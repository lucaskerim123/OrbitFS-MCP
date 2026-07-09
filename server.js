import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });
import express from "express";
import fs from "fs/promises";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { jwtVerify } from "jose";
import Anthropic from "@anthropic-ai/sdk";
import { mountOAuth, getOAuthState } from "./oauth.js";
import { makeOps } from "./hive-ops.js";

const ROOT = process.env.HIVE_ROOT;
const API_KEY = process.env.HIVE_API_KEY;
const PORT = process.env.PORT || 3939;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const SECRET_KEY = new TextEncoder().encode(process.env.SESSION_SECRET);
const SORT_FOLDER = "_sorter";
const TRASH_FOLDER = "🗑 Trash";
const LEGACY_TRASH_FOLDERS = ["_trash"];
const PROTECTED_ROOT_FOLDERS = new Set([
  "_system",
  "_sorter",
  "🗑 Trash",
  "_trash",
  "0. Core Folder",
  "1. Master Court System",
  "2. Mental Health System",
  "3. Legal Charges - AVO",
  "Media",
]);
const SORT_MODEL = process.env.SORT_MODEL || "claude-haiku-4-5-20251001";
const DEFAULT_TRASH_RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS || 4);
const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_MAX_BYTES = 10 * 1024 * 1024;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
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
  Master: ["_system", "0. Core Folder"],
  Court: ["1. Master Court System", "3. Legal Charges - AVO"],
  Mental: ["2. Mental Health System"],
  Media: ["Media"],
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

