// patch-fix53.mjs — scope mobile treatment to touch devices: add (pointer: coarse) to media + JS guards
// Usage: node patch-fix53.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix53.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) media queries: add (pointer: coarse)
{
  const from = '@media(max-width:1024px)';
  const to = '@media(max-width:1024px) and (pointer: coarse)';
  const n = h.split(from).length - 1;
  if (n > 0) { h = h.split(from).join(to); log.push(`media coarse x${n}`); }
  else log.push('media 1024: NOT FOUND');
}
// 2) JS guards: skip on fine-pointer devices
{
  const from = 'if(window.innerWidth>1024)return;';
  const to = 'if(window.innerWidth>1024||matchMedia("(pointer: fine)").matches)return;';
  const n = h.split(from).length - 1;
  if (n > 0) { h = h.split(from).join(to); log.push(`guard coarse x${n}`); }
  else log.push('guard: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
