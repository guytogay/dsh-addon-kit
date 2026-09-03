// patch-fix35.mjs — cache the official logo clone; use it both open AND closed (no size switching)
// Usage: node patch-fix35.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix35.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) align(): cache official clone in officialSvg
{
  const from = 'var px=5,py=13,calibrated=false;function align(){var logo=document.querySelector(".hHd-Xa_brandMark svg");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>0){px=r.left+r.width/2-22;py=r.top+r.height/2-22;calibrated=true;var cl=logo.cloneNode(true);cl.removeAttribute("id");cl.style.color="#d5d9e0";var ps=cl.querySelectorAll("path,ellipse,circle,polygon,rect");for(var i=0;i<ps.length;i++){if(ps[i].hasAttribute("fill"))ps[i].setAttribute("fill","#d5d9e0")}btn.innerHTML="";btn.appendChild(cl)}}';
  const to = 'var px=5,py=13,calibrated=false,officialSvg="";function align(){var logo=document.querySelector(".hHd-Xa_brandMark svg");if(!logo)return;var r=logo.getBoundingClientRect();if(r.width>0&&r.height>0&&r.left>0){px=r.left+r.width/2-22;py=r.top+r.height/2-22;calibrated=true;var cl=logo.cloneNode(true);cl.removeAttribute("id");cl.style.color="#d5d9e0";var ps=cl.querySelectorAll("path,ellipse,circle,polygon,rect");for(var i=0;i<ps.length;i++){if(ps[i].hasAttribute("fill"))ps[i].setAttribute("fill","#d5d9e0")}officialSvg=cl.outerHTML;btn.innerHTML=officialSvg}}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('officialSvg cache'); }
  else log.push('align: NOT FOUND');
}
// 2) sync else: use cached official, fallback to favicon only before first calibration
{
  const from = 'btn.innerHTML=whaleSvg;btn.style.left=px+"px";btn.style.top=py+"px"';
  const to = 'btn.innerHTML=officialSvg||whaleSvg;btn.style.left=px+"px";btn.style.top=py+"px"';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('sync uses cached official'); }
  else log.push('sync else: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
