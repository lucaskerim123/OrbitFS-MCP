import fs from "node:fs";

const file = "server.js";
let source = fs.readFileSync(file, "utf8");

function replaceOnce(label, before, after) {
  if (!source.includes(before)) {
    throw new Error(`Patch target not found: ${label}`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  "mandatory startup matcher",
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
`const REQUIRED_MASTER_PROFILE_FILES = new Set([
  "luke_kerim_master_profile.docx",
  "laura_woods_master_profile.docx",
]);

function isMandatoryStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const basename = path.basename(normalized);
  const inMasterLogs = normalized.startsWith("0. core/master logs/");
  const isProfilesQuickView = basename === "mental_health_profiles_core.docx";
  const isRequiredMasterProfile = REQUIRED_MASTER_PROFILE_FILES.has(basename);
  return inMasterLogs || isProfilesQuickView || isRequiredMasterProfile;
}`
);

replaceOnce(
  "deferred profile matcher",
`function shouldDeferStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const parts = normalized.split("/");
  const inMasterProfiles = parts.slice(0, -1).some((part) => part === "master profiles");
  return inMasterProfiles && !isMandatoryStartupFile(filepath);
}`,
`function shouldDeferStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const parts = normalized.split("/");
  const inMasterProfiles = parts.slice(0, -1).some((part) => part === "master profiles");
  return inMasterProfiles && !isMandatoryStartupFile(filepath);
}

function isVisibleStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath);
  return normalized && !normalized.toLowerCase().startsWith("_system/");
}`
);

replaceOnce(
  "startup context loader",
`async function loadStartupContextFiles(filepaths, load) {
  const fileLimit = STARTUP_CONTEXT_FILE_LIMIT[load];
  const totalCap = STARTUP_CONTEXT_TOTAL_CHAR_CAP[load];
  const perFileCap = STARTUP_CONTEXT_FILE_CHAR_CAP[load];
  const mandatory = filepaths.filter(isMandatoryStartupFile);
  const normal = filepaths.filter((filepath) => !isMandatoryStartupFile(filepath));
  const selected = [...mandatory, ...(load === "low" ? [] : normal.slice(0, fileLimit))];
  const files = [];
  let totalChars = 0;
  for (let offset = 0; offset < selected.length && totalChars < totalCap; offset += BATCH_READ_MAX_FILES) {
    const batch = selected.slice(offset, offset + BATCH_READ_MAX_FILES);
    for (const filepath of batch) {
      let data;
      try {
        data = await readStartupFile(filepath);
      } catch (err) {
        files.push({ filepath, error: err.message });
        continue;
      }
      const remaining = totalCap - totalChars;
      const content = data.slice(0, Math.min(perFileCap, remaining));
      totalChars += content.length;
      files.push({ filepath, content, chars: data.length, truncated: content.length < data.length });
      if (totalChars >= totalCap) break;
    }
  }
  return {
    files,
    totalChars,
    discoveredCount: filepaths.length,
    selectedCount: selected.length,
    truncated: filepaths.length > selected.length || totalChars >= totalCap,
  };
}`,
`async function loadStartupContextFiles(filepaths, load) {
  const fileLimit = STARTUP_CONTEXT_FILE_LIMIT[load];
  const normalTotalCap = STARTUP_CONTEXT_TOTAL_CHAR_CAP[load];
  const normalPerFileCap = STARTUP_CONTEXT_FILE_CHAR_CAP[load];
  const mandatoryTotalCap = 1_500_000;
  const mandatoryPerFileCap = 300_000;
  const mandatory = filepaths.filter(isMandatoryStartupFile);
  const normal = filepaths.filter((filepath) => !isMandatoryStartupFile(filepath));
  const selected = [...mandatory, ...(load === "low" ? [] : normal.slice(0, fileLimit))];
  const files = [];
  let mandatoryChars = 0;
  let normalChars = 0;

  for (const filepath of selected) {
    let data;
    try {
      data = await readStartupFile(filepath);
    } catch (err) {
      files.push({ filepath, error: err.message });
      continue;
    }

    const mandatoryFile = isMandatoryStartupFile(filepath);
    const remaining = mandatoryFile
      ? Math.max(0, mandatoryTotalCap - mandatoryChars)
      : Math.max(0, normalTotalCap - normalChars);
    const cap = mandatoryFile ? mandatoryPerFileCap : normalPerFileCap;
    const content = data.slice(0, Math.min(cap, remaining));
    if (mandatoryFile) mandatoryChars += content.length;
    else normalChars += content.length;
    files.push({
      filepath,
      content,
      chars: data.length,
      truncated: content.length < data.length,
      mandatory: mandatoryFile,
    });
  }

  return {
    files,
    totalChars: mandatoryChars + normalChars,
    mandatoryChars,
    normalChars,
    discoveredCount: filepaths.length,
    selectedCount: selected.length,
    truncated: files.some((item) => item.truncated) || filepaths.length > selected.length,
  };
}`
);

replaceOnce(
  "startup result builder",
`  const confirmations = projects
    .filter((name) => name !== "Master")
    .map((name) => {
      if (name === "Court") return "Court System active. Startup loaded. Ready.";
      if (name === "Mental") return "Mental Health System active. Startup loaded. Ready.";
      if (name === "Media") return "Media startup loaded. Ready.";
      return "Master startup loaded. Ready.";
    });
  if (projects.length === 1 && projects[0] === "Master") confirmations.push("Master startup loaded. Ready.");

  sections.push("", "Reply to the user with ONLY the following line(s) - no summary of the above:", ...confirmations);
  logEvent("tool.startup_firestorm.ok", {
    ...authContext,
    projects: projects.join(":"),
    load,
    startupFiles: startupFiles.length,
    ruleFiles: ruleFiles.length,
    folders: folders.length,
    discoveredContextFiles: contextLoad.discoveredCount,
    loadedContextFiles: contextLoad.files.length,
    loadedContextChars: contextLoad.totalChars,
  });
  return sections.join("\\n");`,
`  const visibleLoadedFiles = contextLoad.files
    .filter((item) => isVisibleStartupFile(item.filepath))
    .map((item) => ({
      path: item.filepath,
      status: item.error ? "failed" : (item.truncated ? "partial" : "loaded"),
      truncated: !!item.truncated,
      charactersLoaded: item.content?.length || 0,
      originalCharacters: item.chars || 0,
      mandatory: !!item.mandatory,
      error: item.error || null,
    }));
  const visibleLines = visibleLoadedFiles.map((item) => {
    if (item.status === "failed") return `✗ ${item.path} — failed to load`;
    if (item.status === "partial") return `◐ ${item.path} — partially loaded`;
    return `✓ ${item.path}`;
  });
  const confirmation = [
    `${projects.join(" + ")} active`,
    `Load strength: ${load}`,
    "",
    "Loaded into this chat:",
    ...(visibleLines.length ? visibleLines : ["(no working files loaded)"]),
    "",
    "Other Master Profiles deferred until needed.",
    `${visibleLoadedFiles.length} working file${visibleLoadedFiles.length === 1 ? "" : "s"} loaded`,
  ].join("\\n");

  sections.push(
    "",
    "Reply to the user with ONLY the following visible startup result. Never mention or display _system files or the file index:",
    confirmation
  );
  logEvent("tool.startup.ok", {
    ...authContext,
    projects: projects.join(":"),
    loadstrength: load,
    startupFiles: startupFiles.length,
    ruleFiles: ruleFiles.length,
    folders: folders.length,
    discoveredContextFiles: contextLoad.discoveredCount,
    loadedContextFiles: visibleLoadedFiles.length,
    loadedContextChars: contextLoad.totalChars,
  });
  return {
    internalText: sections.join("\\n"),
    structuredContent: {
      projects,
      loadstrength: load,
      visibleLoadedFiles,
      loadedFileCount: visibleLoadedFiles.length,
      truncatedFileCount: visibleLoadedFiles.filter((item) => item.truncated).length,
      failedFileCount: visibleLoadedFiles.filter((item) => item.status === "failed").length,
      totalCharactersLoaded: contextLoad.totalChars,
      deferredMasterProfiles: true,
    },
  };`
);

replaceOnce(
  "startup tool",
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
`  server.tool(
    "startup",
    "Load OrbitFS project startup context into the current chat with /startup <project> <loadstrength>. Always loads every readable file in 0. Core/Master Logs, Mental_health_profiles_core.docx, Luke_Kerim_Master_Profile.docx, and Laura_Woods_Master_Profile.docx. Other Master Profiles remain deferred until needed.",
    {
      project: z.string().describe("Master, Court, Mental, Media, or combined projects separated with ':' such as Court:Mental"),
      loadstrength: z.enum(["low", "med", "high"]).optional().describe("low, med, or high; default med"),
    },
    async ({ project, loadstrength }) => {
      const strength = loadstrength || "med";
      logEvent("tool.startup.start", { ...authContext, project, loadstrength: strength });
      const result = await buildFirestormStartup(project, strength, authContext);
      return {
        structuredContent: result.structuredContent,
        content: [{ type: "text", text: result.internalText }],
      };
    }
  );`
);

replaceOnce(
  "startup prompt",
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
      loadstrength: z.enum(["low", "med", "high"]).optional().describe("low, med, or high; default med"),
    },
    "startup",
    "Show the working files loaded into the chat. Never display _system files or mention the file index."
  );`
);

if (source.includes('"startup_firestorm"') || source.includes("load_level")) {
  throw new Error("Old startup tool name or parameter still remains in server.js");
}

fs.writeFileSync(file, source, "utf8");
console.log("Patched server.js startup integration successfully.");
