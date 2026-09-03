// patch-fix38.mjs — shrink the button frame 44->34 (whale size untouched), keep center aligned
// Usage: node patch-fix38.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix38.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'position:fixed;left:6px;top:max(env(safe-area-inset-top,0px) + 4px,14px);width:44px;height:44px;border-radius:12px';
const to = 'position:fixed;left:11px;top:max(env(safe-area-inset-top,0px) + 4px,19px);width:34px;height:34px;border-radius:10px';
if (!h.includes(from)) { console.error('button inline NOT FOUND'); process.exit(1); }
if (h.includes('width:34px;height:34px')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('button frame 34x34: applied');
