// patch-refchip-css.mjs — v5: add .dsh-fa-card styles for attachment cards
import fs from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: node patch-refchip-css.mjs <index.html>"); process.exit(1); }
let src = fs.readFileSync(file, "utf8");

const markerV5 = "dsh-file-attach: attachment card styles";
if (src.includes(markerV5)) { console.log("already patched (v5):", file); process.exit(0); }

const styled = `<style>/* ${markerV5} */.dsh-fa-card{display:flex;align-items:center;gap:8px;margin:6px 0;padding:8px 12px;border-radius:10px;background:var(--dsw-alias-fill-3,rgba(255,255,255,.07));max-width:min(68vw,300px);min-width:0;text-align:left}.dsh-fa-card-icon{font-size:20px;flex:none;line-height:1}.dsh-fa-card-body{display:flex;flex-direction:column;gap:2px;min-width:0}.dsh-fa-card-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:16px}.dsh-fa-card-size{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:14px}</style>`;

if (!src.includes("</head>")) { console.error("</head> not found:", file); process.exit(2); }
src = src.replace("</head>", styled + "</head>");
fs.writeFileSync(file, src, "utf8");
console.log("patched OK (v5):", file);
