import fs from "node:fs";
import { spawnSync } from "node:child_process";

const serverPath = new URL("./server.js", import.meta.url);
const serverSource = fs.readFileSync(serverPath, "utf8");

if (serverSource.includes('"startup_firestorm"') || serverSource.includes("load_level")) {
  const patch = spawnSync(process.execPath, [".github/scripts/patch-startup-command.mjs"], {
    cwd: new URL(".", import.meta.url),
    stdio: "inherit",
  });
  if (patch.status !== 0) {
    throw new Error(`Startup migration failed with exit code ${patch.status}`);
  }
}

const check = spawnSync(process.execPath, ["--check", "server.js"], {
  cwd: new URL(".", import.meta.url),
  stdio: "inherit",
});
if (check.status !== 0) {
  throw new Error(`server.js syntax validation failed with exit code ${check.status}`);
}

await import("./server.js");
