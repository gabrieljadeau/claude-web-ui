// Claude Web UI — a local browser interface for Claude Code.
// Runs on 127.0.0.1 only. Uses the Claude Agent SDK, which reads the same
// configuration as the `claude` command (~/.claude/settings.json), so an
// Amazon Bedrock setup made with /setup-bedrock works as-is.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as sdk from '@anthropic-ai/claude-agent-sdk';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3737);
const TOKEN = crypto.randomBytes(16).toString('hex');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(ROOT, 'public', 'index.html');
const IS_WIN = process.platform === 'win32';
const UPLOAD_DIR = path.join(os.tmpdir(), 'claude-web-ui-uploads');
const MAX_UPLOAD = 25 * 1024 * 1024;
const CONFIG_DIR = path.join(os.homedir(), '.claude-web-ui');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const URL_WITH_TOKEN = `http://${HOST}:${PORT}/?t=${TOKEN}`;

const SYSTEM_APPEND = [
  'You are being used through a local web interface on the user\'s computer, similar to the Claude app.',
  'When the user asks you to visit websites or act in a web page, use the browser tools',
  '(their names start with mcp__browser__), which control Microsoft Edge.',
  'When you create documents, pages or other files for the user, save them in the working folder so they appear in the Files panel.',
  'Answer in the language the user writes in. Keep answers readable: short paragraphs, lists where helpful.',
].join(' ');

// Folders whose files the Files panel may show (working folders used in this run + uploads).
const allowedRoots = new Set([path.resolve(UPLOAD_DIR)]);

// ---------- persistent config (recent folders) ----------
let config = { recents: [], lastCwd: null };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { /* first run */ }
function saveConfig() {
  fsp.mkdir(CONFIG_DIR, { recursive: true })
    .then(() => fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2)))
    .catch(() => {});
}
function rememberFolder(dir) {
  config.recents = [dir, ...config.recents.filter((d) => d !== dir)].slice(0, 8);
  config.lastCwd = dir;
  saveConfig();
}
function recentFolders() {
  return config.recents.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
    .map((d) => ({ path: d, name: path.basename(d) || d }));
}

