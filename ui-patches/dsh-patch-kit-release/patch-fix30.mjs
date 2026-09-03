// patch-fix30.mjs — calibration offset: +1.0 right (was +0.6), -0.5 up
// Usage: node patch-fix30.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix30.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'px=r.left+r.width/2-22+0.6;py=r.top+r.height/2-22-0.5;calibrated=true';
const to = 'px=r.left+r.width/2-22+1;py=r.top+r.height/2-22-0.5;calibrated=true';
if (!h.includes(from)) { console.error('align line NOT FOUND'); process.exit(1); }
if (h.includes('-22+1;py=r.top')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('offset +1.0/-0.5: applied');
