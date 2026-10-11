// Claude Web UI — a local browser interface for Claude Code.
// Runs on 127.0.0.1 only. Uses the Claude Agent SDK, which reads the same
// configuration as the `claude` command (~/.claude/settings.json), so an
// Amazon Bedrock setup made in the terminal works as-is.
//
// Layout of this file:
//   1. config & persistent state (~/.claude-web-ui/state.json)
//   2. auth / connection check (`claude auth status`)
//   3. session runtimes (several Claude sessions can run at the same time)
//   4. routines scheduler (prompts that run on a schedule)
//   5. HTTP + WebSocket protocol with the browser

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  query, listSessions, getSessionMessages, renameSession, deleteSession,
} from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------- 1. config
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3737);
const TOKEN = crypto.randomBytes(16).toString('hex');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const DATA_DIR = path.join(os.homedir(), '.claude-web-ui');
const CHAT_DIR = path.join(DATA_DIR, 'chats');       // cwd of "Chat" sessions (no project)
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PROBE_DIR = path.join(DATA_DIR, 'probe');      // cwd of the tiny connection-test requests (hidden from the sidebar)
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_UPLOAD = 25 * 1024 * 1024;
const URL_WITH_TOKEN = `http://${HOST}:${PORT}/?t=${TOKEN}`;
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

for (const d of [DATA_DIR, CHAT_DIR, UPLOAD_DIR, PROBE_DIR]) fs.mkdirSync(d, { recursive: true });

const KINDS = ['chat', 'cowork', 'code', 'routine'];
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

const PROMPTS = {
  common: 'You are being used through a local web interface on the user\'s computer (Claude Web UI). Keep answers readable: short paragraphs, lists where helpful.',
  chat: 'This is a general conversation ("Chat"): you have no project folder. You can read files the user attaches and fetch web pages, nothing else. Do not try to run commands or edit files.',
  cowork: 'This is a "Cowork" task: the user gave you a folder to work in autonomously. Plan briefly, do the work, save results as files in that folder, and finish with a short summary of what you produced and where.',
  code: 'This is a "Code" session in a project folder, like the claude terminal command.',
  routine: 'This is a scheduled routine running without anyone watching. Do the task completely, do not ask questions, and finish with a concise report of what you did.',
  browser: 'When the user asks you to visit websites or act in a web page, use the browser tools (their names start with mcp__browser__).',
};

// Playwright's MCP server lets Claude drive Edge/Chrome (navigate, click, type, read pages).
function browserServer() {
  const args = ['-y', '@playwright/mcp@latest', '--browser', IS_WIN ? 'msedge' : 'chrome'];
  return IS_WIN
    ? { type: 'stdio', command: 'cmd', args: ['/c', 'npx', ...args] }
    : { type: 'stdio', command: 'npx', args };
}

// ------------------------------------------------------- persistent state
const state = loadState();
function loadState() {
  const def = { projects: [], routines: [], meta: {}, settings: { model: '', mode: 'default', coworkMode: 'acceptEdits', browser: true, lang: 'fr-FR' } };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...def, ...s, settings: { ...def.settings, ...(s.settings || {}) } };
  } catch { return def; }
}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2)).catch(() => {}), 200);
}
function metaOf(sdkId) { return state.meta[sdkId] || {}; }
function setMeta(sdkId, patch) { state.meta[sdkId] = { ...metaOf(sdkId), ...patch }; saveState(); }

// ---------------------------------------------------------------- 2. auth
let auth = { checked: false, connected: null, provider: 'unknown', loggedIn: false, detail: '', cli: null };

function runCmd(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, shell: IS_WIN }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function checkAuth() {
  const r = await runCmd('claude', ['auth', 'status']);
  if (r.err && !r.stdout) {
    // `claude` is not on PATH (the SDK ships its own binary, so this is not fatal).
    const env = settingsEnv();
    const bedrock = env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_BEDROCK === 'true';
    auth = { checked: true, connected: bedrock || !!env.ANTHROPIC_API_KEY || null, provider: bedrock ? 'bedrock' : 'unknown', loggedIn: false, cli: null,
      detail: 'The claude command was not found in PATH; connection could not be verified.' };
  } else {
    let j = null;
    try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { /* not JSON */ }
    if (j) {
      const provider = j.apiProvider || 'firstParty';
      const connected = !!j.loggedIn || (provider !== 'firstParty' && provider !== 'none');
      auth = { checked: true, connected, provider, loggedIn: !!j.loggedIn, cli: await cliVersion(),
        detail: connected ? '' : 'Not logged in.' };
    } else {
      auth = { checked: true, connected: null, provider: 'unknown', loggedIn: false, cli: await cliVersion(), detail: (r.stderr || r.stdout).trim().slice(0, 300) };
    }
  }
  broadcast({ type: 'auth', auth });
  return auth;
}
async function cliVersion() { const r = await runCmd('claude', ['--version']); return r.stdout.trim().split('\n')[0] || null; }
function settingsEnv() {
  const env = { ...process.env };
  try { Object.assign(env, JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {}); } catch { /* none */ }
  return env;
}
// Opens a terminal window running `claude` so the user can log in there.
function openLoginTerminal() {
  if (IS_WIN) exec('start "Claude login" cmd /k claude');
  else if (IS_MAC) exec(`osascript -e 'tell application "Terminal" to do script "claude"' -e 'tell application "Terminal" to activate'`);
  else exec('x-terminal-emulator -e claude || gnome-terminal -- claude || xterm -e claude');
}

