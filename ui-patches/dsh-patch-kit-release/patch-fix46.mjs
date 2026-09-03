// patch-fix46.mjs — FINAL: remove calibration/debug/alert; position fixed in inline style; sync only toggles label
// Usage: node patch-fix46.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix46.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const re = /var px=11,py=19,calibrated=false;[\s\S]*?btn\.style\.display="flex"\}/;
const to = 'function sync(){btn.setAttribute("aria-label",document.documentElement.hasAttribute("data-dsh-drawer")?"收起侧边栏":"展开侧边栏");btn.style.display="flex"}';
if (!re.test(h)) { console.error('calibration block NOT FOUND'); process.exit(1); }
if (h.includes('function sync(){btn.setAttribute("aria-label",document.documentElement.hasAttribute("data-dsh-drawer")?"收起侧边栏":"展开侧边栏")')) { console.log('already patched'); process.exit(0); }
h = h.replace(re, to);
fs.writeFileSync(htmlPath, h);
console.log('final static: applied');
