// peer-mcp-server.mjs — PC 端 DSH 跨机 MCP 桥 server（契约 v1.3，§3-§8）
// 绑定本端 tailnet IP <PC_TAILSCALE_IP>:39480，/mcp；fail-closed Bearer 鉴权（令牌 = peer-mcp/token.txt 或 DSH_PEER_TOKEN）
// 工具：get_status / query_sessions / run_task（run_task 经 dsh --profile headless <goal> 执行）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { prepareGoal, CONTEXT_CHAR_LIMIT, WORKSPACE_CHAR_LIMIT } from './peer-goal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = await import('zod');

// Bind address and advertised hostname come from the environment: a reusable bridge must not
// hardcode one machine's address. DSH_PEER_BIND defaults to loopback.
const HOST = process.env.DSH_PEER_BIND || '127.0.0.1';
const PORT = 39480;
const INSTANCE_ID = 'pc-dsh';
const HOSTNAME = process.env.DSH_PEER_HOSTNAME || 'localhost';
const DSH_VERSION = (() => {
  try {
    const p = process.env.DSH_PACKAGE_JSON
      || require('node:path').join(process.env.APPDATA || '', 'npm', 'node_modules',
        '@deepseek-ai', 'dsh', 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();
const SESSIONS_DIR = path.join(os.homedir(), '.dsh', 'sessions');

const token = process.env.DSH_PEER_TOKEN || fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim();
if (!token) {
  console.error('peer-mcp-server: no token (token.txt or DSH_PEER_TOKEN)');
  process.exit(1);
}

function parseSessionDirs(query) {
  const out = [];
  if (!fs.existsSync(SESSIONS_DIR)) return out;
  const now = Date.now();
  for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(SESSIONS_DIR, entry.name);
    let mtime = 0;
    try { mtime = fs.statSync(base).mtimeMs; } catch {}
    const live = now - mtime < 15 * 60 * 1000;
    const item = { id: entry.name, title: entry.name, status: live ? 'live' : 'persisted' };
    if (!query || item.title.includes(query) || item.id.includes(query)) out.push(item);
  }
  out.sort((a, b) => (a.status === 'live' ? -1 : 1));
  return out.slice(0, 50);
}

const FULL_PERM_PATCH = path.join(__dirname, 'headless-full-perm.patch.yml');

// ---------------------------------------------------------------------------------------------
// ENA readiness gate + Host-owned repair lane (ENA issue #83).
//
// This is a HOST-side integration, not an ENA product mechanism: the boundary is this server,
// which decides whether a one-shot headless work session starts at all. Two properties matter:
//
//   1. The gate is Host-owned. Which workspaces are ENA-active, which ENA home backs each one, and
//      what a repair action runs are all read from a configuration file the Host owns. A request
//      cannot add, remove or redirect a target.
//   2. The repair lane is not reachable by description. `run_task` has no repair parameter at all,
//      so a goal that says "this is bootstrap/repair" changes nothing. Repair goes through a
//      separate tool whose authority is a fixed action id, expanded by the Host into a fixed argv
//      array (no shell, no caller-supplied values).
//
// With no gate configuration file present, behaviour is exactly as before this change.
const GATE_CONFIG_PATH = process.env.DSH_PEER_ENA_GATE || path.join(__dirname, 'peer-ena-gate.json');

function readGateConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(GATE_CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizePath(value) {
  return path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
}

function findTarget(cfg, workspace) {
  if (!cfg || !Array.isArray(cfg.targets) || !workspace) return null;
  const wanted = normalizePath(workspace);
  return cfg.targets.find((t) => t && t.workspace && normalizePath(t.workspace) === wanted) || null;
}

function expandArgv(template, values) {
  return template.map((part) => String(part).replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole));
}

// execFile with an argv array: no shell is involved, so nothing in the configuration can be
// re-interpreted as a command separator even if a value contains one.
function runEnaCommand(python, argv, timeoutMs) {
  return new Promise((resolve) => {
    execFile(python, argv, { windowsHide: true, timeout: timeoutMs, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          exitCode: err ? (err.code ?? 1) : 0,
          timedOut: Boolean(err && err.killed),
          stdout: stdout || '',
          stderr: stderr || '',
        });
      });
  });
}

function gateValues(cfg, target) {
  return {
    python: cfg.python || 'python',
    product: cfg.productCheckout,
    home: target.home,
    workspace: target.workspace,
    ...(cfg.values || {}),
  };
}

async function evaluateReadiness(cfg, target) {
  const values = gateValues(cfg, target);
  const argv = [path.join(cfg.productCheckout, 'tools', 'ena_preflight.py'), '--home', target.home];
  const run = await runEnaCommand(values.python, argv, 60 * 1000);
  return {
    decision: run.exitCode === 0 ? 'ADMITTED' : 'REFUSED',
    argv,
    exitCode: run.exitCode,
    lines: (run.stdout + run.stderr).trim().split(/\r?\n/).filter(Boolean).slice(0, 12),
  };
}

// ---------------------------------------------------------------------------------------------
// Effect record for dispatched peer work.
//
// A bridge records the request and the session's own closing prose. Neither says what the session
// created, changed or deleted. Measured: a dispatched task created one file and deleted another and
// the only trace anywhere was the missing file. This records the effect, produced by the HOST from
// the declared scope, so it does not depend on the session telling the truth or telling anything.
//
// Scope is what the caller declares: the `workspace` of the request. A request that declares no
// scope is recorded as SCOPE_UNDECLARED rather than silently unrecorded - you cannot account for a
// scope you never named.
const WORK_RECORD_DIR = path.join(os.homedir(), '.dsh', 'peer-work');
// Peer identity is asserted by the token holder (bearer + tailnet), not cryptographically verified,
// so the record says exactly that instead of implying a verified caller.
const PEER_CALLER_ASSERTED = process.env.DSH_PEER_CALLER || 'token-holder (asserted, not verified)';
const HASH_LIMIT_BYTES = 1024 * 1024;        // hash small files; for larger ones size+mtime is recorded
const HASH_TOTAL_CAP = 256 * 1024 * 1024;    // stop hashing after this much content, and say so
const MAX_ENTRIES = 50000;

// The walk must not run on the server's event loop. It did once: an independent verifier pointed a
// dispatch at a large scope, the synchronous hash blocked the loop, and other peer requests stalled
// (~7 s for `initialize`, against 9-34 ms when idle). The observation now runs in a worker thread
// with a wall-clock budget, so the server keeps answering while it works.
const SNAPSHOT_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HASH_LIMIT_BYTES = ${HASH_LIMIT_BYTES};
const HASH_TOTAL_CAP = ${HASH_TOTAL_CAP};
const MAX_ENTRIES = ${MAX_ENTRIES};
const DEADLINE = Date.now() + workerData.budgetMs;

function walk(dir, prefix, depth, state) {
  if (Date.now() > DEADLINE) { state.capped = true; state.notes.push('time budget reached'); return; }
  if (depth > 24) return;
  let listing;
  try { listing = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { state.notes.push('unreadable ' + (prefix || '.') + ': ' + e.code); return; }
  for (const entry of listing) {
    if (state.entries >= MAX_ENTRIES) { state.capped = true; state.notes.push('entry cap reached'); return; }
    const full = path.join(dir, entry.name);
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    let stat;
    try { stat = fs.lstatSync(full); } catch (e) { state.notes.push('unreadable ' + rel); continue; }
    if (stat.isDirectory()) { walk(full, rel, depth + 1, state); continue; }
    state.entries += 1;
    if (stat.isSymbolicLink()) {
      let target = '?';
      try { target = fs.readlinkSync(full); } catch (e) { state.notes.push('unreadable symlink ' + rel); }
      state.manifest[rel] = 'link->' + target;
      continue;
    }
    let digest = 'NOHASH';
    if (stat.size <= HASH_LIMIT_BYTES && state.hashedBytes + stat.size <= HASH_TOTAL_CAP) {
      try {
        digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
        state.hashedBytes += stat.size;
      } catch (e) { state.notes.push('unhashable ' + rel + ': ' + e.code); }
    } else {
      digest = stat.size > HASH_LIMIT_BYTES ? 'TOO_LARGE' : 'CAP_REACHED';
      state.capped = true;
    }
    state.manifest[rel] = stat.size + ':' + Math.round(stat.mtimeMs) + ':' + digest;
  }
}

const state = { manifest: {}, notes: [], entries: 0, hashedBytes: 0, capped: false };
const scope = workerData.scope;
if (!scope) {
  parentPort.postMessage({ declared: false, manifest: {}, notes: [], capped: false, complete: false });
} else {
  let resolved = null;
  try { resolved = path.resolve(String(scope)); } catch (e) { /* unresolvable below */ }
  if (!resolved) {
    parentPort.postMessage({ declared: true, manifest: {}, notes: ['scope unresolvable'], capped: true, complete: false });
  } else if (!fs.existsSync(resolved)) {
    parentPort.postMessage({ declared: true, resolved, manifest: {}, notes: ['scope missing: ' + resolved], capped: true, complete: false });
  } else {
    walk(resolved, '', 0, state);
    parentPort.postMessage({
      declared: true, resolved, manifest: state.manifest, notes: state.notes,
      count: state.entries, capped: state.capped, complete: !state.capped && state.notes.length === 0,
    });
  }
}
`;

function snapshotScope(scope, budgetMs = 20000) {
  return new Promise((resolve) => {
    const incomplete = (notesList) => ({ declared: Boolean(scope), manifest: {}, notes: notesList,
                                         capped: true, complete: false });
    let worker;
    try {
      worker = new Worker(SNAPSHOT_WORKER_SOURCE, { eval: true, workerData: { scope, budgetMs } });
    } catch (err) {
      resolve(incomplete([`worker unavailable: ${err.message}`]));
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      resolve(value);
    };
    worker.on('message', finish);
    worker.on('error', (err) => finish(incomplete([`worker error: ${err.message}`])));
    worker.on('exit', (code) => { if (code !== 0) finish(incomplete([`worker exited ${code}`])); });
    setTimeout(() => finish(incomplete(['observation timed out'])), budgetMs + 5000).unref();
  });
}

function diffManifests(before, after) {
  const added = [];
  const removed = [];
  const modified = [];
  for (const key of Object.keys(after.manifest)) {
    if (!(key in before.manifest)) added.push(key);
    else if (before.manifest[key] !== after.manifest[key]) modified.push(key);
  }
  for (const key of Object.keys(before.manifest)) {
    if (!(key in after.manifest)) removed.push(key);
  }
  // Vocabulary matches the product reference tool: added / removed / modified. The differential guard compares the two, so a different word for the same idea is a drift, not a style choice.
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

function writeWorkRecord(entry) {
  try {
    fs.mkdirSync(WORK_RECORD_DIR, { recursive: true });
    const file = path.join(WORK_RECORD_DIR, `${entry.taskId || 'task-' + Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(entry, null, 2));
    fs.appendFileSync(path.join(WORK_RECORD_DIR, 'index.jsonl'), JSON.stringify({
      ts: entry.ts_start,
      taskId: entry.taskId,
      caller: entry.caller,
      status: entry.status,
      scope: entry.scope,
      scope_declared: entry.scope_declared,
      added: entry.effects ? entry.effects.added.length : null,
      modified: entry.effects ? entry.effects.modified.length : null,
      removed: entry.effects ? entry.effects.removed.length : null,
      record: file,
    }) + '\n');
    return file;
  } catch (e) {
    return `UNWRITTEN: ${e.code}`;
  }
}

