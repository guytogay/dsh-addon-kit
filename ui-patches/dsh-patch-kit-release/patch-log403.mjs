// patch-log403.mjs — log 403 details in ws-explorer/ws-file handlers
// Usage: node patch-log403.mjs <client-connection/index.js>
import fs from 'node:fs';

const [, , connPath] = process.argv;
if (!connPath) { console.error('usage: node patch-log403.mjs <client-connection/index.js>'); process.exit(1); }

let c = fs.readFileSync(connPath, 'utf8');
const oldLine = 'if (!wsTrust(req)) { res.writeHead(403); res.end("forbidden"); return; }';
if (!c.includes(oldLine)) { console.error('old 403 line NOT FOUND'); process.exit(1); }

const labels = ['ws-explorer', 'ws-file'];
let count = 0;
for (const label of labels) {
  const newLine = `if (!wsTrust(req)) { ctx.logger.warn(${JSON.stringify(label + ' 403')} + " host=" + req.headers["host"] + " origin=" + req.headers["origin"] + " sfs=" + req.headers["sec-fetch-site"] + " url=" + req.url); res.writeHead(403); res.end("forbidden"); return; }`;
  c = c.replace(oldLine, newLine);
  count++;
}
fs.writeFileSync(connPath, c);
console.log(`403 logging: applied to ${count} handlers`);
