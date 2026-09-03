// patch-fix6.mjs — open state uses transform:none (no transform => inner fixed panels are viewport-relative)
// Usage: node patch-fix6.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix6.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'html[data-dsh-drawer="open"] .pI_x6G_sidebarCol{transform:translateX(0)!important}';
const to = 'html[data-dsh-drawer="open"] .pI_x6G_sidebarCol{transform:none!important}';
if (!h.includes(from)) { console.error('open rule NOT FOUND'); process.exit(1); }
if (h.includes('transform:none!important}')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('open rule: transform:none');
