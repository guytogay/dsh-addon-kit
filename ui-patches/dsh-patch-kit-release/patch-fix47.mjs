// patch-fix47.mjs — raise mobile breakpoint 768 -> 1024 (landscape phones get the mobile treatment)
// Usage: node patch-fix47.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix47.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];
// media queries
{
  const from = '@media(max-width:768px)';
  const to = '@media(max-width:1024px)';
  const n = h.split(from).length - 1;
  if (n > 0) { h = h.split(from).join(to); log.push(`media 768->1024 x${n}`); }
  else log.push('media 768: NOT FOUND');
}
// script guard
{
  const from = 'if(window.innerWidth>768)return;';
  const to = 'if(window.innerWidth>1024)return;';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('script guard 1024'); }
  else log.push('script guard: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
