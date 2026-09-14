// strip-bom.js — one-off: hapus BOM dari semua .json/.js/.jsx di workspace app
const fs = require('fs');
const path = require('path');

const dirs = [
  'D:/local-rag-voice-bot/cadas-app',
  'D:/local-rag-voice-bot/cadas-app-backend',
];

const seen = new Set();
function walk(d, out) {
  for (const f of fs.readdirSync(d)) {
    if (['node_modules', '.git', '.expo', '.idea', '.claude'].includes(f)) continue;
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(json|js|jsx)$/.test(f)) out.push(p);
  }
  return out;
}

let fixed = 0;
for (const d of dirs) {
  for (const f of walk(d, [])) {
    if (seen.has(f)) continue;
    seen.add(f);
    const buf = fs.readFileSync(f);
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      fs.writeFileSync(f, buf.subarray(3));
      console.log('BOM dihapus:', f);
      fixed++;
    }
  }
}
console.log('Total BOM dihapus:', fixed);