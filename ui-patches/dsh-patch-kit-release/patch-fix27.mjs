// patch-fix27.mjs — calibration offset: +0.4 right, -0.4 up (was -0.3)
// Usage: node patch-fix27.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix27.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'px=r.left+r.width/2-22+0.4;py=r.top+r.height/2-22-0.3;calibrated=true';
const to = 'px=r.left+r.width/2-22+0.4;py=r.top+r.height/2-22-0.4;calibrated=true';
if (!h.includes(from)) { console.error('align line NOT FOUND'); process.exit(1); }
if (h.includes('-22+0.4;py=r.top+r.height/2-22-0.4')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('offset +0.4/-0.4: applied');
