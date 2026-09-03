// patch-fix36.mjs — calibrate ONCE, persist to localStorage; clone once; no repeated calibration motion
// Usage: node patch-fix36.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix36.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'var px=5,py=13,calibrated=false,officialSvg="";function align(){var logo=document.querySelector(".hHd-Xa_brandMark svg");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>0){px=r.left+r.width/2-22;py=r.top+r.height/2-22;calibrated=true;var cl=logo.cloneNode(true);cl.removeAttribute("id");cl.style.color="#d5d9e0";var ps=cl.querySelectorAll("path,ellipse,circle,polygon,rect");for(var i=0;i<ps.length;i++){if(ps[i].hasAttribute("fill"))ps[i].setAttribute("fill","#d5d9e0")}officialSvg=cl.outerHTML;btn.innerHTML=officialSvg}}';
const to = 'var px=5,py=13,calibrated=false,officialSvg="";try{var wp=localStorage.getItem("dshWhalePos");if(wp){var wq=wp.split(",");px=parseFloat(wq[0]);py=parseFloat(wq[1]);calibrated=true}}catch(e){}function align(){var logo=document.querySelector(".hHd-Xa_brandMark svg");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>0){if(!calibrated){px=r.left+r.width/2-22;py=r.top+r.height/2-22;calibrated=true;try{localStorage.setItem("dshWhalePos",px+","+py)}catch(e){}}if(!officialSvg){var cl=logo.cloneNode(true);cl.removeAttribute("id");cl.style.color="#d5d9e0";var ps=cl.querySelectorAll("path,ellipse,circle,polygon,rect");for(var i=0;i<ps.length;i++){if(ps[i].hasAttribute("fill"))ps[i].setAttribute("fill","#d5d9e0")}officialSvg=cl.outerHTML;btn.innerHTML=officialSvg}}}';
if (!h.includes(from)) { console.error('align block NOT FOUND'); process.exit(1); }
if (h.includes('localStorage.getItem("dshWhalePos")')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('one-shot persisted calibration: applied');
