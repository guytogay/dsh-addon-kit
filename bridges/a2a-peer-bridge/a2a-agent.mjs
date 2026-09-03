// a2a-agent.mjs — PC 端标准 A2A agent server（契约 v1.5：标准 A2A v1.0，非 DSH 私有包）
// 暴露 get_status / query_sessions / run_task 三个 capability；
// 鉴权：Authorization: Bearer <共享令牌>（fail-closed 403）；绑定 tailnet IP（仅尾网可达）；
// run_task 执行 headless 默认全权限（--patch danger-full-access）。
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  TaskState,
  Role,
} from '@a2a-js/sdk';
import { InMemoryTaskStore, DefaultRequestHandler, AgentEvent } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.A2A_HOST || '<PC_TAILSCALE_IP>';
const PORT = Number(process.env.A2A_PORT || 39481);
const INSTANCE_ID = 'pc-dsh';
const HOSTNAME = '<YOUR_DOMAIN>.ts.net';
const DSH_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync('C:/Users/PC/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json', 'utf8')).version;
  } catch { return 'unknown'; }
})();
const SESSIONS_DIR = path.join(os.homedir(), '.dsh', 'sessions');
const FULL_PERM_PATCH = path.join(__dirname, 'headless-full-perm.patch.yml');

const token = process.env.DSH_PEER_TOKEN || fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim();
if (!token) { console.error('a2a-agent: no token'); process.exit(1); }

// A2A push 回调令牌（独立于共享令牌；回调端点专用，fail-closed）
const PUSH_TOKEN = process.env.DSH_A2A_PUSH_TOKEN || (() => {
  try { return fs.readFileSync(path.join(__dirname, 'a2a-push.token'), 'utf8').trim(); } catch { return ''; }
})();
// peer compatible：X-A2A-Signature (HMAC-SHA256) 共享 secret（方案①；值仅存本地，不落库）
const PUSH_SIGNATURE_SECRET = process.env.DSH_A2A_SIGNATURE_SECRET || (() => {
  try { return fs.readFileSync(path.join(__dirname, 'a2a-push-signature.secret'), 'utf8').trim(); } catch { return ''; }
})();
const PUSH_INBOX_DIR = path.join(__dirname, 'push-inbox');
try { fs.mkdirSync(PUSH_INBOX_DIR, { recursive: true }); } catch {}

// peer 签名规则辅助：sort_keys 递归排序 + Python json.dumps 风格序列化（separators=(', ', ': ')，ensure_ascii=False 天然由 JS 输出原文）
function sortKeysRecursive(o) {
  if (Array.isArray(o)) return o.map(sortKeysRecursive);
  if (o && typeof o === 'object') {
    return Object.keys(o).sort().reduce((acc, k) => { acc[k] = sortKeysRecursive(o[k]); return acc; }, {});
  }
  return o;
}
function pyDumps(o, compact) {
  const sep = compact ? [',', ':'] : [', ', ': '];
  function walk(v) {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(walk).join(sep[0]) + ']';
    if (typeof v === 'object') {
      return '{' + Object.keys(v).map((k) => JSON.stringify(k) + sep[1] + walk(v[k])).join(sep[0]) + '}';
    }
    return 'null';
  }
  return walk(o);
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

function runHeadless(goal, context, workspace) {
  return new Promise((resolve) => {
    const taskId = 'a2a-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const safe = String(goal || '').replace(/["`^<>&|;%!]/g, ' ').replace(/\r?\n/g, ' ').slice(0, 2000);
    const env = { ...process.env };
    if (context) env.DSH_PEER_CONTEXT = String(context).slice(0, 4000);
    if (workspace) env.DSH_PEER_WORKSPACE = String(workspace).slice(0, 500);
    execFile('cmd.exe', ['/d', '/c', 'dsh', '--profile', 'headless', '--patch', FULL_PERM_PATCH, safe],
      { env, windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) resolve({ taskId, status: 'timeout', result: (stdout || '') + (stderr || ''), exitCode: null });
        else if (err) resolve({ taskId, status: 'failed', result: (stdout || '') + (stderr || String(err)).slice(0, 1000), exitCode: err.code ?? 1 });
        else resolve({ taskId, status: 'done', result: stdout || '', exitCode: 0 });
      });
  });
}

