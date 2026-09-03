// patch-fix9.mjs — CSS-only: when settings overlay exists, sidebar transform:none (beats drawer rule)
// Usage: node patch-fix9.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix9.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const anchor = 'html .pI_x6G_sidebarCol .VOzbGW_overlay{position:fixed!important;left:0!important;right:0!important;top:0!important;bottom:0!important;width:auto!important;max-width:none!important;z-index:1300!important}';
const add = 'html:has(.VOzbGW_overlay) .pI_x6G_sidebarCol{transform:none!important;transition:none!important}';
if (!h.includes(anchor)) { console.error('overlay css anchor NOT FOUND'); process.exit(1); }
if (h.includes('html:has(.VOzbGW_overlay)')) { console.log('already patched'); process.exit(0); }
h = h.split(anchor).join(anchor + add);
fs.writeFileSync(htmlPath, h);
console.log(':has overlay rule: added');
