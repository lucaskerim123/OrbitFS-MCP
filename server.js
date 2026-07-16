import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HIVE_ROOT;
const WIDGET_URI = "ui://widget/orbitfs-hive-v7.html";
const HELP_WIDGET_URI = "ui://widget/orbitfs-help-v2.html";
const CHATGPT_WIDGET_URI = "ui://widget/orbitfs-chatgpt-ui-v2.html";
const CHATGPT_HELP_WIDGET_URI = "ui://widget/orbitfs-chatgpt-help-v2.html";

// Widget assembly: each widget is built from a host-agnostic shell (markup/CSS)
// plus the shared engine logic (core.js) plus one bridge implementation per
// host (bridge.chatgpt.js for window.openai, bridge.claude.js for the
// official @modelcontextprotocol/ext-apps App class). Both bridge scripts are
// always inlined into the one served resource; each is a no-op unless its own
// host is actually detected at runtime in-browser - see app/widget/core.js.
const require = createRequire(import.meta.url);
const EXT_APPS_BUNDLE = (
  await fs.readFile(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8")
).replace(/export\{([^}]+)\};?\s*$/, (_, body) =>
  "globalThis.ExtApps={" +
  body
    .split(",")
    .map((p) => {
      const [local, exported] = p.split(" as ").map((s) => s.trim());
      return `${exported ?? local}:${local}`;
    })
    .join(",") +
  "};"
);
const BRIDGE_CHATGPT_JS = await fs.readFile(path.join(SERVER_DIR, "app/widget/bridge.chatgpt.js"), "utf8");
const BRIDGE_CLAUDE_JS = await fs.readFile(path.join(SERVER_DIR, "app/widget/bridge.claude.js"), "utf8");

function assembleWidget(shellHtml, coreJs, bridgeJs, bridgeHost) {
  // ExtApps (~330KB) is only needed by bridge.claude.js (globalThis.ExtApps.App).
  // bridge.chatgpt.js talks to window.openai only, so skip inlining it there -
  // it was dead weight bloating the ChatGPT widget for no reason.
  return shellHtml
    .replace("/*__EXT_APPS_BUNDLE__*/", () => bridgeHost === "claude" ? EXT_APPS_BUNDLE : "")
    .replace("/*__BRIDGE_CHATGPT__*/", () => bridgeHost === "chatgpt" ? bridgeJs : "")
    .replace("/*__BRIDGE_CLAUDE__*/", () => bridgeHost === "claude" ? bridgeJs : "")
    .replace("/*__CORE_JS__*/", () => coreJs);
}

function assembleLegacyWidget(shellHtml, coreJs) {
  return shellHtml
    .replace("/*__EXT_APPS_BUNDLE__*/", () => EXT_APPS_BUNDLE)
    .replace("/*__BRIDGE_CHATGPT__*/", () => BRIDGE_CHATGPT_JS)
    .replace("/*__BRIDGE_CLAUDE__*/", () => BRIDGE_CLAUDE_JS)
    .replace("/*__CORE_JS__*/", () => coreJs);
}

async function loadUiBundle(folder, bridgeHost) {
  const dir = path.join(SERVER_DIR, "app", folder);
  const shell = await fs.readFile(path.join(dir, "shell.html"), "utf8");
  const core = await fs.readFile(path.join(dir, "core.js"), "utf8");
  const bridge = await fs.readFile(path.join(dir, "bridge.js"), "utf8");
  const helpShell = await fs.readFile(path.join(dir, "help-shell.html"), "utf8");
  const helpCoreTemplate = await fs.readFile(path.join(dir, "help-core.js"), "utf8");
  const commands = JSON.parse(await fs.readFile(path.join(dir, "commands.json"), "utf8"));
  const helpCore = helpCoreTemplate.replace("__ORBITFS_COMMANDS__", () => JSON.stringify(commands).replace(/</g, "\u003c"));
  return {
    widgetHtml: assembleWidget(shell, core, bridge, bridgeHost),
    helpHtml: assembleWidget(helpShell, helpCore, bridge, bridgeHost),
    commands,
  };
}

const CHATGPT_UI = await loadUiBundle("chatgpt-ui", "chatgpt");
const COMMAND_HELP = CHATGPT_UI.commands;

const WIDGET_SHELL = await fs.readFile(path.join(SERVER_DIR, "app/widget/shell.html"), "utf8");
const WIDGET_CORE_JS = await fs.readFile(path.join(SERVER_DIR, "app/widget/core.js"), "utf8");
const WIDGET_HTML = assembleLegacyWidget(WIDGET_SHELL, WIDGET_CORE_JS);

const HELP_SHELL = await fs.readFile(path.join(SERVER_DIR, "app/widget/help-shell.html"), "utf8");
const HELP_CORE_TEMPLATE = await fs.readFile(path.join(SERVER_DIR, "app/widget/help-core.js"), "utf8");
const HELP_CORE_JS = HELP_CORE_TEMPLATE.replace("__ORBITFS_COMMANDS__", () => JSON.stringify(COMMAND_HELP).replace(/</g, "\u003c"));
const HELP_WIDGET_HTML = assembleLegacyWidget(HELP_SHELL, HELP_CORE_JS);

