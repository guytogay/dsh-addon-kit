// patch-fix13.mjs — whale button always visible & always whale icon; position switches only
// Usage: node patch-fix13.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix13.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'var closeSvg="<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 24 24\\" width=\\"18\\" height=\\"18\\"><path d=\\"M6 6l12 12M18 6L6 18\\" stroke=\\"currentColor\\" stroke-width=\\"2.5\\" fill=\\"none\\" stroke-linecap=\\"round\\"/></svg>";function sync(){if(document.documentElement.hasAttribute("data-dsh-drawer")){btn.style.display="flex";btn.style.left="auto";btn.style.right="8px";btn.innerHTML=closeSvg;btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.display="flex";btn.style.right="auto";btn.style.left="8px";btn.innerHTML=whaleSvg;btn.setAttribute("aria-label","展开侧边栏")}}';
const to = 'function sync(){if(document.documentElement.hasAttribute("data-dsh-drawer")){btn.style.display="flex";btn.style.left="auto";btn.style.right="8px";btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.display="flex";btn.style.right="auto";btn.style.left="8px";btn.setAttribute("aria-label","展开侧边栏")}}';
if (!h.includes(from)) { console.error('sync block NOT FOUND'); process.exit(1); }
if (!h.includes('var closeSvg=')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('whale-always: applied');
