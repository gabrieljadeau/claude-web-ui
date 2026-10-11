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
    view: 'welcome',                          // welcome | session | dashboard | projects | routines | routine | routineEdit | customize
    sid: null, info: null, routineId: null,
    sessions: [], projects: [], routines: [], settings: {}, auth: { checked: false }, repo: '',
    skills: null, mcp: null, plugins: null, dash: null,
    home: '', user: '', chatDir: '', version: '',
    closedGroups: new Set(store.get('closedGroups', [])),
    showArchived: store.get('showArchived', false),
    connectSkipped: false,
    newFolder: store.get('lastFolder', ''), newMode: null, newModel: null, newEffort: null,
  };
  const KIND_LABEL = { chat: 'Chat', cowork: 'Cowork', code: 'Code', routine: 'Routine' };
  const MODE_LABEL = { default: 'Ask before changes', acceptEdits: 'Auto-accept edits', bypassPermissions: 'Autonomous', plan: 'Plan only' };
  const EFFORT_LABEL = { '': 'Default effort', low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Very high effort', max: 'Max effort' };
  const MODELS = [['', 'Default model'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['__custom', 'Custom ID…']];
  const modelLabel = (m) => (m ? ({ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }[m] || shortModel(m)) : 'Default model');
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
        Object.assign(S, { home: m.home, user: m.user, chatDir: m.chatDir, version: m.version, settings: m.settings, auth: m.auth, routines: m.routines, repo: m.repo });
        setUser(m.user); renderAuth(); applySettingsToUi(); renderWelcomeChips();
        if (S.view === 'welcome') showWelcome(); if (S.view === 'routines') renderRoutinesPage(); if (S.view === 'routine') showRoutine(S.routineId, true); if (S.view === 'dashboard') send({ type: 'dashboard' });
        break;
      case 'sessions': S.sessions = m.items; S.projects = m.projects; renderList(); if (S.view === 'welcome') { renderWelcomeChips(); renderJump(); } if (S.view === 'projects') renderProjects(); if (S.view === 'routine') renderRoutineRuns(); if (S.view === 'dashboard') send({ type: 'dashboard' }); break;
      case 'routines': S.routines = m.items; if (S.view === 'routines') renderRoutinesPage(); if (S.view === 'routine') showRoutine(S.routineId, true); break;
      case 'settings': S.settings = m.settings; if (m.repo) S.repo = m.repo; if (m.user) { setUser(m.user); if (S.view === 'welcome') showWelcome(); } applySettingsToUi(); renderWelcomeChips(); break;
      case 'auth': S.auth = m.auth; renderAuth(); break;
      case 'authTest': toast(m.ok ? `Connection works. Claude replied: "${m.reply}"` : `Request failed: ${m.message}`, !m.ok, 8000); $('connectDetail').textContent = $('connDetail').textContent = m.ok ? '' : m.message; break;
      case 'opened': openSessionView(m.info, m.items, m.liveText, m.liveThinking); if (m.draft) sessionComposer.setText(m.draft); break;
      case 'info': if (S.info && m.info.sid === S.info.sid) { S.info = m.info; renderSessionHead(); } break;
      case 'sdkId': if (S.info && m.sid === S.info.sid) S.info.sdkId = m.sdkId; break;
      case 'status': if (S.info && m.sid === S.info.sid) { S.info.status = m.status; renderSessionHead(); sessionComposer.setBusy(m.status !== 'idle'); if (m.status === 'idle') hideWorking(); else showWorking(m.status === 'waiting' ? 'Waiting for your approval' : null); } if (m.status === 'idle') flushQueue(m.sid); break;
      case 'ev': if (S.info && m.sid === S.info.sid) renderEvent(m.ev); else if (m.ev.type === 'done' && m.ev.ok === false && m.ev.message) toast(m.ev.message, true); else if (m.ev.type === 'permission') toast('A chat needs your approval. See the sidebar or the Dashboard.', false, 5000); break;
      case 'ls': renderDirs(m); break;
      case 'picked': onPicked(m); break;
      case 'uploaded': if (m.ref === 'skill') { send({ type: 'skillAdd', file: m.path }); } else { welcomeComposer.uploaded(m); sessionComposer.uploaded(m); } break;
      case 'skills': S.skills = m.items; renderSkills(); break;
      case 'mcp': S.mcp = m.items; renderMcp(); break;
      case 'plugins': S.plugins = m; renderPlugins(); break;
      case 'dashboard': S.dash = m; if (S.view === 'dashboard') renderDashboard(); break;
      case 'reported': onReported(m); break;
      case 'toast': toast(m.text); break;
      case 'error': toast(m.message, true); break;
    }
    if (onceHandlers.length) onceHandlers.splice(0).forEach((h) => h(m));
  }
  function setUser(u) { S.user = u; $('userName').textContent = u; $('avatar').textContent = (u || 'U').charAt(0).toUpperCase(); }

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
    $('navProjects').hidden = tab === 'chat';
    renderList();
    if (S.view === 'welcome') showWelcome();
  }
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $('newBtn').onclick = () => showWelcome();
  $('navDashboard').onclick = () => showDashboard();
  $('navProjects').onclick = () => showProjects();
  $('navRoutines').onclick = () => showRoutines();
  $('navCustomize').onclick = () => showCustomize();
  $('refreshBtn').onclick = () => send({ type: 'sessions' });
  $('collapseBtn').onclick = () => { document.body.classList.add('collapsed'); $('expandBtn').hidden = false; };
  $('expandBtn').onclick = () => { document.body.classList.remove('collapsed'); $('expandBtn').hidden = true; };
  function markNav() {
    const map = { dashboard: 'navDashboard', projects: 'navProjects', routines: 'navRoutines', routine: 'navRoutines', routineEdit: 'navRoutines', customize: 'navCustomize', welcome: 'newBtn' };
    document.querySelectorAll('.sb-nav button').forEach((b) => b.classList.toggle('active', b.id === map[S.view]));
  }

  // Each tab lists strictly its own kind: chats, cowork tasks, or code sessions.
  const visibleSessions = (kind) => S.sessions.filter((s) => (S.showArchived || !s.archived) && s.kind === kind);
  function renderList() {
    const box = $('list'); box.innerHTML = '';
    const items = visibleSessions(S.tab);
    $('recentsLabel').textContent = S.tab === 'chat' ? 'Recents' : S.tab === 'cowork' ? 'Tasks' : 'Sessions';
    if (S.tab === 'chat') {
      if (!items.length) { box.innerHTML = '<div class="empty-list">Chats you start will show up here</div>'; return; }
      for (const [label, list] of byDate(items)) box.appendChild(group(label, list, null));
      return;
    }
    const groups = new Map();
    if (S.tab === 'code') for (const p of S.projects) groups.set(p.path, { name: p.name, path: p.path, items: [] });
    for (const s of items) { const k = s.cwd || '?'; if (!groups.has(k)) groups.set(k, { name: folderName(s.cwd), path: s.cwd || '', items: [] }); groups.get(k).items.push(s); }
    const arr = [...groups.values()].sort((a, b) => (latest(b) - latest(a)) || a.name.localeCompare(b.name));
    if (!arr.length) { box.innerHTML = `<div class="empty-list">${S.tab === 'cowork' ? 'Tasks you start will show up here' : 'Sessions you start will show up here'}</div>`; return; }
    for (const g of arr) box.appendChild(group(g.name, g.items, g.path));
  }
  const folderName = (p) => (!p ? 'Other' : p === S.home ? 'Home folder' : baseName(p) || p);
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
    for (const v of ['Welcome', 'Session', 'Dashboard', 'Projects', 'Routines', 'Routine', 'RoutineEdit', 'Customize']) $('view' + v).hidden = name !== v[0].toLowerCase() + v.slice(1);
    if (name !== 'session') { S.sid = null; S.info = null; }
    markNav(); renderList();
  }

  // welcome
  function showWelcome(folder) {
    showView('welcome');
    if (folder) { S.newFolder = folder; if (S.tab === 'chat') setTab('code'); }
    S.newMode = null; S.newModel = null; S.newEffort = null;
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
    $('modelChipText').textContent = modelLabel(S.newModel ?? S.settings.model ?? '');
    $('effortChipText').textContent = EFFORT_LABEL[S.newEffort ?? S.settings.effort ?? ''] || 'Default effort';
  }
  function modelMenu(e, onPick) {
    menu(e, MODELS.map(([v, l]) => [v === '__custom' ? 'Custom model ID…' : l, () => {
      if (v === '__custom') { const id = prompt('Model ID (for example an Amazon Bedrock model or inference profile ID):', store.get('customModel', '')); if (!id) return; store.set('customModel', id.trim()); onPick(id.trim()); }
      else onPick(v);
    }]), 'Model');
  }
  $('projectChip').onclick = (e) => {
    const entries = S.projects.map((p) => [p.name + '  ·  ' + shortPath(p.path), () => { S.newFolder = p.path; renderWelcomeChips(); }]);
    entries.push(null, ['Browse for a folder…', () => pickFolder(S.newFolder || S.home, (p) => { S.newFolder = p; send({ type: 'addProject', path: p }); renderWelcomeChips(); })]);
    menu(e, entries, 'Project folder');
  };
  $('modeChip').onclick = (e) => menu(e, Object.entries(MODE_LABEL).map(([v, l]) => [l, () => { S.newMode = v; renderWelcomeChips(); }]), 'Permissions');
  $('effortChip').onclick = (e) => menu(e, Object.entries(EFFORT_LABEL).map(([v, l]) => [l, () => { S.newEffort = v; renderWelcomeChips(); }]), 'Thinking effort');
  $('modelChip').onclick = (e) => modelMenu(e, (v) => { S.newModel = v; renderWelcomeChips(); });
  function renderJump() {
    const box = $('jump'); box.innerHTML = '';
    const items = visibleSessions(S.tab).slice(0, 4);
    if (!items.length) return;
    box.appendChild(el('div', 'lbl', 'Jump back in'));
    for (const s of items) {
      const b = el('button', 'row'); b.innerHTML = `<span class="icon">${icon(S.tab)}</span><span class="t"><span class="tt"></span><small></small></span>`;
      b.querySelector('.tt').textContent = s.title;
      b.querySelector('small').innerHTML = `<span>${s.status === 'running' ? 'Working…' : s.status === 'waiting' ? 'Needs approval' : s.unread ? 'Ready to review' : 'Idle'}</span><span class="m"> · ${KIND_LABEL[s.kind]} · ${S.tab === 'chat' ? '' : esc(folderName(s.cwd)) + ' · '}${ago(s.when)}</span>`;
      b.onclick = () => openSession(s); box.appendChild(b);
    }
  }

  // session
  function openSessionView(info, items, liveText, liveThinking) {
    showView('session');
    S.sid = info.sid; S.info = info;
    if (info.kind !== 'routine' && info.kind !== S.tab) setTab(info.kind);
    clearLog();
    for (const it of items) renderItem(it);
    if (liveThinking) { openThinking(); V.think.querySelector('.tbody').textContent = liveThinking; }
    if (liveText) renderEvent({ type: 'delta', text: liveText });
    renderSessionHead(); renderList(); renderPanel();
    sessionComposer.setBusy(info.status !== 'idle');
    if (info.status !== 'idle') showWorking(info.status === 'waiting' ? 'Waiting for your approval' : null);
    editing = null; $('editHint').hidden = true; renderQueue();
    scrollDown(true); sessionComposer.focus();
    if (pendingFirst) { const m = pendingFirst; pendingFirst = null; send({ type: 'send', sid: info.sid, text: m.text, files: m.files }); }
  }
  function renderSessionHead() {
    const i = S.info; if (!i) return;
    $('sKind').textContent = KIND_LABEL[i.kind]; $('sKind').className = 'kind ' + i.kind;
    if (document.activeElement !== $('sTitle')) $('sTitle').value = i.title || '';
    $('sPath').textContent = i.kind === 'chat' ? '' : shortPath(i.cwd);
    const st = $('sStatus'); st.className = 's-status ' + i.status;
    st.textContent = i.status === 'running' ? 'Working…' : i.status === 'waiting' ? 'Needs your approval' : '';
    $('sCost').textContent = i.cost ? `~$${i.cost.toFixed(i.cost < 0.1 ? 3 : 2)} spent` : '';
    renderCtx($('sCtx'), i.context);
    $('sModelChip').querySelector('span').textContent = modelLabel(i.model);
    $('sEffortChip').querySelector('span').textContent = EFFORT_LABEL[i.effort || ''];
    $('sModeChip').querySelector('span').textContent = MODE_LABEL[i.mode] || i.mode; $('sModeChip').hidden = i.kind === 'chat';
    $('sBrowserChip').querySelector('span').textContent = i.browser ? 'Browser: on' : 'Browser: off'; $('sBrowserChip').hidden = i.kind === 'chat';
    $('sPin').classList.toggle('on', !!i.pinned);
    $('panelBtn').classList.toggle('on', document.body.classList.contains('panel-open'));
  }
  function renderCtx(node, ctx) {
    if (!ctx || !ctx.window) { node.hidden = true; return; }
    const pct = Math.min(100, Math.round(ctx.used / ctx.window * 100));
    node.hidden = false; node.className = 'ctx' + (pct > 85 ? ' bad' : pct > 60 ? ' warn' : '');
    node.querySelector('i').style.width = pct + '%'; node.querySelector('.pct').textContent = `Context ${pct}%`;
    node.title = `Context window: ${fmtK(ctx.used)} of ${fmtK(ctx.window)} tokens used`;
  }
  $('sTitle').onchange = () => { const t = $('sTitle').value.trim(); if (t && S.info) { S.info.title = t; send({ type: 'rename', sid: S.sid, title: t }); } };
  $('sTitle').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('sTitle').blur(); } };
  $('sModelChip').onclick = (e) => modelMenu(e, (v) => send({ type: 'sessionSettings', sid: S.sid, model: v }));
  $('sEffortChip').onclick = (e) => menu(e, Object.entries(EFFORT_LABEL).map(([v, l]) => [l, () => send({ type: 'sessionSettings', sid: S.sid, effort: v })]), 'Thinking effort');
  $('sModeChip').onclick = (e) => menu(e, Object.entries(MODE_LABEL).map(([v, l]) => [l, () => send({ type: 'sessionSettings', sid: S.sid, mode: v })]), 'Permissions');
  $('sBrowserChip').onclick = () => send({ type: 'sessionSettings', sid: S.sid, browser: !S.info?.browser });
  $('sPin').onclick = () => { if (!S.info?.sdkId) return toast('Send a message first.'); S.info.pinned = !S.info.pinned; send({ type: 'pin', sid: S.sid, value: S.info.pinned }); renderSessionHead(); };
  $('sMore').onclick = (e) => { const i = S.info; if (i) sessionMenu(e, { sid: i.sid, sdkId: i.sdkId, title: i.title, pinned: i.pinned, archived: i.archived }); };
  $('panelBtn').onclick = () => openPanel(!document.body.classList.contains('panel-open'));
  function openPanel(v) { document.body.classList.toggle('panel-open', v); store.set('panel', v); $('panelBtn').classList.toggle('on', v); if (v) renderPanel(); }
  if (store.get('panel', true)) document.body.classList.add('panel-open');
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

  // ------------------------------------------------------- chat rendering
  // A "turn" = one user message and everything Claude did in reply (thinking, text, steps, approvals).
  const log = $('log');
  let V = null;
  function resetView() { V = { turn: null, reply: null, group: null, steps: new Map(), todos: [], tasks: new Map(), files: new Map(), used: new Set(), stepCount: 0, started: 0, lastText: '', live: null, think: null, working: null, current: '' }; }
  function clearLog() { log.innerHTML = ''; resetView(); }
  function renderItem(it) {
    switch (it.type) {
      case 'user': addUser(it.text, it.files, it.prev); break;
      case 'thinking': openThinking(); setThinking(it.text, true); break;
      case 'assistant': addProse(it.text); break;
      case 'tool': { onToolUse(it, true); if (it.subText) onSubText({ id: it.id, subText: it.subText }); if (it.result != null) onToolResult({ id: it.id, isError: it.isError, content: it.result }, true); break; }
      case 'perm': addPermission(it, it.answer); break;
      case 'note': note(it.text, it.err); break;
      case 'done': onDone(it, true); break;
    }
  }
  function renderEvent(ev) {
    switch (ev.type) {
      case 'user': addUser(ev.text, ev.files, ev.prev); showWorking('Thinking'); break;
      case 'thinkingStart': openThinking(); break;
      case 'thinkingDelta': openThinking(); V.think.querySelector('.tbody').textContent += ev.text; break;
      case 'thinking': openThinking(); setThinking(ev.text, true); break;
      case 'delta': if (!V.live) V.live = addProse('', true); V.live.raw += ev.text; renderInto(V.live.el, V.live.raw); scrollDown(); break;
      case 'assistantText': if (!V.live) V.live = addProse('', true); V.live.raw = ev.text; renderInto(V.live.el, ev.text, true); V.lastText = ev.text; V.live = null; V.group = null; scrollDown(); break;
      case 'toolUse': closeLive(); onToolUse(ev); break;
      case 'subText': onSubText({ id: ev.parent, subText: ev.text }); break;
      case 'toolResult': onToolResult(ev); break;
      case 'permission': closeLive(); addPermission(ev, null); break;
      case 'permitted': { const p = log.querySelector(`.perm[data-id="${ev.id}"]`); if (p) markPerm(p, ev.answer); break; }
      case 'note': note(ev.text, ev.err); break;
      case 'done': closeLive(); onDone(ev); break;
    }
  }
  function closeLive() { if (V.live && !V.live.raw.trim()) V.live.el.remove(); V.live = null; if (V.think) { V.think.classList.remove('live'); V.think = null; } }
  function ensureReply() {
    if (!V.turn) { V.turn = el('div', 'turn'); V.reply = el('div', 'reply'); V.turn.appendChild(V.reply); log.appendChild(V.turn); V.started = Date.now(); }
    keepWorkingLast();
    return V.reply;
  }
  function addUser(text, files, prev) {
    const turn = el('div', 'turn'); turn.dataset.text = text; turn.dataset.prev = prev || '';
    const row = el('div', 'user-row'); const wrap = el('div', 'user-wrap');
    const b = el('div', 'bubble', text);
    if (files?.length) b.appendChild(el('span', 'files', '📎 ' + files.join(', ')));
    const acts = el('div', 'acts');
    const mini = (ic, title, fn) => { const x = el('button', 'ib'); x.title = title; x.innerHTML = icon(ic); x.onclick = fn; return x; };
    acts.append(mini('copy', 'Copy', () => copyText(text)), mini('retry', 'Send again from here (branches the conversation)', () => retryTurn(turn)),
      mini('branch', 'Branch: new conversation starting before this message', () => send({ type: 'fork', sid: S.sid, upTo: turn.dataset.prev || null, draft: stripAttachLine(text) })),
      mini('edit', 'Edit and resend', () => editTurn(turn)));
    wrap.append(b, acts); row.appendChild(wrap); turn.appendChild(row);
    const reply = el('div', 'reply'); turn.appendChild(reply);
    log.appendChild(turn); V.turn = turn; V.reply = reply; V.group = null; V.think = null; V.live = null; V.started = Date.now();
    if (!$('sTitle').value && document.activeElement !== $('sTitle')) $('sTitle').value = text.split('\n')[0].slice(0, 80);
    keepWorkingLast(); scrollDown(true);
  }
  function addProse(text, live) {
    const d = el('div', 'prose'); renderInto(d, text, !live); ensureReply().appendChild(d); V.group = null;
    if (!live) V.lastText = text;
    return { el: d, raw: text };
  }
  function openThinking() {
    if (V.think) return V.think;
    const d = el('details', 'think live'); d.innerHTML = '<summary>Thinking…</summary><div class="tbody"></div>';
    ensureReply().appendChild(d); V.think = d; return d;
  }
  function setThinking(text, final) { const d = openThinking(); d.querySelector('.tbody').textContent = text; if (final) { d.classList.remove('live'); d.querySelector('summary').textContent = 'Thought for a moment'; V.think = null; } }
  function note(text, err) {
    const d = el('div', 'note' + (err ? ' err' : ''), text);
    if (err) { const b = el('button', 'btn', 'Report this'); b.onclick = () => openReport({ kind: 'bug', title: text.split('\n')[0].slice(0, 120), primary: text }); d.appendChild(b); }
    (V.reply || log).appendChild(d); keepWorkingLast(); scrollDown();
  }
  // working indicator (spinner + what Claude is doing right now)
  let workTimer = null;
  function showWorking(label) {
    if (!V) return;
    if (!V.working) { V.working = el('div', 'working'); V.working.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="lbl"></span><span class="t"></span>'; V.workStart = Date.now(); clearInterval(workTimer); workTimer = setInterval(() => { if (V?.working) V.working.querySelector('.t').textContent = fmtDur(Math.round((Date.now() - V.workStart) / 1000)); }, 1000); }
    if (label) V.current = label;
    V.working.querySelector('.lbl').textContent = V.current || 'Working';
    keepWorkingLast(); scrollDown(); renderPanelLight();
  }
  function hideWorking() { if (V?.working) { V.working.remove(); V.working = null; clearInterval(workTimer); renderPanelLight(); } }
  function keepWorkingLast() { if (V?.working) (V.reply || log).appendChild(V.working); }

  // steps (tool calls): compact groups in the chat, full detail in the panel
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  function describe(name, input = {}) {
    const i = input || {};
    if (name.startsWith('mcp__browser__')) {
      const a = name.slice(14).replace(/^browser_/, '');
      const map = { navigate: 'Opened ' + (i.url || 'a page'), click: 'Clicked ' + (i.element || 'on the page'), type: 'Typed in ' + (i.element || 'a field'), snapshot: 'Looked at the page', take_screenshot: 'Took a screenshot', fill_form: 'Filled in a form', select_option: 'Chose an option', press_key: 'Pressed ' + (i.key || 'a key'), navigate_back: 'Went back', close: 'Closed the browser', wait_for: 'Waited for the page', tabs: 'Switched tabs', hover: 'Hovered ' + (i.element || '') };
      return { label: map[a] || 'Browser: ' + a.replace(/_/g, ' '), kind: 'browser', cat: 'Browser' };
    }
    if (name.startsWith('mcp__')) { const [, srv, t] = name.split('__'); return { label: `${srv}: ${(t || '').replace(/_/g, ' ')}`, kind: 'other', cat: srv }; }
    switch (name) {
      case 'Read': return { label: 'Read ' + base(i.file_path), kind: 'read', cat: 'Files' };
      case 'Write': return { label: 'Created ' + base(i.file_path), kind: 'created', cat: 'Files', file: i.file_path, action: 'Created' };
      case 'Edit': case 'MultiEdit': return { label: 'Edited ' + base(i.file_path), kind: 'edited', cat: 'Files', file: i.file_path, action: 'Edited' };
      case 'NotebookEdit': return { label: 'Edited ' + base(i.notebook_path), kind: 'edited', cat: 'Files', file: i.notebook_path, action: 'Edited' };
      case 'Bash': case 'PowerShell': return { label: 'Ran ' + (i.description || String(i.command || '').slice(0, 80)), kind: 'command', cat: 'Terminal' };
      case 'BashOutput': case 'Monitor': return { label: 'Checked a running command', kind: 'command', cat: 'Terminal' };
      case 'Glob': return { label: 'Found files matching ' + (i.pattern || ''), kind: 'search', cat: 'Files' };
      case 'Grep': return { label: `Searched for "${i.pattern || ''}"`, kind: 'search', cat: 'Files' };
      case 'LS': return { label: 'Listed ' + base(i.path), kind: 'search', cat: 'Files' };
      case 'WebSearch': return { label: 'Searched the web for ' + (i.query || ''), kind: 'web', cat: 'Web' };
      case 'WebFetch': { let h = i.url || ''; try { h = new URL(i.url).hostname; } catch { /* keep */ } return { label: 'Read ' + h, kind: 'web', cat: 'Web' }; }
      case 'Task': case 'Agent': return { label: 'Helper agent: ' + (i.description || i.subagent_type || 'working'), kind: 'agent', cat: 'Helper agents' };
      case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return { label: 'Updated the plan', kind: 'plan', cat: 'Plan' };
      case 'AskUserQuestion': return { label: 'Asked you a question', kind: 'other', cat: 'Questions' };
      case 'Skill': return { label: 'Used the ' + (i.skill || i.command || '') + ' skill', kind: 'other', cat: 'Skills' };
      default: return { label: name.replace(/_/g, ' '), kind: 'other', cat: name };
    }
  }
  function currentGroup() {
    if (V.group) return V.group;
    const g = el('div', 'steps running'); g.innerHTML = '<div class="sum"><span class="st"></span><span class="txt"></span><span class="arrow">▼</span></div><div class="list"></div>';
    g.querySelector('.sum').onclick = () => g.classList.toggle('open');
    ensureReply().appendChild(g);
    V.group = { el: g, list: g.querySelector('.list'), items: [] };
    return V.group;
  }
  function refreshGroup(g) {
    const n = {}; for (const s of g.items) if (!s.parent) n[s.kind] = (n[s.kind] || 0) + 1;
    const parts = [];
    const w = (k, one, many) => { if (n[k]) parts.push(n[k] === 1 ? one : many.replace('N', n[k])); };
    w('read', 'Read 1 file', 'Read N files'); w('search', 'Searched files', 'Searched files'); w('edited', 'Edited 1 file', 'Edited N files'); w('created', 'Created 1 file', 'Created N files');
    w('command', 'Ran 1 command', 'Ran N commands'); w('browser', 'Used the browser', 'Used the browser'); w('web', 'Looked online', 'Looked online'); w('agent', 'Used a helper agent', 'Used N helper agents'); w('plan', 'Updated the plan', 'Updated the plan'); w('other', 'Used 1 tool', 'Used N tools');
    const running = g.items.some((s) => s.status === 'running' || s.status === 'waiting');
    g.el.classList.toggle('running', running);
    g.el.querySelector('.txt').textContent = (running ? 'Working: ' : '') + (parts.join(' · ') || 'Working…');
  }
  function onToolUse(m, replay) {
    const d = describe(m.name, m.input);
    const s = { id: m.id, name: m.name, input: m.input, ...d, status: 'running', start: Date.now(), parent: m.parent || null, row: null, actRow: null };
    V.steps.set(m.id, s); V.used.add(d.cat); V.stepCount++;
    const g = currentGroup();
    const row = el('div', 'step running' + (s.parent ? ' sub' : '')); row.innerHTML = '<span class="st"></span><span class="lbl"></span>';
    row.querySelector('.lbl').textContent = (s.parent ? '↳ ' : '') + d.label; row.onclick = () => focusStep(m.id);
    const parentRow = s.parent && V.steps.get(s.parent)?.row;
    if (parentRow && parentRow.parentElement === g.list) { let after = parentRow; while (after.nextElementSibling?.classList.contains('sub')) after = after.nextElementSibling; after.after(row); } else g.list.appendChild(row);
    g.items.push(s); s.row = row; refreshGroup(g);
    if (!replay) showWorking(s.parent ? (V.steps.get(s.parent)?.label || 'Helper agent') + ' › ' + d.label : d.label);
    updatePlan(m.name, m.input, null);
    if (d.file) V.files.set(d.file, { action: V.files.get(d.file)?.action === 'Created' ? 'Created' : d.action });
    addActRow(s); renderPanelLight(); scrollDown();
  }
  function onSubText(m) {
    const s = V.steps.get(m.id); if (!s) return;
    s.subText = (s.subText ? s.subText + '\n' : '') + m.subText;
    if (s.actRow) { let pre = s.actRow.querySelector(':scope > .detail > .sub-pre'); if (!pre) { pre = el('pre', 'sub-pre'); s.actRow.querySelector('.detail').appendChild(pre); } pre.textContent = s.subText; }
  }
  function onToolResult(m, replay) {
    const s = V.steps.get(m.id); if (!s) return;
    s.status = m.isError ? 'error' : 'done'; s.output = m.content; s.end = Date.now();
    if (s.row) s.row.className = 'step ' + s.status + (s.parent ? ' sub' : '');
    if (V.group) refreshGroup(V.group);
    updatePlan(s.name, s.input, m.content);
    updateActRow(s);
    if (s.file && previewPath === s.file && !$('preview').hidden) openPreview(s.file);
    if (!replay && !s.parent) showWorking('Thinking');
    renderPanelLight();
  }
  function updatePlan(name, input, result) {
    if (name === 'TodoWrite' && Array.isArray(input?.todos) && result === null) V.todos = input.todos.map((t) => ({ content: t.content || t.subject || '', status: t.status || 'pending', active: t.activeForm }));
    else if (name === 'TaskCreate' && result) { const id = (String(result).match(/#\s*(\w+)/) || [])[1] || String(V.tasks.size + 1); const t = { content: input?.subject || input?.description || 'Task', status: 'pending', active: input?.activeForm }; V.tasks.set(id, t); V.todos.push(t); }
    else if (name === 'TaskUpdate' && result === null) { const t = V.tasks.get(String(input?.taskId)); if (t && input?.status) { if (input.status === 'deleted') V.todos = V.todos.filter((x) => x !== t); else t.status = input.status; } if (t && input?.subject) t.content = input.subject; }
  }
  function formatInput(tool, input) {
    if (!input || typeof input !== 'object') return String(input ?? '');
    if (input.command) return input.command;
    if (tool === 'Write' && input.file_path) return input.file_path + '\n\n' + String(input.content || '').slice(0, 1200);
    if (tool === 'Edit' && input.file_path) return input.file_path + '\n\n- ' + String(input.old_string || '').slice(0, 500) + '\n+ ' + String(input.new_string || '').slice(0, 500);
    return JSON.stringify(input, null, 2);
  }
  function askText(tool, i, d) {
    if (d.kind === 'command') return 'Allow Claude to run this command?' + (i?.description ? ' (' + i.description + ')' : '');
    if (d.kind === 'created') return `Allow Claude to create ${base(d.file)}?`;
    if (d.kind === 'edited') return `Allow Claude to edit ${base(d.file)}?`;
    if (d.kind === 'browser') return 'Allow Claude to use the browser? ' + d.label;
    if (d.kind === 'web') return 'Allow Claude to go online? ' + d.label;
    if (d.kind === 'agent') return 'Allow Claude to start a helper agent?';
    return `Allow Claude to use ${tool.replace(/^mcp__/, '').replace(/__/g, ': ').replace(/_/g, ' ')}?`;
  }
  function addPermission(p, answer) {
    const d = describe(p.tool, p.input);
    const s = [...V.steps.values()].reverse().find((x) => x.name === p.tool && x.status === 'running');
    if (s && !answer) { s.status = 'waiting'; if (s.row) s.row.className = 'step waiting'; updateActRow(s); if (V.group) refreshGroup(V.group); }
    const card = el('div', 'perm'); card.dataset.id = p.id; card.dataset.label = d.label;
    const q = el('div', 'q', askText(p.tool, p.input, d));
    const pre = el('pre', null, formatInput(p.tool, p.input));
    const btns = el('div', 'btns');
    const mk = (label, cls, allow, always) => { const b = el('button', 'btn ' + cls, label); b.onclick = () => { send({ type: 'permit', sid: S.sid, id: p.id, tool: p.tool, allow, always }); markPerm(card, allow ? 'allow' : 'deny', always); if (s) { s.status = allow ? 'running' : 'error'; if (s.row) s.row.className = 'step ' + s.status; updateActRow(s); } showWorking(allow ? d.label : 'Continuing'); }; return b; };
    btns.append(mk('Allow', 'dark', true, false), mk(p.tool.startsWith('mcp__browser__') ? 'Allow all browser actions' : 'Always allow in this chat', '', true, true), mk('Refuse', '', false, false));
    card.append(q, pre, btns); ensureReply().appendChild(card); V.group = null;
    if (answer) markPerm(card, answer); else showWorking('Waiting for your approval');
    scrollDown(true);
  }
  function markPerm(card, answer, always) {
    card.classList.add('answered'); card.querySelectorAll('button').forEach((x) => (x.disabled = true));
    card.querySelector('.q').textContent = (answer === 'allow' ? (always ? 'Allowed for this chat: ' : 'Allowed: ') : 'Refused: ') + (card.dataset.label || '');
  }
  function onDone(m, replay) {
    hideWorking();
    if (!m.ok && m.message && m.message !== 'error_during_execution') note(m.message, true);
    if (!V.turn) return;
    if (!V.turn.querySelector('.turn-foot')) {
      const foot = el('div', 'turn-foot');
      const mini = (ic, title, fn) => { const b = el('button', 'ib'); b.title = title; b.innerHTML = icon(ic); b.onclick = fn; return b; };
      const turn = V.turn;
      foot.append(mini('copy', 'Copy reply', () => copyText(collectReply(turn))), mini('retry', 'Retry', () => retryTurn(turn)));
      if (window.speechSynthesis) foot.append(mini('speaker', 'Read aloud', () => speak(collectReply(turn))));
      const up = mini('thumbup', 'Good answer', () => { up.classList.toggle('on'); down.classList.remove('on'); if (up.classList.contains('on')) toast('Thanks for the feedback.'); });
      const down = mini('thumbdown', 'Bad answer', () => { down.classList.toggle('on'); up.classList.remove('on'); if (down.classList.contains('on')) openReport({ kind: 'bug', title: 'Bad answer in "' + (S.info?.title || '') + '"', primary: 'The answer was not good:\n\n' + collectReply(turn).slice(0, 1500) }); });
      foot.append(up, down);
      const secs = m.ms ? Math.round(m.ms / 1000) : (!replay && V.started ? Math.round((Date.now() - V.started) / 1000) : 0);
      const meta = [secs ? fmtDur(secs) : '', m.cost != null ? '$' + m.cost.toFixed(m.cost < 0.1 ? 3 : 2) : '', m.model ? shortModel(m.model) : ''].filter(Boolean).join(' · ');
      if (meta) foot.appendChild(el('span', 'meta', meta));
      V.reply.appendChild(foot);
    }
    if (m.context && S.info) { S.info.context = m.context; renderCtx($('sCtx'), m.context); }
    if (!replay && m.cost && S.info) { S.info.cost = (S.info.cost || 0) + m.cost; $('sCost').textContent = `~$${S.info.cost.toFixed(S.info.cost < 0.1 ? 3 : 2)} spent`; }
    if (!replay && store.get('speak', false) && V.lastText) speak(V.lastText);
    V.group = null; V.turn = null; V.reply = null;
    renderPanelLight();
  }
  const collectReply = (turn) => [...turn.querySelectorAll('.reply > .prose')].map((p) => p.dataset.raw || p.innerText).join('\n\n');
  const stripAttachLine = (t) => t.replace(/\n?📎[^\n]*$/, '').trim();
  function editTurn(turn) {
    if (S.info?.status !== 'idle') { toast('Wait for Claude to finish, or stop it first.'); return; }
    const row = turn.querySelector('.user-row'); if (row.querySelector('.edit-box')) return;
    const box = el('div', 'edit-box'); const ta = el('textarea'); ta.value = stripAttachLine(turn.dataset.text);
    const r = el('div', 'row'); const cancel = el('button', 'btn', 'Cancel'); const save = el('button', 'btn dark', 'Send'); r.append(cancel, save); box.append(ta, r);
    const old = [...row.children]; old.forEach((c) => (c.style.display = 'none')); row.appendChild(box); ta.focus(); ta.style.height = ta.scrollHeight + 'px';
    cancel.onclick = () => { box.remove(); old.forEach((c) => (c.style.display = '')); };
    save.onclick = () => { const t = ta.value.trim(); if (t) resend(turn, t); };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save.click(); } if (e.key === 'Escape') cancel.click(); });
  }
  function retryTurn(turn) { if (S.info?.status !== 'idle') return; resend(turn, stripAttachLine(turn.dataset.text)); }
  function resend(turn, text) { send({ type: 'send', sid: S.sid, text, edit: { upTo: turn.dataset.prev || null } }); }
  function focusStep(id) { openPanel(true); const s = V.steps.get(id); if (!s?.actRow) return; s.actRow.classList.add('open'); s.actRow.scrollIntoView({ block: 'nearest' }); }
  function scrollDown(force) { const c = $('chat'); if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 200) c.scrollTop = c.scrollHeight; updateJump(); }
  function updateJump() { const c = $('chat'); $('jumpBtn').hidden = c.scrollHeight - c.scrollTop - c.clientHeight < 200; }
  $('chat').addEventListener('scroll', updateJump); $('jumpBtn').onclick = () => scrollDown(true);

  // right panel: progress, outputs, steps, used
  function renderPanel() { $('acts').innerHTML = ''; if (V) for (const s of V.steps.values()) addActRow(s); if (!V || !V.steps.size) $('acts').innerHTML = '<div class="empty-note">Each action Claude takes appears here as it happens.</div>'; renderPanelLight(); }
  function renderPanelLight() {
    if (!V) return;
    const pb = $('progressBody'); pb.innerHTML = '';
    if (V.todos.length) {
      const ul = el('ul', 'todos');
      for (const t of V.todos) ul.appendChild(el('li', 'todo ' + t.status, t.status === 'in_progress' && t.active ? t.active : t.content));
      pb.appendChild(ul);
      const doneN = V.todos.filter((t) => t.status === 'completed').length; const cur = V.todos.findIndex((t) => t.status === 'in_progress');
      $('progressLabel').textContent = doneN === V.todos.length ? `${doneN} of ${V.todos.length} done` : `step ${(cur >= 0 ? cur : doneN) + 1} of ${V.todos.length}`;
    } else { pb.appendChild(el('div', 'empty-note', V.working ? (V.current || 'Working') + '…' : 'When a task has several steps, Claude\'s plan shows up here.')); $('progressLabel').textContent = ''; }
    const out = $('outputs'); out.innerHTML = '';
    const files = [...V.files.entries()]; $('outCount').textContent = files.length || '';
    if (!files.length) out.appendChild(el('div', 'empty-note', 'Files Claude creates or changes appear here.'));
    for (const [p, f] of files) { const b = el('button', 'out'); b.title = p; b.innerHTML = `${icon('file')}<span class="nm"></span><span class="tag"></span>`; b.querySelector('.nm').textContent = base(p); b.querySelector('.tag').textContent = f.action || ''; b.onclick = () => openPreview(p); out.appendChild(b); }
    $('stepCount').textContent = V.stepCount || '';
    const used = $('used'); used.innerHTML = ''; if (!V.used.size) used.appendChild(el('span', null, 'Nothing yet'));
    for (const u of V.used) used.appendChild(el('span', null, u));
  }
  function addActRow(s) {
    const acts = $('acts'); const empty = acts.querySelector('.empty-note'); if (empty) empty.remove();
    const row = el('div', 'act ' + s.status); row.id = 'act-' + s.id;
    row.innerHTML = '<div class="top"><span class="st"></span><span class="lbl"></span><span class="t"></span></div><div class="detail"></div><div class="children"></div>';
    row.querySelector('.lbl').textContent = s.label; row.querySelector('.top').onclick = () => row.classList.toggle('open');
    row.querySelector('.detail').appendChild(el('pre', null, formatInput(s.name, s.input)));
    const parent = s.parent && document.querySelector(`#act-${CSS.escape(s.parent)} > .children`);
    (parent || acts).appendChild(row); s.actRow = row;
    if (s.output != null) updateActRow(s);
    if (s.subText) onSubText({ id: s.id, subText: '' });
    if (!parent) acts.scrollTop = acts.scrollHeight;
  }
  function updateActRow(s) {
    const row = s.actRow; if (!row) return;
    row.className = 'act ' + s.status + (row.classList.contains('open') ? ' open' : '');
    if (s.end) row.querySelector('.t').textContent = fmtDur(Math.max(0, Math.round((s.end - s.start) / 1000)));
    if (s.output != null && !row.querySelector(':scope > .detail > .out-pre')) row.querySelector('.detail').appendChild(el('pre', 'out-pre', s.output || '(no output)'));
  }

  // file preview
  let previewPath = null;
  const fileUrl = (p, raw) => `/file?t=${encodeURIComponent(token || '')}&path=${encodeURIComponent(p)}${raw ? '&raw=1' : ''}`;
  async function openPreview(p) {
    previewPath = p; $('previewName').textContent = base(p); $('previewOpen').href = fileUrl(p);
    const body = $('previewBody'); body.innerHTML = ''; const ext = (base(p).split('.').pop() || '').toLowerCase();
    $('preview').hidden = false;
    if (['html', 'htm', 'pdf', 'svg'].includes(ext)) { const f = el('iframe'); f.src = fileUrl(p); f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups'); body.appendChild(f); }
    else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) { const img = el('img'); img.src = fileUrl(p) + '&v=' + Date.now(); body.appendChild(img); }
    else if (['mp4', 'webm'].includes(ext)) { const v = el('video'); v.src = fileUrl(p); v.controls = true; body.appendChild(v); }
    else if (['docx', 'xlsx', 'pptx', 'zip', 'exe'].includes(ext)) body.innerHTML = '<div class="prose"><p>This file type can\'t be previewed here. Use "Show in folder" to open it.</p></div>';
    else {
      try { const r = await fetch(fileUrl(p, true)); const t = await r.text(); if (!r.ok) throw new Error(t); if (ext === 'md' || ext === 'markdown') { const d = el('div', 'prose'); renderInto(d, t, true); body.appendChild(d); } else body.appendChild(el('pre', null, t)); }
      catch { body.innerHTML = '<div class="prose"><p>This file isn\'t available yet.</p></div>'; }
    }
  }
  $('previewClose').onclick = () => { $('preview').hidden = true; previewPath = null; };
  $('previewReveal').onclick = () => previewPath && send({ type: 'reveal', path: previewPath });

  // Minimal, safe Markdown (escape first, then format), with copy buttons on code blocks.
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
  function renderInto(node, src, final) {
    node.innerHTML = md(src); node.dataset.raw = src;
    if (final) for (const pre of node.querySelectorAll('pre')) { const b = el('button', 'copy-btn', 'Copy'); b.onclick = () => copyText(pre.innerText.replace(/Copy$/, '')); pre.appendChild(b); }
  }
  function copyText(t) { navigator.clipboard?.writeText(t).then(() => toast('Copied'), () => toast('Copy failed', true)); }

  // ------------------------------------------------------------ composer
  function makeComposer(host, onSubmit, opts = {}) {
    host.innerHTML = `<div class="box"><div class="chips"></div><div class="top"><textarea rows="1" placeholder="Message Claude…"></textarea><button class="send" title="Send (Enter)">${icon('up')}</button></div><div class="interim"></div>
      <div class="crow"><button class="icon attach" title="Attach files">${icon('plus')}</button><input type="file" multiple hidden>
      <button class="icon mic" title="Dictate (click to start / stop)">${icon('mic')}</button><span class="slot"></span><span class="slot-r"><span class="spin" hidden title="Claude is working"></span></span></div></div>`;
    const ta = host.querySelector('textarea'), chips = host.querySelector('.chips'), fileIn = host.querySelector('input[type=file]');
    const sendBtn = host.querySelector('.send'), mic = host.querySelector('.mic'), interim = host.querySelector('.interim'), spin = host.querySelector('.spin');
    const attachments = []; let busy = false;
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      else if (e.key === 'ArrowUp' && !ta.value.trim() && opts.onArrowUp) { e.preventDefault(); opts.onArrowUp(); }
      else if (e.key === 'Escape' && opts.onEscape) opts.onEscape();
    });
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
      if (attachments.some((a) => !a.path)) { toast('Files are still uploading — one moment.'); return; }
      const text = ta.value.trim(); if (!text && !attachments.length) return;
      onSubmit({ text, files: attachments.map((a) => a.path), queued: busy });
      ta.value = ''; autosize(); attachments.length = 0; renderChips(); if (rec.active) rec.stop();
    }
    sendBtn.onclick = () => { if (busy) onSubmit(null); else submit(); };
    const rec = voice(ta, interim, mic, autosize);
    return {
      focus: () => ta.focus(), addFiles, slot: host.querySelector('.slot'), slotR: host.querySelector('.slot-r'),
      setPlaceholder: (t) => (ta.placeholder = t),
      uploaded(m) { const a = attachments.find((x) => x.ref === m.ref); if (a) { a.path = m.path; renderChips(); } },
      setBusy(v) { busy = v; sendBtn.classList.toggle('stop', v); sendBtn.title = v ? 'Stop' : 'Send (Enter)'; sendBtn.innerHTML = icon(v ? 'stop' : 'up'); spin.hidden = !v; ta.placeholder = v ? 'Type a message to send when Claude is done, or press Stop…' : (opts.placeholder || 'Message Claude…'); },
      setText(t) { ta.value = t; autosize(); ta.focus(); ta.setSelectionRange(t.length, t.length); },
      getText: () => ta.value,
    };
  }
  let pendingFirst = null;
  const welcomeComposer = makeComposer($('welcomeComposer'), (m) => {
    if (!m || m.queued) return;
    const kind = S.tab; const cwd = kind === 'chat' ? '' : S.newFolder;
    if (kind !== 'chat') { if (!cwd) return toast('Choose a project folder first.', true); store.set('lastFolder', cwd); send({ type: 'addProject', path: cwd }); }
    pendingFirst = m;
    send({ type: 'new', kind, cwd, mode: kind === 'chat' ? undefined : (S.newMode || undefined), model: S.newModel ?? undefined, effort: S.newEffort ?? undefined });
  });
  // queue: messages typed while Claude is still working; sent in order when the turn ends ("Send now" interrupts).
  const queues = new Map(); let editing = null;
  const sessionComposer = makeComposer($('sessionComposer'), (m) => {
    if (!m) { send({ type: 'stop', sid: S.sid }); return; }
    if (editing) { const t = editing; editing = null; $('editHint').hidden = true; resend(t, m.text); return; }
    if (m.queued) { const q = queues.get(S.sid) || []; q.push({ text: m.text, files: m.files }); queues.set(S.sid, q); renderQueue(); return; }
    send({ type: 'send', sid: S.sid, text: m.text, files: m.files });
  }, {
    onArrowUp() {
      const q = queues.get(S.sid) || [];
      if (q.length) { const m = q.pop(); renderQueue(); sessionComposer.setText(m.text); return; }
      const turns = [...log.querySelectorAll('.turn[data-text]')]; const last = turns[turns.length - 1];
      if (last && S.info?.status === 'idle') startEdit(last);
    },
    onEscape() { if (editing) { editing = null; $('editHint').hidden = true; sessionComposer.setText(''); } },
  });
  function startEdit(turn) { editing = turn; $('editHint').hidden = false; $('editHint').querySelector('span').textContent = 'Editing your message. Sending will branch the conversation from there.'; sessionComposer.setText(stripAttachLine(turn.dataset.text)); }
  $('editHint').querySelector('button').onclick = () => { editing = null; $('editHint').hidden = true; sessionComposer.setText(''); };
  function renderQueue() {
    const box = $('queue'); box.innerHTML = ''; const q = queues.get(S.sid) || [];
    for (const m of q) {
      const d = el('div', 'qmsg'); const b = el('div', 'bubble', m.text + (m.files?.length ? `\n📎 ${m.files.length} file(s)` : '')); b.title = 'Click to edit'; b.style.cursor = 'text';
      b.onclick = () => { q.splice(q.indexOf(m), 1); renderQueue(); sessionComposer.setText(m.text); };
      const acts = el('div', 'acts'); const now = el('button', 'btn link', 'Send now'); now.title = 'Stop the current work and send this'; now.onclick = () => { q.splice(q.indexOf(m), 1); q.unshift(m); renderQueue(); send({ type: 'stop', sid: S.sid }); };
      const x = el('button', 'ib'); x.innerHTML = '✕'; x.title = 'Remove'; x.onclick = () => { q.splice(q.indexOf(m), 1); renderQueue(); };
      acts.append(now, x); d.append(b, acts); box.appendChild(d);
    }
  }
  function flushQueue(sid) { const q = queues.get(sid); if (!q?.length) return; const m = q.shift(); if (sid === S.sid) renderQueue(); send({ type: 'send', sid, text: m.text, files: m.files }); }
  // chips under the composers (model, effort, permissions), like claude.ai
  welcomeComposer.slot.append($('projectChip'), $('modeChip')); welcomeComposer.slotR.prepend($('modelChip'), $('effortChip'));
  sessionComposer.slot.append($('sModeChip'), $('sBrowserChip')); sessionComposer.slotR.prepend($('sModelChip'), $('sEffortChip'));
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
    const r = new SR(); r.continuous = true; r.interimResults = true; let baseText = '';
    r.onstart = () => { api.active = true; mic.classList.add('rec'); baseText = ta.value; };
    r.onend = () => { api.active = false; mic.classList.remove('rec'); interimEl.textContent = ''; };
    r.onerror = (e) => { if (e.error === 'not-allowed') toast('Microphone access was blocked. Allow it in the address bar and try again.', true); };
    r.onresult = (e) => { let fin = '', inter = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) fin += x[0].transcript; else inter += x[0].transcript; } if (fin) { baseText = (baseText ? baseText.replace(/\s*$/, ' ') : '') + fin.trim(); ta.value = baseText; autosize(); } interimEl.textContent = inter; };
    mic.onclick = () => { if (api.active) { r.stop(); return; } speechSynthesis?.cancel(); r.lang = S.settings.lang || 'fr-FR'; try { r.start(); } catch { /* already started */ } };
    api.stop = () => r.stop(); return api;
  }
  function speak(text) {
    if (!window.speechSynthesis) return;
    const plain = text.replace(/```[\s\S]*?```/g, ' (code) ').replace(/[`*#>_]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(plain.slice(0, 4000)); u.lang = S.settings.lang || 'fr-FR'; speechSynthesis.speak(u);
  }

  // ------------------------------------------------------------- dashboard
  function showDashboard() { showView('dashboard'); send({ type: 'dashboard' }); if (S.dash) renderDashboard(); else $('dashStats').innerHTML = '<div class="muted">Loading…</div>'; }
  function renderDashboard() {
    const D = S.dash; if (!D) return;
    const now = Date.now(); const day = 86400000; const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const sum = (arr) => arr.reduce((a, u) => a + (u.cost || 0), 0);
    const today = D.usage.filter((u) => u.at >= d0.getTime()), week = D.usage.filter((u) => u.at >= now - 7 * day), month = D.usage.filter((u) => u.at >= now - 30 * day);
    const stat = (v, l) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('dashStats').innerHTML = stat('$' + sum(today).toFixed(2), 'Spent today') + stat('$' + sum(week).toFixed(2), 'Last 7 days') + stat('$' + sum(month).toFixed(2), 'Last 30 days') + stat(fmtK(month.reduce((a, u) => a + (u.in || 0) + (u.out || 0), 0)), 'Tokens, 30 days');
    $('dashNote').textContent = D.usage.length ? `${D.usage.length} turns recorded. Estimates reported by Claude Code, not a bill.` : 'Spend is recorded from now on, for every turn run through this app.';
    const pend = $('dashPending'); pend.innerHTML = '';
    const waiting = D.items.filter((s) => s.status === 'waiting');
    if (!waiting.length) pend.appendChild(el('div', 'empty-note', 'Nothing is waiting for you.'));
    for (const s of waiting) for (const p of (s.pending || [])) {
      const d = describe(p.tool, p.input); const row = el('div', 'pend');
      row.innerHTML = `<div class="t"></div><div class="arg"></div><div class="btns"></div>`;
      row.querySelector('.t').textContent = `${s.title} · ${d.label}`; row.querySelector('.arg').textContent = formatInput(p.tool, p.input).split('\n')[0];
      const mk = (label, cls, allow) => { const b = el('button', 'btn ' + cls, label); b.onclick = () => { send({ type: 'permit', sid: s.sid, id: p.id, tool: p.tool, allow, always: false }); row.remove(); }; return b; };
      const open = el('button', 'btn', 'Open'); open.onclick = () => openSession(s);
      row.querySelector('.btns').append(mk('Allow', 'dark', true), mk('Refuse', '', false), open); pend.appendChild(row);
    }
    const run = $('dashRunning'); run.innerHTML = '';
    const running = D.items.filter((s) => s.status === 'running');
    if (!running.length) run.appendChild(el('div', 'empty-note', 'No chat is working right now.'));
    for (const s of running) { const b = el('button', 'row'); b.innerHTML = '<span class="st running"></span><span class="t"><span class="tt"></span><small></small></span>'; b.querySelector('.tt').textContent = s.title; b.querySelector('small').textContent = `${KIND_LABEL[s.kind]} · ${s.kind === 'chat' ? '' : folderName(s.cwd) + ' · '}${ago(s.when)}`; b.onclick = () => openSession(s); run.appendChild(b); }
    const bars = $('dashBars'); bars.innerHTML = '';
    const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(d0.getTime() - i * day); days.push({ d, v: 0 }); }
    for (const u of D.usage) { const idx = Math.floor((u.at - (d0.getTime() - 13 * day)) / day); if (idx >= 0 && idx < 14) days[idx].v += u.cost || 0; }
    const max = Math.max(0.01, ...days.map((x) => x.v));
    for (const x of days) { const b = el('div', 'b'); b.innerHTML = '<i></i><small></small>'; b.querySelector('i').style.height = Math.max(2, Math.round(x.v / max * 90)) + 'px'; b.title = `${x.d.toLocaleDateString()} · $${x.v.toFixed(2)}`; b.querySelector('small').textContent = x.d.toLocaleDateString(undefined, { weekday: 'short' })[0] + ' ' + x.d.getDate(); bars.appendChild(b); }
    const agg = (key, label) => { const m = new Map(); for (const u of month) { const k = u[key] || 'unknown'; const a = m.get(k) || { cost: 0, n: 0, tok: 0 }; a.cost += u.cost || 0; a.n++; a.tok += (u.in || 0) + (u.out || 0); m.set(k, a); } const box = $(label); box.innerHTML = ''; if (!m.size) box.appendChild(el('div', 'empty-note', 'No data yet.')); for (const [k, a] of [...m.entries()].sort((x, y) => y[1].cost - x[1].cost)) { const r = el('div', 'kv'); r.innerHTML = '<span></span><span class="m"></span>'; r.querySelector('span').textContent = key === 'kind' ? (KIND_LABEL[k] || k) : shortModel(k); r.querySelector('.m').textContent = `$${a.cost.toFixed(2)} · ${a.n} turns · ${fmtK(a.tok)} tok`; box.appendChild(r); } };
    agg('model', 'dashModels'); agg('kind', 'dashKinds');
    const ctx = $('dashContext'); ctx.innerHTML = '';
    const withCtx = D.items.filter((s) => s.context && s.context.window).slice(0, 8);
    if (!withCtx.length) ctx.appendChild(el('div', 'empty-note', 'Context use appears for chats that ran through this app.'));
    for (const s of withCtx) { const r = el('div', 'kv'); r.innerHTML = '<span class="n"></span><span class="ctx"><span class="bar"><i></i></span><span class="pct"></span></span>'; r.querySelector('.n').textContent = `${s.title} · ${KIND_LABEL[s.kind]}${s.cost ? ' · ~$' + s.cost.toFixed(2) : ''}`; renderCtx(r.querySelector('.ctx'), s.context); r.style.cursor = 'pointer'; r.onclick = () => openSession(s); ctx.appendChild(r); }
    const rb = $('dashRoutines'); rb.innerHTML = '';
    if (!D.routines.length) rb.appendChild(el('div', 'empty-note', 'No routines. Create one from the Routines page.'));
    for (const r of D.routines) { const row = el('div', 'kv'); row.innerHTML = '<span></span><span class="m"></span>'; row.querySelector('span').textContent = r.name; const last = r.runs?.[0]; row.querySelector('.m').textContent = (r.enabled ? (r.nextRun ? 'next ' + fmtWhen(r.nextRun) : 'on') : 'paused') + (last ? ` · last ${last.ok === false ? 'failed' : last.ok ? 'ok' : 'running'} ${ago(last.at)}` : ''); row.style.cursor = 'pointer'; row.onclick = () => showRoutine(r.id); rb.appendChild(row); }
  }

  // ------------------------------------------------------------- projects
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
        row.querySelector('div').textContent = describeSchedule(r.schedule) + ' · ' + folderName(r.cwd) + (r.enabled && r.nextRun ? ' · next ' + fmtWhen(r.nextRun) : '');
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

  // --------------------------------------------------------- request a fix
  let reportKind = 'bug';
  const REPORT_COPY = {
    bug: { intro: 'Tell us what you saw. The app version, system and recent errors come with it automatically.', title: 'The reply stops after the first line', p: 'What happened', pp: 'The message you saw, the button that did nothing…', s: 'What should have happened', sp: 'The result you were expecting instead.', btn: 'Send report' },
    feature: { intro: 'Describe what you need. The app version and system come with it automatically.', title: 'Export a chat to PDF', p: 'What it should do', pp: 'The feature itself: where it lives and how you would use it.', s: 'Why it matters', sp: 'What you do today instead, and what it costs you.', btn: 'Send request' },
  };
  function openReport(prefill = {}) {
    reportKind = prefill.kind || 'bug'; reportKindUi();
    $('rpTitle').value = prefill.title || ''; $('rpPrimary').value = prefill.primary || ''; $('rpSecondary').value = ''; $('rpResult').textContent = '';
    $('rpSend').disabled = false; $('rpSend').textContent = REPORT_COPY[reportKind].btn;
    $('reportDlg').showModal(); $('rpTitle').focus();
  }
  function reportKindUi() {
    const c = REPORT_COPY[reportKind];
    document.querySelectorAll('#reportKind button').forEach((b) => b.classList.toggle('active', b.dataset.k === reportKind));
    $('reportIntro').textContent = c.intro; $('rpTitle').placeholder = c.title;
    $('rpPrimaryLbl').firstChild.textContent = c.p + ' '; $('rpPrimary').placeholder = c.pp; $('rpSecondaryLbl').firstChild.textContent = c.s + ' '; $('rpSecondary').placeholder = c.sp;
    $('rpImpactLbl').hidden = reportKind !== 'bug'; $('rpErrors').parentElement.hidden = reportKind !== 'bug'; $('rpSend').textContent = c.btn;
  }
  $('reportKind').onclick = (e) => { const b = e.target.closest('button'); if (b) { reportKind = b.dataset.k; reportKindUi(); } };
  $('reportBtn').onclick = () => openReport();
  $('setReportTry').onclick = () => { $('settingsDlg').close(); openReport(); };
  $('rpCancel').onclick = () => $('reportDlg').close();
  $('reportForm').onsubmit = (e) => {
    e.preventDefault();
    const errors = reportKind === 'bug' && $('rpErrors').checked ? [...log.querySelectorAll('.note.err')].map((n) => n.firstChild?.textContent || n.textContent).slice(-5).join('\n---\n') : '';
    const view = S.view === 'session' && S.info ? `${KIND_LABEL[S.info.kind]} session "${S.info.title || ''}" (${S.info.model || 'default model'}, ${S.info.mode})` : S.view;
    send({ type: 'report', kind: reportKind, title: $('rpTitle').value.trim(), primary: $('rpPrimary').value.trim(), secondary: $('rpSecondary').value.trim(), impact: $('rpImpact').value, errors, view, userAgent: navigator.userAgent });
    $('rpSend').disabled = true; $('rpSend').textContent = 'Sending…'; $('rpResult').textContent = '';
  };
  function onReported(m) {
    $('rpSend').disabled = false; $('rpSend').textContent = REPORT_COPY[reportKind].btn;
    if (m.error) { $('rpResult').style.color = 'var(--danger)'; $('rpResult').textContent = m.error; return; }
    $('rpResult').style.color = '';
    if (m.via === 'browser') { window.open(m.url, '_blank'); $('rpResult').textContent = 'A GitHub page with your report opened in a new tab. Press "Submit new issue" there to file it.'; }
    else { $('rpResult').innerHTML = 'Filed: <a target="_blank" rel="noopener"></a>'; const a = $('rpResult').querySelector('a'); a.href = m.url; a.textContent = m.url; toast('Issue filed on GitHub.'); }
  }

  // --------------------------------------------------------------- search
  // ⌘K / Ctrl+K or "/" anywhere. Filters: All, Chat, Cowork, Code, Projects, Routines. ←/→ change the filter, ↑/↓ move, ↵ opens.
  const FILTERS = ['all', 'chat', 'cowork', 'code', 'projects', 'routines'];
  let selIdx = 0, results = [], searchFilter = 'all';
  function openSearch() { $('search').hidden = false; $('searchInput').value = ''; searchFilter = 'all'; renderSearch(); $('searchInput').focus(); }
  function closeSearch() { $('search').hidden = true; }
  $('searchBtn').onclick = openSearch; $('searchClose').onclick = closeSearch;
  $('search').onclick = (e) => { if (e.target === $('search')) closeSearch(); };
  $('searchInput').oninput = renderSearch;
  $('searchFilters').onclick = (e) => { const b = e.target.closest('button'); if (b) { searchFilter = b.dataset.f; renderSearch(); $('searchInput').focus(); } };
  $('searchInput').onkeydown = (e) => {
    if (e.key === 'Escape') closeSearch();
    else if (e.key === 'ArrowDown') { selIdx = Math.min(selIdx + 1, results.length - 1); paintSel(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { selIdx = Math.max(selIdx - 1, 0); paintSel(); e.preventDefault(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !$('searchInput').value) { const i = FILTERS.indexOf(searchFilter); searchFilter = FILTERS[(i + (e.key === 'ArrowRight' ? 1 : FILTERS.length - 1)) % FILTERS.length]; renderSearch(); e.preventDefault(); }
    else if (e.key === 'Enter') { results[selIdx]?.go(); closeSearch(); }
  };
  function renderSearch() {
    document.querySelectorAll('#searchFilters button').forEach((b) => b.classList.toggle('active', b.dataset.f === searchFilter));
    const q = $('searchInput').value.trim().toLowerCase(); const f = searchFilter;
    const hit = (t) => !q || t.toLowerCase().includes(q);
    const sessions = []; const others = [];
    if (f === 'all' || f === 'projects') for (const p of S.projects) if (hit(p.name + ' ' + p.path) && (q || f === 'projects')) others.push({ icon: 'folder', label: p.name, sub: 'Project · new session', go: () => { setTab('code'); showWelcome(p.path); } });
    if (f === 'all' || f === 'routines') for (const r of S.routines) if (hit(r.name) && (q || f === 'routines')) others.push({ icon: 'clock', label: r.name, sub: 'Routine · ' + describeSchedule(r.schedule), go: () => showRoutine(r.id) });
    for (const s of S.sessions) if (!s.archived && s.kind !== 'routine' && (f === 'all' || f === s.kind) && hit(s.title + ' ' + s.cwd)) sessions.push({ icon: s.kind, label: s.title, sub: `${KIND_LABEL[s.kind]}${s.kind === 'chat' ? '' : ' · ' + folderName(s.cwd)} · ${ago(s.when)}`, go: () => openSession(s) });
    const box = $('searchResults'); box.innerHTML = ''; results = []; selIdx = 0;
    const section = (title, list) => { if (!list.length) return; box.appendChild(el('div', 'sh', title)); for (const r of list) { const b = el('button', 'row'); b.innerHTML = `${icon(r.icon)}<span class="t"><span class="tt"></span><small></small></span>`; b.querySelector('.tt').textContent = r.label; b.querySelector('small').textContent = r.sub; b.onclick = () => { r.go(); closeSearch(); }; box.appendChild(b); results.push(r); } };
    section(q ? 'Results' : 'Recents', sessions.slice(0, q ? 30 : 10)); section('Projects and routines', others.slice(0, 15));
    if (!q) section('Actions', [{ icon: 'plus', label: 'New ' + (S.tab === 'chat' ? 'chat' : S.tab === 'cowork' ? 'task' : 'session'), sub: 'In ' + (S.tab === 'chat' ? 'Chat' : S.tab === 'cowork' ? 'Cowork' : 'Code'), go: () => showWelcome() }, { icon: 'dash', label: 'Dashboard', sub: 'Spend, approvals, context', go: showDashboard }]);
    if (!results.length) box.appendChild(el('div', 'empty-list', 'No match.'));
    paintSel();
  }
  function paintSel() { [...$('searchResults').querySelectorAll('.row')].forEach((x, i) => x.classList.toggle('sel', i === selIdx)); }
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey; const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
    else if (e.key === '/' && !typing && !mod) { e.preventDefault(); openSearch(); }
    else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); showWelcome(); }
    else if (mod && e.key.toLowerCase() === '.') { e.preventDefault(); if (S.view === 'session') openPanel(!document.body.classList.contains('panel-open')); }
    else if (e.key === 'Escape') { closeSearch(); $('menu').hidden = true; if (!$('preview').hidden) { $('preview').hidden = true; previewPath = null; } }
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
    $('setEffort').value = s.effort || '';
    $('setMode').value = s.mode || 'default'; $('setCoworkMode').value = s.coworkMode || 'acceptEdits';
    $('setBrowser').checked = s.browser !== false; $('setLang').value = s.lang || 'fr-FR';
    $('setSpeak').checked = store.get('speak', false); $('setArchived').checked = S.showArchived;
    if (document.activeElement !== $('setName')) $('setName').value = s.name || S.user || '';
    if (document.activeElement !== $('setRepo')) $('setRepo').value = s.repo || S.repo || '';
    $('setToken').placeholder = s.hasToken ? 'Saved (enter a new one to replace)' : 'github_pat_…';
    pills('themePills', store.get('theme', 'auto')); pills('sizePills', store.get('size', 'm')); pills('widthPills', store.get('width', 'm'));
    $('aboutLine').textContent = `Claude Web UI ${S.version}${S.auth?.cli ? ' · ' + S.auth.cli : ''} · runs locally on this computer · shortcuts: ⌘K or / search, ⌘N new, ⌘. panel`;
  }
  function pills(id, v) { document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('active', b.dataset.v === v)); }
  $('themePills').onclick = (e) => { const b = e.target.closest('button'); if (b) { store.set('theme', b.dataset.v); applyTheme(); pills('themePills', b.dataset.v); } };
  $('sizePills').onclick = (e) => { const b = e.target.closest('button'); if (b) { store.set('size', b.dataset.v); applyTheme(); pills('sizePills', b.dataset.v); } };
  $('widthPills').onclick = (e) => { const b = e.target.closest('button'); if (b) { store.set('width', b.dataset.v); applyTheme(); pills('widthPills', b.dataset.v); } };
  $('setModel').onchange = () => { const v = modelValue($('setModel')); if (v === null) { applySettingsToUi(); return; } send({ type: 'settings', model: v }); };
  $('setEffort').onchange = () => send({ type: 'settings', effort: $('setEffort').value });
  $('setName').onchange = () => send({ type: 'settings', name: $('setName').value });
  $('setRepo').onchange = () => send({ type: 'settings', repo: $('setRepo').value });
  $('setToken').onchange = () => { send({ type: 'settings', githubToken: $('setToken').value }); $('setToken').value = ''; toast('Token saved.'); };
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
  // Native dialog first (Windows Explorer, macOS Finder, zenity); the in-page browser as fallback.
  let dlgCurrent = null, dlgCb = null, pickRef = null;
  function pickFolder(start, cb) { dlgCb = cb; pickRef = Math.random().toString(36).slice(2); send({ type: 'pickFolder', ref: pickRef, start }); toast('Choose a folder in the window that opened.', false, 2500); }
  function onPicked(m) {
    if (m.ref !== pickRef) return;
    if (m.path) { dlgCb?.(m.path); return; }
    if (m.unavailable) { send({ type: 'ls', path: S.home }); $('folderDlg').showModal(); }
  }
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
    const h = m.offsetHeight || entries.length * 34 + 20;
    let x = Math.min(r ? r.left : e.clientX, window.innerWidth - 240), y = r ? r.bottom + 4 : e.clientY;
    if (y + h > window.innerHeight - 8) y = Math.max(8, (r ? r.top : e.clientY) - h - 4);
    m.style.left = x + 'px'; m.style.top = y + 'px';
    setTimeout(() => document.addEventListener('click', () => (m.hidden = true), { once: true }), 0);
  }
  function toast(text, err, ms) { const t = el('div', 'toast' + (err ? ' err' : ''), text); $('toasts').appendChild(t); setTimeout(() => t.remove(), ms || (err ? 7000 : 3500)); }
  function ago(ts) { const d = Date.now() - ts; if (d < 60000) return 'just now'; if (d < 3600000) return Math.floor(d / 60000) + ' min ago'; if (d < 86400000) return Math.floor(d / 3600000) + ' h ago'; if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' d ago'; return new Date(ts).toLocaleDateString(); }
  function fmtWhen(ts) { const d = new Date(ts); const same = d.toDateString() === new Date().toDateString(); return (same ? 'today ' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  const fmtDur = (s) => (s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's');
  const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
  const shortModel = (m) => { const s = String(m || '').replace(/^(anthropic\.|us\.|eu\.|apac\.|global\.)/, '').replace(/^claude-/, '').replace(/-\d{8}.*$/, '').replace(/-v\d+:\d+$/, ''); return s || m; };
  function toLocalInput(iso) { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  function baseName(p) { return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }
  function shortPath(p) { if (!p) return ''; return S.home && p.startsWith(S.home) ? '~' + p.slice(S.home.length) : p; }

  // ---------------------------------------------------------------- start
  resetView(); setTab(S.tab); showWelcome(); connect();
})();
