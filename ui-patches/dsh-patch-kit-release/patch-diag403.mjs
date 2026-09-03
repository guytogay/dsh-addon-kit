// patch-diag403.mjs — make ws-explorer/ws-file 403 responses carry request diagnostics
// Usage: node patch-diag403.mjs <client-connection/index.js>
import fs from 'node:fs';

const [, , connPath] = process.argv;
if (!connPath) { console.error('usage: node patch-diag403.mjs <client-connection/index.js>'); process.exit(1); }

let c = fs.readFileSync(connPath, 'utf8');
// match the whole wsTrust 403 statement (with or without the logger preamble) inside ws handlers
const re = /if \(!wsTrust\(req\)\) \{ (?:ctx\.logger\.warn\([^;]+\); )?res\.writeHead\(403\); res\.end\("forbidden"\); return; \}/g;
const matches = c.match(re);
if (!matches || matches.length === 0) { console.error('wsTrust 403 statements NOT FOUND'); process.exit(1); }
const replacement = (m) => m.replace('res.writeHead(403); res.end("forbidden"); return; }', 'res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end("forbidden | host=" + req.headers["host"] + " | origin=" + req.headers["origin"] + " | sfs=" + req.headers["sec-fetch-site"]); return; }');
c = c.replace(re, replacement);
fs.writeFileSync(connPath, c);
console.log(`diag403: applied to ${matches.length} ws handlers`);
