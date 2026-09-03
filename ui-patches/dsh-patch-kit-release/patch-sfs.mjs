// patch-sfs.mjs — ignore Sec-Fetch-Site for ws-explorer/ws-file (Chrome PWA window.open marks cross-site)
// Host + Origin checks remain the trust boundary. Usage: node patch-sfs.mjs <client-connection/index.js>
import fs from 'node:fs';

const [, , connPath] = process.argv;
if (!connPath) { console.error('usage: node patch-sfs.mjs <client-connection/index.js>'); process.exit(1); }

let c = fs.readFileSync(connPath, 'utf8');
const from = '	const wsTrust = (req) => req.headers["origin"] === "null" ? isTrustedApiRequest({ headers: Object.assign({}, req.headers, { origin: void 0 }) }, trustedHosts) : isTrustedApiRequest(req, trustedHosts);';
const to = '	const wsTrust = (req) => { const h = Object.assign({}, req.headers); if (h["sec-fetch-site"] === "cross-site") delete h["sec-fetch-site"]; if (h["origin"] === "null") delete h["origin"]; return isTrustedApiRequest({ headers: h }, trustedHosts); };';
if (!c.includes(from)) { console.error('wsTrust line NOT FOUND'); process.exit(1); }
if (c.includes('h["sec-fetch-site"]')) { console.log('already patched'); process.exit(0); }
c = c.replace(from, to);
fs.writeFileSync(connPath, c);
console.log('sfs ignore: applied');