async function runTool(text) {
  // 消息文本 = JSON {"tool":"run_task","goal":...} / {"tool":"get_status"} / {"tool":"query_sessions","query":...}
  // 解析失败则视为 run_task 的 goal（便于人对人/简单客户端）
  let cmd;
  try { cmd = JSON.parse(text); } catch { cmd = { tool: 'run_task', goal: text }; }
  if (cmd.tool === 'get_status') {
    return { instanceId: INSTANCE_ID, host: HOSTNAME, version: DSH_VERSION, liveSessionCount: parseSessionDirs().filter((s) => s.status === 'live').length };
  }
  if (cmd.tool === 'query_sessions') return parseSessionDirs(cmd.query);
  if (cmd.tool === 'run_task') return await runHeadless(cmd.goal, cmd.context, cmd.workspace);
  return { status: 'unknown-tool', tool: cmd.tool };
}

const agentCard = {
  name: 'pc-dsh',
  description: 'DSH A2A agent: get_status / query_sessions / run_task (callee runs with full permissions; tailnet + shared token)',
  supportedInterfaces: [{ url: `http://${HOST}:${PORT}/`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_PROTOCOL_VERSION }],
  provider: { organization: 'home-lab', url: `http://${HOST}:${PORT}/` },
  version: '1.5.0',
  capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text', 'task-status'],
  skills: [
    { id: 'get_status', name: 'Get Status', description: 'Return instance id/host/version/live session count', tags: ['status'], examples: ['{"tool":"get_status"}'], inputModes: ['text'], outputModes: ['text', 'task-status'], securityRequirements: [] },
    { id: 'query_sessions', name: 'Query Sessions', description: 'List local live/persisted sessions (optional query filter)', tags: ['sessions'], examples: ['{"tool":"query_sessions","query":""}'], inputModes: ['text'], outputModes: ['text', 'task-status'], securityRequirements: [] },
    { id: 'run_task', name: 'Run Task', description: 'Execute a headless DSH task; message text = {"tool":"run_task","goal":"...","context":"...","workspace":"..."} (plain text = goal). Callee runs with FULL permissions by owner policy.', tags: ['task'], examples: ['{"tool":"run_task","goal":"reply OK"}'], inputModes: ['text'], outputModes: ['text', 'task-status'], securityRequirements: [] },
  ],
  documentationUrl: '',
  signatures: [],
};

class PcDshExecutor {
  async execute(requestContext, eventBus) {
    const { userMessage, taskId, contextId, task: existingTask } = requestContext;
    const text = (userMessage.parts.find((p) => p.content?.$case === 'text')?.content?.value ?? '').trim();
    eventBus.publish(AgentEvent.task(existingTask ?? {
      id: taskId, contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString() },
      artifacts: [], history: [userMessage], metadata: {},
    }));
    eventBus.publish(AgentEvent.statusUpdate({
      taskId, contextId,
      status: { state: TaskState.TASK_STATE_WORKING, message: { role: Role.ROLE_AGENT, messageId: crypto.randomUUID(), parts: [{ content: { $case: 'text', value: 'working' }, mediaType: 'text/plain', filename: '', metadata: undefined }], taskId, contextId, extensions: [], metadata: {}, referenceTaskIds: [] }, timestamp: new Date().toISOString() },
      metadata: {},
    }));
    const result = await runTool(text);
    eventBus.publish(AgentEvent.artifactUpdate({
      taskId, contextId,
      artifact: { artifactId: crypto.randomUUID(), name: 'result', parts: [{ content: { $case: 'text', value: JSON.stringify(result) }, mediaType: 'text/plain', filename: '', metadata: undefined }] },
      lastChunk: true, append: false, metadata: undefined,
    }));
    eventBus.publish(AgentEvent.statusUpdate({
      taskId, contextId,
      status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() }, metadata: undefined,
    }));
  }
  cancelTask = async () => {};
}