const CONFIG_PATH = path.join(ROOT, "_system", "Config", "startup-loading.json");
const originalTool = McpServer.prototype.tool;
const resourceRegistered = new WeakSet();
const extraToolsRegistered = new WeakSet();
const DEFAULT_PUBLIC_ORIGIN = "https://mcp.incendiarynetworks.cc";
const CONTEXT_TTL_MS = null;
let capturedLoadFileHandler = null;
const HIVE_SCREENS = ["startup", "browser", "files", "viewer", "context", "vent", "journal", "system", "settings", "permissions", "search", "move", "upload"];
const HIVE_MODALS = ["permissions", "move", "info", "upload", "delete"];

// UI navigation state and loaded-file context are per client (ChatGPT vs Claude vs
// webpanel), keyed by authContext.flow - see oauth.js classifyRedirect. This keeps
// two clients connected as the same person from stomping on each other's open
// screen/modal or active file set.
const activeContextByFlow = new Map();
const hiveUiStateByFlow = new Map();

function flowKey(authContext = {}) {
  return authContext.flow || "shared";
}

// The /mcp transport is stateless per request (see StreamableHTTPServerTransport
// with no sessionIdGenerator in server-core.js), and MCP clients sometimes drop
// and re-initialize their connection mid-call, resending whatever tool call was
// still in flight. For expensive/visible calls like startup, that produces
// duplicate "project loaded" confirmations. Dedupe identical (client, tool,
// args) calls that land within a short window so a retry reuses the original
// call's result instead of re-running it.
const DEDUP_WINDOW_MS = 8000;
const dedupCache = new Map();

function withDedup(authContext, name, args, fn) {
  const key = `${flowKey(authContext)}::${name}::${JSON.stringify(args)}`;
  const now = Date.now();
  const existing = dedupCache.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;
  const promise = fn().catch((err) => {
    dedupCache.delete(key);
    throw err;
  });
  dedupCache.set(key, { promise, expiresAt: now + DEDUP_WINDOW_MS });
  return promise;
}

function getActiveContext(authContext) {
  const key = flowKey(authContext);
  if (!activeContextByFlow.has(key)) activeContextByFlow.set(key, new Map());
  return activeContextByFlow.get(key);
}

function getHiveUiState(authContext) {
  const key = flowKey(authContext);
  if (!hiveUiStateByFlow.has(key)) {
    hiveUiStateByFlow.set(key, {
      currentScreen: "startup",
      history: [],
      selectedFiles: [],
      filters: {},
      scrollPosition: {},
      permissions: {},
      modal: null,
      open: false,
      focused: false,
      revision: 0,
    });
  }
  return hiveUiStateByFlow.get(key);
}

function hiveUiSnapshot(authContext, extra = {}) {
  const hiveUiState = getHiveUiState(authContext);
  return {
    mode: "ui_controller",
    ui: { ...hiveUiState, history: [...hiveUiState.history], selectedFiles: [...hiveUiState.selectedFiles] },
    context: contextStructured(authContext),
    ...extra,
  };
}

function hiveUiPublicSnapshot(authContext, extra = {}) {
  const hiveUiState = getHiveUiState(authContext);
  return {
    mode: extra.mode || "ui_controller",
    view: extra.view || hiveUiState.currentScreen,
    action: extra.action || null,
    target: extra.target || null,
    ui: {
      currentScreen: hiveUiState.currentScreen,
      open: hiveUiState.open,
      focused: hiveUiState.focused,
      modal: hiveUiState.modal,
      revision: hiveUiState.revision,
    },
  };
}

const DEFAULT_CONFIG = {
  defaultStrength: "medium",
  excludeFolders: ["_trash", "archive", "archives", "2. Wellbeing/Pure Vent Mode"],
  presets: {
    "1. Legal": { low: [], medium: [], high: [], custom1: [], custom2: [] },
    "2. Wellbeing": { low: [], medium: [], high: [], custom1: [], custom2: [] },
  },
  levels: {
    low: { maxFiles: 20, maxCharacters: 120000, perFileCharacters: 40000 },
    medium: { maxFiles: 50, maxCharacters: 350000, perFileCharacters: 60000 },
    high: { maxFiles: 120, maxCharacters: 900000, perFileCharacters: 100000 },
    custom1: { maxFiles: 180, maxCharacters: 1400000, perFileCharacters: 140000 },
    custom2: { maxFiles: 260, maxCharacters: 2200000, perFileCharacters: 180000 },
    custom: { maxFiles: 260, maxCharacters: 2200000, perFileCharacters: 180000 },
    mega: { maxFiles: 10000, maxCharacters: 12000000, perFileCharacters: 1000000 },
  },
};

