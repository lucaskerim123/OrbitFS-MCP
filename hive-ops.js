import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export function makeOps(root) {
  const ROOT = path.resolve(root);

  function safeResolve(rel) {
    const full = path.resolve(ROOT, rel || ".");
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
      throw new Error("Path escapes the Master Hive root");
    }
    return full;
  }

  async function listFiles(subpath) {
    const dir = safeResolve(subpath);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
  }

  async function readFile(filepath) {
    return fs.readFile(safeResolve(filepath), "utf-8");
  }

  async function writeFile(filepath, content) {
    const full = safeResolve(filepath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
  }

  async function deleteFile(filepath) {
    await fs.unlink(safeResolve(filepath));
  }

  async function moveFile(from, to) {
    const src = safeResolve(from);
    const dest = safeResolve(to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
  }

  async function makeDir(subpath) {
    await fs.mkdir(safeResolve(subpath), { recursive: true });
  }

  async function hashFile(full) {
    const data = await fs.readFile(full);
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  async function statFile(filepath) {
    const full = safeResolve(filepath);
    const st = await fs.stat(full);
    return { size: st.size, mtime: st.mtime.toISOString(), sha256: await hashFile(full) };
  }

  async function walk(dir, out = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, out);
      else out.push(full);
    }
    return out;
  }

  async function manifest() {
    const files = await walk(ROOT);
    const result = [];
    for (const full of files) {
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      const st = await fs.stat(full);
      result.push({ path: rel, size: st.size, mtime: st.mtime.toISOString(), sha256: await hashFile(full) });
    }
    return result;
  }

  async function searchFiles(query, subpath, limit = 200) {
    const startDir = safeResolve(subpath);
    const files = await walk(startDir);
    const matches = [];
    for (const full of files) {
      let text;
      try {
        text = await fs.readFile(full, "utf-8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < limit; i++) {
        if (lines[i].includes(query)) {
          matches.push({
            path: path.relative(ROOT, full).split(path.sep).join("/"),
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
          });
        }
      }
      if (matches.length >= limit) break;
    }
    return matches;
  }

  return {
    ROOT,
    safeResolve,
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    moveFile,
    makeDir,
    statFile,
    manifest,
    searchFiles,
  };
}
