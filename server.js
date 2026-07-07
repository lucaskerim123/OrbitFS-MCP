import "dotenv/config";
import express from "express";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { jwtVerify } from "jose";
import { mountOAuth } from "./oauth.js";
import { makeOps } from "./hive-ops.js";

const ROOT = process.env.HIVE_ROOT;
const API_KEY = process.env.HIVE_API_KEY;
const PORT = process.env.PORT || 3939;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const SECRET_KEY = new TextEncoder().encode(process.env.SESSION_SECRET);
const FETCH_MAX_BYTES = 10 * 1024 * 1024;

const ops = makeOps(ROOT);

function buildServer() {
  const server = new McpServer({ name: "master-hive", version: "1.0.0" });

  server.tool(
    "list_files",
    "List files and folders in the Master Hive store",
    { subpath: z.string().optional().describe("Relative subfolder, default root") },
    async ({ subpath }) => {
      const entries = await ops.listFiles(subpath);
      const listing = entries
        .map((e) => (e.type === "dir" ? "[DIR] " : "[FILE] ") + e.name)
        .join("\n");
      return { content: [{ type: "text", text: listing || "(empty)" }] };
    }
  );

  server.tool(
    "read_file",
    "Read a file's contents from the Master Hive store",
    { filepath: z.string().describe("Relative path to the file") },
    async ({ filepath }) => {
      const data = await ops.readFile(filepath);
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
      await ops.writeFile(filepath, content);
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
      await ops.deleteFile(filepath);
      return { content: [{ type: "text", text: `Deleted ${filepath}` }] };
    }
  );

  server.tool(
    "move_file",
    "Move or rename a file within the Master Hive store",
    {
      from: z.string().describe("Relative path to the source file"),
      to: z.string().describe("Relative path to the destination"),
    },
    async ({ from, to }) => {
      await ops.moveFile(from, to);
      return { content: [{ type: "text", text: `Moved ${from} -> ${to}` }] };
    }
  );

  server.tool(
    "mkdir",
    "Create a folder (and any missing parent folders) in the Master Hive store",
    { subpath: z.string().describe("Relative folder path to create") },
    async ({ subpath }) => {
      await ops.makeDir(subpath);
      return { content: [{ type: "text", text: `Created folder ${subpath}` }] };
    }
  );

  server.tool(
    "stat_file",
    "Get size, modified time, and sha256 hash of a file in the Master Hive store",
    { filepath: z.string().describe("Relative path to the file") },
    async ({ filepath }) => {
      const info = await ops.statFile(filepath);
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
      const matches = await ops.searchFiles(query, subpath);
      const text = matches.length
        ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n")
        : "(no matches)";
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
      const resp = await fetch(url, { redirect: "follow" });
      if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > FETCH_MAX_BYTES) {
        throw new Error(`Response too large (${buf.length} bytes, max ${FETCH_MAX_BYTES})`);
      }
      await ops.writeFile(filepath, buf.toString("utf-8"));
      return { content: [{ type: "text", text: `Saved ${buf.length} bytes from ${url} to ${filepath}` }] };
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

// Unauthenticated liveness check, used by the panel/sync engine to detect whether
// this node is reachable at all before attempting authenticated calls.
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, name: "master-hive" });
});

app.use("/api", async (req, res, next) => {
  const ok = await checkAuth(req);
  if (!ok) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/api/manifest", async (req, res) => {
  try {
    res.json({ files: await ops.manifest() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/files", async (req, res) => {
  try {
    res.json({ entries: await ops.listFiles(req.query.subpath) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    res.json({ content: await ops.readFile(req.query.path) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/file", async (req, res) => {
  try {
    await ops.writeFile(req.body.path, req.body.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/file", async (req, res) => {
  try {
    await ops.deleteFile(req.query.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/move", async (req, res) => {
  try {
    await ops.moveFile(req.body.from, req.body.to);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Master Hive MCP server listening on :${PORT}`);
});
