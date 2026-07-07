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
import { mountOAuth, getOAuthState } from "./oauth.js";

const ROOT = process.env.HIVE_ROOT;
const API_KEY = process.env.HIVE_API_KEY;
const PORT = process.env.PORT || 3939;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const SECRET_KEY = new TextEncoder().encode(process.env.SESSION_SECRET);

function safeResolve(rel) {
  const full = path.resolve(ROOT, rel || ".");
  if (!full.startsWith(path.resolve(ROOT))) {
    throw new Error("Path escapes the Master Hive root");
  }
  return full;
}

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.slice(2).swap16().toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf-8");
  }
  return buf.toString("utf-8");
}

async function listRecursive(dir, base) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let lines = [];
  for (const e of entries) {
    const rel = path.join(base, e.name);
    if (e.isDirectory()) {
      lines.push(`[DIR] ${rel}`);
      lines = lines.concat(await listRecursive(path.join(dir, e.name), rel));
    } else {
      lines.push(`[FILE] ${rel}`);
    }
  }
  return lines;
}

// Recursive listing with size/mtime/sha256 per file, used by the web panel's
// PC<->VPS sync (and generally as a "what's actually in here" manifest).
async function listManifest(dir, base) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let out = [];
  for (const e of entries) {
    const rel = path.join(base, e.name).split(path.sep).join("/");
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out = out.concat(await listManifest(full, rel));
    } else {
      const buf = await fs.readFile(full);
      const stat = await fs.stat(full);
      out.push({
        path: rel,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      });
    }
  }
  return out;
}

function buildServer() {
  const server = new McpServer({ name: "master-hive", version: "1.0.0" });

  server.tool(
    "list_files",
    "List files and folders in the Master Hive store",
    {
      subpath: z.string().optional().describe("Relative subfolder, default root"),
      recursive: z.boolean().optional().describe("List all nested contents, not just top level"),
    },
    async ({ subpath, recursive }) => {
      const dir = safeResolve(subpath);
      if (recursive) {
        const lines = await listRecursive(dir, subpath || "");
        return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }] };
      }
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const listing = entries
        .map((e) => (e.isDirectory() ? "[DIR] " : "[FILE] ") + e.name)
        .join("\n");
      return { content: [{ type: "text", text: listing || "(empty)" }] };
    }
  );

  server.tool(
    "read_file",
    "Read a file's contents from the Master Hive store",
    { filepath: z.string().describe("Relative path to the file") },
    async ({ filepath }) => {
      const full = safeResolve(filepath);
      const buf = await fs.readFile(full);
      return { content: [{ type: "text", text: decodeText(buf) }] };
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
      const full = safeResolve(filepath);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
      return {
        content: [{ type: "text", text: `Wrote ${content.length} chars to ${filepath}` }],
      };
    }
  );

  server.tool(
    "delete_file",
    "Delete a file from the Master Hive store",
    { filepath: z.string().describe("Relative path to the file") },
    async ({ filepath }) => {
      const full = safeResolve(filepath);
      await fs.unlink(full);
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
      const src = safeResolve(from);
      const dest = safeResolve(to);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      return { content: [{ type: "text", text: `Moved ${from} -> ${to}` }] };
    }
  );

  return server;
}

const app = express();

mountOAuth(app, {
  publicBaseUrl: PUBLIC_BASE_URL,
  cfAuthEndpoint: process.env.CF_AUTHORIZE_URL,
  cfTokenEndpoint: process.env.CF_TOKEN_URL,
  cfClientId: process.env.CF_CLIENT_ID,
  cfClientSecret: process.env.CF_CLIENT_SECRET,
  secretKey: SECRET_KEY,
});

app.use(express.json());

async function checkAuth(req) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  if (token === API_KEY) return true;
  try {
    const { payload } = await jwtVerify(token, SECRET_KEY, {
      issuer: PUBLIC_BASE_URL,
      audience: `${PUBLIC_BASE_URL}/mcp`,
    });
    return !!payload;
  } catch (err) {
    console.error("JWT verification failed:", err.message);
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
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// --- REST API for the Master Brain web panel ---------------------------
// Same underlying file store as the MCP tools above, same HIVE_API_KEY
// bearer auth, just a plain REST shape the panel's browser JS can call
// directly (upload/download need raw bytes, which doesn't map cleanly onto
// MCP tool calls over JSON-RPC).

app.get("/api/ping", (req, res) => res.json({ ok: true }));

app.use("/api", async (req, res, next) => {
  if (req.path === "/ping") return next();
  const ok = await checkAuth(req);
  if (!ok) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/api/manifest", async (req, res) => {
  try {
    const files = await listManifest(safeResolve(""), "");
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/files", async (req, res) => {
  try {
    const dir = safeResolve(req.query.subpath);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const withStats = await Promise.all(
      entries.map(async (e) => {
        if (e.isDirectory()) return { name: e.name, type: "dir" };
        const stat = await fs.stat(path.join(dir, e.name));
        return { name: e.name, type: "file", size: stat.size, mtime: stat.mtime.toISOString() };
      })
    );
    res.json({ entries: withStats });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const full = safeResolve(req.query.path);
    const buf = await fs.readFile(full);
    res.json({ content: decodeText(buf) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/file", async (req, res) => {
  try {
    const full = safeResolve(req.body.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, req.body.content ?? "", "utf-8");
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/file", async (req, res) => {
  try {
    const full = safeResolve(req.query.path);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      await fs.rm(full, { recursive: true, force: true });
    } else {
      await fs.unlink(full);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/move", async (req, res) => {
  try {
    const src = safeResolve(req.body.from);
    const dest = safeResolve(req.body.to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/mkdir", async (req, res) => {
  try {
    const full = safeResolve(req.body.path);
    await fs.mkdir(full, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const full = safeResolve(req.query.path);
    res.download(full, path.basename(full));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Raw binary body, path given as a query param (browsers set Content-Type to
// the file's own mime type on upload, so accept any content-type here).
app.post("/api/upload", express.raw({ type: () => true, limit: "2gb" }), async (req, res) => {
  try {
    const full = safeResolve(req.query.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, req.body);
    res.json({ ok: true, bytes: req.body.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Read-only summary of connected MCP clients (Claude/ChatGPT DCR registrations
// + which accounts hold a refresh token) - no secrets included.
app.get("/api/oauth-state", (req, res) => {
  res.json(getOAuthState());
});

app.listen(PORT, () => {
  console.log(`Master Hive MCP server listening on :${PORT}`);
});
