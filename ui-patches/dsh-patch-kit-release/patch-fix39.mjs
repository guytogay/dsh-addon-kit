// patch-fix39.mjs — keep env-branch center aligned after frame shrink: top env+9 for 34px button
// Usage: node patch-fix39.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix39.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'top:max(env(safe-area-inset-top,0px) + 4px,19px)';
const to = 'top:max(env(safe-area-inset-top,0px) + 9px,19px)';
if (!h.includes(from)) { console.error('top rule NOT FOUND'); process.exit(1); }
if (h.includes('+ 9px,19px')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('env-branch center fix: applied');
