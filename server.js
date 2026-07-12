import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });
import express from "express";
import fs from "fs/promises";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { jwtVerify, SignJWT } from "jose";
import { mountOAuth, getOAuthState } from "./oauth.js";
import { makeOps } from "./hive-ops.js";
import archiver from "archiver";
import mammoth from "mammoth";

const ROOT = process.env.HIVE_ROOT;
const API_KEY = process.env.HIVE_API_KEY;
const PORT = process.env.PORT || 3939;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const SECRET_KEY = new TextEncoder().encode(process.env.SESSION_SECRET);
const SORT_FOLDER = "_sorter";
const TRASH_FOLDER = "_trash";
const VENT_FOLDER = "2. Wellbeing/Pure Vent Mode";
const LEGACY_TRASH_FOLDERS = ["?? Trash"];
// TEMPORARILY EMPTY during the top-level folder redesign - delete/move/trash
// protection for root folders is off. Restore the real list below once the
// new structure is settled:
//   "_system", "_sorter", "_trash", "0. Core", "1. Legal",
//   "2. Wellbeing", "_media"
const PROTECTED_ROOT_FOLDERS = new Set([]);
const DEFAULT_TRASH_RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS || 4);
const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Per-file cap for MCP uploads/fetches. Bumped from 10MB and made configurable
// via UPLOAD_MAX_MB in .env. Large files can be sent in chunks (upload_file
// append), so this is really a ceiling on total assembled size.
const FETCH_MAX_BYTES = Number(process.env.UPLOAD_MAX_MB || 100) * 1024 * 1024;
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(SERVER_DIR, "logs");
const EVENT_LOG_FILE = path.join(LOG_DIR, "master-hive-events.jsonl");
const ERROR_LOG_FILE = path.join(LOG_DIR, "master-hive-errors.jsonl");
const TRASH_CONFIG_FILE = path.join(SERVER_DIR, "trash-config.json");
const FIRESTORM_STARTUP_FILES = {
  Master: "_system/Startup/00_MASTER_STARTUP.md",
  Court: "_system/Startup/01_COURT_SYSTEM_STARTUP.md",
  Mental: "_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md",
  Media: "_system/Startup/03_MEDIA_STARTUP.md",
};
const FIRESTORM_RULE_FILES = {
  loadOrder: "_system/Rules/load_order.md",
  projectRules: "_system/Rules/project_rules.md",
  savingRules: "_system/Rules/saving_rules.md",
  commands: "_system/Rules/commands.md",
};
const FIRESTORM_OPTIONAL_FILES = {
  fileIndex: "_system/Index/file_index.json",
};
const FIRESTORM_PROJECT_FOLDERS = {
  Master: ["_system", "0. Core"],
  Court: ["1. Legal"],
  Mental: ["2. Wellbeing"],
  Media: ["_media"],
};
const FIRESTORM_LOAD_ALIASES = {
  light: "low",
  normal: "med",
  full: "high",
  low: "low",
  med: "med",
  high: "high",
};

const ops = makeOps(ROOT);
const execFileAsync = promisify(execFile);
const MASTER_BRAIN_LOCAL_URL = `http://127.0.0.1:${process.env.PANEL_PORT || 4000}/`;
const HIVE_LOCAL_PING_URL = `http://127.0.0.1:${PORT}/api/ping`;
const MASTER_BRAIN_SERVICE_NAME = process.env.PANEL_SERVICE_NAME || "OrbitFSPanel";
const HIVE_SERVICE_NAME = process.env.HIVE_SERVICE_NAME || "OrbitFSMcpServer";
const TUNNEL_SERVICE_NAME = process.env.TUNNEL_SERVICE_NAME || "OrbitFSTunnel";
const POWERSHELL_EXE = process.env.POWERSHELL_EXE || "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function logEvent(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  console.log(line);
  fs.appendFile(EVENT_LOG_FILE, `${line}\n`).catch(() => {});
}

function logError(event, err, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, error: err.message, ...fields });
  console.error(line);
  fs.appendFile(ERROR_LOG_FILE, `${line}\n`).catch(() => {});
}

