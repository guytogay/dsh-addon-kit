// patch-fix43.mjs — opaque while drawer open (no see-through double-whale), translucent when closed
// Usage: node patch-fix43.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix43.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'function sync(){var open=document.documentElement.hasAttribute("data-dsh-drawer");if(open){setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},600);setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},1400);setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},2800);btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.left=px+"px";btn.style.top=py+"px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
const to = 'function sync(){var open=document.documentElement.hasAttribute("data-dsh-drawer");if(open){setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},600);setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},1400);setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},2800);btn.style.opacity="1";btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.opacity=".45";btn.style.left=px+"px";btn.style.top=py+"px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
if (!h.includes(from)) { console.error('sync block NOT FOUND'); process.exit(1); }
if (h.includes('btn.style.opacity="1";btn.setAttribute')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('opaque-when-open: applied');