// ------------------------------------------------------ 3. session runtimes
// A runtime is one conversation. It exists in memory while the server runs;
// the transcript itself is written by Claude Code to ~/.claude/projects.
const runtimes = new Map();   // localId -> runtime
const bySdk = new Map();      // sdk session id -> runtime

function createRuntime({ kind, cwd, sdkId = null, title = '', items = [], mode, model, routineId = null }) {
  const rt = {
    localId: crypto.randomUUID(), sdkId, kind, cwd, title,
    items,                        // normalized transcript: user / assistant / tool / perm / note
    status: 'idle',               // idle | running | waiting
    mode: mode || (kind === 'cowork' || kind === 'routine' ? state.settings.coworkMode : state.settings.mode),
    model: model ?? state.settings.model,
    browser: state.settings.browser,
    routineId,
    abort: null, pending: new Map(), alwaysAllow: new Set(),
    liveText: '', cost: 0, lastActivity: Date.now(), unread: false, createdAt: Date.now(),
  };
  runtimes.set(rt.localId, rt);
  if (sdkId) bySdk.set(sdkId, rt);
  return rt;
}

function emit(rt, ev) {
  // keep the transcript in memory so a client that opens the session later sees everything
  switch (ev.type) {
    case 'user': rt.items.push({ type: 'user', text: ev.text, files: ev.files }); break;
    case 'delta': rt.liveText += ev.text; break;
    case 'assistantText': rt.liveText = ''; rt.items.push({ type: 'assistant', text: ev.text }); break;
    case 'toolUse': rt.liveText = ''; rt.items.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, result: null, isError: false }); break;
    case 'toolResult': { const t = rt.items.find((i) => i.type === 'tool' && i.id === ev.id); if (t) { t.result = ev.content; t.isError = ev.isError; } break; }
    case 'permission': rt.items.push({ type: 'perm', id: ev.id, tool: ev.tool, input: ev.input, answer: null }); break;
    case 'permitted': { const p = rt.items.find((i) => i.type === 'perm' && i.id === ev.id); if (p) p.answer = ev.answer; break; }
    case 'note': if (ev.err && sameError(rt, ev.text)) return; rt.items.push({ type: 'note', text: ev.text, err: !!ev.err }); break;
    case 'done': rt.liveText = ''; if (!ev.ok && sameError(rt, ev.message)) ev = { ...ev, message: null }; rt.items.push({ type: 'done', ok: ev.ok, cost: ev.cost, message: ev.message }); break;
  }
  rt.lastActivity = Date.now();
  broadcast({ type: 'ev', sid: rt.localId, ev });
}

// The SDK reports one failure several ways (assistant text, thrown error, result); show it once.
function sameError(rt, text) {
  if (!text) return false;
  const norm = (x) => String(x || '').replace(/^Claude Code returned an error result:\s*/i, '').trim();
  const t = norm(text);
  return rt.items.slice(-4).some((i) => (i.type === 'assistant' || i.type === 'note' || i.type === 'done') && norm(i.text || i.message) === t);
}

function setStatus(rt, status) {
  if (rt.status === status) return;
  rt.status = status;
  broadcast({ type: 'status', sid: rt.localId, status, waiting: rt.pending.size });
  sidebarDirty();
}

function allowKey(toolName) {
  return toolName.startsWith('mcp__') ? toolName.split('__').slice(0, 2).join('__') : toolName;
}

function makePermissionHandler(rt) {
  return (toolName, input, { signal }) => {
    if (rt.alwaysAllow.has(allowKey(toolName))) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      rt.pending.set(id, (answer) => {
        rt.pending.delete(id);
        if (!rt.pending.size && rt.status === 'waiting') setStatus(rt, 'running');
        emit(rt, { type: 'permitted', id, answer: answer.behavior });
        resolve(answer.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : answer);
      });
      signal?.addEventListener('abort', () => {
        if (rt.pending.has(id)) rt.pending.get(id)({ behavior: 'deny', message: 'Cancelled.' });
      }, { once: true });
      emit(rt, { type: 'permission', id, tool: toolName, input });
      setStatus(rt, 'waiting');
    });
  };
}

function denyAllPending(rt, message) {
  for (const [, resolve] of rt.pending) resolve({ behavior: 'deny', message });
  rt.pending.clear();
}

function queryOptions(rt, ac) {
  const kind = rt.kind;
  const append = [PROMPTS.common, PROMPTS[kind]];
  const browser = rt.browser && kind !== 'chat';
  if (browser) append.push(PROMPTS.browser);
  const opts = {
    cwd: rt.cwd,
    resume: rt.sdkId || undefined,
    abortController: ac,
    includePartialMessages: true,
    permissionMode: rt.mode,
    model: rt.model || undefined,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: append.join(' ') },
    mcpServers: browser ? { browser: browserServer() } : {},
    canUseTool: makePermissionHandler(rt),
  };
  if (rt.mode === 'bypassPermissions') opts.allowDangerouslySkipPermissions = true;
  if (kind === 'chat') opts.tools = ['Read', 'WebFetch', 'WebSearch'];
  if (rt.title && !rt.sdkId) opts.title = rt.title;
  return opts;
}