function runHeadless(goal, context, workspace) {
  return new Promise((resolve) => {
    const taskId = 'task-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const timeoutMs = 30 * 60 * 1000;
    // 防注入：goal 中的命令控制符过滤（tailnet + 令牌双闸，仍按契约§8 加固）
    // 投递保真：过滤/切片语义逐字不动，只把两处静默变更变成可见 + 原文落盘（见 peer-goal.mjs）
    const { safe, meta } = prepareGoal(taskId, goal);
    const env = { ...process.env };
    if (context) env.DSH_PEER_CONTEXT = String(context).slice(0, CONTEXT_CHAR_LIMIT);
    if (workspace) env.DSH_PEER_WORKSPACE = String(workspace).slice(0, WORKSPACE_CHAR_LIMIT);
    const child = execFile(
      'cmd.exe',
      ['/d', '/c', 'dsh', '--profile', 'headless', '--patch', FULL_PERM_PATCH, safe],
      { env, windowsHide: true, timeout: timeoutMs, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          resolve({ taskId, status: 'timeout', result: (stdout || '') + (stderr || ''), exitCode: null, ...meta });
        } else if (err) {
          resolve({ taskId, status: 'failed', result: (stdout || '') + (stderr || String(err)).slice(0, 1000), exitCode: err.code ?? 1, ...meta });
        } else {
          resolve({ taskId, status: 'done', result: stdout || '', exitCode: 0, ...meta });
        }
      },
    );
  });
}

