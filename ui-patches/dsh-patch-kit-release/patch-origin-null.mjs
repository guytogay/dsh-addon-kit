// patch-origin-null.mjs — allow `Origin: null` (mobile PWA top-level navigation) in ws-explorer trust check
// Usage: node patch-origin-null.mjs <client-connection/index.js>
import fs from 'node:fs';

const [, , connPath] = process.argv;
if (!connPath) { console.error('usage: node patch-origin-null.mjs <client-connection/index.js>'); process.exit(1); }

let c = fs.readFileSync(connPath, 'utf8');
const from = '	const wsTrust = (req) => isTrustedApiRequest(req, trustedHosts);';
const to = '	const wsTrust = (req) => req.headers["origin"] === "null" ? isTrustedApiRequest({ headers: Object.assign({}, req.headers, { origin: void 0 }) }, trustedHosts) : isTrustedApiRequest(req, trustedHosts);';
if (!c.includes(from)) { console.error('wsTrust line NOT FOUND'); process.exit(1); }
if (c.includes('origin: void 0')) { console.log('already patched'); process.exit(0); }
c = c.replace(from, to);
fs.writeFileSync(connPath, c);
console.log('origin-null allowance: applied');
