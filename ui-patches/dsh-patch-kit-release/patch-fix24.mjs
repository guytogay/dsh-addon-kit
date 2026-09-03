// patch-fix24.mjs — calibration offset: -0.1 right (was +0.2), -0.2 up
// Usage: node patch-fix24.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix24.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'px=r.left+r.width/2-22+0.2;py=r.top+r.height/2-22-0.2;calibrated=true';
const to = 'px=r.left+r.width/2-22-0.1;py=r.top+r.height/2-22-0.2;calibrated=true';
if (!h.includes(from)) { console.error('align line NOT FOUND'); process.exit(1); }
if (h.includes('-22-0.1;py=r.top')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('offset -0.1/-0.2: applied');
