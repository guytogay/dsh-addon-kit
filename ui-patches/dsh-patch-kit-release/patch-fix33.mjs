// patch-fix33.mjs — on close restore the stable favicon whale; clone (official) only while open
// Usage: node patch-fix33.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix33.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = '}else{btn.style.left=px+"px";btn.style.top=py+"px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
const to = '}else{btn.innerHTML=whaleSvg;btn.style.left=px+"px";btn.style.top=py+"px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
if (!h.includes(from)) { console.error('sync else NOT FOUND'); process.exit(1); }
if (h.includes('btn.innerHTML=whaleSvg;btn.style.left')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('restore favicon whale on close: applied');