async function runTurn(rt, text) {
  if (rt.status !== 'idle') return;
  const ac = new AbortController();
  rt.abort = ac;
  setStatus(rt, 'running');
  try {
    const q = query({ prompt: text, options: queryOptions(rt, ac) });
    for await (const m of q) handleSdkMessage(rt, m);
  } catch (err) {
    if (!ac.signal.aborted) {
      const msg = String(err?.message || err);
      emit(rt, { type: 'note', text: msg, err: true });
      if (/auth|401|403|credential|login|api key|token|AccessDenied|ExpiredToken/i.test(msg)) checkAuth();
    }
  } finally {
    denyAllPending(rt, 'Cancelled.');
    rt.abort = null;
    if (rt.liveText) emit(rt, { type: 'assistantText', text: rt.liveText });
    setStatus(rt, 'idle');
    rt.unread = true;
    invalidateListing();
    sidebarDirty();
  }
}

function handleSdkMessage(rt, m) {
  if (m.type === 'system' && m.subtype === 'init') {
    if (m.session_id && m.session_id !== rt.sdkId) {
      rt.sdkId = m.session_id;
      bySdk.set(rt.sdkId, rt);
      setMeta(rt.sdkId, { kind: rt.kind, routineId: rt.routineId || undefined });
      broadcast({ type: 'sdkId', sid: rt.localId, sdkId: rt.sdkId });
      sidebarDirty();
    }
    return;
  }
  if (m.type === 'auth_status') {
    if (m.error) emit(rt, { type: 'note', text: `Authentication: ${m.error}`, err: true });
    return;
  }
  if (m.parent_tool_use_id) return; // hide subagent internals
  if (m.type === 'stream_event') {
    const e = m.event;
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') emit(rt, { type: 'delta', text: e.delta.text });
    return;
  }
  if (m.type === 'assistant') {
    const content = m.message?.content || [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    if (text) emit(rt, { type: 'assistantText', text });
    for (const b of content) if (b.type === 'tool_use') emit(rt, { type: 'toolUse', id: b.id, name: b.name, input: b.input });
    return;
  }
  if (m.type === 'user') {
    const content = Array.isArray(m.message?.content) ? m.message.content : [];
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      emit(rt, { type: 'toolResult', id: b.tool_use_id, isError: !!b.is_error, content: resultText(b.content) });
    }
    return;
  }
  if (m.type === 'result') {
    const ok = m.subtype === 'success' && !m.is_error;
    if (typeof m.total_cost_usd === 'number') rt.cost += m.total_cost_usd;
    emit(rt, { type: 'done', ok, cost: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
      message: ok ? null : (m.errors?.join?.('\n') || m.result || m.subtype) });
    if (!ok && m.startup_failure_reason) checkAuth();
  }
}

// ---- opening sessions saved on disk (by the terminal `claude` or by this app)
async function openFromDisk(sdkId, cwd) {
  const existing = bySdk.get(sdkId);
  if (existing) return existing;
  const info = (await listing()).find((s) => s.sessionId === sdkId);
  const dir = cwd || info?.cwd || undefined;
  const msgs = await getSessionMessages(sdkId, dir ? { dir } : undefined).catch(() => []);
  const meta = metaOf(sdkId);
  const kind = meta.kind || (dir === CHAT_DIR ? 'chat' : 'code');
  return createRuntime({ kind, cwd: dir || os.homedir(), sdkId, title: info?.customTitle || info?.summary || '', items: simplifyHistory(msgs), routineId: meta.routineId || null });
}

function simplifyHistory(msgs) {
  const out = [];
  const tools = new Map();
  for (const m of msgs) {
    if (m.parent_tool_use_id) continue;
    const c = m.message?.content;
    if (m.type === 'user') {
      if (typeof c === 'string') { if (c.trim() && !isMetaPrompt(c)) out.push({ type: 'user', text: c }); continue; }
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type === 'tool_result') { const t = tools.get(b.tool_use_id); if (t) { t.result = resultText(b.content); t.isError = !!b.is_error; } }
      }
      const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text.trim() && !isMetaPrompt(text)) out.push({ type: 'user', text });
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      if (text.trim()) out.push({ type: 'assistant', text });
      for (const b of c) if (b.type === 'tool_use') { const t = { type: 'tool', id: b.id, name: b.name, input: b.input, result: null, isError: false }; tools.set(b.id, t); out.push(t); }
    }
  }
  return out;
}
function isMetaPrompt(s) { return /^<(local-command|command-name|system-reminder|bash-input)/.test(s.trim()); }

function resultText(content) {
  const s = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') : '';
  return s.length > 4000 ? s.slice(0, 4000) + '\n… (truncated)' : s;
}

// ---- session listing (disk + memory) for the sidebar
let listingCache = { at: 0, items: [] };
function invalidateListing() { listingCache.at = 0; }
async function listing() {
  if (Date.now() - listingCache.at < 15000) return listingCache.items;
  const items = await listSessions({ limit: 500, includeProgrammatic: true }).catch(() => []);
  listingCache = { at: Date.now(), items };
  return items;
}

