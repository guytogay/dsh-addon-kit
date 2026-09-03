// patch-fix19.mjs — self-calibrating whale button: on first open, align to real logo position, then pin
// Usage: node patch-fix19.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix19.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'function sync(){btn.style.display="flex";btn.setAttribute("aria-label",document.documentElement.hasAttribute("data-dsh-drawer")?"收起侧边栏":"展开侧边栏")}';
const to = 'var px=5,py=13,calibrated=false;function align(){var logo=document.querySelector(".hHd-Xa_brandMark");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>-200){px=r.left+r.width/2-22;py=r.top+r.height/2-22;calibrated=true}}function sync(){var open=document.documentElement.hasAttribute("data-dsh-drawer");if(open){if(!calibrated){setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},350)}btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.left=px+"px";btn.style.top=py+"px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
if (!h.includes(from)) { console.error('sync block NOT FOUND'); process.exit(1); }
if (h.includes('var px=5,py=13,calibrated=false')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('calibrating sync: applied');
