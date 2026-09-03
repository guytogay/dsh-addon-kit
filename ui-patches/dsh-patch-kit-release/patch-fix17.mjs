// patch-fix17.mjs — when drawer open, align whale button center with the official sidebar logo
// Usage: node patch-fix17.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix17.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'function sync(){btn.style.display="flex";btn.setAttribute("aria-label",document.documentElement.hasAttribute("data-dsh-drawer")?"收起侧边栏":"展开侧边栏")}';
const to = 'function sync(){if(document.documentElement.hasAttribute("data-dsh-drawer")){btn.style.left="6px";btn.style.top="14px";btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.left="8px";btn.style.top="8px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
if (!h.includes(from)) { console.error('sync block NOT FOUND'); process.exit(1); }
if (h.includes('btn.style.top="14px"')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('logo-aligned sync: applied');
