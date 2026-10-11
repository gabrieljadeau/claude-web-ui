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
import https from 'node:https';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { spawn } from 'node:child_process';
import {
  query, listSessions, getSessionMessages, renameSession, deleteSession, forkSession,
} from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------- 1. config
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3737);
const TOKEN = process.env.CLAUDE_WEB_UI_TOKEN || crypto.randomBytes(16).toString('hex');   // kept across a "Relaunch to update" so open tabs reconnect
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const DATA_DIR = path.join(os.homedir(), '.claude-web-ui');
const CHAT_DIR = path.join(DATA_DIR, 'chats');       // cwd of "Chat" sessions (no project)
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PROBE_DIR = path.join(DATA_DIR, 'probe');      // cwd of the tiny connection-test requests (hidden from the sidebar)
const SHOTS_DIR = path.join(DATA_DIR, 'shots');      // images returned by tools (browser screenshots…)
const BROWSER_PROFILE = path.join(DATA_DIR, 'browser-profile');
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_UPLOAD = 25 * 1024 * 1024;
const URL_WITH_TOKEN = `http://${HOST}:${PORT}/?t=${TOKEN}`;
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

for (const d of [DATA_DIR, CHAT_DIR, UPLOAD_DIR, PROBE_DIR, SHOTS_DIR]) fs.mkdirSync(d, { recursive: true });

const KINDS = ['chat', 'cowork', 'code', 'routine'];
const MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
const READ_ONLY_TOOLS = new Set(['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', 'LS']);
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const REPO = detectRepo();

const PROMPTS = {
  common: 'You are being used through a local web interface on the user\'s computer (Claude Web UI). Keep answers readable: short paragraphs, lists where helpful.',
  chat: 'This is a general conversation ("Chat"): you have no project folder. You can read files the user attaches and fetch web pages, nothing else. Do not try to run commands or edit files.',
  cowork: 'This is a "Cowork" task: the user gave you a folder to work in autonomously. Plan briefly, do the work, save results as files in that folder, and finish with a short summary of what you produced and where.',
  code: 'This is a "Code" session in a project folder, like the claude terminal command.',
  routine: 'This is a scheduled routine running without anyone watching. Do the task completely, do not ask questions, and finish with a concise report of what you did.',
  browser: 'You have a real web browser: the tools whose names start with mcp__browser__ (if they are listed as deferred, load them with ToolSearch first). The user watches that browser live in a panel next to the chat, so when you look something up on the web (a site, the weather, prices, news, documentation) prefer the browser tools over curl or WebFetch, so they can follow along. WebSearch is fine for finding where to look.',
};

// Playwright's MCP server lets Claude drive a browser (navigate, click, type, read pages).
// When we could launch Chrome/Edge ourselves with a debugging port, Playwright attaches to it
// and the app can stream that window into the "Browser" panel.
function browserServer() {
  const args = ['-y', '@playwright/mcp@latest', '--output-dir', SHOTS_DIR];
  if (liveBrowser.ready) args.push('--cdp-endpoint', `http://127.0.0.1:${CDP_PORT}`);
  else args.push('--browser', IS_WIN ? 'msedge' : 'chrome');
  return IS_WIN
    ? { type: 'stdio', command: 'cmd', args: ['/c', 'npx', ...args] }
    : { type: 'stdio', command: 'npx', args };
}

