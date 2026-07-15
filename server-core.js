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
import { mountOAuth, getOAuthState, revokeOAuthAccess } from "./oauth.js";
import { makeOps } from "./hive-ops.js";
import archiver from "archiver";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const ROOT = process.env.HIVE_ROOT;
const API_KEY = process.env.HIVE_API_KEY;
const PORT = process.env.PORT || 3939;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const SECRET_KEY = new TextEncoder().encode(process.env.SESSION_SECRET);
const SORT_FOLDER = "_sorter";
const TRASH_FOLDER = "_trash";
const GHOST_TRASH_ROOT = process.env.GHOST_TRASH_ROOT || "B:\\OrbitFS Recovery\\Ghost Trash";
const VENT_FOLDER = "2. Wellbeing/Pure Vent Mode";
const JOURNAL_FOLDER = "2. Wellbeing/Letters Documents/Journal Entries";
const JOURNAL_MODE_RULES = `[JOURNAL MODE - ACTIVE CHAT RULES]
Journal Mode overlays the current chat and preserves all active OrbitFS context. It is for ordinary thoughts, reflections, events, ideas, memories, plans, and day-to-day life.
While active: respond normally and conversationally. Do not dramatise, clinically reinterpret, or turn every message into advice. Do not save anything automatically.
When asked to style the journal entry, preserve Luke's wording, meaning, tone, and sequence. Lightly correct obvious transcription errors, add paragraphs, title, and date, and remove only accidental repetition. Do not soften strong wording or add interpretations.
Saving requires separate explicit approval and must upload the exact locked draft.`;
const VENT_MODE_RULES = `[PURE VENT MODE - ACTIVE CHAT RULES]
Vent Mode overlays the current chat and all currently active OrbitFS context. Never clear, replace, unload, or block existing context. More context may be loaded while Vent Mode is active.
This is Luke's protected space to vent worries, stress, anger, grief, paranoia, life events, and unsent thoughts without judgment or unwanted change.
While active: match Luke's wording, tone, energy, and strong language. Do not soften, polish, clinically reframe, summarise, interpret, explain emotions, automatically analyse, or automatically ask wellbeing questions. Conversation comes first.
Nothing is recorded, saved, uploaded, or turned into a document automatically.
When asked to make a vent entry, create a safe readable draft that remains 99% Luke and 1% formatting. Only correct obvious transcription errors, add paragraph spacing, title, and date. Never rewrite, soften, interpret, or save automatically.
Saving requires a separate explicit approval and must use the approved draft exactly.`;
const LEGACY_TRASH_FOLDERS = ["?? Trash"];
// TEMPORARILY EMPTY during the top-level folder redesign - delete/move/trash
// protection for root folders is off. Restore the real list below once the
// new structure is settled:
//   "_system", "_sorter", "_trash", "0. Core", "1. Legal",
//   "2. Wellbeing", "_media"
const PROTECTED_ROOT_FOLDERS = new Set(["_sorter"]);
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
const PRIVATE_DRAFT_STATE_FILE = path.join(SERVER_DIR, "private-drafts.json");
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

const LOG_ROTATE_MAX_BYTES = 5 * 1024 * 1024;
const LOG_ROTATE_MAX_BACKUPS = 3;

async function rotateLogIfNeeded(filepath) {
  let stat;
  try { stat = await fs.stat(filepath); } catch { return; }
  if (stat.size < LOG_ROTATE_MAX_BYTES) return;
  try {
    for (let i = LOG_ROTATE_MAX_BACKUPS - 1; i >= 1; i--) {
      const from = `${filepath}.${i}`;
      const to = `${filepath}.${i + 1}`;
      await fs.rm(to, { force: true }).catch(() => {});
      await fs.rename(from, to).catch(() => {});
    }
    await fs.rename(filepath, `${filepath}.1`);
  } catch {}
}

function logEvent(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  console.log(line);
  rotateLogIfNeeded(EVENT_LOG_FILE).finally(() => {
    fs.appendFile(EVENT_LOG_FILE, `${line}\n`).catch(() => {});
  });
}