function normalize(value = "") {
  return String(value).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function getWidgetDomain() {
  const configured = process.env.ORBITFS_WIDGET_DOMAIN || process.env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_ORIGIN;
  const url = new URL(configured);
  if (url.protocol !== "https:") throw new Error("OrbitFS widget domain must use HTTPS.");
  return url.origin;
}

async function readConfig() {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      levels: {
        low: { ...DEFAULT_CONFIG.levels.low, ...(raw.levels?.low || {}) },
        medium: { ...DEFAULT_CONFIG.levels.medium, ...(raw.levels?.medium || raw.levels?.med || {}) },
        high: { ...DEFAULT_CONFIG.levels.high, ...(raw.levels?.high || {}) },
        custom1: { ...DEFAULT_CONFIG.levels.custom1, ...(raw.levels?.custom1 || {}) },
        custom2: { ...DEFAULT_CONFIG.levels.custom2, ...(raw.levels?.custom2 || {}) },
        custom: { ...DEFAULT_CONFIG.levels.custom, ...(raw.levels?.custom || {}) },
        mega: { ...DEFAULT_CONFIG.levels.mega, ...(raw.levels?.mega || {}) },
      },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function contextArray(authContext) {
  return [...getActiveContext(authContext).values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.path.localeCompare(b.path));
}

function isBackgroundUiPath(filepath = "") {
  const normalized = normalize(filepath).toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.at(-1) || "";
  return parts.includes("_system")
    || parts.includes("_trash")
    || name === "file_index.json"
    || name === "startup-loading.json"
    || name === "loadorder"
    || name === "project_rules.md";
}

function contextStructured(authContext, extra = {}) {
  const files = contextArray(authContext).filter((file) => !isBackgroundUiPath(file.path));
  return {
    mode: "active",
    activeFiles: files,
    activeFileCount: files.length,
    totalCharactersLoaded: files.reduce((sum, file) => sum + Number(file.characters || 0), 0),
    ...extra,
  };
}

function trackFile(authContext, filepath, characters, source = "manual", truncated = false, pinned = false) {
  const activeContext = getActiveContext(authContext);
  const key = normalize(filepath);
  const now = Date.now();
  activeContext.set(key, {
    path: key,
    characters: Number(characters || 0),
    source,
    truncated: !!truncated,
    pinned: !!pinned,
    loadedAt: new Date(now).toISOString(),
    lastAccessedAt: new Date(now).toISOString(),
    expiresAt: null,
  });
}

function visibleStartupResult(authContext, text, project, loadstrength) {
  const marker = "Working files loaded into context:";
  const section = text.includes(marker) ? text.split(marker)[1].split("Reply to the user with ONLY")[0] : "";
  const matches = [...section.matchAll(/^===== (.+?) =====$/gm)];
  const files = matches
    .map((match) => match[1])
    .filter((filepath) => !normalize(filepath).toLowerCase().startsWith("_system/"));
  for (const filepath of files) {
    const tail = section.slice(section.indexOf(`===== ${filepath} =====`) + filepath.length + 12);
    const next = tail.indexOf("\n=====");
    const body = next >= 0 ? tail.slice(0, next) : tail;
    trackFile(authContext, filepath, body.length, "startup", body.includes("startup copy truncated"));
  }
  const projects = String(project || "Master").split(":").map((value) => value.trim()).filter(Boolean);
  return contextStructured(authContext, {
    mode: "loaded",
    projects,
    loadstrength,
    visibleLoadedFiles: contextArray(authContext).filter((file) => !isBackgroundUiPath(file.path)),
    loadedFileCount: contextArray(authContext).filter((file) => !isBackgroundUiPath(file.path)).length,
    truncatedFileCount: contextArray(authContext).filter((file) => !isBackgroundUiPath(file.path) && file.truncated).length,
  });
}

// Claude-facing widget metadata: MCP Apps spec keys under _meta.ui.*
// (resourceUri is set at the tool-result call site, not here).
function buildClaudeUiMeta(widgetDomain) {
  return {
    prefersBorder: true,
    csp: { connectDomains: [widgetDomain], resourceDomains: [widgetDomain] },
  };
}

// ChatGPT Apps SDK-facing widget metadata: openai/* namespaced keys, ignored
// by any host (Claude included) that doesn't recognize them.
function buildChatGptMeta(widgetDescription, widgetDomain = getWidgetDomain()) {
  return {
    "openai/widgetDescription": widgetDescription,
    "openai/widgetPrefersBorder": true,
    "openai/widgetCSP": { connect_domains: [widgetDomain], resource_domains: [widgetDomain] },
    "openai/widgetDomain": widgetDomain,
  };
}

function registerWidget(server) {
  if (resourceRegistered.has(server)) return;
  resourceRegistered.add(server);
  const widgetDomain = getWidgetDomain();
  const widgetMeta = {
    ui: buildClaudeUiMeta(widgetDomain),
  };
  const helpMeta = {
    ui: buildClaudeUiMeta(widgetDomain),
  };
  const chatGptWidgetMeta = buildChatGptMeta("The OrbitFS ChatGPT startup chooser, active context manager, file browser and upload controls.");
  const chatGptHelpMeta = buildChatGptMeta("Searchable OrbitFS ChatGPT command reference with usage and short descriptions.");
  server.registerResource(
    "orbitfs-ui",
    WIDGET_URI,
    { title: "OrbitFS UI", description: "Legacy OrbitFS controls for existing clients, including Claude", mimeType: "text/html;profile=mcp-app", _meta: widgetMeta },
    async () => ({ contents: [{ uri: WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: WIDGET_HTML, _meta: widgetMeta }] })
  );
  server.registerResource(
    "orbitfs-chatgpt-ui",
    CHATGPT_WIDGET_URI,
    { title: "OrbitFS ChatGPT UI", description: "ChatGPT-specific OrbitFS controls", mimeType: "text/html;profile=mcp-app", _meta: chatGptWidgetMeta },
    async () => ({ contents: [{ uri: CHATGPT_WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: CHATGPT_UI.widgetHtml, _meta: chatGptWidgetMeta }] })
  );
  server.registerResource(
    "orbitfs-help",
    HELP_WIDGET_URI,
    { title: "OrbitFS Command Help", description: "Verified OrbitFS commands", mimeType: "text/html;profile=mcp-app", _meta: helpMeta },
    async () => ({ contents: [{ uri: HELP_WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: HELP_WIDGET_HTML, _meta: helpMeta }] })
  );
  server.registerResource(
    "orbitfs-chatgpt-help",
    CHATGPT_HELP_WIDGET_URI,
    { title: "OrbitFS ChatGPT Command Help", description: "Verified ChatGPT OrbitFS commands", mimeType: "text/html;profile=mcp-app", _meta: chatGptHelpMeta },
    async () => ({ contents: [{ uri: CHATGPT_HELP_WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: CHATGPT_UI.helpHtml, _meta: chatGptHelpMeta }] })
  );
}

async function findProfilePaths() {
  const results = [];
  async function walk(dir, rel = "") {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childRel = normalize(path.posix.join(rel, entry.name));
      const lower = childRel.toLowerCase();
      if (["_trash", "node_modules", ".git", "archive", "archives"].some((part) => lower.split("/").includes(part))) continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child, childRel);
      else if (/master[_\s-]*profile/i.test(entry.name) && /\.(md|txt|json|docx)$/i.test(entry.name)) results.push(childRel);
    }
  }
  await walk(ROOT);
  return results;
}

