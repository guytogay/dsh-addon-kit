// patch-fix31.mjs — whale button clones the OFFICIAL logo SVG (same shape/size), compensation reset
// Usage: node patch-fix31.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix31.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'var px=5,py=13,calibrated=false;function align(){var logo=document.querySelector(".hHd-Xa_brandMark");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>-200){px=r.left+r.width/2-22+1;py=r.top+r.height/2-22-0.5;calibrated=true}}';
const to = 'var px=5,py=13,calibrated=false;function align(){var logo=document.querySelector(".hHd-Xa_brandMark svg");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>-200){px=r.left+r.width/2-22;py=r.top+r.height/2-22;calibrated=true;var cl=logo.cloneNode(true);cl.removeAttribute("id");cl.style.color="#d5d9e0";var ps=cl.querySelectorAll("path,ellipse,circle,polygon,rect");for(var i=0;i<ps.length;i++){if(ps[i].hasAttribute("fill"))ps[i].setAttribute("fill","#d5d9e0")}btn.innerHTML="";btn.appendChild(cl)}}';
if (!h.includes(from)) { console.error('align block NOT FOUND'); process.exit(1); }
if (h.includes('cloneNode(true)')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('official-logo clone: applied');