// ---- live browser (Chrome/Edge with a CDP port) ----
// The same window is driven by Claude (through Playwright's MCP) and by the user (through the Browser pane:
// tabs, address bar, clicks and keys are relayed over CDP).
const liveBrowser = { ready: false, proc: null, watchers: 0, cdp: null, target: null, wanted: null, lastFrame: null, tabs: [], page: null, pending: new Map(), seq: 0 };
function findBrowserExe() {
  const c = [process.env.CLAUDE_WEB_UI_BROWSER].filter(Boolean);
  if (IS_WIN) {
    for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean)) {
      c.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (IS_MAC) c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  else c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  return c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
function httpJson(url, timeout = 1500, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request(url, { method, timeout }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b ? { text: b } : null); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
  });
}
const cdpUrl = (p) => `http://127.0.0.1:${CDP_PORT}/json${p}`;
async function ensureLiveBrowser() {
  const ok = await launchLiveBrowser();
  if (ok && liveBrowser.watchers) startScreencast(); // someone is already looking at the Browser pane
  return ok;
}
async function launchLiveBrowser() {
  if (await httpJson(cdpUrl('/version'))) { liveBrowser.ready = true; return true; }
  const exe = findBrowserExe();
  if (!exe) { liveBrowser.ready = false; return false; }
  try {
    // Headless by default: the Browser pane is the only view of it, like the embedded browser of the desktop app
    // (no Chrome window pops up or steals the focus). CLAUDE_WEB_UI_BROWSER_WINDOW=1 shows the real window instead.
    const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${BROWSER_PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,860',
      '--disable-features=TranslateUI', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
    if (!process.env.CLAUDE_WEB_UI_BROWSER_WINDOW) args.push('--headless=new');
    const proc = spawn(exe, [...args, 'about:blank'], { detached: !IS_WIN, stdio: 'ignore', windowsHide: true });
    proc.unref(); liveBrowser.proc = proc;
  } catch { liveBrowser.ready = false; return false; }
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); if (await httpJson(cdpUrl('/version'))) { liveBrowser.ready = true; return true; } }
  liveBrowser.ready = false; return false;
}
const isRealPage = (t) => t.type === 'page' && !/^(devtools|chrome|chrome-extension):/.test(t.url || '');
async function browserTabs() {
  const list = await httpJson(cdpUrl('/list'));
  if (!Array.isArray(list)) return null;
  liveBrowser.tabs = list.filter(isRealPage).map((t) => ({ id: t.id, url: t.url, title: t.title, favicon: t.faviconUrl || '' }));
  return liveBrowser.tabs;
}
function browserStateMsg(extra = {}) {
  return { type: 'browserState', live: liveBrowser.ready, page: liveBrowser.page, tabs: liveBrowser.tabs, active: liveBrowser.target, following: !liveBrowser.wanted, ...extra };
}
// Streams the active page of the live browser as JPEG frames to every client that asked for it.
let screencastTimer = null;
async function screencastTick() {
  if (!liveBrowser.watchers) { stopScreencast(); return; }
  const tabs = await browserTabs();
  if (!tabs) { liveBrowser.ready = false; closeCdp(); broadcast(browserStateMsg()); return; }
  liveBrowser.ready = true;
  const page = tabs.find((t) => t.id === liveBrowser.wanted) || tabs.find((t) => t.id === liveBrowser.target) || tabs[0];
  if (!page) {
    closeCdp();
    // Chrome may be running with no tab at all (Playwright closes its pages when a turn ends): open a blank one so there is something to show.
    if (Date.now() - (liveBrowser.lastNew || 0) > 10000) { liveBrowser.lastNew = Date.now(); await httpJson(cdpUrl('/new?about:blank'), 1500, 'PUT'); }
    liveBrowser.page = null; broadcast(browserStateMsg()); return;
  }
  liveBrowser.page = { url: page.url, title: page.title };
  if (liveBrowser.target === page.id && liveBrowser.cdp?.readyState === 1) { broadcast(browserStateMsg()); return; }
  closeCdp();
  liveBrowser.target = page.id;
  await httpJson(cdpUrl('/activate/' + page.id), 1500); // only the foreground tab produces screencast frames
  const raw = (await httpJson(cdpUrl('/list')))?.find?.((t) => t.id === page.id);
  if (!raw?.webSocketDebuggerUrl) return;
  const ws = new WsClient(raw.webSocketDebuggerUrl, { perMessageDeflate: false });
  liveBrowser.cdp = ws;
  ws.on('open', () => { cdpSend('Page.enable'); cdpSend('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 }); });
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.id && liveBrowser.pending.has(m.id)) { const p = liveBrowser.pending.get(m.id); liveBrowser.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Page.screencastFrame') {
      cdpSend('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
      liveBrowser.lastFrame = m.params.data;
      const md = m.params.metadata || {};
      broadcast({ type: 'browserFrame', data: m.params.data, url: liveBrowser.page?.url, title: liveBrowser.page?.title, w: md.deviceWidth, h: md.deviceHeight, id: page.id });
    }
  });
  ws.on('close', () => { if (liveBrowser.cdp === ws) { liveBrowser.cdp = null; liveBrowser.target = null; } for (const p of liveBrowser.pending.values()) p.reject(new Error('closed')); liveBrowser.pending.clear(); });
  ws.on('error', () => {});
  broadcast(browserStateMsg());
}
function closeCdp() { if (liveBrowser.cdp) { try { liveBrowser.cdp.close(); } catch { /* ignore */ } } liveBrowser.cdp = null; liveBrowser.target = null; }
function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = liveBrowser.cdp; if (!ws || ws.readyState !== 1) return reject(new Error('No page is open.'));
    const id = ++liveBrowser.seq; liveBrowser.pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (liveBrowser.pending.has(id)) { liveBrowser.pending.delete(id); reject(new Error('timeout')); } }, 10000);
  });
}
function startScreencast() { if (!screencastTimer) { screencastTimer = setInterval(screencastTick, 1200); screencastTick(); } }
function stopScreencast() { clearInterval(screencastTimer); screencastTimer = null; closeCdp(); }
// Tabs, address bar and history, driven from the Browser pane.
async function browserAction(msg) {
  if (!liveBrowser.ready && !(await ensureLiveBrowser())) throw new Error('No Chrome or Edge found on this computer. Set CLAUDE_WEB_UI_BROWSER to the path of one.');
  const a = msg.action;
  if (a === 'newTab' || (a === 'navigate' && !liveBrowser.cdp)) {
    const t = await httpJson(cdpUrl('/new?' + (a === 'navigate' ? normalizeUrl(msg.url) : 'about:blank')), 2000, 'PUT');
    if (t?.id) { liveBrowser.wanted = t.id; liveBrowser.target = null; await httpJson(cdpUrl('/activate/' + t.id), 1500); }
  } else if (a === 'selectTab') { liveBrowser.wanted = msg.id; liveBrowser.target = null; await httpJson(cdpUrl('/activate/' + msg.id), 1500); }
  else if (a === 'closeTab') { await httpJson(cdpUrl('/close/' + msg.id), 1500); if (liveBrowser.wanted === msg.id) liveBrowser.wanted = null; }
  else if (a === 'navigate') { liveBrowser.wanted = liveBrowser.target; await cdpSend('Page.navigate', { url: normalizeUrl(msg.url) }); }
  else if (a === 'reload') await cdpSend('Page.reload', {});
  else if (a === 'back' || a === 'forward') {
    const h = await cdpSend('Page.getNavigationHistory'); const i = h.currentIndex + (a === 'back' ? -1 : 1);
    if (h.entries[i]) await cdpSend('Page.navigateToHistoryEntry', { entryId: h.entries[i].id });
  }
  else if (a === 'follow') liveBrowser.wanted = null; // follow whatever page Claude works on
  if (liveBrowser.watchers) { startScreencast(); setTimeout(screencastTick, 150); }
}
function normalizeUrl(u) {
  u = String(u || '').trim(); if (!u) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (/^localhost(:\d+)?([/?#]|$)/.test(u) || /^(\d{1,3}\.){3}\d{1,3}/.test(u) || /^[\w-]+(\.[\w-]+)+/.test(u)) return 'http' + (/^localhost|^(\d{1,3}\.){3}\d{1,3}/.test(u) ? '' : 's') + '://' + u;
  return 'https://www.google.com/search?q=' + encodeURIComponent(u);
}
// Mouse, wheel and keyboard from the Browser pane, in CSS pixels of the streamed page.
const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
async function browserInput(m) {
  const mods = (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
  if (m.kind === 'mouse') {
    const btn = ['left', 'middle', 'right'][m.button] || 'none';
    await cdpSend('Input.dispatchMouseEvent', { type: m.event, x: m.x, y: m.y, button: m.event === 'mouseMoved' ? (m.buttons ? btn : 'none') : btn, buttons: m.buttons || 0, clickCount: m.clicks || 0, modifiers: mods });
  } else if (m.kind === 'wheel') {
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy, modifiers: mods });
  } else if (m.kind === 'key') {
    const printable = m.key?.length === 1 && !m.ctrl && !m.meta;
    const base = { key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, modifiers: mods, autoRepeat: !!m.repeat };
    if (m.event === 'keydown') { await cdpSend('Input.dispatchKeyEvent', { ...base, type: printable ? 'keyDown' : 'rawKeyDown', text: printable ? m.key : (m.key === 'Enter' ? '\r' : undefined), unmodifiedText: printable ? m.key : undefined }); }
    else await cdpSend('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  } else if (m.kind === 'text') await cdpSend('Input.insertText', { text: String(m.text || '') });
}

// ---- dev servers from .claude/launch.json (the "play" buttons of the Browser pane) ----
const devServers = new Map(); // key cwd + name -> { proc, name, cwd, port, url, logs, status }
const devKey = (cwd, name) => cwd + '\n' + name;
async function readLaunchConfig(cwd) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(cwd, '.claude', 'launch.json'), 'utf8'));
    return (j.configurations || []).filter((c) => c && c.name).map((c) => ({ name: String(c.name), port: c.port ? Number(c.port) : null, url: c.url || '', command: c.runtimeExecutable ? [c.runtimeExecutable, ...(c.runtimeArgs || [])].join(' ') : '', autoPort: !!c.autoPort }));
  } catch { return []; }
}
async function launchList(cwd) {
  const items = await readLaunchConfig(cwd);
  for (const it of items) { const s = devServers.get(devKey(cwd, it.name)); it.status = s?.status || 'stopped'; it.liveUrl = s?.url || ''; it.livePort = s?.port || null; }
  return items;
}
const portFree = (port) => new Promise((resolve) => { const srv = net.createServer(); srv.once('error', () => resolve(false)); srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true))); });
const portOpen = (port) => new Promise((resolve) => { const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); s.setTimeout(800, () => { s.destroy(); resolve(false); }); });
async function freePort(from) { for (let p = from; p < from + 50; p++) if (await portFree(p)) return p; return from; }
function devLog(s, line) { s.logs.push(line); if (s.logs.length > 400) s.logs.splice(0, s.logs.length - 400); broadcast({ type: 'launchLog', cwd: s.cwd, name: s.name, line }); }
function devBroadcast(cwd) { launchList(cwd).then((items) => broadcast({ type: 'launchList', cwd, items })); }
async function launchStart(cwd, name) {
  const cfg = (await readLaunchConfig(cwd)).find((c) => c.name === name);
  if (!cfg) throw new Error(`No configuration "${name}" in .claude/launch.json`);
  const key = devKey(cwd, name); const old = devServers.get(key);
  if (old?.status === 'running' || old?.status === 'starting') { if (old.url) await openInBrowser(old.url); return; }
  const raw = JSON.parse(await fsp.readFile(path.join(cwd, '.claude', 'launch.json'), 'utf8')).configurations.find((c) => c.name === name);
  let port = cfg.port;
  if (port && !(await portFree(port))) {
    if (cfg.autoPort) port = await freePort(port + 1);
    else if (await portOpen(port)) { // something already listens there: just show it
      const url = cfg.url || `http://localhost:${port}`; devServers.set(key, { name, cwd, port, url, logs: [`Port ${port} is already in use; showing what runs there.`], status: 'running', proc: null, attached: true }); devBroadcast(cwd); await openInBrowser(url); return;
    }
  }
  const s = { name, cwd, port, url: cfg.url || (port ? `http://localhost:${port}` : ''), logs: [], status: 'starting', proc: null };
  devServers.set(key, s); devBroadcast(cwd);
  if (!raw.runtimeExecutable) { s.status = 'running'; devBroadcast(cwd); if (s.url) await openInBrowser(s.url); return; }
  const env = { ...process.env, ...(raw.env || {}) }; if (port && port !== cfg.port) env.PORT = String(port);
  devLog(s, `$ ${[raw.runtimeExecutable, ...(raw.runtimeArgs || [])].join(' ')}${port && port !== cfg.port ? `   (PORT=${port})` : ''}`);
  let proc;
  try { proc = spawn(raw.runtimeExecutable, raw.runtimeArgs || [], { cwd, env, shell: IS_WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (err) { s.status = 'error'; devLog(s, String(err.message || err)); devBroadcast(cwd); return; }
  s.proc = proc;
  const onData = (d) => { for (const line of String(d).split(/\r?\n/)) if (line) devLog(s, line); };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  proc.on('error', (err) => { s.status = 'error'; devLog(s, String(err.message || err)); devBroadcast(cwd); });
  proc.on('exit', (code) => { if (s.proc === proc) { s.status = code ? 'error' : 'stopped'; s.proc = null; devLog(s, `Process exited (${code ?? 'killed'}).`); devBroadcast(cwd); } });
  if (port) {
    for (let i = 0; i < 120 && s.proc === proc && s.status === 'starting'; i++) { await new Promise((r) => setTimeout(r, 500)); if (await portOpen(port)) break; }
    if (s.proc !== proc || s.status !== 'starting') return;
  } else await new Promise((r) => setTimeout(r, 1500));
  s.status = 'running'; devBroadcast(cwd);
  if (s.url) await openInBrowser(s.url);
}
async function launchStop(cwd, name) {
  const s = devServers.get(devKey(cwd, name)); if (!s) return;
  if (s.proc) { try { if (IS_WIN) spawn('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true }); else s.proc.kill('SIGTERM'); } catch { /* ignore */ } }
  s.status = 'stopped'; s.proc = null; devBroadcast(cwd);
}
async function openInBrowser(url) {
  if (!liveBrowser.ready && !(await ensureLiveBrowser())) { openBrowser(url); return; }
  const tabs = (await browserTabs()) || [];
  const same = tabs.find((t) => t.url === url || t.url === url + '/');
  if (same) { liveBrowser.wanted = same.id; liveBrowser.target = null; await httpJson(cdpUrl('/activate/' + same.id), 1500); }
  else { const t = await httpJson(cdpUrl('/new?' + url), 2000, 'PUT'); if (t?.id) { liveBrowser.wanted = t.id; liveBrowser.target = null; } }
  if (liveBrowser.watchers) { startScreencast(); setTimeout(screencastTick, 200); }
}

// ---- files pane ----
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', 'target', '.playwright-mcp']);
async function fsList(dir) {
  const abs = path.resolve(dir);
  if (!isAllowedFile(abs)) throw new Error('Not allowed');
  const ents = await fsp.readdir(abs, { withFileTypes: true });
  const items = ents.filter((e) => e.name !== '.git' && e.name !== '.DS_Store').map((e) => ({ name: e.name, dir: e.isDirectory(), path: path.join(abs, e.name) }));
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
  return items;
}
async function fsSearch(root, q, content) {
  root = path.resolve(root); if (!isAllowedFile(root)) throw new Error('Not allowed');
  const needle = String(q || '').toLowerCase(); const out = []; let seen = 0;
  const walk = async (dir, depth) => {
    if (out.length >= 100 || seen > 20000 || depth > 12) return;
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= 100) return; seen++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (!content) { if (e.name.toLowerCase().includes(needle)) out.push({ path: p, name: e.name, rel: path.relative(root, p) }); continue; }
      try {
        const st = await fsp.stat(p); if (st.size > 600 * 1024) continue;
        const buf = await fsp.readFile(p); if (buf.subarray(0, 1024).includes(0)) continue;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && out.length < 100; i++) if (lines[i].toLowerCase().includes(needle)) out.push({ path: p, name: e.name, rel: path.relative(root, p), line: i + 1, text: lines[i].trim().slice(0, 160) });
      } catch { /* skip */ }
    }
  };
  await walk(root, 0);
  return out;
}

// ---- terminal pane: one shell per session, no pty (plain pipes), commands end with a marker so the pane knows when to show the prompt again ----
const TERM_MARK = '\u001e';
function termOpen(rt) {
  if (rt.term?.proc && rt.term.proc.exitCode === null) return rt.term;
  const shell = IS_WIN ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
  const args = IS_WIN ? ['/Q', '/K', 'prompt $_'] : [];
  const proc = spawn(shell, args, { cwd: rt.cwd, env: { ...process.env, TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', CLICOLOR: '0', NO_COLOR: '1', PS1: '' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const t = { proc, shell: path.basename(shell), cwd: rt.cwd };
  rt.term = t;
  const out = (d) => broadcast({ type: 'termOut', sid: rt.localId, data: String(d) });
  proc.stdout.on('data', out); proc.stderr.on('data', out);
  proc.on('exit', (code) => { if (rt.term === t) { broadcast({ type: 'termOut', sid: rt.localId, data: `\n[shell exited${code ? ' with code ' + code : ''}]\n` }); rt.term = null; } });
  proc.on('error', (err) => broadcast({ type: 'termOut', sid: rt.localId, data: `\n[${err.message}]\n` }));
  return t;
}
function termRun(rt, cmd) {
  const t = termOpen(rt); if (!t?.proc?.stdin?.writable) return;
  const line = IS_WIN ? `${cmd}\r\necho ${TERM_MARK}%CD%${TERM_MARK}\r\n` : `${cmd}\nprintf '${TERM_MARK}%s${TERM_MARK}\\n' "$PWD"\n`;
  t.proc.stdin.write(line);
}
function termKill(rt) { const t = rt.term; if (!t?.proc) return; rt.term = null; try { if (IS_WIN) spawn('taskkill', ['/pid', String(t.proc.pid), '/T', '/F'], { windowsHide: true }); else t.proc.kill('SIGKILL'); } catch { /* ignore */ } }

// ------------------------------------------------------- persistent state
const state = loadState();
function loadState() {
  const def = { projects: [], routines: [], meta: {}, usage: [], settings: { model: '', effort: '', mode: 'default', coworkMode: 'auto', browser: true, lang: 'fr-FR', repo: '', githubToken: '' } };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const st = { ...def, ...s, settings: { ...def.settings, ...(s.settings || {}) } };
    if (!st.settings.v) { st.settings.v = 2; if (st.settings.coworkMode === 'acceptEdits') st.settings.coworkMode = 'auto'; } // 0.2: Cowork defaults to Auto
    return st;
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
    effort: state.settings.effort || '',
    browser: state.settings.browser,
    lastUuid: null,               // uuid of the last assistant message: the cut point used by edit / retry
    liveThinking: '',
    routineId,
    abort: null, pending: new Map(), alwaysAllow: new Set(),
    liveText: '', cost: 0, totalCost: 0, context: null, lastActivity: Date.now(), unread: false, createdAt: Date.now(),
  };
  runtimes.set(rt.localId, rt);
  if (sdkId) bySdk.set(sdkId, rt);
  return rt;
}

function emit(rt, ev) {
  // keep the transcript in memory so a client that opens the session later sees everything
  switch (ev.type) {
    case 'user': rt.items.push({ type: 'user', text: ev.text, files: ev.files, paths: ev.paths, prev: ev.prev ?? null }); break;
    case 'thinkingStart': rt.liveThinking = ''; break;
    case 'thinkingDelta': rt.liveThinking += ev.text; break;
    case 'thinking': rt.liveThinking = ''; rt.items.push({ type: 'thinking', text: ev.text }); break;
    case 'delta': rt.liveText += ev.text; break;
    case 'assistantText': rt.liveText = ''; rt.items.push({ type: 'assistant', text: ev.text }); break;
    case 'toolUse': if (String(ev.name).startsWith('mcp__browser__')) liveBrowser.wanted = null; if (!ev.parent) rt.liveText = ''; rt.items.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, result: null, isError: false, parent: ev.parent || null }); break;
    case 'subText': { const t = rt.items.find((i) => i.type === 'tool' && i.id === ev.parent); if (t) t.subText = (t.subText ? t.subText + '\n' : '') + ev.text; break; }
    case 'toolResult': { const t = rt.items.find((i) => i.type === 'tool' && i.id === ev.id); if (t) { t.result = ev.content; t.isError = ev.isError; if (ev.images?.length) t.images = ev.images; } break; }
    case 'permission': rt.items.push({ type: 'perm', id: ev.id, tool: ev.tool, input: ev.input, answer: null }); break;
    case 'permitted': { const p = rt.items.find((i) => i.type === 'perm' && i.id === ev.id); if (p) p.answer = ev.answer; break; }
    case 'note': if (ev.err && sameError(rt, ev.text)) return; rt.items.push({ type: 'note', text: ev.text, err: !!ev.err }); break;
    case 'done': rt.liveText = ''; rt.liveThinking = ''; if (!ev.ok && sameError(rt, ev.message)) ev = { ...ev, message: null }; rt.items.push({ type: 'done', ok: ev.ok, cost: ev.cost, ms: ev.ms, model: ev.model, message: ev.message }); break;
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
    // Read-only lookups never need a prompt once the user already accepted edits.
    if (rt.mode === 'acceptEdits' && READ_ONLY_TOOLS.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
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
    effort: rt.effort || undefined,
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
    if (rt.browser && rt.kind !== 'chat' && !liveBrowser.ready) await ensureLiveBrowser();
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
  if (m.parent_tool_use_id) {
    // Helper agent (subagent) activity: forwarded with its parent so the UI can nest it.
    const parent = m.parent_tool_use_id;
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'tool_use') emit(rt, { type: 'toolUse', id: b.id, name: b.name, input: b.input, parent });
        else if (b.type === 'text' && b.text?.trim()) emit(rt, { type: 'subText', parent, text: b.text.slice(0, 1500) });
      }
    } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) if (b.type === 'tool_result') emit(rt, { type: 'toolResult', id: b.tool_use_id, isError: !!b.is_error, content: resultText(b.content), images: resultImages(b.content, b.tool_use_id), parent });
    }
    return;
  }
  if (m.type === 'stream_event') {
    const e = m.event;
    if (e?.type === 'content_block_start' && e.content_block?.type === 'thinking') emit(rt, { type: 'thinkingStart' });
    if (e?.type === 'content_block_delta') {
      if (e.delta?.type === 'text_delta') emit(rt, { type: 'delta', text: e.delta.text });
      else if (e.delta?.type === 'thinking_delta') emit(rt, { type: 'thinkingDelta', text: e.delta.thinking });
    }
    return;
  }
  if (m.type === 'assistant') {
    const content = m.message?.content || [];
    if (m.uuid) rt.lastUuid = m.uuid;
    const thinking = content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n\n');
    if (thinking) emit(rt, { type: 'thinking', text: thinking });
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    if (text) emit(rt, { type: 'assistantText', text });
    for (const b of content) if (b.type === 'tool_use') emit(rt, { type: 'toolUse', id: b.id, name: b.name, input: b.input });
    return;
  }
  if (m.type === 'user') {
    const content = Array.isArray(m.message?.content) ? m.message.content : [];
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      emit(rt, { type: 'toolResult', id: b.tool_use_id, isError: !!b.is_error, content: resultText(b.content), images: resultImages(b.content, b.tool_use_id) });
    }
    return;
  }
  if (m.type === 'result') {
    const ok = m.subtype === 'success' && !m.is_error;
    // total_cost_usd is cumulative for a resumed session: the turn's cost is the difference.
    const total = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
    const turnCost = total === null ? null : Math.max(0, total - (rt.totalCost || 0));
    if (total !== null) { rt.totalCost = total; rt.cost += turnCost; }
    const mu = m.modelUsage || {};
    const models = Object.entries(mu).sort((a, b) => (b[1].costUSD || 0) - (a[1].costUSD || 0));
    const u = m.usage || {};
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    const window = models.reduce((w, [, x]) => Math.max(w, x.contextWindow || 0), 0);
    if (used) rt.context = { used, window: window || 200000 };
    const model = rt.model || (models[0] ? (models[0][1].canonicalModel || models[0][0]) : '');
    state.usage.push({ at: Date.now(), sid: rt.sdkId, kind: rt.kind, title: (rt.title || firstUserText(rt) || '').slice(0, 80), model: String(model).slice(0, 80), cost: turnCost || 0,
      in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens || 0, ms: m.duration_ms || 0, turns: m.num_turns || 0 });
    if (state.usage.length > 4000) state.usage = state.usage.slice(-3000);
    saveState();
    emit(rt, { type: 'done', ok, cost: turnCost, ms: m.duration_ms || 0, context: rt.context, model,
      message: ok ? null : (m.errors?.join?.('\n') || m.result || m.subtype) });
    if (!ok && m.startup_failure_reason) checkAuth();
    if (!rt.title && !rt.titling && rt.kind !== 'routine') autoTitle(rt);
  }
}