async function httpCheck(url) {
  try {
    const resp = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    return { ok: resp.status >= 200 && resp.status < 400, status: resp.status, error: null };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}

async function getServiceStates() {
  if (process.platform !== "win32") {
    return {
      panel: { exists: false, running: false, status: "Unsupported" },
      hive: { exists: false, running: false, status: "Unsupported" },
      tunnel: { exists: false, running: false, status: "Unsupported" },
    };
  }
  const script = `
$services = @("${MASTER_BRAIN_SERVICE_NAME}", "${HIVE_SERVICE_NAME}", "${TUNNEL_SERVICE_NAME}")
$result = @{}
foreach ($name in $services) {
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($svc) {
    $result[$name] = @{ exists = $true; status = [string]$svc.Status; running = ($svc.Status -eq "Running") }
  } else {
    $result[$name] = @{ exists = $false; status = "NotInstalled"; running = $false }
  }
}
$result | ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await execFileAsync(POWERSHELL_EXE, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout.trim() || "{}");
    return {
      panel: parsed[MASTER_BRAIN_SERVICE_NAME] || { exists: false, running: false, status: "Unknown" },
      hive: parsed[HIVE_SERVICE_NAME] || { exists: false, running: false, status: "Unknown" },
      tunnel: parsed[TUNNEL_SERVICE_NAME] || { exists: false, running: false, status: "Unknown" },
    };
  } catch (err) {
    return {
      panel: { exists: false, running: false, status: `CheckFailed: ${err.message}` },
      hive: { exists: false, running: false, status: `CheckFailed: ${err.message}` },
      tunnel: { exists: false, running: false, status: `CheckFailed: ${err.message}` },
    };
  }
}

async function readLastErrorBrief(filepath) {
  try {
    const raw = await fs.readFile(filepath, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (["auth.jwt.failed", "auth.missing"].includes(parsed.event)) continue;
        return parsed.error || parsed.event || lines[i].slice(0, 200);
      } catch {}
    }
    return lines[lines.length - 1].slice(0, 200);
  } catch {
    return null;
  }
}

function classifyConnectionStatus(clients = [], refreshTokens = [], flow) {
  const flowClients = clients.filter((client) => client.flow === flow).length;
  const flowTokens = refreshTokens.filter((token) => token.flow === flow).length;
  if (flowClients > 0 && flowTokens > 0) {
    return `Connected (${flowClients} client${flowClients === 1 ? "" : "s"}, ${flowTokens} account${flowTokens === 1 ? "" : "s"})`;
  }
  if (flowClients > 0) {
    return `Registered (${flowClients} client${flowClients === 1 ? "" : "s"}), no refresh-token account`;
  }
  return "Not connected";
}

async function buildServerStatusReport() {
  const [services, panelLocal, hiveLocal, oauthState, hiveErrorBrief] = await Promise.all([
    getServiceStates(),
    httpCheck(MASTER_BRAIN_LOCAL_URL),
    httpCheck(HIVE_LOCAL_PING_URL),
    Promise.resolve(getOAuthState()),
    readLastErrorBrief(ERROR_LOG_FILE),
  ]);

  const masterBrainLocal = panelLocal.ok ? "Yes" : "No";
  const masterBrainOnline = services.tunnel.running && panelLocal.ok ? "Likely yes" : "No";
  const masterBrainStatus = panelLocal.ok
    ? (services.tunnel.running ? "Local panel reachable; tunnel service running." : "Local panel reachable; tunnel service not running.")
    : (services.panel.running ? `Panel service running, but local HTTP check failed${panelLocal.error ? `: ${panelLocal.error}` : "."}` : `Panel service ${services.panel.status}.`);
  const masterBrainErrors = panelLocal.ok && services.tunnel.running
    ? "None detected from local checks."
    : [!services.panel.running ? `Panel service ${services.panel.status}` : null, !services.tunnel.running ? `Tunnel service ${services.tunnel.status}` : null, panelLocal.error].filter(Boolean).join("; ") || "None detected from local checks.";

  const hiveRunning = services.hive.running ? "Yes" : "No";
  const hiveOnline = hiveLocal.ok && services.tunnel.running ? "Likely yes" : (hiveLocal.ok ? "Local only" : "No");
  const hiveStatus = hiveLocal.ok
    ? (services.tunnel.running ? "Local ping OK; tunnel service running." : "Local ping OK; tunnel service not running.")
    : (services.hive.running ? `Hive service running, but local ping failed${hiveLocal.error ? `: ${hiveLocal.error}` : "."}` : `Hive service ${services.hive.status}.`);
  const hiveErrors = hiveLocal.ok && services.hive.running
    ? "None detected from local checks."
    : (hiveErrorBrief || [!services.hive.running ? `Hive service ${services.hive.status}` : null, hiveLocal.error].filter(Boolean).join("; ") || "None detected from recent Hive logs.");

  const chatgptStatus = classifyConnectionStatus(oauthState.clients || [], oauthState.refreshTokens || [], "chatgpt");
  const claudeStatus = classifyConnectionStatus(oauthState.clients || [], oauthState.refreshTokens || [], "claude");

  const text = [
    "The Master Brain",
    `Connected locally: ${masterBrainLocal}`,
    `Connected Online: ${masterBrainOnline}`,
    `Connection status: ${masterBrainStatus}`,
    `Errors (brief): ${masterBrainErrors}`,
    "",
    "The Hive Server",
    `Running: ${hiveRunning}`,
    `Online: ${hiveOnline}`,
    `Status: ${hiveStatus}`,
    `Errors (brief): ${hiveErrors}`,
    "",
    `Chatgpt Connection Status: ${chatgptStatus}`,
    `Claude Connection Status: ${claudeStatus}`,
  ].join("\n");

  return {
    text,
    masterBrain: {
      connectedLocally: masterBrainLocal,
      connectedOnline: masterBrainOnline,
      connectionStatus: masterBrainStatus,
      errorsBrief: masterBrainErrors,
    },
    hiveServer: {
      running: hiveRunning,
      online: hiveOnline,
      status: hiveStatus,
      errorsBrief: hiveErrors,
    },
    chatgptConnectionStatus: chatgptStatus,
    claudeConnectionStatus: claudeStatus,
  };
}
function requestId() {
  return crypto.randomBytes(6).toString("hex");
}

function normalizeRetentionDays(input) {
  const value = Number(input);
  if (!Number.isFinite(value)) throw new Error("retentionDays must be a number");
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 365) throw new Error("retentionDays must be between 1 and 365");
  return rounded;
}

async function loadTrashConfig() {
  try {
    const raw = JSON.parse(await fs.readFile(TRASH_CONFIG_FILE, "utf-8"));
    return { retentionDays: normalizeRetentionDays(raw?.retentionDays ?? DEFAULT_TRASH_RETENTION_DAYS) };
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) {
      return { retentionDays: DEFAULT_TRASH_RETENTION_DAYS };
    }
    throw err;
  }
}

async function saveTrashConfig(retentionDays) {
  const normalized = normalizeRetentionDays(retentionDays);
  const config = { retentionDays: normalized };
  await fs.writeFile(TRASH_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

function requestContext(req) {
  return {
    rid: req.id,
    method: req.method,
    path: req.path,
    ip: req.ip,
    auth: req.authContext?.type,
    flow: req.authContext?.flow,
    email: req.authContext?.email,
  };
}

function summarizeMcpBody(body) {
  if (!body || typeof body !== "object") return {};
  const params = body.params || {};
  return {
    rpcMethod: body.method,
    rpcId: body.id,
    tool: params.name,
  };
}

function filterLegacyTopLevelEntries(subpath = "", entries = []) {
  if (normalizeRelativePath(subpath)) return entries;
  return entries.filter((entry) => !LEGACY_TRASH_FOLDERS.includes(entry.name));
}

// Directory-only listing used to give the sorter model a map of where things
// could go. Capped in depth and count so the prompt stays small.
async function listFolderTree(base, depth, out) {
  if (depth <= 0) return out;
  const entries = await ops.listFiles(base);
  for (const e of entries) {
    if (e.type !== "dir") continue;
    if (base === "" && (e.name === SORT_FOLDER || e.name === TRASH_FOLDER || LEGACY_TRASH_FOLDERS.includes(e.name))) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    out.push(rel);
    if (out.length >= 400) return out;
    await listFolderTree(rel, depth - 1, out);
  }
  return out;
}

function sorterNorm(value = "") {
  return String(value || "").toLowerCase().replace(/[_\-.]+/g, " ");
}

function scoreSorterFolder(folderPath, hints = [], preferredFolders = []) {
  const text = sorterNorm(folderPath);
  let score = 0;
  for (const hint of hints) {
    if (text.includes(sorterNorm(hint))) score += 10;
  }
  for (const preferred of preferredFolders) {
    const normalized = sorterNorm(preferred);
    if (text === normalized || text.startsWith(`${normalized}/`) || text.startsWith(`${normalized} `)) score += 60;
    else if (text.includes(normalized)) score += 25;
  }
  return score;
}

function findSorterFolder(folders, preferredFolders = []) {
  for (const preferred of preferredFolders) {
    const normalized = sorterNorm(preferred);
    const exact = folders.find((folder) => {
      const text = sorterNorm(folder);
      return text === normalized || text.startsWith(`${normalized}/`) || text.startsWith(`${normalized} `);
    });
    if (exact) return exact;
  }
  return null;
}

function chooseSorterDestination(folders, hints = [], preferredFolders = [], fallbackHints = []) {
  let best = null;
  for (const folder of folders) {
    let score = scoreSorterFolder(folder, hints, preferredFolders);
    if (!score && fallbackHints.length) score = scoreSorterFolder(folder, fallbackHints, preferredFolders);
    if (!best || score > best.score) best = { folder, score };
  }
  if (best?.score > 0) return best.folder;
  return findSorterFolder(folders, preferredFolders);
}

async function classifyDestination(itemName, isDir, folders) {
  const text = sorterNorm(itemName);
  const ext = path.extname(itemName).toLowerCase();
  const rules = [
    {
      name: "Media",
      match: () => [".mp3", ".wav", ".m4a", ".mp4", ".mov", ".avi", ".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext),
      hints: ["media", "audio", "video", "photos", "images"],
      preferredFolders: ["_media"],
    },
    {
      name: "Wellbeing",
      match: () => /mental|wellbeing|session|mood|sleep|vent|therapy/.test(text),
      hints: ["wellbeing", "mental", "notes"],
      preferredFolders: ["2. Wellbeing"],
    },
    {
      name: "Legal",
      match: () => /statement|witness|victim|police|court|hearing|avo|charge|order|affidavit|mention|adjourn/.test(text),
      hints: ["legal", "court", "documents", "reference"],
      preferredFolders: ["1. Legal"],
    },
    {
      name: "Core",
      match: () => !isDir && [".md", ".txt", ".doc", ".docx", ".pdf"].includes(ext),
      hints: ["documents", "notes", "imports"],
      preferredFolders: ["0. Core"],
    },
  ];

  for (const rule of rules) {
    if (!rule.match()) continue;
    const destination = chooseSorterDestination(folders, rule.hints, rule.preferredFolders, ["imports", "needs review"]);
    if (destination) {
      return { destination, isNew: false, reason: `Rule matched: ${rule.name}` };
    }
  }

  const fallback = chooseSorterDestination(folders, ["imports", "notes"], ["0. Core"], ["needs review"]);
  return {
    destination: fallback || "0. Core",
    isNew: !fallback,
    reason: fallback ? "Fallback matched: Core/Documents" : "Fallback created: 0. Core",
  };
}

// Dry run: applies deterministic sorter rules to each _sorter item, but does
// not touch the filesystem. Callers must show this to the user and only move
// files via applySortMoves() once the destinations are confirmed.
async function planSortInbox(authContext = {}) {
  let entries;
  try {
    entries = await ops.listFiles(SORT_FOLDER);
  } catch (err) {
    if (err.code === "ENOENT") return { proposals: [], errors: [], note: `No ${SORT_FOLDER} folder yet - nothing to sort.` };
    throw err;
  }
  if (!entries.length) return { proposals: [], errors: [], note: `${SORT_FOLDER} is empty - nothing to sort.` };

  const folders = await listFolderTree("", 4, []);
  const proposals = [];
  const errors = [];

  for (const e of entries) {
    const itemName = e.name;
    try {
      logEvent("tool.sort_inbox.plan.start", { ...authContext, item: itemName });
      const { destination, isNew, reason } = await classifyDestination(itemName, e.type === "dir", folders);
      proposals.push({ item: itemName, isDir: e.type === "dir", destination, isNewFolder: !!isNew, reason });
      if (isNew) folders.push(destination);
    } catch (err) {
      logError("tool.sort_inbox.plan.failed", err, { ...authContext, item: itemName });
      errors.push({ item: itemName, error: err.message });
    }
  }

  logEvent("tool.sort_inbox.planned", { ...authContext, proposedCount: proposals.length, errorCount: errors.length });
  return { proposals, errors };
}

// Executes an explicitly confirmed set of moves out of _sorter - the
// destinations the caller already showed the user, possibly edited by them.
async function applySortMoves(moves, authContext = {}) {
  const moved = [];
  const errors = [];

  for (const move of moves || []) {
    const itemName = move?.item;
    const destination = typeof move?.destination === "string" ? move.destination.replace(/^\/+|\/+$/g, "").trim() : "";
    if (!itemName || !destination) {
      errors.push({ item: itemName || "(unknown)", error: "Missing item or destination" });
      continue;
    }
    const from = `${SORT_FOLDER}/${itemName}`;
    const to = `${destination}/${itemName}`;
    try {
      await ops.moveFile(from, to);
      logEvent("file.change.move", { ...authContext, source: "sort_inbox_apply", from, to });
      moved.push({ item: itemName, from, to });
    } catch (err) {
      logError("tool.sort_inbox.apply.failed", err, { ...authContext, item: itemName, from, to });
      errors.push({ item: itemName, error: err.message });
    }
  }

  logEvent("tool.sort_inbox.applied", { ...authContext, movedCount: moved.length, errorCount: errors.length });
  return { moved, errors };
}

function normalizeRelativePath(input = "") {
  return String(input || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isTrashPath(relPath = "") {
  const normalized = normalizeRelativePath(relPath);
  return [TRASH_FOLDER, ...LEGACY_TRASH_FOLDERS].some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
}

function isProtectedRootFolderPath(relPath = "") {
  return PROTECTED_ROOT_FOLDERS.has(normalizeRelativePath(relPath));
}

function assertMutablePath(relPath = "", action = "modify") {
  const normalized = normalizeRelativePath(relPath);
  if (!normalized) throw new Error("Path is required");
  if (isProtectedRootFolderPath(normalized)) {
    throw new Error(`Cannot ${action} protected root folder "${normalized}"`);
  }
  return normalized;
}

const FILE_VIEW_TOKEN_TTL = "15m";
const FILE_VIEW_TOKEN_TTL_MINUTES = 15;
const DOWNLOAD_TOKEN_TTL = "15m";
const DOWNLOAD_TOKEN_TTL_MINUTES = 15;
const BATCH_READ_MAX_FILES = 50;
const BATCH_READ_MAX_CHARS = 500_000;
const BATCH_READ_MAX_CHARS_PER_FILE = 100_000;
const RECURSIVE_LIST_MAX_ENTRIES = 10_000;
const UPLOAD_LINK_TOKEN_TTL = "15m";
const UPLOAD_LINK_TOKEN_TTL_MINUTES = 15;
const uploadTokens = new Map();

// Short-lived, single-file-scoped tokens for "open this in a browser tab"
// links - narrower than the HIVE_API_KEY bearer token (one path, expires
// fast), so handing one out is safe even outside the normal auth header flow
// browsers can't attach to a plain link click.
async function signFileViewToken(relPath) {
  return new SignJWT({ path: relPath, purpose: "file_view" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(PUBLIC_BASE_URL)
    .setExpirationTime(FILE_VIEW_TOKEN_TTL)
    .sign(SECRET_KEY);
}

async function buildFileWebLink(filepath) {
  const normalized = normalizeRelativePath(filepath);
  if (!normalized) throw new Error("Path is required");
  const full = ops.safeResolve(normalized);
  const st = await fs.stat(full);
  if (st.isDirectory()) {
    throw new Error(`"${normalized}" is a folder, not a file. Point /openfileweb at a specific file.`);
  }
  const token = await signFileViewToken(normalized);
  const url = `${PUBLIC_BASE_URL}/open?path=${encodeURIComponent(normalized)}&token=${token}`;
  return { url, expiresInMinutes: FILE_VIEW_TOKEN_TTL_MINUTES };
}

async function buildTemporaryDownloadLink(filepath, requireFolder = false) {
  const normalized = normalizeRelativePath(filepath);
  if (!normalized) throw new Error("Path is required");
  const full = ops.safeResolve(normalized);
  const st = await fs.stat(full);
  const kind = st.isDirectory() ? "folder" : "file";
  if (requireFolder && kind !== "folder") throw new Error(`"${normalized}" is a file, not a folder`);
  const token = await new SignJWT({ path: normalized, kind, purpose: "temporary_download" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(PUBLIC_BASE_URL)
    .setExpirationTime(DOWNLOAD_TOKEN_TTL)
    .sign(SECRET_KEY);
  const url = new URL("/download-temp", PUBLIC_BASE_URL);
  url.searchParams.set("path", normalized);
  url.searchParams.set("token", token);
  return { url: url.toString(), expiresInMinutes: DOWNLOAD_TOKEN_TTL_MINUTES, kind };
}

async function streamFolderZip(res, relPath) {
  const normalized = normalizeRelativePath(relPath);
  const full = ops.safeResolve(normalized);
  const st = await fs.stat(full);
  if (!st.isDirectory()) throw new Error(`"${normalized}" is not a folder`);
  const archiveName = `${path.basename(full) || "Master-Hive"}.zip`;
  res.attachment(archiveName);
  res.type("application/zip");
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("warning", (err) => logError("zip.warning", err, { path: normalized }));
  archive.on("error", (err) => {
    logError("zip.failed", err, { path: normalized });
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  archive.pipe(res);
  archive.directory(full, false);
  await archive.finalize();
}

async function readFilesBatch(filepaths) {
  if (!Array.isArray(filepaths) || filepaths.length === 0) throw new Error("filepaths must contain at least one path");
  if (filepaths.length > BATCH_READ_MAX_FILES) throw new Error(`A batch may contain at most ${BATCH_READ_MAX_FILES} files`);
  const files = [];
  let totalChars = 0;
  for (const requested of filepaths) {
    const filepath = normalizeRelativePath(requested);
    try {
      if (!filepath) throw new Error("Path is required");
      const data = await ops.readFile(filepath);
      const remaining = Math.max(0, BATCH_READ_MAX_CHARS - totalChars);
      const allowed = Math.min(BATCH_READ_MAX_CHARS_PER_FILE, remaining);
      const content = data.slice(0, allowed);
      totalChars += content.length;
      files.push({ filepath, content, truncated: content.length < data.length, chars: data.length });
      if (totalChars >= BATCH_READ_MAX_CHARS) break;
    } catch (err) {
      files.push({ filepath, error: err.message });
    }
  }
  return { files, totalChars, limits: { maxFiles: BATCH_READ_MAX_FILES, maxTotalChars: BATCH_READ_MAX_CHARS, maxCharsPerFile: BATCH_READ_MAX_CHARS_PER_FILE } };
}

function pruneUploadTokens() {
  const now = Date.now();
  for (const [jti, state] of uploadTokens.entries()) {
    if (!state || state.expiresAt <= now || state.usedAt) uploadTokens.delete(jti);
  }
}

// --- Pure Vent Mode: private journaling flow for the site owner only. ------
// State lives at module scope (like uploadTokens above) because each /mcp
// POST gets a brand-new buildServer() call (see StreamableHTTPServerTransport
// with no sessionIdGenerator further down) - nothing inside that closure
// survives between requests, so mode on/off and the pending draft have to
// live out here instead.
const ventSessions = new Map();

function ventSessionKey(authContext = {}) {
  // This server is single-tenant - a valid bearer key or OAuth JWT is already
  // "Lucas or an authorized administrator" by construction (see the Auth
  // model note in CLAUDE.md: the real identity gate is Cloudflare Access /
  // the shared bearer key, not a per-user table in this server). Key by
  // authenticated email when there is one (OAuth flow), otherwise treat all
  // bearer-key callers as one shared session.
  return authContext.email || "api_key";
}

function getVentSession(authContext) {
  const key = ventSessionKey(authContext);
  let session = ventSessions.get(key);
  if (!session) {
    session = { active: false, pendingDraft: null };
    ventSessions.set(key, session);
  }
  return session;
}

function isVentFolderPath(relPath = "") {
  const normalized = normalizeRelativePath(relPath);
  return normalized === VENT_FOLDER || normalized.startsWith(`${VENT_FOLDER}/`);
}

// Excludes the Vent Mode folder from general browsing/search so it isn't
// accidentally surfaced by a broad /startup scan or a casual list/search -
// the folder is still reachable directly by path via style_vent_entry /
// upload_vent_entry, and on the webpanel side is gated by the existing
// admin-only file-permission rule (see orbitfs-panel/file-permissions.json).
function filterVentFolder(subpath, entries, recursive) {
  if (recursive) return entries.filter((e) => !isVentFolderPath(e.path));
  if (normalizeRelativePath(subpath) === "2. Wellbeing") {
    return entries.filter((e) => e.name !== "Pure Vent Mode");
  }
  return entries;
}

function sydneyDateDDMMYYYY() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Sydney",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("day")}-${get("month")}-${get("year")}`;
}

const VENT_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthYearFromEntryDate(entryDate) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(entryDate);
  if (!match) throw new Error(`entry_date must be in DD-MM-YYYY format, got "${entryDate}"`);
  const [, dd, mm, yyyy] = match;
  const monthIndex = Number(mm) - 1;
  const asDate = new Date(Number(yyyy), monthIndex, Number(dd));
  // Round-trips through Date to reject calendar-invalid dates (e.g. 31-02-2026)
  // instead of silently accepting them.
  if (monthIndex < 0 || monthIndex > 11 || asDate.getMonth() !== monthIndex || asDate.getDate() !== Number(dd)) {
    throw new Error(`entry_date "${entryDate}" is not a real calendar date`);
  }
  return { monthYear: `${VENT_MONTH_NAMES[monthIndex]} ${yyyy}` };
}

