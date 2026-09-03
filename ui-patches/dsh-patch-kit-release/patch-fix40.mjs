// patch-fix40.mjs — TEMP: restore calibration (34px half=17), alert the calibrated px,py once
// Usage: node patch-fix40.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix40.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'function sync(){btn.setAttribute("aria-label",document.documentElement.hasAttribute("data-dsh-drawer")?"收起侧边栏":"展开侧边栏");btn.style.display="flex"}';
const to = 'var px=11,py=19,calibrated=false;try{var wp=localStorage.getItem("dshWhalePos34");if(wp){var wq=wp.split(",");px=parseFloat(wq[0]);py=parseFloat(wq[1]);calibrated=true}}catch(e){}function align(){var logo=document.querySelector(".hHd-Xa_brandMark svg");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>0){var nx=r.left+r.width/2-17,ny=r.top+r.height/2-17;if(!calibrated){try{alert("whale:"+nx+","+ny)}catch(e){}}px=nx;py=ny;calibrated=true;try{localStorage.setItem("dshWhalePos34",px+","+py)}catch(e){}}}function sync(){var open=document.documentElement.hasAttribute("data-dsh-drawer");if(open){setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},500);btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.left=px+"px";btn.style.top=py+"px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
if (!h.includes(from)) { console.error('sync block NOT FOUND'); process.exit(1); }
if (h.includes('dshWhalePos34')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('temp calibration + alert: applied');