const taskStore = new InMemoryTaskStore();
const requestHandler = new DefaultRequestHandler(agentCard, taskStore, new PcDshExecutor());
const app = express();
// 注意：不在此处挂全局 express.json —— SDK 的 jsonRpcHandler 自带 express.json（见其源码 router.use(express.json())），
// 且 /a2a/push 需要原始字节做 HMAC 校验（见下方 express.raw）。

// ===== A2A push 回调接收端点（v1.0：body = StreamResponse.toJSON()，裸字段 task/message/statusUpdate/artifactUpdate）=====
// 鉴权三条路径（全 fail-closed；命中任一即放行）：
//   A) Authorization: Bearer <PUSH_TOKEN>（v1.0 standard，authentication 优先）
//   B) X-A2A-Notification-Token: <PUSH_TOKEN>（v1.0 legacy token）
//   C) X-A2A-Signature: HMAC-SHA256(rawBody, PUSH_SIGNATURE_SECRET)（peer implementation；secret 未配置时不启用）
// 幂等：按 taskId 落盘事件序列；只在首次见到终态(TASK_STATE_COMPLETED/FAILED/CANCELED/REJECTED)时标记 done
const pushRawParser = express.raw({ type: () => true, limit: '4mb' });
app.post('/a2a/push', pushRawParser, (req, res) => {
  const auth = req.headers['authorization'] || '';
  const legacy = req.headers['x-a2a-notification-token'] || '';
  const signature = req.headers['x-a2a-signature'] || '';
  let okAuth = false;
  let authPath = null;
  if (PUSH_TOKEN && (auth === 'Bearer ' + PUSH_TOKEN || legacy === PUSH_TOKEN)) { okAuth = true; authPath = legacy === PUSH_TOKEN ? 'token-legacy' : 'token-bearer'; }
  if (!okAuth && signature && PUSH_SIGNATURE_SECRET) {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8');
    // peer 精确规则：签名 = HMAC-SHA256(secret, json.dumps(payload, sort_keys=True, ensure_ascii=False))
    //   - 输入：收到的 body 解析为对象后，按 key 字典序递归排序
    //   - 序列化：Python json.dumps 风格 —— separators=(', ', ': ')，无 ensure_ascii（即非 ASCII 输出 UTF-8 原文）
    //   - 输出：hex 小写 64 字符
    // 保留 raw 与 compact 变体作为兼容（其他 push 实现无空格）
    const digestRaw = crypto.createHmac('sha256', PUSH_SIGNATURE_SECRET).update(raw).digest('hex');
    const digestRawB64 = crypto.createHmac('sha256', PUSH_SIGNATURE_SECRET).update(raw).digest('base64');
    let digestPeer = null;
    let digestCompact = null;
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      const sorted = sortKeysRecursive(parsed);
      digestPeer = crypto.createHmac('sha256', PUSH_SIGNATURE_SECRET)
        .update(Buffer.from(pyDumps(sorted, false), 'utf8')).digest('hex');
      digestCompact = crypto.createHmac('sha256', PUSH_SIGNATURE_SECRET)
        .update(Buffer.from(pyDumps(sorted, true), 'utf8')).digest('hex');
    } catch { /* 解析失败则只有 raw 可试 */ }
    const candidates = [['raw', digestRaw], ['raw-b64', digestRawB64], ['pyDumpsSortedSpaced', digestPeer], ['pyDumpsSortedCompact', digestCompact]].filter(([, v]) => !!v);
    const hit = candidates.find(([, v]) => v === signature);
    if (hit) { okAuth = true; authPath = 'signature:' + hit[0]; }
    else {
      // 调试 dump：保存收到的 raw body + header，便于本地校准
      try {
        fs.writeFileSync(path.join(PUSH_INBOX_DIR, '_debug-sig-mismatch-' + Date.now() + '.json'),
          JSON.stringify({ at: new Date().toISOString(), header: signature, bodyUtf8: raw.toString('utf8') }, null, 2));
      } catch {}
      console.log(`[a2a-push] sig mismatch: header=${signature.slice(0, 16)}... raw=${digestRaw.slice(0, 12)}... peer=${(digestPeer || 'NA').slice(0, 12)}... bodyLen=${raw.length}`);
    }
  }
  if (!okAuth && signature && !PUSH_SIGNATURE_SECRET) {
    console.log(`[a2a-push] sig received but NO secret configured: header=${signature.slice(0, 16)}...`);
  }
  if (!okAuth) { res.status(403).json({ error: 'unauthorized' }); return; }

  // 解析 body（raw 字节 → JSON）
  let body = req.body;
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString('utf8')); } catch { body = null; }
  } else if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  body = body || {};
  // 从裸字段还原 StreamResponse 的 $case
  let pcase = null;
  let value = null;
  if (body.task) { pcase = 'task'; value = body.task; }
  else if (body.statusUpdate) { pcase = 'statusUpdate'; value = body.statusUpdate; }
  else if (body.artifactUpdate) { pcase = 'artifactUpdate'; value = body.artifactUpdate; }
  else if (body.message) { pcase = 'message'; value = body.message; }
  if (!pcase) { res.status(400).json({ error: 'bad-payload', hint: 'expected StreamResponse JSON {task|message|statusUpdate|artifactUpdate}' }); return; }

  const taskId = pcase === 'task' ? value.id : (value.taskId || '');
  const contextId = pcase === 'task' ? (value.contextId || '') : (value.contextId || '');
  const stateRaw = pcase === 'task' ? value.status?.state : pcase === 'statusUpdate' ? value.status?.state : null;
  const stateStr = typeof stateRaw === 'string' ? stateRaw
    : (typeof stateRaw === 'number'
      ? ('TASK_STATE_' + ['UNSPECIFIED', 'SUBMITTED', 'WORKING', 'COMPLETED', 'FAILED', 'CANCELED', 'INPUT_REQUIRED', 'REJECTED', 'AUTH_REQUIRED'][stateRaw] || 'UNKNOWN')
      : null);
  const terminal = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(stateStr);
  const now = new Date().toISOString();

  if (!taskId) { res.status(400).json({ error: 'no-task-id' }); return; }

  // 幂等落盘：push-inbox/<taskId>.json（事件追加，含首个终态标记）
  const file = path.join(PUSH_INBOX_DIR, taskId.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
  let record = null;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!record) record = { taskId, contextId, createdAt: now, events: [], done: false, doneAt: null };
  if (!record.auth && authPath) record.auth = authPath;
  const evt = { at: now, case: pcase, state: stateStr || null };
  // 简化事件体，避免无限膨胀：只存有意义的字段
  if (pcase === 'artifactUpdate' && value.artifact) {
    evt.artifactName = value.artifact.name || null;
    const parts = value.artifact.parts?.filter((p) => p.content?.$case === 'text');
    if (parts?.length) evt.artifactTextPreview = String(parts[0].content.value).slice(0, 3000);
  }
  if (pcase === 'statusUpdate' && value.status?.message) {
    const parts = value.status.message.parts?.filter((p) => p.content?.$case === 'text');
    if (parts?.length) evt.messagePreview = String(parts[0].content.value).slice(0, 3000);
  }
  record.events.push(evt);
  if (terminal && !record.done) { record.done = true; record.doneAt = now; }
  record.lastAt = now;
  fs.writeFileSync(file, JSON.stringify(record, null, 2));

  console.log(`[a2a-push] task=${taskId} $case=${pcase} state=${stateStr} (done=${record.done}, auth=${authPath})`);
  res.json({ ok: true, taskId, case: pcase, state: stateStr, done: record.done });
});

// 令牌鉴权（fail-closed；与 MCP 桥同一共享令牌）
app.use((req, res, next) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + token) {
    res.status(403).json({ error: 'unauthorized' });
    return;
  }
  next();
});

app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

app.listen(PORT, HOST, () => {
  console.log(`[pc-dsh A2A] http://${HOST}:${PORT}/  card=/.well-known/agent-card.json (instance ${INSTANCE_ID})`);
});
