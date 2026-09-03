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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = await import('zod');

const HOST = '<PC_TAILSCALE_IP>';
const PORT = 39480;
const INSTANCE_ID = 'pc-dsh';
const HOSTNAME = '<YOUR_DOMAIN>.ts.net';
const DSH_VERSION = (() => {
  try {
    const p = 'C:/Users/PC/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json';
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

function runHeadless(goal, context, workspace) {
  return new Promise((resolve) => {
    const taskId = 'task-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    const timeoutMs = 30 * 60 * 1000;
    // 防注入：goal 中的命令控制符过滤（tailnet + 令牌双闸，仍按契约§8 加固）
    const safe = String(goal || '')
      .replace(/["`^<>&|;%!]/g, ' ')
      .replace(/\r?\n/g, ' ')
      .slice(0, 2000);
    const env = { ...process.env };
    if (context) env.DSH_PEER_CONTEXT = String(context).slice(0, 4000);
    if (workspace) env.DSH_PEER_WORKSPACE = String(workspace).slice(0, 500);
    const child = execFile(
      'cmd.exe',
      ['/d', '/c', 'dsh', '--profile', 'headless', '--patch', FULL_PERM_PATCH, safe],
      { env, windowsHide: true, timeout: timeoutMs, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          resolve({ taskId, status: 'timeout', result: (stdout || '') + (stderr || ''), exitCode: null });
        } else if (err) {
          resolve({ taskId, status: 'failed', result: (stdout || '') + (stderr || String(err)).slice(0, 1000), exitCode: err.code ?? 1 });
        } else {
          resolve({ taskId, status: 'done', result: stdout || '', exitCode: 0 });
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
    description: '执行一个 headless 任务（dsh --profile headless <goal>），返回 stdout',
    inputSchema: z.object({
      goal: z.string(),
      context: z.string().optional(),
      workspace: z.string().optional(),
    }),
  }, async (args) => {
    const r = await runHeadless(args.goal, args.context, args.workspace);
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
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
