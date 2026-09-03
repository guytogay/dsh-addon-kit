// patch-fix14.mjs — when any dialog is open, demote sidebar z-index to 50 (dialog always on top)
// Usage: node patch-fix14.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix14.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'if(dlg){if(s){s.style.setProperty("transition","none","important");s.style.setProperty("transform","none","important")}}else if(s){s.style.removeProperty("transform");s.style.removeProperty("transition");s.style.zIndex="";s.style.display=""}';
const to = 'if(dlg){if(s){s.style.setProperty("transition","none","important");s.style.setProperty("transform","none","important");s.style.zIndex="50"}}else if(s){s.style.removeProperty("transform");s.style.removeProperty("transition");s.style.zIndex="";s.style.display=""}';
if (!h.includes(from)) { console.error('observer block NOT FOUND'); process.exit(1); }
if (h.includes('s.style.zIndex="50"}')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('dialog z-demote: applied');
