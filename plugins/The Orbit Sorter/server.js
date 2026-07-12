import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { startSorter, confirmSorter, buildFolderIndex, HIVE_ROOT } from './sorter-core.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(APP_DIR, '.env') });
const config = JSON.parse(await fs.readFile(path.join(APP_DIR, 'config.json'), 'utf8'));
const PORT = Number(process.env.SORTER_PORT || process.env.PORT || config.port || 4055);
const API_KEY = process.env.HIVE_API_KEY || config.apiKey;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const STATE_FILE = path.join(APP_DIR, 'sorter-state.json');
let state = { status: 'idle', safeMode: true, items: [], lastRun: null };

function isAuthorized(req) {
  if (!API_KEY) return true; // no key configured - auth disabled, matches old behavior
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${API_KEY}`;
}

async function loadState() {
  try { state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch { await saveState(); }
}

async function saveState() {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}
function send(res, code, data, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(data, null, 2) : data;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    let data = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html';
    if (ext === '.html' || rel === 'index.html') {
      // Only this local server ever serves index.html, so injecting the key
      // here (rather than making the user paste it in) is safe - the page
      // is never proxied to an untrusted origin.
      data = Buffer.from(
        data.toString('utf8').replace(
          '</head>',
          `<script>window.HIVE_SORTER_API_KEY = ${JSON.stringify(API_KEY || '')};</script></head>`
        ),
        'utf8'
      );
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

async function api(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, { ok: true, root: HIVE_ROOT, ...state });
  }
  if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, state);
  if (req.method === 'GET' && url.pathname === '/api/folders') {
    const index = await buildFolderIndex();
    return send(res, 200, { folders: index.folders });
  }
  if (req.method === 'PUT' && url.pathname === '/api/session') {
    state = await readBody(req);
    await saveState();
    return send(res, 200, state);
  }
  if (req.method === 'POST' && url.pathname === '/api/startsorter') {
    const run = await startSorter();
    state = { ...run, lastRun: run.startedAt };
    await saveState();
    return send(res, 200, state);
  }
  if (req.method === 'POST' && url.pathname === '/api/stopsorter') {
    state = { status: 'stopped', safeMode: true, items: [], lastRun: state.lastRun };
    await saveState();
    return send(res, 200, state);
  }
  if (req.method === 'POST' && url.pathname === '/api/confirmsorter') {
    const body = await readBody(req);
    const result = await confirmSorter(body.items || state.items || []);
    state = { status: 'confirmed', safeMode: true, items: [], lastRun: state.lastRun, result };
    await saveState();
    return send(res, 200, result);
  }
  return send(res, 404, { error: 'unknown api route' });
}

await loadState();

async function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(startPort, () => {
      server.close(() => resolve(startPort));
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        findFreePort(startPort + 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

const ACTUAL_PORT = await findFreePort(PORT);

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      if (!isAuthorized(req)) return send(res, 401, { error: 'Unauthorized' });
      return await api(req, res);
    }
    return await serveStatic(req, res);
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
}).listen(ACTUAL_PORT, async () => {
  console.log(`Orbit Sorter running on http://localhost:${ACTUAL_PORT}`);
  // Publish the chosen port so the panel proxy can discover it. Tunnel routing
  // is handled by the OrbitFSTunnel service + Cloudflare dashboard (the tunnel
  // is remote-managed, so a local config.yml is ignored) - the sorter must NOT
  // rewrite cloudflared config or kill the tunnel process.
  await fs.writeFile(path.join(APP_DIR, '.sorter-port'), String(ACTUAL_PORT), 'utf8').catch(() => {});
  console.log('Commands: /startsorter /stopsorter /confirmsorter');
});