function logError(event, err, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, error: err.message, ...fields });
  console.error(line);
  rotateLogIfNeeded(ERROR_LOG_FILE).finally(() => {
    fs.appendFile(ERROR_LOG_FILE, `${line}\n`).catch(() => {});
  });
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
    : (services.hive.running ? `OrbitFS service running, but local ping failed${hiveLocal.error ? `: ${hiveLocal.error}` : "."}` : `OrbitFS service ${services.hive.status}.`);
  const hiveErrors = hiveLocal.ok && services.hive.running
    ? "None detected from local checks."
    : (hiveErrorBrief || [!services.hive.running ? `OrbitFS service ${services.hive.status}` : null, hiveLocal.error].filter(Boolean).join("; ") || "None detected from recent OrbitFS logs.");

  const chatgptStatus = classifyConnectionStatus(oauthState.clients || [], oauthState.refreshTokens || [], "chatgpt");
  const claudeStatus = classifyConnectionStatus(oauthState.clients || [], oauthState.refreshTokens || [], "claude");

  const text = [
    "The OrbitFS Panel",
    `Connected locally: ${masterBrainLocal}`,
    `Connected Online: ${masterBrainOnline}`,
    `Connection status: ${masterBrainStatus}`,
    `Errors (brief): ${masterBrainErrors}`,
    "",
    "The OrbitFS Server",
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

// Sorting is owned exclusively by the OrbitFS Panel sorter service.
// MCP keeps _sorter only as a protected upload landing folder.

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
  const archiveName = `${path.basename(full) || "OrbitFS"}.zip`;
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
const journalSessions = new Map();
let persistedPrivateDrafts = { vent: {}, journal: {} };
try { persistedPrivateDrafts = JSON.parse(await fs.readFile(PRIVATE_DRAFT_STATE_FILE, "utf8")); } catch {}
persistedPrivateDrafts.vent ||= {}; persistedPrivateDrafts.journal ||= {};
async function persistPrivateDrafts(){ await fs.writeFile(PRIVATE_DRAFT_STATE_FILE, JSON.stringify(persistedPrivateDrafts,null,2), "utf8"); }
function defaultPrivateSession(saved={}){ return { enabled:false, recording:false, stopped:false, pendingDraft:null, startedAt:null, ...saved }; }
async function syncPrivateSession(mode,key,session){ persistedPrivateDrafts[mode][key]=session; await persistPrivateDrafts(); }

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
    session = defaultPrivateSession(persistedPrivateDrafts.vent[key]);
    ventSessions.set(key, session);
  }
  return session;
}

function getJournalSession(authContext) {
  const key = ventSessionKey(authContext);
  let session = journalSessions.get(key);
  if (!session) {
    session = defaultPrivateSession(persistedPrivateDrafts.journal[key]);
    journalSessions.set(key, session);
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

function isInternalUiPath(filepath = "") {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.at(-1) || "";
  return parts.includes("_system") || parts.includes("_trash")
    || name === "file_index.json" || name === "startup-loading.json"
    || name === "loadorder" || name === "project_rules.md";
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
  <title>OrbitFS Upload</title>
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
    <h1>Upload to OrbitFS</h1>
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

async function moveTrashEntryToGhost(relPath, authContext = {}) {
  const source = ops.safeResolve(relPath);
  const stamp = `${trashEntryPrefix()}-${crypto.randomBytes(3).toString("hex")}`;
  const safeName = path.basename(normalizeRelativePath(relPath)) || "trash-entry";
  const destination = path.join(GHOST_TRASH_ROOT, `${stamp}-${safeName}`);
  await fs.mkdir(GHOST_TRASH_ROOT, { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    await fs.rm(source, { recursive: true, force: true });
  }
  logEvent("file.change.ghost_trash", { ...authContext, source: authContext.source || "api", from: relPath, to: destination });
  return destination;
}

async function emptyTrash(authContext = {}) {
  let entries;
  try {
    entries = await ops.listFiles(TRASH_FOLDER, { recursive: false });
  } catch (err) {
    if (err.code === "ENOENT") return { deleted: [], deletedCount: 0, note: `${TRASH_FOLDER} does not exist.` };
    throw err;
  }

  const moved = [];
  for (const entry of entries) {
    const target = `${TRASH_FOLDER}/${entry.name}`;
    const ghostPath = await moveTrashEntryToGhost(target, authContext);
    moved.push({ from: target, to: ghostPath });
  }

  logEvent("file.change.empty_trash", { ...authContext, source: authContext.source || "api", movedToGhostCount: moved.length });
  return { moved, movedToGhostCount: moved.length, destination: GHOST_TRASH_ROOT };
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
    const ghostPath = await moveTrashEntryToGhost(relPath, authContext);
    deleted.push({ from: relPath, to: ghostPath });
  }

  if (deleted.length) {
    logEvent("file.change.trash_autopurge", {
      ...authContext,
      source: authContext.source || "scheduler",
      movedToGhostCount: deleted.length,
      retentionDays,
    });
  }
  return { moved: deleted, movedToGhostCount: deleted.length, retentionDays, destination: GHOST_TRASH_ROOT };
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
  return `${trimmed.slice(0, cap)}\nÃ¢â‚¬Â¦ (truncated - use read_file "${source}" for the rest)`;
}

function isStartupReadableFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  return STARTUP_TEXT_EXTENSIONS.has(ext) || ext === ".docx";
}

function isMandatoryStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) || "";
  const inMasterLogs = normalized.startsWith("0. core/master logs/");
  const isProfilesQuickView = /^mental[\s_-]*health[\s_-]*profiles[\s_-]*core\.docx$/.test(basename);
  const inMasterProfiles = parts.slice(0, -1).some((part) => part === "master profiles");
  const isLukeOrLaura = /(^|[^a-z])luke([^a-z]|$)/.test(basename) || /(^|[^a-z])laura([^a-z]|$)/.test(basename);
  return inMasterLogs || isProfilesQuickView || (inMasterProfiles && isLukeOrLaura);
}

function shouldDeferStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const parts = normalized.split("/");
  const inMasterProfiles = parts.slice(0, -1).some((part) => part === "master profiles");
  return inMasterProfiles && !isMandatoryStartupFile(filepath);
}

async function readStartupFile(filepath) {
  if (path.extname(filepath).toLowerCase() !== ".docx") return ops.readFile(filepath);
  const result = await mammoth.extractRawText({ path: ops.safeResolve(filepath) });
  return result.value;
}

async function extractViewableFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: ops.safeResolve(filepath) });
    return { text: result.value, format: "DOCX", pages: null };
  }
  if (ext === ".pdf") {
    const result = await pdfParse(await fs.readFile(ops.safeResolve(filepath)));
    return { text: result.text || "", format: "PDF", pages: result.numpages || null };
  }
  if (STARTUP_TEXT_EXTENSIONS.has(ext)) {
    return { text: await ops.readFile(filepath), format: (ext.slice(1) || "text").toUpperCase(), pages: null };
  }
  throw new Error(`Unsupported viewer format "${ext || "(none)"}". Supported: PDF, DOCX, and readable text files.`);
}

function buildDocumentView(filepath, extracted, preview) {
  const fullText = String(extracted.text || "");
  const maxLines = preview ? 80 : 2500;
  const maxChars = preview ? 12000 : 250000;
  const lines = fullText.split(/\r?\n/);
  let text = lines.slice(0, maxLines).join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return {
    mode: "document_viewer",
    document: {
      path: filepath,
      name: path.basename(filepath),
      format: extracted.format,
      pages: extracted.pages,
      totalLines: lines.length,
      totalChars: fullText.length,
      text,
      preview,
      truncated: text.length < fullText.length,
    },
  };
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
      if (shouldDeferStartupFile(filepath)) continue;
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

function referenceWords(value = "") {
  return normalizeRelativePath(value)
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function scorePathReference(candidatePath, reference) {
  const candidate = normalizeRelativePath(candidatePath).toLowerCase();
  const basename = path.basename(candidate).toLowerCase();
  const withoutExt = basename.replace(/\.[a-z0-9]{1,8}$/i, "");
  const query = normalizeRelativePath(reference).toLowerCase();
  const queryWithoutExt = query.replace(/\.[a-z0-9]{1,8}$/i, "");
  if (candidate === query) return 1000;
  if (basename === query) return 950;
  if (withoutExt === queryWithoutExt) return 925;
  const words = referenceWords(reference);
  if (!words.length || !words.every((word) => candidate.includes(word))) return 0;
  return 500 + words.reduce((score, word) => score + (basename.includes(word) ? 20 : 5), 0);
}

async function resolveHiveReference(reference, expectedType) {
  const normalized = normalizeRelativePath(reference);
  if (!normalized) throw new Error("A file or folder name is required");
  try {
    const stat = await fs.stat(ops.safeResolve(normalized));
    const type = stat.isDirectory() ? "dir" : "file";
    if (!expectedType || expectedType === type) return { path: normalized, type, matchedBy: "exact path" };
  } catch {}

  const entries = (await ops.listFiles("", { recursive: true }))
    .filter((entry) => !isVentFolderPath(entry.path))
    .filter((entry) => !expectedType || entry.type === expectedType)
    .map((entry) => ({ ...entry, score: scorePathReference(entry.path, normalized) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (!entries.length) throw new Error(`No ${expectedType === "dir" ? "folder" : "file or folder"} matched "${reference}"`);
  const best = entries[0];
  const tied = entries.filter((entry) => entry.score === best.score);
  if (tied.length > 1) {
    throw new Error(`"${reference}" is ambiguous. Choose one: ${tied.slice(0, 10).map((entry) => entry.path).join(" | ")}`);
  }
  return { path: best.path, type: best.type, matchedBy: "short-name search" };
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
        sections.push(`  Ã¢â‚¬Â¦ ${entries.length - shown.length} more - use list_files "${folder}" for the full listing`);
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
              sections.push(`    Ã¢â‚¬Â¦ ${childEntries.length - childShown.length} more - use list_files "${childDir}"`);
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
      const truncationNote = item.truncated ? "\nÃ¢â‚¬Â¦ (startup copy truncated; use read_file for the complete file)" : "";
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
  server.authContext = authContext;

  server.tool(
    "list_files",
    "List files and folders in the OrbitFS store",
    {
      subpath: z.string().optional().describe("Relative subfolder, default root"),
      recursive: z.boolean().optional().describe("List all nested contents, not just top level"),
      include_internal: z.boolean().optional().describe("Show internal _system/_trash/index files; default false"),
    },
    async ({ subpath, recursive, include_internal }) => {
      logEvent("tool.list_files.start", { ...authContext, subpath: subpath || "", recursive: !!recursive });
      let entries = await ops.listFiles(subpath, { recursive });
      if (!recursive) entries = filterLegacyTopLevelEntries(subpath, entries);
      entries = filterVentFolder(subpath, entries, recursive);
      if (!include_internal) entries = entries.filter((entry) => !isInternalUiPath(entry.path ?? entry.name));
      const listing = entries.map((e) => (e.type === "dir" ? "[DIR] " : "[FILE] ") + (e.path ?? e.name)).join("\n");
      logEvent("tool.list_files.ok", { ...authContext, subpath: subpath || "", recursive: !!recursive, count: entries.length });
      return { content: [{ type: "text", text: listing || "(empty)" }] };
    }
  );

  server.tool(
    "read_file",
    "Read a file's contents from the OrbitFS store",
    { filepath: z.string().describe("Relative path to the file") },
    async ({ filepath }) => {
      logEvent("tool.read_file.start", { ...authContext, filepath });
      const data = await ops.readFile(filepath);
      logEvent("tool.read_file.ok", { ...authContext, filepath, chars: data.length });
      return { content: [{ type: "text", text: data }] };
    }
  );

  server.tool(
    "load_file",
    "Fully load and understand one OrbitFS text or DOCX file. Triggered by `/loadfile <filepath>`. Returns the complete extracted content without startup truncation. Read the entire returned file as active context; do not merely list or preview it, and do not summarize it unless the user asks.",
    { filepath: z.string().describe("Relative path to the file that must be fully loaded") },
    async ({ filepath }) => {
      const requested = normalizeRelativePath(filepath);
      if (!requested) throw new Error("filepath is required");
      const resolved = await resolveHiveReference(requested, "file");
      const normalized = resolved.path;
      if (!isStartupReadableFile(normalized)) {
        throw new Error(`Resolved "${requested}" to "${normalized}", but load_file supports readable text files and DOCX files. Use open_file_web for binary media or PDFs.`);
      }
      logEvent("tool.load_file.start", { ...authContext, filepath: normalized, requested, matchedBy: resolved.matchedBy });
      const data = await readStartupFile(normalized);
      logEvent("tool.load_file.ok", { ...authContext, filepath: normalized, requested, chars: data.length });
      return {
        content: [{
          type: "text",
          text: `[INTERNAL FILE CONTEXT - Read and understand this entire file. Treat it as active context. Do not summarize or repeat it unless the user asks.]\n\n===== ${normalized} =====\n${data}\n\n[END FILE CONTEXT: ${normalized}]`,
        }],
      };
    }
  );

  server.tool(
    "view_file",
    "Open a PDF, DOCX, or readable text file in the expandable OrbitFS document viewer UI.",
    { filepath: z.string().describe("File path or filename") },
    async ({ filepath }) => {
      const resolved = await resolveHiveReference(filepath, "file");
      const extracted = await extractViewableFile(resolved.path);
      const structuredContent = buildDocumentView(resolved.path, extracted, false);
      logEvent("tool.view_file.ok", { ...authContext, filepath: resolved.path, format: extracted.format });
      return {
        content: [{ type: "text", text: `Opened ${resolved.path} in the OrbitFS document viewer.` }],
        structuredContent,
      };
    }
  );

  server.tool(
    "preview_file",
    "Preview the first section of a PDF, DOCX, or readable text file in the compact OrbitFS document viewer UI.",
    { filepath: z.string().describe("File path or filename") },
    async ({ filepath }) => {
      const resolved = await resolveHiveReference(filepath, "file");
      const extracted = await extractViewableFile(resolved.path);
      const structuredContent = buildDocumentView(resolved.path, extracted, true);
      logEvent("tool.preview_file.ok", { ...authContext, filepath: resolved.path, format: extracted.format });
      return {
        content: [{ type: "text", text: `Previewed ${resolved.path} in the OrbitFS document viewer.` }],
        structuredContent,
      };
    }
  );

  server.tool(
    "read_folder_recursive",
    "Recursively list every file and subfolder beneath an OrbitFS folder. Use this when the full folder tree is needed, including protected project roots such as 0. Core.",
    {
      path: z.string().optional().describe("Relative folder path, default OrbitFS root"),
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
    "Read multiple individual text files from the OrbitFS in one call. Each result includes its path, content, original character count, and whether it was truncated.",
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
    "Export an OrbitFS folder as a ZIP archive. Returns a temporary browser download link scoped to that folder and expiring after 15 minutes.",
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
    "Create a temporary browser download link for an OrbitFS file or folder. Files download directly; folders download as ZIP archives. The link is path-scoped and expires after 15 minutes.",
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
    "Create or overwrite a plain text file in the OrbitFS store. Do NOT use this for images, PDFs, audio, video, or any other binary file - it writes content as UTF-8 text and will corrupt binary data. Use upload_file for anything that isn't plain text. If you give a bare filename with no folder, new files are placed in the _sorter inbox.",
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
    "Delete a file or folder from the OrbitFS store",
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
    "Move or rename a file or folder within the OrbitFS store (e.g. to sort something out of _sorter into its real home). Creates destination folders as needed.",
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
    "find_items",
    "Find OrbitFS files or folders by a short name instead of a full directory. Use this when the user's wording could match more than one item.",
    {
      query: z.string().describe("Short file or folder name, such as Master Log v1 or Court Profiles"),
      type: z.enum(["any", "file", "folder"]).optional().describe("Optional item type filter"),
    },
    async ({ query, type }) => {
      const expectedType = type === "folder" ? "dir" : type === "file" ? "file" : undefined;
      const entries = (await ops.listFiles("", { recursive: true }))
        .filter((entry) => !isVentFolderPath(entry.path))
        .filter((entry) => !expectedType || entry.type === expectedType)
        .map((entry) => ({ ...entry, score: scorePathReference(entry.path, query) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, 20);
      const text = entries.length
        ? entries.map((entry, index) => `${index + 1}. ${entry.type === "dir" ? "Ã°Å¸â€œÂ" : "Ã°Å¸â€œâ€ž"} ${entry.path}`).join("\n")
        : `(no matches for "${query}")`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "move_item",
    "Move an OrbitFS file or folder using short names instead of full directory paths. First call with confirmed=false to resolve and preview the exact move. After the user confirms that exact preview, call again with confirmed=true. Never set confirmed=true without explicit user confirmation.",
    {
      source: z.string().describe("Short name or full path of the file/folder to move"),
      destination_folder: z.string().describe("Short name or full path of the destination folder"),
      new_name: z.string().optional().describe("Optional new filename/folder name; omit to keep its current name"),
      confirmed: z.boolean().optional().describe("false previews only; true executes after explicit confirmation"),
    },
    async ({ source, destination_folder, new_name, confirmed }) => {
      const resolvedSource = await resolveHiveReference(source);
      const resolvedDestination = await resolveHiveReference(destination_folder, "dir");
      const finalName = String(new_name || path.basename(resolvedSource.path)).trim();
      if (!finalName || finalName.includes("/") || finalName.includes("\\")) throw new Error("new_name must be a name only, not a path");
      const to = `${resolvedDestination.path}/${finalName}`;
      if (!confirmed) {
        return {
          content: [{
            type: "text",
            text: `Move preview (nothing moved yet):\nFROM: ${resolvedSource.path}\nTO: ${to}\n\nAsk the user to confirm this exact move, then call move_item again with confirmed=true.`,
          }],
        };
      }
      assertMutablePath(resolvedSource.path, "move");
      await ops.moveFile(resolvedSource.path, to);
      logEvent("file.change.move", { ...authContext, source: "mcp_short_reference", from: resolvedSource.path, to });
      return { content: [{ type: "text", text: `Moved ${resolvedSource.path} -> ${to}` }] };
    }
  );

  server.tool(
    "mkdir",
    "Create a folder (and any missing parent folders) in the OrbitFS store",
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
    "Get size, modified time, and sha256 hash of a file in the OrbitFS store",
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
    "Get a live status report for the OrbitFS Panel, OrbitFS MCP server, ChatGPT, and Claude. Triggered by the user typing `/server-status`, `server status`, `show server status`, or `show orbitfs status`.",
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
    "Get a link to open an OrbitFS file directly in a web browser. Triggered by the user typing `/openfileweb <file>`. Returns a URL that renders the file inline (PDF, image, text, etc.) or lets the browser handle it; the link is single-file-scoped and expires in 15 minutes.",
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
    "Create a short-lived, single-use upload link for browser-based multipart uploads into OrbitFS. The link expires after 15 minutes and defaults to the _sorter inbox.",
    { destination: z.string().optional().describe("Destination folder; defaults to _sorter") },
    async ({ destination: requestedDestination }) => {
      const targetDestination = normalizeRelativePath(requestedDestination || SORT_FOLDER) || SORT_FOLDER;
      logEvent("tool.create_upload_link.start", { ...authContext, destination: targetDestination });
      const { url, expiresInMinutes, destination } = await buildUploadLink(targetDestination);
      logEvent("tool.create_upload_link.ok", { ...authContext, destination });
      return {
        content: [
          { type: "text", text: `Upload link (single-use, expires in ${expiresInMinutes} minutes): ${url}` },
        ],
      };
    }
  );

  server.tool("ventmode","Turn Pure Private Vent Mode on or off.",{state:z.enum(["on","off"])},async({state})=>{const key=ventSessionKey(authContext),s=getVentSession(authContext);s.enabled=state==="on";if(!s.enabled){s.recording=false;s.stopped=false;}await syncPrivateSession("vent",key,s);return{content:[{type:"text",text:s.enabled?`${VENT_MODE_RULES}\n\nVENT MODE — ON\nPress Start when ready.`:"VENT MODE — OFF"}],structuredContent:{...s,pendingDraft:!!s.pendingDraft,privacy:"pure-private"}}});
  server.tool("start_vent_recording","Start the current Vent entry.",{},async()=>{const key=ventSessionKey(authContext),s=getVentSession(authContext);if(!s.enabled)throw new Error("Turn Vent Mode on first.");s.recording=true;s.stopped=false;s.startedAt=new Date().toISOString();await syncPrivateSession("vent",key,s);return{content:[{type:"text",text:"VENT RECORDING — STARTED"}],structuredContent:{...s,pendingDraft:!!s.pendingDraft}}});
  server.tool("stop_vent_recording","Stop the current Vent entry without uploading it.",{},async()=>{const key=ventSessionKey(authContext),s=getVentSession(authContext);if(!s.recording)throw new Error("Vent recording is not active.");s.recording=false;s.stopped=true;await syncPrivateSession("vent",key,s);return{content:[{type:"text",text:"VENT RECORDING — STOPPED\nUse Save Draft to store the entry."}],structuredContent:{...s,pendingDraft:!!s.pendingDraft}}});
  server.tool("save_vent_draft","Save a Pure Private Vent draft exactly as supplied.",{text:z.string().min(1),title:z.string().min(1),entry_date:z.string().optional()},async({text,title,entry_date})=>{const key=ventSessionKey(authContext),s=getVentSession(authContext);if(!s.stopped)throw new Error("Stop the Vent entry first.");const cleanTitle=sanitizeVentTitle(title),entryDate=entry_date||sydneyDateDDMMYYYY();monthYearFromEntryDate(entryDate);s.pendingDraft={title:cleanTitle,entryDate,text,hash:hashVentDraft(cleanTitle,entryDate,text),savedAt:new Date().toISOString()};await syncPrivateSession("vent",key,s);return{content:[{type:"text",text:`VENT DRAFT SAVED\n\n${cleanTitle}\n\n${entryDate}\n\n${text}`}],structuredContent:{...s,pendingDraft:true,draft:s.pendingDraft}}});
  server.tool("reload_vent_draft","Reload the saved Pure Private Vent draft.",{},async()=>{const s=getVentSession(authContext);if(!s.pendingDraft)throw new Error("No saved Vent draft.");return{content:[{type:"text",text:`${s.pendingDraft.title}\n\n${s.pendingDraft.entryDate}\n\n${s.pendingDraft.text}`}],structuredContent:{draft:s.pendingDraft,pendingDraft:true}}});
  server.tool("delete_vent_draft","Delete the saved Vent draft.",{},async()=>{const key=ventSessionKey(authContext),s=getVentSession(authContext);s.pendingDraft=null;await syncPrivateSession("vent",key,s);return{content:[{type:"text",text:"Vent draft deleted."}],structuredContent:{pendingDraft:false}}});
  server.tool("upload_vent_entry","Finalise and upload the exact saved Vent draft.",{},async()=>{const key=ventSessionKey(authContext),s=getVentSession(authContext),d=s.pendingDraft;if(!d)throw new Error("No saved Vent draft.");if(hashVentDraft(d.title,d.entryDate,d.text)!==d.hash)throw new Error("Vent draft integrity check failed.");const{monthYear}=monthYearFromEntryDate(d.entryDate),monthDir=`${VENT_FOLDER}/${monthYear}`,filename=`${d.entryDate} - ${d.title}.md`,filepath=`${monthDir}/${filename}`;await ops.makeDir(monthDir);await ops.writeFile(filepath,`# ${d.title}\n\n${d.entryDate}\n\n${d.text}\n`);s.pendingDraft=null;s.stopped=false;s.startedAt=null;await syncPrivateSession("vent",key,s);return{content:[{type:"text",text:`Uploaded: \`${filename}\`\nLocation: \`/${monthDir}/\``}],structuredContent:{uploaded:true,filepath,pendingDraft:false}}});
  server.tool("vent_status","Return current Pure Private Vent state.",{},async()=>{const s=getVentSession(authContext);return{content:[{type:"text",text:JSON.stringify({...s,pendingDraft:!!s.pendingDraft})}],structuredContent:{...s,pendingDraft:!!s.pendingDraft,privacy:"pure-private"}}});
  server.tool("journalmode","Turn Semi Personal Journal Mode on or off.",{state:z.enum(["on","off"])},async({state})=>{const key=ventSessionKey(authContext),s=getJournalSession(authContext);s.enabled=state==="on";if(!s.enabled){s.recording=false;s.stopped=false;}await syncPrivateSession("journal",key,s);return{content:[{type:"text",text:s.enabled?`${JOURNAL_MODE_RULES}\n\nJOURNAL MODE — ON\nPress Start when ready.`:"JOURNAL MODE — OFF"}],structuredContent:{...s,pendingDraft:!!s.pendingDraft,privacy:"semi-personal"}}});
  server.tool("start_journal_recording","Start the current Journal entry.",{},async()=>{const key=ventSessionKey(authContext),s=getJournalSession(authContext);if(!s.enabled)throw new Error("Turn Journal Mode on first.");s.recording=true;s.stopped=false;s.startedAt=new Date().toISOString();await syncPrivateSession("journal",key,s);return{content:[{type:"text",text:"JOURNAL RECORDING — STARTED"}],structuredContent:{...s,pendingDraft:!!s.pendingDraft}}});
  server.tool("stop_journal_recording","Stop the current Journal entry without uploading it.",{},async()=>{const key=ventSessionKey(authContext),s=getJournalSession(authContext);if(!s.recording)throw new Error("Journal recording is not active.");s.recording=false;s.stopped=true;await syncPrivateSession("journal",key,s);return{content:[{type:"text",text:"JOURNAL RECORDING — STOPPED\nUse Save Draft to store the entry."}],structuredContent:{...s,pendingDraft:!!s.pendingDraft}}});
  server.tool("save_journal_draft","Save a Semi Personal Journal draft as supplied.",{text:z.string().min(1),title:z.string().min(1),entry_date:z.string().optional()},async({text,title,entry_date})=>{const key=ventSessionKey(authContext),s=getJournalSession(authContext);if(!s.stopped)throw new Error("Stop the Journal entry first.");const cleanTitle=sanitizeVentTitle(title),entryDate=entry_date||sydneyDateDDMMYYYY();monthYearFromEntryDate(entryDate);s.pendingDraft={title:cleanTitle,entryDate,text,hash:hashVentDraft(cleanTitle,entryDate,text),savedAt:new Date().toISOString()};await syncPrivateSession("journal",key,s);return{content:[{type:"text",text:`JOURNAL DRAFT SAVED\n\n${cleanTitle}\n\n${entryDate}\n\n${text}`}],structuredContent:{...s,pendingDraft:true,draft:s.pendingDraft}}});
  server.tool("reload_journal_draft","Reload the saved Journal draft.",{},async()=>{const s=getJournalSession(authContext);if(!s.pendingDraft)throw new Error("No saved Journal draft.");return{content:[{type:"text",text:`${s.pendingDraft.title}\n\n${s.pendingDraft.entryDate}\n\n${s.pendingDraft.text}`}],structuredContent:{draft:s.pendingDraft,pendingDraft:true}}});
  server.tool("delete_journal_draft","Delete the saved Journal draft.",{},async()=>{const key=ventSessionKey(authContext),s=getJournalSession(authContext);s.pendingDraft=null;await syncPrivateSession("journal",key,s);return{content:[{type:"text",text:"Journal draft deleted."}],structuredContent:{pendingDraft:false}}});
  server.tool("upload_journal_entry","Finalise and upload the exact saved Journal draft.",{},async()=>{const key=ventSessionKey(authContext),s=getJournalSession(authContext),d=s.pendingDraft;if(!d)throw new Error("No saved Journal draft.");if(hashVentDraft(d.title,d.entryDate,d.text)!==d.hash)throw new Error("Journal draft integrity check failed.");const{monthYear}=monthYearFromEntryDate(d.entryDate),monthDir=`${JOURNAL_FOLDER}/${monthYear}`,filename=`${d.entryDate} - ${d.title}.md`,filepath=`${monthDir}/${filename}`;await ops.makeDir(monthDir);await ops.writeFile(filepath,`# ${d.title}\n\n${d.entryDate}\n\n${d.text}\n`);s.pendingDraft=null;s.stopped=false;s.startedAt=null;await syncPrivateSession("journal",key,s);return{content:[{type:"text",text:`Uploaded: \`${filename}\`\nLocation: \`/${monthDir}/\``}],structuredContent:{uploaded:true,filepath,pendingDraft:false}}});
  server.tool("journal_status","Return current Semi Personal Journal state.",{},async()=>{const s=getJournalSession(authContext);return{content:[{type:"text",text:JSON.stringify({...s,pendingDraft:!!s.pendingDraft})}],structuredContent:{...s,pendingDraft:!!s.pendingDraft,privacy:"semi-personal"}}});

  server.tool(
    "search_files",
    "Search file contents for a substring within the OrbitFS store",
    {
      query: z.string().describe("Substring to search for"),
      subpath: z.string().optional().describe("Relative subfolder to search, default root"),
      include_internal: z.boolean().optional().describe("Search internal _system/_trash/index files; default false"),
    },
    async ({ query, subpath, include_internal }) => {
      logEvent("tool.search_files.start", { ...authContext, query, subpath: subpath || "", includeInternal: !!include_internal });
      const matches = (await ops.searchFiles(query, subpath))
        .filter((m) => !isVentFolderPath(m.path))
        .filter((m) => include_internal || !isInternalUiPath(m.path));
      logEvent("tool.search_files.ok", { ...authContext, query, matchCount: matches.length });
      const text = matches.length ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") : "(no matches)";
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "fetch_url_to_file",
    "Download a URL and save it into the OrbitFS store, binary-safe (docx, PDF, images, audio all fine). Use this when a real downloadable URL exists that the OrbitFS server itself can access directly. If you only have a ChatGPT or Claude sandbox path like '/mnt/data/file.pdf', the server cannot read that path; use upload_file with base64 content or create_upload_link instead. Bare filenames with no folder go to the _sorter inbox.",
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
    "startup_firestorm",
    "Hardcoded Project FireStorm startup command. Equivalent to /startup <project> <low|med|high>. Always loads 0. Core/Master Logs, Mental_health_profiles_core.docx, and Luke's and Laura's Master Profile documents; other Master Profiles stay deferred for /loadfile. Also loads the correct startup files, rules, and bounded project context without making changes.",
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
    "List files and folders in an OrbitFS folder",
    { subpath: z.string().optional().describe("Relative folder, default root") },
    "list_files"
  );

  toolPrompt("read", "Read a file's contents", { filepath: z.string().describe("Relative path to the file") }, "read_file");

  toolPrompt(
    "loadfile",
    "Fully read and understand one file as active context",
    { filepath: z.string().describe("Relative path to the text or DOCX file") },
    "load_file",
    "Read the complete returned content and confirm only that the file is loaded and understood unless I ask for analysis or a summary."
  );

  toolPrompt(
    "viewfile",
    "Open a document in the expandable OrbitFS viewer",
    { filepath: z.string().describe("PDF, DOCX, or text file") },
    "view_file",
    "Show the returned OrbitFS document viewer UI."
  );

  toolPrompt(
    "previewfile",
    "Preview a document in the compact OrbitFS viewer",
    { filepath: z.string().describe("PDF, DOCX, or text file") },
    "preview_file",
    "Show the returned OrbitFS document viewer UI."
  );

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
    "Get a live status report for the OrbitFS Panel, OrbitFS MCP server, ChatGPT, and Claude",
    {},
    "server_status",
    "Reply with the returned text exactly and do not add any extra commentary."
  );

  toolPrompt(
    "showcp",
    "Open the OrbitFS UI control panel widget",
    {},
    "orbitfs_ui",
    'Call it with action="open" to open the widget on the startup screen.'
  );
  toolPrompt(
    "move",
    "Move a file or folder using short names",
    {
      source: z.string().describe("Short source name or full path"),
      destination_folder: z.string().describe("Short destination folder name or full path"),
      new_name: z.string().optional().describe("Optional new name"),
    },
    "move_item",
    "Preview the resolved FROM and TO paths first. Do not execute until I confirm the exact move."
  );

  toolPrompt("mkdir", "Create a folder", { subpath: z.string().describe("Relative folder path to create") }, "mkdir");

  toolPrompt(
    "trash",
    `Move a file or folder into "${TRASH_FOLDER}"`,
    { filepath: z.string().describe(`Relative path to move into ${TRASH_FOLDER}`) },
    "move_to_trash"
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

app.post("/api/oauth-disconnect", express.json(), (req, res) => {
  try {
    const result = revokeOAuthAccess(req.body?.email, req.body?.flow || null);
    logEvent("api.oauth_disconnect.ok", { ...requestContext(req), ...result });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
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




