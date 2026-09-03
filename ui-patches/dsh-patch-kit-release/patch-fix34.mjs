// patch-fix34.mjs — calibrate only when logo fully in viewport (left>0), never mid-animation
// Usage: node patch-fix34.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix34.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'if(r.width>0&&r.height>0&&r.left>-200){';
const to = 'if(r.width>0&&r.height>0&&r.left>0){';
if (!h.includes(from)) { console.error('align condition NOT FOUND'); process.exit(1); }
if (h.includes('r.width>0&&r.height>0&&r.left>0){')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('viewport-gated calibration: applied');
