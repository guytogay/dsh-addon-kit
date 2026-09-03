// patch-fix42.mjs — debug tag shows BOTH button center and logo center for comparison
// Usage: node patch-fix42.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix42.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'function showDbg(nx,ny){var dbg=document.getElementById("dshWhaleDbg");if(!dbg){dbg=document.createElement("div");dbg.id="dshWhaleDbg";dbg.style.cssText="position:fixed;right:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,.78);color:#ffd75e;font-size:13px;padding:5px 10px;border-radius:6px;display:none;font-family:monospace";document.body.appendChild(dbg)}dbg.style.display="block";dbg.textContent="whale: "+nx.toFixed(2)+", "+ny.toFixed(2)}';
const to = 'function showDbg(){var dbg=document.getElementById("dshWhaleDbg");if(!dbg){dbg=document.createElement("div");dbg.id="dshWhaleDbg";dbg.style.cssText="position:fixed;right:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,.78);color:#ffd75e;font-size:13px;padding:5px 10px;border-radius:6px;display:none;font-family:monospace";document.body.appendChild(dbg)}var br=btn.getBoundingClientRect();var logo=document.querySelector(".hHd-Xa_brandMark svg");var lr=logo?logo.getBoundingClientRect():null;dbg.style.display="block";dbg.textContent="btnC:"+Math.round(br.x+br.width/2)+","+Math.round(br.y+br.height/2)+" logoC:"+(lr?Math.round(lr.left+lr.width/2)+","+Math.round(lr.top+lr.height/2):"?")}';
if (!h.includes(from)) { console.error('showDbg NOT FOUND'); process.exit(1); }
if (h.includes('btnC:')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('center-compare debug: applied');
