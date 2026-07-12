import fs from "node:fs";
import { spawnSync } from "node:child_process";

const serverPath = "server.js";
const backupPath = "server.js.before-startup-ui";
let source = fs.readFileSync(serverPath, "utf8").replace(/^\uFEFF/, "");

if (source.includes("ORBITFS_STARTUP_UI_V1")) {
  console.log("Startup/UI migration is already applied.");
  process.exit(0);
}

function replaceRequired(label, pattern, replacement) {
  if (!pattern.test(source)) {
    throw new Error(`Could not locate ${label}; server.js was left unchanged.`);
  }
  source = source.replace(pattern, replacement);
}

replaceRequired(
  "mammoth import",
  /import mammoth from "mammoth";/,
  `import mammoth from "mammoth";

// ORBITFS_STARTUP_UI_V1
const ORBITFS_WIDGET_URI = "ui://widget/orbitfs-startup-v1.html";
const ORBITFS_WIDGET_HTML = await fs.readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "app/widget/index.html"),
  "utf8"
);`
);

replaceRequired(
  "mandatory startup matcher",
  /function isMandatoryStartupFile\(filepath\) \{[\s\S]*?\n\}/,
  `const REQUIRED_MASTER_PROFILE_FILES = new Set([
  "luke_kerim_master_profile.docx",
  "laura_woods_master_profile.docx",
]);

function isMandatoryStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const basename = path.basename(normalized);
  return (
    normalized.startsWith("0. core/master logs/") ||
    basename === "mental_health_profiles_core.docx" ||
    REQUIRED_MASTER_PROFILE_FILES.has(basename)
  );
}

function isVisibleStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath);
  return normalized && !normalized.toLowerCase().startsWith("_system/");
}`
);

replaceRequired(
  "startup resource insertion point",
  /  server\.tool\(\n    "list_files",/,
  `  server.registerResource(
    "orbitfs-startup-ui",
    ORBITFS_WIDGET_URI,
    {
      title: "OrbitFS",
      description: "OrbitFS startup context and file browser",
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": "Shows the active OrbitFS project, load strength, loaded files, search, and folder browsing controls.",
      },
    },
    async () => ({
      contents: [{
        uri: ORBITFS_WIDGET_URI,
        mimeType: "text/html;profile=mcp-app",
        text: ORBITFS_WIDGET_HTML,
      }],
    })
  );

  server.tool(
    "list_files",`
);

replaceRequired(
  "startup tool",
  /  server\.tool\(\n    "startup_firestorm",[\s\S]*?\n  \);\n\n  server\.tool\(\n    "move_to_trash",/,
  `  server.registerTool(
    "startup",
    {
      title: "Start OrbitFS project",
      description: "Use this when the user types /startup <project> <loadstrength>. Loads OrbitFS project context and shows the working files loaded into the chat.",
      inputSchema: {
        project: z.string().describe("Master, Court, Mental, Media, or combined with ':' such as Court:Mental"),
        loadstrength: z.enum(["low", "med", "high"]).optional().describe("low, med, or high; default med"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        ui: { resourceUri: ORBITFS_WIDGET_URI },
        "openai/outputTemplate": ORBITFS_WIDGET_URI,
        "openai/toolInvocation/invoking": "Loading OrbitFS project…",
        "openai/toolInvocation/invoked": "OrbitFS project loaded",
      },
    },
    async ({ project, loadstrength }) => {
      const strength = loadstrength || "med";
      logEvent("tool.startup.start", { ...authContext, project, loadstrength: strength });
      const internalText = await buildFirestormStartup(project, strength, authContext);

      const marker = "Working files loaded into context:";
      const workingSection = internalText.includes(marker)
        ? internalText.split(marker)[1].split("Reply to the user with ONLY")[0]
        : "";
      const visibleLoadedFiles = [...workingSection.matchAll(/^===== (.+?) =====$/gm)]
        .map((match) => match[1])
        .filter(isVisibleStartupFile)
        .map((filepath) => ({
          path: filepath,
          status: "loaded",
          truncated: false,
        }));
      const projects = parseStartupProjects(project);
      const structuredContent = {
        projects,
        loadstrength: strength,
        visibleLoadedFiles,
        loadedFileCount: visibleLoadedFiles.length,
        truncatedFileCount: 0,
        totalCharactersLoaded: internalText.length,
        deferredMasterProfiles: true,
      };
      const visibleText = [
        projects.join(" + ") + " active",
        "Load strength: " + strength,
        "",
        "Loaded into this chat:",
        ...(visibleLoadedFiles.length
          ? visibleLoadedFiles.map((item) => "✓ " + item.path)
          : ["(no working files loaded)"]),
        "",
        "Other Master Profiles deferred until needed.",
      ].join("\\n");

      return {
        structuredContent,
        content: [{
          type: "text",
          text: internalText + "\\n\\n[VISIBLE STARTUP RESULT]\\n" + visibleText,
        }],
      };
    }
  );

  server.tool(
    "move_to_trash",`
);

replaceRequired(
  "startup prompt",
  /  toolPrompt\(\n    "startup",[\s\S]*?\n  \);\n\n  toolPrompt\(\n    "list",/,
  `  toolPrompt(
    "startup",
    "Load OrbitFS project startup context",
    {
      project: z.string().describe("Master, Court, Mental, Media, or combined with ':' such as Court:Mental"),
      loadstrength: z.enum(["low", "med", "high"]).optional().describe("low, med, or high; default med"),
    },
    "startup",
    "Show the working files loaded into the chat. Never display _system files or mention the file index."
  );

  toolPrompt(
    "list",`
);

if (source.includes('"startup_firestorm"') || source.includes("load_level")) {
  throw new Error("Old startup tool name or parameter remains; server.js was left unchanged.");
}

if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(serverPath, backupPath);
}
fs.writeFileSync(serverPath, source, "utf8");

const check = spawnSync(process.execPath, ["--check", serverPath], {
  stdio: "inherit",
});
if (check.status !== 0) {
  fs.copyFileSync(backupPath, serverPath);
  throw new Error("Syntax validation failed. Original server.js was restored.");
}

console.log("Applied OrbitFS startup command and ChatGPT UI migration successfully.");
console.log("Backup: " + backupPath);
