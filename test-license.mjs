import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { issueEntitlement } from "../../OrbitFS-License-API/src/entitlements.js";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orbitfs-license-test-"));
let responseMode = "valid";
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const components = Object.fromEntries((input.components || []).map((name) => [name, {
    state: "locked",
    allowed: responseMode === "valid",
    lockedToThisInstallation: responseMode === "valid",
    reason: responseMode === "valid" ? null : "not_found",
  }]));
  res.writeHead(200, { "Content-Type": "application/json" });
  const validation = {
    valid: responseMode === "valid",
    reason: responseMode === "valid" ? null : "not_found",
    label: "Local Test",
    installationId: input.installationId,
    components,
  };
  res.end(JSON.stringify({ ...validation, ...issueEntitlement(validation) }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

process.env.NODE_ENV = "production";
process.env.ENTITLEMENT_PRIVATE_KEY_PATH = "F:/OrbitFS-License-API/secrets/entitlement-private.pem";
process.env.ORBITFS_ENTITLEMENT_PUBLIC_KEY_PATH = "F:/OrbitFS-License-API/secrets/entitlement-public.pem";
process.env.ORBITFS_LICENSE_API_URL = `http://127.0.0.1:${port}`;
process.env.ORBITFS_LICENSE_DIR = tempDir;
process.env.ORBITFS_LICENSE_REFRESH_MINUTES = "1";
process.env.ORBITFS_LICENSE_GRACE_HOURS = "0";

try {
  const client = await import(`./license.js?test=${Date.now()}`);
  const activated = await client.activateComponents(
    "OFS-TEST-TEST-TEST-TEST",
    [client.COMPONENTS.PANEL, client.COMPONENTS.MCP]
  );
  assert.equal(activated.valid, true);
  assert.equal(activated.components[client.COMPONENTS.PANEL].allowed, true);
  await client.assertComponentLicensed(client.COMPONENTS.PANEL);

  const stored = JSON.parse(await fs.readFile(client.getLicensePaths().key, "utf8"));
  assert.equal(stored.licenseKey, "OFS-TEST-TEST-TEST-TEST");

  responseMode = "invalid";
  const invalid = await client.getLicenseSummary({ refresh: true });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.reason, "not_found");
  await assert.rejects(
    client.assertComponentLicensed(client.COMPONENTS.PANEL),
    (error) => error.code === "LICENSE_REQUIRED"
  );
  console.log("OrbitFS licence client tests passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
}