async function readProfile(filepath) {
  const absolute = path.join(ROOT, ...normalize(filepath).split("/"));
  if (/\.docx$/i.test(filepath)) return (await mammoth.extractRawText({ path: absolute })).value;
  return fs.readFile(absolute, "utf8");
}


const STARTUP_PROJECTS = {
  "1. Legal": "1. Legal/STARTUP.md",
  "2. Wellbeing": "2. Wellbeing/STARTUP.md",
};

function normalizeStartupProject(project = "") {
  const value = String(project).trim().toLowerCase();
  if (["1", "legal", "1. legal", "court"].includes(value)) return "1. Legal";
  if (["2", "wellbeing", "well-being", "2. wellbeing", "mental", "mental health"].includes(value)) return "2. Wellbeing";
  return String(project).trim();
}

const STARTUP_SYSTEM_FILES = [
  "_system/Rules/load_order.md",
  "_system/Rules/project_rules.md",
  "_system/Rules/saving_rules.md",
  "_system/Rules/commands.md",
  "_system/Index/file_index.json",
];

const STARTUP_ALWAYS_FILES = [
  "0. Core/Master Logs/Master_Incident_Log_v1",
  "0. Core/Master Logs/Master_Incident_Log_v2",
  "0. Core/Master Logs/Mental_Health_Profiles_Core",
  "0. Core/Master Logs/Master_Relationship_Timeline",
  "0. Core/Profiles/Master Profiles/Luke_Kerim_Master_Profile.docx",
  "0. Core/Profiles/Master Profiles/Laura_Woods_Master_Profile.docx",
];


function excludedStartupPath(filepath = "") {
  return normalize(filepath).split("/").some((part) => ["archive", "archives", "trash", "_trash", "_sorter"].includes(part.toLowerCase()));
}

function archivePath(filepath = "") {
  return excludedStartupPath(filepath);
}

async function resolveStartupPath(filepath) {
  const rel = normalize(filepath);
  const absolute = path.join(ROOT, ...rel.split("/"));
  try {
    const stat = await fs.stat(absolute);
    if (stat.isFile()) return rel;
  } catch {}

  const folder = path.posix.dirname(rel);
  const wanted = path.posix.basename(rel).replace(/\.[^.]+$/, "").toLowerCase();
  const folderAbsolute = path.join(ROOT, ...folder.split("/"));
  const entries = await fs.readdir(folderAbsolute, { withFileTypes: true });
  const match = entries.find((entry) => entry.isFile() && entry.name.replace(/\.[^.]+$/, "").toLowerCase() === wanted);
  if (!match) throw new Error(`Required startup file not found: ${rel}`);
  return normalize(path.posix.join(folder, match.name));
}

const STARTUP_TEXT_EXTENSIONS = /\.(md|txt|json|jsonl|csv|yml|yaml|xml|html|js|mjs|cjs|ts|tsx|jsx|css|py|ps1|sh|sql|log|ini|cfg|conf)$/i;

async function readableStartupText(filepath) {
  const rel = normalize(filepath);
  if (!rel || rel.includes("..") || /^[a-z]:/i.test(rel)) throw new Error(`Invalid OrbitFS-relative path: ${filepath}`);
  if (archivePath(rel)) throw new Error(`Archive is excluded: ${rel}`);
  const absolute = path.join(ROOT, ...rel.split("/"));
  if (/\.docx$/i.test(rel)) return (await mammoth.extractRawText({ path: absolute })).value;
  if (/\.pdf$/i.test(rel)) {
    const result = await pdfParse(await fs.readFile(absolute));
    const text = result.text || "";
    if (text.trim().length > 20) return text;
    const stat = await fs.stat(absolute);
    return `[PDF FILE REFERENCE]\nPath: ${rel}\nPages: ${result.numpages || "unknown"}\nSize: ${stat.size} bytes\nPDF text extraction returned little or no readable text. It may be scanned or image-based.`;
  }
  if (STARTUP_TEXT_EXTENSIONS.test(rel)) return fs.readFile(absolute, "utf8");
  const stat = await fs.stat(absolute);
  return `[FILE REFERENCE]\nPath: ${rel}\nType: ${path.extname(rel).slice(1).toUpperCase() || "UNKNOWN"}\nSize: ${stat.size} bytes\nReadable text was not extracted automatically. Use view_file/open_file_web/download link or a specialist extractor for this file type.`;
}

