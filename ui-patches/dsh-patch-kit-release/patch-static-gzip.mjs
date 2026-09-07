#!/usr/bin/env node
// patch-static-gzip.mjs — 前端静态响应 gzip（dist 回退件：index/manifest/图标等）
// Usage: node patch-static-gzip.mjs <dsh-host-frontend-static/lib/index.js>
// USER 2026-09-07；幂等（dsh-gzip 标记）；只压 text/*、json、manifest+json、svg。
import { readFileSync, writeFileSync } from "node:fs";
const target = process.argv[2];
if (!target) { console.error("usage: node patch-static-gzip.mjs <index.js>"); process.exit(1); }
let c = readFileSync(target, "utf8");
if (c.includes("dsh-gzip")) { console.log("already patched, skip"); process.exit(0); }
c = c.replace('import { readFile } from "node:fs/promises";', 'import { readFile } from "node:fs/promises";\nimport { gzipSync } from "node:zlib";');
const sigPat = /async function serveStatic\(pathname, res, distRoot, distIndex, renderIndex\) \{/;
if (!sigPat.test(c)) { console.error("ABORT: serveStatic signature not found"); process.exit(1); }
c = c.replace(sigPat, "async function serveStatic(pathname, res, distRoot, distIndex, renderIndex, req = void 0) {");
const endPat = /res\.writeHead\(200, \{ "content-type": type \}\);\s*res\.end\(body\);/;
if (!endPat.test(c)) { console.error("ABORT: response end block not found"); process.exit(1); }
const rep = `	/* dsh-gzip: compress compressible static responses when the client accepts gzip (heavy mobile bundle loads). */
	if (req !== void 0 && /gzip/.test(String(req.headers["accept-encoding"] ?? "")) && (type.startsWith("text/") || type === "application/json" || type === "application/manifest+json" || type === "image/svg+xml")) {
		const zipped = gzipSync(body, { level: 6 });
		if (zipped.length < body.length) {
			res.writeHead(200, { "content-type": type, "content-encoding": "gzip", "vary": "Accept-Encoding" });
			res.end(zipped);
			return;
		}
	}
	res.writeHead(200, { "content-type": type });
	res.end(body);`;
c = c.replace(endPat, rep);
const callPat = /await serveStatic\(decodeURIComponent\(rawPath\), res, distRoot, distIndex, renderIndex\);/;
if (!callPat.test(c)) { console.error("ABORT: call site not found"); process.exit(1); }
c = c.replace(callPat, "await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex, req);");
writeFileSync(target, c);
console.log("patched OK");
