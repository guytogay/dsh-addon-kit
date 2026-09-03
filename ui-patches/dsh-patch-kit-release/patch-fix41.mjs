// patch-fix41.mjs — TEMP: robust calibration (3 attempts) + visible debug tag with the calibrated value
// Usage: node patch-fix41.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix41.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'var px=11,py=19,calibrated=false;try{var wp=localStorage.getItem("dshWhalePos34");if(wp){var wq=wp.split(",");px=parseFloat(wq[0]);py=parseFloat(wq[1]);calibrated=true}}catch(e){}function align(){var logo=document.querySelector(".hHd-Xa_brandMark svg");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>0){var nx=r.left+r.width/2-17,ny=r.top+r.height/2-17;if(!calibrated){try{alert("whale:"+nx+","+ny)}catch(e){}}px=nx;py=ny;calibrated=true;try{localStorage.setItem("dshWhalePos34",px+","+py)}catch(e){}}}function sync(){var open=document.documentElement.hasAttribute("data-dsh-drawer");if(open){setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},500);btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.left=px+"px";btn.style.top=py+"px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
const to = 'var px=11,py=19,calibrated=false;function showDbg(nx,ny){var dbg=document.getElementById("dshWhaleDbg");if(!dbg){dbg=document.createElement("div");dbg.id="dshWhaleDbg";dbg.style.cssText="position:fixed;right:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,.78);color:#ffd75e;font-size:13px;padding:5px 10px;border-radius:6px;display:none;font-family:monospace";document.body.appendChild(dbg)}dbg.style.display="block";dbg.textContent="whale: "+nx.toFixed(2)+", "+ny.toFixed(2)}function align(){var logo=document.querySelector(".hHd-Xa_brandMark svg");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>0){var nx=r.left+r.width/2-17,ny=r.top+r.height/2-17;px=nx;py=ny;if(!calibrated){calibrated=true;showDbg(nx,ny);try{alert("whale:"+nx+","+ny)}catch(e){}}try{localStorage.setItem("dshWhalePos34",px+","+py)}catch(e){}}}function sync(){var open=document.documentElement.hasAttribute("data-dsh-drawer");if(open){setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},600);setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},1400);setTimeout(function(){align();btn.style.left=px+"px";btn.style.top=py+"px"},2800);btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.left=px+"px";btn.style.top=py+"px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
if (!h.includes(from)) { console.error('sync block NOT FOUND'); process.exit(1); }
if (h.includes('dshWhaleDbg')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('debug-tag calibration: applied');