async function sidebar() {
  const disk = await listing();
  const seen = new Set();
  const out = [];
  const push = (e) => out.push(e);
  for (const rt of runtimes.values()) {
    if (!rt.sdkId && !rt.items.length && rt.status === 'idle') continue; // empty new chat, not sent yet
    const meta = rt.sdkId ? metaOf(rt.sdkId) : {};
    if (rt.sdkId) seen.add(rt.sdkId);
    push({ sid: rt.localId, sdkId: rt.sdkId, kind: rt.kind, title: rt.title || firstUserText(rt) || 'New chat', cwd: rt.cwd, when: rt.lastActivity,
      status: rt.status, waiting: rt.pending.size, unread: rt.unread, pinned: !!meta.pinned, archived: !!meta.archived, routineId: rt.routineId || meta.routineId || null, live: true });
  }
  for (const s of disk) {
    if (seen.has(s.sessionId) || s.cwd === PROBE_DIR) continue;
    const meta = metaOf(s.sessionId);
    const kind = meta.kind || (s.cwd === CHAT_DIR ? 'chat' : 'code');
    push({ sid: s.sessionId, sdkId: s.sessionId, kind, title: s.customTitle || s.summary || s.firstPrompt || 'Untitled', cwd: s.cwd || '', when: s.lastModified,
      status: 'idle', waiting: 0, unread: false, pinned: !!meta.pinned, archived: !!meta.archived, routineId: meta.routineId || null, live: false });
  }
  out.sort((a, b) => b.when - a.when);
  return out;
}
function firstUserText(rt) { const u = rt.items.find((i) => i.type === 'user'); return u ? u.text.split('\n')[0].slice(0, 80) : ''; }

let sidebarTimer = null;
function sidebarDirty() {
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(async () => broadcast({ type: 'sessions', items: await sidebar(), projects: projects() }), 250);
}

