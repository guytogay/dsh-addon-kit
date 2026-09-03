// patch-whale-fix.mjs — mount whale button/edge after body exists (head-injected script bug)
// Usage: node patch-whale-fix.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-whale-fix.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'document.body.appendChild(btn);document.body.appendChild(edge)';
const to = '(function mount(){var b=document.body;if(!b){return setTimeout(mount,50)}b.appendChild(btn);b.appendChild(edge)})()';
if (!h.includes(from)) { console.error('appendChild site NOT FOUND'); process.exit(1); }
if (h.includes('function mount()')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('mount fix: applied');
