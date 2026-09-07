#!/usr/bin/env node
// patch-parallel-load.mjs — 插件加载并行化（同级依赖 Promise.all）
// Usage: node patch-parallel-load.mjs <dsh-client-modules/lib/client.js>
// USER 2026-09-07/08；幂等（dsh-parallel-load 标记跳过）；不匹配即中止。
import { readFileSync, writeFileSync } from "node:fs";
const target = process.argv[2];
if (!target) { console.error("usage: node patch-parallel-load.mjs <client.js>"); process.exit(1); }
let c = readFileSync(target, "utf8");
if (c.includes("dsh-parallel-load")) { console.log("already patched, skip"); process.exit(0); }
const pat = /for \(const request of row\.external\) \{\s*const id = stripClientSuffix\(request\);\s*if \(this\.seed\.has\(request\) \|\| this\.loadCache\.has\(id\)\) continue;\s*const dependency = this\.graphRows\.get\(id\);\s*if \(dependency !== void 0\) await this\.arriveGraphRow\(dependency, next\);\s*\}/;
const m = c.match(pat);
if (!m) { console.error("ABORT: arrival loop pattern not found"); process.exit(1); }
const rep = `const depTasks = [];
				for (const request of row.external) {
					const id = stripClientSuffix(request);
					if (this.seed.has(request) || this.loadCache.has(id)) continue;
					const dependency = this.graphRows.get(id);
					if (dependency !== void 0) depTasks.push(this.arriveGraphRow(dependency, next));
				}
				/* dsh-parallel-load: independent sibling deps fetch concurrently (44 plugins serial -> parallel) */
				if (depTasks.length > 0) await Promise.all(depTasks);`;
c = c.replace(pat, rep);
writeFileSync(target, c);
console.log("patched OK");
