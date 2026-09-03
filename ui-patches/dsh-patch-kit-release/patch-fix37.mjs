// patch-fix37.mjs — fully hardcode: official logo SVG + fixed position; remove calibration machinery
// Usage: node patch-fix37.mjs <index.html> <official-svg.txt>
import fs from 'node:fs';

const [, , htmlPath, svgPath] = process.argv;
if (!htmlPath || !svgPath) { console.error('usage: node patch-fix37.mjs <index.html> <official-svg.txt>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
let svg = fs.readFileSync(svgPath, 'utf8').trim();
// strip the CDP wrapper (the script prints the outerHTML; ensure it is the svg element)
if (!svg.startsWith('<svg')) { const m = svg.match(/<svg[\s\S]*<\/svg>/); if (m) svg = m[0]; else { console.error('no svg found in input'); process.exit(1); } }
// give paths a light fill (they inherit fill="none" otherwise -> invisible on dark button)
svg = svg.replace(/<path d=/g, '<path fill="#d5d9e0" d=');
if (svg.includes("'")) { console.error('svg contains single quote — unsafe for inline string'); process.exit(1); }

const log = [];

// 1) replace the favicon whaleSvg definition with the official SVG
{
  const re = /var whaleSvg='<svg[\s\S]*?<\/svg>';/;
  if (re.test(h)) { h = h.replace(re, `var whaleSvg='${svg}';`); log.push('whaleSvg = official'); }
  else log.push('whaleSvg def: NOT FOUND');
}
// 2) button inline position -> fixed (6,14)
{
  const from = 'position:fixed;left:5px;top:max(env(safe-area-inset-top,0px) + 4px,13px);width:44px;height:44px';
  const to = 'position:fixed;left:6px;top:max(env(safe-area-inset-top,0px) + 4px,14px);width:44px;height:44px';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('pos (6,14)'); }
  else log.push('inline pos: NOT FOUND');
}
// 3) sync: drop calibration entirely — only aria-label toggles
{
  const re = /var px=5,py=13,calibrated=false,officialSvg="";try\{[\s\S]*?btn\.style\.display="flex"\}/;
  const to = 'function sync(){btn.setAttribute("aria-label",document.documentElement.hasAttribute("data-dsh-drawer")?"收起侧边栏":"展开侧边栏");btn.style.display="flex"}';
  if (re.test(h)) { h = h.replace(re, to); log.push('sync simplified (no calibration)'); }
  else log.push('sync block: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
