// patch-msgattach.mjs — render dsh-file-attach tokens (@emoji+name·size) as standalone cards
// Indentation-agnostic (regex-captured) so any build layout matches.
// Usage: node patch-msgattach.mjs <path-to-dsh-client-ui-conversation/lib/client.js>
import fs from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: node patch-msgattach.mjs <client.js>"); process.exit(1); }
let src = fs.readFileSync(file, "utf8");

const marker = "dsh-file-attach: attachment card";
if (src.includes(marker)) { console.log("already patched:", file); process.exit(0); }

// ── patch 1: tag our tokens as kind "fa" when collecting plain ranges ──
const re1 = /([ \t]*)if \(label\.length <= 1\) continue;\n([ \t]*)ranges\.push\(\{\n(?:\2[ \t]+[^\n]*\n)*?\2[ \t]*kind: "plain"\n([ \t]*)\}\);/;
const m1 = src.match(re1);
if (!m1) { console.error("patch1 anchor not found:", file); process.exit(2); }
const ind1 = m1[1];
const ind2 = m1[2];
const ind3 = m1[3];
const new1 = `${ind1}if (label.length <= 1) continue;
${ind2}// ${marker}: @emoji+name·size tokens from dsh-file-attach get kind "fa"
${ind2}const isFa = /^@[^\\s·]+·\\d+(?:\\.\\d+)?[KMG]?B$/u.test(label);
${ind2}ranges.push({
${ind2}\tstart: tokenStart,
${ind2}\tend: tokenStart + label.length,
${ind2}\tlabel,
${ind2}\tkind: isFa ? "fa" : "plain"
${ind3}});`;
src = src.replace(re1, new1);

// ── patch 2: render kind "fa" as a standalone card before the chip branch ──
const re2 = /([ \t]*)const referenceKind = kind === "session" \? "session" : label\.startsWith\("@"\) \? label\.endsWith\("\/"\) \? "folder" : "file" : void 0;/;
const m2 = src.match(re2);
if (!m2) { console.error("patch2 anchor not found:", file); process.exit(3); }
const ind = m2[1];
const card = `${ind}// ${marker}: standalone card block (icon / name / size), own styling
${ind}if (kind === "fa") {
${ind}\tconst fa = label.slice(1);
${ind}\tconst FA_ICONS = ["🎵", "🎬", "📄", "📊", "📝", "📁", "🖼️"];
${ind}\tlet icon = "";
${ind}\tlet rest = fa;
${ind}\tfor (const ic of FA_ICONS) {
${ind}\t\tif (fa.startsWith(ic)) { icon = ic; rest = fa.slice(ic.length); break; }
${ind}\t}
${ind}\tconst dot = rest.lastIndexOf("·");
${ind}\tconst name = dot > 0 ? rest.slice(0, dot) : rest;
${ind}\tconst size = dot > 0 ? rest.slice(dot + 1) : "";
${ind}\tparts.push((0, react_jsx_runtime.jsxs)("div", {
${ind}\t\tclassName: "dsh-fa-card",
${ind}\t\t"data-fa-card": "",
${ind}\t\ttitle: label,
${ind}\t\tchildren: [
${ind}\t\t\t(0, react_jsx_runtime.jsx)("span", { className: "dsh-fa-card-icon", children: icon }),
${ind}\t\t\t(0, react_jsx_runtime.jsxs)("span", { className: "dsh-fa-card-body", children: [
${ind}\t\t\t\t(0, react_jsx_runtime.jsx)("span", { className: "dsh-fa-card-name", children: name }),
${ind}\t\t\t\tsize === "" ? null : (0, react_jsx_runtime.jsx)("span", { className: "dsh-fa-card-size", children: "· " + size })
${ind}\t\t\t] })
${ind}\t\t]
${ind}\t}, tokenStart));
${ind}\tcursor = end;
${ind}\tcontinue;
${ind}}
${ind}const referenceKind = kind === "session" ? "session" : label.startsWith("@") ? label.endsWith("/") ? "folder" : "file" : void 0;`;
src = src.replace(re2, card);

fs.writeFileSync(file, src, "utf8");
console.log("patched OK:", file);
