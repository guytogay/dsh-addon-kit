// patch-location.mjs — navigate in-window instead of new tab for ws-file/ws-explorer
// Usage: node patch-location.mjs <deliverables/client.js>
import fs from 'node:fs';

const [, , delivPath] = process.argv;
if (!delivPath) { console.error('usage: node patch-location.mjs <deliverables/client.js>'); process.exit(1); }

let d = fs.readFileSync(delivPath, 'utf8');
const changes = [];

const fileFrom = 'window.open("/ws-file/?path=" + encodeURIComponent(path), "_blank", "noopener"); return; }';
const fileTo = 'location.assign("/ws-file/?path=" + encodeURIComponent(path)); return; }';
if (d.includes(fileFrom)) { d = d.split(fileFrom).join(fileTo); changes.push('file -> location.assign'); }
else changes.push('file window.open: NOT FOUND');

const dirFrom = 'window.open("/ws-explorer/?path=" + encodeURIComponent(dirname(paths[0])), "_blank", "noopener"); return; }';
const dirTo = 'location.assign("/ws-explorer/?path=" + encodeURIComponent(dirname(paths[0]))); return; }';
if (d.includes(dirFrom)) { d = d.split(dirFrom).join(dirTo); changes.push('showFolder -> location.assign'); }
else changes.push('showFolder window.open: NOT FOUND');

fs.writeFileSync(delivPath, d);
console.log('deliverables/client.js:', changes.join(' | '));
