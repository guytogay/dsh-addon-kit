// patch-deliverables.mjs — mobile fixes for dsh-client-ui-deliverables
// Usage: node patch-deliverables.mjs <client.js path> <index.html path>
import fs from 'node:fs';

const [, , clientPath, htmlPath] = process.argv;
if (!clientPath || !htmlPath) { console.error('usage: node patch-deliverables.mjs <client.js> <index.html>'); process.exit(1); }

let c = fs.readFileSync(clientPath, 'utf8');
let changed = [];

// 1) measure(): never re-collapse once expanded
{
  const from = 'const measure = () => {';
  const to = 'const measure = () => { if (row.style.flexWrap === "wrap") return;';
  if (c.includes(from)) { c = c.split(from).join(to); changed.push('measure guard'); }
  else changed.push('measure guard: NOT FOUND');
}

// 2) "+N 个文件" span -> expand button
{
  const re = /hidden > 0 && \(0, react_jsx_runtime\.jsx\)\("span", \{\s*className: ProducedFiles_module_css_default\.more,\s*children: moreLabel\(t, hidden\)\s*\}\)/;
  const to = `hidden > 0 && (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: ProducedFiles_module_css_default.more,
						onClick: () => {
							const row = rowRef.current;
							if (row) { row.style.flexWrap = "wrap"; row.setAttribute("data-expanded", "true"); }
							setShownCount(limit);
						},
						children: moreLabel(t, hidden)
					})`;
  if (re.test(c)) { c = c.replace(re, to); changed.push('more->expand button'); }
  else changed.push('more->expand button: NOT FOUND');
}

// 3) show-in-folder: open the real produced-files directory
{
  const from = 'openFile(".")';
  const to = 'openFile(dirname(paths[0]))';
  if (c.includes(from)) { c = c.split(from).join(to); changed.push('showFolder dirname'); }
  else changed.push('showFolder dirname: NOT FOUND');
}

// 4) dirname() helper after basename()
{
  const re = /(function basename\(path\) \{\s*const at = Math\.max\(path\.lastIndexOf\("\/"\), path\.lastIndexOf\("\\\\"\)\);\s*return at === -1 \? path : path\.slice\(at \+ 1\);\s*\})/;
  const helper = `$1
		/**
		* Directory of a path, for opening the produced-files folder.
		* @param path - Slash- or backslash-separated path.
		* @returns The containing directory, or the root when at the root.
		*/
		function dirname(path) {
			const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\\\"));
			if (at === -1) return path;
			if (at === 0) return path.slice(0, 1);
			if (at === 2 && path.charCodeAt(1) === 58) return path.slice(0, 3);
			return path.slice(0, at);
		}`;
  if (re.test(c)) { c = c.replace(re, helper); changed.push('dirname helper'); }
  else changed.push('dirname helper: NOT FOUND');
}

fs.writeFileSync(clientPath, c);
console.log('client.js:', changed.join(' | '));

// 5) CSS injection into index.html (idempotent, marked)
let h = fs.readFileSync(htmlPath, 'utf8');
const marker = 'dsh-deliverables-mobile';
if (h.includes(marker)) {
  console.log('index.html: css already injected, skipped');
} else {
  const css = `<!-- ${marker} --><style>.P4kPIW_more{cursor:pointer;text-decoration:underline}.P4kPIW_row[data-expanded="true"]{flex-wrap:wrap!important;overflow:visible!important}.P4kPIW_row[data-expanded="true"] .P4kPIW_file{max-width:100%}</style><!-- /${marker} -->`;
  if (h.includes('</head>')) { h = h.replace('</head>', css + '</head>'); fs.writeFileSync(htmlPath, h); console.log('index.html: css injected'); }
  else console.log('index.html: </head> NOT FOUND');
}
