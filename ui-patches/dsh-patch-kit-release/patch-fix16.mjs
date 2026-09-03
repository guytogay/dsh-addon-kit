// patch-fix16.mjs — clicking the whale button must not trigger the outside-click close
// Usage: node patch-fix16.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix16.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'if(e.target.closest&&e.target.closest("[role=dialog],[role=menu],[role=listbox],[role=alertdialog],[aria-modal=true]"))return;closeDrawer()';
const to = 'if(e.target.closest&&e.target.closest("[role=dialog],[role=menu],[role=listbox],[role=alertdialog],[aria-modal=true]"))return;if(e.target.closest&&e.target.closest("[aria-label=\\"展开侧边栏\\"],[aria-label=\\"收起侧边栏\\"]"))return;closeDrawer()';
if (!h.includes(from)) { console.error('click listener NOT FOUND'); process.exit(1); }
if (h.includes('aria-label=\\"展开侧边栏\\"')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('whale-click exclude: applied');
