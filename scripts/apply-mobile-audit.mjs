import fs from "node:fs";

function replaceExact(file, from, to) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(from)) throw new Error(`Expected text not found in ${file}: ${from.slice(0, 80)}`);
  fs.writeFileSync(file, source.replace(from, to));
}

replaceExact(
  "server-core.js",
  'const STARTUP_CONTEXT_FILE_LIMIT = { low: 0, med: 25, high: 60 };\nconst STARTUP_CONTEXT_TOTAL_CHAR_CAP = { low: 100_000, med: 200_000, high: 500_000 };\nconst STARTUP_CONTEXT_FILE_CHAR_CAP = { low: 10_000, med: 12_000, high: 20_000 };',
  'const STARTUP_CONTEXT_FILE_LIMIT = { low: 0, med: 25, high: 250 };\nconst STARTUP_CONTEXT_TOTAL_CHAR_CAP = { low: 100_000, med: 200_000, high: 2_000_000 };\nconst STARTUP_CONTEXT_FILE_CHAR_CAP = { low: 10_000, med: 12_000, high: 120_000 };'
);

replaceExact(
  "server.js",
  'high: { maxFiles: 80, maxCharacters: 700000, perFileCharacters: 90000 },',
  'high: { maxFiles: 250, maxCharacters: 2000000, perFileCharacters: 120000 },'
);

replaceExact(
  "app/widget/index.html",
  '<button id="previewMove">Preview move</button>',
  '<button id="previewMove" class="danger">Move / rename</button>'
);

replaceExact(
  "app/widget/index.html",
  "previewMove.onclick=async()=>{if(!moveFrom.value.trim()||!moveTo.value.trim())return;const r=await callTool('move_file',{from:moveFrom.value.trim(),to:moveTo.value.trim()});show(textFrom(r));};",
  "previewMove.onclick=async()=>{const from=moveFrom.value.trim(),to=moveTo.value.trim();if(!from||!to)return;if(!confirm(`Move or rename ${from} to ${to}?`))return;const r=await callTool('move_file',{from,to});show(textFrom(r));};"
);

replaceExact(
  "app/widget/index.html",
  'input,select,button{border:1px solid #33415b;background:#111827;color:#eef4ff;border-radius:8px;padding:8px}',
  'input,select,button{border:1px solid #33415b;background:#111827;color:#eef4ff;border-radius:8px;padding:9px;min-height:42px;font-size:16px}'
);

replaceExact(
  "app/widget/index.html",
  '@media(max-width:520px){.grid{grid-template-columns:1fr}.file{grid-template-columns:auto 1fr}.file-actions{grid-column:2}}',
  '@media(max-width:520px){body{padding:8px}.card{padding:10px}.tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));position:sticky;top:0;z-index:4;background:#171e2d;padding:6px 0}.tabs button{padding:7px 3px;min-height:42px;font-size:12px}.grid,.toolbar{grid-template-columns:1fr}.actions button{flex:1 1 46%;min-height:46px}.file{grid-template-columns:auto 1fr;padding:10px}.file-actions{grid-column:2}.file-actions button{min-height:42px}.files{max-height:48vh}}'
);

console.log("Applied MCP mobile and high-load audit fixes.");