function makeMcpServer() {
  const server = new McpServer({ name: 'pc-dsh-peer-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.registerTool('get_status', {
    description: '活性+身份探测',
    inputSchema: z.object({}),
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ instanceId: INSTANCE_ID, host: HOSTNAME, version: DSH_VERSION, liveSessionCount: parseSessionDirs().filter((s) => s.status === 'live').length }) }],
  }));

  server.registerTool('query_sessions', {
    description: '列出本机 live / persisted session',
    inputSchema: z.object({ query: z.string().optional() }),
  }, async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(parseSessionDirs(args.query)) }],
  }));

  server.registerTool('run_task', {
    description: '执行一个 headless 任务（dsh --profile headless <goal>），返回 stdout。'
      + '投递上限（契约 v1.6.2，超限可见）：goal 取前 2000 个 UTF-16 字符（按字符，不按字节），'
      + 'context 4000（仅写入环境变量 DSH_PEER_CONTEXT，当前无消费者、不进 prompt），workspace 500。'
      + 'goal 会先做命令控制符过滤（" ` ^ < > & | ; % ! → 空格），换行 → 空格（CRLF 对整体变一个空格，每处净 -1 字符）。'
      + 'goal 原文超过 2000 字符时，过滤前原文自动落盘到 $DSH_HOME/peer-inbox/<taskId>.md（只读取件、不执行），'
      + '返回体带 goalSourceChars / goalCharsKept / goalTruncated / goalFilterApplied / goalSpillPath。'
      + '长文请只发 ≤2000 字符的任务卡，全文走 spill 取件；不要依赖反引号与换行做结构。',
    inputSchema: z.object({
      goal: z.string(),
      context: z.string().optional(),
      workspace: z.string().optional(),
    }),
  }, async (args) => {
    // ENA readiness gate. Applies only to workspaces the Host has registered as ENA-active; for
    // every other workspace the path below is unchanged. The decision is made BEFORE a session
    // starts, and nothing the caller wrote takes part in it.
    const cfg = readGateConfig();
    const target = findTarget(cfg, args.workspace);
    if (target) {
      const readiness = await evaluateReadiness(cfg, target);
      if (readiness.decision === 'REFUSED') {
        // A refusal is peer work that did not happen. It belongs in the same ledger as the work that
        // did, with no effects, so the initiator can reconcile "what I asked for" against
        // "what this Host did or did not do" from one place.
        const refusalRecord = writeWorkRecord({
          taskId: 'refused-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
          ts_start: new Date().toISOString(),
          ts_end: new Date().toISOString(),
          caller: PEER_CALLER_ASSERTED,
          channel: 'a2a',
          goal: args.goal,
          workspace: args.workspace ?? null,
          scope: target.home,
          scope_declared: Boolean(args.workspace),
          status: 'refused',
          decision: readiness.decision,
          preflight_exit: readiness.exitCode,
          effects: null,
          note: 'no session was started; no effect was possible',
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              taskId: null,
              status: 'refused',
              gate: 'ena_readiness',
              decision: 'ORDINARY_WORK_REFUSED',
              workspace: target.workspace,
              home: target.home,
              preflightExitCode: readiness.exitCode,
              preflightLines: readiness.lines,
              workRecord: refusalRecord,
              repairLane: 'call run_repair_action with a Host-registered workspace and an '
                + 'allowlisted action id; describing this task as repair does not open the lane',
            }),
          }],
        };
      }
    } else if (cfg && cfg.unregisteredPolicy === 'refuse' && args.workspace) {
      // Host-owned closure of the "work somewhere unregistered" hole. A request that names no
      // workspace at all is the peer coordination channel, not ENA-active work, so it still passes.
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            taskId: null,
            status: 'refused',
            gate: 'ena_workspace_classification',
            decision: 'WORKSPACE_NOT_CLASSIFIED',
            workspace: args.workspace,
            registeredWorkspaces: (cfg.targets || []).map((t) => t.workspace),
            note: 'the Host has set unregisteredPolicy=refuse: a workspace must be registered as '
              + 'ENA-active (gated) or the request must carry no workspace (coordination channel)',
          }),
        }],
      };
    }
    const before = await snapshotScope(args.workspace);
    const tsStart = new Date().toISOString();
    const r = await runHeadless(args.goal, args.context, args.workspace);
    const after = await snapshotScope(args.workspace);
    // "Undefined scope" is NOT "nothing changed". Reporting zero counts for an observation that never
    // happened would read as a clean result. An independent implementation of the same semantics
    // reports counts: null with NOT_OBSERVED and complete: false; this side now agrees, so the two
    // cannot be quoted for opposite conclusions.
    const effects = before.declared ? diffManifests(before, after) : null;
    const counts = effects
      ? { added: effects.added.length, removed: effects.removed.length, modified: effects.modified.length }
      : null;
    const countsMeaning = effects ? 'OBSERVED' : 'NOT_OBSERVED';
    const complete = Boolean(effects) && before.complete !== false && after.complete !== false;
    const recordPath = writeWorkRecord({
      taskId: r.taskId,
      ts_start: tsStart,
      ts_end: new Date().toISOString(),
      caller: PEER_CALLER_ASSERTED,
      channel: 'a2a',
      goal: args.goal,
      workspace: args.workspace ?? null,
      scope: args.workspace ? path.resolve(String(args.workspace)) : null,
      scope_declared: before.declared,
      scope_status: before.declared ? (before.notes.some((n) => n.startsWith('scope missing')) ? 'SCOPE_MISSING' : 'OBSERVED') : 'SCOPE_UNDECLARED',
      counts,
      counts_meaning: countsMeaning,
      complete,
      status: r.status,
      exitCode: r.exitCode,
      snapshot_notes: [...before.notes, ...after.notes],
      effects,
      manifests: before.declared ? { before: before.manifest, after: after.manifest } : null,
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...r,
          workRecord: {
            record: recordPath,
            scope: args.workspace ?? null,
            scope_declared: before.declared,
            scope_status: before.declared ? 'OBSERVED' : 'SCOPE_UNDECLARED',
            complete,
            counts,
            countsMeaning,
            added: effects ? effects.added.slice(0, 50) : null,
            modified: effects ? effects.modified.slice(0, 50) : null,
            removed: effects ? effects.removed.slice(0, 50) : null,
            note: effects
              ? 'effect list is produced by the Host from the declared scope, not reported by the session'
              : 'no scope was declared, so no effect was observed: null counts are NOT a claim that nothing changed',
          },
        }),
      }],
    };
  });

  // The initiator's half: fetch the record for a dispatch so the two sides can be reconciled.
  server.registerTool('get_work_record', {
    description: 'Return the Host-produced effect record for a dispatched task: what the declared '
      + 'scope lost, gained or changed, plus the dispatch facts. Independent of what the session said.',
    inputSchema: z.object({ taskId: z.string() }),
  }, async (args) => {
    const safe = String(args.taskId).replace(/[^A-Za-z0-9._-]/g, '');
    const file = path.join(WORK_RECORD_DIR, `${safe}.json`);
    if (!fs.existsSync(file)) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_found', taskId: args.taskId }) }] };
    }
    return { content: [{ type: 'text', text: fs.readFileSync(file, 'utf8') }] };
  });

  // Host-owned repair lane. The caller chooses a registered target and an allowlisted action id;
  // the Host expands that id into a fixed argv array. There is no free-text parameter, so this
  // tool cannot be used as a general command runner, and `run_task` cannot reach it.
  server.registerTool('run_repair_action', {
    description: 'Host-owned ENA repair lane: bootstrap / refresh / diagnose the ENA home behind a '
      + 'registered workspace, using values the Host owns. action is an allowlisted id, workspace '
      + 'must be a target registered in the Host gate configuration; the caller supplies no other '
      + 'input and cannot supply command text. Available while ordinary work is refused.',
    inputSchema: z.object({
      action: z.string(),
      workspace: z.string(),
    }),
  }, async (args) => {
    const cfg = readGateConfig();
    if (!cfg) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'refused', code: 'NO_GATE_CONFIG' }) }] };
    }
    const target = findTarget(cfg, args.workspace);
    if (!target) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'refused',
            code: 'REPAIR_TARGET_NOT_REGISTERED',
            detail: 'the repair lane only acts on workspaces the Host has registered',
            registeredWorkspaces: (cfg.targets || []).map((t) => t.workspace),
          }),
        }],
      };
    }
    const action = (cfg.repairActions || {})[args.action];
    if (!action || !Array.isArray(action.argv)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'refused',
            code: 'REPAIR_ACTION_NOT_ALLOWLISTED',
            requested: args.action,
            allowlisted: Object.keys(cfg.repairActions || {}),
          }),
        }],
      };
    }
    const values = gateValues(cfg, target);
    const argv = expandArgv(action.argv, values);
    const python = values.python;
    const run = await runEnaCommand(python, argv.slice(1), 5 * 60 * 1000);
    // Two different questions, reported separately so the evidence is not ambiguous: did the lane
    // execute (laneRan), and what did ENA itself report (enaReported)? A diagnostic that correctly
    // reports NOT_READY is a successful execution of the lane, not a failed one.
    const summaryLine = (run.stdout + run.stderr).split(/\r?\n/).find((l) => l.trim()) || '';
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ran',
          laneRan: true,
          enaReported: run.exitCode === 0 ? 'OK' : 'NOT_READY_OR_REFRESH_REQUIRED',
          action: args.action,
          workspace: target.workspace,
          home: target.home,
          argv: argv.slice(1),
          exitCode: run.exitCode,
          summaryLine,
          stdout: run.stdout.trim().split(/\r?\n/).slice(0, 20),
          stderr: run.stderr.trim().split(/\r?\n/).slice(0, 10),
        }),
      }],
    };
  });

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'error', status: 403, code: 'unauthorized', message: 'invalid token' }));
    return;
  }
  try {
    if (req.method === 'POST') {
      // stateless per SDK: sessionIdGenerator undefined → 每请求独立 transport
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = makeMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body ?? undefined);
      await server.close();
      await transport.close();
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
    }
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`pc-dsh peer MCP server: http://${HOST}:${PORT}/mcp (instance ${INSTANCE_ID})`);
});
process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
