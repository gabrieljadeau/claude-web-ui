/* Claude Web UI — browser side. One WebSocket to the local server; the server owns the sessions. */
(() => {
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get('t');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cwui.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cwui.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;

  // ---------------------------------------------------------------- state
  const S = {
    ws: null, connected: false,
    tab: store.get('tab', 'code'),            // chat | cowork | code
    view: 'welcome',                          // welcome | session | projects | routines | routine | routineEdit | customize
    sid: null, info: null, routineId: null,
    sessions: [], projects: [], routines: [], settings: {}, auth: { checked: false },
    skills: null, mcp: null, plugins: null,
    home: '', user: '', chatDir: '', version: '',
    closedGroups: new Set(store.get('closedGroups', [])),
    showArchived: store.get('showArchived', false),
    connectSkipped: false,
    newFolder: store.get('lastFolder', ''), newMode: null, newModel: null,
  };
  const KIND_LABEL = { chat: 'Chat', cowork: 'Cowork', code: 'Code', routine: 'Routine' };
  const MODE_LABEL = { default: 'Ask before changes', acceptEdits: 'Auto-accept edits', bypassPermissions: 'Autonomous', plan: 'Plan only' };
  const MODELS = [['', 'Default model'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['__custom', 'Custom ID…']];
  const ROUTINE_TEMPLATES = [
    { name: 'Morning briefing', desc: 'Summarise what changed in the folder since yesterday and list what needs attention, in BRIEFING.md.', prompt: 'Look at the files that changed in this folder in the last 24 hours. Write a short briefing in BRIEFING.md: what changed, what looks unfinished, and 3 suggested next actions.', schedule: { type: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] } },
    { name: 'Inbox triage', desc: 'Read new files dropped in an Inbox folder, sort them and write a summary.', prompt: 'Check the Inbox subfolder. For each new file: read it, write a one-paragraph summary in INBOX-SUMMARY.md (newest first), and move the file to Processed/.', schedule: { type: 'daily', time: '12:00', days: [1, 2, 3, 4, 5] } },
    { name: 'Project health check', desc: 'Run the tests and linters, report failures and propose fixes.', prompt: 'Run the project\'s tests and linters. If something fails, explain why and propose a fix (do not change code unless the fix is trivial and safe). Write the report in HEALTH.md.', schedule: { type: 'daily', time: '07:00', days: [1, 2, 3, 4, 5] } },
    { name: 'Weekly report', desc: 'Every Friday, compile the week\'s work into a report.', prompt: 'Using git history and files changed this week, write WEEKLY-REPORT.md: achievements, open issues, next week\'s plan. Keep it under one page.', schedule: { type: 'daily', time: '17:00', days: [5] } },
    { name: 'Dependency updates', desc: 'Every Monday, look for outdated packages and security advisories.', prompt: 'Check for outdated dependencies and known vulnerabilities in this project. Write DEPENDENCIES.md with what should be updated, the risk, and the command to run. Do not update anything yourself.', schedule: { type: 'daily', time: '09:15', days: [1] } },
    { name: 'Data refresh', desc: 'Re-run a data script and refresh a spreadsheet or CSV every hour.', prompt: 'Run the data refresh script in this folder (look for refresh.* or update.*). Verify the output file was updated and report row counts in REFRESH-LOG.md (append).', schedule: { type: 'interval', every: 60 } },
  ];

  // ---------------------------------------------------------- connection
  function connect() {
    S.ws = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(token || '')}`);
    S.ws.onopen = () => { S.connected = true; renderAuth(); };
    S.ws.onclose = () => { S.connected = false; renderAuth(); setTimeout(connect, 2500); };
    S.ws.onmessage = (e) => handle(JSON.parse(e.data));
  }
  const send = (obj) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); };
  const onceHandlers = [];
  function handle(m) {
    switch (m.type) {
      case 'hello':
        Object.assign(S, { home: m.home, user: m.user, chatDir: m.chatDir, version: m.version, settings: m.settings, auth: m.auth, routines: m.routines });
        $('userName').textContent = m.user; $('avatar').textContent = (m.user || 'U').charAt(0).toUpperCase();
        renderAuth(); applySettingsToUi(); renderWelcomeChips();
        if (S.view === 'welcome') showWelcome(); if (S.view === 'routines') renderRoutinesPage(); if (S.view === 'routine') showRoutine(S.routineId, true);
        break;
      case 'sessions': S.sessions = m.items; S.projects = m.projects; renderList(); if (S.view === 'welcome') renderJump(); if (S.view === 'projects') renderProjects(); if (S.view === 'routine') renderRoutineRuns(); break;
      case 'routines': S.routines = m.items; if (S.view === 'routines') renderRoutinesPage(); if (S.view === 'routine') showRoutine(S.routineId, true); break;
      case 'settings': S.settings = m.settings; if (m.user) { S.user = m.user; $('userName').textContent = m.user; $('avatar').textContent = m.user.charAt(0).toUpperCase(); if (S.view === 'welcome') showWelcome(); } applySettingsToUi(); renderWelcomeChips(); break;
      case 'auth': S.auth = m.auth; renderAuth(); break;
      case 'authTest': toast(m.ok ? `Connection works. Claude replied: "${m.reply}"` : `Request failed: ${m.message}`, !m.ok, 8000); $('connectDetail').textContent = $('connDetail').textContent = m.ok ? '' : m.message; break;
      case 'opened': openSessionView(m.info, m.items, m.liveText); break;
      case 'info': if (S.info && m.info.sid === S.info.sid) { S.info = m.info; renderSessionHead(); } break;
      case 'sdkId': if (S.info && m.sid === S.info.sid) S.info.sdkId = m.sdkId; break;
      case 'status': if (S.info && m.sid === S.info.sid) { S.info.status = m.status; renderSessionHead(); sessionComposer.setBusy(m.status !== 'idle'); } break;
      case 'ev': if (S.info && m.sid === S.info.sid) renderEvent(m.ev); else if (m.ev.type === 'done' && m.ev.ok === false && m.ev.message) toast(m.ev.message, true); break;
      case 'ls': renderDirs(m); break;
      case 'uploaded': if (m.ref === 'skill') { send({ type: 'skillAdd', file: m.path }); } else { welcomeComposer.uploaded(m); sessionComposer.uploaded(m); } break;
      case 'skills': S.skills = m.items; renderSkills(); break;
      case 'mcp': S.mcp = m.items; renderMcp(); break;
      case 'plugins': S.plugins = m; renderPlugins(); break;
      case 'toast': toast(m.text); break;
      case 'error': toast(m.message, true); break;
    }
    if (onceHandlers.length) onceHandlers.splice(0).forEach((h) => h(m));
  }

  // ---------------------------------------------------------------- auth
  function renderAuth() {
    const a = S.auth || {}; const dot = $('authDot'), label = $('authLabel');
    const prov = { bedrock: 'Amazon Bedrock', vertex: 'Google Vertex', foundry: 'Microsoft Foundry', firstParty: 'Claude account' }[a.provider] || 'Claude';
    let text, cls;
    if (!S.connected) { cls = 'bad'; text = 'Server not reachable'; }
    else if (!a.checked) { cls = ''; text = 'Checking connection…'; }
    else if (a.connected === true) { cls = 'ok'; text = `Connected · ${prov}`; }
    else if (a.connected === false) { cls = 'bad'; text = 'Not connected'; }
    else { cls = 'warn'; text = 'Connection not verified'; }
    dot.className = 'dot ' + cls; label.textContent = text;
    $('connStatus').textContent = text + (a.cli ? ` · ${a.cli}` : ''); $('connDetail').textContent = a.detail || '';
    $('connect').hidden = !(S.connected && a.checked && a.connected === false && !S.connectSkipped);
    $('connectDetail').textContent = a.detail || '';
    $('connectText').textContent = a.provider === 'bedrock' ? 'Claude is set up for Amazon Bedrock but the AWS credentials are missing or expired.' : 'This interface uses the same login as the claude terminal command.';
  }
  $('userBtn').onclick = () => openSettings('connection');
  $('connectCheck').onclick = $('connCheck').onclick = () => { $('connectDetail').textContent = 'Checking…'; send({ type: 'authCheck' }); };
  $('connectOpen').onclick = $('connLogin').onclick = () => { send({ type: 'authLogin' }); toast('A terminal window with claude should open. Log in there, then press "Check again".', false, 6000); };
  $('connectTest').onclick = $('connTest').onclick = () => { $('connectDetail').textContent = $('connDetail').textContent = 'Sending a tiny request…'; send({ type: 'authTest' }); };
  $('connectSkip').onclick = () => { S.connectSkipped = true; $('connect').hidden = true; };

  // ------------------------------------------------------------- sidebar
  function setTab(tab) {
    S.tab = tab; store.set('tab', tab);
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('brand').textContent = tab === 'chat' ? 'Claude' : tab === 'cowork' ? 'Claude Cowork' : 'Claude Code';
    $('newLabel').textContent = 'New';
    $('navProjects').hidden = tab === 'chat';
    renderList();
    if (S.view === 'welcome') showWelcome();
  }
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $('newBtn').onclick = () => showWelcome();
  $('navProjects').onclick = () => showProjects();
  $('navRoutines').onclick = () => showRoutines();
  $('navCustomize').onclick = () => showCustomize();
  $('refreshBtn').onclick = () => send({ type: 'sessions' });
  $('collapseBtn').onclick = () => { document.body.classList.add('collapsed'); $('expandBtn').hidden = false; };
  $('expandBtn').onclick = () => { document.body.classList.remove('collapsed'); $('expandBtn').hidden = true; };
  function markNav() {
    const map = { projects: 'navProjects', routines: 'navRoutines', routine: 'navRoutines', routineEdit: 'navRoutines', customize: 'navCustomize', welcome: 'newBtn' };
    document.querySelectorAll('.sb-nav button').forEach((b) => b.classList.toggle('active', b.id === map[S.view]));
  }

  const visibleSessions = () => S.sessions.filter((s) => (S.showArchived || !s.archived) && s.kind !== 'routine');
  function renderList() {
    const box = $('list'); box.innerHTML = '';
    const items = visibleSessions().filter((s) => s.kind === S.tab);
    $('recentsLabel').textContent = S.tab === 'chat' ? 'Recents' : S.tab === 'cowork' ? 'Tasks' : 'Sessions';
    if (S.tab === 'chat') {
      if (!items.length) { box.innerHTML = '<div class="empty-list">Chats you start will show up here</div>'; return; }
      for (const [label, list] of byDate(items)) box.appendChild(group(label, list, null));
      return;
    }
    const groups = new Map();
    if (S.tab === 'code') for (const p of S.projects) groups.set(p.path, { name: p.name, path: p.path, items: [] });
    for (const s of items) { if (!groups.has(s.cwd)) groups.set(s.cwd, { name: baseName(s.cwd), path: s.cwd, items: [] }); groups.get(s.cwd).items.push(s); }
    const arr = [...groups.values()].sort((a, b) => (latest(b) - latest(a)) || a.name.localeCompare(b.name));
    if (!arr.length) { box.innerHTML = `<div class="empty-list">${S.tab === 'cowork' ? 'Tasks you start will show up here' : 'Sessions you start will show up here'}</div>`; return; }
    for (const g of arr) box.appendChild(group(g.name, g.items, g.path));
  }
  const latest = (g) => g.items.reduce((m, s) => Math.max(m, s.when), 0);
  function byDate(items) {
    const now = new Date(); const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const buckets = [['Today', []], ['Yesterday', []], ['Previous 7 days', []], ['Older', []]];
    for (const s of items) buckets[s.when >= d0 ? 0 : s.when >= d0 - 86400000 ? 1 : s.when >= d0 - 7 * 86400000 ? 2 : 3][1].push(s);
    return buckets.filter((b) => b[1].length);
  }
  function group(name, items, folder) {
    const key = folder || name;
    const g = el('div', 'grp' + (S.closedGroups.has(key) ? ' closed' : ''));
    const h = el('div', 'grp-head'); h.innerHTML = `<span class="arrow">▼</span><span class="name"></span>`;
    h.querySelector('.name').textContent = name; h.title = folder || name;
    if (folder) {
      const plus = el('button', 'ib sm'); plus.title = 'New session in this folder'; plus.innerHTML = icon('plus');
      plus.onclick = (e) => { e.stopPropagation(); showWelcome(folder); };
      h.appendChild(plus);
      h.oncontextmenu = (e) => { e.preventDefault(); menu(e, [['New session here', () => showWelcome(folder)], ['Remove from list', () => send({ type: 'removeProject', path: folder })]]); };
    }
    h.onclick = () => { g.classList.toggle('closed'); if (g.classList.contains('closed')) S.closedGroups.add(key); else S.closedGroups.delete(key); store.set('closedGroups', [...S.closedGroups]); };
    g.appendChild(h);
    const body = el('div', 'grp-body');
    for (const s of [...items].sort((a, b) => (b.pinned - a.pinned) || (b.when - a.when))) body.appendChild(sessionRow(s));
    if (!items.length) body.innerHTML = '<div class="empty-list" style="padding:2px 10px 6px;text-align:left">No sessions yet</div>';
    g.appendChild(body);
    return g;
  }
  function sessionRow(s) {
    const b = el('button', 'row' + (isActive(s) ? ' active' : '') + (s.archived ? ' archived' : ''));
    b.innerHTML = `<span class="st"></span><span class="t"><span class="tt"></span><small></small></span>`;
    b.querySelector('.tt').textContent = s.title;
    b.querySelector('small').textContent = (s.status === 'waiting' ? 'Needs your approval · ' : s.status === 'running' ? 'Working… · ' : '') + ago(s.when);
    b.querySelector('.st').className = 'st ' + (s.status === 'waiting' ? 'waiting' : s.status === 'running' ? 'running' : s.unread ? 'unread' : '');
    if (s.pinned) b.appendChild(el('span', 'pin', '📌'));
    b.onclick = () => openSession(s);
    b.oncontextmenu = (e) => { e.preventDefault(); sessionMenu(e, s); };
    return b;
  }
  const isActive = (s) => S.view === 'session' && (s.sid === S.sid || (S.info && s.sdkId && s.sdkId === S.info.sdkId));
  function sessionMenu(e, s) {
    menu(e, [
      ['Rename', () => { const t = prompt('New title', s.title); if (t) send({ type: 'rename', sid: s.sid, title: t }); }],
      [s.pinned ? 'Unpin' : 'Pin', () => send({ type: 'pin', sid: s.sid, value: !s.pinned })],
      [s.archived ? 'Unarchive' : 'Archive', () => send({ type: 'archive', sid: s.sid, value: !s.archived })],
      ['Delete', () => { if (confirm(`Delete “${s.title}”? This cannot be undone.`)) { send({ type: 'delete', sid: s.sid }); if (S.sid === s.sid) showWelcome(); } }, 'danger'],
    ]);
  }
  const openSession = (s) => send({ type: 'open', sid: s.sid, cwd: s.cwd });

  // --------------------------------------------------------------- views
  function showView(name) {
    S.view = name;
    for (const v of ['Welcome', 'Session', 'Projects', 'Routines', 'Routine', 'RoutineEdit', 'Customize']) $('view' + v).hidden = name !== v[0].toLowerCase() + v.slice(1);
    if (name !== 'session') { S.sid = null; S.info = null; }
    markNav(); renderList();
  }

  // welcome
  function showWelcome(folder) {
    showView('welcome');
    if (folder) { S.newFolder = folder; if (S.tab === 'chat') setTab('code'); }
    S.newMode = null; S.newModel = null;
    const first = (S.user || '').split(' ')[0];
    $('welcomeTitle').textContent = S.tab === 'chat' ? `Welcome, ${first}` : S.tab === 'cowork' ? `What should I take care of, ${first}?` : `What's up next, ${first}?`;
    welcomeComposer.setPlaceholder(S.tab === 'chat' ? 'How can I help you today?' : S.tab === 'cowork' ? 'Describe the task. Claude works in the folder on its own.' : 'Describe a task or ask a question');
    renderWelcomeChips(); renderJump();
    welcomeComposer.focus();
  }
  function renderWelcomeChips() {
    const chat = S.tab === 'chat';
    $('projectChip').hidden = chat; $('modeChip').hidden = chat;
    if (!chat) {
      if (!S.newFolder || !S.projects.some((p) => p.path === S.newFolder)) S.newFolder = S.projects[0]?.path || S.newFolder || '';
      $('projectChipText').textContent = S.newFolder ? baseName(S.newFolder) : 'Select folder…';
      $('projectChip').title = S.newFolder || '';
    }
    const mode = S.newMode || (S.tab === 'cowork' ? S.settings.coworkMode : S.settings.mode) || 'default';
    $('modeChipText').textContent = MODE_LABEL[mode];
    const model = S.newModel ?? S.settings.model ?? '';
    $('modelChipText').textContent = model ? ({ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }[model] || model) : 'Default model';
  }
  $('projectChip').onclick = (e) => {
    const entries = S.projects.map((p) => [p.name + '  ·  ' + shortPath(p.path), () => { S.newFolder = p.path; renderWelcomeChips(); }]);
    entries.push(null, ['Browse for a folder…', () => pickFolder(S.newFolder || S.home, (p) => { S.newFolder = p; send({ type: 'addProject', path: p }); renderWelcomeChips(); })]);
    menu(e, entries, 'Project folder');
  };
  $('modeChip').onclick = (e) => menu(e, Object.entries(MODE_LABEL).map(([v, l]) => [l, () => { S.newMode = v; renderWelcomeChips(); }]), 'Permissions');
  $('modelChip').onclick = (e) => menu(e, MODELS.map(([v, l]) => [v === '__custom' ? 'Custom model ID…' : l, () => {
    if (v === '__custom') { const id = prompt('Model ID (for example an Amazon Bedrock model or inference profile ID):', store.get('customModel', '')); if (!id) return; store.set('customModel', id.trim()); S.newModel = id.trim(); }
    else S.newModel = v;
    renderWelcomeChips();
  }]), 'Model');
  function renderJump() {
    const box = $('jump'); box.innerHTML = '';
    const items = visibleSessions().filter((s) => s.kind === S.tab).slice(0, 4);
    if (!items.length) return;
    box.appendChild(el('div', 'lbl', 'Jump back in'));
    for (const s of items) {
      const b = el('button', 'row'); b.innerHTML = `<span class="icon">${icon(S.tab)}</span><span class="t"><span class="tt"></span><small></small></span>`;
      b.querySelector('.tt').textContent = s.title;
      b.querySelector('small').innerHTML = `<span>${s.status === 'running' ? 'Working…' : s.status === 'waiting' ? 'Needs approval' : s.unread ? 'Ready to review' : 'Idle'}</span><span class="m"> · ${KIND_LABEL[s.kind]} · ${S.tab === 'chat' ? '' : esc(baseName(s.cwd)) + ' · '}${ago(s.when)}</span>`;
      b.onclick = () => openSession(s); box.appendChild(b);
    }
  }

  // session
  function openSessionView(info, items, liveText) {
    showView('session');
    S.sid = info.sid; S.info = info;
    if (info.kind !== 'routine' && info.kind !== S.tab) setTab(info.kind);
    clearLog();
    for (const it of items) renderItem(it);
    if (liveText) renderEvent({ type: 'delta', text: liveText });
    renderSessionHead(); renderList();
    sessionComposer.setBusy(info.status !== 'idle');
    scrollDown(true); sessionComposer.focus();
    if (pendingFirst) { const m = pendingFirst; pendingFirst = null; send({ type: 'send', sid: info.sid, text: m.text, files: m.files }); }
  }
  function renderSessionHead() {
    const i = S.info; if (!i) return;
    $('sKind').textContent = KIND_LABEL[i.kind]; $('sKind').className = 'kind ' + i.kind;
    if (document.activeElement !== $('sTitle')) $('sTitle').value = i.title || '';
    $('sPath').textContent = i.kind === 'chat' ? '' : shortPath(i.cwd);
    const st = $('sStatus'); st.className = 's-status ' + i.status;
    st.textContent = i.status === 'running' ? 'Working…' : i.status === 'waiting' ? 'Needs your approval' : i.cost ? `$${i.cost.toFixed(3)}` : '';
    fillModelSelect($('sModel'), i.model);
    $('sMode').value = i.mode; $('sMode').disabled = i.kind === 'chat';
    $('sBrowserWrap').hidden = i.kind === 'chat'; $('sBrowser').checked = !!i.browser;
    $('sPin').classList.toggle('on', !!i.pinned);
  }
  $('sTitle').onchange = () => { const t = $('sTitle').value.trim(); if (t && S.info) { S.info.title = t; send({ type: 'rename', sid: S.sid, title: t }); } };
  $('sTitle').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('sTitle').blur(); } };
  $('sModel').onchange = () => { const v = modelValue($('sModel')); if (v === null) { renderSessionHead(); return; } send({ type: 'sessionSettings', sid: S.sid, model: v }); };
  $('sMode').onchange = () => send({ type: 'sessionSettings', sid: S.sid, mode: $('sMode').value });
  $('sBrowser').onchange = () => send({ type: 'sessionSettings', sid: S.sid, browser: $('sBrowser').checked });
  $('sPin').onclick = () => { if (!S.info?.sdkId) return toast('Send a message first.'); S.info.pinned = !S.info.pinned; send({ type: 'pin', sid: S.sid, value: S.info.pinned }); renderSessionHead(); };
  $('sMore').onclick = (e) => { const i = S.info; if (i) sessionMenu(e, { sid: i.sid, sdkId: i.sdkId, title: i.title, pinned: i.pinned, archived: i.archived }); };
  function fillModelSelect(sel, value) {
    sel.innerHTML = ''; const custom = store.get('customModel', '');
    for (const [v, l] of MODELS) { const o = el('option', null, v === '__custom' && custom ? 'Custom: ' + custom : l); o.value = v; sel.appendChild(o); }
    if (value && !['opus', 'sonnet', 'haiku'].includes(value)) { if (custom !== value) { store.set('customModel', value); sel.options[4].textContent = 'Custom: ' + value; } sel.value = '__custom'; }
    else sel.value = value || '';
  }
  function modelValue(sel) {
    if (sel.value !== '__custom') return sel.value;
    const id = prompt('Model ID (for example an Amazon Bedrock model or inference profile ID):', store.get('customModel', ''));
    if (!id) return null; store.set('customModel', id.trim()); return id.trim();
  }

  // projects page
  function showProjects() { showView('projects'); renderProjects(); }
  function renderProjects() {
    const box = $('projectList'); box.innerHTML = '';
    if (!S.projects.length) { box.innerHTML = '<div class="empty-page">No projects yet. Add a folder to start.</div>'; return; }
    for (const p of S.projects) {
      const n = S.sessions.filter((s) => s.cwd === p.path && !s.archived).length;
      const r = el('div', 'prow'); r.innerHTML = `<span class="icon">${icon('folder')}</span><span class="t"><b></b><small></small></span>`;
      r.querySelector('b').textContent = p.name; r.querySelector('small').textContent = `${p.path} · ${n} session${n === 1 ? '' : 's'}`;
      const a = el('button', 'btn', 'New session'); a.onclick = () => { setTab(S.tab === 'cowork' ? 'cowork' : 'code'); showWelcome(p.path); };
      const b = el('button', 'btn', 'Cowork task'); b.onclick = () => { setTab('cowork'); showWelcome(p.path); };
      const x = el('button', 'ib'); x.innerHTML = icon('trash'); x.title = 'Remove from list (files are not deleted)'; x.onclick = () => send({ type: 'removeProject', path: p.path });
      r.append(a, b, x); box.appendChild(r);
    }
  }
  $('addProjectBtn').onclick = () => pickFolder(S.newFolder || S.home, (p) => send({ type: 'addProject', path: p }));

  // ------------------------------------------------------- chat rendering
  const log = $('log'); const tools = new Map(); let live = null; let lastAssistantText = '';
  function clearLog() { log.innerHTML = ''; tools.clear(); live = null; }
  function renderItem(it) {
    switch (it.type) {
      case 'user': addUser(it.text, it.files); break;
      case 'assistant': addAssistant(it.text); break;
      case 'tool': { const d = addTool(it); if (it.result != null) toolResult(d, it); break; }
      case 'perm': addPermission(it, it.answer); break;
      case 'note': note(it.text, it.err); break;
      case 'done': if (!it.ok && it.message) note(it.message, true); break;
    }
  }
  function renderEvent(ev) {
    switch (ev.type) {
      case 'user': addUser(ev.text, ev.files); break;
      case 'delta': if (!live) live = addAssistant(''); live.raw += ev.text; live.el.innerHTML = md(live.raw); scrollDown(); break;
      case 'assistantText': if (!live) live = addAssistant(''); live.raw = ev.text; live.el.innerHTML = md(ev.text); lastAssistantText = ev.text; live = null; scrollDown(); break;
      case 'toolUse': finalizeLive(); addTool(ev); break;
      case 'toolResult': { const d = tools.get(ev.id); if (d) toolResult(d, { result: ev.content, isError: ev.isError }); break; }
      case 'permission': finalizeLive(); addPermission(ev, null); break;
      case 'permitted': { const p = log.querySelector(`.perm[data-id="${ev.id}"]`); if (p) markPerm(p, ev.answer); break; }
      case 'note': note(ev.text, ev.err); break;
      case 'done': finalizeLive(); if (!ev.ok && ev.message) note(ev.message, true); if (store.get('speak', false) && lastAssistantText) speak(lastAssistantText); lastAssistantText = ''; break;
    }
  }
  function addUser(text, files) {
    const d = el('div', 'msg user'); const b = el('div', 'bubble', text);
    if (files?.length) b.appendChild(el('span', 'files', '📎 ' + files.join(', ')));
    d.appendChild(b); log.appendChild(d); scrollDown(true);
  }
  function addAssistant(text) { const d = el('div', 'msg assistant'); const b = el('div', 'bubble'); b.innerHTML = md(text); d.appendChild(b); log.appendChild(d); return { el: b, raw: text }; }
  function finalizeLive() { if (live && !live.raw.trim()) live.el.parentElement.remove(); live = null; }
  function note(text, err) { log.appendChild(el('div', 'note' + (err ? ' err' : ''), text)); scrollDown(); }
  function toolArg(input) { if (!input || typeof input !== 'object') return ''; return input.command || input.file_path || input.url || input.pattern || input.path || input.query || input.element || input.description || input.prompt || JSON.stringify(input).slice(0, 160); }
  function prettyTool(name) { if (name.startsWith('mcp__browser__')) return 'Browser · ' + name.slice(14).replace(/^browser_/, '').replace(/_/g, ' '); if (name.startsWith('mcp__')) return name.split('__').slice(1).join(' · '); return name; }
  function addTool(t) {
    const d = el('details', 'tool pending'); const s = el('summary'); s.innerHTML = '<span class="dot"></span><span class="name"></span><span class="arg"></span>';
    s.querySelector('.name').textContent = prettyTool(t.name); s.querySelector('.arg').textContent = toolArg(t.input);
    d.appendChild(s); log.appendChild(d); tools.set(t.id, d); scrollDown(); return d;
  }
  function toolResult(d, t) { d.classList.remove('pending'); d.classList.add(t.isError ? 'err' : 'ok'); d.appendChild(el('pre', null, t.result || '(no output)')); }
  function addPermission(p, answer) {
    const d = el('div', 'perm'); d.dataset.id = p.id;
    const q = el('div', 'q', `Claude wants to use ${prettyTool(p.tool)}`);
    const pre = el('pre', null, typeof p.input === 'object' ? JSON.stringify(p.input, null, 2) : String(p.input));
    const btns = el('div', 'btns');
    const mk = (label, cls, allow, always) => { const b = el('button', 'btn ' + cls, label); b.onclick = () => { send({ type: 'permit', sid: S.sid, id: p.id, tool: p.tool, allow, always }); markPerm(d, allow ? 'allow' : 'deny'); }; return b; };
    btns.append(mk('Allow', 'dark', true, false), mk(p.tool.startsWith('mcp__browser__') ? 'Allow all browser actions' : 'Always allow in this chat', '', true, true), mk('Refuse', '', false, false));
    d.append(q, pre, btns); log.appendChild(d); if (answer) markPerm(d, answer); scrollDown();
  }
  function markPerm(d, answer) { d.classList.add('done'); d.querySelectorAll('button').forEach((x) => (x.disabled = true)); const q = d.querySelector('.q'); if (!/—/.test(q.textContent)) q.textContent += answer === 'allow' ? ' — allowed' : ' — refused'; }
  function scrollDown(force) { const c = $('chat'); if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 160) c.scrollTop = c.scrollHeight; }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function inline(s) {
    return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function md(src) {
    const parts = String(src || '').split(/```/); let html = '';
    parts.forEach((part, i) => {
      if (i % 2 === 1) { html += '<pre><code>' + esc(part.replace(/^[^\n]*\n/, '')) + '</code></pre>'; return; }
      const lines = esc(part).split('\n'); let list = null, para = [], table = null;
      const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join('<br>')) + '</p>'; para = []; } };
      const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
      const flushTable = () => { if (table) { html += '</table>'; table = null; } };
      for (const line of lines) {
        let m;
        if (/^\s*\|.*\|\s*$/.test(line)) {
          flushPara(); flushList(); if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
          const cells = line.trim().slice(1, -1).split('|').map((c) => inline(c.trim()));
          if (!table) { html += '<table><tr>' + cells.map((c) => `<th>${c}</th>`).join('') + '</tr>'; table = 1; } else html += '<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>';
          continue;
        }
        flushTable();
        if ((m = line.match(/^\s*#{1,4}\s+(.*)/))) { flushPara(); flushList(); html += '<h3>' + inline(m[1]) + '</h3>'; }
        else if ((m = line.match(/^\s*&gt;\s?(.*)/))) { flushPara(); flushList(); html += '<blockquote>' + inline(m[1]) + '</blockquote>'; }
        else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flushPara(); if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += '<li>' + inline(m[1]) + '</li>'; }
        else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += '<li>' + inline(m[1]) + '</li>'; }
        else if (!line.trim()) { flushPara(); flushList(); }
        else { flushList(); para.push(line); }
      }
      flushPara(); flushList(); flushTable();
    });
    return html;
  }

  // ------------------------------------------------------------ composer
  function makeComposer(host, onSubmit) {
    host.innerHTML = `<div class="box"><div class="chips"></div><textarea rows="1" placeholder="Message Claude…"></textarea><div class="interim"></div>
      <div class="crow"><button class="icon attach" title="Attach files">${icon('plus')}</button><input type="file" multiple hidden>
      <button class="icon mic" title="Dictate (click to start / stop)">${icon('mic')}</button><button class="send" title="Send (Enter)">${icon('up')}</button></div></div>`;
    const ta = host.querySelector('textarea'), chips = host.querySelector('.chips'), fileIn = host.querySelector('input[type=file]');
    const sendBtn = host.querySelector('.send'), mic = host.querySelector('.mic'), interim = host.querySelector('.interim');
    const attachments = []; let busy = false;
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
    function renderChips() {
      chips.innerHTML = '';
      for (const a of attachments) { const c = el('span', 'fchip' + (a.path ? '' : ' loading'), a.name + (a.path ? '' : ' (uploading…)')); const x = el('button', null, '×'); x.onclick = () => { attachments.splice(attachments.indexOf(a), 1); renderChips(); }; c.appendChild(x); chips.appendChild(c); }
    }
    function addFiles(list) {
      for (const f of list) {
        if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is larger than 25 MB.`, true); continue; }
        const ref = Math.random().toString(36).slice(2); attachments.push({ ref, name: f.name, path: null }); renderChips();
        const r = new FileReader(); r.onload = () => send({ type: 'upload', ref, name: f.name, data: String(r.result).split(',')[1] || '' }); r.readAsDataURL(f);
      }
    }
    host.querySelector('.attach').onclick = () => fileIn.click();
    fileIn.onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
    function submit() {
      if (busy) { onSubmit(null); return; }
      if (attachments.some((a) => !a.path)) { toast('Files are still uploading — one moment.'); return; }
      const text = ta.value.trim(); if (!text && !attachments.length) return;
      onSubmit({ text, files: attachments.map((a) => a.path) });
      ta.value = ''; autosize(); attachments.length = 0; renderChips(); if (rec.active) rec.stop();
    }
    sendBtn.onclick = submit;
    const rec = voice(ta, interim, mic, autosize);
    return {
      focus: () => ta.focus(), addFiles,
      setPlaceholder: (t) => (ta.placeholder = t),
      uploaded(m) { const a = attachments.find((x) => x.ref === m.ref); if (a) { a.path = m.path; renderChips(); } },
      setBusy(v) { busy = v; sendBtn.classList.toggle('stop', v); sendBtn.title = v ? 'Stop' : 'Send (Enter)'; sendBtn.innerHTML = icon(v ? 'stop' : 'up'); },
      setText(t) { ta.value = t; autosize(); ta.focus(); },
    };
  }
  let pendingFirst = null;
  const welcomeComposer = makeComposer($('welcomeComposer'), (m) => {
    if (!m) return;
    const kind = S.tab; const cwd = kind === 'chat' ? '' : S.newFolder;
    if (kind !== 'chat') { if (!cwd) return toast('Choose a project folder first.', true); store.set('lastFolder', cwd); send({ type: 'addProject', path: cwd }); }
    pendingFirst = m;
    send({ type: 'new', kind, cwd, mode: kind === 'chat' ? undefined : (S.newMode || undefined), model: S.newModel ?? undefined });
  });
  const sessionComposer = makeComposer($('sessionComposer'), (m) => { if (!m) send({ type: 'stop', sid: S.sid }); else send({ type: 'send', sid: S.sid, text: m.text, files: m.files }); });
  const activeComposer = () => (S.view === 'session' ? sessionComposer : welcomeComposer);
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); if (e.dataTransfer?.files?.length) activeComposer().addFiles(e.dataTransfer.files); });
  window.addEventListener('paste', (e) => { const f = e.clipboardData?.files; if (f?.length && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); activeComposer().addFiles(f); } });

  function voice(ta, interimEl, mic, autosize) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; const api = { active: false, stop() {} };
    if (!SR) { mic.disabled = true; mic.title = 'Dictation needs Microsoft Edge or Google Chrome'; return api; }
    const r = new SR(); r.continuous = true; r.interimResults = true; let base = '';
    r.onstart = () => { api.active = true; mic.classList.add('rec'); base = ta.value; };
    r.onend = () => { api.active = false; mic.classList.remove('rec'); interimEl.textContent = ''; };
    r.onerror = (e) => { if (e.error === 'not-allowed') toast('Microphone access was blocked. Allow it in the address bar and try again.', true); };
    r.onresult = (e) => { let fin = '', inter = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) fin += x[0].transcript; else inter += x[0].transcript; } if (fin) { base = (base ? base.replace(/\s*$/, ' ') : '') + fin.trim(); ta.value = base; autosize(); } interimEl.textContent = inter; };
    mic.onclick = () => { if (api.active) { r.stop(); return; } speechSynthesis?.cancel(); r.lang = S.settings.lang || 'fr-FR'; try { r.start(); } catch { /* already started */ } };
    api.stop = () => r.stop(); return api;
  }
  function speak(text) {
    if (!window.speechSynthesis) return;
    const plain = text.replace(/```[\s\S]*?```/g, ' (code) ').replace(/[`*#>_]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(plain.slice(0, 4000)); u.lang = S.settings.lang || 'fr-FR'; speechSynthesis.speak(u);
  }

  // -------------------------------------------------------------- routines
  let routineTab = 'yours';
  function showRoutines() { showView('routines'); renderRoutinesPage(); }
  $('routineTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; routineTab = b.dataset.t; renderRoutinesPage(); };
  $('newRoutineBtn').onclick = () => showRoutineEdit(null);
  function renderRoutinesPage() {
    document.querySelectorAll('#routineTabs button').forEach((b) => b.classList.toggle('active', b.dataset.t === routineTab));
    $('routinesYours').hidden = routineTab !== 'yours'; $('routinesTemplates').hidden = routineTab !== 'templates';
    const y = $('routinesYours'); y.innerHTML = '';
    if (!S.routines.length) y.innerHTML = `<div class="empty-page">${icon('clock')}<div>No routines yet.</div><div class="small">A routine is a prompt Claude runs on a schedule in a folder, while this app is open.</div></div>`;
    else {
      const rows = el('div', 'rows');
      for (const r of S.routines) {
        const running = S.sessions.some((s) => s.routineId === r.id && s.status !== 'idle');
        const row = el('div', 'rrow'); row.style.cursor = 'pointer';
        row.innerHTML = `<span class="icon">${icon('clock')}</span><span class="t"><b></b><span class="tag"></span><div></div></span><span class="acts"></span>`;
        row.querySelector('b').textContent = r.name; row.querySelector('.tag').textContent = running ? 'Running' : r.enabled ? 'On' : 'Paused';
        row.querySelector('div').textContent = describeSchedule(r.schedule) + ' · ' + baseName(r.cwd) + (r.enabled && r.nextRun ? ' · next ' + fmtWhen(r.nextRun) : '');
        const run = el('button', 'btn', 'Run now'); run.onclick = (e) => { e.stopPropagation(); send({ type: 'routineRun', id: r.id }); };
        row.querySelector('.acts').append(run); row.onclick = () => showRoutine(r.id); rows.appendChild(row);
      }
      y.appendChild(rows);
    }
    const t = $('routinesTemplates'); t.innerHTML = '';
    for (const tpl of ROUTINE_TEMPLATES) {
      const c = el('div', 'card c'); c.innerHTML = `<span class="icon">${icon('clock')}</span><span class="t"><b></b><div></div><small></small></span>`;
      c.querySelector('b').textContent = tpl.name; c.querySelector('div').textContent = tpl.desc; c.querySelector('small').textContent = describeSchedule(tpl.schedule);
      c.onclick = () => showRoutineEdit(null, tpl); t.appendChild(c);
    }
  }
  function showRoutine(id, keep) {
    const r = S.routines.find((x) => x.id === id);
    if (!r) { if (!keep) showRoutines(); return; }
    showView('routine'); S.routineId = id;
    $('rName').textContent = r.name; $('rEnabled').checked = !!r.enabled;
    $('rSchedule').textContent = describeSchedule(r.schedule);
    $('rNext').textContent = r.enabled ? (r.nextRun ? 'Next run: ' + fmtWhen(r.nextRun) : 'No next run scheduled') : 'Paused';
    $('rCwd').textContent = r.cwd; $('rPrompt').textContent = r.prompt;
    $('rMode').textContent = MODE_LABEL[r.mode] + (r.model ? ' · model ' + r.model : '');
    renderRoutineRuns();
  }
  function renderRoutineRuns() {
    const r = S.routines.find((x) => x.id === S.routineId); if (!r) return;
    const box = $('rRuns'); box.innerHTML = '';
    if (!r.runs?.length) { box.innerHTML = '<div class="muted">No runs yet. Press “Run now” to try it.</div>'; return; }
    for (const run of r.runs) {
      const live = S.sessions.find((s) => s.sid === run.sid || (run.sdkId && s.sdkId === run.sdkId));
      const st = live && live.status !== 'idle' ? 'running' : run.ok === true ? 'ok' : run.ok === false ? 'bad' : '';
      const b = el('button', 'run'); b.innerHTML = `<span class="st ${st}"></span><span class="t"></span><span class="spacer"></span><span class="muted small"></span>`;
      b.querySelector('.t').textContent = fmtWhen(run.at);
      b.querySelector('.muted').textContent = st === 'running' ? 'Running…' : (run.ok === false ? 'Failed' : run.ok ? 'Done' : '') + (run.cost ? ` · $${run.cost.toFixed(3)}` : '');
      b.onclick = () => send({ type: 'open', sid: run.sdkId || run.sid, cwd: r.cwd }); box.appendChild(b);
    }
  }
  $('rBack').onclick = showRoutines;
  $('rEnabled').onchange = () => send({ type: 'routineToggle', id: S.routineId, enabled: $('rEnabled').checked });
  $('rRun').onclick = () => send({ type: 'routineRun', id: S.routineId });
  $('rEdit').onclick = () => showRoutineEdit(S.routineId);
  $('rDelete').onclick = () => { const r = S.routines.find((x) => x.id === S.routineId); if (r && confirm(`Delete routine “${r.name}”?`)) { send({ type: 'routineDelete', id: r.id }); showRoutines(); } };

  let editingId = null;
  function showRoutineEdit(id, tpl) {
    editingId = id; const r = S.routines.find((x) => x.id === id) || tpl || {};
    showView('routineEdit');
    $('reTitle').textContent = id ? 'Edit routine' : 'New routine';
    $('reName').value = r.name || ''; $('rePrompt').value = r.prompt || '';
    $('reCwd').value = r.cwd || S.newFolder || S.projects[0]?.path || S.home;
    $('reMode').value = r.mode || S.settings.coworkMode || 'acceptEdits'; $('reModel').value = r.model || '';
    const s = r.schedule || { type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] };
    $('reType').value = s.type; $('reTime').value = s.time || '09:00'; $('reEvery').value = s.every || 60;
    $('reAt').value = toLocalInput(s.at || new Date(Date.now() + 3600000).toISOString());
    document.querySelectorAll('#reDays input').forEach((c) => (c.checked = (s.days || [1, 2, 3, 4, 5]).includes(Number(c.value))));
    scheduleTypeUi(); $('reName').focus();
  }
  function scheduleTypeUi() { const t = $('reType').value; $('reDailyWrap').hidden = t !== 'daily'; $('reDays').hidden = t !== 'daily'; $('reIntervalWrap').hidden = t !== 'interval'; $('reOnceWrap').hidden = t !== 'once'; }
  $('reType').onchange = scheduleTypeUi;
  $('reBrowse').onclick = () => pickFolder($('reCwd').value || S.home, (p) => ($('reCwd').value = p));
  $('reCancel').onclick = $('reBack').onclick = () => (editingId ? showRoutine(editingId) : showRoutines());
  $('routineForm').onsubmit = (e) => {
    e.preventDefault(); const t = $('reType').value;
    const schedule = t === 'daily' ? { type: 'daily', time: $('reTime').value || '09:00', days: [...document.querySelectorAll('#reDays input:checked')].map((c) => Number(c.value)) }
      : t === 'interval' ? { type: 'interval', every: Math.max(1, Number($('reEvery').value) || 60) } : { type: 'once', at: new Date($('reAt').value).toISOString() };
    const routine = { id: editingId || undefined, name: $('reName').value.trim(), prompt: $('rePrompt').value.trim(), cwd: $('reCwd').value.trim(), mode: $('reMode').value, model: $('reModel').value.trim(), schedule, enabled: true };
    send({ type: 'routineSave', routine });
    onceHandlers.push((m) => { if (m.type === 'routines') { const r = m.items.find((x) => editingId ? x.id === editingId : x.name === routine.name); if (r) { toast('Routine saved.'); showRoutine(r.id); } } });
  };
  function describeSchedule(s) {
    if (!s) return ''; const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    if (s.type === 'interval') return `Every ${s.every} min`;
    if (s.type === 'once') return `Once, ${fmtWhen(Date.parse(s.at))}`;
    const d = s.days || []; const days = !d.length || d.length === 7 ? 'daily' : d.length === 5 && !d.includes(0) && !d.includes(6) ? 'weekdays' : d.map((x) => D[x]).join(', ');
    return `${days[0].toUpperCase() + days.slice(1)} at ${s.time}`;
  }

  // -------------------------------------------------------------- customize
  let custTab = 'skills', plugTab = 'installed';
  function showCustomize(tab) {
    showView('customize'); if (tab) custTab = tab;
    document.querySelectorAll('#custTabs button').forEach((b) => b.classList.toggle('active', b.dataset.t === custTab));
    $('custSkills').hidden = custTab !== 'skills'; $('custMcp').hidden = custTab !== 'mcp'; $('custPlugins').hidden = custTab !== 'plugins';
    if (custTab === 'skills') { send({ type: 'skills' }); renderSkills(); }
    if (custTab === 'mcp') { send({ type: 'mcp' }); renderMcp(); }
    if (custTab === 'plugins') { send({ type: 'plugins' }); renderPlugins(); }
  }
  $('custTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showCustomize(b.dataset.t); };
  $('skillSearch').oninput = renderSkills; $('plugSearch').oninput = renderPlugins; $('plugCat').onchange = renderPlugins;
  $('plugTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; plugTab = b.dataset.t; renderPlugins(); };
  function renderSkills() {
    const box = $('skillList'); box.innerHTML = '';
    if (S.skills === null) { box.innerHTML = '<div class="empty-page">Loading…</div>'; return; }
    const q = $('skillSearch').value.trim().toLowerCase();
    const items = S.skills.filter((s) => !q || (s.name + ' ' + s.description).toLowerCase().includes(q));
    if (!items.length) { box.innerHTML = `<div class="empty-page">${icon('skill')}<div>${S.skills.length ? 'No match.' : 'No skills installed yet.'}</div></div>`; return; }
    for (const s of items) {
      const r = el('div', 'rrow'); r.innerHTML = `<span class="icon">${icon('skill')}</span><span class="t"><b></b><span class="tag"></span><div></div></span><span class="acts"></span>`;
      r.querySelector('b').textContent = s.name; r.querySelector('.tag').textContent = s.scope === 'user' ? 'Personal' : 'Project: ' + s.scope; r.querySelector('div').textContent = s.description; r.querySelector('div').title = s.dir;
      const use = el('button', 'btn', 'Use'); use.onclick = () => { setTab(S.tab === 'chat' ? 'code' : S.tab); showWelcome(); welcomeComposer.setText(`/${s.name} `); };
      const x = el('button', 'ib'); x.innerHTML = icon('trash'); x.title = 'Delete skill'; x.onclick = () => { if (confirm(`Delete skill “${s.name}”?`)) send({ type: 'skillDelete', dir: s.dir }); };
      r.querySelector('.acts').append(use, x); box.appendChild(r);
    }
  }
  $('skillAddBtn').onclick = () => $('skillDlg').showModal();
  $('skClose').onclick = () => $('skillDlg').close();
  $('skUrlBtn').onclick = () => { const v = $('skUrl').value.trim(); if (v) { send({ type: 'skillAdd', source: v }); toast('Installing skill…'); $('skillDlg').close(); } };
  $('skPathBtn').onclick = () => { const v = $('skPath').value.trim(); if (v) { send({ type: 'skillAdd', source: v }); $('skillDlg').close(); } };
  $('skPathBrowse').onclick = () => pickFolder($('skPath').value || S.home, (p) => ($('skPath').value = p));
  $('skFileBtn').onclick = () => { const f = $('skFile').files[0]; if (!f) return; const r = new FileReader(); r.onload = () => send({ type: 'upload', ref: 'skill', name: f.name, data: String(r.result).split(',')[1] || '' }); r.readAsDataURL(f); $('skillDlg').close(); toast('Installing skill…'); };
  $('skIdeaBtn').onclick = () => {
    const idea = $('skIdea').value.trim(); if (!idea) return; $('skillDlg').close();
    setTab('code'); S.newFolder = S.home; showWelcome();
    welcomeComposer.setText(`Create a new Claude Code skill for this workflow: ${idea}\n\nWrite it as ~/.claude/skills/<short-name>/SKILL.md with YAML frontmatter (name, description that says when to trigger) followed by clear step-by-step instructions. Ask me at most 3 questions first if something important is unclear, then create the file.`);
  };

  function renderMcp() {
    const box = $('mcpList'); box.innerHTML = '';
    if (S.mcp === null) { box.innerHTML = '<div class="empty-page">Loading…</div>'; return; }
    if (!S.mcp.length) { box.innerHTML = `<div class="empty-page">${icon('plug')}<div>No connectors configured.</div></div>`; return; }
    for (const c of S.mcp) {
      const r = el('div', 'rrow'); r.innerHTML = `<span class="icon">${icon('plug')}</span><span class="t"><b></b><span class="tag"></span><div></div></span><span class="acts"></span>`;
      r.querySelector('b').textContent = c.name; r.querySelector('.tag').textContent = c.scope === 'user' ? 'Personal' : c.scope === 'plugin' ? 'From plugin' : c.scope;
      r.querySelector('div').textContent = [c.type && c.type.toUpperCase(), c.target, c.health].filter(Boolean).join(' · ');
      if (c.scope === 'user') { const x = el('button', 'ib'); x.innerHTML = icon('trash'); x.title = 'Remove'; x.onclick = () => { if (confirm(`Remove connector “${c.name}”?`)) send({ type: 'mcpRemove', name: c.name }); }; r.querySelector('.acts').append(x); }
      box.appendChild(r);
    }
  }
  $('mcpAddBtn').onclick = () => { $('mcpForm').reset(); mcTypeUi(); $('mcpDlg').showModal(); };
  $('mcCancel').onclick = () => $('mcpDlg').close();
  function mcTypeUi() { const t = $('mcType').value; const remote = t !== 'stdio'; $('mcUrlWrap').hidden = !remote; $('mcHeadWrap').hidden = !remote; $('mcCmdWrap').hidden = remote; $('mcEnvWrap').hidden = remote; }
  $('mcType').onchange = mcTypeUi;
  $('mcpForm').onsubmit = (e) => {
    e.preventDefault();
    const kv = (txt, sep) => Object.fromEntries(txt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    send({ type: 'mcpAdd', name: $('mcName').value.trim(), type: $('mcType').value, url: $('mcUrl').value.trim(), command: $('mcCmd').value.trim(), headers: kv($('mcHeaders').value, ':'), env: kv($('mcEnv').value, '=') });
    $('mcpDlg').close();
  };

  function renderPlugins() {
    document.querySelectorAll('#plugTabs button').forEach((b) => b.classList.toggle('active', b.dataset.t === plugTab));
    $('plugInstalled').hidden = plugTab !== 'installed'; $('plugDiscover').hidden = plugTab !== 'discover';
    $('plugSearch').hidden = plugTab !== 'discover'; $('plugCat').hidden = plugTab !== 'discover';
    const P = S.plugins;
    if (!P) { $('plugInstalled').innerHTML = $('plugDiscover').innerHTML = '<div class="empty-page">Loading…</div>'; return; }
    const inst = $('plugInstalled'); inst.innerHTML = '';
    if (!P.cliOk) inst.innerHTML = '<div class="empty-page">The claude command was not found, so plugins cannot be managed from here.</div>';
    else if (!P.installed.length) inst.innerHTML = `<div class="empty-page">${icon('puzzle')}<div>No plugins installed. Look in Discover.</div></div>`;
    for (const p of P.installed) {
      const meta = P.available.find((a) => a.id === p.id) || {};
      const r = el('div', 'rrow'); r.innerHTML = `<span class="icon">${icon('puzzle')}</span><span class="t"><b></b><span class="tag"></span><div></div></span><span class="acts"></span>`;
      r.querySelector('b').textContent = p.id.split('@')[0]; r.querySelector('.tag').textContent = `v${p.version}` + (p.enabled ? '' : ' · disabled');
      r.querySelector('div').textContent = meta.description || p.id;
      const sw = el('label', 'switch'); sw.innerHTML = `<input type="checkbox" ${p.enabled ? 'checked' : ''}><span></span>`; sw.title = 'Enabled';
      sw.querySelector('input').onchange = (e) => send({ type: 'pluginAction', action: e.target.checked ? 'enable' : 'disable', id: p.id });
      const x = el('button', 'ib'); x.innerHTML = icon('trash'); x.title = 'Uninstall'; x.onclick = () => { if (confirm(`Uninstall plugin “${p.id}”?`)) send({ type: 'pluginAction', action: 'uninstall', id: p.id }); };
      r.querySelector('.acts').append(sw, x); inst.appendChild(r);
    }
    const cat = $('plugCat');
    if (cat.options.length <= 1) for (const c of [...new Set(P.available.map((a) => a.category).filter(Boolean))].sort()) { const o = el('option', null, c[0].toUpperCase() + c.slice(1)); o.value = c; cat.appendChild(o); }
    const q = $('plugSearch').value.trim().toLowerCase(), cv = cat.value;
    const disc = $('plugDiscover'); disc.innerHTML = '';
    const installedIds = new Set(P.installed.map((p) => p.id));
    const list = P.available.filter((a) => (!cv || a.category === cv) && (!q || (a.name + ' ' + a.description + ' ' + a.author).toLowerCase().includes(q))).slice(0, 80);
    if (!list.length) disc.innerHTML = `<div class="empty-page" style="grid-column:1/-1">${P.available.length ? 'No match.' : 'No marketplace catalog found. Add a marketplace (for example anthropics/claude-plugins-official).'}</div>`;
    for (const a of list) {
      const c = el('div', 'card c'); c.style.cursor = 'default';
      c.innerHTML = `<span class="icon">${icon('puzzle')}</span><span class="t"><b></b><div></div><small></small></span>`;
      c.querySelector('b').textContent = a.name; c.querySelector('div').textContent = a.description; c.querySelector('small').textContent = [a.author && 'by ' + a.author, a.category, a.marketplace].filter(Boolean).join(' · ');
      const b = el('button', 'btn add ' + (installedIds.has(a.id) ? '' : 'dark'), installedIds.has(a.id) ? 'Installed' : 'Add'); b.disabled = installedIds.has(a.id);
      b.onclick = () => { b.disabled = true; b.textContent = 'Installing…'; send({ type: 'pluginAction', action: 'install', id: a.id }); };
      c.appendChild(b); disc.appendChild(c);
    }
  }
  $('mkAddBtn').onclick = () => { const s = prompt('Marketplace source (GitHub owner/repo, URL or folder):', 'anthropics/claude-plugins-official'); if (s) send({ type: 'marketplaceAdd', source: s.trim() }); };

  // --------------------------------------------------------------- search
  let selIdx = 0, results = [];
  function openSearch() { $('search').hidden = false; $('searchInput').value = ''; renderSearch(); $('searchInput').focus(); }
  function closeSearch() { $('search').hidden = true; }
  $('searchBtn').onclick = openSearch;
  $('search').onclick = (e) => { if (e.target === $('search')) closeSearch(); };
  $('searchInput').oninput = renderSearch;
  $('searchInput').onkeydown = (e) => {
    if (e.key === 'Escape') closeSearch();
    else if (e.key === 'ArrowDown') { selIdx = Math.min(selIdx + 1, results.length - 1); paintSel(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { selIdx = Math.max(selIdx - 1, 0); paintSel(); e.preventDefault(); }
    else if (e.key === 'Enter') { results[selIdx]?.go(); closeSearch(); }
  };
  function renderSearch() {
    const q = $('searchInput').value.trim().toLowerCase(); results = [];
    for (const r of S.routines) if (!q || r.name.toLowerCase().includes(q)) results.push({ label: r.name, sub: 'Routine', go: () => showRoutine(r.id) });
    for (const p of S.projects) if (q && (p.name + p.path).toLowerCase().includes(q)) results.push({ label: p.name, sub: 'Project · new session', go: () => { setTab('code'); showWelcome(p.path); } });
    for (const s of (S.skills || [])) if (q && s.name.toLowerCase().includes(q)) results.push({ label: s.name, sub: 'Skill', go: () => showCustomize('skills') });
    for (const s of S.sessions) if (!q || (s.title + ' ' + s.cwd).toLowerCase().includes(q)) results.push({ label: s.title, sub: `${KIND_LABEL[s.kind]} · ${s.kind === 'chat' ? ago(s.when) : baseName(s.cwd)}`, go: () => openSession(s) });
    results = results.slice(0, 40); selIdx = 0;
    const box = $('searchResults'); box.innerHTML = '';
    for (const r of results) { const b = el('button', 'row'); b.innerHTML = '<span class="t"><span class="tt"></span><small></small></span>'; b.querySelector('.tt').textContent = r.label; b.querySelector('small').textContent = r.sub; b.onclick = () => { r.go(); closeSearch(); }; box.appendChild(b); }
    paintSel();
  }
  function paintSel() { [...$('searchResults').children].forEach((x, i) => x.classList.toggle('sel', i === selIdx)); }
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
    else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); showWelcome(); }
    else if (e.key === 'Escape') { closeSearch(); $('menu').hidden = true; }
  });

  // ------------------------------------------------------------- settings
  function openSettings(page) { applySettingsToUi(); setPage(page || 'general'); $('settingsDlg').showModal(); }
  function setPage(p) { document.querySelectorAll('.set-nav button[data-p]').forEach((b) => b.classList.toggle('active', b.dataset.p === p)); document.querySelectorAll('.set-page').forEach((x) => (x.hidden = x.dataset.page !== p)); }
  document.querySelectorAll('.set-nav button[data-p]').forEach((b) => (b.onclick = () => setPage(b.dataset.p)));
  document.querySelectorAll('.set-nav button[data-go]').forEach((b) => (b.onclick = () => { $('settingsDlg').close(); showCustomize(b.dataset.go); }));
  $('settingsBtn').onclick = () => openSettings('general');
  $('settingsClose').onclick = () => $('settingsDlg').close();
  function applySettingsToUi() {
    const s = S.settings || {};
    fillModelSelect($('setModel'), s.model || '');
    $('setMode').value = s.mode || 'default'; $('setCoworkMode').value = s.coworkMode || 'acceptEdits';
    $('setBrowser').checked = s.browser !== false; $('setLang').value = s.lang || 'fr-FR';
    $('setSpeak').checked = store.get('speak', false); $('setArchived').checked = S.showArchived; if (document.activeElement !== $('setName')) $('setName').value = s.name || S.user || '';
    pills('themePills', store.get('theme', 'auto')); pills('sizePills', store.get('size', 'm')); pills('widthPills', store.get('width', 'm'));
    $('aboutLine').textContent = `Claude Web UI ${S.version}${S.auth?.cli ? ' · ' + S.auth.cli : ''} · runs locally on this computer`;
  }
  function pills(id, v) { document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('active', b.dataset.v === v)); }
  $('themePills').onclick = (e) => { const b = e.target.closest('button'); if (b) { store.set('theme', b.dataset.v); applyTheme(); pills('themePills', b.dataset.v); } };
  $('sizePills').onclick = (e) => { const b = e.target.closest('button'); if (b) { store.set('size', b.dataset.v); applyTheme(); pills('sizePills', b.dataset.v); } };
  $('widthPills').onclick = (e) => { const b = e.target.closest('button'); if (b) { store.set('width', b.dataset.v); applyTheme(); pills('widthPills', b.dataset.v); } };
  $('setModel').onchange = () => { const v = modelValue($('setModel')); if (v === null) { applySettingsToUi(); return; } send({ type: 'settings', model: v }); };
  $('setName').onchange = () => send({ type: 'settings', name: $('setName').value });
  $('setMode').onchange = () => send({ type: 'settings', mode: $('setMode').value });
  $('setCoworkMode').onchange = () => send({ type: 'settings', coworkMode: $('setCoworkMode').value });
  $('setBrowser').onchange = () => send({ type: 'settings', browser: $('setBrowser').checked });
  $('setLang').onchange = () => send({ type: 'settings', lang: $('setLang').value });
  $('setSpeak').onchange = () => { store.set('speak', $('setSpeak').checked); if (!$('setSpeak').checked) speechSynthesis?.cancel(); };
  $('setArchived').onchange = () => { S.showArchived = $('setArchived').checked; store.set('showArchived', S.showArchived); renderList(); };
  function applyTheme() {
    const t = store.get('theme', 'auto'); const d = document.documentElement.dataset;
    if (t === 'auto') delete d.theme; else d.theme = t;
    d.size = store.get('size', 'm'); d.width = store.get('width', 'm');
  }
  applyTheme();

  // --------------------------------------------------------- folder picker
  let dlgCurrent = null, dlgCb = null;
  function pickFolder(start, cb) { dlgCb = cb; send({ type: 'ls', path: start }); $('folderDlg').showModal(); }
  $('dlgCancel').onclick = () => $('folderDlg').close();
  $('dlgChoose').onclick = () => { if (dlgCurrent && dlgCurrent !== 'drives') dlgCb?.(dlgCurrent); $('folderDlg').close(); };
  function renderDirs(m) {
    dlgCurrent = m.path; $('dlgPath').textContent = m.path === 'drives' ? 'This PC' : m.path; $('dlgChoose').disabled = m.path === 'drives';
    const box = $('dirs'); box.innerHTML = '';
    const add = (label, p) => { const b = el('button', null, label); b.onclick = () => send({ type: 'ls', path: p }); box.appendChild(b); };
    if (m.parent) add('⬆  Up', m.parent); if (m.home && m.path !== m.home) add('🏠  Home', m.home);
    for (const d of m.dirs) add('📁  ' + d.name, d.path);
    if (!m.dirs.length) box.insertAdjacentHTML('beforeend', '<div class="muted" style="padding:6px 10px">No subfolders.</div>');
  }

  // ---------------------------------------------------------------- utils
  function menu(e, entries, head) {
    const m = $('menu'); m.innerHTML = '';
    if (head) m.appendChild(el('div', 'mh', head));
    for (const ent of entries) { if (!ent) { m.appendChild(el('div', 'sep')); continue; } const [label, fn, cls] = ent; const b = el('button', cls || '', label); b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); }
    m.hidden = false;
    const r = e.currentTarget?.getBoundingClientRect?.();
    const x = Math.min(r ? r.left : e.clientX, window.innerWidth - 240), y = Math.min(r ? r.bottom + 4 : e.clientY, window.innerHeight - entries.length * 34 - 20);
    m.style.left = x + 'px'; m.style.top = y + 'px';
    setTimeout(() => document.addEventListener('click', () => (m.hidden = true), { once: true }), 0);
  }
  function toast(text, err, ms) { const t = el('div', 'toast' + (err ? ' err' : ''), text); $('toasts').appendChild(t); setTimeout(() => t.remove(), ms || (err ? 7000 : 3500)); }
  function ago(ts) { const d = Date.now() - ts; if (d < 60000) return 'just now'; if (d < 3600000) return Math.floor(d / 60000) + ' min ago'; if (d < 86400000) return Math.floor(d / 3600000) + ' h ago'; if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' d ago'; return new Date(ts).toLocaleDateString(); }
  function fmtWhen(ts) { const d = new Date(ts); const same = d.toDateString() === new Date().toDateString(); return (same ? 'today ' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function toLocalInput(iso) { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  function baseName(p) { return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }
  function shortPath(p) { if (!p) return ''; return S.home && p.startsWith(S.home) ? '~' + p.slice(S.home.length) : p; }

  // ---------------------------------------------------------------- start
  setTab(S.tab); showWelcome(); connect();
})();