// Playwright's MCP server lets Claude drive Edge (navigate, click, type, read pages).
function browserServer() {
  const args = ['-y', '@playwright/mcp@latest', '--browser', 'msedge'];
  return IS_WIN
    ? { type: 'stdio', command: 'cmd', args: ['/c', 'npx', ...args] }
    : { type: 'stdio', command: 'npx', args };
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
function isAllowedFile(p) {
  const abs = path.resolve(p);
  for (const r of allowedRoots) if (abs === r || abs.startsWith(r + path.sep)) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.searchParams.get('t') !== TOKEN) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Open the link printed in the terminal (it contains an access token).');
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(await fsp.readFile(INDEX));
    return;
  }
  if (url.pathname === '/file') {
    // Serves files for the Files panel. HTML is sandboxed so it can't reach this app.
    const p = url.searchParams.get('path') || '';
    try {
      if (!isAllowedFile(p)) throw new Error('not allowed');
      const abs = path.resolve(p);
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) throw new Error('not a file');
      const ext = path.extname(abs).toLowerCase();
      const raw = url.searchParams.get('raw') === '1';
      const type = raw ? 'text/plain; charset=utf-8' : (MIME[ext] || 'text/plain; charset=utf-8');
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(abs).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File not available.');
    }
    return;
  }
  res.writeHead(404); res.end();
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 40 * 1024 * 1024 });
const ALLOWED_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ws' || url.searchParams.get('t') !== TOKEN || !ALLOWED_ORIGINS.has(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  const startDir = config.lastCwd && fs.existsSync(config.lastCwd) ? config.lastCwd : os.homedir();
  const st = {
    cwd: startDir,
    sessionId: null,
    mode: 'default',
    model: '',
    effort: '',
    browser: true,
    abort: null,
    running: false,
    pending: new Map(),
    alwaysAllow: new Set(),
    lastUuid: null,       // last assistant message uuid: the cut point used by edit / retry
  };
  allowedRoots.add(path.resolve(st.cwd));

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  send({ type: 'hello', cwd: st.cwd, recents: recentFolders(), platform: process.platform, home: os.homedir() });

  function denyAllPending(message) {
    for (const [, resolve] of st.pending) resolve({ behavior: 'deny', message });
    st.pending.clear();
  }
  const allowKey = (toolName) => (toolName.startsWith('mcp__') ? toolName.split('__').slice(0, 2).join('__') : toolName);

  function askPermission(toolName, input, { signal }) {
    if (st.alwaysAllow.has(allowKey(toolName))) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      st.pending.set(id, (answer) => {
        st.pending.delete(id);
        resolve(answer.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : answer);
      });
      signal?.addEventListener('abort', () => {
        if (st.pending.has(id)) st.pending.get(id)({ behavior: 'deny', message: 'Cancelled.' });
      }, { once: true });
      send({ type: 'permission', id, tool: toolName, input });
    });
  }

  function setCwd(dir) {
    st.cwd = dir; st.sessionId = null; st.lastUuid = null; st.alwaysAllow.clear();
    allowedRoots.add(path.resolve(dir));
    rememberFolder(dir);
    send({ type: 'cwd', cwd: dir, recents: recentFolders() });
  }

  async function run(text, display, editFrom) {
    st.running = true;
    const ac = new AbortController();
    st.abort = ac;
    send({ type: 'busy', value: true });
    try {
      // Edit / retry: continue from a copy of the conversation cut just before the edited message.
      if (editFrom) {
        if (editFrom.upTo && st.sessionId && typeof sdk.forkSession === 'function') {
          const forked = await sdk.forkSession(st.sessionId, { dir: st.cwd, upToMessageId: editFrom.upTo });
          st.sessionId = forked?.sessionId || st.sessionId;
          const msgs = await sdk.getSessionMessages(st.sessionId, { dir: st.cwd }).catch(() => []);
          const { items, lastUuid } = simplifyHistory(msgs);
          st.lastUuid = lastUuid;
          send({ type: 'session', id: st.sessionId });
          send({ type: 'history', items });
        } else {
          st.sessionId = null; st.lastUuid = null;
          send({ type: 'session', id: null });
        }
      }
      send({ type: 'userEcho', text: display, prev: st.lastUuid });
      const q = sdk.query({
        prompt: text,
        options: {
          cwd: st.cwd,
          resume: st.sessionId || undefined,
          abortController: ac,
          includePartialMessages: true,
          permissionMode: st.mode,
          model: st.model || undefined,
          effort: st.effort || undefined,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
          mcpServers: st.browser ? { browser: browserServer() } : {},
          canUseTool: askPermission,
        },
      });
      for await (const m of q) handleMessage(m);
    } catch (err) {
      if (!ac.signal.aborted) send({ type: 'error', message: String(err?.message || err) });
    } finally {
      denyAllPending('Cancelled.');
      st.running = false;
      st.abort = null;
      send({ type: 'busy', value: false });
    }
  }

  function handleMessage(m) {
    if (m.type === 'system' && m.subtype === 'init') {
      if (m.session_id && m.session_id !== st.sessionId) {
        st.sessionId = m.session_id;
        send({ type: 'session', id: st.sessionId, fresh: true });
      }
      if (m.model) send({ type: 'model', model: m.model });
      return;
    }
    if (m.parent_tool_use_id) {
      // Helper-agent (subagent) work: shown in the Activity panel, nested under the agent's step.
      const parent = m.parent_tool_use_id;
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) {
          if (b.type === 'tool_use') send({ type: 'toolUse', id: b.id, name: b.name, input: b.input, parent });
          else if (b.type === 'text' && b.text?.trim()) send({ type: 'subText', parent, text: b.text.slice(0, 1500) });
        }
      } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b.type === 'tool_result') send({ type: 'toolResult', id: b.tool_use_id, isError: !!b.is_error, content: resultText(b.content), parent });
        }
      }
      return;
    }
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'content_block_start' && e.content_block?.type === 'thinking') send({ type: 'thinkingStart' });
      if (e?.type === 'content_block_delta') {
        if (e.delta?.type === 'text_delta') send({ type: 'delta', text: e.delta.text });
        else if (e.delta?.type === 'thinking_delta') send({ type: 'thinkingDelta', text: e.delta.thinking });
      }
      return;
    }
    if (m.type === 'assistant') {
      const content = m.message?.content || [];
      const thinking = content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n\n');
      if (thinking) send({ type: 'thinking', text: thinking });
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      if (text) send({ type: 'assistantText', text });
      for (const b of content) if (b.type === 'tool_use') send({ type: 'toolUse', id: b.id, name: b.name, input: b.input });
      if (m.uuid) st.lastUuid = m.uuid;
      return;
    }
    if (m.type === 'user') {
      const content = Array.isArray(m.message?.content) ? m.message.content : [];
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        send({ type: 'toolResult', id: b.tool_use_id, isError: !!b.is_error, content: resultText(b.content) });
      }
      return;
    }
    if (m.type === 'result') {
      send({
        type: 'done',
        ok: m.subtype === 'success' && !m.is_error,
        cost: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
        message: m.subtype !== 'success' ? (m.errors?.join?.('\n') || m.subtype) : null,
      });
    }
  }

  async function sessionList() {
    const list = await sdk.listSessions({ dir: st.cwd, limit: 200 }).catch(() => []);
    return list.filter((s) => s.tag !== 'cwui-hidden').map((s) => ({
      id: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
      when: s.lastModified,
    }));
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      switch (msg.type) {
        case 'send': {
          if (st.running || typeof msg.text !== 'string') break;
          const files = Array.isArray(msg.files) ? msg.files.filter((f) => typeof f === 'string' && f.startsWith(UPLOAD_DIR)) : [];
          let text = msg.text.trim();
          const display = text + (files.length ? `\n📎 ${files.map((f) => path.basename(f)).join(', ')}` : '');
          if (files.length) text += `\n\nAttached files (read them with your tools):\n${files.map((f) => `- ${f}`).join('\n')}`;
          if (text) run(text, display, msg.edit ? { upTo: typeof msg.edit.upTo === 'string' ? msg.edit.upTo : null } : null);
          break;
        }
        case 'stop':
          denyAllPending('The user stopped the task.');
          st.abort?.abort();
          break;
        case 'permit': {
          const resolve = st.pending.get(msg.id);
          if (!resolve) break;
          if (msg.always) st.alwaysAllow.add(allowKey(msg.tool || ''));
          resolve(msg.allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'The user refused this action.' });
          break;
        }
        case 'settings':
          if (['default', 'acceptEdits', 'plan'].includes(msg.mode)) st.mode = msg.mode;
          if (typeof msg.browser === 'boolean') st.browser = msg.browser;
          if (typeof msg.model === 'string') st.model = msg.model.trim().slice(0, 200);
          if (['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(msg.effort)) st.effort = msg.effort;
          break;
        case 'setCwd': {
          if (st.running) break;
          const dir = path.resolve(String(msg.path || ''));
          if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) setCwd(dir);
          else send({ type: 'error', message: `Folder not found: ${dir}` });
          break;
        }
        case 'pickFolder': {
          if (st.running) break;
          const dir = await pickFolderNative(st.cwd);
          if (dir === undefined) send({ type: 'pickUnavailable' });
          else if (dir) setCwd(dir);
          break;
        }
        case 'ls':
          send({ type: 'ls', ...(await listDirs(msg.path)) });
          break;
        case 'newChat':
          if (st.running) break;
          st.sessionId = null; st.lastUuid = null; st.alwaysAllow.clear();
          send({ type: 'session', id: null });
          break;
        case 'sessions':
          send({ type: 'sessions', items: await sessionList() });
          break;
        case 'openSession': {
          if (st.running) break;
          const msgs = await sdk.getSessionMessages(msg.id, { dir: st.cwd }).catch(() => []);
          const { items, lastUuid } = simplifyHistory(msgs);
          st.sessionId = msg.id; st.lastUuid = lastUuid; st.alwaysAllow.clear();
          send({ type: 'session', id: msg.id });
          send({ type: 'history', items });
          break;
        }
        case 'renameSession': {
          const title = String(msg.title || '').trim().slice(0, 200);
          if (title && typeof sdk.renameSession === 'function') await sdk.renameSession(msg.id, title, { dir: st.cwd });
          send({ type: 'sessions', items: await sessionList() });
          break;
        }
        case 'deleteSession': {
          if (st.running && msg.id === st.sessionId) break;
          // Hide the chat from this interface; the transcript stays on disk (recoverable with `claude --resume`).
          if (typeof sdk.tagSession === 'function') await sdk.tagSession(msg.id, 'cwui-hidden', { dir: st.cwd });
          if (msg.id === st.sessionId) { st.sessionId = null; st.lastUuid = null; send({ type: 'session', id: null }); }
          send({ type: 'sessions', items: await sessionList() });
          break;
        }
        case 'reveal': {
          const p = String(msg.path || '');
          if (!isAllowedFile(p) || !fs.existsSync(p)) break;
          if (IS_WIN) execFile('explorer.exe', [`/select,${path.resolve(p)}`]);
          else if (process.platform === 'darwin') execFile('open', ['-R', p]);
          else execFile('xdg-open', [path.dirname(p)]);
          break;
        }
        case 'upload': {
          // Dropped files are saved to a temp folder; their paths are added to the prompt.
          const name = path.basename(String(msg.name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
          const buf = Buffer.from(String(msg.data || ''), 'base64');
          if (buf.length > MAX_UPLOAD) { send({ type: 'error', message: `${name} is larger than 25 MB.` }); break; }
          const dir = path.join(UPLOAD_DIR, crypto.randomUUID());
          await fsp.mkdir(dir, { recursive: true });
          const file = path.join(dir, name);
          await fsp.writeFile(file, buf);
          send({ type: 'uploaded', ref: msg.ref, name, path: file, size: buf.length });
          break;
        }
      }
    } catch (err) {
      send({ type: 'error', message: String(err?.message || err) });
    }
  });

  ws.on('close', () => { denyAllPending('Disconnected.'); st.abort?.abort(); });
});