async function expandStartupSelections(selections = []) {
  const files = [];
  const expandedFolders = [];
  async function walk(abs, rel) {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = normalize(path.posix.join(rel, entry.name));
      if (excludedStartupPath(childRel)) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) await walk(childAbs, childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  }
  for (const requested of selections.map(normalize).filter(Boolean)) {
    if (excludedStartupPath(requested)) continue;
    const absolute = path.join(ROOT, ...requested.split("/"));
    let stat;
    try { stat = await fs.stat(absolute); }
    catch (error) { throw new Error(`Configured startup path not found: ${requested}`); }
    if (stat.isDirectory()) {
      const before = files.length;
      await walk(absolute, requested);
      expandedFolders.push({ folder: requested, fileCount: files.length - before });
    } else if (stat.isFile()) {
      files.push(requested);
    }
  }
  return { files: [...new Set(files)], expandedFolders };
}

async function collectMegaFiles() {
  const files = [];
  const roots = ["0. Core", "1. Legal", "2. Wellbeing"];
  async function walk(abs, rel) {
    let entries;
    try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childRel = normalize(path.posix.join(rel, entry.name));
      if (excludedStartupPath(childRel)) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) await walk(childAbs, childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  }
  for (const root of roots) await walk(path.join(ROOT, root), root);
  return files;
}

async function runOrbitStartup(authContext, { project, loadstrength, mega = false, selectedFiles = [], taskFiles = [] }) {
  project = normalizeStartupProject(project);
  const startupFile = STARTUP_PROJECTS[project];
  if (!startupFile) throw new Error(`Unknown project "${project}". Use 1. Legal or 2. Wellbeing.`);
  const strength = String(loadstrength).toLowerCase();
  if (!["low", "medium", "high", "custom1", "custom2", "custom"].includes(strength)) throw new Error("Use low, medium, high, custom1, custom2, or custom.");

  const config = await readConfig();
  const preset = config.presets?.[project]?.[strength] || [];
  const mandatoryRequested = [startupFile, ...STARTUP_SYSTEM_FILES, ...STARTUP_ALWAYS_FILES];
  const mandatoryResolved = [];
  for (const filepath of mandatoryRequested) mandatoryResolved.push(await resolveStartupPath(filepath));

  const mandatoryKeys = new Set(mandatoryResolved.map((filepath) => normalize(filepath).toLowerCase()));
  const optionalRequested = [...preset, ...selectedFiles, ...taskFiles];
  if (mega) optionalRequested.push(...await collectMegaFiles());
  const expansion = await expandStartupSelections(optionalRequested);
  const optional = expansion.files
    .filter((filepath) => !archivePath(filepath) && !mandatoryKeys.has(filepath.toLowerCase()));

  const loaded = [];
  const failed = [];
  for (const filepath of mandatoryResolved) {
    try {
      const content = await readableStartupText(filepath);
      loaded.push({ filepath, content, characters: content.length, truncated: false, mandatory: true });
      trackFile(authContext, filepath, content.length, "startup-default", false, false);
    } catch (error) {
      failed.push({ filepath, error: error.message, mandatory: true });
    }
  }
  if (failed.some((item) => item.mandatory)) {
    const detail = failed.filter((item) => item.mandatory).map((item) => `${item.filepath}: ${item.error}`).join("; ");
    throw new Error(`Required startup context failed: ${detail}`);
  }

  const limits = mega
    ? (config.levels?.mega || DEFAULT_CONFIG.levels.mega)
    : (config.levels?.[strength] || DEFAULT_CONFIG.levels[strength]);
  let optionalTotal = 0;
  for (const filepath of optional.slice(0, limits.maxFiles)) {
    try {
      const full = await readableStartupText(filepath);
      const room = Math.max(0, limits.maxCharacters - optionalTotal);
      if (!room) break;
      const content = full.slice(0, Math.min(limits.perFileCharacters, room));
      optionalTotal += content.length;
      loaded.push({ filepath, content, characters: full.length, truncated: content.length < full.length, mandatory: false });
      trackFile(authContext, filepath, content.length, mega ? "mega" : "startup", content.length < full.length);
    } catch (error) {
      failed.push({ filepath, error: error.message, mandatory: false });
    }
  }

  const blocks = loaded.map((item) => `===== ${item.filepath} =====\n${item.content}${item.truncated ? "\n? (truncated)" : ""}`);
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: "orbit.startup.loaded", project, strength, mega, configuredSelections: optionalRequested.length, expandedFolders: expansion.expandedFolders, expandedFiles: optional.length, loaded: loaded.length, failed: failed.length }));
  const confirmation = `${project} active. ${mega ? "MEGA 0. Core + 1. Legal + 2. Wellbeing" : strength.toUpperCase()} context loaded. ${loaded.length} files read (${optional.length} expanded preset files plus required context). Ready.`;
  return {
    content: [{ type: "text", text: `[INTERNAL ORBITFS STARTUP CONTEXT - read silently; do not claim files not listed as loaded.]\n\n${blocks.join("\n\n")}\n\n${confirmation}` }],
    structuredContent: contextStructured(authContext, {
      mode: "loaded",
      projects: [project],
      loadstrength: strength,
      mega,
      alwaysLoadedFiles: mandatoryResolved,
      configuredSelections: optionalRequested,
      expandedFolders: expansion.expandedFolders,
      expandedFileCount: optional.length,
      loadedFiles: loaded.map(({ content, ...rest }) => rest),
      failedFiles: failed,
      confirmation,
    }),
  };
}