async function classifyDestination(itemName, isDir, folders) {
  if (!anthropic) {
    throw new Error("ANTHROPIC_API_KEY is not configured on the Hive server, so sort_inbox can't ask the model for a destination.");
  }
  const prompt = [
    `You are filing an item out of a personal file store's "${SORT_FOLDER}" staging folder into its real home.`,
    `Item to file: "${itemName}" (${isDir ? "folder" : "file"}).`,
    `Existing folders in the store (relative paths, top-level first):`,
    folders.length ? folders.map((f) => `- ${f}`).join("\n") : "(store is empty, no existing folders yet)",
    ``,
    `Pick the single best destination folder for this item. Prefer an existing folder that clearly matches over inventing a new one. If nothing fits, propose a short, sensible new top-level (or nested, e.g. "Documents/Invoices") folder name.`,
    `Respond with ONLY compact JSON, no prose, no markdown fences: {"destination": "<folder path, no leading/trailing slash>", "isNew": true|false, "reason": "<one short sentence>"}`,
  ].join("\n");

  const msg = await anthropic.messages.create({
    model: SORT_MODEL,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Sorter model returned an unparseable response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  if (!parsed.destination || typeof parsed.destination !== "string") {
    throw new Error("Sorter model response missing a destination");
  }
  return parsed;
}

// Dry run: asks the model where each _sorter item should go, but does not
// touch the filesystem. Callers must show this to the user and only move
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

function buildFirestormRuleFiles() {
  return [
    FIRESTORM_RULE_FILES.loadOrder,
    FIRESTORM_RULE_FILES.projectRules,
    FIRESTORM_RULE_FILES.savingRules,
    FIRESTORM_RULE_FILES.commands,
  ];
}

async function buildFirestormStartup(projectsInput, loadInput, authContext = {}) {
  const projects = parseStartupProjects(projectsInput);
  const load = parseStartupLoadLevel(loadInput);
  const startupFiles = [...new Set(projects.map((name) => FIRESTORM_STARTUP_FILES[name]))];
  const ruleFiles = buildFirestormRuleFiles();
  const optionalFiles = [FIRESTORM_OPTIONAL_FILES.fileIndex];
  const folders = [...new Set(projects.flatMap((name) => FIRESTORM_PROJECT_FOLDERS[name] || []))]
    .filter((folder) => !isArchivePath(folder));

  const sections = [
    `Command: /startup ${projects.join(":")} ${load}`,
    `Projects: ${projects.join(", ")}`,
    `Load level: ${load}`,
    "",
    "Loaded startup files:",
    ...startupFiles.map((f) => `- ${f}`),
  ];

  for (const file of startupFiles) {
    const content = await ops.readFile(file);
    sections.push("", `===== ${file} =====`, content.trim());
  }

  sections.push("", "Loaded rule files:", ...ruleFiles.map((f) => `- ${f}`));
  for (const file of ruleFiles) {
    const content = await ops.readFile(file);
    sections.push("", `===== ${file} =====`, content.trim());
  }

  for (const file of optionalFiles) {
    const content = await readOptionalFile(file);
    if (content === null) continue;
    sections.push("", "Loaded optional files:", `- ${file}`, "", `===== ${file} =====`, content.trim());
  }

  if (load !== "low") {
    sections.push("", "Relevant folders in scope:");
    for (const folder of folders) {
      try {
        const entries = (await ops.listFiles(folder, { recursive: false }))
          .filter((entry) => !isArchivePath(`${folder}/${entry.name}`));
        sections.push("", `===== ${folder} =====`, summarizeEntries(entries, "  "));
        if (load === "high") {
          const childDirs = entries
            .filter((e) => e.type === "dir")
            .map((e) => `${folder}/${e.name}`)
            .filter((childDir) => !isArchivePath(childDir));
          for (const childDir of childDirs) {
            try {
              const childEntries = (await ops.listFiles(childDir, { recursive: false }))
                .filter((entry) => !isArchivePath(`${childDir}/${entry.name}`));
              sections.push("", `--- ${childDir} ---`, summarizeEntries(childEntries, "    "));
            } catch {}
          }
        }
      } catch (err) {
        sections.push("", `===== ${folder} =====`, `(unavailable: ${err.message})`);
      }
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

  sections.push("", "Confirmation:", ...confirmations);
  logEvent("tool.startup_firestorm.ok", {
    ...authContext,
    projects: projects.join(":"),
    load,
    startupFiles: startupFiles.length,
    ruleFiles: ruleFiles.length,
    optionalFiles: optionalFiles.length,
    folders: folders.length,
  });
  return sections.join("\n");
}

function buildServer(authContext = {}) {
  const server = new McpServer({ name: "master-hive", version: "1.0.0" });

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
    "write_file",
    "Create or overwrite a file in the Master Hive store",
    {
      filepath: z.string().describe("Relative path to the file"),
      content: z.string().describe("Full text content to write"),
    },
    async ({ filepath, content }) => {
      logEvent("tool.write_file.start", { ...authContext, filepath, chars: content.length });
      await ops.writeFile(filepath, content);
      logEvent("file.change.write", { ...authContext, source: "mcp_tool", filepath, chars: content.length });
      return { content: [{ type: "text", text: `Wrote ${content.length} chars to ${filepath}` }] };
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
    "search_files",
    "Search file contents for a substring within the Master Hive store",
    {
      query: z.string().describe("Substring to search for"),
      subpath: z.string().optional().describe("Relative subfolder to search, default root"),
    },
    async ({ query, subpath }) => {
      logEvent("tool.search_files.start", { ...authContext, query, subpath: subpath || "" });
      const matches = await ops.searchFiles(query, subpath);
      logEvent("tool.search_files.ok", { ...authContext, query, matchCount: matches.length });
      const text = matches.length ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") : "(no matches)";
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "fetch_url_to_file",
    "Download a URL's text content and save it into the Master Hive store",
    {
      url: z.string().url().describe("URL to fetch"),
      filepath: z.string().describe("Relative path to save the content to"),
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
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      await ops.writeFile(filepath, buf.toString("utf-8"));
      logEvent("file.change.write", { ...authContext, source: "mcp_tool_fetch_url", filepath, bytes: buf.length, url });
      return { content: [{ type: "text", text: `Saved ${buf.length} bytes from ${url} to ${filepath}` }] };
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

app.get("/api/ping", (req, res) => res.json({ ok: true, name: "master-hive" }));

app.use("/api", async (req, res, next) => {
  if (req.path === "/ping") return next();
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

// Raw binary body, path given as a query param (browsers set Content-Type to
// the file's own mime type on upload, so accept any content-type here).
app.post("/api/upload", express.raw({ type: () => true, limit: "2gb" }), async (req, res) => {
  try {
    await ops.writeFile(req.query.path, req.body);
    logEvent("file.change.upload", { ...requestContext(req), source: "rest_api", path: req.query.path, bytes: req.body.length });
    res.json({ ok: true, bytes: req.body.length });
  } catch (err) {
    logError("api.upload.failed", err, { ...requestContext(req), path: req.query.path });
    res.status(400).json({ error: err.message });
  }
});

// Read-only summary of connected MCP clients (Claude/ChatGPT DCR registrations
// + which accounts hold a refresh token) - no secrets included.
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

