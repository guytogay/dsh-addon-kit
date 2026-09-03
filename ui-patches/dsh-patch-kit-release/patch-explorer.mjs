// patch-explorer.mjs — web file explorer endpoints + remote-open behavior for deliverables
// Usage: node patch-explorer.mjs <client-connection/index.js> <deliverables/client.js>
import fs from 'node:fs';

const [, , connPath, delivPath] = process.argv;
if (!connPath || !delivPath) { console.error('usage: node patch-explorer.mjs <client-connection/index.js> <deliverables/client.js>'); process.exit(1); }

let c = fs.readFileSync(connPath, 'utf8');
const changes = [];

// ---- host: inject ws-explorer/ws-file routes after the /api route registration ----
const anchor = 'ctx.effect(() => ctx.webServer.register(route), "client-connection: /api route");';
if (!c.includes(anchor)) { console.error('host anchor NOT FOUND'); process.exit(1); }
if (c.includes('ws-explorer route')) {
  changes.push('host routes: already present');
} else {
  const routes = `
	/* dsh-ws-explorer: web file browsing & preview (trusted-host only, for remote/mobile clients). */
	const wsTrust = (req) => isTrustedApiRequest(req, trustedHosts);
	const wsAbs = (s) => process.platform === "win32" ? /^(?:[A-Za-z]:[\\\\/]|[\\\\/]{2}[^\\\\/]+[\\\\/]+[^\\\\/]+)/.test(s) : s.startsWith("/");
	const wsEsc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\\"", "&quot;");
	const wsExplorerRoute = {
		kind: "prefix",
		path: "/ws-explorer/",
		handler: async (req, res) => {
			if (!wsTrust(req)) { res.writeHead(403); res.end("forbidden"); return; }
			const url = new URL(req.url, "http://x");
			const raw = url.searchParams.get("path");
			if (raw === null || !wsAbs(raw)) { res.writeHead(400); res.end("bad path"); return; }
			const { opendir, stat } = await import("node:fs/promises");
			const { basename, dirname, resolve } = await import("node:path");
			const abs = resolve(raw);
			try {
				const st = await stat(abs);
				if (!st.isDirectory()) { res.writeHead(302, { location: "/ws-file/?path=" + encodeURIComponent(abs) }); res.end(); return; }
				const dir = await opendir(abs);
				const dirs = [];
				const files = [];
				for await (const d of dir) { if (d.isDirectory()) dirs.push(d.name); else if (d.isFile()) files.push(d.name); }
				dirs.sort((a, b) => a.localeCompare(b));
				files.sort((a, b) => a.localeCompare(b));
				const crumbs = [];
				let cur = abs;
				for (;;) { const parent = dirname(cur); crumbs.unshift({ name: parent === cur ? cur : basename(cur), path: cur }); if (parent === cur) break; cur = parent; }
				const rows = dirs.map((n) => "<li><a class=\\"item d\\" href=\\"/ws-explorer/?path=" + encodeURIComponent(resolve(abs, n)) + "\\">📁 " + wsEsc(n) + "</a></li>").concat(files.map((n) => "<li><a class=\\"item f\\" href=\\"/ws-file/?path=" + encodeURIComponent(resolve(abs, n)) + "\\">📄 " + wsEsc(n) + "</a></li>")).join("");
				const crumbHtml = crumbs.map((cr) => "<a href=\\"/ws-explorer/?path=" + encodeURIComponent(cr.path) + "\\">" + wsEsc(cr.name) + "</a>").join("<span>/</span>");
				const html = "<!doctype html><html lang=\\"zh-CN\\"><head><meta charset=\\"utf-8\\"><meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\"><title>" + wsEsc(basename(abs)) + " — DSH 文件</title><style>:root{color-scheme:light dark}body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:14px;max-width:760px;margin-inline:auto}h1{font-size:15px;margin:0 0 8px;opacity:.9;word-break:break-all}nav{display:flex;flex-wrap:wrap;align-items:center;gap:2px;font-size:13px;opacity:.85;margin-bottom:10px;word-break:break-all}nav a{color:inherit;text-decoration:none}nav span{margin:0 4px}ul{list-style:none;padding:0;margin:0}a.item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:8px;text-decoration:none;color:inherit;font-size:14px;word-break:break-all}a.item:hover{background:rgba(128,128,128,.15)}a.d{font-weight:600}</style></head><body><h1>" + wsEsc(abs) + "</h1><nav>" + crumbHtml + "</nav><ul>" + rows + "</ul></body></html>";
				res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				res.end(html);
			} catch (error) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("not found: " + wsEsc(error instanceof Error ? error.message : String(error)));
			}
		}
	};
	ctx.effect(() => ctx.webServer.register(wsExplorerRoute), "client-connection: ws-explorer route");
	const wsFileRoute = {
		kind: "prefix",
		path: "/ws-file/",
		handler: async (req, res) => {
			if (!wsTrust(req)) { res.writeHead(403); res.end("forbidden"); return; }
			const url = new URL(req.url, "http://x");
			const raw = url.searchParams.get("path");
			if (raw === null || !wsAbs(raw)) { res.writeHead(400); res.end("bad path"); return; }
			const { readFile, stat } = await import("node:fs/promises");
			const { basename, resolve } = await import("node:path");
			const abs = resolve(raw);
			try {
				const st = await stat(abs);
				if (!st.isFile()) { res.writeHead(302, { location: "/ws-explorer/?path=" + encodeURIComponent(abs) }); res.end(); return; }
				const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
				const types = { ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8", ".ps1": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" };
				const ct = types[ext];
				const data = await readFile(abs);
				if (ct !== void 0) res.writeHead(200, { "content-type": ct, "content-length": data.length, "cache-control": "no-store" });
				else res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=\\"" + wsEsc(basename(abs)) + "\\"", "content-length": data.length, "cache-control": "no-store" });
				res.end(data);
			} catch (error) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("not found: " + wsEsc(error instanceof Error ? error.message : String(error)));
			}
		}
	};
	ctx.effect(() => ctx.webServer.register(wsFileRoute), "client-connection: ws-file route");
`;
  c = c.replace(anchor, anchor + routes);
  changes.push('host routes: injected');
}
fs.writeFileSync(connPath, c);
console.log('client-connection/index.js:', changes.join(' | '));

// ---- client: remote open behavior in deliverables ----
let d = fs.readFileSync(delivPath, 'utf8');
const dChanges = [];

const fileRe = /onClick: \(\) => \{\s*openFile\(path\);\s*\},/;
const fileTo = `onClick: () => {
							if (!/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)) { window.open("/ws-file/?path=" + encodeURIComponent(path), "_blank", "noopener"); return; }
							openFile(path);
						},`;
if (fileRe.test(d)) { d = d.replace(fileRe, fileTo); dChanges.push('file chip remote branch'); }
else dChanges.push('file chip remote branch: NOT FOUND');

const dirRe = /onClick: \(\) => \{\s*openFile\(dirname\(paths\[0\]\)\);\s*\},/;
const dirTo = `onClick: () => {
							if (!/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)) { window.open("/ws-explorer/?path=" + encodeURIComponent(dirname(paths[0])), "_blank", "noopener"); return; }
							openFile(dirname(paths[0]));
						},`;
if (dirRe.test(d)) { d = d.replace(dirRe, dirTo); dChanges.push('showFolder remote branch'); }
else dChanges.push('showFolder remote branch: NOT FOUND');

fs.writeFileSync(delivPath, d);
console.log('deliverables/client.js:', dChanges.join(' | '));