// ---- automatic conversation titles: a 3-7 word title from the first exchange, written by a small model
async function autoTitle(rt) {
  rt.titling = true;
  const first = rt.items.find((i) => i.type === 'user')?.text || '';
  const reply = rt.liveText || [...rt.items].reverse().find((i) => i.type === 'assistant')?.text || '';
  if (!first) { rt.titling = false; return; }
  const prompt = `Write a title for this conversation: 3 to 7 words, in the language of the user, no quotes, no trailing period, Title Case not required.\n\nUser:\n${first.slice(0, 1500)}\n\nAssistant:\n${reply.slice(0, 800)}`;
  try {
    const q = query({ prompt, options: { cwd: PROBE_DIR, tools: [], maxTurns: 1, model: 'haiku', permissionMode: 'default', systemPrompt: 'You write short conversation titles. Reply with the title only.' } });
    let title = '';
    for await (const m of q) if (m.type === 'result' && m.subtype === 'success') title = String(m.result || '');
    title = title.split('\n')[0].replace(/^["'“”«»\s]+|["'“”«»\s.]+$/g, '').slice(0, 80);
    if (!title || rt.title) return;
    rt.title = title;
    if (rt.sdkId) await renameSession(rt.sdkId, title, { dir: rt.cwd }).catch(() => {});
    broadcast({ type: 'info', info: sessionInfo(rt) });
    invalidateListing(); sidebarDirty();
  } catch { /* a missing title is not worth an error */ }
  finally { rt.titling = false; }
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
  const { items, lastUuid } = simplifyHistory(msgs);
  const rt = createRuntime({ kind, cwd: dir || os.homedir(), sdkId, title: info?.customTitle || info?.summary || '', items, routineId: meta.routineId || null });
  rt.lastUuid = lastUuid;
  return rt;
}

function simplifyHistory(msgs) {
  const out = [];
  const tools = new Map();
  let lastUuid = null;
  for (const m of msgs) {
    const c = m.message?.content;
    if (m.parent_tool_use_id) {
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type === 'tool_use') { const t = { type: 'tool', id: b.id, name: b.name, input: b.input, result: null, isError: false, parent: m.parent_tool_use_id }; tools.set(b.id, t); out.push(t); }
        else if (b.type === 'tool_result') { const t = tools.get(b.tool_use_id); if (t) { t.result = resultText(b.content); t.isError = !!b.is_error; const im = resultImages(b.content, b.tool_use_id); if (im.length) t.images = im; } }
      }
      continue;
    }
    if (m.type === 'user') {
      if (typeof c === 'string') { if (c.trim() && !isMetaPrompt(c)) out.push({ type: 'user', text: c, prev: lastUuid }); continue; }
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type === 'tool_result') { const t = tools.get(b.tool_use_id); if (t) { t.result = resultText(b.content); t.isError = !!b.is_error; const im = resultImages(b.content, b.tool_use_id); if (im.length) t.images = im; } }
      }
      const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text.trim() && !isMetaPrompt(text)) out.push({ type: 'user', text, prev: lastUuid });
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      if (m.uuid) lastUuid = m.uuid;
      const thinking = c.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n\n');
      if (thinking.trim()) out.push({ type: 'thinking', text: thinking });
      const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      if (text.trim()) out.push({ type: 'assistant', text });
      for (const b of c) if (b.type === 'tool_use') { const t = { type: 'tool', id: b.id, name: b.name, input: b.input, result: null, isError: false }; tools.set(b.id, t); out.push(t); }
    }
  }
  return { items: out, lastUuid };
}
function isMetaPrompt(s) { return /^<(local-command|command-name|system-reminder|bash-input)/.test(s.trim()); }