async function replayActiveContext(authContext) {
  const files = contextArray(authContext).filter((file) => !isBackgroundUiPath(file.path));
  const blocks = [];
  const failed = [];
  for (const file of files) {
    try {
      const content = await readableStartupText(file.path);
      const now = Date.now();
      file.lastAccessedAt = new Date(now).toISOString();
      file.expiresAt = null;
      blocks.push(`===== ${file.path} =====
${content}`);
    } catch (error) {
      failed.push({ filepath: file.path, error: error.message });
    }
  }
  return {
    content: [{ type: "text", text: blocks.length
      ? `[INTERNAL ORBITFS ACTIVE CONTEXT - read every file below and continue treating it as active.]

${blocks.join("\n\n")}`
      : "No active OrbitFS files." }],
    structuredContent: contextStructured(authContext, { replayed: blocks.length, failedFiles: failed }),
  };
}

const CHATGPT_WIDGET_CALLABLE_TOOLS = new Set([
  "clear_active_context",
  "clear_all_context",
  "delete_journal_draft",
  "delete_vent_draft",
  "journal_status",
  "journalmode",
  "list_active_context",
  "list_files",
  "load_file",
  "move_item",
  "move_to_trash",
  "orbitfs_ui",
  "preview_file",
  "reload_journal_draft",
  "reload_vent_draft",
  "server_status",
  "start_journal_recording",
  "start_vent_recording",
  "startup",
  "stop_journal_recording",
  "stop_vent_recording",
  "unload_context_files",
  "upload_journal_entry",
  "upload_vent_entry",
  "vent_status",
  "ventmode",
]);

function isChatGptWidgetCallable(authContext, name) {
  return flowKey(authContext) === "chatgpt" && CHATGPT_WIDGET_CALLABLE_TOOLS.has(name);
}