// ---------- helpers ----------
function resultText(content) {
  const s = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
    : '';
  return s.length > 4000 ? s.slice(0, 4000) + '\n… (truncated)' : s;
}

function simplifyHistory(msgs) {
  const out = [];
  let lastAssistantUuid = null;
  for (const m of msgs) {
    if (m.parent_tool_use_id) continue;
    const c = m.message?.content;
    if (m.type === 'user') {
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
      if (text.trim()) out.push({ role: 'user', text, prev: lastAssistantUuid });
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      const tools = c.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, input: b.input }));
      if (m.uuid) lastAssistantUuid = m.uuid;
      if (text.trim() || tools.length) out.push({ role: 'assistant', text, tools });
    }
  }
  return { items: out, lastUuid: lastAssistantUuid };
}

// Opens the operating system's own folder picker. Returns a path, '' if cancelled, undefined if unavailable.
function pickFolderNative(start) {
  return new Promise((resolve) => {
    const done = (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(undefined);
      const p = String(stdout || '').trim();
      resolve(p && fs.existsSync(p) ? p : '');
    };
    if (IS_WIN) {
      const ps = [
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d=New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description='Choose the folder Claude will work in'",
        '$d.UseDescriptionForTitle=$true',
        '$d.ShowNewFolderButton=$true',
        'if ($env:CWUI_START -and (Test-Path $env:CWUI_START)) { $d.SelectedPath=$env:CWUI_START }',
        '$f=New-Object System.Windows.Forms.Form',
        '$f.TopMost=$true; $f.ShowInTaskbar=$false; $f.WindowState=\'Minimized\'',
        "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
      ].join('; ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { env: { ...process.env, CWUI_START: start }, windowsHide: true, timeout: 10 * 60 * 1000 }, done);
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose the folder Claude will work in")'], { timeout: 600000 }, done);
    } else {
      execFile('zenity', ['--file-selection', '--directory', `--filename=${start}/`], { timeout: 600000 }, done);
    }
  });
}

async function listDirs(p) {
  if (IS_WIN && (!p || p === 'drives')) {
    const drives = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) drives.push({ name: `${l}:`, path: `${l}:\\` });
    return { path: 'drives', parent: null, dirs: drives };
  }
  const dir = path.resolve(p || os.homedir());
  let entries = [];
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* unreadable folder */ }
  const up = path.dirname(dir);
  const parent = up !== dir ? up : (IS_WIN ? 'drives' : null);
  return { path: dir, parent, dirs: entries, home: os.homedir() };
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  if (IS_WIN) exec(`start "" msedge --app="${url}"`, (err) => { if (err) exec(`start "" "${url}"`); });
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

server.listen(PORT, HOST, () => {
  console.log('\n  Claude Web UI is running.');
  console.log(`  Open: ${URL_WITH_TOKEN}`);
  console.log('  Keep this window open. Press Ctrl+C to stop.\n');
  openBrowser(URL_WITH_TOKEN);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other window or set PORT=3738.`);
  else console.error(err);
  process.exit(1);
});
