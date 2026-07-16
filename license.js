import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const COMPONENTS = Object.freeze({
  PANEL: "orbitfs_panel",
  MCP: "orbitfs_mcp",
  WORKSPACES: "orbitfs_workspaces",
  SORTER: "orbitfs_sorter",
});

const ALL_COMPONENTS = Object.values(COMPONENTS);
const COMPONENT_SET = new Set(ALL_COMPONENTS);

export function isLicenseEnforced() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.ORBITFS_LICENSE_ENFORCE || "").trim().toLowerCase()
  );
}

function licenseDirectory() {
  const configured = String(process.env.ORBITFS_LICENSE_DIR || "").trim();
  if (configured) return configured;
  const base = process.env.ProgramData
    || process.env.PROGRAMDATA
    || path.join(os.homedir(), ".orbitfs");
  return path.join(base, "OrbitFS");
}

const installationPath = () => path.join(licenseDirectory(), "installation.json");
const cachePath = () => path.join(licenseDirectory(), "license.json");
const keyPath = () => path.join(licenseDirectory(), "license-key.json");

function refreshMs() {
  return Math.max(60_000, Number(process.env.ORBITFS_LICENSE_REFRESH_MINUTES || 180) * 60_000);
}

function signalPollMs() {
  return Math.max(60_000, Number(process.env.ORBITFS_LICENSE_SIGNAL_MINUTES || 1) * 60_000);
}

function graceMs() {
  return Math.max(0, Number(process.env.ORBITFS_LICENSE_GRACE_HOURS || 72) * 3_600_000);
}

function requestedComponents(value = ALL_COMPONENTS) {
  const input = Array.isArray(value) ? value : [value];
  return [...new Set(input.filter((item) => COMPONENT_SET.has(item)))];
}

async function readJson(filepath) {
  try { return JSON.parse(await fs.readFile(filepath, "utf8")); }
  catch { return null; }
}

async function writeJsonAtomic(filepath, value) {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  const temporary = `${filepath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filepath);
  await fs.chmod(filepath, 0o600).catch(() => {});
}

export async function ensureInstallationIdentity() {
  const current = await readJson(installationPath());
  if (current?.installationId) return current;
  const created = {
    installationId: `ofs-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(installationPath(), created);
  return created;
}

function keyHint(value) {
  const clean = String(value || "").trim();
  return clean.length > 4 ? `****${clean.slice(-4)}` : "****";
}

async function storedLicenseKey() {
  const storedKey = String((await readJson(keyPath()))?.licenseKey || "").trim();
  if (storedKey) return storedKey;
  return String(process.env.ORBITFS_LICENSE_KEY || "").trim();
}

async function saveLicenseKey(licenseKey) {
  await writeJsonAtomic(keyPath(), {
    licenseKey: String(licenseKey).trim(),
    keyHint: keyHint(licenseKey),
    savedAt: new Date().toISOString(),
  });
}

function providerConfig() {
  const exact = String(process.env.ORBITFS_LICENSE_VALIDATE_URL || "").trim();
  const base = String(process.env.ORBITFS_LICENSE_API_URL || process.env.ORBITFS_LICENSE_URL || "")
    .trim().replace(/\/+$/, "");
  const route = String(process.env.ORBITFS_LICENSE_VALIDATE_PATH || "/api/license/validate").trim();
  const url = exact || (base ? `${base}${route.startsWith("/") ? route : `/${route}`}` : "");
  if (!url) {
    const error = new Error("OrbitFS licence API is not configured");
    error.code = "LICENSE_PROVIDER_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }
  return { url, token: String(process.env.ORBITFS_LICENSE_API_TOKEN || "").trim() };
}

async function fetchValidationRevision() {
  const exact = String(process.env.ORBITFS_LICENSE_REVISION_URL || "").trim();
  const base = String(process.env.ORBITFS_LICENSE_API_URL || process.env.ORBITFS_LICENSE_URL || "")
    .trim().replace(/\/+$/, "");
  const url = exact || (base ? `${base}/api/license/revision` : "");
  if (!url) return null;
  const headers = {};
  const token = String(process.env.ORBITFS_LICENSE_API_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(Number(process.env.ORBITFS_LICENSE_TIMEOUT_MS || 8000)),
  });
  if (!response.ok) throw new Error(`Licence revision API returned ${response.status}`);
  const body = await response.json().catch(() => ({}));
  return body.revision || null;
}

