import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GENERATED = path.join(DIR, ".orbitfs-runtime-server.mjs");
const SOURCE_URL = "https://raw.githubusercontent.com/lucaskerim123/OrbitFS-MCP/57a6394434be4db41bbec083dc6e7c9e98d4b36f/server.js";
const PATCH_VERSION = "orbitfs-startup-ui-v3";

function replaceOnce(source, label, before, after) {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(before, after);
}

async function buildRuntimeServer() {
  let cached = "";
  try { cached = await fs.readFile(GENERATED, "utf8"); } catch {}
  if (cached.includes(`// ${PATCH_VERSION}`)) return;

  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`Could not fetch base server: ${response.status} ${response.statusText}`);
  let source = await response.text();

  source = source.replace(/^\uFEFF/, "");
  source = source.replace('import mammoth from "mammoth";', 'import mammoth from "mammoth";\n\n// ' + PATCH_VERSION + '\nconst ORBITFS_WIDGET_URI = "ui://widget/orbitfs-v3.html";\nconst ORBITFS_WIDGET_HTML = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "app/widget/index.html"), "utf8");');

  source = replaceOnce(source, "mandatory matcher",
`function isMandatoryStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) || "";
  const inMasterLogs = normalized.startsWith("0. core/master logs/");
  const isProfilesQuickView = /^mental[\\s_-]*health[\\s_-]*profiles[\\s_-]*core\\.docx$/.test(basename);
  const inMasterProfiles = parts.slice(0, -1).some((part) => part === "master profiles");
  const isLukeOrLaura = /(^|[^a-z])luke([^a-z]|$)/.test(basename) || /(^|[^a-z])laura([^a-z]|$)/.test(basename);
  return inMasterLogs || isProfilesQuickView || (inMasterProfiles && isLukeOrLaura);
}`,
`const REQUIRED_MASTER_PROFILE_FILES = new Set(["luke_kerim_master_profile.docx", "laura_woods_master_profile.docx"]);
function isMandatoryStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const basename = path.basename(normalized);
  return normalized.startsWith("0. core/master logs/") || basename === "mental_health_profiles_core.docx" || REQUIRED_MASTER_PROFILE_FILES.has(basename);
}
function isVisibleStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath);
  return normalized && !normalized.toLowerCase().startsWith("_system/");
}`);

  source = replaceOnce(source, "startup loader caps",
`  const totalCap = STARTUP_CONTEXT_TOTAL_CHAR_CAP[load];
  const perFileCap = STARTUP_CONTEXT_FILE_CHAR_CAP[load];`,
`  const totalCap = STARTUP_CONTEXT_TOTAL_CHAR_CAP[load];
  const perFileCap = STARTUP_CONTEXT_FILE_CHAR_CAP[load];
  const mandatoryTotalCap = 1500000;
  const mandatoryPerFileCap = 300000;`);

  source = replaceOnce(source, "startup selected loop",
`      const remaining = totalCap - totalChars;
      const content = data.slice(0, Math.min(perFileCap, remaining));
      totalChars += content.length;
      files.push({ filepath, content, chars: data.length, truncated: content.length < data.length });
      if (totalChars >= totalCap) break;`,
`      const mandatoryFile = isMandatoryStartupFile(filepath);
      const normalChars = files.filter((item) => !item.mandatory).reduce((sum, item) => sum + (item.content?.length || 0), 0);
      const mandatoryChars = files.filter((item) => item.mandatory).reduce((sum, item) => sum + (item.content?.length || 0), 0);
      const remaining = mandatoryFile ? Math.max(0, mandatoryTotalCap - mandatoryChars) : Math.max(0, totalCap - normalChars);
      const cap = mandatoryFile ? mandatoryPerFileCap : perFileCap;
      const content = data.slice(0, Math.min(cap, remaining));
      totalChars += content.length;
      files.push({ filepath, content, chars: data.length, truncated: content.length < data.length, mandatory: mandatoryFile });`);

  source = replaceOnce(source, "server UI resource injection",
`  });

  server.tool(
    "list_files",`,
`  });

  server.registerResource(
    "orbitfs-ui",
    ORBITFS_WIDGET_URI,
    {
      title: "OrbitFS",
      description: "Interactive OrbitFS startup and file browser",
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "Shows the active OrbitFS project, loaded working files, startup status, search, and folder browsing controls."
      }
    },
    async () => ({ contents: [{ uri: ORBITFS_WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: ORBITFS_WIDGET_HTML }] })
  );

  server.tool(
    "list_files",`);

  source = replaceOnce(source, "startup tool",
`  server.tool(
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
  );`,
`  server.registerTool(
    "startup",
    {
      title: "Start OrbitFS project",
      description: "Use this when the user types /startup <project> <loadstrength>. Loads required OrbitFS context and shows the working files loaded into the chat.",
      inputSchema: {
        project: z.string().describe("Master, Court, Mental, Media, or combined with ':' such as Court:Mental"),
        loadstrength: z.enum(["low", "med", "high"]).optional().describe("low, med, or high; default med")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      _meta: {
        ui: { resourceUri: ORBITFS_WIDGET_URI },
        "openai/outputTemplate": ORBITFS_WIDGET_URI,
        "openai/toolInvocation/invoking": "Loading OrbitFS project…",
        "openai/toolInvocation/invoked": "OrbitFS project loaded"
      }
    },
    async ({ project, loadstrength }) => {
      const strength = loadstrength || "med";
      logEvent("tool.startup.start", { ...authContext, project, loadstrength: strength });
      const internalText = await buildFirestormStartup(project, strength, authContext);
      const marker = "Working files loaded into context:";
      const section = internalText.includes(marker) ? internalText.split(marker)[1].split("Reply to the user with ONLY")[0] : "";
      const paths = [...section.matchAll(/^===== (.+?) =====$/gm)].map((match) => match[1]).filter(isVisibleStartupFile);
      const visibleLoadedFiles = paths.map((filepath) => ({ path: filepath, status: "loaded", truncated: false }));
      const structuredContent = {
        projects: parseStartupProjects(project),
        loadstrength: strength,
        visibleLoadedFiles,
        loadedFileCount: visibleLoadedFiles.length,
        truncatedFileCount: 0,
        totalCharactersLoaded: internalText.length,
        deferredMasterProfiles: true
      };
      const visibleText = [
        `${structuredContent.projects.join(" + ")} active`,
        `Load strength: ${strength}`,
        "",
        "Loaded into this chat:",
        ...(visibleLoadedFiles.length ? visibleLoadedFiles.map((item) => `✓ ${item.path}`) : ["(no working files loaded)"]),
        "",
        "Other Master Profiles deferred until needed."
      ].join("\\n");
      return { structuredContent, content: [{ type: "text", text: `${internalText}\\n\\n[VISIBLE STARTUP RESULT]\\n${visibleText}` }] };
    }
  );`);

  source = replaceOnce(source, "startup prompt",
`  toolPrompt(
    "startup",
    "Load Project FireStorm startup context for one or more projects",
    {
      project: z.string().describe("Master, Court, Mental, Media, or combined with ':' e.g. Court:Mental"),
      load_level: z.string().optional().describe("low, med, high (default med). Aliases: light, normal, full"),
    },
    "startup_firestorm",
    "Reply following the startup contract (normalized command, files loaded, active rules, in-scope folders, confirmation line)."
  );`,
`  toolPrompt(
    "startup",
    "Load OrbitFS project startup context",
    {
      project: z.string().describe("Master, Court, Mental, Media, or combined with ':' such as Court:Mental"),
      loadstrength: z.enum(["low", "med", "high"]).optional().describe("low, med, or high; default med")
    },
    "startup",
    "Show the working files loaded into the chat. Never display _system files or mention the file index."
  );`);

  if (source.includes('"startup_firestorm"') || source.includes("load_level")) throw new Error("Old startup command remains after patch");
  await fs.writeFile(GENERATED, source, "utf8");
}

await buildRuntimeServer();
await import(`${pathToFileURL(GENERATED).href}?v=${PATCH_VERSION}`);
