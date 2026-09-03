// patch-fix44.mjs — force the whale-in-button SVG to the official 24x17.66 size (no flex shrink)
// Usage: node patch-fix44.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix44.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const anchor = '.hHd-Xa_toggle{pointer-events:none}';
const add = 'button[aria-label="展开侧边栏"] svg,button[aria-label="收起侧边栏"] svg{width:24px!important;height:17.66px!important;flex:none!important}';
if (!h.includes(anchor)) { console.error('anchor NOT FOUND'); process.exit(1); }
if (h.includes('button[aria-label="展开侧边栏"] svg')) { console.log('already patched'); process.exit(0); }
h = h.split(anchor).join(anchor + add);
fs.writeFileSync(htmlPath, h);
console.log('whale size forced: applied');