function normaliseComponents(value) {
  const entries = Array.isArray(value)
    ? value.map((item) => [item.component || item.Component, item])
    : Object.entries(value || {});
  return Object.fromEntries(entries.filter(([name]) => COMPONENT_SET.has(name)).map(([name, item]) => {
    const state = String(item.state || item.State || "blocked").toLowerCase();
    const allowed = item.allowed === true || item.Allowed === true || item.allowed === 1 || item.Allowed === 1;
    const lockedHere = item.lockedToThisInstallation === true
      || item.LockedToThisInstallation === true
      || item.lockedToThisInstallation === 1
      || item.LockedToThisInstallation === 1;
    return [name, {
      state,
      allowed,
      lockedToThisInstallation: lockedHere,
      reason: item.reason || item.Reason || null,
    }];
  }));
}

function normaliseResult(body, installationId) {
  const value = body?.data || body || {};
  return {
    valid: value.valid === true || value.Valid === true || value.valid === 1 || value.Valid === 1,
    reason: value.reason || value.Reason || null,
    licenseId: value.licenseId || value.LicenseId || null,
    label: value.label || value.Label || null,
    expiresAt: value.expiresAt || value.ExpiresAt || null,
    installationId: value.installationId || value.InstallationId || installationId,
    components: normaliseComponents(value.components || value.Components),
  };
}

async function callProvider({ licenseKey, components, activate }) {
  const cleanKey = String(licenseKey || "").trim();
  if (!cleanKey) {
    const error = new Error("Licence key is required");
    error.code = "LICENSE_KEY_REQUIRED";
    error.status = 400;
    throw error;
  }
  const { url, token } = providerConfig();
  const installation = await ensureInstallationIdentity();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      licenseKey: cleanKey,
      installationId: installation.installationId,
      components: requestedComponents(components),
      activate: activate === true,
    }),
    signal: AbortSignal.timeout(Number(process.env.ORBITFS_LICENSE_TIMEOUT_MS || 8000)),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || body.message || `Licence API returned ${response.status}`);
    error.code = body.code || "LICENSE_PROVIDER_ERROR";
    error.status = response.status >= 400 && response.status < 500 ? response.status : 503;
    throw error;
  }
  return normaliseResult(body, installation.installationId);
}

function fresh(cache) {
  const checked = Date.parse(cache?.lastCheckedAt || "");
  return Number.isFinite(checked) && Date.now() - checked < refreshMs();
}

function withinGrace(cache) {
  const checked = Date.parse(cache?.lastCheckedAt || "");
  return cache?.valid === true && Number.isFinite(checked) && Date.now() - checked <= graceMs();
}

