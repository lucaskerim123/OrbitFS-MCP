import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HIVE_ROOT;
const WIDGET_URI = "ui://widget/orbitfs-hive-v5.html";
const WIDGET_HTML = await fs.readFile(path.join(SERVER_DIR, "app/widget/index.html"), "utf8");
const CONFIG_PATH = path.join(ROOT, "_system", "Config", "startup-loading.json");
const originalTool = McpServer.prototype.tool;
const resourceRegistered = new WeakSet();
const extraToolsRegistered = new WeakSet();
const DEFAULT_PUBLIC_ORIGIN = "https://mcp.incendiarynetworks.cc";
const activeContext = new Map();
const CONTEXT_TTL_MS = null;
let capturedLoadFileHandler = null;
const HIVE_SCREENS = ["startup", "browser", "viewer", "context", "vent", "settings", "permissions", "search", "move", "upload"];
const HIVE_MODALS = ["permissions", "move", "info", "upload", "delete"];
const hiveUiState = {
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
};

function hiveUiSnapshot(extra = {}) {
  return {
    mode: "ui_controller",
    ui: { ...hiveUiState, history: [...hiveUiState.history], selectedFiles: [...hiveUiState.selectedFiles] },
    context: contextStructured(),
    ...extra,
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

function contextArray() {
  return [...activeContext.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.path.localeCompare(b.path));
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

function contextStructured(extra = {}) {
  const files = contextArray().filter((file) => !isBackgroundUiPath(file.path));
  return {
    mode: "active",
    activeFiles: files,
    activeFileCount: files.length,
    totalCharactersLoaded: files.reduce((sum, file) => sum + Number(file.characters || 0), 0),
    ...extra,
  };
}

function trackFile(filepath, characters, source = "manual", truncated = false, pinned = false) {
  const key = normalize(filepath);
  const now = Date.now();
  const existingPinned = activeContext.get(key)?.pinned || false;
  activeContext.set(key, {
    path: key,
    characters: Number(characters || 0),
    source,
    truncated: !!truncated,
    pinned: !!pinned || existingPinned,
    loadedAt: new Date(now).toISOString(),
    lastAccessedAt: new Date(now).toISOString(),
    expiresAt: null,
  });
}

function visibleStartupResult(text, project, loadstrength) {
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
    trackFile(filepath, body.length, "startup", body.includes("startup copy truncated"));
  }
  const projects = String(project || "Master").split(":").map((value) => value.trim()).filter(Boolean);
  return contextStructured({
    mode: "loaded",
    projects,
    loadstrength,
    visibleLoadedFiles: contextArray().filter((file) => !isBackgroundUiPath(file.path)),
    loadedFileCount: contextArray().filter((file) => !isBackgroundUiPath(file.path)).length,
    truncatedFileCount: contextArray().filter((file) => !isBackgroundUiPath(file.path) && file.truncated).length,
  });
}

function registerWidget(server) {
  if (resourceRegistered.has(server)) return;
  resourceRegistered.add(server);
  const widgetDomain = getWidgetDomain();
  const widgetMeta = {
    ui: {
      prefersBorder: true,
      csp: { connectDomains: [widgetDomain], resourceDomains: [widgetDomain] },
    },
    "openai/widgetDescription": "The Hive startup chooser, active context manager, file browser and upload controls.",
    "openai/widgetPrefersBorder": true,
  };
  server.registerResource(
    "orbitfs-hive-ui",
    WIDGET_URI,
    { title: "The Hive", description: "OrbitFS controls inside ChatGPT", mimeType: "text/html;profile=mcp-app", _meta: widgetMeta },
    async () => ({ contents: [{ uri: WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: WIDGET_HTML, _meta: widgetMeta }] })
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

async function readableStartupText(filepath) {
  const rel = normalize(filepath);
  if (!rel || rel.includes("..") || /^[a-z]:/i.test(rel)) throw new Error(`Invalid Hive-relative path: ${filepath}`);
  if (archivePath(rel)) throw new Error(`Archive is excluded: ${rel}`);
  const absolute = path.join(ROOT, ...rel.split("/"));
  if (/\.docx$/i.test(rel)) return (await mammoth.extractRawText({ path: absolute })).value;
  return fs.readFile(absolute, "utf8");
}

const STARTUP_READABLE_EXTENSIONS = /\.(md|txt|json|jsonl|csv|yml|yaml|xml|html|js|mjs|cjs|ts|tsx|jsx|css|py|ps1|sh|sql|log|ini|cfg|conf|docx)$/i;

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
      else if (STARTUP_READABLE_EXTENSIONS.test(entry.name)) files.push(childRel);
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
      if (!STARTUP_READABLE_EXTENSIONS.test(requested)) throw new Error(`Unsupported startup file type: ${requested}`);
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
      else if (STARTUP_READABLE_EXTENSIONS.test(entry.name)) files.push(childRel);
    }
  }
  for (const root of roots) await walk(path.join(ROOT, root), root);
  return files;
}

async function runOrbitStartup({ project, loadstrength, mega = false, selectedFiles = [], taskFiles = [] }) {
  const startupFile = STARTUP_PROJECTS[project];
  if (!startupFile) throw new Error(`Unknown project "${project}". Use 1. Legal or 2. Wellbeing.`);
  const strength = String(loadstrength || "medium").toLowerCase();
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
      trackFile(filepath, content.length, "startup-required", false, true);
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
      trackFile(filepath, content.length, mega ? "mega" : "startup", content.length < full.length);
    } catch (error) {
      failed.push({ filepath, error: error.message, mandatory: false });
    }
  }

  const blocks = loaded.map((item) => `===== ${item.filepath} =====\n${item.content}${item.truncated ? "\n? (truncated)" : ""}`);
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: "orbit.startup.loaded", project, strength, mega, configuredSelections: optionalRequested.length, expandedFolders: expansion.expandedFolders, expandedFiles: optional.length, loaded: loaded.length, failed: failed.length }));
  const confirmation = `${project} active. ${mega ? "MEGA 0. Core + 1. Legal + 2. Wellbeing" : strength.toUpperCase()} context loaded. ${loaded.length} files read (${optional.length} expanded preset files plus required context). Ready.`;
  return {
    content: [{ type: "text", text: `[INTERNAL ORBITFS STARTUP CONTEXT - read silently; do not claim files not listed as loaded.]\n\n${blocks.join("\n\n")}\n\n${confirmation}` }],
    structuredContent: contextStructured({
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

async function replayActiveContext() {
  const files = contextArray().filter((file) => !isBackgroundUiPath(file.path));
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
      ? `[INTERNAL HIVE ACTIVE CONTEXT - read every file below and continue treating it as active.]

${blocks.join("\n\n")}`
      : "No active Hive files." }],
    structuredContent: contextStructured({ replayed: blocks.length, failedFiles: failed }),
  };
}

