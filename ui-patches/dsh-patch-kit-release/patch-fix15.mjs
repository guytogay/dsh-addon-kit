// patch-fix15.mjs — whale button pinned to top-left always; only aria-label switches
// Usage: node patch-fix15.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix15.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'function sync(){if(document.documentElement.hasAttribute("data-dsh-drawer")){btn.style.display="flex";btn.style.left="auto";btn.style.right="8px";btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.display="flex";btn.style.right="auto";btn.style.left="8px";btn.setAttribute("aria-label","展开侧边栏")}}';
const to = 'function sync(){btn.style.display="flex";btn.setAttribute("aria-label",document.documentElement.hasAttribute("data-dsh-drawer")?"收起侧边栏":"展开侧边栏")}';
if (!h.includes(from)) { console.error('sync block NOT FOUND'); process.exit(1); }
if (h.includes('btn.setAttribute("aria-label",document.documentElement.hasAttribute("data-dsh-drawer")')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('whale pinned top-left: applied');
