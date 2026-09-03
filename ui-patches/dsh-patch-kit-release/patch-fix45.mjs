// patch-fix45.mjs — REVERT fix43: remove the opacity overrides (no covering), back to translucent
// Usage: node patch-fix45.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix45.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from1 = 'btn.style.opacity="1";btn.setAttribute("aria-label","收起侧边栏")';
const to1 = 'btn.setAttribute("aria-label","收起侧边栏")';
const from2 = 'btn.style.opacity=".45";btn.style.left=px+"px";btn.style.top=py+"px"';
const to2 = 'btn.style.left=px+"px";btn.style.top=py+"px"';
let n = 0;
if (h.includes(from1)) { h = h.split(from1).join(to1); n++; }
if (h.includes(from2)) { h = h.split(from2).join(to2); n++; }
if (n === 0) { console.error('fix43 changes NOT FOUND'); process.exit(1); }
fs.writeFileSync(htmlPath, h);
console.log(`fix43 reverted (${n} spots)`);
