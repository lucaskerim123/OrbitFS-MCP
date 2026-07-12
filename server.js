import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_URI = "ui://widget/orbitfs-startup-v2.html";
const WIDGET_HTML = await fs.readFile(path.join(SERVER_DIR, "app/widget/index.html"), "utf8");
const originalTool = McpServer.prototype.tool;
const resourceRegistered = new WeakSet();
const DEFAULT_PUBLIC_ORIGIN = "https://mcp.incendiarynetworks.cc";

function getWidgetDomain() {
  const configured = process.env.ORBITFS_WIDGET_DOMAIN || process.env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_ORIGIN;
  const url = new URL(configured);
  if (url.protocol !== "https:") {
    throw new Error("OrbitFS widget domain must use HTTPS.");
  }
  return url.origin;
}

function visibleStartupResult(text, project, loadstrength) {
  const marker = "Working files loaded into context:";
  const section = text.includes(marker)
    ? text.split(marker)[1].split("Reply to the user with ONLY")[0]
    : "";
  const files = [...section.matchAll(/^===== (.+?) =====$/gm)]
    .map((match) => match[1])
    .filter((filepath) => !String(filepath).replace(/\\/g, "/").toLowerCase().startsWith("_system/"))
    .map((filepath) => ({ path: filepath, status: "loaded", truncated: false }));
  const projects = String(project || "Master").split(":").map((value) => value.trim()).filter(Boolean);
  return {
    projects,
    loadstrength,
    visibleLoadedFiles: files,
    loadedFileCount: files.length,
    truncatedFileCount: 0,
    totalCharactersLoaded: text.length,
    deferredMasterProfiles: true,
  };
}

function registerWidget(server) {
  if (resourceRegistered.has(server)) return;
  resourceRegistered.add(server);

  const widgetDomain = getWidgetDomain();
  const widgetMeta = {
    ui: {
      prefersBorder: true,
      domain: widgetDomain,
      csp: {
        connectDomains: [widgetDomain],
        resourceDomains: [widgetDomain],
      },
    },
    "openai/widgetDescription": "Shows the active OrbitFS project, load strength, loaded files, search, and folder browsing controls.",
    "openai/widgetPrefersBorder": true,
  };

  server.registerResource(
    "orbitfs-startup-ui",
    WIDGET_URI,
    {
      title: "The Hive",
      description: "OrbitFS startup context and file browser by IncendiaryNetwork",
      mimeType: "text/html;profile=mcp-app",
      _meta: widgetMeta,
    },
    async () => ({
      contents: [{
        uri: WIDGET_URI,
        mimeType: "text/html;profile=mcp-app",
        text: WIDGET_HTML,
        _meta: widgetMeta,
      }],
    })
  );
}

McpServer.prototype.tool = function patchedTool(name, description, schema, handler) {
  registerWidget(this);
  if (name !== "startup_firestorm") {
    return originalTool.call(this, name, description, schema, handler);
  }

  return this.registerTool(
    "startup",
    {
      title: "Start The Hive project",
      description: "Use this when the user types /startup <project> <loadstrength>. Loads OrbitFS project context and shows the working files loaded into the chat.",
      inputSchema: {
        project: z.string().describe("Master, Court, Mental, Media, or combined with ':' such as Court:Mental"),
        loadstrength: z.enum(["low", "med", "high"]).optional().describe("low, med, or high; default med"),
      },
      outputSchema: {
        projects: z.array(z.string()),
        loadstrength: z.enum(["low", "med", "high"]),
        visibleLoadedFiles: z.array(z.object({
          path: z.string(),
          status: z.string(),
          truncated: z.boolean(),
        })),
        loadedFileCount: z.number(),
        truncatedFileCount: z.number(),
        totalCharactersLoaded: z.number(),
        deferredMasterProfiles: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/outputTemplate": WIDGET_URI,
        "openai/toolInvocation/invoking": "Loading The Hive project…",
        "openai/toolInvocation/invoked": "The Hive project loaded",
      },
    },
    async ({ project, loadstrength }) => {
      const strength = loadstrength || "med";
      const result = await handler({ project, load_level: strength });
      const text = (result?.content || []).map((item) => item?.text || "").join("\n");
      return {
        ...result,
        structuredContent: visibleStartupResult(text, project, strength),
      };
    }
  );
};

await import("./server-core.js");
