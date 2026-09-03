// patch-explorer-fix.mjs — content sniffing for unknown extensions in ws-file
// Usage: node patch-explorer-fix.mjs <client-connection/index.js>
import fs from 'node:fs';

const [, , connPath] = process.argv;
if (!connPath) { console.error('usage: node patch-explorer-fix.mjs <client-connection/index.js>'); process.exit(1); }

let c = fs.readFileSync(connPath, 'utf8');
const oldBlock = `				const ct = types[ext];
				const data = await readFile(abs);
				if (ct !== void 0) res.writeHead(200, { "content-type": ct, "content-length": data.length, "cache-control": "no-store" });
				else res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=\\"" + wsEsc(basename(abs)) + "\\"", "content-length": data.length, "cache-control": "no-store" });`;
const newBlock = `				const data = await readFile(abs);
				let ct = types[ext];
				if (ct === void 0) {
					const head = data.subarray(0, 512);
					ct = head.includes(0) ? "application/octet-stream" : "text/plain; charset=utf-8";
				}
				if (ct === "application/octet-stream") res.writeHead(200, { "content-type": ct, "content-disposition": "attachment; filename=\\"" + wsEsc(basename(abs)) + "\\"", "content-length": data.length, "cache-control": "no-store" });
				else res.writeHead(200, { "content-type": ct, "content-length": data.length, "cache-control": "no-store" });`;

if (!c.includes(oldBlock)) { console.error('sniff block NOT FOUND — was the explorer patch applied?'); process.exit(1); }
c = c.replace(oldBlock, newBlock);
fs.writeFileSync(connPath, c);
console.log('sniffing: applied');
