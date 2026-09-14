// peer-effect-responsiveness-guard.mjs — the observation must not stall the peer server.
//
// Found by an independent verifier: it pointed a dispatch at a large scope, the synchronous hashing
// blocked the event loop, and every other request waited (~7.3 s for a bare `initialize`, against
// 9-34 ms when idle). The snapshot now runs in a worker thread with a budget. This guard keeps it
// that way: it starts an observation over a deliberately large scope and measures how long an
// unrelated request takes while that observation is in flight.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';

const token = fs.readFileSync(path.join(import.meta.dirname, 'token.txt'), 'utf8').trim();
const make = async () => {
  const client = new Client({ name: 'responsiveness-guard', version: '1.0.0' });
  const PEER_URL = process.env.DSH_PEER_URL || 'http://127.0.0.1:39480/mcp';
await client.connect(new StreamableHTTPClientTransport(new URL(PEER_URL),
    { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  return client;
};

const client = await make();
const big = 3;   // repeat to expose a loop that is blocked for seconds

const timed = async (label, fn) => {
  const t = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`${label}: ${ms.toFixed(1)} ms`);
  return { ms, value };
};

console.log('baseline while idle:');
await timed('  get_status', () => client.callTool({ name: 'get_status', arguments: {} }));

console.log('\nstarting a large-scope dispatch, then measuring an unrelated request:');
const dispatch = client.callTool({
  name: 'run_task',
  arguments: {
    workspace: process.env.ENA_GUARD_SCOPE || '<path-to-a-large-directory-to-observe>',
    goal: 'Reply with exactly the word DONE. Do not create, modify or delete anything.',
  },
});
const probes = [];
for (let i = 0; i < big; i += 1) {
  const r = await timed(`  get_status during observation #${i + 1}`, () =>
    client.callTool({ name: 'get_status', arguments: {} }));
  probes.push(r.ms);
}
const result = JSON.parse((await dispatch).content[0].text);
console.log(`\ndispatch finished: status=${result.status} scope_status=${result.workRecord?.scope_status}`
  + ` complete=${result.workRecord?.complete} counts=${JSON.stringify(result.workRecord?.counts)}`);
console.log(`worst unrelated request during the observation: ${Math.max(...probes).toFixed(1)} ms`);
const ok = Math.max(...probes) < 2000;
console.log(ok ? 'RESPONSIVE: the observation did not block the server'
               : 'BLOCKED: an unrelated request waited seconds for the observation to finish');
process.exit(ok ? 0 : 1);
