export const LOAD_STATUS = Object.freeze({
  FULLY_LOADED: "fully_loaded",
  PARTIALLY_LOADED: "partially_loaded",
  REFERENCE_ONLY: "reference_only",
  FAILED: "failed",
});

export function normalizeLoadedCharacters(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function buildLoadManifestEntry({
  filepath,
  source = "manual",
  charactersLoaded = 0,
  totalCharacters = charactersLoaded,
  truncated = false,
  pinned = false,
  chunksLoaded = 1,
  totalChunks = 1,
  hash = null,
  warnings = [],
  status,
} = {}) {
  const loaded = normalizeLoadedCharacters(charactersLoaded);
  const total = normalizeLoadedCharacters(totalCharacters) || loaded;
  const hasWarnings = Array.isArray(warnings) && warnings.length > 0;
  const finalStatus = status || (truncated || loaded < total ? LOAD_STATUS.PARTIALLY_LOADED : LOAD_STATUS.FULLY_LOADED);
  const now = new Date().toISOString();
  const coveragePercent = total > 0 ? Math.min(100, Math.round((loaded / total) * 10000) / 100) : 0;

  return {
    path: String(filepath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
    characters: loaded,
    charactersLoaded: loaded,
    totalCharacters: total,
    coveragePercent,
    source,
    status: finalStatus,
    truncated: !!truncated || loaded < total,
    pinned: !!pinned,
    chunksLoaded: Math.max(0, Number(chunksLoaded || 0)),
    totalChunks: Math.max(1, Number(totalChunks || 1)),
    hash,
    warnings: hasWarnings ? warnings.map(String) : [],
    loadedAt: now,
    lastAccessedAt: now,
    expiresAt: null,
  };
}

export function summarizeLoadManifest(entries = []) {
  const files = Array.isArray(entries) ? entries : [];
  return {
    fileCount: files.length,
    fullyLoadedCount: files.filter((file) => file.status === LOAD_STATUS.FULLY_LOADED).length,
    partiallyLoadedCount: files.filter((file) => file.status === LOAD_STATUS.PARTIALLY_LOADED).length,
    referenceOnlyCount: files.filter((file) => file.status === LOAD_STATUS.REFERENCE_ONLY).length,
    failedCount: files.filter((file) => file.status === LOAD_STATUS.FAILED).length,
    charactersLoaded: files.reduce((sum, file) => sum + normalizeLoadedCharacters(file.charactersLoaded ?? file.characters), 0),
    totalCharacters: files.reduce((sum, file) => sum + normalizeLoadedCharacters(file.totalCharacters ?? file.characters), 0),
  };
}
