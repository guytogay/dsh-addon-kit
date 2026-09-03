// patch-fix49.mjs — re-enable official toggle (intercepted to close drawer) + auto-collapse on session select
// Usage: node patch-fix49.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix49.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) remove pointer-events:none from official toggle
{
  const from = 'html[data-dsh-drawer="open"] .pI_x6G_sidebarCol{transform:translateX(0)!important}.hHd-Xa_toggle{pointer-events:none}';
  const to = 'html[data-dsh-drawer="open"] .pI_x6G_sidebarCol{transform:translateX(0)!important}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('toggle re-enabled'); }
  else log.push('toggle css: NOT FOUND (maybe already removed)');
}
// 2) inject interception script after the auto-collapse block
{
  const marker = '<!-- dsh-whale-toggle -->';
  const anchor = '<!-- /dsh-auto-collapse -->';
  if (h.includes(marker)) { log.push('script: already present'); }
  else if (h.includes(anchor)) {
    const snippet = `<!-- dsh-whale-toggle --><script>(function(){if(window.innerWidth>1024)return;document.addEventListener("click",function(e){var t=e.target;if(t&&t.closest&&t.closest(".hHd-Xa_toggle")){e.preventDefault();e.stopPropagation();document.documentElement.removeAttribute("data-dsh-drawer");return}if(t&&t.closest&&t.closest("[aria-label^=\\"会话\\"]")){document.documentElement.removeAttribute("data-dsh-drawer")}},true)})();</script><!-- /dsh-whale-toggle -->\n`;
    h = h.replace(anchor, anchor + '\n' + snippet);
    log.push('script: toggle + session-collapse');
  } else log.push('auto-collapse anchor: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