function registerExtraTools(server) {
  if (extraToolsRegistered.has(server)) return;
  extraToolsRegistered.add(server);
  const uiMeta = { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI };

  server.registerTool("hive_ui", {
    title: "The Hive UI controller",
    description: "Central controller for The Hive in ChatGPT or Claude. Use for commands like '@The hive open startup', '@The hive open browser', '@The hive open viewer <file>', '@The hive close', '@The hive back', '@The hive refresh', '@The hive focus', '@The hive status', and '@The hive modal <permissions|move|info|upload|delete|close>'.",
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
    const text = action === "status" ? `Hive UI: ${hiveUiState.open ? "open" : "closed"}; screen=${hiveUiState.currentScreen}; modal=${hiveUiState.modal || "none"}; history=${hiveUiState.history.length}` : `Hive UI ${action}: ${screen || modal || hiveUiState.currentScreen}`;
    return { content: [{ type: "text", text }], structuredContent: hiveUiSnapshot({ action, target: target || null }) };
  });

  server.registerTool("show_hive", {
    title: "Open The Hive",
    description: "Open the Hive interface in ChatGPT. Use for /hive, /files, /context, /profiles, /upload, or natural-language requests to open or manage Hive.",
    inputSchema: { view: z.enum(["startup", "context", "files", "upload"]).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async ({ view }) => {
    const config = await readConfig();
    return { content: [{ type: "text", text: "The Hive interface is open." }], structuredContent: contextStructured({ mode: "chooser", view: view || "startup", config }) };
  });

  server.registerTool("list_active_context", {
    title: "List active Hive context",
    description: "List files currently marked active for this Hive ChatGPT session.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async () => replayActiveContext());

  server.registerTool("unload_context_file", {
    title: "Unload Hive context file",
    description: "Remove a file from the authoritative active Hive context set. This cannot erase text already present earlier in the chat, but ChatGPT must stop treating it as active Hive context.",
    inputSchema: { filepath: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async ({ filepath }) => {
    const key = normalize(filepath);
    const current = activeContext.get(key);
    if (current?.pinned) throw new Error(`${key} is pinned startup-required context and cannot be unloaded individually.`);
    activeContext.delete(key);
    return { content: [{ type: "text", text: `[HIVE CONTEXT UPDATE] ${key} is unloaded and must no longer be treated as active Hive context.` }], structuredContent: contextStructured() };
  });

  server.registerTool("clear_active_context", {
    title: "Clear active Hive context",
    description: "Unload every unpinned file from the authoritative active Hive context set.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async () => {
    for (const [key, file] of activeContext) if (!file.pinned) activeContext.delete(key);
    return { content: [{ type: "text", text: "[HIVE CONTEXT UPDATE] Unpinned Hive files are no longer active." }], structuredContent: contextStructured() };
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
        trackFile(filepath, data.length, "profiles", false);
        blocks.push(`===== ${filepath} =====\n${data}`);
      } catch (error) {
        blocks.push(`===== ${filepath} =====\n(unavailable: ${error.message})`);
      }
    }
    return {
      content: [{ type: "text", text: `[INTERNAL HIVE PROFILE CONTEXT - Read every profile below and treat each as active context. Do not summarize unless asked.]\n\n${blocks.join("\n\n")}` }],
      structuredContent: contextStructured({ mode: "loaded", profileCount: paths.length }),
    };
  });
}

McpServer.prototype.tool = function patchedTool(name, description, schema, handler) {
  registerWidget(this);

  if (name === "load_file") {
    capturedLoadFileHandler = handler;
    return originalTool.call(this, name, description, schema, async (args) => {
      const result = await handler(args);
      const text = (result?.content || []).map((item) => item?.text || "").join("\n");
      trackFile(args.filepath, text.length, "manual", false);
      return result;
    });
  }

  if (name !== "startup_firestorm") return originalTool.call(this, name, description, schema, handler);

  registerExtraTools(this);
  return this.registerTool("startup", {
    title: "Start The Hive project",
    description: "Use for /startup. With no arguments, show the project and load-strength chooser. With project and strength, load real Hive startup context and show what became active.",
    inputSchema: {
      project: z.string().optional().describe("1. Legal or 2. Wellbeing"),
      loadstrength: z.enum(["low", "medium", "high", "custom1", "custom2", "custom"]).optional(),
      mega: z.boolean().optional(),
      selectedFiles: z.array(z.string()).optional(),
      taskFiles: z.array(z.string()).optional(),
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
      ui: { resourceUri: WIDGET_URI },
      "openai/outputTemplate": WIDGET_URI,
      "openai/toolInvocation/invoking": "Loading The Hive project...",
      "openai/toolInvocation/invoked": "The Hive project loaded",
    },
  }, async ({ project, loadstrength, mega, selectedFiles, taskFiles }) => {
    const config = await readConfig();
    if (!project) return { content: [{ type: "text", text: "Choose a project and load strength in the Startup UI." }], structuredContent: contextStructured({ mode: "chooser", config }) };
    return runOrbitStartup({ project, loadstrength: loadstrength || config.defaultStrength || "medium", mega: !!mega, selectedFiles: selectedFiles || [], taskFiles: taskFiles || [] });
  });
};

await import("./server-core.js");
