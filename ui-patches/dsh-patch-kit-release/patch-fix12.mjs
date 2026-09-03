// patch-fix12.mjs — dialogs on top (z 1300) + whale button becomes close-X when drawer open
// Usage: node patch-fix12.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix12.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) mobile dialogs above sidebar
{
  const anchor = '._portal_19372_43{z-index:1300!important}';
  const add = '[role="dialog"]{z-index:1300!important}';
  if (h.includes(anchor)) {
    if (h.includes('[role="dialog"]{z-index:1300!important}')) { log.push('dialog z: already present'); }
    else { h = h.split(anchor).join(anchor + add); log.push('dialog z: 1300'); }
  } else log.push('portal anchor: NOT FOUND');
}
// 2) whale button z-index above sidebar (1210)
{
  const from = 'z-index:1195;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);touch-action:manipulation;opacity:.45;transition:opacity .18s';
  const to = 'z-index:1210;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);touch-action:manipulation;opacity:.45;transition:opacity .18s';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('btn z: 1210'); }
  else log.push('btn z: NOT FOUND');
}
// 3) openDr -> toggle (open when closed, close when open)
{
  const from = 'function openDr(){document.documentElement.setAttribute("data-dsh-drawer","open")}';
  const to = 'function openDr(){var e=document.documentElement;if(e.hasAttribute("data-dsh-drawer")){e.removeAttribute("data-dsh-drawer")}else{e.setAttribute("data-dsh-drawer","open")}}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('openDr: toggle'); }
  else log.push('openDr: NOT FOUND');
}
// 4) sync: whale when closed (left), X when open (right inside sidebar top)
{
  const from = 'function sync(){btn.style.display=document.documentElement.hasAttribute("data-dsh-drawer")?"none":"flex"}';
  const to = 'var closeSvg="<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 24 24\\" width=\\"18\\" height=\\"18\\"><path d=\\"M6 6l12 12M18 6L6 18\\" stroke=\\"currentColor\\" stroke-width=\\"2.5\\" fill=\\"none\\" stroke-linecap=\\"round\\"/></svg>";function sync(){if(document.documentElement.hasAttribute("data-dsh-drawer")){btn.style.display="flex";btn.style.left="auto";btn.style.right="8px";btn.innerHTML=closeSvg;btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.display="flex";btn.style.right="auto";btn.style.left="8px";btn.innerHTML=whaleSvg;btn.setAttribute("aria-label","展开侧边栏")}}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('sync: whale/X switch'); }
  else log.push('sync: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
