// patch-fix22.mjs — calibration offset: +0.5 right, -0.2 up (fine tune)
// Usage: node patch-fix22.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix22.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'px=r.left+r.width/2-22+1;py=r.top+r.height/2-22;calibrated=true';
const to = 'px=r.left+r.width/2-22+0.5;py=r.top+r.height/2-22-0.2;calibrated=true';
if (!h.includes(from)) { console.error('align line NOT FOUND'); process.exit(1); }
if (h.includes('+0.5;py=r.top')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('offset +0.5/-0.2: applied');