function resultText(content) {
  const s = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '' : `[${c.type}]`)).filter(Boolean).join('\n') : '';
  return s.length > 4000 ? s.slice(0, 4000) + '\n… (truncated)' : s;
}
// Images returned by tools (browser screenshots, image reads) are saved so the page can show them.
function resultImages(content, id) {
  if (!Array.isArray(content)) return [];
  const out = [];
  content.forEach((c, i) => {
    if (c.type !== 'image' || c.source?.type !== 'base64' || !c.source.data) return;
    const ext = (c.source.media_type || 'image/png').split('/')[1].replace('jpeg', 'jpg');
    const file = path.join(SHOTS_DIR, `${String(id || 'img').replace(/[^\w-]/g, '')}-${i}.${ext}`);
    try { if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(c.source.data, 'base64')); out.push(file); } catch { /* ignore */ }
  });
  return out;
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
    const pending = rt.items.filter((i) => i.type === 'perm' && !i.answer).map((i) => ({ id: i.id, tool: i.tool, input: i.input }));
    push({ sid: rt.localId, sdkId: rt.sdkId, kind: rt.kind, title: rt.title || firstUserText(rt) || 'New chat', cwd: rt.cwd, when: rt.lastActivity,
      status: rt.status, waiting: rt.pending.size, pending, context: rt.context, cost: rt.cost, unread: rt.unread, pinned: !!meta.pinned, archived: !!meta.archived, routineId: rt.routineId || meta.routineId || null, live: true });
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
    mode: MODES.includes(input.mode) ? input.mode : (prev.mode || 'auto'),
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
const FILE_MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json', '.css': 'text/css', '.js': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8' };
// Files Claude produced may be previewed only when they live in a folder this app works in.
function isAllowedFile(p) {
  const abs = path.resolve(String(p || ''));
  const roots = [DATA_DIR, ...state.projects.map((x) => x.path), ...[...runtimes.values()].map((r) => r.cwd)];
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}
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
  if (url.pathname === '/file') {
    const p = url.searchParams.get('path') || '';
    if (url.searchParams.get('t') !== TOKEN || !isAllowedFile(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(403); res.end('Not allowed'); return; }
    const raw = url.searchParams.get('raw') === '1';
    res.writeHead(200, { 'Content-Type': raw ? 'text/plain; charset=utf-8' : (FILE_MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(p).pipe(res);
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
    browser: rt.browser, effort: rt.effort, cost: rt.cost, context: rt.context, pinned: !!meta.pinned, archived: !!meta.archived, routineId: rt.routineId };
}

wss.on('connection', async (ws) => {
  clients.add(ws);
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  send({ type: 'hello', platform: process.platform, home: os.homedir(), user: displayName(), chatDir: CHAT_DIR, version: APP_VERSION, settings: publicSettings(), auth, routines: state.routines, repo: state.settings.repo || REPO, token: TOKEN });
  send({ type: 'update', ...update });
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
          if (EFFORTS.includes(msg.effort)) r.effort = msg.effort;
          send({ type: 'opened', info: sessionInfo(r), items: [], liveText: '' });
          break;
        }
        case 'open': {
          let r = rt;
          if (!r) r = await openFromDisk(msg.sid, msg.cwd);
          r.unread = false;
          send({ type: 'opened', info: sessionInfo(r), items: r.items, liveText: r.liveText, liveThinking: r.liveThinking });
          sidebarDirty();
          break;
        }
        case 'send': {
          if (!rt || rt.status !== 'idle' || typeof msg.text !== 'string') break;
          const files = Array.isArray(msg.files) ? msg.files.filter((f) => typeof f === 'string' && path.resolve(f).startsWith(UPLOAD_DIR)) : [];
          let text = msg.text.trim();
          if (!text && files.length) text = 'Please look at the attached files.';
          if (!text) break;
          if (msg.edit) {
            // Edit / retry: continue from a copy of the conversation cut just before the edited message.
            const upTo = typeof msg.edit.upTo === 'string' ? msg.edit.upTo : null;
            const idx = rt.items.findIndex((i) => i.type === 'user' && (i.prev || null) === upTo);
            if (rt.sdkId) bySdk.delete(rt.sdkId);
            if (upTo && rt.sdkId) {
              try { const f = await forkSession(rt.sdkId, { dir: rt.cwd, upToMessageId: upTo, title: rt.title || undefined }); rt.sdkId = f.sessionId; bySdk.set(rt.sdkId, rt); setMeta(rt.sdkId, { kind: rt.kind }); }
              catch (err) { send({ type: 'error', message: 'Could not branch the conversation: ' + (err.message || err) }); bySdk.set(rt.sdkId, rt); break; }
            } else { rt.sdkId = null; }
            rt.lastUuid = upTo;
            rt.items = idx >= 0 ? rt.items.slice(0, idx) : [];
            rt.alwaysAllow.clear();
            send({ type: 'opened', info: sessionInfo(rt), items: rt.items, liveText: '' });
            invalidateListing();
          }
          emit(rt, { type: 'user', text, files: files.map((f) => path.basename(f)), paths: files, prev: rt.lastUuid });
          if (!rt.title) broadcast({ type: 'info', info: sessionInfo(rt) });
          if (files.length) text += `\n\nAttached files (read them with your tools):\n${files.map((f) => `- ${f}`).join('\n')}`;
          runTurn(rt, text);
          sidebarDirty();
          break;
        }
        case 'fork': {
          // Branch: a new conversation that contains everything up to (and including) the given assistant message.
          if (!rt) break;
          const upTo = typeof msg.upTo === 'string' ? msg.upTo : null;
          let nr;
          if (upTo && rt.sdkId) {
            try { const f = await forkSession(rt.sdkId, { dir: rt.cwd, upToMessageId: upTo, title: (rt.title || 'Chat') + ' (branch)' }); invalidateListing(); nr = await openFromDisk(f.sessionId, rt.cwd); nr.kind = rt.kind; setMeta(nr.sdkId, { kind: rt.kind }); }
            catch (err) { send({ type: 'error', message: 'Could not branch: ' + (err.message || err) }); break; }
          } else nr = createRuntime({ kind: rt.kind, cwd: rt.cwd, mode: rt.mode, model: rt.model });
          nr.mode = rt.mode; nr.model = rt.model; nr.effort = rt.effort; nr.browser = rt.browser;
          send({ type: 'opened', info: sessionInfo(nr), items: nr.items, liveText: '', draft: msg.draft || '' });
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
          sidebarDirty();
          break;
        }
        case 'sessionSettings': {
          if (!rt) break;
          if (MODES.includes(msg.mode)) rt.mode = msg.mode;
          if (typeof msg.model === 'string') rt.model = msg.model.trim().slice(0, 200);
          if (EFFORTS.includes(msg.effort)) rt.effort = msg.effort;
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
          if (rt) { denyAllPending(rt, 'Deleted.'); termKill(rt); rt.abort?.abort(); runtimes.delete(rt.localId); if (rt.sdkId) bySdk.delete(rt.sdkId); }
          if (sdkId) { await deleteSession(sdkId, rt?.cwd ? { dir: rt.cwd } : undefined).catch(() => {}); delete state.meta[sdkId]; saveState(); }
          invalidateListing(); sidebarDirty();
          break;
        }
        case 'sessions': invalidateListing(); send({ type: 'sessions', items: await sidebar(), projects: projects() }); break;
        case 'dashboard': send({ type: 'dashboard', usage: state.usage.slice(-3000), items: await sidebar(), routines: state.routines }); break;

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
        case 'pickFolder': {
          const dir = await pickFolderNative(safeDir(msg.start) || os.homedir());
          send({ type: 'picked', ref: msg.ref, path: dir || null, unavailable: dir === undefined });
          break;
        }
        case 'reveal': {
          const p = String(msg.path || '');
          if (!isAllowedFile(p) || !fs.existsSync(p)) break;
          if (IS_WIN) execFile('explorer.exe', [`/select,${path.resolve(p)}`]);
          else if (IS_MAC) execFile('open', ['-R', p]);
          else execFile('xdg-open', [path.dirname(p)]);
          break;
        }
        case 'report': {
          try { send({ type: 'reported', ...(await fileIssue(msg)) }); }
          catch (err) { send({ type: 'reported', error: String(err.message || err) }); }
          break;
        }
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
          if (EFFORTS.includes(msg.effort)) s.effort = msg.effort;
          if (typeof msg.repo === 'string') s.repo = msg.repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').slice(0, 120);
          if (typeof msg.githubToken === 'string') s.githubToken = msg.githubToken.trim().slice(0, 200);
          saveState(); broadcast({ type: 'settings', settings: publicSettings(), user: displayName(), repo: s.repo || REPO });
          break;
        }
        case 'browserWatch': {
          const was = ws.watching; ws.watching = !!msg.on;
          liveBrowser.watchers += (ws.watching ? 1 : 0) - (was ? 1 : 0);
          // "lazy": show the pane without launching a browser; it starts streaming once a page is opened (by Claude or from the pane).
          if (ws.watching) {
            if (!liveBrowser.ready && !msg.lazy) await ensureLiveBrowser();
            if (!liveBrowser.ready && msg.lazy) liveBrowser.ready = !!(await httpJson(cdpUrl('/version')));
            if (liveBrowser.ready) await browserTabs();
            send(browserStateMsg({ lazy: !!msg.lazy, frame: liveBrowser.lastFrame }));
            if (liveBrowser.ready) startScreencast();
          } else if (liveBrowser.watchers <= 0) { liveBrowser.watchers = 0; stopScreencast(); }
          break;
        }
        case 'browserAction': await browserAction(msg); break;
        case 'browserInput': try { await browserInput(msg); } catch { /* page gone */ } break;
        // ---- dev servers (.claude/launch.json)
        case 'launchList': { const cwd = rt?.cwd || safeDir(msg.cwd); if (cwd) send({ type: 'launchList', cwd, items: await launchList(cwd) }); break; }
        case 'launchStart': { const cwd = rt?.cwd || safeDir(msg.cwd); if (cwd) launchStart(cwd, msg.name).catch((err) => send({ type: 'error', message: String(err.message || err) })); break; }
        case 'launchStop': { const cwd = rt?.cwd || safeDir(msg.cwd); if (cwd) await launchStop(cwd, msg.name); break; }
        case 'launchLogs': { const cwd = rt?.cwd || safeDir(msg.cwd); const s = cwd && devServers.get(devKey(cwd, msg.name)); send({ type: 'launchLogs', cwd, name: msg.name, lines: s?.logs || [] }); break; }
        case 'openUrl': openBrowser(String(msg.url || '')); break;
        // ---- files pane
        case 'fsList': send({ type: 'fsList', ref: msg.ref, path: path.resolve(msg.path), items: await fsList(msg.path) }); break;
        case 'fsSearch': send({ type: 'fsSearch', ref: msg.ref, items: await fsSearch(msg.root, msg.q, !!msg.content) }); break;
        // ---- terminal pane
        case 'termOpen': if (rt) { const t = termOpen(rt); send({ type: 'termOpened', sid: rt.localId, shell: t.shell, cwd: rt.cwd }); } break;
        case 'termRun': if (rt && typeof msg.cmd === 'string') termRun(rt, msg.cmd); break;
        case 'termKill': if (rt) { termKill(rt); const t = termOpen(rt); send({ type: 'termOpened', sid: rt.localId, shell: t.shell, cwd: rt.cwd, restarted: true }); } break;
        case 'authCheck': send({ type: 'auth', auth: await checkAuth() }); break;
        case 'updateCheck': send({ type: 'update', ...(await checkUpdate()), manual: true }); break;
        case 'updateApply': applyUpdate(); break;
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

  ws.on('close', () => { clients.delete(ws); if (ws.watching) { liveBrowser.watchers = Math.max(0, liveBrowser.watchers - 1); if (!liveBrowser.watchers) stopScreencast(); } });
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

function pickFolderNative(start) {
  return new Promise((resolve) => {
    const done = (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(undefined);
      const p = String(stdout || '').trim();
      resolve(p && fs.existsSync(p) ? p : '');
    };
    if (IS_WIN) {
      const ps = [
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8', 'Add-Type -AssemblyName System.Windows.Forms',
        '$d=New-Object System.Windows.Forms.FolderBrowserDialog', "$d.Description='Choose the folder Claude will work in'",
        '$d.UseDescriptionForTitle=$true', '$d.ShowNewFolderButton=$true',
        'if ($env:CWUI_START -and (Test-Path $env:CWUI_START)) { $d.SelectedPath=$env:CWUI_START }',
        '$f=New-Object System.Windows.Forms.Form', "$f.TopMost=$true; $f.ShowInTaskbar=$false; $f.WindowState='Minimized'",
        "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
      ].join('; ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps], { env: { ...process.env, CWUI_START: start }, windowsHide: true, timeout: 600000 }, done);
    } else if (IS_MAC) {
      execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose the folder Claude will work in")'], { timeout: 600000 }, done);
    } else {
      execFile('zenity', ['--file-selection', '--directory', `--filename=${start}/`], { timeout: 600000 }, done);
    }
  });
}

function publicSettings() { const { githubToken, ...rest } = state.settings; return { ...rest, hasToken: !!githubToken }; }

function detectRepo() {
  try {
    const cfg = fs.readFileSync(path.join(ROOT, '.git', 'config'), 'utf8');
    const m = cfg.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s/);
    if (m) return m[1];
  } catch { /* no git */ }
  return 'gabrieljadeau/claude-web-ui';
}

// ---------------------------------------------------------------- updates
// The app is a git checkout: "git fetch" tells whether the upstream branch moved. "Relaunch to update" pulls, installs and
// restarts the server; the token is passed to the new process so open tabs reconnect on their own.
const update = { available: false, behind: 0, log: [], checked: 0, applying: false, step: '', error: '' };
async function git(args, timeout = 15000) { return runCmd('git', ['-C', ROOT, ...args], timeout); }
async function checkUpdate() {
  update.error = '';
  const up = await git(['rev-parse', '--abbrev-ref', '@{u}']);
  if (up.err || !up.stdout.trim()) { update.available = false; update.checked = Date.now(); return update; }   // not a git checkout, or no upstream
  const f = await git(['fetch', '--quiet'], 30000);
  if (f.err) { update.error = (f.stderr || f.err.message).trim().split('\n').pop().slice(0, 200); update.checked = Date.now(); broadcast({ type: 'update', ...update }); return update; }
  const n = await git(['rev-list', '--count', 'HEAD..@{u}']);
  update.behind = Number(n.stdout.trim()) || 0;
  update.available = update.behind > 0;
  update.log = update.available ? (await git(['log', '--format=%s', '-n', '6', 'HEAD..@{u}'])).stdout.trim().split('\n').filter(Boolean) : [];
  update.checked = Date.now();
  broadcast({ type: 'update', ...update });
  return update;
}
async function applyUpdate() {
  if (update.applying) return;
  update.applying = true; update.error = '';
  const step = (s) => { update.step = s; broadcast({ type: 'update', ...update }); console.log(`  Update: ${s}`); };
  const fail = (e) => { update.applying = false; update.step = ''; update.error = String(e).slice(0, 300); broadcast({ type: 'update', ...update, failed: true }); console.error(`  Update failed: ${update.error}`); };
  step('pull');
  const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.stdout.trim()) return fail('Local changes in the app folder. Commit or stash them, then try again.');
  const pull = await git(['pull', '--ff-only', '--quiet'], 120000);
  if (pull.err) return fail((pull.stderr || pull.err.message).trim().split('\n').pop());
  step('install');
  const npm = await runCmd(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--no-fund', '--no-audit', '--prefix', ROOT], 300000);
  if (npm.err) return fail((npm.stderr || npm.err.message).trim().split('\n').pop());
  step('relaunch');
  setTimeout(relaunch, 300);
}
function relaunch() {
  // Stop what we own (terminals, dev servers, running turns), free the port, then start the new code.
  for (const rt of runtimes.values()) { try { termKill(rt); rt.abort?.abort(); } catch { /* ignore */ } }
  for (const d of devServers.values()) if (d.proc) launchStop(d.cwd, d.name).catch(() => {});
  for (const ws of clients) { try { ws.close(); } catch { /* ignore */ } }
  server.close(() => {
    if (process.env.CLAUDE_WEB_UI_SUPERVISED) { console.log('  Restarting…\n'); process.exit(75); }   // scripts/launch.mjs starts us again
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: ROOT, env: { ...process.env, NO_OPEN: '1', CLAUDE_WEB_UI_TOKEN: TOKEN }, stdio: 'inherit', detached: !IS_WIN, windowsHide: true });
    child.unref();
    console.log(`  Restarted as process ${child.pid}. Stop it with: kill ${child.pid}\n`);
    process.exit(0);
  });
  server.closeAllConnections?.();
  setTimeout(() => process.exit(process.env.CLAUDE_WEB_UI_SUPERVISED ? 75 : 0), 5000).unref();
}

// "Request a fix": files a GitHub issue. Uses a token from settings, else the gh CLI, else hands back a prefilled new-issue link.
async function fileIssue(msg) {
  const repo = state.settings.repo || REPO;
  const kind = msg.kind === 'feature' ? 'feature' : 'bug';
  const title = String(msg.title || '').trim().slice(0, 200) || (kind === 'bug' ? 'Bug report' : 'Feature request');
  const impact = { blocking: "Blocking — can't work", slowing: 'Slowing me down', cosmetic: 'Cosmetic' }[msg.impact] || '';
  const ctx = [
    `- App: Claude Web UI ${APP_VERSION}`, `- OS: ${process.platform} ${os.release()} · Node ${process.version}`,
    `- Claude Code: ${auth.cli || 'unknown'} · provider: ${auth.provider} · connected: ${auth.connected}`,
    msg.view ? `- Where: ${msg.view}` : '', msg.userAgent ? `- Browser: ${String(msg.userAgent).slice(0, 160)}` : '',
  ].filter(Boolean).join('\n');
  const body = [
    kind === 'bug' ? '### What happened' : '### What it should do', String(msg.primary || '').trim() || '_(not given)_', '',
    kind === 'bug' ? '### What should have happened' : '### Why it matters', String(msg.secondary || '').trim() || '_(not given)_', '',
    impact ? `**Impact:** ${impact}\n` : '', msg.errors ? '### Recent errors\n```\n' + String(msg.errors).slice(0, 3000) + '\n```\n' : '',
    '### Context', ctx, '', `_Reported from the app by ${displayName()} on ${new Date().toISOString()}_`,
  ].filter((x) => x !== null).join('\n');
  const labels = [kind === 'bug' ? 'bug' : 'enhancement'];
  const token = state.settings.githubToken || process.env.GITHUB_TOKEN;
  if (token) {
    const data = JSON.stringify({ title, body, labels });
    const r = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'api.github.com', path: `/repos/${repo}/issues`, method: 'POST', headers: { 'User-Agent': 'claude-web-ui', Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      req.on('error', reject); req.end(data);
    });
    let j = {}; try { j = JSON.parse(r.body); } catch { /* not JSON */ }
    if (r.status >= 200 && r.status < 300 && j.html_url) return { url: j.html_url, via: 'token' };
    throw new Error(`GitHub refused the issue (${r.status}): ${j.message || r.body.slice(0, 200)}`);
  }
  const gh = await runCmd('gh', ['issue', 'create', '-R', repo, '-t', title, '-b', body, '-l', labels[0]], 30000);
  if (!gh.err && /https:\/\/github\.com\/\S+\/issues\/\d+/.test(gh.stdout)) return { url: gh.stdout.match(/https:\/\/github\.com\/\S+\/issues\/\d+/)[0], via: 'gh' };
  const link = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=${labels[0]}`;
  openBrowser(link);
  return { url: link, via: 'browser' };
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
  setTimeout(checkUpdate, 8000); setInterval(checkUpdate, 30 * 60 * 1000).unref();
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other window or set PORT=3738.`);
  else console.error(err);
  process.exit(1);
});
