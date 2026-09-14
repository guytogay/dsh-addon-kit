// peer-effect-differential-guard.mjs — one behaviour, two implementations, no drift allowed.
//
// The product ships a reference observation primitive (tools/ena_peer_effect.py) and this Host runs
// its own native implementation inside the peer bridge. The owner's rule is that one function must
// not have two behaviours. This guard drives both on the same mutation and demands the same answer:
// same added / removed / modified sets, same completeness verdict. Any semantic drift goes red here
// instead of being discovered later on a real dispatch.
//
// It is deliberately not an equality check on record bytes: the two records have different shapes
// (the Python record carries per-entry kind and a full digest; the bridge record is compact), and a
// wire format was never promised. What must agree is the observation result.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
// The product checkout to compare against; set ENA_PRODUCT_REPO on your host.
const REPO = process.env.ENA_PRODUCT_REPO || '<path-to-ENA-checkout>';
const TOOL = `${REPO}/tools/ena_peer_effect.py`;
const ROOT = path.join(process.env.TEMP, 'peer-effect-differential');
const PY_SCOPE = path.join(ROOT, 'python-scope');
const JS_SCOPE = path.join(ROOT, 'bridge-scope');
const OUT = path.join(ROOT, 'records');
const token = fs.readFileSync(path.join(HERE, 'token.txt'), 'utf8').trim();

// The same declared mutation for both sides. Nothing else is allowed in either scope.
const CREATE = 'created-by-mutation.txt';
const DELETE = 'deleted-by-mutation.txt';
const MODIFY = 'modified-by-mutation.txt';

function reset() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const scope of [PY_SCOPE, JS_SCOPE]) {
    fs.mkdirSync(scope, { recursive: true });
    fs.writeFileSync(path.join(scope, DELETE), 'here before the mutation\n');
    fs.writeFileSync(path.join(scope, MODIFY), 'before\n');
    fs.writeFileSync(path.join(scope, 'untouched.txt'), 'never changes\n');
  }
  fs.mkdirSync(OUT, { recursive: true });
}

function py(args) { return execFileSync('python', args, { encoding: 'utf8' }); }

reset();

// ---- side A: the product reference tool -----------------------------------------------------
const beforeFile = path.join(OUT, 'before.json');
py([TOOL, 'snapshot', '--scope', PY_SCOPE, '--out', beforeFile]);
fs.writeFileSync(path.join(PY_SCOPE, CREATE), 'created\n');
fs.unlinkSync(path.join(PY_SCOPE, DELETE));
fs.writeFileSync(path.join(PY_SCOPE, MODIFY), 'after\n');
const pyReceipt = JSON.parse(py([TOOL, 'record', '--before', beforeFile,
  '--correlation-id', 'differential-guard', '--out', path.join(OUT, 'record.json')]).trim());
const pyRecord = JSON.parse(fs.readFileSync(path.join(OUT, 'record.json'), 'utf8'));

// ---- side B: this Host's native implementation, through a real dispatch ----------------------
const client = new Client({ name: 'peer-effect-differential', version: '1.0.0' });
const PEER_URL = process.env.DSH_PEER_URL || 'http://127.0.0.1:39480/mcp';
await client.connect(new StreamableHTTPClientTransport(new URL(PEER_URL),
  { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
const goal = `In ${JS_SCOPE} do exactly three things and nothing else: (1) create ${CREATE} `
  + `containing the line created; (2) delete ${DELETE}; (3) overwrite ${MODIFY} so it contains the `
  + `line after. Do not create, delete or modify anything else. Then reply with the single word DONE.`;
const res = await client.callTool({ name: 'run_task', arguments: { workspace: JS_SCOPE, goal } });
const dispatch = JSON.parse(res.content[0].text);
const jsRecord = JSON.parse(fs.readFileSync(dispatch.workRecord.record, 'utf8'));

// ---- compare semantics ----------------------------------------------------------------------
const normalise = (list) => [...list].sort().join('|');
const only = (list) => list.filter((name) => [CREATE, DELETE, MODIFY].includes(name));
const rows = [];
const compare = (label, pyValue, jsValue) => {
  const same = pyValue === jsValue;
  rows.push({ label, same, python: pyValue, bridge: jsValue });
  console.log(`${same ? 'MATCH  ' : 'DRIFT  '} ${label}\n         python: ${pyValue}\n         bridge: ${jsValue}`);
};

console.log(`scope: ${Object.keys(pyRecord.before).length} files before the mutation\n`);
compare('added (declared names only)', normalise(only(pyRecord.effects.added)),
  normalise(only(jsRecord.effects.added)));
compare('removed', normalise(pyRecord.effects.removed), normalise(jsRecord.effects.removed));
compare('modified (declared names only)', normalise(only(pyRecord.effects.modified)),
  normalise(only(jsRecord.effects.modified)));
compare('completeness verdict', String(pyRecord.complete), String(jsRecord.complete));

// The undeclared-scope case is where the two implementations disagreed once: this side reported
// zero counts, which reads as "nothing changed" for an observation that never happened. The
// independent implementation reported counts: null with NOT_OBSERVED. Both must now agree.
const res2 = await client.callTool({ name: 'run_task',
  arguments: { goal: 'Reply with exactly the word DONE and change nothing.' } });
const undeclared = JSON.parse(res2.content[0].text);
const jsUndeclared = undeclared.workRecord || {};
compare('undeclared scope: counts are null, not zero', 'null', String(jsUndeclared.counts));
compare('undeclared scope: countsMeaning', 'NOT_OBSERVED', String(jsUndeclared.countsMeaning));
compare('undeclared scope: complete is false', 'false', String(jsUndeclared.complete));

const extras = jsRecord.effects.added.concat(jsRecord.effects.modified)
  .filter((name) => ![CREATE, DELETE, MODIFY].includes(name));
console.log(`\nunexpected files the dispatched session touched inside the scope: ${extras.length ? extras.join(', ') : 'none'}`);
console.log(`python receipt counts: added ${pyReceipt.added_count}, removed ${pyReceipt.removed_count}, modified ${pyReceipt.modified_count}`);
const drifted = rows.filter((row) => !row.same);
console.log(drifted.length ? `\nDRIFT DETECTED in ${drifted.length} field(s)` : '\nno drift: both implementations report the same observation');
process.exit(drifted.length ? 1 : 0);