function projects() {
  // union of folders the user added and folders that have sessions
  const map = new Map();
  for (const p of state.projects) map.set(p.path, { path: p.path, name: p.name || path.basename(p.path), pinned: true });
  for (const s of listingCache.items) if (s.cwd && s.cwd !== CHAT_DIR && s.cwd !== PROBE_DIR && !map.has(s.cwd)) map.set(s.cwd, { path: s.cwd, name: path.basename(s.cwd) || s.cwd, pinned: false });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ 4. routines
// routine = { id, name, prompt, cwd, mode, model, enabled, schedule, lastRun, nextRun, runs: [{at, sdkId, ok, cost, title}] }
// schedule = { type: 'interval', every: <minutes> } | { type: 'daily', time: 'HH:MM', days: [0..6] } | { type: 'once', at: <ISO> }
function computeNextRun(r, from = Date.now()) {
  const s = r.schedule || {};
  if (s.type === 'interval') { const ms = Math.max(1, Number(s.every) || 60) * 60000; return (r.lastRun || from) + ms; }
  if (s.type === 'once') { const t = Date.parse(s.at); return Number.isFinite(t) && t > (r.lastRun || 0) ? t : null; }
  if (s.type === 'daily') {
    const [hh, mm] = String(s.time || '09:00').split(':').map(Number);
    const days = Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
    const d = new Date(from); d.setSeconds(0, 0);
    for (let i = 0; i < 8; i++) {
      const c = new Date(d); c.setDate(d.getDate() + i); c.setHours(hh || 0, mm || 0, 0, 0);
      if (c.getTime() > from && days.includes(c.getDay())) return c.getTime();
    }
  }
  return null;
}

function normalizeRoutine(input, prev = {}) {
  const r = {
    id: prev.id || crypto.randomUUID(),
    name: String(input.name || prev.name || 'Routine').slice(0, 120),
    prompt: String(input.prompt ?? prev.prompt ?? '').slice(0, 20000),
    cwd: String(input.cwd || prev.cwd || os.homedir()),
    mode: MODES.includes(input.mode) ? input.mode : (prev.mode || 'acceptEdits'),
    model: typeof input.model === 'string' ? input.model.slice(0, 200) : (prev.model || ''),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : (prev.enabled ?? true),
    schedule: input.schedule || prev.schedule || { type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
    lastRun: prev.lastRun || null,
    runs: prev.runs || [],
    createdAt: prev.createdAt || Date.now(),
  };
  r.nextRun = r.enabled ? computeNextRun(r) : null;
  return r;
}

const routineRunning = new Set();
async function runRoutine(r, manual = false) {
  if (routineRunning.has(r.id)) return null;
  routineRunning.add(r.id);
  r.lastRun = Date.now();
  r.nextRun = r.enabled && r.schedule?.type !== 'once' ? computeNextRun(r) : null;
  if (r.schedule?.type === 'once' && !manual) r.enabled = false;
  saveState();
  broadcast({ type: 'routines', items: state.routines });
  const title = `${r.name} · ${new Date().toLocaleString()}`;
  const rt = createRuntime({ kind: 'routine', cwd: r.cwd, title, mode: r.mode, model: r.model, routineId: r.id });
  const run = { at: Date.now(), sid: rt.localId, sdkId: null, ok: null, cost: null, title };
  r.runs.unshift(run); r.runs = r.runs.slice(0, 30);
  emit(rt, { type: 'user', text: r.prompt });
  sidebarDirty();
  runTurn(rt, r.prompt).then(() => {
    const last = rt.items.filter((i) => i.type === 'done').pop();
    run.sdkId = rt.sdkId; run.ok = last ? last.ok : false; run.cost = rt.cost;
    routineRunning.delete(r.id);
    saveState();
    broadcast({ type: 'routines', items: state.routines });
  });
  return rt;
}

setInterval(() => {
  const now = Date.now();
  for (const r of state.routines) {
    if (!r.enabled || !r.nextRun || r.nextRun > now) continue;
    if (now - r.nextRun > 6 * 3600000) { r.nextRun = computeNextRun(r, now); saveState(); continue; } // missed by a lot (computer was off): skip
    runRoutine(r);
  }
}, 20000);
for (const r of state.routines) { if (r.enabled && !r.nextRun) r.nextRun = computeNextRun(r); }

// ----------------------------------------------------------- 4b. customize
// Skills live in ~/.claude/skills/<name>/SKILL.md. Plugins and MCP connectors are
// managed through the `claude` command so the terminal and this app stay in sync.
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SKILLS_DIR = path.join(CLAUDE_HOME, 'skills');

function frontmatter(md) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const k = line.match(/^([\w-]+):\s*(.*)$/);
    if (k) out[k[1]] = k[2].replace(/^["']|["']$/g, '').replace(/^>-?\s*$/, '');
  }
  return out;
}
async function readSkillDir(dir, scope) {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return out; }
  for (const name of names) {
    const file = path.join(dir, name, 'SKILL.md');
    try {
      const md = await fsp.readFile(file, 'utf8');
      const fm = frontmatter(md);
      out.push({ name: fm.name || name, dir: path.join(dir, name), description: (fm.description || md.replace(/^---[\s\S]*?---/, '').trim().split('\n')[0] || '').slice(0, 400), scope });
    } catch { /* not a skill */ }
  }
  return out;
}
async function listSkills() {
  const items = await readSkillDir(SKILLS_DIR, 'user');
  for (const p of state.projects) items.push(...await readSkillDir(path.join(p.path, '.claude', 'skills'), p.name || path.basename(p.path)));
  return items;
}
async function findSkillMd(root, depth = 3) {
  const direct = path.join(root, 'SKILL.md');
  if (fs.existsSync(direct)) return root;
  if (depth === 0) return null;
  for (const e of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') { const r = await findSkillMd(path.join(root, e.name), depth - 1); if (r) return r; }
  }
  return null;
}
async function addSkill({ source, file }) {
  // source: a folder path or a git URL; file: an uploaded SKILL.md or .zip
  const tmp = path.join(UPLOAD_DIR, 'skill-' + crypto.randomUUID());
  await fsp.mkdir(tmp, { recursive: true });
  let root = null;
  if (file && path.resolve(file).startsWith(UPLOAD_DIR)) {
    if (/\.zip$/i.test(file)) { const r = await runCmd('tar', ['-xf', file, '-C', tmp], 60000); if (r.err) throw new Error('Could not unzip: ' + (r.stderr || r.err.message)); root = await findSkillMd(tmp); }
    else if (/\.md$/i.test(file)) { const md = await fsp.readFile(file, 'utf8'); const name = (frontmatter(md).name || path.basename(file, '.md')).replace(/[^\w.-]+/g, '-'); root = path.join(tmp, name); await fsp.mkdir(root); await fsp.writeFile(path.join(root, 'SKILL.md'), md); }
  } else if (typeof source === 'string' && /^(https?:\/\/|git@)/.test(source.trim())) {
    const r = await runCmd('git', ['clone', '--depth', '1', source.trim(), path.join(tmp, 'repo')], 120000);
    if (r.err) throw new Error('git clone failed: ' + (r.stderr || r.err.message).slice(0, 300));
    root = await findSkillMd(path.join(tmp, 'repo'));
  } else if (typeof source === 'string' && safeDir(source)) {
    root = await findSkillMd(safeDir(source), 2);
  }
  if (!root) throw new Error('No SKILL.md found in that source.');
  const md = await fsp.readFile(path.join(root, 'SKILL.md'), 'utf8');
  const name = (frontmatter(md).name || path.basename(root)).replace(/[^\w.-]+/g, '-').slice(0, 80);
  const dest = path.join(SKILLS_DIR, name);
  await fsp.mkdir(SKILLS_DIR, { recursive: true });
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(root, dest, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git${path.sep}`) && !p.endsWith(`${path.sep}.git`) });
  fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return name;
}
async function deleteSkill(dir) {
  const d = path.resolve(String(dir || ''));
  const allowed = [SKILLS_DIR, ...state.projects.map((p) => path.join(p.path, '.claude', 'skills'))];
  if (!allowed.some((a) => d.startsWith(a + path.sep)) || !fs.existsSync(path.join(d, 'SKILL.md'))) throw new Error('Not a skill folder.');
  await fsp.rm(d, { recursive: true, force: true });
}

async function listPlugins() {
  const r = await runCmd('claude', ['plugin', 'list', '--json'], 20000);
  let installed = [];
  try { installed = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))); } catch { /* none */ }
  const available = [];
  let known = {};
  try { known = JSON.parse(await fsp.readFile(path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json'), 'utf8')); } catch { /* none */ }
  for (const [mk, info] of Object.entries(known)) {
    try {
      const cat = JSON.parse(await fsp.readFile(path.join(info.installLocation, '.claude-plugin', 'marketplace.json'), 'utf8'));
      for (const p of cat.plugins || []) available.push({ id: `${p.name}@${mk}`, name: p.name, description: String(p.description || '').slice(0, 300), category: p.category || '', author: p.author?.name || '', marketplace: mk, homepage: p.homepage || '' });
    } catch { /* marketplace not readable */ }
  }
  return { installed: installed.map((p) => ({ id: p.id, version: p.version, enabled: p.enabled !== false, scope: p.scope })), available, marketplaces: Object.keys(known), cliOk: !r.err || !!r.stdout };
}
async function pluginAction(action, id) {
  const ok = ['install', 'uninstall', 'enable', 'disable', 'update'];
  if (!ok.includes(action) || !/^[\w.@/-]+$/.test(String(id || ''))) throw new Error('Bad plugin action.');
  const args = ['plugin', action, id];
  if (action === 'install') args.push('-s', 'user');
  const r = await runCmd('claude', args, 180000);
  if (r.err && !/already/i.test(r.stdout + r.stderr)) throw new Error((r.stderr || r.stdout || r.err.message).trim().slice(0, 500));
  return (r.stdout || r.stderr).trim().slice(0, 500);
}
async function marketplaceAdd(source) {
  if (!/^[\w.:/@~ -]+$/.test(String(source || ''))) throw new Error('Bad marketplace source.');
  const r = await runCmd('claude', ['plugin', 'marketplace', 'add', source], 180000);
  if (r.err) throw new Error((r.stderr || r.stdout || r.err.message).trim().slice(0, 500));
  return (r.stdout || '').trim().slice(0, 500);
}

async function listMcp() {
  let cfg = {};
  try { cfg = JSON.parse(await fsp.readFile(path.join(os.homedir(), '.claude.json'), 'utf8')); } catch { /* none */ }
  const user = Object.entries(cfg.mcpServers || {}).map(([name, c]) => ({ name, scope: 'user', type: c.type || (c.url ? 'http' : 'stdio'), target: c.url || [c.command, ...(c.args || [])].join(' ') }));
  const r = await runCmd('claude', ['mcp', 'list'], 30000);
  const health = {};
  for (const line of r.stdout.split('\n')) { const m = line.match(/^([^:\s]+(?::[^:\s]+)*):\s+(.*?)\s+-\s+(.*)$/); if (m) health[m[1]] = m[3].trim(); }
  const items = user.map((s) => ({ ...s, health: health[s.name] || '' }));
  for (const [name, h] of Object.entries(health)) if (!items.some((i) => i.name === name)) items.push({ name, scope: name.startsWith('plugin:') ? 'plugin' : 'project', type: '', target: '', health: h });
  return items;
}
async function mcpAdd({ name, type, url, command, headers, env }) {
  if (!/^[\w.-]{1,60}$/.test(String(name || ''))) throw new Error('Name: letters, digits, - _ . only.');
  let json;
  if (type === 'http' || type === 'sse') { if (!/^https?:\/\//.test(String(url || ''))) throw new Error('A valid URL is required.'); json = { type, url, ...(headers && Object.keys(headers).length ? { headers } : {}) }; }
  else { const parts = String(command || '').trim().split(/\s+/); if (!parts[0]) throw new Error('A command is required.'); json = { type: 'stdio', command: parts[0], args: parts.slice(1), ...(env && Object.keys(env).length ? { env } : {}) }; }
  const r = await runCmd('claude', ['mcp', 'add-json', '-s', 'user', name, JSON.stringify(json)], 30000);
  if (r.err) throw new Error((r.stderr || r.stdout || r.err.message).trim().slice(0, 500));
  return (r.stdout || '').trim();
}
async function mcpRemove(name) {
  if (!/^[\w.-]{1,60}$/.test(String(name || ''))) throw new Error('Bad name.');
  const r = await runCmd('claude', ['mcp', 'remove', '-s', 'user', name], 30000);
  if (r.err) throw new Error((r.stderr || r.stdout || r.err.message).trim().slice(0, 500));
}

let fullName = '';
if (IS_MAC) runCmd('id', ['-F']).then((r) => { fullName = r.stdout.trim(); });
function displayName() {
  if (state.settings.name) return state.settings.name;
  if (fullName) return fullName.split(' ')[0];
  const u = os.userInfo().username || 'there';
  const n = u.replace(/[._-]+/g, ' ').trim();
  return n.charAt(0).toUpperCase() + n.slice(1);
}

// ------------------------------------------------------------- 5. HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === '/') {
    if (url.searchParams.get('t') !== TOKEN) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<p style="font:15px system-ui;padding:40px">Open the link printed in the terminal window (it contains an access token).</p>');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(await fsp.readFile(path.join(PUBLIC, 'index.html')));
    return;
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname));
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await fsp.readFile(file));
    return;
  }
  res.writeHead(404); res.end();
});

// ---------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ noServer: true, maxPayload: 40 * 1024 * 1024 });
const ALLOWED_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const clients = new Set();
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s); }

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ws' || url.searchParams.get('t') !== TOKEN || !ALLOWED_ORIGINS.has(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

function sessionInfo(rt) {
  const meta = rt.sdkId ? metaOf(rt.sdkId) : {};
  return { sid: rt.localId, sdkId: rt.sdkId, kind: rt.kind, cwd: rt.cwd, title: rt.title || firstUserText(rt), status: rt.status, mode: rt.mode, model: rt.model,
    browser: rt.browser, cost: rt.cost, pinned: !!meta.pinned, archived: !!meta.archived, routineId: rt.routineId };
}

wss.on('connection', async (ws) => {
  clients.add(ws);
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  send({ type: 'hello', platform: process.platform, home: os.homedir(), user: displayName(), chatDir: CHAT_DIR, version: APP_VERSION, settings: state.settings, auth, routines: state.routines });
  send({ type: 'sessions', items: await sidebar(), projects: projects() });
  if (!auth.checked) checkAuth();

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    try {
      const rt = msg.sid ? (runtimes.get(msg.sid) || bySdk.get(msg.sid)) : null;
      switch (msg.type) {
        // ---- sessions
        case 'new': {
          const kind = KINDS.includes(msg.kind) ? msg.kind : 'code';
          const cwd = kind === 'chat' ? CHAT_DIR : safeDir(msg.cwd);
          if (!cwd) { send({ type: 'error', message: `Folder not found: ${msg.cwd}` }); break; }
          const r = createRuntime({ kind, cwd });
          if (typeof msg.mode === 'string' && MODES.includes(msg.mode)) r.mode = msg.mode;
          if (typeof msg.model === 'string') r.model = msg.model.trim().slice(0, 200);
          send({ type: 'opened', info: sessionInfo(r), items: [], liveText: '' });
          break;
        }
        case 'open': {
          let r = rt;
          if (!r) r = await openFromDisk(msg.sid, msg.cwd);
          r.unread = false;
          send({ type: 'opened', info: sessionInfo(r), items: r.items, liveText: r.liveText });
          sidebarDirty();
          break;
        }
        case 'send': {
          if (!rt || rt.status !== 'idle' || typeof msg.text !== 'string') break;
          const files = Array.isArray(msg.files) ? msg.files.filter((f) => typeof f === 'string' && path.resolve(f).startsWith(UPLOAD_DIR)) : [];
          let text = msg.text.trim();
          if (!text && files.length) text = 'Please look at the attached files.';
          if (!text) break;
          emit(rt, { type: 'user', text, files: files.map((f) => path.basename(f)) });
          if (files.length) text += `\n\nAttached files (read them with your tools):\n${files.map((f) => `- ${f}`).join('\n')}`;
          runTurn(rt, text);
          sidebarDirty();
          break;
        }
        case 'stop':
          if (!rt) break;
          denyAllPending(rt, 'The user stopped the task.');
          rt.abort?.abort();
          break;
        case 'permit': {
          if (!rt) break;
          const resolve = rt.pending.get(msg.id);
          if (!resolve) break;
          if (msg.always) rt.alwaysAllow.add(allowKey(msg.tool || ''));
          resolve(msg.allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'The user refused this action.' });
          break;
        }
        case 'sessionSettings': {
          if (!rt) break;
          if (MODES.includes(msg.mode)) rt.mode = msg.mode;
          if (typeof msg.model === 'string') rt.model = msg.model.trim().slice(0, 200);
          if (typeof msg.browser === 'boolean') rt.browser = msg.browser;
          send({ type: 'info', info: sessionInfo(rt) });
          break;
        }
        case 'rename': {
          const title = String(msg.title || '').trim().slice(0, 200);
          if (!title) break;
          if (rt) rt.title = title;
          const sdkId = rt?.sdkId || msg.sid;
          if (sdkId) await renameSession(sdkId, title, rt?.cwd ? { dir: rt.cwd } : undefined).catch(() => {});
          invalidateListing(); sidebarDirty();
          break;
        }
        case 'pin': case 'archive': {
          const sdkId = rt?.sdkId || msg.sid;
          if (!sdkId) break;
          setMeta(sdkId, { [msg.type === 'pin' ? 'pinned' : 'archived']: !!msg.value });
          sidebarDirty();
          break;
        }
        case 'delete': {
          const sdkId = rt?.sdkId || msg.sid;
          if (rt) { denyAllPending(rt, 'Deleted.'); rt.abort?.abort(); runtimes.delete(rt.localId); if (rt.sdkId) bySdk.delete(rt.sdkId); }
          if (sdkId) { await deleteSession(sdkId, rt?.cwd ? { dir: rt.cwd } : undefined).catch(() => {}); delete state.meta[sdkId]; saveState(); }
          invalidateListing(); sidebarDirty();
          break;
        }
        case 'sessions': invalidateListing(); send({ type: 'sessions', items: await sidebar(), projects: projects() }); break;

        // ---- projects & folders
        case 'addProject': {
          const dir = safeDir(msg.path);
          if (!dir) { send({ type: 'error', message: `Folder not found: ${msg.path}` }); break; }
          if (!state.projects.some((p) => p.path === dir)) { state.projects.push({ path: dir, name: path.basename(dir) || dir, addedAt: Date.now() }); saveState(); }
          sidebarDirty();
          break;
        }
        case 'removeProject': state.projects = state.projects.filter((p) => p.path !== msg.path); saveState(); sidebarDirty(); break;
        case 'ls': send({ type: 'ls', ref: msg.ref, ...(await listDirs(msg.path)) }); break;
        case 'upload': {
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

        // ---- routines
        case 'routineSave': {
          const prev = state.routines.find((r) => r.id === msg.routine?.id);
          const r = normalizeRoutine(msg.routine || {}, prev || {});
          if (!safeDir(r.cwd)) { send({ type: 'error', message: `Folder not found: ${r.cwd}` }); break; }
          if (prev) Object.assign(prev, r); else state.routines.push(r);
          saveState(); broadcast({ type: 'routines', items: state.routines });
          break;
        }
        case 'routineDelete': state.routines = state.routines.filter((r) => r.id !== msg.id); saveState(); broadcast({ type: 'routines', items: state.routines }); break;
        case 'routineToggle': {
          const r = state.routines.find((x) => x.id === msg.id); if (!r) break;
          r.enabled = !!msg.enabled; r.nextRun = r.enabled ? computeNextRun(r) : null;
          saveState(); broadcast({ type: 'routines', items: state.routines });
          break;
        }
        case 'routineRun': {
          const r = state.routines.find((x) => x.id === msg.id); if (!r) break;
          const started = await runRoutine(r, true);
          if (started) send({ type: 'opened', info: sessionInfo(started), items: started.items, liveText: '' });
          break;
        }

        // ---- customize: skills, plugins, connectors
        case 'skills': send({ type: 'skills', items: await listSkills() }); break;
        case 'skillAdd': {
          try { const name = await addSkill(msg); send({ type: 'toast', text: `Skill “${name}” installed.` }); }
          catch (err) { send({ type: 'error', message: String(err.message || err) }); }
          send({ type: 'skills', items: await listSkills() });
          break;
        }
        case 'skillDelete': {
          try { await deleteSkill(msg.dir); } catch (err) { send({ type: 'error', message: String(err.message || err) }); }
          send({ type: 'skills', items: await listSkills() });
          break;
        }
        case 'plugins': send({ type: 'plugins', ...(await listPlugins()) }); break;
        case 'pluginAction': {
          send({ type: 'toast', text: `${msg.action} ${msg.id}…` });
          try { const out = await pluginAction(msg.action, msg.id); send({ type: 'toast', text: out || `${msg.action} done. Applies to new sessions.` }); }
          catch (err) { send({ type: 'error', message: String(err.message || err) }); }
          send({ type: 'plugins', ...(await listPlugins()) });
          break;
        }
        case 'marketplaceAdd': {
          try { await marketplaceAdd(msg.source); send({ type: 'toast', text: 'Marketplace added.' }); }
          catch (err) { send({ type: 'error', message: String(err.message || err) }); }
          send({ type: 'plugins', ...(await listPlugins()) });
          break;
        }
        case 'mcp': send({ type: 'mcp', items: await listMcp() }); break;
        case 'mcpAdd': {
          try { await mcpAdd(msg); send({ type: 'toast', text: `Connector “${msg.name}” added. Applies to new sessions.` }); }
          catch (err) { send({ type: 'error', message: String(err.message || err) }); }
          send({ type: 'mcp', items: await listMcp() });
          break;
        }
        case 'mcpRemove': {
          try { await mcpRemove(msg.name); } catch (err) { send({ type: 'error', message: String(err.message || err) }); }
          send({ type: 'mcp', items: await listMcp() });
          break;
        }

        // ---- settings, auth
        case 'settings': {
          const s = state.settings;
          if (MODES.includes(msg.mode)) s.mode = msg.mode;
          if (MODES.includes(msg.coworkMode)) s.coworkMode = msg.coworkMode;
          if (typeof msg.model === 'string') s.model = msg.model.trim().slice(0, 200);
          if (typeof msg.browser === 'boolean') s.browser = msg.browser;
          if (typeof msg.lang === 'string') s.lang = msg.lang.slice(0, 10);
          if (typeof msg.name === 'string') s.name = msg.name.trim().slice(0, 60);
          saveState(); broadcast({ type: 'settings', settings: s, user: displayName() });
          break;
        }
        case 'authCheck': send({ type: 'auth', auth: await checkAuth() }); break;
        case 'authLogin': openLoginTerminal(); break;
        case 'authTest': {
          // one tiny real request to prove the connection works end to end
          try {
            let reply = '';
            const q = query({ prompt: 'Reply with the single word: ready', options: { cwd: PROBE_DIR, tools: [], maxTurns: 1, systemPrompt: 'Answer in one word.', permissionMode: 'default' } });
            for await (const m of q) {
              if (m.type === 'assistant') reply += (m.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
              if (m.type === 'result' && m.is_error) throw new Error(m.errors?.join?.('\n') || m.result || m.subtype);
            }
            auth = { ...auth, checked: true, connected: true, detail: '' };
            broadcast({ type: 'auth', auth });
            send({ type: 'authTest', ok: true, reply: reply.trim().slice(0, 200) });
          } catch (err) {
            const message = String(err?.message || err);
            auth = { ...auth, checked: true, connected: false, detail: message.slice(0, 400) };
            broadcast({ type: 'auth', auth });
            send({ type: 'authTest', ok: false, message });
          }
          break;
        }
      }
    } catch (err) {
      send({ type: 'error', message: String(err?.message || err) });
    }
  });

  ws.on('close', () => clients.delete(ws));
});

// -------------------------------------------------------------- helpers
function safeDir(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const dir = path.resolve(p);
  try { return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

async function listDirs(p) {
  if (IS_WIN && (!p || p === 'drives')) {
    const drives = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) drives.push({ name: `${l}:`, path: `${l}:\\` });
    return { path: 'drives', parent: null, dirs: drives, home: os.homedir() };
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
  if (IS_WIN) exec(`start "" msedge "${url}"`, (err) => { if (err) exec(`start "" "${url}"`); });
  else if (IS_MAC) exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Claude Web UI ${APP_VERSION} is running.`);
  console.log(`  Open: ${URL_WITH_TOKEN}`);
  console.log('  Keep this window open. Press Ctrl+C to stop.\n');
  checkAuth();
  listing();
  openBrowser(URL_WITH_TOKEN);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other window or set PORT=3738.`);
  else console.error(err);
  process.exit(1);
});