async function persist(result, source, licenseKey) {
  const cache = {
    ...result,
    enforcement: isLicenseEnforced(),
    keyHint: keyHint(licenseKey),
    source,
    lastCheckedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(cachePath(), cache);
  return cache;
}

function bypassSummary() {
  return {
    valid: true,
    enforcement: false,
    reason: "enforcement_disabled",
    components: Object.fromEntries(ALL_COMPONENTS.map((component) => [component, {
      state: "development",
      allowed: true,
      lockedToThisInstallation: true,
      reason: null,
    }])),
  };
}

export async function activateComponents(licenseKey, components = ALL_COMPONENTS) {
  const cleanKey = String(licenseKey || await storedLicenseKey()).trim();
  const requested = requestedComponents(components);
  if (!requested.length) throw Object.assign(new Error("At least one component is required"), { status: 400 });
  const result = await callProvider({ licenseKey: cleanKey, components: requested, activate: true });
  const denied = requested.filter((component) => {
    const item = result.components?.[component];
    return item?.state !== "locked" || item?.allowed !== true || item?.lockedToThisInstallation !== true;
  });
  if (!result.valid || denied.length) {
    const item = result.components?.[denied[0]] || {};
    const error = new Error(item.reason === "locked_elsewhere"
      ? "Licence component is locked to another installation"
      : `Licence does not allow ${denied.join(", ") || "this installation"}`);
    error.code = item.reason || result.reason || "LICENSE_COMPONENT_DENIED";
    error.status = 403;
    error.license = result;
    throw error;
  }
  await saveLicenseKey(cleanKey);
  return persist(result, "activation", cleanKey);
}

export async function getLicenseSummary({ refresh = false } = {}) {
  if (!isLicenseEnforced()) return bypassSummary();
  const licenseKey = await storedLicenseKey();
  if (!licenseKey) return { valid: false, enforcement: true, reason: "not_activated", components: {} };
  const cache = await readJson(cachePath());
  if (!refresh && fresh(cache)) return { ...cache, enforcement: true };
  try {
    const result = await callProvider({ licenseKey, components: ALL_COMPONENTS, activate: false });
    return await persist(result, "refresh", licenseKey);
  } catch (error) {
    if (withinGrace(cache)) return { ...cache, enforcement: true, offlineGrace: true, refreshError: error.message };
    return { valid: false, enforcement: true, reason: error.code || "provider_unavailable", refreshError: error.message, components: {} };
  }
}

export async function getComponentStatus(component, options = {}) {
  if (!COMPONENT_SET.has(component)) throw new Error(`Unknown licence component: ${component}`);
  const summary = await getLicenseSummary(options);
  const item = summary.components?.[component] || {
    state: "blocked",
    allowed: false,
    lockedToThisInstallation: false,
    reason: summary.reason || "not_included",
  };
  return {
    ...item,
    component,
    licensed: summary.enforcement === false || (
      summary.valid === true
      && item.state === "locked"
      && item.allowed === true
      && item.lockedToThisInstallation === true
    ),
    valid: summary.valid === true,
    enforcement: summary.enforcement !== false,
    offlineGrace: summary.offlineGrace === true,
    keyHint: summary.keyHint || null,
    lastCheckedAt: summary.lastCheckedAt || null,
    installationId: summary.installationId || null,
  };
}

export async function assertComponentLicensed(component, options = {}) {
  const status = await getComponentStatus(component, options);
  if (status.licensed) return status;
  const error = new Error(status.reason === "locked_elsewhere"
    ? "Licence is locked to another OrbitFS installation"
    : `${component} licence is blocked or not activated`);
  error.code = "LICENSE_REQUIRED";
  error.status = 403;
  error.license = status;
  throw error;
}

export function licenseGuard(component) {
  return async (_req, res, next) => {
    try {
      await assertComponentLicensed(component);
      next();
    } catch (error) {
      res.status(error.status || 403).json({
        error: error.message,
        code: error.code || "LICENSE_REQUIRED",
        license: error.license || null,
      });
    }
  };
}

let licenseHeartbeatTimer = null;
let licenseSignalTimer = null;
let lastValidationRevision = null;

export function startLicenseHeartbeat({ onUpdate, onError } = {}) {
  if (licenseHeartbeatTimer || licenseSignalTimer) return () => {};
  const check = async () => {
    if (!isLicenseEnforced()) return;
    try {
      const summary = await getLicenseSummary({ refresh: true });
      onUpdate?.(summary);
    } catch (error) {
      onError?.(error);
    }
  };
  const checkSignal = async () => {
    if (!isLicenseEnforced()) return;
    try {
      const revision = await fetchValidationRevision();
      if (!revision) return;
      if (lastValidationRevision === null) {
        lastValidationRevision = revision;
        return;
      }
      if (revision !== lastValidationRevision) {
        lastValidationRevision = revision;
        await check();
      }
    } catch (error) {
      onError?.(error);
    }
  };
  check();
  checkSignal();
  licenseHeartbeatTimer = setInterval(check, refreshMs());
  licenseSignalTimer = setInterval(checkSignal, signalPollMs());
  licenseHeartbeatTimer.unref?.();
  licenseSignalTimer.unref?.();
  return () => {
    clearInterval(licenseHeartbeatTimer);
    clearInterval(licenseSignalTimer);
    licenseHeartbeatTimer = null;
    licenseSignalTimer = null;
  };
}

export function getLicensePaths() {
  return { directory: licenseDirectory(), installation: installationPath(), cache: cachePath(), key: keyPath() };
}
