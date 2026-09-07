#!/usr/bin/env node
// patch-api-gzip.mjs — /api unary JSON + /plugins 包响应 gzip（v5：扩展 GET /plugins，typed-array 安全 + 头合并 + 日志）
// Usage: node patch-api-gzip.mjs <dsh-host-webserver/lib/index.js>
// USER 2026-09-08；幂等（dsh-gzip-v4 标记）；只压 POST /api/ + application/json；SSE/WS/ZIP 不触。
// 注意：需重启 web 服务生效；调试日志 %TEMP%/dsh-gzip-dbg.log。
import { readFileSync, writeFileSync } from "node:fs";
const target = process.argv[2];
if (!target) { console.error("usage: node patch-api-gzip.mjs <index.js>"); process.exit(1); }
let c = readFileSync(target, "utf8");
if (c.includes("wrapApiResponse")) { console.log("already patched, skip"); process.exit(0); }
c = c.replace('import { createServer } from "node:http";', 'import { createServer } from "node:http";\nimport { appendFileSync } from "node:fs";\nimport { gzipSync } from "node:zlib";');
const wrapper = `function wrapApiResponse(req, res) {
	const path = String(req.url ?? "").split("?", 1)[0];
	const isApi = req.method === "POST" && path.startsWith("/api/") && !path.startsWith("/api/events");
	const isPlugin = req.method === "GET" && path.startsWith("/plugins/");
	if ((!isApi && !isPlugin) || !/gzip/.test(String(req.headers["accept-encoding"] ?? ""))) return res;
	let stashedStatus, stashedHeaders;
	const origWriteHead = res.writeHead.bind(res);
	const origEnd = res.end.bind(res);
	const parts = [];
	const toBuf = (x) => Buffer.isBuffer(x) ? x : ArrayBuffer.isView(x) ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : Buffer.from(String(x));
	const dbg = (line) => { try { appendFileSync(process.env.TEMP + "/dsh-gzip-dbg.log", line + "\\n"); } catch (e) {} };
	res.writeHead = (status, headers) => { stashedStatus = status; if (headers !== void 0) stashedHeaders = headers; return res; };
	res.write = (...args) => { if (args[0] != null) parts.push(toBuf(args[0])); return true; };
	res.end = (chunk, enc, cb) => {
		try {
			if (res.writableEnded) return;
			if (chunk != null) parts.push(toBuf(chunk));
			const body = Buffer.concat(parts);
			const status = stashedStatus ?? res.statusCode ?? 200;
			let live; try { live = res.getHeaders(); } catch (e2) { live = {}; }
			const headers = { ...(stashedHeaders ?? {}), ...live };
			const ct = String(headers["content-type"] ?? "");
			let mode = "plain";
			if (body.length >= 1024 && (ct.startsWith("application/json") || ct.startsWith("text/javascript") || ct.startsWith("text/html"))) {
				const gz = gzipSync(body, { level: 6 });
				if (gz.length < body.length) {
					const out = { ...headers, "content-encoding": "gzip", vary: "Accept-Encoding" };
					delete out["content-length"];
					origWriteHead(status, out);
					origEnd(gz);
					mode = "gzip";
					dbg("[" + new Date().toISOString() + "] " + path + " parts=" + parts.length + " body=" + body.length + " gz=" + gz.length + " MODE=gzip");
					return;
				}
			}
			if (res.headersSent) { origEnd(body); return; }
			origWriteHead(status, headers);
			origEnd(body);
			dbg("[" + new Date().toISOString() + "] " + path + " parts=" + parts.length + " body=" + body.length + " ct=" + ct + " MODE=" + mode);
		} catch (e) {
			try { if (!res.headersSent) origWriteHead(stashedStatus ?? 500, stashedHeaders ?? {}); } catch (e3) {}
			try { return origEnd(chunk, enc, cb); } catch (e4) { return void 0; }
		}
	};
	return res;
}`;
const anchor = 'this.server = createServer((req, res) => {';
if (c.split(anchor).length - 1 !== 1) { console.error("ABORT: createServer anchor"); process.exit(1); }
c = c.replace(anchor, "/* dsh-gzip-v4: typed-array-safe buffered gzip for POST /api JSON (+header merge + debug log). USER 2026-09-08. */\n" + wrapper + "\n" + anchor);
c = c.replace('handle(req, res).catch(', 'handle(req, wrapApiResponse(req, res)).catch(');
writeFileSync(target, c);
console.log("patched OK (restart required)");