function sanitizeVentTitle(title = "") {
  const cleaned = String(title || "").trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ");
  return cleaned || "Vent Entry";
}

function hashVentDraft(title, entryDate, text) {
  return crypto.createHash("sha256").update(`${title}\n${entryDate}\n${text}`, "utf8").digest("hex");
}

function sanitizeUploadFilename(filename = "") {
  const base = path.basename(String(filename || "").replace(/\\/g, "/")).trim();
  if (!base || base === "." || base === "..") throw new Error("Uploaded file must have a valid filename");
  return base.replace(/[\x00-\x1f]/g, "_");
}

async function signUploadLinkToken(destination = SORT_FOLDER) {
  const relPath = normalizeRelativePath(destination || SORT_FOLDER) || SORT_FOLDER;
  const jti = crypto.randomBytes(12).toString("hex");
  const expiresAt = Date.now() + (UPLOAD_LINK_TOKEN_TTL_MINUTES * 60 * 1000);
  uploadTokens.set(jti, { destination: relPath, expiresAt, usedAt: null });
  return new SignJWT({ purpose: "upload_link", destination: relPath, jti })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(PUBLIC_BASE_URL)
    .setAudience(`${PUBLIC_BASE_URL}/api/upload`)
    .setExpirationTime(UPLOAD_LINK_TOKEN_TTL)
    .sign(SECRET_KEY);
}

async function buildUploadLink(destination = SORT_FOLDER) {
  pruneUploadTokens();
  const token = await signUploadLinkToken(destination);
  const url = new URL("/upload", PUBLIC_BASE_URL);
  url.searchParams.set("token", token);
  return {
    url: url.toString(),
    expiresInMinutes: UPLOAD_LINK_TOKEN_TTL_MINUTES,
    destination: normalizeRelativePath(destination || SORT_FOLDER) || SORT_FOLDER,
  };
}

async function verifyUploadLinkToken(token, { consume = false } = {}) {
  pruneUploadTokens();
  const { payload } = await jwtVerify(String(token), SECRET_KEY, {
    issuer: PUBLIC_BASE_URL,
    audience: `${PUBLIC_BASE_URL}/api/upload`,
  });
  if (payload.purpose !== "upload_link" || !payload.jti) throw new Error("Invalid upload token");
  const state = uploadTokens.get(payload.jti);
  if (!state) throw new Error("Upload token is invalid or has expired");
  if (state.usedAt) throw new Error("Upload token has already been used");
  if (state.expiresAt <= Date.now()) {
    uploadTokens.delete(payload.jti);
    throw new Error("Upload token has expired");
  }
  if (state.destination !== payload.destination) throw new Error("Upload token destination mismatch");
  if (consume) {
    state.usedAt = Date.now();
    uploadTokens.set(payload.jti, state);
  }
  return { destination: state.destination, jti: payload.jti, expiresAt: state.expiresAt };
}

function parseMultipartFile(req) {
  const contentType = String(req.headers["content-type"] || "");
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error("multipart/form-data boundary is required");
  const boundary = match[1] || match[2];
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  let cursor = body.indexOf(boundaryMarker);

  while (cursor !== -1) {
    const partStart = cursor + boundaryMarker.length;
    if (body.slice(partStart, partStart + 2).equals(Buffer.from("--"))) break;
    const dataStart = body.indexOf(headerSeparator, partStart);
    if (dataStart === -1) break;
    const rawHeaders = body.slice(partStart, dataStart).toString("utf8").trim();
    const disposition = rawHeaders.split(/\r?\n/).find((line) => /^content-disposition:/i.test(line));
    const filenameMatch = disposition?.match(/filename="([^"]*)"/i);
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart + headerSeparator.length);
    if (nextBoundary === -1) break;
    const content = body.slice(dataStart + headerSeparator.length, nextBoundary);
    if (filenameMatch && filenameMatch[1] !== "") {
      return {
        filename: sanitizeUploadFilename(filenameMatch[1]),
        buffer: content,
      };
    }
    cursor = nextBoundary + 2;
  }

  throw new Error("No uploaded file was found in the multipart form data");
}

function renderUploadPage(uploadUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hive Upload</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef4ff;
      --panel: rgba(255,255,255,0.94);
      --border: #c8d7f2;
      --text: #17304f;
      --muted: #5e7494;
      --accent: #1f6feb;
      --accent-strong: #0b4db6;
      --ok: #0f9d58;
      --error: #c62828;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", system-ui, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top, rgba(31,111,235,0.18), transparent 40%),
        linear-gradient(180deg, #f7faff 0%, var(--bg) 100%);
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .card {
      width: min(100%, 520px);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 24px 60px rgba(31, 61, 110, 0.14);
      backdrop-filter: blur(10px);
    }
    h1 { margin: 0 0 8px; font-size: clamp(1.6rem, 4vw, 2.2rem); }
    p { margin: 0 0 18px; color: var(--muted); line-height: 1.5; }
    label {
      display: block;
      margin: 16px 0 8px;
      font-weight: 600;
    }
    input[type="file"] {
      width: 100%;
      padding: 14px;
      border: 1px dashed var(--border);
      border-radius: 14px;
      background: white;
    }
    button {
      width: 100%;
      margin-top: 18px;
      border: 0;
      border-radius: 14px;
      padding: 14px 16px;
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      color: white;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled { opacity: 0.6; cursor: wait; }
    progress {
      width: 100%;
      height: 14px;
      margin-top: 16px;
    }
    .status {
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 12px;
      background: #f5f8fe;
      color: var(--text);
      word-break: break-word;
    }
    .status.ok { background: #edf8f1; color: var(--ok); }
    .status.error { background: #fdeeee; color: var(--error); }
    .small { font-size: 0.92rem; color: var(--muted); margin-top: 10px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Upload to Hive</h1>
    <p>Select one file and upload it directly into <code>_sorter</code>. Links expire after 15 minutes and can only be used once.</p>
    <form id="upload-form">
      <label for="file">Choose file</label>
      <input id="file" name="file" type="file" required>
      <button id="submit" type="submit">Upload File</button>
      <progress id="progress" value="0" max="100" hidden></progress>
      <div id="status" class="status" hidden></div>
      <div class="small">Maximum file size: 100MB.</div>
    </form>
  </main>
  <script>
    const form = document.getElementById("upload-form");
    const fileInput = document.getElementById("file");
    const submit = document.getElementById("submit");
    const progress = document.getElementById("progress");
    const status = document.getElementById("status");
    function setStatus(message, kind) {
      status.hidden = false;
      status.className = "status" + (kind ? " " + kind : "");
      status.textContent = message;
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        setStatus("Choose a file first.", "error");
        return;
      }
      submit.disabled = true;
      progress.hidden = false;
      progress.value = 0;
      setStatus("Uploading...", "");
      const data = new FormData();
      data.append("file", file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", ${JSON.stringify(uploadUrl)});
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) progress.value = Math.round((e.loaded / e.total) * 100);
      });
      xhr.onload = () => {
        submit.disabled = false;
        try {
          const parsed = JSON.parse(xhr.responseText || "{}");
          if (xhr.status >= 200 && xhr.status < 300 && parsed.success) {
            progress.value = 100;
            setStatus("Saved to " + parsed.filepath, "ok");
            form.reset();
            return;
          }
          setStatus(parsed.error || "Upload failed.", "error");
        } catch {
          setStatus("Upload failed.", "error");
        }
      };
      xhr.onerror = () => {
        submit.disabled = false;
        setStatus("Network error while uploading.", "error");
      };
      xhr.send(data);
    });
  </script>
</body>
</html>`;
}

function trashEntryPrefix() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function movePathToTrash(filepath, authContext = {}) {
  const normalized = assertMutablePath(filepath, "trash");
  if (isTrashPath(normalized)) throw new Error(`Path is already inside ${TRASH_FOLDER}`);
  const stamp = `${trashEntryPrefix()}-${crypto.randomBytes(3).toString("hex")}`;
  const destination = `${TRASH_FOLDER}/${stamp}/${normalized}`;
  await ops.moveFile(normalized, destination);
  logEvent("file.change.trash", { ...authContext, source: authContext.source || "api", from: normalized, to: destination });
  return { from: normalized, to: destination };
}

async function emptyTrash(authContext = {}) {
  let entries;
  try {
    entries = await ops.listFiles(TRASH_FOLDER, { recursive: false });
  } catch (err) {
    if (err.code === "ENOENT") return { deleted: [], deletedCount: 0, note: `${TRASH_FOLDER} does not exist.` };
    throw err;
  }

  const deleted = [];
  for (const entry of entries) {
    const target = `${TRASH_FOLDER}/${entry.name}`;
    await ops.deleteFile(target);
    deleted.push(target);
  }

  logEvent("file.change.empty_trash", { ...authContext, source: authContext.source || "api", deletedCount: deleted.length });
  return { deleted, deletedCount: deleted.length };
}

async function purgeExpiredTrash(authContext = {}) {
  let entries;
  try {
    entries = await ops.listFiles(TRASH_FOLDER, { recursive: false });
  } catch (err) {
    if (err.code === "ENOENT") return { deleted: [], deletedCount: 0, note: `${TRASH_FOLDER} does not exist.` };
    throw err;
  }

  const { retentionDays } = await loadTrashConfig();
  const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  const deleted = [];

  for (const entry of entries) {
    const relPath = `${TRASH_FOLDER}/${entry.name}`;
    let stat;
    try {
      stat = await fs.stat(ops.safeResolve(relPath));
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    if (stat.mtimeMs > cutoff) continue;
    await ops.deleteFile(relPath);
    deleted.push(relPath);
  }

  if (deleted.length) {
    logEvent("file.change.trash_autopurge", {
      ...authContext,
      source: authContext.source || "scheduler",
      deletedCount: deleted.length,
      retentionDays,
    });
  }
  return { deleted, deletedCount: deleted.length, retentionDays };
}

function parseStartupProjects(input = "Master") {
  const requested = String(input || "Master")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  const deduped = [];
  for (const raw of requested.length ? requested : ["Master"]) {
    const matched = Object.keys(FIRESTORM_STARTUP_FILES).find((name) => name.toLowerCase() === raw.toLowerCase());
    if (!matched) {
      throw new Error(`Unknown startup project "${raw}". Use Master, Court, Mental, Media, or combine with ":".`);
    }
    if (matched !== "Master" && !deduped.includes("Master")) deduped.push("Master");
    if (!deduped.includes(matched)) deduped.push(matched);
  }
  return deduped.length ? deduped : ["Master"];
}

function parseStartupLoadLevel(input = "med") {
  const normalized = FIRESTORM_LOAD_ALIASES[String(input || "med").trim().toLowerCase()];
  if (!normalized) {
    throw new Error(`Unknown startup load level "${input}". Use low, med, high, or aliases light/normal/full.`);
  }
  return normalized;
}

function isArchivePath(relPath = "") {
  return relPath.split("/").some((part) => part.toLowerCase() === "archive");
}

function summarizeEntries(entries, prefix = "") {
  return entries.length
    ? entries.map((e) => `${prefix}${e.type === "dir" ? "[DIR]" : "[FILE]"} ${e.path ?? e.name}`).join("\n")
    : `${prefix}(empty)`;
}

async function readOptionalFile(filepath) {
  try {
    return await ops.readFile(filepath);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Rule files per load level, matching the /startup spec in
// _system/Rules/commands.md: low loads no extra rules, med loads the core
// pair, high loads everything.
function buildFirestormRuleFiles(load) {
  if (load === "low") return [];
  const files = [FIRESTORM_RULE_FILES.loadOrder, FIRESTORM_RULE_FILES.projectRules];
  if (load === "high") files.push(FIRESTORM_RULE_FILES.savingRules, FIRESTORM_RULE_FILES.commands);
  return files;
}

// Startup reads live working files into model context, but keeps hard limits so
// one large Hive cannot overflow the MCP response or the client's context.
const STARTUP_FILE_CHAR_CAP = { low: 4000, med: 8000, high: 16000 };
const STARTUP_FOLDER_ENTRY_CAP = 40;
const STARTUP_CONTEXT_FILE_LIMIT = { low: 0, med: 25, high: 60 };
const STARTUP_CONTEXT_TOTAL_CHAR_CAP = { low: 100_000, med: 200_000, high: 500_000 };
const STARTUP_CONTEXT_FILE_CHAR_CAP = { low: 10_000, med: 12_000, high: 20_000 };
const STARTUP_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv",
  ".yaml", ".yml", ".xml", ".html", ".htm", ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx", ".css", ".scss", ".py", ".ps1", ".sh",
  ".sql", ".log", ".ini", ".cfg", ".conf",
]);

function clipStartupText(text, cap, source) {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap)}\n… (truncated - use read_file "${source}" for the rest)`;
}

function isStartupReadableFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  return STARTUP_TEXT_EXTENSIONS.has(ext) || ext === ".docx";
}

function isMandatoryStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) || "";
  const inLogsOrProfiles = parts.slice(0, -1).some((part) => /(^|\s)(logs?|profiles?)(\s|$)/i.test(part));
  const namedMentalHealthProfile = /mental[\s_-]*health/.test(normalized)
    && /profile/.test(normalized)
    && (/(^|[^a-z])luke([^a-z]|$)/.test(normalized) || /(^|[^a-z])laura([^a-z]|$)/.test(normalized));
  return inLogsOrProfiles || namedMentalHealthProfile || basename === "core.docx";
}

async function readStartupFile(filepath) {
  if (path.extname(filepath).toLowerCase() !== ".docx") return ops.readFile(filepath);
  const result = await mammoth.extractRawText({ path: ops.safeResolve(filepath) });
  return result.value;
}

function prioritizeIndexedFiles(filepaths, fileIndexText = "") {
  const indexLower = fileIndexText.toLowerCase().replace(/\\\\/g, "/");
  return [...filepaths].sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aScore = (isMandatoryStartupFile(a) ? 100 : 0) + (indexLower.includes(aLower) ? 2 : (indexLower.includes(path.basename(aLower)) ? 1 : 0));
    const bScore = (isMandatoryStartupFile(b) ? 100 : 0) + (indexLower.includes(bLower) ? 2 : (indexLower.includes(path.basename(bLower)) ? 1 : 0));
    return bScore - aScore || a.localeCompare(b);
  });
}

