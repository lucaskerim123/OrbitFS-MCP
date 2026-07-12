import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
// Sorter now lives at orbitfs-mcp/plugins/The Orbit Sorter - HIVE_ROOT lives
// two levels up in the repo-root .env (same one server.js loads). Parse it
// without touching process.env: that .env also sets PORT/HIVE_API_KEY for the
// *main* MCP server, and blindly injecting those would make the sorter fight
// the main server for its port.
const rootEnvPath = path.join(APP_DIR, '..', '..', '.env');
const rootEnv = await fs.readFile(rootEnvPath, 'utf8').then(dotenv.parse).catch(() => ({}));
const config = JSON.parse(await fs.readFile(path.join(APP_DIR, 'config.json'), 'utf8'));

export const HIVE_ROOT = process.env.HIVE_ROOT || rootEnv.HIVE_ROOT || config.hiveRoot;
export const SORTER_DIR = config.sorterFolder || '_sorter';
export const TRASH_DIR = config.trashFolder || '_trash';
export const INDEX_REL = config.indexPath || '_system/Index/folder_index.json';

function rootPath() {
  return path.resolve(HIVE_ROOT);
}

function relFromRoot(full) {
  return path.relative(rootPath(), full).split(path.sep).join('/');
}

export function safeJoin(...parts) {
  const full = path.resolve(rootPath(), ...parts);
  if (!full.startsWith(rootPath())) throw new Error('Path escapes Hive root');
  return full;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[_\-.]+/g, ' ');
}
async function walk(dir, out = { folders: [], files: [] }) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = relFromRoot(full);
    if (ent.isDirectory()) {
      out.folders.push(rel);
      await walk(full, out);
    } else {
      const st = await fs.stat(full);
      out.files.push({ path: rel, name: ent.name, size: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return out;
}

function isHiddenDestination(rel) {
  const parts = rel.split('/');
  return parts.includes(SORTER_DIR) || parts.includes(TRASH_DIR);
}
export async function buildFolderIndex() {
  const tree = await walk(rootPath());
  const folders = tree.folders
    .filter(p => !isHiddenDestination(p))
    .map(p => ({
      path: p,
      name: path.basename(p),
      meaning: norm(p),
      suggestable: true
    }));
  const index = { root: HIVE_ROOT, builtAt: new Date().toISOString(), folders };
  const indexPath = safeJoin(INDEX_REL);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');
  return index;
}

function scoreFolder(folder, terms) {
  const text = folder.meaning;
  return terms.reduce((n, term) => n + (text.includes(term) ? 10 : 0), 0);
}
function bestFolder(index, terms, fallback = ['intake', 'needs review']) {
  let best = null;
  for (const folder of index.folders) {
    let score = scoreFolder(folder, terms);
    if (!score) score = scoreFolder(folder, fallback);
    if (!best || score > best.score) best = { folder, score };
  }
  return best?.folder?.path || null;
}

function classify(file) {
  const text = norm(`${file.path} ${file.name}`);
  const ext = path.extname(file.name).toLowerCase();
  if (/statement|witness|victim|police statement|court statement|recorded statement|affidavit/.test(text)) {
    return { type: 'Statements', terms: ['statements', 'statement'] };
  }
  if (/jade.*avo|laura.*avo|active avo|current avo|interim avo/.test(text)) {
    return { type: 'Current AVO', terms: ['current avo', 'active orders'] };
  }
  if (/hearing|callover|call over|outcome|court date|mention|adjourn|appearance/.test(text)) {
    return { type: 'Court Days', terms: ['key dates', 'court'] };
  }
  if (['.mp3', '.wav', '.m4a'].includes(ext)) return { type: 'Audio', terms: ['audio', 'media'] };
  if (['.mp4', '.mov', '.avi'].includes(ext)) return { type: 'Videos', terms: ['videos', 'media'] };
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return { type: 'Photos', terms: ['photos', 'media'] };
  if (/mental|wellbeing|session|mood|sleep|vent/.test(text)) {
    return { type: 'Wellbeing', terms: ['wellbeing', 'notes'] };
  }
  if (/legal|court|avo|police|charge|order/.test(text)) {
    return { type: 'Legal Intake', terms: ['legal', 'intake', 'needs review'] };
  }
  return { type: 'Needs Review', terms: ['intake', 'needs review'] };
}
export async function startSorter() {
  const index = await buildFolderIndex();
  const sorterTree = await walk(safeJoin(SORTER_DIR));
  const suggestions = sorterTree.files.map(file => {
    const cls = classify(file);
    const destFolder = bestFolder(index, cls.terms);
    const destination = destFolder ? `${destFolder}/${file.name}` : '';
    return {
      id: Buffer.from(file.path).toString('base64url'),
      source: file.path,
      name: file.name,
      classification: cls.type,
      reason: `Meaning matched: ${cls.type}`,
      selectedDestination: destination,
      approved: false,
      status: destination ? 'preview' : 'needs_destination'
    };
  });
  return { status: 'preview', safeMode: true, startedAt: new Date().toISOString(), items: suggestions, index };
}
async function uniqueDest(dest) {
  const parsed = path.parse(dest);
  let candidate = dest;
  let n = 1;
  while (true) {
    try { await fs.access(candidate); }
    catch { return candidate; }
    candidate = path.join(parsed.dir, `${parsed.name} (${n++})${parsed.ext}`);
  }
}

export async function confirmSorter(items) {
  const moved = [];
  const skipped = [];
  for (const item of items || []) {
    if (!item.approved) { skipped.push({ ...item, reason: 'not approved' }); continue; }
    if (!item.source?.startsWith(`${SORTER_DIR}/`)) { skipped.push({ ...item, reason: 'source not in sorter' }); continue; }
    if (!item.selectedDestination || isHiddenDestination(item.selectedDestination)) { skipped.push({ ...item, reason: 'blocked destination' }); continue; }
    const src = safeJoin(item.source);
    const dest = await uniqueDest(safeJoin(item.selectedDestination));
    await fs.rename(src, dest);
    moved.push({ source: item.source, destination: relFromRoot(dest) });
  }
  return { status: 'confirmed', confirmedAt: new Date().toISOString(), moved, skipped };
}
