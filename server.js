import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HIVE_ROOT;
const WIDGET_URI = "ui://widget/orbitfs-hive-v4.html";
const WIDGET_HTML = await fs.readFile(path.join(SERVER_DIR, "app/widget/index.html"), "utf8");
const CONFIG_PATH = path.join(ROOT, "_system", "Config", "startup-loading.json");
const originalTool = McpServer.prototype.tool;
const resourceRegistered = new WeakSet();
const extraToolsRegistered = new WeakSet();
const DEFAULT_PUBLIC_ORIGIN = "https://mcp.incendiarynetworks.cc";
const activeContext = new Map();
let capturedLoadFileHandler = null;

const DEFAULT_CONFIG = {
  defaultProject: "Mental",
  defaultStrength: "med",
  includeMasterProfiles: false,
  includeFolders: ["0. Core"],
  excludeFolders: ["_trash", "archive", "archives", "2. Wellbeing/Pure Vent Mode"],
  levels: {
    low: { maxFiles: 0, maxCharacters: 60000, perFileCharacters: 30000 },
    med: { maxFiles: 24, maxCharacters: 240000, perFileCharacters: 50000 },
    high: { maxFiles: 80, maxCharacters: 700000, perFileCharacters: 90000 },
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
        med: { ...DEFAULT_CONFIG.levels.med, ...(raw.levels?.med || {}) },
        high: { ...DEFAULT_CONFIG.levels.high, ...(raw.levels?.high || {}) },
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

function trackFile(filepath, characters, source = "manual", truncated = false) {
  const key = normalize(filepath);
  activeContext.set(key, {
    path: key,
    characters: Number(characters || 0),
    source,
    truncated: !!truncated,
    pinned: activeContext.get(key)?.pinned || false,
    loadedAt: new Date().toISOString(),
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

function registerExtraTools(server) {
  if (extraToolsRegistered.has(server)) return;
  extraToolsRegistered.add(server);
  const uiMeta = { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI };

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
  }, async () => ({ content: [{ type: "text", text: JSON.stringify(contextStructured(), null, 2) }], structuredContent: contextStructured() }));

  server.registerTool("unload_context_file", {
    title: "Unload Hive context file",
    description: "Remove a file from the authoritative active Hive context set. This cannot erase text already present earlier in the chat, but ChatGPT must stop treating it as active Hive context.",
    inputSchema: { filepath: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: uiMeta,
  }, async ({ filepath }) => {
    const key = normalize(filepath);
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
      project: z.string().optional().describe("Master, Court, Mental, Media, Combined, or colon-separated projects"),
      loadstrength: z.enum(["low", "med", "high"]).optional(),
    },
    outputSchema: {
      mode: z.string(),
      projects: z.array(z.string()).optional(),
      loadstrength: z.enum(["low", "med", "high"]).optional(),
      activeFiles: z.array(z.any()),
      activeFileCount: z.number(),
      totalCharactersLoaded: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      ui: { resourceUri: WIDGET_URI },
      "openai/outputTemplate": WIDGET_URI,
      "openai/toolInvocation/invoking": "Loading The Hive projectâ€¦",
      "openai/toolInvocation/invoked": "The Hive project loaded",
    },
  }, async ({ project, loadstrength }) => {
    const config = await readConfig();
    if (!project) {
      return { content: [{ type: "text", text: "Choose a Hive project and load strength in the widget." }], structuredContent: contextStructured({ mode: "chooser", config }) };
    }
    const selectedProject = project === "Combined" ? "Court:Mental:Media" : project;
    const strength = loadstrength || config.defaultStrength || "med";
    const result = await handler({ project: selectedProject, load_level: strength });
    const text = (result?.content || []).map((item) => item?.text || "").join("\n");
    return { ...result, structuredContent: visibleStartupResult(text, selectedProject, strength) };
  });
};

await import("./server-core.js");
