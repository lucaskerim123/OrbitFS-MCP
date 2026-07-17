import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverFile = path.join(repoRoot, "server-core.js");
let source = await fs.readFile(serverFile, "utf8");

const marker = "// FULL_STARTUP_POLICY_V1";
if (source.includes(marker)) {
  process.stdout.write("Full startup policy already enforced.\n");
  process.exit(0);
}

const oldMandatory = `function isMandatoryStartupFile(filepath) {
  const normalized = normalizeRelativePath(filepath).toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) || "";
  const inMasterLogs = normalized.startsWith("0. core/master logs/");
  const isProfilesQuickView = /^mental[\\s_-]*health[\\s_-]*profiles[\\s_-]*core\\.docx$/.test(basename);
  const inMasterProfiles = parts.slice(0, -1).some((part) => part === "master profiles");
  const isLukeOrLaura = /(^|[^a-z])luke([^a-z]|$)/.test(basename) || /(^|[^a-z])laura([^a-z]|$)/.test(basename);
  return inMasterLogs || isProfilesQuickView || (inMasterProfiles && isLukeOrLaura);
}`;

const newMandatory = `${marker}
const HARD_CODED_FULL_STARTUP_FILES = new Set([
  "master_incident_log_v1.md",
  "master_incident_log_v2.md",
  "master_relationship_timeline.md",
  "mental_health_profiles_core_v2.md",
  "luke_kerim_master_profile.md",
  "laura_woods_master_profile.md",
]);

function startupBasename(filepath = "") {
  return path.basename(normalizeRelativePath(filepath)).toLowerCase();
}

function isMandatoryStartupFile(filepath) {
  return HARD_CODED_FULL_STARTUP_FILES.has(startupBasename(filepath));
}`;

const hasCurrentMandatoryPolicy = source.includes("function isMandatoryStartupFile(filepath)")
  && source.includes("0. core/master logs/")
  && source.includes("master profiles")
  && source.includes("luke")
  && source.includes("laura");

if (!source.includes(oldMandatory)) {
  if (hasCurrentMandatoryPolicy) {
    process.stdout.write("Mandatory startup-file policy already present.\n");
    process.exit(0);
  }
  throw new Error("Could not find the mandatory startup-file policy block. Refusing to patch an unknown server version.");
}
source = source.replace(oldMandatory, newMandatory);

const oldLoaderStart = "async function loadStartupContextFiles(filepaths, load) {";
const loaderStart = source.indexOf(oldLoaderStart);
const loaderEnd = source.indexOf("\n}\n\nfunction referenceWords", loaderStart);
if (loaderStart < 0 || loaderEnd < 0) {
  throw new Error("Could not find loadStartupContextFiles(). Refusing to patch an unknown server version.");
}

const newLoader = `async function loadStartupContextFiles(filepaths, load) {
  const fullRead = load === "high";
  const fileLimit = STARTUP_CONTEXT_FILE_LIMIT[load];
  const totalCap = fullRead ? Number.POSITIVE_INFINITY : STARTUP_CONTEXT_TOTAL_CHAR_CAP[load];
  const perFileCap = fullRead ? Number.POSITIVE_INFINITY : STARTUP_CONTEXT_FILE_CHAR_CAP[load];
  const mandatory = filepaths.filter(isMandatoryStartupFile);
  const normal = filepaths.filter((filepath) => !isMandatoryStartupFile(filepath));
  const selected = fullRead
    ? [...mandatory, ...normal]
    : [...mandatory, ...(load === "low" ? [] : normal.slice(0, fileLimit))];
  const files = [];
  let totalChars = 0;

  for (let offset = 0; offset < selected.length; offset += BATCH_READ_MAX_FILES) {
    const batch = selected.slice(offset, offset + BATCH_READ_MAX_FILES);
    for (const filepath of batch) {
      let data;
      try {
        data = await readStartupFile(mainOps, filepath);
      } catch (err) {
        files.push({ filepath, error: err.message, complete: false });
        continue;
      }
      const remaining = totalCap - totalChars;
      const content = fullRead ? data : data.slice(0, Math.min(perFileCap, remaining));
      totalChars += content.length;
      files.push({
        filepath,
        content,
        chars: data.length,
        loadedChars: content.length,
        truncated: content.length < data.length,
        complete: content.length === data.length,
        sha256: crypto.createHash("sha256").update(data, "utf8").digest("hex"),
      });
      if (!fullRead && totalChars >= totalCap) break;
    }
    if (!fullRead && totalChars >= totalCap) break;
    if (fullRead && offset + BATCH_READ_MAX_FILES < selected.length) {
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }

  const failed = files.filter((item) => item.error || !item.complete);
  const missingMandatory = [...HARD_CODED_FULL_STARTUP_FILES].filter(
    (required) => !files.some((item) => startupBasename(item.filepath) === required && item.complete)
  );

  if (fullRead && (failed.length || missingMandatory.length)) {
    const details = [
      ...failed.map((item) => \`\${item.filepath}: \${item.error || "partial read"}\`),
      ...missingMandatory.map((name) => \`missing mandatory file: \${name}\`),
    ];
    throw new Error(\`100% startup load failed. Startup is not complete. \${details.join(" | ")}\`);
  }

  return {
    files,
    totalChars,
    discoveredCount: filepaths.length,
    selectedCount: selected.length,
    completedCount: files.filter((item) => item.complete).length,
    failedCount: failed.length,
    missingMandatory,
    fullRead,
    truncated: fullRead ? false : filepaths.length > selected.length || totalChars >= totalCap,
  };
}`;

source = source.slice(0, loaderStart) + newLoader + source.slice(loaderEnd + 2);

const oldConfirmation = `  sections.push("", "Reply to the user with ONLY the following line(s) - no summary of the above:", ...confirmations);`;
const newConfirmation = `  if (load === "high") {
    sections.push(
      "",
      \`100% load verification: \${contextLoad.completedCount}/\${contextLoad.selectedCount} files fully read; 0 partial; 0 failed.\`
    );
  }
  sections.push("", "Reply to the user with ONLY the following line(s) - no summary of the above:", ...confirmations);`;
if (!source.includes(oldConfirmation)) {
  throw new Error("Could not find startup confirmation block. Refusing to patch an unknown server version.");
}
source = source.replace(oldConfirmation, newConfirmation);

await fs.writeFile(serverFile, source, "utf8");
process.stdout.write("Applied hardcoded 100% startup reading policy.\n");
