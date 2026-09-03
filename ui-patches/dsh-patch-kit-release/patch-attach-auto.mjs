// patch-attach-auto.mjs — append auto-carry reference line to composer on upload success
// Usage: node patch-attach-auto.mjs <path-to-client.js>
import fs from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: node patch-attach-auto.mjs <client.js>"); process.exit(1); }
let src = fs.readFileSync(file, "utf8");

const marker = `// Auto-carry: append the reference line to the composer`;
if (src.includes(marker)) { console.log("already patched:", file); process.exit(0); }

const oldBlock = `						.then((value) => {
							updateChip(uid, { status: "ready", progress: 100, path: value.path, kind: value.kind });
							addReadyFile(sessionId, {
								ref: value.path,
								name: value.name,
								path: value.path,
								kind: value.kind,
								size: value.size,
							});
						})`;

const newBlock = `						.then((value) => {
							updateChip(uid, { status: "ready", progress: 100, path: value.path, kind: value.kind });
							addReadyFile(sessionId, {
								ref: value.path,
								name: value.name,
								path: value.path,
								kind: value.kind,
								size: value.size,
							});
							${marker}
							// so the file ships with the message without needing "@".
							if (input && typeof input.value === "string") {
								const line = buildBlock(value, zh);
								const cur = input.value || "";
								input.value = cur + (cur ? "\\n" : "") + line;
								input.dispatchEvent(new Event("input", { bubbles: true }));
							}
						})`;

if (!src.includes(oldBlock)) { console.error("pattern not found in:", file); process.exit(2); }
src = src.replace(oldBlock, newBlock);

// onFiles deps must include input so the closure sees the live element
const depOld = `}, [api, inputActions, sessionId, zh, updateChip, conversation]);`;
const depNew = `}, [api, inputActions, sessionId, zh, updateChip, conversation, input]);`;
if (!src.includes(depOld)) { console.error("deps pattern not found in:", file); process.exit(3); }
src = src.replace(depOld, depNew);

fs.writeFileSync(file, src, "utf8");
console.log("patched OK:", file);
