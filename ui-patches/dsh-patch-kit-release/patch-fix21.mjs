// patch-fix21.mjs — calibration offset adjust: keep +1 right, remove the -1 up (user says move down)
// Usage: node patch-fix21.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix21.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'px=r.left+r.width/2-22+1;py=r.top+r.height/2-22-1;calibrated=true';
const to = 'px=r.left+r.width/2-22+1;py=r.top+r.height/2-22;calibrated=true';
if (!h.includes(from)) { console.error('align line NOT FOUND'); process.exit(1); }
if (h.includes('py=r.top+r.height/2-22;calibrated')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('offset now +1 right / 0 vertical: applied');
