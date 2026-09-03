// patch-fix10.mjs — remove :has() (perf) -> observer uses setProperty(...,'important') inline
// Usage: node patch-fix10.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix10.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) remove the :has() rule (continuous DOM scanning on mobile)
{
  const from = 'html:has(.VOzbGW_overlay) .pI_x6G_sidebarCol{transform:none!important;transition:none!important}';
  if (h.includes(from)) { h = h.split(from).join(''); log.push(':has rule: removed'); }
  else log.push(':has rule: NOT FOUND');
}
// 2) observer: setProperty with important (beats stylesheet !important), removeProperty on close
{
  const from = 'if(dlg){if(s){s.style.transition="none";s.style.transform="none"}}else if(s){s.style.transform="";s.style.zIndex="";s.style.display="";s.style.transition=""}';
  const to = 'if(dlg){if(s){s.style.setProperty("transition","none","important");s.style.setProperty("transform","none","important")}}else if(s){s.style.removeProperty("transform");s.style.removeProperty("transition");s.style.zIndex="";s.style.display=""}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('observer: setProperty important'); }
  else log.push('observer: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
