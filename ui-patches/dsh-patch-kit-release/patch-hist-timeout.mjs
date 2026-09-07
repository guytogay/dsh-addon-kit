#!/usr/bin/env node
// patch-hist-timeout.mjs — unary RPC 超时 30s→120s（大历史页防中止）
// Usage: node patch-hist-timeout.mjs <dsh-client-connection/lib/client.js>
// USER 2026-09-07；幂等（dsh-hist-timeout 跳过）。
import { readFileSync, writeFileSync } from "node:fs";
const target = process.argv[2];
if (!target) { console.error("usage: node patch-hist-timeout.mjs <client.js>"); process.exit(1); }
let c = readFileSync(target, "utf8");
if (c.includes("dsh-hist-timeout")) { console.log("already patched, skip"); process.exit(0); }
const pat = /const DEFAULT_TIMEOUT_MS = 3e4;/;
if (!pat.test(c)) { console.error("ABORT: DEFAULT_TIMEOUT_MS pattern not found"); process.exit(1); }
c = c.replace(pat, "/* dsh-hist-timeout: unary 30s -> 120s (mobile big-history pages, USER 2026-09-07) */ const DEFAULT_TIMEOUT_MS = 1.2e5;");
writeFileSync(target, c);
console.log("patched OK");
