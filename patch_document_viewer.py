from pathlib import Path

core = Path(r"F:\OrbitFS Project\orbitfs-mcp\server-core.js")
widget = Path(r"F:\OrbitFS Project\orbitfs-mcp\app\widget\index.html")
s = core.read_text(encoding="utf-8-sig")

if 'import pdfParse from "pdf-parse";' not in s:
    s = s.replace('import mammoth from "mammoth";\n', 'import mammoth from "mammoth";\nimport pdfParse from "pdf-parse";\n', 1)

anchor = '''async function readStartupFile(filepath) {
  if (path.extname(filepath).toLowerCase() !== ".docx") return ops.readFile(filepath);
  const result = await mammoth.extractRawText({ path: ops.safeResolve(filepath) });
  return result.value;
}
'''

helper = '''async function extractViewableFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: ops.safeResolve(filepath) });
    return { text: result.value, format: "DOCX", pages: null };
  }
  if (ext === ".pdf") {
    const result = await pdfParse(await fs.readFile(ops.safeResolve(filepath)));
    return { text: result.text || "", format: "PDF", pages: result.numpages || null };
  }
''  if (STARTUP_TEXT_EXTENSIONS.has(ext)) {
    return { text: await ops.readFile(filepath), format: (ext.slice(1) || "text").toUpperCase(), pages: null };
  }
  throw new Error(`Unsupported viewer format "${ext || "(none)"}". Supported: PDF, DOCX, and readable text files.`);
}

function buildDocumentView(filepath, extracted, preview) {
  const fullText = String(extracted.text || "");
  const maxLines = preview ? 80 : 2500;
  const maxChars = preview ? 12000 : 250000;
  const lines = fullText.split(/\\r?\\n/);
  let text = lines.slice(0, maxLines).join("\\n");
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return {
    mode: "document_viewer",
    document: {
      path: filepath,
      name: path.basename(filepath),
      format: extracted.format,
      pages: extracted.pages,
      totalLines: lines.length,
      totalChars: fullText.length,
      text,
      preview,
      truncated: text.length < fullText.length,
    },
  };
}
'''

if 'async function extractViewableFile' not in s:
    if anchor not in s:
        raise SystemExit('readStartupFile anchor missing')
    s = s.replace(anchor, anchor + '\n' + helper, 1)
tool_anchor = '''  server.tool(
    "read_folder_recursive",'''
viewer_tools = '''  server.tool(
    "view_file",
    "Open a PDF, DOCX, or readable text file in the expandable Hive document viewer UI.",
    { filepath: z.string().describe("File path or filename") },
    async ({ filepath }) => {
      const resolved = await resolveHiveReference(filepath, "file");
      const extracted = await extractViewableFile(resolved.path);
      const structuredContent = buildDocumentView(resolved.path, extracted, false);
      logEvent("tool.view_file.ok", { ...authContext, filepath: resolved.path, format: extracted.format });
      return {
        content: [{ type: "text", text: `Opened ${resolved.path} in the Hive document viewer.` }],
        structuredContent,
      };
    }
  );

  server.tool(
    "preview_file",
    "Preview the first section of a PDF, DOCX, or readable text file in the compact Hive document viewer UI.",
    { filepath: z.string().describe("File path or filename") },
    async ({ filepath }) => {
      const resolved = await resolveHiveReference(filepath, "file");
      const extracted = await extractViewableFile(resolved.path);
      const structuredContent = buildDocumentView(resolved.path, extracted, true);
      logEvent("tool.preview_file.ok", { ...authContext, filepath: resolved.path, format: extracted.format });
      return {
        content: [{ type: "text", text: `Previewed ${resolved.path} in the Hive document viewer.` }],
        structuredContent,
      };
    }
  );

'''
if '"view_file"' not in s:
    if tool_anchor not in s:
        raise SystemExit('tool anchor missing')
    s = s.replace(tool_anchor, viewer_tools + tool_anchor, 1)
prompt_anchor = '''  toolPrompt(
    "search",'''
prompts = '''  toolPrompt(
    "viewfile",
    "Open a document in the expandable Hive viewer",
    { filepath: z.string().describe("PDF, DOCX, or text file") },
    "view_file",
    "Show the returned Hive document viewer UI."
  );

  toolPrompt(
    "previewfile",
    "Preview a document in the compact Hive viewer",
    { filepath: z.string().describe("PDF, DOCX, or text file") },
    "preview_file",
    "Show the returned Hive document viewer UI."
  );

'''
if '"viewfile"' not in s:
    if prompt_anchor not in s:
        raise SystemExit('prompt anchor missing')
    s = s.replace(prompt_anchor, prompts + prompt_anchor, 1)

core.write_text(s, encoding="utf-8")

w = widget.read_text(encoding="utf-8")
w = w.replace('.status-output{max-height:360px}', '.status-output{max-height:360px}.doc-viewer{margin-top:10px;border:1px solid #2a354a;border-radius:12px;background:#0d121d;overflow:hidden}.doc-head{display:flex;align-items:center;gap:8px;padding:10px;background:#151d2b}.doc-title{flex:1;min-width:0}.doc-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.doc-body{max-height:360px;overflow:auto;padding:12px;white-space:pre-wrap;line-height:1.55;font-size:13px}.doc-viewer.expanded .doc-body{max-height:72vh}.doc-viewer.fullscreen{position:fixed;inset:8px;z-index:50}.doc-viewer.fullscreen .doc-body{max-height:calc(100vh - 88px)}', 1)
files_anchor = '''    <div class="toolbar"><input id="loadPath" placeholder="File path"><button id="loadFile">Load into ChatGPT</button></div>'''
files_markup = '''    <div class="toolbar"><input id="loadPath" placeholder="File path"><button id="loadFile">Load into ChatGPT</button></div>
    <div class="actions"><button id="viewFile">View in Hive</button><button id="previewFile">Preview in Hive</button></div>'''
if files_anchor in w and 'id="viewFile"' not in w:
    w = w.replace(files_anchor, files_markup, 1)

output_anchor = '''  <pre id="output" class="hidden"></pre>'''
viewer_markup = '''  <section id="docViewer" class="doc-viewer hidden">
    <div class="doc-head">
      <div class="doc-title"><strong id="docName">Document</strong><span id="docMeta" class="muted"></span></div>
      <button id="docExpand" type="button">Expand</button>
      <button id="docFull" type="button">Full screen</button>
      <button id="docClose" type="button">✕</button>
    </div>
    <div id="docBody" class="doc-body"></div>
  </section>
  <pre id="output" class="hidden"></pre>'''
if output_anchor in w and 'id="docViewer"' not in w:
    w = w.replace(output_anchor, viewer_markup, 1)

render_old = "function render(d){if(!d)return;"
render_new = "function render(d){if(!d)return;if(d.mode==='document_viewer'&&d.document){renderDocument(d.document);return;}"
if render_old in w:
    w = w.replace(render_old, render_new, 1)