async function discoverStartupContextFiles(folders, alreadyLoaded, fileIndexText) {
  const discovered = [];
  const seen = new Set(alreadyLoaded.map(normalizeRelativePath));
  for (const folder of folders) {
    let entries;
    try {
      entries = await ops.listFiles(folder, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      const filepath = normalizeRelativePath(entry.path);
      if (!filepath || seen.has(filepath) || isArchivePath(filepath) || isVentFolderPath(filepath)) continue;
      if (!isStartupReadableFile(filepath)) continue;
      seen.add(filepath);
      discovered.push(filepath);
    }
  }
  return prioritizeIndexedFiles(discovered, fileIndexText);
}

async function loadStartupContextFiles(filepaths, load) {
  const fileLimit = STARTUP_CONTEXT_FILE_LIMIT[load];
  const totalCap = STARTUP_CONTEXT_TOTAL_CHAR_CAP[load];
  const perFileCap = STARTUP_CONTEXT_FILE_CHAR_CAP[load];
  const mandatory = filepaths.filter(isMandatoryStartupFile);
  const normal = filepaths.filter((filepath) => !isMandatoryStartupFile(filepath));
  const selected = [...mandatory, ...(load === "low" ? [] : normal.slice(0, fileLimit))];
  const files = [];
  let totalChars = 0;
  for (let offset = 0; offset < selected.length && totalChars < totalCap; offset += BATCH_READ_MAX_FILES) {
    const batch = selected.slice(offset, offset + BATCH_READ_MAX_FILES);
    for (const filepath of batch) {
      let data;
      try {
        data = await readStartupFile(filepath);
      } catch (err) {
        files.push({ filepath, error: err.message });
        continue;
      }
      const remaining = totalCap - totalChars;
      const content = data.slice(0, Math.min(perFileCap, remaining));
      totalChars += content.length;
      files.push({ filepath, content, chars: data.length, truncated: content.length < data.length });
      if (totalChars >= totalCap) break;
    }
  }
  return {
    files,
    totalChars,
    discoveredCount: filepaths.length,
    selectedCount: selected.length,
    truncated: filepaths.length > selected.length || totalChars >= totalCap,
  };
}

async function buildFirestormStartup(projectsInput, loadInput, authContext = {}) {
  const projects = parseStartupProjects(projectsInput);
  const load = parseStartupLoadLevel(loadInput);
  const startupFiles = [...new Set(projects.map((name) => FIRESTORM_STARTUP_FILES[name]))];
  const ruleFiles = buildFirestormRuleFiles(load);
  const fileCap = STARTUP_FILE_CHAR_CAP[load];
  const folders = [...new Set(projects.flatMap((name) => FIRESTORM_PROJECT_FOLDERS[name] || []))]
    .filter((folder) => !isArchivePath(folder));

  const sections = [
    "[INTERNAL STARTUP CONTEXT - read silently and follow it. Do NOT quote, list, summarize, or re-display any of this content in your reply. Your entire reply should be just the confirmation line(s) at the bottom - nothing else unless the user asked an actual question.]",
    "",
    `/startup ${projects.join(":")} ${load}`,
  ];

  // The rules: requested project startup file(s) plus the level-appropriate
  // rule files, inlined (capped) - this is the context the model must follow.
  for (const file of [...startupFiles, ...ruleFiles]) {
    const content = await ops.readFile(file);
    sections.push("", `===== ${file} =====`, clipStartupText(content, fileCap, file));
  }

  // Always load the live index when present. It changes as the Hive changes
  // and is used to prioritise which discovered working files enter context.
  const fileIndexText = await readOptionalFile(FIRESTORM_OPTIONAL_FILES.fileIndex);
  if (fileIndexText !== null) {
    sections.push(
      "",
      `===== ${FIRESTORM_OPTIONAL_FILES.fileIndex} =====`,
      clipStartupText(fileIndexText, fileCap, FIRESTORM_OPTIONAL_FILES.fileIndex)
    );
  }

  // The folders: 0. Core plus each requested project's folder, top-level
  // listing only. _system is deliberately not listed - it's rule plumbing,
  // not working files. Deeper levels come from list_files on demand.
  const listedFolders = folders.filter((folder) => folder !== "_system");
  if (!listedFolders.includes("0. Core")) listedFolders.unshift("0. Core");
  sections.push("", "Folders in scope:");
  for (const folder of listedFolders) {
    try {
      const entries = (await ops.listFiles(folder, { recursive: false }))
        .filter((entry) => !isArchivePath(`${folder}/${entry.name}`));
      const shown = entries.slice(0, STARTUP_FOLDER_ENTRY_CAP);
      sections.push("", `===== ${folder} =====`, summarizeEntries(shown, "  "));
      if (entries.length > shown.length) {
        sections.push(`  … ${entries.length - shown.length} more - use list_files "${folder}" for the full listing`);
      }
      if (load === "high") {
        const childDirs = entries
          .filter((e) => e.type === "dir")
          .map((e) => `${folder}/${e.name}`)
          .filter((childDir) => !isArchivePath(childDir));
        for (const childDir of childDirs) {
          try {
            const childEntries = (await ops.listFiles(childDir, { recursive: false }))
              .filter((entry) => !isArchivePath(`${childDir}/${entry.name}`));
            const childShown = childEntries.slice(0, STARTUP_FOLDER_ENTRY_CAP);
            sections.push("", `--- ${childDir} ---`, summarizeEntries(childShown, "    "));
            if (childEntries.length > childShown.length) {
              sections.push(`    … ${childEntries.length - childShown.length} more - use list_files "${childDir}"`);
            }
          } catch {}
        }
      }
    } catch (err) {
      sections.push("", `===== ${folder} =====`, `(unavailable: ${err.message})`);
    }
  }

  // med/high now load actual working-file content, not just folder names.
  // Discovery is recursive and live, so renamed/new files are picked up
  // without editing this startup command. Archive and Pure Vent Mode stay out.
  let contextLoad = { files: [], totalChars: 0, discoveredCount: 0, selectedCount: 0, truncated: false };
  {
    const contextPaths = await discoverStartupContextFiles(
      listedFolders,
      [...startupFiles, ...ruleFiles, FIRESTORM_OPTIONAL_FILES.fileIndex],
      fileIndexText || ""
    );
    contextLoad = await loadStartupContextFiles(contextPaths, load);
    sections.push("", "Working files loaded into context:");
    if (!contextLoad.files.length) sections.push("(no readable working files found)");
    for (const item of contextLoad.files) {
      if (item.error) {
        sections.push("", `===== ${item.filepath} =====`, `(unavailable: ${item.error})`);
        continue;
      }
      const truncationNote = item.truncated ? "\n… (startup copy truncated; use read_file for the complete file)" : "";
      sections.push("", `===== ${item.filepath} =====`, `${item.content}${truncationNote}`);
    }
    if (contextLoad.truncated) {
      sections.push(
        "",
        `Startup context limit reached: loaded ${contextLoad.files.length} of ${contextLoad.discoveredCount} readable files (${contextLoad.totalChars} characters). Use read_folder_recursive/read_files_batch for anything else needed.`
      );
    }
  }

  const confirmations = projects
    .filter((name) => name !== "Master")
    .map((name) => {
      if (name === "Court") return "Court System active. Startup loaded. Ready.";
      if (name === "Mental") return "Mental Health System active. Startup loaded. Ready.";
      if (name === "Media") return "Media startup loaded. Ready.";
      return "Master startup loaded. Ready.";
    });
  if (projects.length === 1 && projects[0] === "Master") confirmations.push("Master startup loaded. Ready.");

  sections.push("", "Reply to the user with ONLY the following line(s) - no summary of the above:", ...confirmations);
  logEvent("tool.startup_firestorm.ok", {
    ...authContext,
    projects: projects.join(":"),
    load,
    startupFiles: startupFiles.length,
    ruleFiles: ruleFiles.length,
    folders: folders.length,
    discoveredContextFiles: contextLoad.discoveredCount,
    loadedContextFiles: contextLoad.files.length,
    loadedContextChars: contextLoad.totalChars,
  });
  return sections.join("\n");
}

// Same brand icon as the web panel's favicon (public/index.html), so
// whichever client shows this - Claude/ChatGPT's connector list, the
// panel's login screen - looks like the same product.
const SERVER_ICON_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%235b8cff'/%3E%3Ctext x='32' y='43' font-size='30' font-family='sans-serif' text-anchor='middle' fill='white'%3E%F0%9F%A7%A0%3C/text%3E%3C/svg%3E";

function buildServer(authContext = {}) {
  const server = new McpServer({
    name: "orbitfs",
    title: "OrbitFS",
    version: "1.0.0",
    description: "Shared file store and server control - list, read, write, move, sort, and trash files, plus MCP prompts for startup context and quick actions.",
    icons: [{ src: SERVER_ICON_SVG, mimeType: "image/svg+xml" }],
  });

  server.tool(
    "list_files",
    "List files and folders in the Master Hive store",
    {
      subpath: z.string().optional().describe("Relative subfolder, default root"),
      recursive: z.boolean().optional().describe("List all nested contents, not just top level"),
    },
    async ({ subpath, recursive }) => {
      logEvent("tool.list_files.start", { ...authContext, subpath: subpath || "", recursive: !!recursive });
      let entries = await ops.listFiles(subpath, { recursive });
      if (!recursive) entries = filterLegacyTopLevelEntries(subpath, entries);
      entries = filterVentFolder(subpath, entries, recursive);
      const listing = entries.map((e) => (e.type === "dir" ? "[DIR] " : "[FILE] ") + (e.path ?? e.name)).join("\n");
      logEvent("tool.list_files.ok", { ...authContext, subpath: subpath || "", recursive: !!recursive, count: entries.length });
      return { content: [{ type: "text", text: listing || "(empty)" }] };
    }
  );

  server.tool(
    "read_file",
    "Read a file's contents from the Master Hive store",
    { filepath: z.string().describe("Relative path to the file") },
    async ({ filepath }) => {
      logEvent("tool.read_file.start", { ...authContext, filepath });
      const data = await ops.readFile(filepath);
      logEvent("tool.read_file.ok", { ...authContext, filepath, chars: data.length });
      return { content: [{ type: "text", text: data }] };
    }
  );

  server.tool(
    "read_folder_recursive",
    "Recursively list every file and subfolder beneath a Master Hive folder. Use this when the full folder tree is needed, including protected project roots such as 0. Core.",
    {
      path: z.string().optional().describe("Relative folder path, default Master Hive root"),
      max_entries: z.number().int().min(1).max(RECURSIVE_LIST_MAX_ENTRIES).optional().describe("Maximum entries to return, default 10000"),
    },
    async ({ path: folderPath, max_entries }) => {
      const subpath = normalizeRelativePath(folderPath || "");
      const limit = max_entries || RECURSIVE_LIST_MAX_ENTRIES;
      logEvent("tool.read_folder_recursive.start", { ...authContext, subpath, limit });
      let entries = await ops.listFiles(subpath, { recursive: true });
      entries = filterVentFolder(subpath, entries, true);
      const truncated = entries.length > limit;
      const selected = entries.slice(0, limit);
      logEvent("tool.read_folder_recursive.ok", { ...authContext, subpath, count: selected.length, truncated });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ path: subpath, entries: selected, count: selected.length, truncated }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "read_files_batch",
    "Read multiple individual text files from the Master Hive in one call. Each result includes its path, content, original character count, and whether it was truncated.",
    {
      filepaths: z.array(z.string()).min(1).max(BATCH_READ_MAX_FILES).describe("Relative paths of the files to read"),
    },
    async ({ filepaths }) => {
      logEvent("tool.read_files_batch.start", { ...authContext, count: filepaths.length });
      const result = await readFilesBatch(filepaths);
      logEvent("tool.read_files_batch.ok", { ...authContext, requested: filepaths.length, returned: result.files.length, totalChars: result.totalChars });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "export_folder",
    "Export a Master Hive folder as a ZIP archive. Returns a temporary browser download link scoped to that folder and expiring after 15 minutes.",
    { path: z.string().describe("Relative path of the folder to export") },
    async ({ path: folderPath }) => {
      logEvent("tool.export_folder.start", { ...authContext, path: folderPath });
      const result = await buildTemporaryDownloadLink(folderPath, true);
      logEvent("tool.export_folder.ok", { ...authContext, path: folderPath });
      return { content: [{ type: "text", text: `ZIP download link (expires in ${result.expiresInMinutes} minutes): ${result.url}` }] };
    }
  );

  server.tool(
    "create_temporary_download_link",
    "Create a temporary browser download link for a Master Hive file or folder. Files download directly; folders download as ZIP archives. The link is path-scoped and expires after 15 minutes.",
    { path: z.string().describe("Relative path of the file or folder") },
    async ({ path: targetPath }) => {
      logEvent("tool.create_temporary_download_link.start", { ...authContext, path: targetPath });
      const result = await buildTemporaryDownloadLink(targetPath);
      logEvent("tool.create_temporary_download_link.ok", { ...authContext, path: targetPath, kind: result.kind });
      return { content: [{ type: "text", text: `Temporary ${result.kind} download link (expires in ${result.expiresInMinutes} minutes): ${result.url}` }] };
    }
  );

  // A bare filename (no folder in the path) means the caller never picked a
  // location. New files like that default into the _sorter inbox instead of
  // landing at the Hive root - but an existing root file keeps its path so
  // read -> edit -> write round-trips still work.
  async function defaultToSorter(filepath) {
    const normalized = filepath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalized.includes("/")) return normalized;
    try {
      await ops.statFile(normalized);
      return normalized; // existing root file being edited in place
    } catch {
      return `_sorter/${normalized}`;
    }
  }

  server.tool(
    "write_file",
    "Create or overwrite a plain text file in the Master Hive store. Do NOT use this for images, PDFs, audio, video, or any other binary file - it writes content as UTF-8 text and will corrupt binary data. Use upload_file for anything that isn't plain text. If you give a bare filename with no folder, new files are placed in the _sorter inbox.",
    {
      filepath: z.string().describe("Relative path to the file (bare filenames go to the _sorter inbox)"),
      content: z.string().describe("Full text content to write"),
    },
    async ({ filepath, content }) => {
      const target = await defaultToSorter(filepath);
      logEvent("tool.write_file.start", { ...authContext, filepath: target, requested: filepath, chars: content.length });
      await ops.writeFile(target, content);
      logEvent("file.change.write", { ...authContext, source: "mcp_tool", filepath: target, chars: content.length });
      const note = target === filepath ? "" : ` (no folder specified, so it went to the _sorter inbox)`;
      return { content: [{ type: "text", text: `Wrote ${content.length} chars to ${target}${note}` }] };
    }
  );

  server.tool(
    "upload_file",
    "Upload a binary file (image, PDF, docx, audio, video, etc.) to the OrbitFS store. Use this instead of write_file for anything that isn't plain text. Content must be base64-encoded. The server cannot read client-side or sandbox file paths such as ChatGPT or Claude attachment paths like '/mnt/data/file.pdf', so those paths are NOT valid values for contentBase64; the model must read the file bytes and base64-encode them before calling this tool. If base64 encoding is unavailable in this context, use create_upload_link instead. If a real downloadable URL exists that the server can fetch directly, use fetch_url_to_file instead. For files too big for one call, send them in pieces: first call with append=false (or omitted), then repeat with append=true using the SAME filepath until done. Max assembled size is 100MB. Verify the final size/sha256 with stat_file. If the user names a destination folder, pass the full path; a bare filename goes to the _sorter inbox.",
    {
      filepath: z.string().describe("Relative path for the upload; bare filenames (no folder) go to the _sorter inbox. Use the same value for every chunk of one file."),
      contentBase64: z.string().describe("File content (or the next chunk of it), base64-encoded"),
      append: z
        .union([z.boolean(), z.enum(["true", "false"])])
        .optional()
        .transform((v) => v === true || v === "true")
        .describe("true = append this chunk to the existing file instead of creating/overwriting it"),
    },
    async ({ filepath, contentBase64, append }) => {
      // Buffer.from(str, "base64") never throws - it silently decodes garbage
      // for non-base64 input (e.g. a literal sandbox path like /mnt/data/...),
      // which used to write a corrupt few-byte file with no error at all. Real
      // file paths almost always contain characters outside the base64
      // alphabet (., _, :, \), so a strict alphabet check reliably catches
      // that mistake and hands back a working alternative instead of failing
      // silently or with a dead-end error.
      const cleanedB64 = String(contentBase64 || "").replace(/\s+/g, "");
      if (!cleanedB64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanedB64)) {
        const { url, expiresInMinutes } = await buildUploadLink(SORT_FOLDER);
        throw new Error(
          `contentBase64 is not valid base64 - it looks like a file path or attachment reference, not encoded file content, and this server cannot read that directly. Give the user this upload link so they can upload the file themselves from their own device (single-use, expires in ${expiresInMinutes} minutes): ${url}`
        );
      }
      const buffer = Buffer.from(cleanedB64, "base64");
      const target = await defaultToSorter(filepath);
      let existingBytes = 0;
      if (append) {
        try {
          existingBytes = (await ops.statFile(target)).size;
        } catch {
          throw new Error(`Cannot append: ${target} does not exist yet - send the first chunk without append`);
        }
      }
      if (existingBytes + buffer.length > FETCH_MAX_BYTES) {
        throw new Error(`File too large (${existingBytes + buffer.length} bytes, over the ${FETCH_MAX_BYTES}-byte limit for MCP uploads) - use the web panel's upload button for larger files`);
      }
      logEvent("tool.upload_file.start", { ...authContext, filepath: target, requested: filepath, bytes: buffer.length, append: !!append });
      if (append) await ops.appendFile(target, buffer);
      else await ops.writeFile(target, buffer);
      logEvent("file.change.upload", { ...authContext, source: "mcp_tool", filepath: target, bytes: buffer.length, append: !!append });
      const total = existingBytes + buffer.length;
      const note = target === filepath ? "" : ` (no folder specified, so it went to the _sorter inbox)`;
      const appendHint = append || total !== buffer.length
        ? ` - file is now ${total} bytes; keep appending with filepath "${target}" or stat_file to verify`
        : ` - to add more chunks, call again with append=true and filepath "${target}"`;
      return { content: [{ type: "text", text: `Uploaded ${buffer.length} bytes to ${target}${note}${appendHint}` }] };
    }
  );

  server.tool(
    "delete_file",
    "Delete a file or folder from the Master Hive store",
    { filepath: z.string().describe("Relative path to the file") },
    async ({ filepath }) => {
      logEvent("tool.delete_file.start", { ...authContext, filepath });
      await ops.deleteFile(assertMutablePath(filepath, "delete"));
      logEvent("file.change.delete", { ...authContext, source: "mcp_tool", filepath });
      return { content: [{ type: "text", text: `Deleted ${filepath}` }] };
    }
  );

  server.tool(
    "move_file",
    "Move or rename a file or folder within the Master Hive store (e.g. to sort something out of _sorter into its real home). Creates destination folders as needed.",
    {
      from: z.string().describe("Relative source path"),
      to: z.string().describe("Relative destination path"),
    },
    async ({ from, to }) => {
      logEvent("tool.move_file.start", { ...authContext, from, to });
      assertMutablePath(from, "move");
      await ops.moveFile(from, to);
      logEvent("file.change.move", { ...authContext, source: "mcp_tool", from, to });
      return { content: [{ type: "text", text: `Moved ${from} -> ${to}` }] };
    }
  );

  server.tool(
    "mkdir",
    "Create a folder (and any missing parent folders) in the Master Hive store",
    { subpath: z.string().describe("Relative folder path to create") },
    async ({ subpath }) => {
      logEvent("tool.mkdir.start", { ...authContext, subpath });
      await ops.makeDir(subpath);
      logEvent("file.change.mkdir", { ...authContext, source: "mcp_tool", subpath });
      return { content: [{ type: "text", text: `Created folder ${subpath}` }] };
    }
  );

  server.tool(
    "stat_file",
    "Get size, modified time, and sha256 hash of a file in the Master Hive store",
    { filepath: z.string().describe("Relative path to the file") },
    async ({ filepath }) => {
      logEvent("tool.stat_file.start", { ...authContext, filepath });
      const info = await ops.statFile(filepath);
      logEvent("tool.stat_file.ok", { ...authContext, filepath });
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  server.tool(
    "server_status",
    "Get a live status report for Master Brain, Hive, ChatGPT, and Claude. Triggered by the user typing `/server-status`, `server status`, `show server status`, or `show hive status`.",
    {},
    async () => {
      logEvent("tool.server_status.start", authContext);
      const report = await buildServerStatusReport();
      logEvent("tool.server_status.ok", authContext);
      return { content: [{ type: "text", text: report.text }] };
    }
  );
  server.tool(
    "open_file_web",
    "Get a link to open a Master Hive file directly in a web browser. Triggered by the user typing `/openfileweb <file>`. Returns a URL that renders the file inline (PDF, image, text, etc.) or lets the browser handle it; the link is single-file-scoped and expires in 15 minutes.",
    { filepath: z.string().describe("Relative path to the file") },
    async ({ filepath }) => {
      logEvent("tool.open_file_web.start", { ...authContext, filepath });
      const { url, expiresInMinutes } = await buildFileWebLink(filepath);
      logEvent("tool.open_file_web.ok", { ...authContext, filepath });
      return {
        content: [
          { type: "text", text: `Open in browser (expires in ${expiresInMinutes} minutes): ${url}` },
        ],
      };
    }
  );

  server.tool(
    "create_upload_link",
    "Create a short-lived, single-use upload link for browser-based multipart uploads into the Hive. Use this when you cannot base64-encode the file for upload_file. The link expires after 15 minutes and uploads into the _sorter inbox by default.",
    {},
    async () => {
      logEvent("tool.create_upload_link.start", authContext);
      const { url, expiresInMinutes, destination } = await buildUploadLink(SORT_FOLDER);
      logEvent("tool.create_upload_link.ok", { ...authContext, destination });
      return {
        content: [
          { type: "text", text: `Upload link (single-use, expires in ${expiresInMinutes} minutes): ${url}` },
        ],
      };
    }
  );

  server.tool(
    "ventmode",
    "Turn Pure Vent Mode on or off. This is a private, unfiltered journaling mode - while active, preserve the user's exact wording, tone, swearing, and intensity; don't soften, moralize, reframe, or unnecessarily polish anything; don't upload or save anything automatically; don't offer advice or commentary unless directly asked. State is stored server-side per authenticated user, not just remembered by you.",
    { state: z.enum(["on", "off"]).describe("on = activate Pure Vent Mode, off = deactivate it") },
    async ({ state }) => {
      const session = getVentSession(authContext);
      session.active = state === "on";
      logEvent("tool.ventmode", { ...authContext, state });
      if (state === "on") {
        return { content: [{ type: "text", text: "🔴\nVENT MODE — ACTIVE\nChat-scoped. Private. Raw. Go." }] };
      }
      return { content: [{ type: "text", text: "VENT MODE — OFF" }] };
    }
  );

  server.tool(
    "style_vent_entry",
    "Lock in the final draft of a Pure Vent Mode entry - required before upload_vent_entry, and the only step that determines what gets uploaded. Before calling this, YOU must already have: preserved the user's exact wording/tone/swearing/intensity, corrected only obvious spelling or speech-to-text errors, added paragraph breaks for readability, and chosen a suitable title. This tool does not rewrite anything itself - it stores and echoes back exactly the text and title you pass in as the one draft eligible for upload. Requires Pure Vent Mode to be active. Does not upload or create any file.",
    {
      text: z.string().describe("The final styled entry text, exactly as it should be uploaded"),
      title: z.string().describe("A suitable title for the entry, chosen by you"),
      entry_date: z.string().optional().describe("Entry date as DD-MM-YYYY; defaults to today in Sydney time"),
    },
    async ({ text, title, entry_date }) => {
      const session = getVentSession(authContext);
      if (!session.active) {
        throw new Error('Pure Vent Mode is not active. Call ventmode with state="on" first.');
      }
      const cleanTitle = sanitizeVentTitle(title);
      const entryDate = entry_date || sydneyDateDDMMYYYY();
      monthYearFromEntryDate(entryDate); // throws if the format/date is invalid
      const hash = hashVentDraft(cleanTitle, entryDate, text);
      session.pendingDraft = { title: cleanTitle, entryDate, text, hash, createdAt: Date.now() };
      logEvent("tool.style_vent_entry.ok", { ...authContext, chars: text.length, entryDate });
      return {
        content: [
          {
            type: "text",
            text: `FINAL DRAFT\n\n${cleanTitle}\n\n${entryDate}\n\n${text}\n\nStatus: Awaiting /uploadvent`,
          },
        ],
      };
    }
  );

  server.tool(
    "upload_vent_entry",
    "Upload the exact pending draft most recently locked in by style_vent_entry. Takes no entry text - it reads the approved draft from server-side session state so content can't be silently swapped in at upload time. Refuses if Pure Vent Mode isn't active, if style_vent_entry hasn't been called, or if the stored draft fails its integrity check. This IS the confirmation - do not ask the user to confirm again after they type /uploadvent.",
    {},
    async () => {
      const session = getVentSession(authContext);
      if (!session.active) {
        throw new Error('Pure Vent Mode is not active. Call ventmode with state="on" first.');
      }
      const draft = session.pendingDraft;
      if (!draft) {
        throw new Error("No pending draft. Call style_vent_entry first.");
      }
      if (hashVentDraft(draft.title, draft.entryDate, draft.text) !== draft.hash) {
        throw new Error("Pending draft failed its integrity check - call style_vent_entry again.");
      }

      const { monthYear } = monthYearFromEntryDate(draft.entryDate);
      const monthDir = `${VENT_FOLDER}/${monthYear}`;
      await ops.makeDir(monthDir);
      const filename = `${draft.entryDate} - ${draft.title}.md`;
      const filepath = `${monthDir}/${filename}`;
      const fileContent = `# ${draft.title}\n\n${draft.entryDate}\n\n${draft.text}\n`;
      await ops.writeFile(filepath, fileContent);

      // Never log the raw vent text itself - path/size/user only.
      logEvent("file.change.upload", {
        ...authContext,
        source: "vent_mode",
        filepath,
        bytes: Buffer.byteLength(fileContent, "utf8"),
      });

      session.pendingDraft = null;
      return {
        content: [{ type: "text", text: `Uploaded: \`${filename}\`\nLocation: \`/${monthDir}/\`` }],
      };
    }
  );

  server.tool(
    "search_files",
    "Search file contents for a substring within the Master Hive store",
    {
      query: z.string().describe("Substring to search for"),
      subpath: z.string().optional().describe("Relative subfolder to search, default root"),
    },
    async ({ query, subpath }) => {
      logEvent("tool.search_files.start", { ...authContext, query, subpath: subpath || "" });
      const matches = (await ops.searchFiles(query, subpath)).filter((m) => !isVentFolderPath(m.path));
      logEvent("tool.search_files.ok", { ...authContext, query, matchCount: matches.length });
      const text = matches.length ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") : "(no matches)";
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "fetch_url_to_file",
    "Download a URL and save it into the Hive store, binary-safe (docx, PDF, images, audio all fine). Use this when a real downloadable URL exists that the Hive server itself can access directly. If you only have a ChatGPT or Claude sandbox path like '/mnt/data/file.pdf', the server cannot read that path; use upload_file with base64 content or create_upload_link instead. Bare filenames with no folder go to the _sorter inbox.",
    {
      url: z.string().url().describe("URL to fetch"),
      filepath: z.string().describe("Relative path to save the content to (bare filenames go to the _sorter inbox)"),
    },
    async ({ url, filepath }) => {
      logEvent("tool.fetch_url_to_file.start", { ...authContext, url, filepath });
      const controller = new AbortController();
      const resp = await fetch(url, { redirect: "follow", signal: controller.signal });
      if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
      const reader = resp.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > FETCH_MAX_BYTES) {
            controller.abort();
            throw new Error(`Response too large (over ${FETCH_MAX_BYTES} bytes, aborted mid-download)`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock?.();
      }
      // Write raw bytes - converting to a UTF-8 string here used to corrupt
      // binary downloads (docx, images, PDFs). Text files are bytes too, so
      // writing the buffer is correct for everything.
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const target = await defaultToSorter(filepath);
      await ops.writeFile(target, buf);
      logEvent("file.change.write", { ...authContext, source: "mcp_tool_fetch_url", filepath: target, bytes: buf.length, url });
      const note = target === filepath ? "" : ` (no folder specified, so it went to the _sorter inbox)`;
      return { content: [{ type: "text", text: `Saved ${buf.length} bytes from ${url} to ${target}${note}` }] };
    }
  );

  server.tool(
    "preview_sort_inbox",
    `Preview where each item sitting in the "${SORT_FOLDER}" staging folder would go if sorted. Does NOT move anything - show this to the user and only call apply_sort_inbox once they've confirmed the destinations (they may want to edit some).`,
    {},
    async () => {
      logEvent("tool.sort_inbox.preview_call", authContext);
      const { proposals, errors, note } = await planSortInbox(authContext);
      if (note) return { content: [{ type: "text", text: note }] };
      const lines = proposals.map((p) => `${p.item} -> ${p.destination}${p.isNewFolder ? " (new folder)" : ""} - ${p.reason}`);
      if (errors.length) lines.push("", "Could not classify:", ...errors.map((e) => `${e.item}: ${e.error}`));
      lines.push("", "Nothing has moved yet. Confirm with the user, then call apply_sort_inbox with the item/destination pairs they approve.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "startup_firestorm",
    "Hardcoded Project FireStorm startup command. Equivalent to /startup <project> <low|med|high>. Loads the correct startup files, rule files, and relevant folder listings without making any changes.",
    {
      project: z.string().describe("Project name or combined projects separated with ':'. Use Master, Court, Mental, Media, or combinations like Court:Mental"),
      load_level: z.string().optional().describe("low, med, high. Also accepts aliases: light, normal, full"),
    },
    async ({ project, load_level }) => {
      logEvent("tool.startup_firestorm.start", { ...authContext, project, load: load_level || "med" });
      const text = await buildFirestormStartup(project, load_level || "med", authContext);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "move_to_trash",
    `Move a file or folder into "${TRASH_FOLDER}" instead of permanently deleting it. The original relative path is preserved under a timestamped trash entry.`,
    { filepath: z.string().describe(`Relative path to move into ${TRASH_FOLDER}`) },
    async ({ filepath }) => {
      logEvent("tool.move_to_trash.start", { ...authContext, filepath });
      const result = await movePathToTrash(filepath, { ...authContext, source: "mcp_tool" });
      return { content: [{ type: "text", text: `Moved ${result.from} -> ${result.to}` }] };
    }
  );

  server.tool(
    "empty_trash",
    `Permanently delete everything currently inside "${TRASH_FOLDER}". Use this only after explicit user confirmation.`,
    {},
    async () => {
      logEvent("tool.empty_trash.start", authContext);
      const result = await emptyTrash({ ...authContext, source: "mcp_tool" });
      return {
        content: [{
          type: "text",
          text: result.deletedCount ? `Deleted ${result.deletedCount} trash entr${result.deletedCount === 1 ? "y" : "ies"}.` : "Trash is already empty.",
        }],
      };
    }
  );

  server.tool(
    "get_trash_config",
    `Get the current auto-purge retention for "${TRASH_FOLDER}".`,
    {},
    async () => {
      const config = await loadTrashConfig();
      return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
    }
  );

  server.tool(
    "apply_sort_inbox",
    `Move the confirmed items out of "${SORT_FOLDER}" to the given destinations. Only call this after preview_sort_inbox and explicit user confirmation of each destination - do not guess destinations here.`,
    {
      moves: z
        .array(
          z.object({
            item: z.string().describe(`Name of the file/folder inside ${SORT_FOLDER} to move`),
            destination: z.string().describe("Confirmed destination folder (relative path, no leading/trailing slash)"),
          })
        )
        .describe("Confirmed item -> destination pairs from preview_sort_inbox"),
    },
    async ({ moves }) => {
      logEvent("tool.sort_inbox.apply_call", { ...authContext, count: moves.length });
      const { moved, errors } = await applySortMoves(moves, authContext);
      const lines = moved.map((m) => `${m.item} -> ${m.to}`);
      if (errors.length) lines.push("", "Errors:", ...errors.map((e) => `${e.item}: ${e.error}`));
      return { content: [{ type: "text", text: lines.join("\n") || "Nothing moved." }] };
    }
  );

  // --- Prompts: real client-side slash commands (autocomplete + argument
  // prompts in Claude's UI), not just text convention the model has to
  // infer. Each one seeds a user turn naming the exact tool + args to call,
  // so the actual work still happens through the tools above. Arg names
  // always match the underlying tool's own param names.
  function toolPrompt(name, description, argsShape, toolName, extraInstruction) {
    server.prompt(name, description, argsShape, async (args) => {
      const argText = Object.entries(args)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${k}="${v}"`)
        .join(", ");
      const text = [`Use the ${toolName} tool${argText ? ` with ${argText}` : ""}.`, extraInstruction]
        .filter(Boolean)
        .join(" ");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    });
  }

  toolPrompt(
    "openfileweb",
    "Get a link to open a file directly in a browser",
    { filepath: z.string().describe("Relative path to the file") },
    "open_file_web",
    "Share the resulting URL with me, noting it expires in 15 minutes."
  );

  toolPrompt(
    "startup",
    "Load Project FireStorm startup context for one or more projects",
    {
      project: z.string().describe("Master, Court, Mental, Media, or combined with ':' e.g. Court:Mental"),
      load_level: z.string().optional().describe("low, med, high (default med). Aliases: light, normal, full"),
    },
    "startup_firestorm",
    "Reply following the startup contract (normalized command, files loaded, active rules, in-scope folders, confirmation line)."
  );

  toolPrompt(
    "list",
    "List files and folders in a Master Hive folder",
    { subpath: z.string().optional().describe("Relative folder, default root") },
    "list_files"
  );

  toolPrompt("read", "Read a file's contents", { filepath: z.string().describe("Relative path to the file") }, "read_file");

  toolPrompt(
    "search",
    "Search file contents for a substring",
    {
      query: z.string().describe("Text to search for"),
      subpath: z.string().optional().describe("Relative folder to search, default root"),
    },
    "search_files"
  );

  toolPrompt(
    "stat",
    "Get size, modified time, and hash of a file",
    { filepath: z.string().describe("Relative path to the file") },
    "stat_file"
  );

  toolPrompt(
    "server-status",
    "Get a live status report for Master Brain, Hive, ChatGPT, and Claude",
    {},
    "server_status",
    "Reply with the returned text exactly and do not add any extra commentary."
  );
  toolPrompt(
    "move",
    "Move or rename a file or folder",
    { from: z.string().describe("Relative source path"), to: z.string().describe("Relative destination path") },
    "move_file"
  );

  toolPrompt("mkdir", "Create a folder", { subpath: z.string().describe("Relative folder path to create") }, "mkdir");

  toolPrompt(
    "trash",
    `Move a file or folder into "${TRASH_FOLDER}"`,
    { filepath: z.string().describe(`Relative path to move into ${TRASH_FOLDER}`) },
    "move_to_trash"
  );

  toolPrompt(
    "sort",
    `Preview where items in "${SORT_FOLDER}" would be sorted (read-only)`,
    {},
    "preview_sort_inbox",
    "Do not call apply_sort_inbox until I confirm each destination."
  );

  toolPrompt(
    "emptybin",
    `Permanently delete everything currently in "${TRASH_FOLDER}"`,
    {},
    "empty_trash",
    `First list what's in ${TRASH_FOLDER} and confirm with me exactly what will be permanently deleted before calling empty_trash - this cannot be undone.`
  );

  toolPrompt(
    "ventmode",
    "Turn Pure Vent Mode on or off",
    { state: z.enum(["on", "off"]).describe("on or off") },
    "ventmode"
  );

  toolPrompt(
    "styleentry",
    "Lock in the final styled draft of a Pure Vent Mode entry, required before /uploadvent",
    {
      text: z.string().describe("The final styled entry text"),
      title: z.string().describe("A suitable title"),
      entry_date: z.string().optional().describe("DD-MM-YYYY, defaults to today in Sydney time"),
    },
    "style_vent_entry"
  );

  toolPrompt(
    "uploadvent",
    "Upload the most recently styled Pure Vent Mode draft",
    {},
    "upload_vent_entry",
    "This is the confirmation - do not ask me to confirm again."
  );

  return server;
}

const app = express();
let serverHandle = null;

mountOAuth(app, {
  publicBaseUrl: PUBLIC_BASE_URL,
  cfAuthEndpoint: process.env.CF_AUTHORIZE_URL,
  cfTokenEndpoint: process.env.CF_TOKEN_URL,
  cfClientId: process.env.CF_CLIENT_ID,
  cfClientSecret: process.env.CF_CLIENT_SECRET,
  secretKey: SECRET_KEY,
});

app.use((req, res, next) => {
  req.id = requestId();
  const started = Date.now();
  res.on("finish", () => {
    logEvent("http.request", {
      ...requestContext(req),
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
});

app.use(express.json());

async function checkAuth(req) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    logEvent("auth.missing", requestContext(req));
    return false;
  }
  const token = auth.slice(7);
  if (token === API_KEY) {
    const headerFlow = String(req.headers["x-hive-flow"] || "").toLowerCase();
    const flow = ["chatgpt", "claude", "webpanel"].includes(headerFlow) ? headerFlow : "api_key";
    req.authContext = { type: "api_key", flow };
    logEvent("auth.api_key.ok", requestContext(req));
    return true;
  }
  try {
    const { payload } = await jwtVerify(token, SECRET_KEY, {
      issuer: PUBLIC_BASE_URL,
      audience: `${PUBLIC_BASE_URL}/mcp`,
    });
    req.authContext = {
      type: "jwt",
      flow: payload.flow || "unknown",
      email: payload.email || payload.sub || null,
    };
    logEvent("auth.jwt.ok", requestContext(req));
    return !!payload;
  } catch (err) {
    logError("auth.jwt.failed", err, requestContext(req));
    return false;
  }
}

app.use("/mcp", async (req, res, next) => {
  const ok = await checkAuth(req);
  if (!ok) {
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`
    );
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.post("/mcp", async (req, res) => {
  logEvent("mcp.request.start", { ...requestContext(req), ...summarizeMcpBody(req.body) });
  const server = buildServer(req.authContext || {});
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logError("mcp.request.failed", err, { ...requestContext(req), ...summarizeMcpBody(req.body) });
    throw err;
  }
});

// --- REST API for the Master Brain web panel ---------------------------
// Same underlying file store as the MCP tools above, same HIVE_API_KEY
// bearer auth, just a plain REST shape the panel's browser JS can call
// directly (upload/download need raw bytes, which doesn't map cleanly onto
// MCP tool calls over JSON-RPC).

app.get("/api/ping", (req, res) => res.json({ ok: true, name: "orbitfs" }));

app.use("/api", async (req, res, next) => {
  if (req.path === "/ping") return next();
  if (req.path === "/upload" && req.query.token) return next();
  const ok = await checkAuth(req);
  if (!ok) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/api/manifest", async (req, res) => {
  try {
    const files = await ops.manifest();
    logEvent("api.manifest.ok", { ...requestContext(req), count: files.length });
    res.json({ files });
  } catch (err) {
    logError("api.manifest.failed", err, requestContext(req));
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/files", async (req, res) => {
  try {
    const dir = ops.safeResolve(req.query.subpath);
    let entries = await fs.readdir(dir, { withFileTypes: true });
    entries = filterLegacyTopLevelEntries(req.query.subpath, entries);
    const withStats = await Promise.all(
      entries.map(async (e) => {
        if (e.isDirectory()) return { name: e.name, type: "dir" };
        const stat = await fs.stat(path.join(dir, e.name));
        return { name: e.name, type: "file", size: stat.size, mtime: stat.mtime.toISOString() };
      })
    );
    logEvent("api.files.ok", { ...requestContext(req), subpath: req.query.subpath || "", count: withStats.length });
    res.json({ entries: withStats });
  } catch (err) {
    logError("api.files.failed", err, { ...requestContext(req), subpath: req.query.subpath || "" });
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/files/recursive", async (req, res) => {
  try {
    const subpath = normalizeRelativePath(req.query.path || "");
    const limit = Math.min(Number(req.query.max_entries || RECURSIVE_LIST_MAX_ENTRIES), RECURSIVE_LIST_MAX_ENTRIES);
    let entries = await ops.listFiles(subpath, { recursive: true });
    entries = filterVentFolder(subpath, entries, true);
    const truncated = entries.length > limit;
    entries = entries.slice(0, limit);
    logEvent("api.files.recursive.ok", { ...requestContext(req), subpath, count: entries.length, truncated });
    res.json({ path: subpath, entries, count: entries.length, truncated });
  } catch (err) {
    logError("api.files.recursive.failed", err, { ...requestContext(req), path: req.query.path || "" });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/files/read-batch", async (req, res) => {
  try {
    const result = await readFilesBatch(req.body?.filepaths);
    logEvent("api.files.read_batch.ok", { ...requestContext(req), requested: req.body?.filepaths?.length || 0, returned: result.files.length });
    res.json(result);
  } catch (err) {
    logError("api.files.read_batch.failed", err, requestContext(req));
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/export-folder-link", async (req, res) => {
  try {
    const result = await buildTemporaryDownloadLink(req.query.path, true);
    logEvent("api.export_folder_link.ok", { ...requestContext(req), path: req.query.path });
    res.json(result);
  } catch (err) {
    logError("api.export_folder_link.failed", err, { ...requestContext(req), path: req.query.path });
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const content = await ops.readFile(req.query.path);
    logEvent("api.file.read.ok", { ...requestContext(req), path: req.query.path, chars: content.length });
    res.json({ content });
  } catch (err) {
    logError("api.file.read.failed", err, { ...requestContext(req), path: req.query.path });
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/stat", async (req, res) => {
  try {
    const info = await ops.statFile(req.query.path);
    logEvent("api.stat.ok", { ...requestContext(req), path: req.query.path });
    res.json(info);
  } catch (err) {
    logError("api.stat.failed", err, { ...requestContext(req), path: req.query.path });
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.query || "");
    if (!query) throw new Error("query is required");
    const matches = await ops.searchFiles(query, req.query.subpath);
    logEvent("api.search.ok", { ...requestContext(req), query, subpath: req.query.subpath || "", matchCount: matches.length });
    res.json({ matches });
  } catch (err) {
    logError("api.search.failed", err, { ...requestContext(req), query: req.query.query, subpath: req.query.subpath || "" });
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/file", async (req, res) => {
  try {
    await ops.writeFile(req.body.path, req.body.content ?? "");
    logEvent("file.change.write", { ...requestContext(req), source: "rest_api", path: req.body.path, chars: (req.body.content ?? "").length });
    res.json({ ok: true });
  } catch (err) {
    logError("api.file.write.failed", err, { ...requestContext(req), path: req.body?.path });
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/file", async (req, res) => {
  try {
    await ops.deleteFile(assertMutablePath(req.query.path, "delete"));
    logEvent("file.change.delete", { ...requestContext(req), source: "rest_api", path: req.query.path });
    res.json({ ok: true });
  } catch (err) {
    logError("api.file.delete.failed", err, { ...requestContext(req), path: req.query.path });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/move", async (req, res) => {
  try {
    assertMutablePath(req.body.from, "move");
    await ops.moveFile(req.body.from, req.body.to);
    logEvent("file.change.move", { ...requestContext(req), source: "rest_api", from: req.body.from, to: req.body.to });
    res.json({ ok: true });
  } catch (err) {
    logError("api.move.failed", err, { ...requestContext(req), from: req.body?.from, to: req.body?.to });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/mkdir", async (req, res) => {
  try {
    await ops.makeDir(req.body.path);
    logEvent("file.change.mkdir", { ...requestContext(req), source: "rest_api", path: req.body.path });
    res.json({ ok: true });
  } catch (err) {
    logError("api.mkdir.failed", err, { ...requestContext(req), path: req.body?.path });
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const full = ops.safeResolve(req.query.path);
    logEvent("api.download.start", { ...requestContext(req), path: req.query.path });
    res.download(full, path.basename(full));
  } catch (err) {
    logError("api.download.failed", err, { ...requestContext(req), path: req.query.path });
    res.status(400).json({ error: err.message });
  }
});

// Bearer-authed (covered by the app.use("/api", ...) guard above): hands
// back a shareable link rather than the file itself, for the ChatGPT
// Actions lane behind /openfileweb - see /open below for the link target.
app.get("/api/open-link", async (req, res) => {
  try {
    const { url, expiresInMinutes } = await buildFileWebLink(req.query.path);
    logEvent("api.open_link.ok", { ...requestContext(req), path: req.query.path });
    res.json({ url, expiresInMinutes });
  } catch (err) {
    logError("api.open_link.failed", err, { ...requestContext(req), path: req.query.path });
    res.status(400).json({ error: err.message });
  }
});

// Deliberately outside /api and the bearer-auth guard above: this is the
// link target /openfileweb hands out, meant to be opened directly in a
// browser tab, which can't attach an Authorization header. Auth instead
// comes from the short-lived, single-file-scoped token in the URL itself.
app.get("/open", async (req, res) => {
  const relPath = req.query.path;
  try {
    const token = req.query.token;
    if (!token) return res.status(401).send("Missing token. Ask for a fresh link with /openfileweb <file>.");
    const { payload } = await jwtVerify(String(token), SECRET_KEY, { issuer: PUBLIC_BASE_URL });
    if (payload.purpose !== "file_view" || payload.path !== relPath) {
      throw new Error("Token does not match the requested file");
    }
    const full = ops.safeResolve(relPath);
    logEvent("open.file.ok", { ...requestContext(req), path: relPath });
    res.sendFile(full);
  } catch (err) {
    logError("open.file.failed", err, { ...requestContext(req), path: relPath });
    res.status(401).send("This link is invalid or has expired. Ask for a fresh one with /openfileweb <file>.");
  }
});

app.get("/download-temp", async (req, res) => {
  const relPath = normalizeRelativePath(req.query.path);
  try {
    const token = req.query.token;
    if (!token) return res.status(401).send("Missing or expired download token.");
    const { payload } = await jwtVerify(String(token), SECRET_KEY, { issuer: PUBLIC_BASE_URL });
    if (payload.purpose !== "temporary_download" || payload.path !== relPath) {
      throw new Error("Token does not match the requested path");
    }
    const full = ops.safeResolve(relPath);
    const st = await fs.stat(full);
    const actualKind = st.isDirectory() ? "folder" : "file";
    if (payload.kind !== actualKind) throw new Error("Path type changed after the link was created");
    logEvent("temporary_download.ok", { ...requestContext(req), path: relPath, kind: actualKind });
    if (actualKind === "folder") return await streamFolderZip(res, relPath);
    return res.download(full, path.basename(full));
  } catch (err) {
    logError("temporary_download.failed", err, { ...requestContext(req), path: relPath });
    if (!res.headersSent) res.status(401).send("This download link is invalid or has expired. Ask for a fresh link.");
  }
});

app.get("/upload", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).send("Missing token. Ask for a fresh upload link.");
    await verifyUploadLinkToken(token, { consume: false });
    const uploadUrl = new URL("/api/upload", PUBLIC_BASE_URL);
    uploadUrl.searchParams.set("token", String(token));
    res.type("html").send(renderUploadPage(uploadUrl.toString()));
  } catch (err) {
    logError("open.upload.failed", err, requestContext(req));
    res.status(401).send("This upload link is invalid, already used, or has expired. Ask for a fresh one.");
  }
});

// Raw binary body, path given as a query param (browsers set Content-Type to
// the file's own mime type on upload, so accept any content-type here).
app.post("/api/upload", express.raw({ type: () => true, limit: FETCH_MAX_BYTES }), async (req, res) => {
  try {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (contentType.startsWith("multipart/form-data")) {
      const token = req.query.token;
      if (!token) return res.status(401).json({ error: "Unauthorized" });
      const { filename, buffer } = parseMultipartFile(req);
      if (buffer.length > FETCH_MAX_BYTES) {
        throw new Error(`File too large (${buffer.length} bytes, over the ${FETCH_MAX_BYTES}-byte limit)`);
      }
      const uploadAuth = await verifyUploadLinkToken(token, { consume: true });
      const filepath = `${uploadAuth.destination}/${filename}`;
      await ops.writeFile(filepath, buffer);
      logEvent("file.change.upload", {
        ...requestContext(req),
        source: "rest_api_upload_link",
        path: filepath,
        filename,
        bytes: buffer.length,
      });
      return res.json({ success: true, filepath, filename, size: buffer.length });
    }

    const rawPath = req.query.path;
    if (!req.authContext) return res.status(401).json({ error: "Unauthorized" });
    const filepath = normalizeRelativePath(rawPath);
    if (!filepath) throw new Error("path is required");
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (bytes.length > FETCH_MAX_BYTES) {
      throw new Error(`File too large (${bytes.length} bytes, over the ${FETCH_MAX_BYTES}-byte limit)`);
    }
    await ops.writeFile(filepath, bytes);
    logEvent("file.change.upload", { ...requestContext(req), source: "rest_api", path: filepath, bytes: bytes.length });
    res.json({ ok: true, success: true, filepath, filename: path.basename(filepath), size: bytes.length, bytes: bytes.length });
  } catch (err) {
    logError("api.upload.failed", err, { ...requestContext(req), path: req.query.path });
    const status = /too large/i.test(err.message) ? 413 : (err.code === "ERR_JOSE_GENERIC" || /token|Unauthorized/i.test(err.message) ? 401 : 400);
    res.status(status).json({ error: err.message });
  }
});

// Read-only summary of connected MCP clients (Claude/ChatGPT DCR registrations
// + which accounts hold a refresh token) - no secrets included.
app.get("/api/server-status", async (req, res) => {
  try {
    const status = await buildServerStatusReport();
    logEvent("api.server_status.ok", requestContext(req));
    res.json(status);
  } catch (err) {
    logError("api.server_status.failed", err, requestContext(req));
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/oauth-state", (req, res) => {
  logEvent("api.oauth_state.ok", requestContext(req));
  res.json(getOAuthState());
});

app.post("/api/sort/preview", async (req, res) => {
  try {
    const result = await planSortInbox({ ...requestContext(req), source: "rest_api" });
    logEvent("api.sort.preview.ok", { ...requestContext(req), proposedCount: result.proposals.length, errorCount: result.errors.length });
    res.json(result);
  } catch (err) {
    logError("api.sort.preview.failed", err, requestContext(req));
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sort/apply", async (req, res) => {
  try {
    const result = await applySortMoves(req.body?.moves, { ...requestContext(req), source: "rest_api" });
    logEvent("api.sort.apply.ok", { ...requestContext(req), movedCount: result.moved.length, errorCount: result.errors.length });
    res.json(result);
  } catch (err) {
    logError("api.sort.apply.failed", err, requestContext(req));
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/trash", async (req, res) => {
  try {
    const result = await movePathToTrash(req.body?.path, { ...requestContext(req), source: "rest_api" });
    res.json({ ok: true, ...result });
  } catch (err) {
    logError("api.trash.move.failed", err, { ...requestContext(req), path: req.body?.path });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/trash/empty", async (req, res) => {
  try {
    const result = await emptyTrash({ ...requestContext(req), source: "rest_api" });
    res.json({ ok: true, ...result });
  } catch (err) {
    logError("api.trash.empty.failed", err, requestContext(req));
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/trash/config", async (req, res) => {
  try {
    res.json(await loadTrashConfig());
  } catch (err) {
    logError("api.trash.config.read.failed", err, requestContext(req));
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/trash/config", async (req, res) => {
  try {
    const config = await saveTrashConfig(req.body?.retentionDays);
    logEvent("api.trash.config.updated", { ...requestContext(req), retentionDays: config.retentionDays });
    res.json({ ok: true, ...config });
  } catch (err) {
    logError("api.trash.config.update.failed", err, { ...requestContext(req), retentionDays: req.body?.retentionDays });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/startup", async (req, res) => {
  try {
    const text = await buildFirestormStartup(req.body?.project || "Master", req.body?.load_level || "med", {
      ...requestContext(req),
      source: "rest_api",
    });
    logEvent("api.startup.ok", { ...requestContext(req), project: req.body?.project || "Master", load: req.body?.load_level || "med" });
    res.json({ text });
  } catch (err) {
    logError("api.startup.failed", err, { ...requestContext(req), project: req.body?.project, load: req.body?.load_level });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/shutdown", async (req, res) => {
  logEvent("api.admin.shutdown.requested", requestContext(req));
  res.json({ ok: true, shuttingDown: true });
  setTimeout(() => {
    if (!serverHandle) {
      process.exit(0);
      return;
    }
    serverHandle.close((err) => {
      if (err) {
        logError("api.admin.shutdown.failed", err, requestContext(req));
        process.exit(1);
        return;
      }
      logEvent("api.admin.shutdown.complete", requestContext(req));
      process.exit(0);
    });
  }, 50);
});

serverHandle = app.listen(PORT, async () => {
  await fs.mkdir(LOG_DIR, { recursive: true }).catch(() => {});
  purgeExpiredTrash({ source: "startup" }).catch((err) => logError("trash.autopurge.startup.failed", err));
  setInterval(() => {
    purgeExpiredTrash({ source: "interval" }).catch((err) => logError("trash.autopurge.interval.failed", err));
  }, TRASH_PURGE_INTERVAL_MS).unref();
  logEvent("server.start", { port: PORT, root: ROOT, publicBaseUrl: PUBLIC_BASE_URL });
});







