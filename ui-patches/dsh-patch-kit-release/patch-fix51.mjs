// patch-fix51.mjs — fix quote chars: use loose /^会话.*的操作$/ (CN quotes are U+201C/201D)
// Usage: node patch-fix51.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix51.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = '/^会话".*"的操作$/';
const to = '/^会话.*的操作$/';
if (!h.includes(from)) { console.error('regex NOT FOUND'); process.exit(1); }
if (h.includes('/^会话.*的操作$/')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('loose session regex: applied');
