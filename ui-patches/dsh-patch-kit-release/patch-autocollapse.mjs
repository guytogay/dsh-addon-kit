// patch-autocollapse.mjs — mobile: auto-collapse sidebar on page load
// Usage: node patch-autocollapse.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-autocollapse.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
if (h.includes('dsh-auto-collapse')) { console.log('already patched'); process.exit(0); }

const marker = '<!-- /dsh-mobile-opt -->';
if (!h.includes(marker)) { console.error('dsh-mobile-opt end marker NOT FOUND'); process.exit(1); }

const snippet = `<!-- dsh-auto-collapse --><script>(function(){if(window.innerWidth>768)return;var done=false;function tc(){if(done)return;var s=document.querySelector(".pI_x6G_sidebarCol");var t=document.querySelector(".hHd-Xa_toggle");if(!s||!t)return;if(!s.querySelector(".hHd-Xa_collapsed")){t.click();done=true}}setTimeout(tc,600);setTimeout(tc,2000);setTimeout(tc,5000)})();</script><!-- /dsh-auto-collapse -->\n`;

h = h.replace(marker, snippet + marker);
fs.writeFileSync(htmlPath, h);
console.log('auto-collapse: injected');
