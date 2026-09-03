// patch-fix2.mjs — fix auto-collapse done flag (first-expand flicker) + sidebar width 280px
// Usage: node patch-fix2.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix2.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) tc(): lock done as soon as elements are ready, whether or not we collapse
{
  const from = 'function tc(){if(done)return;var s=document.querySelector(".pI_x6G_sidebarCol");var t=document.querySelector(".hHd-Xa_toggle");if(!s||!t)return;if(!s.querySelector(".hHd-Xa_collapsed")){t.click();done=true}}';
  const to = 'function tc(){var s=document.querySelector(".pI_x6G_sidebarCol");var t=document.querySelector(".hHd-Xa_toggle");if(!s||!t)return;if(!s.querySelector(".hHd-Xa_collapsed")){t.click()}done=true}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('tc done-lock: applied'); }
  else log.push('tc done-lock: NOT FOUND');
}
// 2) sidebar expanded width: 84vw/320px -> 80vw/280px (desktop native width)
{
  const from = 'width:min(84vw,320px)!important;box-shadow:0 0 24px rgba(0,0,0,.35);transition:transform .18s ease';
  const to = 'width:min(80vw,280px)!important;box-shadow:0 0 24px rgba(0,0,0,.35);transition:transform .18s ease';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('width 280px: applied'); }
  else log.push('width 280px: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
