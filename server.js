import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GENERATED = path.join(DIR, ".orbitfs-runtime-server-v4.mjs");
const SOURCE_URL = "https://raw.githubusercontent.com/lucaskerim123/OrbitFS-MCP/57a6394434be4db41bbec083dc6e7c9e98d4b36f/server.js";
const PATCH_VERSION = "orbitfs-startup-ui-v4";
const lines = (...items) => items.join("\n");

function mustReplace(source, label, pattern, replacement) {
  if (!pattern.test(source)) throw new Error("Patch target not found: " + label);
  return source.replace(pattern, replacement);
}

async function buildRuntimeServer() {
  let cached = "";
  try { cached = await fs.readFile(GENERATED, "utf8"); } catch {}
  if (cached.includes("// " + PATCH_VERSION)) return;

  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error("Could not fetch base server: " + response.status + " " + response.statusText);
  let source = (await response.text()).replace(/^\uFEFF/, "");

  source = source.replace(
    'import mammoth from "mammoth";',
    lines(
      'import mammoth from "mammoth";',
      '',
      '// ' + PATCH_VERSION,
      'const ORBITFS_WIDGET_URI = "ui://widget/orbitfs-v4.html";',
      'const ORBITFS_WIDGET_HTML = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "app/widget/index.html"), "utf8");'
    )
  );

  source = mustReplace(
    source,
    "mandatory startup matcher",
    /function isMandatoryStartupFile\(filepath\) \{[\s\S]*?\n\}/,
    lines(
      'const REQUIRED_MASTER_PROFILE_FILES = new Set(["luke_kerim_master_profile.docx", "laura_woods_master_profile.docx"]);',
      'function isMandatoryStartupFile(filepath) {',
      '  const normalized = normalizeRelativePath(filepath).toLowerCase();',
      '  const basename = path.basename(normalized);',
      '  return normalized.startsWith("0. core/master logs/") || basename === "mental_health_profiles_core.docx" || REQUIRED_MASTER_PROFILE_FILES.has(basename);',
      '}',
      'function isVisibleStartupFile(filepath) {',
      '  const normalized = normalizeRelativePath(filepath);',
      '  return normalized && !normalized.toLowerCase().startsWith("_system/");',
      '}'
    )
  );

  source = source.replace(
    '  const totalCap = STARTUP_CONTEXT_TOTAL_CHAR_CAP[load];\n  const perFileCap = STARTUP_CONTEXT_FILE_CHAR_CAP[load];',
    lines(
      '  const totalCap = STARTUP_CONTEXT_TOTAL_CHAR_CAP[load];',
      '  const perFileCap = STARTUP_CONTEXT_FILE_CHAR_CAP[load];',
      '  const mandatoryTotalCap = 1500000;',
      '  const mandatoryPerFileCap = 300000;'
    )
  );

  source = source.replace(
    lines(
      '      const remaining = totalCap - totalChars;',
      '      const content = data.slice(0, Math.min(perFileCap, remaining));',
      '      totalChars += content.length;',
      '      files.push({ filepath, content, chars: data.length, truncated: content.length < data.length });',
      '      if (totalChars >= totalCap) break;'
    ),
    lines(
      '      const mandatoryFile = isMandatoryStartupFile(filepath);',
      '      const normalChars = files.filter((item) => !item.mandatory).reduce((sum, item) => sum + (item.content?.length || 0), 0);',
      '      const mandatoryChars = files.filter((item) => item.mandatory).reduce((sum, item) => sum + (item.content?.length || 0), 0);',
      '      const remaining = mandatoryFile ? Math.max(0, mandatoryTotalCap - mandatoryChars) : Math.max(0, totalCap - normalChars);',
      '      const cap = mandatoryFile ? mandatoryPerFileCap : perFileCap;',
      '      const content = data.slice(0, Math.min(cap, remaining));',
      '      totalChars += content.length;',
      '      files.push({ filepath, content, chars: data.length, truncated: content.length < data.length, mandatory: mandatoryFile });'
    )
  );

  const resourceCode = lines(
    '  server.registerResource(',
    '    "orbitfs-ui",',
    '    ORBITFS_WIDGET_URI,',
    '    {',
    '      title: "OrbitFS",',
    '      description: "Interactive OrbitFS startup and file browser",',
    '      mimeType: "text/html;profile=mcp-app",',
    '      _meta: {',
    '        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },',
    '        "openai/widgetDescription": "Shows the active OrbitFS project, loaded working files, startup status, search, and folder browsing controls."',
    '      }',
    '    },',
    '    async () => ({ contents: [{ uri: ORBITFS_WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: ORBITFS_WIDGET_HTML }] })',
    '  );',
    ''
  );
  source = source.replace('  server.tool(\n    "list_files",', resourceCode + '  server.tool(\n    "list_files",');

  const startupTool = lines(
    '  server.registerTool(',
    '    "startup",',
    '    {',
    '      title: "Start OrbitFS project",',
    '      description: "Use this when the user types /startup <project> <loadstrength>. Loads required OrbitFS context and shows the working files loaded into the chat.",',
    '      inputSchema: {',
    '        project: z.string().describe("Master, Court, Mental, Media, or combined with : such as Court:Mental"),',
    '        loadstrength: z.enum(["low", "med", "high"]).optional().describe("low, med, or high; default med")',
    '      },',
    '      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },',
    '      _meta: {',
    '        ui: { resourceUri: ORBITFS_WIDGET_URI },',
    '        "openai/outputTemplate": ORBITFS_WIDGET_URI,',
    '        "openai/toolInvocation/invoking": "Loading OrbitFS project…",',
    '        "openai/toolInvocation/invoked": "OrbitFS project loaded"',
    '      }',
    '    },',
    '    async ({ project, loadstrength }) => {',
    '      const strength = loadstrength || "med";',
    '      logEvent("tool.startup.start", { ...authContext, project, loadstrength: strength });',
    '      const internalText = await buildFirestormStartup(project, strength, authContext);',
    '      const marker = "Working files loaded into context:";',
    '      const section = internalText.includes(marker) ? internalText.split(marker)[1].split("Reply to the user with ONLY")[0] : "";',
    '      const paths = [...section.matchAll(/^===== (.+?) =====$/gm)].map((match) => match[1]).filter(isVisibleStartupFile);',
    '      const visibleLoadedFiles = paths.map((filepath) => ({ path: filepath, status: "loaded", truncated: false }));',
    '      const projects = parseStartupProjects(project);',
    '      const structuredContent = { projects, loadstrength: strength, visibleLoadedFiles, loadedFileCount: visibleLoadedFiles.length, truncatedFileCount: 0, totalCharactersLoaded: internalText.length, deferredMasterProfiles: true };',
    '      const visibleText = [',
    '        projects.join(" + ") + " active",',
    '        "Load strength: " + strength,',
    '        "",',
    '        "Loaded into this chat:",',
    '        ...(visibleLoadedFiles.length ? visibleLoadedFiles.map((item) => "✓ " + item.path) : ["(no working files loaded)"]),',
    '        "",',
    '        "Other Master Profiles deferred until needed."',
    '      ].join("\\n");',
    '      return { structuredContent, content: [{ type: "text", text: internalText + "\\n\\n[VISIBLE STARTUP RESULT]\\n" + visibleText }] };',
    '    }',
    '  );',
    ''
  );
  source = mustReplace(
    source,
    "startup tool",
    /  server\.tool\(\n    "startup_firestorm",[\s\S]*?\n  \);\n\n  server\.tool\(\n    "move_to_trash",/,
    startupTool + '  server.tool(\n    "move_to_trash",'
  );

  const startupPrompt = lines(
    '  toolPrompt(',
    '    "startup",',
    '    "Load OrbitFS project startup context",',
    '    {',
    '      project: z.string().describe("Master, Court, Mental, Media, or combined with : such as Court:Mental"),',
    '      loadstrength: z.enum(["low", "med", "high"]).optional().describe("low, med, or high; default med")',
    '    },',
    '    "startup",',
    '    "Show the working files loaded into the chat. Never display _system files or mention the file index."',
    '  );',
    ''
  );
  source = mustReplace(
    source,
    "startup prompt",
    /  toolPrompt\(\n    "startup",[\s\S]*?\n  \);\n\n  toolPrompt\(\n    "list",/,
    startupPrompt + '  toolPrompt(\n    "list",'
  );

  if (source.includes('"startup_firestorm"') || source.includes("load_level")) throw new Error("Old startup command remains after patch");
  await fs.writeFile(GENERATED, source, "utf8");
}

await buildRuntimeServer();
await import(pathToFileURL(GENERATED).href + "?v=" + PATCH_VERSION);