function widgetCallableDescriptor(name, description, schema) {
  return {
    title: name.replace(/_/g, " "),
    description: typeof description === "string" ? description : undefined,
    inputSchema: schema || {},
    _meta: { "openai/widgetAccessible": true },
  };
}
function toolUiMeta(resourceUri, isChatGpt) {
  const meta = { ui: { resourceUri } };
  if (isChatGpt) {
    meta["openai/outputTemplate"] = resourceUri;
    meta["openai/widgetAccessible"] = true;
  }
  return meta;
}
function registerExtraTools(server, authContext) {
  if (extraToolsRegistered.has(server)) return;
  extraToolsRegistered.add(server);
  const isChatGpt = flowKey(authContext) === "chatgpt";
  const uiResourceUri = isChatGpt ? CHATGPT_WIDGET_URI : WIDGET_URI;
  const helpResourceUri = isChatGpt ? CHATGPT_HELP_WIDGET_URI : HELP_WIDGET_URI;
  const uiMeta = toolUiMeta(uiResourceUri, isChatGpt);
  const helpMeta = toolUiMeta(helpResourceUri, isChatGpt);

  server.registerTool("showcp", {
    title: "Open OrbitFS Control Panel",
    description: "Directly open the main OrbitFS control panel. This is the tool for /showcp and the UI navigation slash commands.",
    inputSchema: { view: z.enum(["startup", "context", "files", "vent", "journal", "system"]).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async ({ view }) => {
    const next = view || "startup";
    const hiveUiState = getHiveUiState(authContext);
    hiveUiState.currentScreen = next;
    hiveUiState.open = true;
    hiveUiState.focused = true;
    hiveUiState.modal = null;
    const publicSnapshot = hiveUiPublicSnapshot(authContext, { mode: "ui", view: next });
    return {
      content: [{ type: "text", text: "OrbitFS control panel opened." }],
      structuredContent: publicSnapshot,
      _meta: { ...uiMeta, orbitfsState: hiveUiSnapshot(authContext, { mode: "ui", view: next }) },
    };
  });

  server.registerTool("orbitfs_help", {
    title: "Open OrbitFS Command Help",
    description: "Open the separate searchable OrbitFS ChatGPT command reference. Use for /orbithelp.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: helpMeta,
  }, async () => ({
    content: [{ type: "text", text: "OrbitFS command help opened." }],
    structuredContent: { mode: "help", commands: COMMAND_HELP },
    _meta: helpMeta,
  }));

  server.registerTool("orbitfs_ui", {
    title: "The OrbitFS UI controller",
    description: "Central controller for the OrbitFS UI in ChatGPT or Claude. Use for commands like '@OrbitFS open startup', '@OrbitFS open browser', '@OrbitFS open viewer <file>', '@OrbitFS close', '@OrbitFS back', '@OrbitFS refresh', '@OrbitFS focus', '@OrbitFS status', and '@OrbitFS modal <permissions|move|info|upload|delete|close>'.",
    inputSchema: {
      action: z.enum(["open", "close", "back", "refresh", "focus", "status", "modal"]),
      screen: z.enum(HIVE_SCREENS).optional(),
      target: z.string().optional().describe("Optional file, folder, or item for the selected screen"),
      modal: z.enum([...HIVE_MODALS, "close"]).optional(),
      options: z.record(z.any()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: uiMeta,
  }, async ({ action, screen, target, modal, options }) => {
    const hiveUiState = getHiveUiState(authContext);
    if (action === "open") {
      const next = screen || "startup";
      if (hiveUiState.open && hiveUiState.currentScreen !== next) hiveUiState.history.push(hiveUiState.currentScreen);
      hiveUiState.currentScreen = next;
      hiveUiState.open = true;
      hiveUiState.focused = true;
      hiveUiState.modal = null;
    } else if (action === "close") {
      hiveUiState.open = false;
      hiveUiState.focused = false;
      hiveUiState.modal = null;
    } else if (action === "back") {
      hiveUiState.currentScreen = hiveUiState.history.pop() || "startup";
      hiveUiState.open = true;
      hiveUiState.modal = null;
    } else if (action === "refresh") {
      hiveUiState.revision += 1;
      hiveUiState.open = true;
    } else if (action === "focus") {
      hiveUiState.open = true;
      hiveUiState.focused = true;
    } else if (action === "modal") {
      hiveUiState.open = true;
      hiveUiState.modal = modal === "close" ? null : (modal || null);
    }
    if (target) hiveUiState.selectedFiles = [target];
    if (options) hiveUiState.filters = { ...hiveUiState.filters, ...options };
    const text = action === "status" ? `OrbitFS UI: ${hiveUiState.open ? "open" : "closed"}; screen=${hiveUiState.currentScreen}; modal=${hiveUiState.modal || "none"}; history=${hiveUiState.history.length}` : `OrbitFS UI ${action}: ${screen || modal || hiveUiState.currentScreen}`;
    const publicSnapshot = hiveUiPublicSnapshot(authContext, { action, target: target || null });
    return { content: [{ type: "text", text }], structuredContent: publicSnapshot, _meta: { ...uiMeta, orbitfsState: hiveUiSnapshot(authContext, { action, target: target || null }) } };
  });

  server.registerTool("show_orbitfs_ui", {
    title: "Open the OrbitFS UI",
    description: "Open the OrbitFS UI in ChatGPT. Use for /orbitfs, /files, /context, /profiles, /upload, or natural-language requests to open or manage OrbitFS.",
    inputSchema: { view: z.enum(["startup", "context", "files", "upload"]).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async ({ view }) => {
    const config = await readConfig();
    const next = view || "startup";
    const hiveUiState = getHiveUiState(authContext);
    hiveUiState.currentScreen = next;
    hiveUiState.open = true;
    hiveUiState.focused = true;
    hiveUiState.modal = null;
    const publicSnapshot = hiveUiPublicSnapshot(authContext, { mode: "chooser", view: next });
    return {
      content: [{ type: "text", text: "The OrbitFS UI is open." }],
      structuredContent: publicSnapshot,
      _meta: { ...uiMeta, config, orbitfsState: hiveUiSnapshot(authContext, { mode: "chooser", view: next }) },
    };
  });

  server.registerTool("list_active_context", {
    title: "List active OrbitFS context",
    description: "List files currently marked active for this OrbitFS ChatGPT session without reloading file contents.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async () => {
    const structuredContent = contextStructured(authContext);
    return {
      content: [{ type: "text", text: `${structuredContent.activeFileCount} active OrbitFS file${structuredContent.activeFileCount === 1 ? "" : "s"}.` }],
      structuredContent,
    };
  });

  server.registerTool("unload_context_file", {
    title: "Unload OrbitFS context file",
    description: "Remove a file from the authoritative active OrbitFS context set. This cannot erase text already present earlier in the chat, but ChatGPT must stop treating it as active OrbitFS context.",
    inputSchema: { filepath: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async ({ filepath }) => {
    const activeContext = getActiveContext(authContext);
    const key = normalize(filepath);
    activeContext.delete(key);
    return { content: [{ type: "text", text: `[ORBITFS CONTEXT UPDATE] ${key} is unloaded and must no longer be treated as active OrbitFS context.` }], structuredContent: contextStructured(authContext) };
  });

  server.registerTool("unload_context_files", {
    title: "Unload multiple OrbitFS context files",
    description: "Remove several files from the authoritative active OrbitFS context set in one call.",
    inputSchema: { filepaths: z.array(z.string()).min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async ({ filepaths }) => {
    const activeContext = getActiveContext(authContext);
    const unloaded = [];
    for (const filepath of filepaths) {
      const key = normalize(filepath);
      activeContext.delete(key);
      unloaded.push(key);
    }
    const text = unloaded.length
      ? `[ORBITFS CONTEXT UPDATE] ${unloaded.join(", ")} unloaded and must no longer be treated as active OrbitFS context.`
      : "No files were unloaded.";
    return { content: [{ type: "text", text }], structuredContent: contextStructured(authContext, { unloaded }) };
  });

  server.registerTool("clear_active_context", {
    title: "Clear active OrbitFS context",
    description: "Unload every file from the authoritative active OrbitFS context set.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async () => {
    const activeContext = getActiveContext(authContext);
    activeContext.clear();
    return { content: [{ type: "text", text: "[ORBITFS CONTEXT UPDATE] All OrbitFS files are no longer active." }], structuredContent: contextStructured(authContext) };
  });

  server.registerTool("clear_all_context", {
    title: "Clear all OrbitFS context, including pinned",
    description: "Unload every file from the active OrbitFS context set, including pinned startup-required files. Use only when the user explicitly wants a full reset, not for routine unloading.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async () => {
    const activeContext = getActiveContext(authContext);
    activeContext.clear();
    return { content: [{ type: "text", text: "[ORBITFS CONTEXT UPDATE] All OrbitFS files, including pinned startup-required context, are no longer active." }], structuredContent: contextStructured(authContext) };
  });

  server.registerTool("load_all_profiles", {
    title: "Load all Master Profiles",
    description: "Find and fully load all Master Profile text and DOCX files into active ChatGPT context.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async () => {
    const paths = await findProfilePaths();
    const blocks = [];
    for (const filepath of paths) {
      try {
        const data = await readProfile(filepath);
        trackFile(authContext, filepath, data.length, "profiles", false);
        blocks.push(`===== ${filepath} =====\n${data}`);
      } catch (error) {
        blocks.push(`===== ${filepath} =====\n(unavailable: ${error.message})`);
      }
    }
    return {
      content: [{ type: "text", text: `[INTERNAL ORBITFS PROFILE CONTEXT - Read every profile below and treat each as active context. Do not summarize unless asked.]\n\n${blocks.join("\n\n")}` }],
      structuredContent: contextStructured(authContext, { mode: "loaded", profileCount: paths.length }),
    };
  });
}

McpServer.prototype.tool = function patchedTool(name, description, schema, handler) {
  registerWidget(this);

  if (name === "load_file") {
    capturedLoadFileHandler = handler;
    const wrappedLoadFile = async (args) => {
      const result = await handler(args);
      const text = (result?.content || []).map((item) => item?.text || "").join("\n");
      trackFile(this.authContext, args.filepath, text.length, "manual", false);
      return result;
    };
    if (isChatGptWidgetCallable(this.authContext, name)) {
      return this.registerTool(name, widgetCallableDescriptor(name, description, schema), wrappedLoadFile);
    }
    return originalTool.call(this, name, description, schema, wrappedLoadFile);
  }

  if (name !== "startup_firestorm") {
    if (isChatGptWidgetCallable(this.authContext, name)) {
      return this.registerTool(name, widgetCallableDescriptor(name, description, schema), handler);
    }
    return originalTool.call(this, name, description, schema, handler);
  }
registerExtraTools(this, this.authContext);
  const isChatGpt = flowKey(this.authContext) === "chatgpt";
  const startupResourceUri = isChatGpt ? CHATGPT_WIDGET_URI : WIDGET_URI;
  const startupUiMeta = toolUiMeta(startupResourceUri, isChatGpt);
  return this.registerTool("startup", {
    title: "Start The OrbitFS project",
    description: "Use for /startup. With no arguments, show the project and load-strength chooser. With project and strength, load real OrbitFS startup context.",
    inputSchema: {
      project: z.string().optional().describe("1. Legal or 2. Wellbeing"),
      loadstrength: z.enum(["low", "medium", "high", "custom1", "custom2", "custom"]).optional(),
      mega: z.boolean().optional(),
      selectedFiles: z.array(z.string()).optional(),
      taskFiles: z.array(z.string()).optional(),
      uiSelectionConfirmed: z.boolean().optional().describe("Internal Startup UI compatibility flag."),
    },
    outputSchema: {
      mode: z.string(),
      projects: z.array(z.string()).optional(),
      loadstrength: z.enum(["low", "medium", "high", "custom1", "custom2", "custom"]).optional(),
      activeFiles: z.array(z.any()),
      activeFileCount: z.number(),
      totalCharactersLoaded: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      ...startupUiMeta,
      "openai/toolInvocation/invoking": "Loading The OrbitFS project...",
      "openai/toolInvocation/invoked": "The OrbitFS project loaded",
    },
  }, async ({ project, loadstrength, mega, selectedFiles, taskFiles, uiSelectionConfirmed }) => {
    const config = await readConfig();
    if (!project) return { content: [{ type: "text", text: "Choose a project and load strength in the Startup UI." }], structuredContent: contextStructured(this.authContext, { mode: "chooser" }), _meta: { ...startupUiMeta, config } };
    if (flowKey(this.authContext) === "chatgpt" && uiSelectionConfirmed && !loadstrength) throw new Error("Startup UI selection must include loadstrength.");
    const args = { project, loadstrength: loadstrength || config.defaultStrength || "medium", mega: !!mega, selectedFiles: selectedFiles || [], taskFiles: taskFiles || [] };
    return withDedup(this.authContext, "startup", args, () => runOrbitStartup(this.authContext, args));
  });
};

await import("./server-core.js");
