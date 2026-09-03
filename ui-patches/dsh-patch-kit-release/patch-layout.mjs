// patch-layout.mjs — keep sidebar wide on narrow viewports (avoid official deadlock on state toggle)
// Usage: node patch-layout.mjs <dsh-client-ui-layout/lib/client.js>
import fs from 'node:fs';

const [, , layoutPath] = process.argv;
if (!layoutPath) { console.error('usage: node patch-layout.mjs <layout/client.js>'); process.exit(1); }

let c = fs.readFileSync(layoutPath, 'utf8');
const changes = [];

// 1) init narrowExpanded true (sidebar starts wide; CSS hides it visually on mobile)
{
  const from = 'narrow: false,\n\t\t\t\tnarrowExpanded: false';
  const to = 'narrow: false,\n\t\t\t\tnarrowExpanded: true';
  if (c.includes(from)) { c = c.split(from).join(to); changes.push('init narrowExpanded=true'); }
  else changes.push('init: NOT FOUND');
}
// 2) setNarrow must not reset narrowExpanded (keep wide on narrow viewports)
{
  const from = '\t\t\t\t\td.narrow = narrow;\n\t\t\t\t\td.narrowExpanded = false;';
  const to = '\t\t\t\t\td.narrow = narrow;';
  if (c.includes(from)) { c = c.split(from).join(to); changes.push('setNarrow keeps expanded'); }
  else changes.push('setNarrow: NOT FOUND');
}
fs.writeFileSync(layoutPath, c);
console.log('layout/client.js:', changes.join(' | '));
