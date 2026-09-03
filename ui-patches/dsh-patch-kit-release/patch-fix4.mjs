// patch-fix4.mjs — whale button: move below Android status bar (edge-to-edge PWA)
// Usage: node patch-fix4.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix4.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'position:fixed;left:4px;top:10px;width:38px;height:38px;border-radius:10px';
const to = 'position:fixed;left:4px;top:max(env(safe-area-inset-top,0px) + 8px,44px);width:38px;height:38px;border-radius:10px';
if (!h.includes(from)) { console.error('button style NOT FOUND'); process.exit(1); }
if (!h.includes('top:10px;width:38px')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('button position: below status bar');
