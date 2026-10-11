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
  const tr = window.I18N.t, LOCALE = window.I18N.locale;   // interface language (public/i18n.js); English is the key

  // ---------------------------------------------------------------- state
  const S = {
    ws: null, connected: false,
    tab: store.get('tab', 'code'),            // chat | cowork | code
    view: 'welcome',                          // welcome | session | dashboard | projects | routines | routine | routineEdit | customize
    sid: null, info: null, routineId: null,
    sessions: [], projects: [], routines: [], artifacts: [], artifactsLoaded: false, openAfter: null, settings: {}, auth: { checked: false }, repo: '',
    skills: null, mcp: null, plugins: null, dash: null,
    home: '', user: '', chatDir: '', version: '',
    closedGroups: new Set(store.get('closedGroups', [])),
    showArchived: store.get('showArchived', false),
    connectSkipped: false,
    newFolder: store.get('lastFolder', ''), newMode: null, newModel: null, newEffort: null,
    selecting: false, selected: new Set(), suggest: null, suggesting: false,   // sidebar select mode (bulk delete), AI suggestions {sid: why}
  };
  const KIND_LABEL = { chat: tr('Chat'), cowork: tr('Cowork'), code: tr('Code'), routine: tr('Routine') };
  const MODE_LABEL = { auto: tr('Auto (Claude decides, asks when unsure)'), acceptEdits: tr('Auto-accept edits'), default: tr('Ask before changes'), bypassPermissions: tr('Autonomous (never asks)'), plan: tr('Plan only') };
  const MODE_SHORT = { auto: tr('Auto'), acceptEdits: tr('Auto-accept edits'), default: tr('Ask before changes'), bypassPermissions: tr('Autonomous'), plan: tr('Plan only') };
  const EFFORT_LABEL = { '': tr('Default effort'), low: tr('Low effort'), medium: tr('Medium effort'), high: tr('High effort'), xhigh: tr('Very high effort'), max: tr('Max effort') };
  const MODELS = [['', tr('Default model')], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['__custom', tr('Custom ID…')]];
  const modelLabel = (m) => (m ? ({ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }[m] || shortModel(m)) : tr('Default model'));
  const ROUTINE_TEMPLATES = [
    { name: tr('Morning briefing'), desc: tr('Summarise what changed in the folder since yesterday and list what needs attention, in BRIEFING.md.'), prompt: 'Look at the files that changed in this folder in the last 24 hours. Write a short briefing in BRIEFING.md: what changed, what looks unfinished, and 3 suggested next actions.', schedule: { type: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] } },
    { name: tr('Inbox triage'), desc: tr('Read new files dropped in an Inbox folder, sort them and write a summary.'), prompt: 'Check the Inbox subfolder. For each new file: read it, write a one-paragraph summary in INBOX-SUMMARY.md (newest first), and move the file to Processed/.', schedule: { type: 'daily', time: '12:00', days: [1, 2, 3, 4, 5] } },
    { name: tr('Project health check'), desc: tr('Run the tests and linters, report failures and propose fixes.'), prompt: 'Run the project\'s tests and linters. If something fails, explain why and propose a fix (do not change code unless the fix is trivial and safe). Write the report in HEALTH.md.', schedule: { type: 'daily', time: '07:00', days: [1, 2, 3, 4, 5] } },
    { name: tr('Weekly report'), desc: tr('Every Friday, compile the week\'s work into a report.'), prompt: 'Using git history and files changed this week, write WEEKLY-REPORT.md: achievements, open issues, next week\'s plan. Keep it under one page.', schedule: { type: 'daily', time: '17:00', days: [5] } },
    { name: tr('Dependency updates'), desc: tr('Every Monday, look for outdated packages and security advisories.'), prompt: 'Check for outdated dependencies and known vulnerabilities in this project. Write DEPENDENCIES.md with what should be updated, the risk, and the command to run. Do not update anything yourself.', schedule: { type: 'daily', time: '09:15', days: [1] } },
    { name: tr('Data refresh'), desc: tr('Re-run a data script and refresh a spreadsheet or CSV every hour.'), prompt: 'Run the data refresh script in this folder (look for refresh.* or update.*). Verify the output file was updated and report row counts in REFRESH-LOG.md (append).', schedule: { type: 'interval', every: 60 } },
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
        try { if (sessionStorage.getItem('updating')) { sessionStorage.removeItem('updating'); if (!m.news) toast(tr('Updated to {v}', { v: m.version })); } } catch { /* private window */ }
        setUser(m.user); renderAuth(); applySettingsToUi(); renderWelcomeChips();
        if (S.view === 'welcome') showWelcome(); if (S.view === 'routines') renderRoutinesPage(); if (S.view === 'routine') showRoutine(S.routineId, true); if (S.view === 'dashboard') send({ type: 'dashboard' });
        break;
      case 'sessions': S.sessions = m.items; S.projects = m.projects; $('projectCount').textContent = S.projects.length; $('projectCount').hidden = !S.projects.length; renderList(); refreshArtifacts(); renderNeeds(); if (S.view === 'welcome') { renderWelcomeChips(); renderHomeDash(); refreshHomeDash(); } if (S.view === 'projects') renderProjects(); if (S.view === 'routine') renderRoutineRuns(); if (S.view === 'dashboard') send({ type: 'dashboard' }); break;
      case 'routines': S.routines = m.items; renderList(); if (S.view === 'routines') renderRoutinesPage(); if (S.view === 'routine') showRoutine(S.routineId, true); if (S.view === 'welcome') renderHomeDash(); break;
      case 'settings': S.settings = m.settings; if (m.repo) S.repo = m.repo; if (m.user) { setUser(m.user); if (S.view === 'welcome') showWelcome(); } applySettingsToUi(); renderWelcomeChips(); break;
      case 'auth': S.auth = m.auth; renderAuth(); break;
      case 'update': S.update = m; renderUpdate(); break;
      case 'context': if (S.info && m.sid === S.info.sid) { S.info.context = m.context; renderCtx($('sCtx'), m.context); } break;
      case 'whatsNew': showWhatsNew(m); break;
      case 'authTest': toast(m.ok ? tr('Connection works. Claude replied: "{reply}"', { reply: m.reply }) : tr('Request failed: {message}', { message: m.message }), !m.ok, 8000); $('connectDetail').textContent = $('connDetail').textContent = m.ok ? '' : m.message; break;
      case 'opened': openSessionView(m.info, m.items, m.liveText, m.liveThinking); if (m.draft) sessionComposer.setText(m.draft); if (S.openAfter) { openFile(S.openAfter); S.openAfter = null; } break;
      case 'artifacts': S.artifacts = m.items; S.artifactsLoaded = true; updateArtifactCount(); renderList(); if (S.view === 'projects') renderProjects(); if (!$('search').hidden) renderSearch(); if (S.view === 'artifacts') renderArtifacts(); if (S.view === 'welcome') renderHomeDash(); break;
      case 'info': if (S.info && m.info.sid === S.info.sid) { S.info = m.info; renderSessionHead(); syncPanes(); } break;
      case 'connectors': if (connMenuWanted) { connMenuWanted = false; connectorMenu(m.items || [], m.defaults || []); } break;
      case 'sdkId': if (S.info && m.sid === S.info.sid) S.info.sdkId = m.sdkId; break;
      case 'status': if (S.info && m.sid === S.info.sid) { window.Voice?.onStatus(m.status); S.info.status = m.status; renderSessionHead(); sessionComposer.setBusy(m.status !== 'idle'); if (m.status === 'idle') hideWorking(); else showWorking(m.status === 'waiting' ? tr('Waiting for your approval') : null); } if (m.status === 'idle') flushQueue(m.sid); break;
      case 'ev': if (S.info && m.sid === S.info.sid) renderEvent(m.ev); else if (m.ev.type === 'done' && m.ev.ok === false && m.ev.message) toast(m.ev.message, true); else if (m.ev.type === 'permission') toast(tr('A chat needs your approval. See the sidebar or the Dashboard.'), false, 5000); break;
      case 'ls': renderDirs(m); break;
      case 'picked': onPicked(m); break;
      case 'uploaded': if (m.ref === 'skill') { send({ type: 'skillAdd', file: m.path }); } else { welcomeComposer.uploaded(m); sessionComposer.uploaded(m); } break;
      case 'skills': S.skills = m.items; renderSkills(); break;
      case 'skillText': if ($('skillEditDlg').dataset.dir === m.dir) { $('skeText').value = m.text; $('skeText').disabled = false; } break;
      case 'mcp': S.mcp = m.items; renderMcp(); break;
      case 'plugins': S.plugins = m; renderPlugins(); break;
      case 'dashboard': S.dash = m; if (S.view === 'dashboard') renderDashboard(); if (S.view === 'welcome') renderHomeDash(); break;
      case 'reported': onReported(m); break;
      case 'browserFrame': browserFrame(m); break;
      case 'browserState': browserState(m); break;
      case 'launchList': onLaunchList(m); break;
      case 'launchLog': onLaunchLog(m); break;
      case 'launchLogs': onLaunchLogs(m); break;
      case 'fsList': onFsList(m); break;
      case 'fsSearch': onFsSearch(m); break;
      case 'termOut': onTermOut(m); break;
      case 'termOpened': onTermOpened(m); break;
      case 'toast': toast(m.text); break;
      case 'error': toast(m.message, true); break;
      case 'cleanupSuggest': onCleanupSuggest(m); break;
    }
    if (onceHandlers.length) onceHandlers.splice(0).forEach((h) => h(m));
  }
  function setUser(u) { S.user = u; $('userName').textContent = u; $('avatar').textContent = (u || 'U').charAt(0).toUpperCase(); }

  // ---------------------------------------------------------------- auth
  // Shown once per browser for each new version the server starts on.
  function showWhatsNew(m) {
    if (!m.log?.length || store.get('seenHead', '') === m.head) return;
    store.set('seenHead', m.head);
    $('newsHead').textContent = tr("What's new in {v}", { v: m.version });
    const ul = $('newsList'); ul.innerHTML = '';
    for (const line of m.log) ul.appendChild(el('li', '', line));
    $('newsDlg').showModal();
  }
  $('newsClose').onclick = () => $('newsDlg').close();
  // Welcome screen: the "how it works" card (hidden per browser once dismissed) and the map of the app.
  $('howto').hidden = store.get('howtoHidden', false);
  $('howtoHide').onclick = () => { store.set('howtoHidden', true); $('howto').hidden = true; };
  $('mapBtn').onclick = $('mapBtnCode').onclick = () => $('mapDlg').showModal();
  $('mapClose').onclick = () => $('mapDlg').close();
  function renderUpdate() {
    const u = S.update || {}, b = $('updateBtn');
    if (u.manual) { if (u.error) toast(tr('Could not check for updates: {e}', { e: u.error }), true); else showUpdateDlg(); }
    else if (u.failed) toast(tr('Update failed: {e}', { e: u.error }), true);
    b.hidden = !u.available; b.disabled = !!u.applying;
    const steps = { pull: tr('Pulling the latest version…'), install: tr('Installing dependencies…'), relaunch: tr('Relaunching…') };
    b.querySelector('span').textContent = u.applying ? steps[u.step] || tr('Updating…') : tr('Relaunch to update');
    b.title = u.available ? tr('{n} new commit(s)', { n: u.behind }) + (u.log?.length ? '\n' + u.log.join('\n') : '') : '';
  }
  // Update popup: lists what changed since the running version; "Update now" pulls, installs and relaunches.
  // With nothing new, the same popup offers to reinstall and relaunch anyway (a forced update).
  function showUpdateDlg() {
    const u = S.update || {}, list = $('updLog'); list.innerHTML = '';
    $('updTitle').textContent = u.available ? tr('Update available') : tr('You have the latest version');
    $('updSub').textContent = u.available ? tr('{n} change(s) since your version:', { n: u.behind }) : tr('Nothing new to download. You can still reinstall and relaunch the app.');
    for (const l of u.log || []) list.appendChild(el('li', null, l));
    $('updGo').textContent = u.available ? tr('Update now') : tr('Reinstall and relaunch');
    if (!$('updDlg').open) $('updDlg').showModal();
  }
  $('updLater').onclick = () => $('updDlg').close();
  $('updGo').onclick = () => { $('updDlg').close(); applyUpdateNow(); };
  $('updCheckBtn').onclick = () => { toast(tr('Checking for updates…')); send({ type: 'updateCheck' }); };
  function applyUpdateNow() { try { sessionStorage.setItem('updating', '1'); } catch { /* ignore */ } S.update = { ...S.update, applying: true, step: 'pull' }; renderUpdate(); send({ type: 'updateApply' }); }
  $('updateBtn').onclick = showUpdateDlg;
  $('updateCheck').onclick = () => { toast(tr('Checking for updates…')); send({ type: 'updateCheck' }); };
  function renderAuth() {
    const a = S.auth || {}; const dot = $('authDot'), label = $('authLabel');
    const prov = { bedrock: 'Amazon Bedrock', vertex: 'Google Vertex', foundry: 'Microsoft Foundry', firstParty: tr('Claude account') }[a.provider] || 'Claude';
    let text, cls;
    if (!S.connected) { cls = 'bad'; text = tr('Server not reachable'); }
    else if (!a.checked) { cls = ''; text = tr('Checking connection…'); }
    else if (a.connected === true) { cls = 'ok'; text = tr('Connected · {prov}', { prov }); }
    else if (a.connected === false) { cls = 'bad'; text = tr('Not connected'); }
    else { cls = 'warn'; text = tr('Connection not verified'); }
    dot.className = 'dot ' + cls; label.textContent = '· ' + (a.connected === true ? prov : text); $('userBtn').title = text;
    $('connStatus').textContent = text + (a.cli ? ` · ${a.cli}` : ''); $('connDetail').textContent = a.detail || '';
    $('connect').hidden = !(S.connected && a.checked && a.connected === false && !S.connectSkipped);
    $('connectDetail').textContent = a.detail || '';
    $('connectText').textContent = a.provider === 'bedrock' ? tr('Claude is set up for Amazon Bedrock but the AWS credentials are missing or expired.') : tr('This interface uses the same login as the claude terminal command.');
  }
  $('userBtn').onclick = (e) => menu(e, [
    [tr('Settings'), () => openSettings('general')],
    [tr('Connection…'), () => openSettings('connection')],
    [S.showArchived ? tr('Hide archived chats') : tr('Show archived chats'), () => { S.showArchived = !S.showArchived; store.set('showArchived', S.showArchived); renderList(); }],
    null,
    [tr('Request a fix or a feature'), () => openReport()],
  ], S.user || tr('Account'));
  $('connectCheck').onclick = $('connCheck').onclick = () => { $('connectDetail').textContent = tr('Checking…'); send({ type: 'authCheck' }); };
  $('connectOpen').onclick = $('connLogin').onclick = () => { send({ type: 'authLogin' }); toast(tr('A terminal window with claude should open. Log in there, then press "Check again".'), false, 6000); };
  $('connectTest').onclick = $('connTest').onclick = () => { $('connectDetail').textContent = $('connDetail').textContent = tr('Sending a tiny request…'); send({ type: 'authTest' }); };
  $('connectSkip').onclick = () => { S.connectSkipped = true; $('connect').hidden = true; };

  // ------------------------------------------------------------- sidebar
  // Two spaces like claude.ai: "Chat and Cowork" (S.tab chat|cowork, chosen in the composer) and "Code".
  const space = () => (S.tab === 'code' ? 'code' : 'chat');
  function setTab(tab) {
    S.tab = tab; store.set('tab', tab);
    if (S.selecting && !S.suggesting) { S.selecting = false; S.selected = new Set(); S.suggest = null; }   // a selection belongs to one space
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === space()));
    // The Code space is its own product on claude.ai: "Claude Code", Routines, task composer docked at the bottom.
    document.body.classList.toggle('space-code', space() === 'code');
    $('brand').textContent = space() === 'code' ? 'Claude Code' : 'Claude';
    $('navRoutines').querySelector('span').textContent = space() === 'code' ? tr('Routines') : tr('Scheduled');
    renderList();
    if (S.view === 'welcome') showWelcome();
  }
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab === 'code' ? 'code' : (store.get('chatKind', 'chat')))));
  $('newBtn').onclick = () => showWelcome();
  $('navDashboard').onclick = () => showDashboard();
  $('navProjects').onclick = () => showProjects();
  $('navArtifacts').onclick = () => showArtifacts();
  $('navRoutines').onclick = () => showRoutines();
  $('navCustomize').onclick = () => showCustomize();
  $('navMore').onclick = () => { const open = $('moreNav').hidden; $('moreNav').hidden = !open; $('navMore').classList.toggle('open', open); store.set('moreNav', open); };
  if (store.get('moreNav', false)) { $('moreNav').hidden = false; $('navMore').classList.add('open'); }
  // resizable sidebar: drag the right edge; the width is remembered per browser
  const SIDE_MIN = 180, SIDE_MAX = 520;
  const setSideW = (w) => document.documentElement.style.setProperty('--side-w', Math.max(SIDE_MIN, Math.min(SIDE_MAX, w)) + 'px');
  { const saved = store.get('sideW', 0); if (saved) setSideW(saved); }
  $('sideResize').onpointerdown = (e) => {
    e.preventDefault(); const x0 = e.clientX, w0 = $('sidebar').getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const move = (ev) => setSideW(w0 + ev.clientX - x0);
    const up = (ev) => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); store.set('sideW', Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, w0 + ev.clientX - x0)))); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  };
  $('sideResize').ondblclick = () => { setSideW(236); store.set('sideW', 0); };
  $('collapseBtn').onclick = () => { document.body.classList.add('collapsed'); $('expandBtn').hidden = false; };
  $('expandBtn').onclick = () => { document.body.classList.remove('collapsed'); $('expandBtn').hidden = true; };
  function markNav() {
    const map = { dashboard: 'navDashboard', projects: 'navProjects', artifacts: 'navArtifacts', routines: 'navRoutines', routine: 'navRoutines', routineEdit: 'navRoutines', customize: 'navCustomize', welcome: 'newBtn' };
    document.querySelectorAll('.sb-nav button').forEach((b) => b.classList.toggle('active', b.id === map[S.view]));
  }

  // The chat space lists chats and cowork tasks together ("Chats and tasks"); Code lists sessions by project.
  const visibleSessions = (kind) => S.sessions.filter((s) => (S.showArchived || !s.archived) && (kind === 'chat' ? s.kind === 'chat' || s.kind === 'cowork' : s.kind === kind));
  function renderList() {
    const box = $('list'); box.innerHTML = '';
    const items = visibleSessions(space());
    const section = (title, extra) => { const h = el('div', 'sec-head'); h.appendChild(el('span', null, title)); if (extra) h.appendChild(extra); box.appendChild(h); };
    if (space() === 'chat') {
      // Scheduled: routines, with a badge for runs not yet opened
      const routines = S.routines.filter((r) => r.enabled || S.sessions.some((s) => s.routineId === r.id));
      if (routines.length) {
        section(tr('Scheduled'));
        for (const r of routines.slice(0, 6)) box.appendChild(routineRow(r));
      }
      const pinned = items.filter((s) => s.pinned);
      if (pinned.length) { section(tr('Pinned')); for (const s of pinned.sort((a, b) => b.when - a.when)) box.appendChild(sessionRow(s)); }
      const rest = items.filter((s) => !s.pinned).sort((a, b) => b.when - a.when);
      section(tr('Chats and tasks'), optionsButton());
      if (S.selecting || S.suggesting) box.appendChild(selectBar());
      if (!rest.length && !pinned.length) { box.appendChild(el('div', 'empty-list', tr('Chats and tasks you start will show up here'))); return; }
      for (const s of rest) box.appendChild(sessionRow(s));
      return;
    }
    const groups = new Map();
    for (const p of S.projects) groups.set(p.path, { name: p.name, path: p.path, items: [] });
    for (const s of items) { const k = s.cwd || '?'; if (!groups.has(k)) groups.set(k, { name: folderName(s.cwd), path: s.cwd || '', items: [] }); groups.get(k).items.push(s); }
    const arr = [...groups.values()].sort((a, b) => (latest(b) - latest(a)) || a.name.localeCompare(b.name));
    // Two views of the Code sessions: grouped by project, or by date (Today, Yesterday…).
    const view = store.get('sessionView') || 'project';
    const tog = el('span', 'view-tog');
    for (const [v, label] of [['project', tr('Project')], ['date', tr('Date')]]) {
      const b = el('button', view === v ? 'on' : null, label); b.onclick = (e) => { e.stopPropagation(); store.set('sessionView', v); renderList(); }; tog.appendChild(b);
    }
    const extra = el('span', 'sec-extra'); extra.append(tog, optionsButton());
    section(tr('Sessions'), extra);
    if (S.selecting || S.suggesting) box.appendChild(selectBar());
    if (!items.length && (view === 'date' || !arr.length)) { box.appendChild(el('div', 'empty-list', tr('Sessions you start will show up here'))); return; }
    if (view === 'date') { for (const [title, list] of byDate(items)) box.appendChild(group(title, list)); return; }
    for (const g of arr) box.appendChild(group(g.name, g.items, g.path));
  }
  function routineRow(r) {
    const b = el('div', 'row rt'); b.tabIndex = 0; b.setAttribute('role', 'button');
    const fresh = S.sessions.filter((s) => s.routineId === r.id && s.unread).length;
    const running = S.sessions.some((s) => s.routineId === r.id && s.status !== 'idle');
    b.innerHTML = `<span class="st"></span><span class="t"><span class="tt"></span></span>`;
    b.querySelector('.tt').textContent = r.name; b.querySelector('.st').className = 'st ' + (running ? 'running' : fresh ? 'unread' : 'hollow');
    if (fresh) b.appendChild(el('span', 'badge', tr('{n} new', { n: fresh })));
    b.onclick = () => showRoutine(r.id); b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showRoutine(r.id); } };
    return b;
  }
  const folderName = (p) => (!p ? tr('Other') : p === S.home ? tr('Home folder') : baseName(p) || p);
  const latest = (g) => g.items.reduce((m, s) => Math.max(m, s.when), 0);
  function byDate(items) {
    const now = new Date(); const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const buckets = [[tr('Today'), []], [tr('Yesterday'), []], [tr('Previous 7 days'), []], [tr('Older'), []]];
    for (const s of items) buckets[s.when >= d0 ? 0 : s.when >= d0 - 86400000 ? 1 : s.when >= d0 - 7 * 86400000 ? 2 : 3][1].push(s);
    return buckets.filter((b) => b[1].length);
  }
  function group(name, items, folder) {
    const key = folder || name;
    const g = el('div', 'grp' + (S.closedGroups.has(key) ? ' closed' : ''));
    const h = el('div', 'grp-head'); h.innerHTML = `<span class="arrow">▼</span><span class="name"></span>`;
    h.querySelector('.name').textContent = name; h.title = folder || name;
    if (folder) {
      const sids = new Set(items.map((s) => s.sid)); const nArt = visibleArts().reduce((n, a) => n + (sids.has(a.sid) ? 1 : 0), 0);
      if (nArt) { const g = el('span', 'badge art', nArt); g.title = nArt === 1 ? tr('1 file') : tr('{n} files', { n: nArt }); h.appendChild(g); }
      const plus = el('button', 'ib sm'); plus.title = tr('New session in this folder'); plus.innerHTML = icon('plus');
      plus.onclick = (e) => { e.stopPropagation(); showWelcome(folder); };
      h.appendChild(plus);
      h.oncontextmenu = (e) => { e.preventDefault(); menu(e, [[tr('New session here'), () => showWelcome(folder)], [tr('Remove from list'), () => send({ type: 'removeProject', path: folder })]]); };
    }
    h.onclick = () => { g.classList.toggle('closed'); if (g.classList.contains('closed')) S.closedGroups.add(key); else S.closedGroups.delete(key); store.set('closedGroups', [...S.closedGroups]); };
    g.appendChild(h);
    const body = el('div', 'grp-body');
    for (const s of [...items].sort((a, b) => (b.pinned - a.pinned) || (b.when - a.when))) body.appendChild(sessionRow(s));
    if (!items.length) body.innerHTML = '<div class="empty-list" style="padding:2px 10px 6px;text-align:left">' + tr('No sessions yet') + '</div>';
    g.appendChild(body);
    return g;
  }
  function sessionRow(s) {
    // a div, not a button: the row holds its own "more" button
    const b = el('div', 'row' + (isActive(s) ? ' active' : '') + (s.archived ? ' archived' : ''));
    b.tabIndex = 0; b.setAttribute('role', 'button');
    b.innerHTML = `<span class="st"></span><span class="t"><span class="tt"></span></span><button class="ib sm more" title="${tr('More actions')}">${icon('vmore')}</button>`;
    b.querySelector('.tt').textContent = s.title;
    if (S.selecting) {
      // select mode: a checkbox replaces the status dot, a click toggles instead of opening
      const on = S.selected.has(s.sid);
      b.classList.add('selectable'); b.classList.toggle('sel', on);
      b.querySelector('.st').outerHTML = `<span class="cb${on ? ' on' : ''}">${icon('check')}</span>`;
      const why = S.suggest?.[s.sid]; if (why) b.querySelector('.t').appendChild(el('small', null, why));
      b.querySelector('.more').remove();
      b.onclick = () => toggleSelected(s.sid);
      b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelected(s.sid); } else if (e.key === 'Escape') setSelecting(false); };
      b.title = why ? `${s.title}\n${why}` : s.title;
      return b;
    }
    const nArt = visibleArts().reduce((n, a) => n + (a.sid === s.sid ? 1 : 0), 0);
    if (nArt) { const g = el('span', 'badge art', nArt); g.title = nArt === 1 ? tr('1 file') : tr('{n} files', { n: nArt }); b.querySelector('.more').before(g); }
    b.title = `${s.title}\n${s.status === 'waiting' ? tr('Needs your approval') + ' · ' : s.status === 'running' ? tr('Working…') + ' · ' : ''}${KIND_LABEL[s.kind]}${s.kind === 'chat' ? '' : ' · ' + folderName(s.cwd)} · ${ago(s.when)}`;
    b.querySelector('.st').className = 'st ' + (s.status === 'waiting' ? 'waiting' : s.status === 'running' ? 'running' : s.unread ? 'unread' : s.kind === 'chat' ? '' : 'hollow');
    b.onclick = () => openSession(s);
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSession(s); } else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSession(s); } };
    b.oncontextmenu = (e) => { e.preventDefault(); sessionMenu(e, s); };
    b.querySelector('.more').onclick = (e) => { e.stopPropagation(); sessionMenu(e, s); };
    return b;
  }
  const isActive = (s) => S.view === 'session' && (s.sid === S.sid || (S.info && s.sdkId && s.sdkId === S.info.sdkId));
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const DEL_KEYS = (IS_MAC ? '⌘⇧⌫' : 'Ctrl+Shift+⌫');
  function deleteSession(s) {
    if (!s || !confirm(tr('Delete “{title}”? This cannot be undone.', { title: s.title || tr('this conversation') }))) return;
    send({ type: 'delete', sid: s.sid });
    if (S.sid === s.sid || (S.info && s.sdkId && s.sdkId === S.info.sdkId)) showWelcome();
  }
  // ---- select mode: tick chats in the sidebar and delete them in one go; Claude can pre-tick the throwaway ones
  function setSelecting(on) {
    S.selecting = on; if (!on) { S.selected = new Set(); S.suggest = null; }
    renderList();
  }
  function toggleSelected(sid) { if (S.selected.has(sid)) S.selected.delete(sid); else S.selected.add(sid); renderList(); }
  const selectableSids = () => visibleSessions(space()).map((s) => s.sid);
  function optionsButton() {
    const b = el('button', 'ib sm'); b.title = tr('Options'); b.innerHTML = icon('filter');
    b.onclick = (e) => menu(e, [
      [tr('Refresh'), () => send({ type: 'sessions' })],
      [tr('Select…'), () => setSelecting(true)],
      [space() === 'code' ? tr('Suggest sessions to delete') : tr('Suggest chats to delete'), suggestCleanup],
    ]);
    return b;
  }
  function selectBar() {
    const bar = el('div', 'sel-bar');
    if (S.suggesting) { bar.appendChild(el('span', 'sel-n', space() === 'code' ? tr('Looking for sessions to delete…') : tr('Looking for chats to delete…'))); return bar; }
    const n = S.selected.size, all = selectableSids();
    bar.appendChild(el('span', 'sel-n', S.suggest && n ? tr('{n} suggested', { n }) : tr('{n} selected', { n })));
    const btn = (label, fn, cls) => { const b = el('button', 'sel-btn' + (cls ? ' ' + cls : ''), label); b.onclick = fn; bar.appendChild(b); return b; };
    btn(n === all.length && all.length ? tr('None') : tr('All'), () => { S.selected = n === all.length ? new Set() : new Set(all); renderList(); });
    const del = btn(tr('Delete'), deleteSelected, 'danger'); del.disabled = !n;
    btn(tr('Cancel'), () => setSelecting(false));
    return bar;
  }
  function deleteSelected() {
    const sids = [...S.selected].filter((sid) => S.sessions.some((s) => s.sid === sid));
    if (!sids.length) return;
    const one = S.sessions.find((s) => s.sid === sids[0]);
    const q = sids.length === 1 ? tr('Delete “{title}”? This cannot be undone.', { title: one.title || tr('this conversation') }) : space() === 'code' ? tr('Delete {n} sessions? This cannot be undone.', { n: sids.length }) : tr('Delete {n} chats? This cannot be undone.', { n: sids.length });
    if (!confirm(q)) return;
    send({ type: 'deleteMany', sids });
    if (sids.some((sid) => S.sid === sid || (S.info && S.sessions.find((s) => s.sid === sid)?.sdkId === S.info.sdkId))) showWelcome();
    setSelecting(false);
  }
  function suggestCleanup() {
    if (S.suggesting) return;
    S.suggesting = true; S.selecting = true; S.selected = new Set(); S.suggest = null; renderList();
    send({ type: 'suggestCleanup', space: space() });
  }
  function onCleanupSuggest(m) {
    S.suggesting = false;
    if (m.error) { toast(m.error, true); setSelecting(false); return; }
    const items = (m.items || []).filter((it) => S.sessions.some((s) => s.sid === it.sid));
    if (!items.length) { toast(tr('Nothing worth deleting found')); setSelecting(false); return; }
    S.suggest = Object.fromEntries(items.map((it) => [it.sid, it.why || '']));
    S.selected = new Set(items.map((it) => it.sid)); S.selecting = true;
    renderList();
  }
  function sessionMenu(e, s) {
    menu(e, [
      [tr('Rename'), () => { const t = prompt(tr('New title'), s.title); if (t) send({ type: 'rename', sid: s.sid, title: t }); }],
      [s.pinned ? tr('Unpin') : tr('Pin'), () => send({ type: 'pin', sid: s.sid, value: !s.pinned })],
      [s.archived ? tr('Unarchive') : tr('Archive'), () => send({ type: 'archive', sid: s.sid, value: !s.archived })],
      [tr('Delete'), () => deleteSession(s), 'danger', DEL_KEYS],
    ]);
  }
  const openSession = (s) => send({ type: 'open', sid: s.sid, cwd: s.cwd });

  // --------------------------------------------------------------- views
  function showView(name) {
    S.view = name;
    for (const v of ['Welcome', 'Session', 'Dashboard', 'Projects', 'Artifacts', 'Routines', 'Routine', 'RoutineEdit', 'Customize']) $('view' + v).hidden = name !== v[0].toLowerCase() + v.slice(1);
    if (name !== 'session') { S.sid = null; S.info = null; }
    markNav(); renderList();
  }

  // welcome
  function showWelcome(folder) {
    showView('welcome');
    if (folder) { S.newFolder = folder; if (S.tab === 'chat') setTab('code'); }
    S.newMode = null; S.newModel = null; S.newEffort = null;
    const first = (S.user || '').split(' ')[0];
    const code = S.tab === 'code';
    $('welcomeTitle').textContent = code ? (first ? tr('What\'s up next, {name}?', { name: first }) : tr('What\'s up next?')) : (first ? tr('Welcome, {name}', { name: first }) : tr('Welcome'));
    welcomeComposer.setPlaceholder(code ? tr('Describe a task or ask a question') : tr('How can I help you today?'));
    renderWelcomeChips(); renderSuggest();
    renderNeeds(); renderHomeDash(); refreshHomeDash(true); refreshArtifacts();
    welcomeComposer.focus();
  }
  function renderWelcomeChips() {
    const chat = S.tab === 'chat';
    $('kindSeg').hidden = S.tab === 'code';
    document.querySelectorAll('#kindSeg button').forEach((b) => b.classList.toggle('active', b.dataset.k === S.tab));
    $('projectChip').hidden = chat;
    if (!chat) {
      if (!S.newFolder || !S.projects.some((p) => p.path === S.newFolder)) S.newFolder = S.projects[0]?.path || S.newFolder || '';
      $('projectChipText').textContent = S.newFolder ? baseName(S.newFolder) : tr('Select folder…');
      $('projectChip').title = S.newFolder || '';
    }
    $('modelChipText').textContent = modelLabel(S.newModel ?? S.settings.model ?? '');
    $('effortChipText').textContent = effortShort(S.newEffort ?? S.settings.effort ?? '');
    $('modeChip').hidden = S.tab !== 'code';
    $('modeChipText').textContent = MODE_SHORT[S.newMode || S.settings.mode || 'auto'] || S.newMode || S.settings.mode;
  }
  $('modeChip').onclick = (e) => menu(e, Object.entries(MODE_LABEL).map(([v, l]) => [l, () => { S.newMode = v; renderWelcomeChips(); }]), tr('Permissions'));
  const effortShort = (v) => ({ '': tr('Default'), low: tr('Low'), medium: tr('Medium'), high: tr('High'), xhigh: tr('Very high'), max: tr('Max') }[v] || v);
  const MODEL_DESC = { '': tr('What Claude Code is set to use'), opus: tr('For complex work and everyday tasks'), sonnet: tr('Most efficient for simpler tasks'), haiku: tr('Fastest for quick answers') };
  // One picker like claude.ai: models with a description and a check mark, then Effort › and More models ›.
  function modelMenu(e, current, effort, onPick, onEffort) {
    const custom = store.get('customModel', '');
    const items = MODELS.filter(([v]) => v !== '__custom').map(([v, l]) => ({ label: l, desc: MODEL_DESC[v], check: (current || '') === v, fn: () => onPick(v) }));
    if (current && !['opus', 'sonnet', 'haiku'].includes(current)) items.push({ label: shortModel(current), desc: tr('Custom model ID'), check: true, fn: () => onPick(current) });
    else if (custom) items.push({ label: shortModel(custom), desc: tr('Custom model ID'), check: false, fn: () => onPick(custom) });
    items.push({ sep: true });
    items.push({ label: tr('Effort'), right: effortShort(effort || ''), arrow: true, fn: () => richMenu(e, Object.keys(EFFORT_LABEL).map((v) => ({ label: effortShort(v), check: (effort || '') === v, fn: () => onEffort(v) }))) });
    items.push({ label: tr('More models'), arrow: true, fn: () => { const id = prompt(tr('Model ID (for example an Amazon Bedrock model or inference profile ID):'), custom); if (!id) return; store.set('customModel', id.trim()); onPick(id.trim()); } });
    richMenu(e, items);
  }
  $('projectChip').onclick = (e) => {
    const entries = S.projects.map((p) => [p.name + '  ·  ' + shortPath(p.path), () => { S.newFolder = p.path; renderWelcomeChips(); }]);
    entries.push(null, [tr('Browse for a folder…'), () => pickFolder(S.newFolder || S.home, (p) => { S.newFolder = p; send({ type: 'addProject', path: p }); renderWelcomeChips(); })]);
    menu(e, entries, tr('Project folder'));
  };
  $('kindSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; store.set('chatKind', b.dataset.k); setTab(b.dataset.k); welcomeComposer.focus(); };
  $('modelChip').onclick = (e) => modelMenu(e, S.newModel ?? S.settings.model ?? '', S.newEffort ?? S.settings.effort ?? '', (v) => { S.newModel = v; renderWelcomeChips(); }, (v) => { S.newEffort = v; renderWelcomeChips(); });
  // suggestion chips under the composer, like claude.ai's Write / Learn / …
  const SUGGEST = [['edit', tr('Write'), tr('Help me write ')], ['skill', tr('Learn'), tr('Explain, step by step, ')], ['code', tr('Code'), tr('Write code that ')], ['file', tr('Summarize'), tr('Summarize the attached files: ')], ['dash', tr('Plan'), tr('Help me plan ')]];
  function renderSuggest() {
    const box = $('suggest'); box.innerHTML = '';
    if (S.tab === 'code') return;
    for (const [ic, label, prefix] of SUGGEST) { const b = el('button', 'sbtn'); b.innerHTML = icon(ic); b.appendChild(el('span', null, label)); b.onclick = () => welcomeComposer.setText(prefix); box.appendChild(b); }
  }

  // session
  function openSessionView(info, items, liveText, liveThinking) {
    showView('session');
    S.sid = info.sid; S.info = info;
    if (info.kind !== 'routine' && info.kind !== S.tab) setTab(info.kind);
    clearLog();
    for (const it of items) renderItem(it);
    // Replayed history has no "done" markers: give every finished turn its action bar anyway.
    if (info.status === 'idle') for (const t of log.querySelectorAll('.turn')) { const r = t.querySelector('.reply'); if (r && r.querySelector('.prose')) addTurnFoot(t, r, ''); }
    if (liveThinking) { openThinking(); V.think.querySelector('.tbody').textContent = liveThinking; }
    if (liveText) renderEvent({ type: 'delta', text: liveText });
    openPanel(panelDefault(info.kind));
    renderSessionHead(); renderList(); renderPanel();
    sessionComposer.setBusy(info.status !== 'idle');
    if (info.status !== 'idle') showWorking(info.status === 'waiting' ? tr('Waiting for your approval') : null);
    editing = null; $('editHint').hidden = true; renderQueue(); panesOnSession();
    scrollDown(true); sessionComposer.focus();
    if (pendingFirst) { const m = pendingFirst; pendingFirst = null; send({ type: 'send', sid: info.sid, text: m.text, files: m.files, voice: !!m.voice, lang: m.lang }); }
  }
  function renderSessionHead() {
    const i = S.info; if (!i) return;
    $('sKindIcon').innerHTML = `<use href="#i-${i.kind === 'routine' ? 'clock' : i.kind}"/>`; $('sKindIcon').title = KIND_LABEL[i.kind];
    $('sTitle').textContent = i.title || tr('Untitled');
    // The folder as a chip next to the title (full path on hover); nothing for Chat, which has no folder.
    const p = $('sPath'), showPath = i.kind !== 'chat' && !!i.cwd; p.hidden = !showPath;
    if (showPath) { p.querySelector('span').textContent = i.cwd === S.home ? tr('Home folder') : (i.cwd.split(/[\\/]/).filter(Boolean).pop() || i.cwd); p.title = shortPath(i.cwd); }
    $('sCost').textContent = i.cost ? tr('~${cost} spent', { cost: i.cost.toFixed(i.cost < 0.1 ? 3 : 2) }) : '';
    renderCtx($('sCtx'), i.context); syncUsage();
    $('sModelChip').querySelector('span').textContent = modelLabel(i.model); $('sEffortText').textContent = effortShort(i.effort || '');
    $('sModeChip').querySelector('span').textContent = MODE_SHORT[i.mode] || i.mode; $('sModeChip').hidden = i.kind === 'chat';
    $('sBrowserChip').querySelector('span').textContent = i.browser ? tr('Browser on') : tr('Browser off'); $('sBrowserChip').hidden = i.kind === 'chat';
    $('sConnChip').querySelector('span').textContent = connectorsLabel(i.connectors || []); $('sConnChip').hidden = i.kind !== 'chat';
    syncPaneBtns();
    renderContext();
  }
  function renderContext() {
    const i = S.info; const box = $('contextBody'); if (!i || !box) return; box.innerHTML = '';
    const row = (ic, label, title, fn) => { const b = el(fn ? 'button' : 'div', 'out'); b.innerHTML = `${icon(ic)}<span class="nm"></span>`; b.querySelector('.nm').textContent = label; if (title) b.title = title; if (fn) b.onclick = fn; box.appendChild(b); };
    if (i.kind !== 'chat' && i.cwd) row('folder', i.cwd === S.home ? tr('Home folder') : baseName(i.cwd), shortPath(i.cwd), () => send({ type: 'reveal', path: i.cwd }));
    row(i.kind === 'routine' ? 'clock' : i.kind, KIND_LABEL[i.kind] + (i.kind === 'chat' ? '' : ' · ' + (MODE_SHORT[i.mode] || i.mode)));
    if (V?.used.size) { const u = el('div', 'used'); for (const x of V.used) u.appendChild(el('span', null, x)); box.appendChild(u); }
  }
  function renderCtx(node, ctx) {
    if (!ctx || !ctx.window) { node.hidden = true; return; }
    const pct = Math.min(100, Math.round(ctx.used / ctx.window * 100));
    node.hidden = false; node.className = 'ctx' + (pct > 85 ? ' bad' : pct > 60 ? ' warn' : '');
    node.querySelector('i').style.width = pct + '%'; node.querySelector('.pct').textContent = tr('Context {pct}%', { pct });
    node.title = tr('Context window: {used} of {window} tokens used', { used: fmtK(ctx.used), window: fmtK(ctx.window) }) + (node.id === 'sCtx' ? '\n' + tr('Click to compact the conversation') : '');
  }
  $('sCtx').style.cursor = 'pointer';
  $('sCtx').onclick = () => { if (S.info?.status !== 'idle') return; if (confirm(tr('Compact the conversation now? Older messages are summarized to free up context.'))) send({ type: 'compact', sid: S.sid }); };
  function syncUsage() { /* context and cost live in the header */ }
  // The title is a dropdown like claude.ai: rename, pin, archive, delete.
  $('sTitleBtn').onclick = (e) => { const i = S.info; if (i) sessionMenu(e, { sid: i.sid, sdkId: i.sdkId, title: i.title, pinned: i.pinned, archived: i.archived }); };
  $('sModelChip').onclick = (e) => modelMenu(e, S.info?.model || '', S.info?.effort || '', (v) => send({ type: 'sessionSettings', sid: S.sid, model: v }), (v) => send({ type: 'sessionSettings', sid: S.sid, effort: v }));
  $('sModeChip').onclick = (e) => menu(e, Object.entries(MODE_LABEL).map(([v, l]) => [l, () => send({ type: 'sessionSettings', sid: S.sid, mode: v })]), tr('Permissions'));
  $('sBrowserChip').onclick = () => send({ type: 'sessionSettings', sid: S.sid, browser: !S.info?.browser });
  // Connectors (Gmail, calendar…) a chat may use: a multi-select menu that stays open while toggling; the choice is kept per session.
  let connMenuWanted = false;
  const connShort = (n) => n.replace(/^claude\.ai /, '');
  function connectorsLabel(list) { return !list.length ? tr('No connectors') : list.length <= 2 ? list.map(connShort).join(', ') : tr('{n} connectors', { n: list.length }); }
  $('sConnChip').onclick = () => { connMenuWanted = true; send({ type: 'connectors' }); };
  function connectorMenu(items, defaults) {
    const m = $('menu'); const sel = new Set(S.info?.connectors || []);
    const apply = () => send({ type: 'sessionSettings', sid: S.sid, connectors: [...sel] });
    const draw = () => {
      m.innerHTML = ''; m.classList.add('rich');
      m.appendChild(el('div', 'mh', tr('Connectors')));
      if (!items.length) m.appendChild(el('div', 'mh', tr('No connectors found. Send a message first, then open this menu again.')));
      const row = (label, on, fn, desc) => {
        const b = el('button', 'mi' + (on ? ' on' : ''));
        b.innerHTML = `<span class="mt"><span class="ml"></span>${desc ? '<small class="md"></small>' : ''}</span><span class="mr">${on ? icon('check') : ''}</span>`;
        b.querySelector('.ml').textContent = label; if (desc) b.querySelector('.md').textContent = desc;
        b.onclick = (ev) => { ev.stopPropagation(); fn(); draw(); }; m.appendChild(b);
      };
      for (const c of items) row(connShort(c.name), sel.has(c.name), () => { if (sel.has(c.name)) sel.delete(c.name); else sel.add(c.name); apply(); });
      if (items.length) {
        m.appendChild(el('div', 'sep'));
        row(tr('All'), false, () => { for (const c of items) sel.add(c.name); apply(); });
        row(tr('None'), false, () => { sel.clear(); apply(); });
        row(tr('Default for new chats'), false, () => { send({ type: 'settings', connectors: [...sel] }); toast(tr('Saved as the default for new chats')); }, tr('Currently: {list}', { list: connectorsLabel(defaults) }));
      }
    };
    draw();
    placeMenu({ currentTarget: $('sConnChip') }, m, items.length + 4);
    menuOpening = false;   // the menu opened after a round trip, so the click that asked for it is long gone
  }
  function fillModelSelect(sel, value) {
    sel.innerHTML = ''; const custom = store.get('customModel', '');
    for (const [v, l] of MODELS) { const o = el('option', null, v === '__custom' && custom ? tr('Custom: {id}', { id: custom }) : l); o.value = v; sel.appendChild(o); }
    if (value && !['opus', 'sonnet', 'haiku'].includes(value)) { if (custom !== value) { store.set('customModel', value); sel.options[4].textContent = tr('Custom: {id}', { id: value }); } sel.value = '__custom'; }
    else sel.value = value || '';
  }
  function modelValue(sel) {
    if (sel.value !== '__custom') return sel.value;
    const id = prompt(tr('Model ID (for example an Amazon Bedrock model or inference profile ID):'), store.get('customModel', ''));
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
      case 'user': addUser(it.text, it.files, it.prev, it.paths); break;
      case 'thinking': openThinking(); setThinking(it.text, true); break;
      case 'assistant': addProse(it.text); break;
      case 'tool': { onToolUse(it, true); if (it.subText) onSubText({ id: it.id, subText: it.subText }); if (it.result != null || it.images) onToolResult({ id: it.id, isError: it.isError, content: it.result || '', images: it.images }, true); break; }
      case 'perm': addPermission(it, it.answer); break;
      case 'note': note(it.text, it.err); break;
      case 'done': onDone(it, true); break;
    }
  }
  function renderEvent(ev) {
    switch (ev.type) {
      case 'user': addUser(ev.text, ev.files, ev.prev, ev.paths); showWorking(tr('Thinking')); break;
      case 'thinkingStart': openThinking(); break;
      case 'thinkingDelta': openThinking(); V.think.querySelector('.tbody').textContent += ev.text; break;
      case 'thinking': openThinking(); setThinking(ev.text, true); break;
      case 'delta': if (!V.live) V.live = addProse('', true); V.live.raw += ev.text; renderInto(V.live.el, V.live.raw); scrollDown(); window.Voice?.onDelta(ev.text); break;
      case 'assistantText': if (!V.live) V.live = addProse('', true); V.live.raw = ev.text; renderInto(V.live.el, ev.text, true); V.lastText = ev.text; V.live = null; V.group = null; scrollDown(); window.Voice?.onAssistantText(ev.text); break;
      case 'toolUse': closeLive(); onToolUse(ev); break;
      case 'subText': onSubText({ id: ev.parent, subText: ev.text }); break;
      case 'toolResult': onToolResult(ev); break;
      case 'permission': closeLive(); addPermission(ev, null); break;
      case 'permitted': { const p = log.querySelector(`.perm[data-id="${ev.id}"]`); if (p) markPerm(p, ev.answer); break; }
      case 'note': note(ev.text, ev.err); break;
      case 'done': closeLive(); onDone(ev); window.Voice?.onDone(ev.ok); break;
    }
  }
  function closeLive() { if (V.live && !V.live.raw.trim()) V.live.el.remove(); V.live = null; if (V.think) { V.think.classList.remove('live'); V.think = null; } }
  function ensureReply() {
    if (!V.turn) { V.turn = el('div', 'turn'); V.reply = el('div', 'reply'); V.turn.appendChild(V.reply); log.appendChild(V.turn); V.started = Date.now(); }
    keepWorkingLast();
    return V.reply;
  }
  const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  const isImage = (name) => IMG_EXT.includes((String(name).split('.').pop() || '').toLowerCase());
  // Attachments inside a user bubble: images show inline (click = in-app preview), other files as chips.
  function attachmentsEl(files, paths) {
    const box = el('div', 'atts');
    files.forEach((name, i) => {
      const p = paths?.[i];
      if (isImage(name) && p) {
        const img = el('img', 'att-img'); img.src = fileUrl(p); img.alt = name; img.title = name; img.loading = 'lazy';
        img.onclick = () => openPreview(p); box.appendChild(img);
      } else {
        const c = el('button', 'att-file'); c.innerHTML = icon('file'); c.appendChild(el('span', null, name)); c.title = name;
        if (p) c.onclick = () => openPreview(p); else c.disabled = true;
        box.appendChild(c);
      }
    });
    return box;
  }
  function addUser(text, files, prev, paths) {
    const turn = el('div', 'turn'); turn.dataset.text = text; turn.dataset.prev = prev || '';
    const row = el('div', 'user-row'); const wrap = el('div', 'user-wrap');
    const b = el('div', 'bubble', text);
    if (files?.length) b.appendChild(attachmentsEl(files, paths));
    const acts = el('div', 'acts');
    const mini = (ic, title, fn) => { const x = el('button', 'ib'); x.title = title; x.innerHTML = icon(ic); x.onclick = fn; return x; };
    acts.append(mini('copy', tr('Copy'), () => copyText(text)), mini('retry', tr('Send again from here (branches the conversation)'), () => retryTurn(turn)),
      mini('branch', tr('Branch: new conversation starting before this message'), () => send({ type: 'fork', sid: S.sid, upTo: turn.dataset.prev || null, draft: stripAttachLine(text) })),
      mini('edit', tr('Edit and resend'), () => editTurn(turn)));
    wrap.append(b, acts); row.appendChild(wrap); turn.appendChild(row);
    const reply = el('div', 'reply'); turn.appendChild(reply);
    log.appendChild(turn); V.turn = turn; V.reply = reply; V.group = null; V.think = null; V.live = null; V.started = Date.now();
    if (S.info && !S.info.title) { S.info.title = text.split('\n')[0].slice(0, 80); $('sTitle').textContent = S.info.title; }
    keepWorkingLast(); scrollDown(true);
  }
  function addProse(text, live) {
    const d = el('div', 'prose'); renderInto(d, text, !live); ensureReply().appendChild(d); V.group = null;
    if (!live) V.lastText = text;
    return { el: d, raw: text };
  }
  function openThinking() {
    if (V.think) return V.think;
    const d = el('details', 'think live'); d.innerHTML = '<summary>' + tr('Thinking…') + '</summary><div class="tbody"></div>';
    ensureReply().appendChild(d); V.think = d; return d;
  }
  function setThinking(text, final) { const d = openThinking(); d.querySelector('.tbody').textContent = text; if (final) { d.classList.remove('live'); d.querySelector('summary').textContent = tr('Thought for a moment'); V.think = null; } }
  function note(text, err) {
    const d = el('div', 'note' + (err ? ' err' : ''), text);
    if (err) { const b = el('button', 'btn', tr('Report this')); b.onclick = () => openReport({ kind: 'bug', title: text.split('\n')[0].slice(0, 120), primary: text }); d.appendChild(b); }
    (V.reply || log).appendChild(d); keepWorkingLast(); scrollDown();
  }
  // working indicator (spinner + what Claude is doing right now)
  let workTimer = null;
  // A floating pill at the top of the chat (the conversation keeps updating underneath), not a row at the bottom.
  function showWorking(label) {
    if (!V) return;
    const bar = $('workingBar');
    if (!V.working) {
      V.working = bar; bar.innerHTML = '<div class="working bar"><span class="wstar" aria-hidden="true">' + icon('star') + '</span><span class="lbl"></span><span class="t"></span></div>'; bar.hidden = false;
      V.workStart = Date.now(); clearInterval(workTimer);
      workTimer = setInterval(() => { if (V?.working) V.working.querySelector('.t').textContent = fmtDur(Math.round((Date.now() - V.workStart) / 1000)); }, 1000);
    }
    if (label) V.current = label;
    V.working.querySelector('.lbl').textContent = V.current || tr('Working');
    renderPanelLight();
  }
  function hideWorking() { if (V?.working) { V.working.hidden = true; V.working = null; clearInterval(workTimer); renderPanelLight(); } }
  function keepWorkingLast() { /* the indicator floats above the log; nothing to move */ }

  // steps (tool calls): compact groups in the chat, full detail in the panel
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  function describe(name, input = {}) {
    const i = input || {};
    if (name.startsWith('mcp__browser__')) {
      const a = name.slice(14).replace(/^browser_/, '');
      const map = { navigate: tr('Opened {x}', { x: i.url || tr('a page') }), click: tr('Clicked {x}', { x: i.element || tr('on the page') }), type: tr('Typed in {x}', { x: i.element || tr('a field') }), snapshot: tr('Looked at the page'), take_screenshot: tr('Took a screenshot'), fill_form: tr('Filled in a form'), select_option: tr('Chose an option'), press_key: tr('Pressed {x}', { x: i.key || tr('a key') }), navigate_back: tr('Went back'), close: tr('Closed the browser'), wait_for: tr('Waited for the page'), tabs: tr('Switched tabs'), hover: tr('Hovered {x}', { x: i.element || '' }) };
      return { label: map[a] || tr('Browser: {x}', { x: a.replace(/_/g, ' ') }), kind: 'browser', cat: tr('Browser') };
    }
    if (name.startsWith('mcp__')) { const [, srv, t] = name.split('__'); return { label: `${srv}: ${(t || '').replace(/_/g, ' ')}`, kind: 'other', cat: srv }; }
    switch (name) {
      case 'Read': return { label: tr('Read {x}', { x: base(i.file_path) }), kind: 'read', cat: tr('Files') };
      case 'Write': return { label: tr('Created {x}', { x: base(i.file_path) }), kind: 'created', cat: tr('Files'), file: i.file_path, action: tr('Created') };
      case 'Edit': case 'MultiEdit': return { label: tr('Edited {x}', { x: base(i.file_path) }), kind: 'edited', cat: tr('Files'), file: i.file_path, action: tr('Edited') };
      case 'NotebookEdit': return { label: tr('Edited {x}', { x: base(i.notebook_path) }), kind: 'edited', cat: tr('Files'), file: i.notebook_path, action: tr('Edited') };
      case 'Bash': case 'PowerShell': return { label: tr('Ran {x}', { x: i.description || String(i.command || '').slice(0, 80) }), kind: 'command', cat: tr('Terminal') };
      case 'BashOutput': case 'Monitor': return { label: tr('Checked a running command'), kind: 'command', cat: tr('Terminal') };
      case 'Glob': return { label: tr('Found files matching {x}', { x: i.pattern || '' }), kind: 'search', cat: tr('Files') };
      case 'Grep': return { label: tr('Searched for "{x}"', { x: i.pattern || '' }), kind: 'search', cat: tr('Files') };
      case 'LS': return { label: tr('Listed {x}', { x: base(i.path) }), kind: 'search', cat: tr('Files') };
      case 'WebSearch': return { label: tr('Searched the web for {x}', { x: i.query || '' }), kind: 'web', cat: tr('Web') };
      case 'WebFetch': { let h = i.url || ''; try { h = new URL(i.url).hostname; } catch { /* keep */ } return { label: tr('Read {x}', { x: h }), kind: 'web', cat: tr('Web') }; }
      case 'Task': case 'Agent': return { label: tr('Helper agent: {x}', { x: i.description || i.subagent_type || tr('working') }), kind: 'agent', cat: tr('Helper agents') };
      case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return { label: tr('Updated the plan'), kind: 'plan', cat: tr('Plan') };
      case 'AskUserQuestion': return { label: tr('Asked you a question'), kind: 'other', cat: tr('Questions') };
      case 'Skill': return { label: tr('Used the {x} skill', { x: i.skill || i.command || '' }), kind: 'other', cat: tr('Skills') };
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
    const w = (k, one, many) => { if (n[k]) parts.push(n[k] === 1 ? tr(one) : tr(many, { n: n[k] })); };
    w('read', 'Read 1 file', 'Read {n} files'); w('search', 'Searched files', 'Searched files'); w('edited', 'Edited 1 file', 'Edited {n} files'); w('created', 'Created 1 file', 'Created {n} files');
    w('command', 'Ran 1 command', 'Ran {n} commands'); w('browser', 'Used the browser', 'Used the browser'); w('web', 'Looked online', 'Looked online'); w('agent', 'Used a helper agent', 'Used {n} helper agents'); w('plan', 'Updated the plan', 'Updated the plan'); w('other', 'Used 1 tool', 'Used {n} tools');
    const running = g.items.some((s) => s.status === 'running' || s.status === 'waiting');
    g.el.classList.toggle('running', running);
    g.el.querySelector('.txt').textContent = (running ? tr('Working: ') : '') + (parts.join(' · ') || tr('Working…'));
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
    if (!replay) showWorking(s.parent ? (V.steps.get(s.parent)?.label || tr('Helper agent')) + ' › ' + d.label : d.label);
    if (!replay && d.kind === 'browser') paneAutoOpen('browser');
    updatePlan(m.name, m.input, null);
    if (d.file) V.files.set(d.file, { action: V.files.get(d.file)?.action === tr('Created') ? tr('Created') : d.action });
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
    if (m.images?.length) {
      s.images = m.images;
      if (s.name === 'Read' && s.input?.file_path) { V.files.set(s.input.file_path, { action: tr('Image') }); } else for (const p of m.images) V.files.set(p, { action: s.kind === 'browser' ? tr('Screenshot') : tr('Image') });
      const last = m.images[m.images.length - 1];
      showBrowserFrame(fileUrl(last) + '&v=' + Date.now(), s.label, true);
      if (s.row && !s.row.nextElementSibling?.classList.contains('shots')) { const strip = el('div', 'shots'); for (const p of m.images) { const im = el('img'); im.src = fileUrl(p); im.title = base(p); im.onclick = (e) => { e.stopPropagation(); openPreview(p); }; strip.appendChild(im); } s.row.after(strip); }
    }
    if (s.row) s.row.className = 'step ' + s.status + (s.parent ? ' sub' : '');
    if (!m.isError && s.name === 'Write' && /\.(html?|svg)$/i.test(s.input?.file_path || '') && s.row) inlinePage(s);
    if (V.group) refreshGroup(V.group);
    updatePlan(s.name, s.input, m.content);
    updateActRow(s);
    if (s.file && F.active === s.file && paneState.files) openFile(s.file);
    if (!replay && !s.parent) showWorking(tr('Thinking'));
    renderPanelLight();
  }
  // A page Claude writes (HTML / SVG) shows right in the conversation, like a claude.ai artifact; hover for full screen.
  function inlinePage(s) {
    const p = s.input.file_path, anchor = s.row.closest('.steps') || s.row;
    if (anchor.parentNode.querySelector(`.inline-page[data-path="${CSS.escape(p)}"]`)) { anchor.parentNode.querySelector(`.inline-page[data-path="${CSS.escape(p)}"] iframe`).src = fileUrl(p) + '&v=' + Date.now(); return; }
    const box = el('div', 'inline-page'); box.dataset.path = p;
    box.innerHTML = `<div class="ip-bar"><span class="ip-name"></span><span class="spacer"></span><button class="ib sm ip-full" title="${tr('Full screen')}">${icon('expand') || '⤢'}</button></div>`;
    box.querySelector('.ip-name').textContent = base(p);
    const f = el('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups'); f.src = fileUrl(p) + '&v=' + Date.now(); f.loading = 'lazy'; box.appendChild(f);
    box.querySelector('.ip-full').onclick = (e) => { e.stopPropagation(); if (document.fullscreenElement) document.exitFullscreen(); else box.requestFullscreen?.(); };
    anchor.after(box); if (V.group?.el === anchor || anchor.classList.contains('steps')) V.group = null;   // later steps start a new group under the page
  }
  function updatePlan(name, input, result) {
    if (name === 'TodoWrite' && Array.isArray(input?.todos) && result === null) V.todos = input.todos.map((t) => ({ content: t.content || t.subject || '', status: t.status || 'pending', active: t.activeForm }));
    else if (name === 'TaskCreate' && result) { const id = (String(result).match(/#\s*(\w+)/) || [])[1] || String(V.tasks.size + 1); const t = { content: input?.subject || input?.description || tr('Task'), status: 'pending', active: input?.activeForm }; V.tasks.set(id, t); V.todos.push(t); }
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
    if (d.kind === 'command') return tr('Allow Claude to run this command?') + (i?.description ? ' (' + i.description + ')' : '');
    if (d.kind === 'created') return tr('Allow Claude to create {x}?', { x: base(d.file) });
    if (d.kind === 'edited') return tr('Allow Claude to edit {x}?', { x: base(d.file) });
    if (d.kind === 'browser') return tr('Allow Claude to use the browser? ') + d.label;
    if (d.kind === 'web') return tr('Allow Claude to go online? ') + d.label;
    if (d.kind === 'agent') return tr('Allow Claude to start a helper agent?');
    return tr('Allow Claude to use {x}?', { x: tool.replace(/^mcp__/, '').replace(/__/g, ': ').replace(/_/g, ' ') });
  }
  function addPermission(p, answer) {
    const d = describe(p.tool, p.input);
    const s = [...V.steps.values()].reverse().find((x) => x.name === p.tool && x.status === 'running');
    if (s && !answer) { s.status = 'waiting'; if (s.row) s.row.className = 'step waiting'; updateActRow(s); if (V.group) refreshGroup(V.group); }
    const card = el('div', 'perm'); card.dataset.id = p.id; card.dataset.label = d.label;
    const q = el('div', 'q', askText(p.tool, p.input, d));
    const pre = el('pre', null, formatInput(p.tool, p.input));
    const btns = el('div', 'btns');
    const mk = (label, cls, allow, always) => { const b = el('button', 'btn ' + cls, label); b.onclick = () => { send({ type: 'permit', sid: S.sid, id: p.id, tool: p.tool, allow, always }); markPerm(card, allow ? 'allow' : 'deny', always); if (s) { s.status = allow ? 'running' : 'error'; if (s.row) s.row.className = 'step ' + s.status; updateActRow(s); } showWorking(allow ? d.label : tr('Continuing')); }; return b; };
    btns.append(mk(tr('Allow'), 'dark', true, false), ...(p.noAlways ? [] : [mk(p.tool.startsWith('mcp__browser__') ? tr('Allow all browser actions') : tr('Always allow in this chat'), '', true, true)]), mk(tr('Refuse'), '', false, false));
    card.append(q, pre, btns); ensureReply().appendChild(card); V.group = null;
    if (answer) markPerm(card, answer); else showWorking(tr('Waiting for your approval'));
    scrollDown(true);
  }
  function markPerm(card, answer, always) {
    card.classList.add('answered'); card.querySelectorAll('button').forEach((x) => (x.disabled = true));
    card.querySelector('.q').textContent = (answer === 'allow' ? (always ? tr('Allowed for this chat: ') : tr('Allowed: ')) : tr('Refused: ')) + (card.dataset.label || '');
  }
  function onDone(m, replay) {
    hideWorking();
    if (!m.ok && m.message && m.message !== 'error_during_execution') note(m.message, true);
    if (!V.turn) return;
    const secs = m.ms ? Math.round(m.ms / 1000) : (!replay && V.started ? Math.round((Date.now() - V.started) / 1000) : 0);
    addTurnFoot(V.turn, V.reply, [secs ? fmtDur(secs) : '', m.cost != null ? '$' + m.cost.toFixed(m.cost < 0.1 ? 3 : 2) : '', m.model ? shortModel(m.model) : ''].filter(Boolean).join(' · '));
    if (m.context && S.info) { S.info.context = m.context; renderCtx($('sCtx'), m.context); }
    if (!replay && m.cost && S.info) { S.info.cost = (S.info.cost || 0) + m.cost; $('sCost').textContent = tr('~${cost} spent', { cost: S.info.cost.toFixed(S.info.cost < 0.1 ? 3 : 2) }); }
    if (m.context || m.cost) syncUsage();
    if (!replay && HF.on) { const c = activeComposer(); c.listen && (V.lastText ? speak(V.lastText, () => { if (HF.on) c.listen(); }) : c.listen()); }
    else if (!replay && store.get('speak', false) && V.lastText) speak(V.lastText);
    V.group = null; V.turn = null; V.reply = null;
    renderPanelLight();
  }
  // Action bar under a reply (copy, retry, read aloud, thumbs), like claude.ai. Also added to replayed turns that have no "done" marker.
  function addTurnFoot(turn, reply, meta) {
    if (!turn || !reply || turn.querySelector('.turn-foot')) return;
    {
      const foot = el('div', 'turn-foot');
      const mini = (ic, title, fn) => { const b = el('button', 'ib'); b.title = title; b.innerHTML = icon(ic); b.onclick = fn; return b; };
      foot.append(mini('copy', tr('Copy reply'), () => copyText(collectReply(turn))), mini('retry', tr('Retry'), () => retryTurn(turn)));
      if (window.speechSynthesis) foot.append(mini('speaker', tr('Read aloud'), () => speak(collectReply(turn))));
      const up = mini('thumbup', tr('Good answer'), () => { up.classList.toggle('on'); down.classList.remove('on'); if (up.classList.contains('on')) toast(tr('Thanks for the feedback.')); });
      const down = mini('thumbdown', tr('Bad answer'), () => { down.classList.toggle('on'); up.classList.remove('on'); if (down.classList.contains('on')) openReport({ kind: 'bug', title: tr('Bad answer in "{title}"', { title: S.info?.title || '' }), primary: tr('The answer was not good:') + '\n\n' + collectReply(turn).slice(0, 1500) }); });
      foot.append(up, down);
      if (meta) foot.appendChild(el('span', 'meta', meta));
      reply.appendChild(foot);
    }
  }
  const collectReply = (turn) => [...turn.querySelectorAll('.reply > .prose')].map((p) => p.dataset.raw || p.innerText).join('\n\n');
  const stripAttachLine = (t) => t.replace(/\n?📎[^\n]*$/, '').trim();
  function editTurn(turn) {
    if (S.info?.status !== 'idle') { toast(tr('Wait for Claude to finish, or stop it first.')); return; }
    const row = turn.querySelector('.user-row'); if (row.querySelector('.edit-box')) return;
    const box = el('div', 'edit-box'); const ta = el('textarea'); ta.value = stripAttachLine(turn.dataset.text);
    const r = el('div', 'row'); const cancel = el('button', 'btn', tr('Cancel')); const save = el('button', 'btn dark', tr('Send')); r.append(cancel, save); box.append(ta, r);
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
  function renderPanel() { $('acts').innerHTML = ''; if (V) for (const s of V.steps.values()) addActRow(s); if (!V || !V.steps.size) $('acts').innerHTML = '<div class="empty-note">' + tr('Each action Claude takes appears here as it happens.') + '</div>'; renderPanelLight(); }
  function renderPanelLight() {
    if (!V) return;
    const pb = $('progressBody'); pb.innerHTML = '';
    if (V.todos.length) {
      const ul = el('ul', 'todos');
      for (const t of V.todos) ul.appendChild(el('li', 'todo ' + t.status, t.status === 'in_progress' && t.active ? t.active : t.content));
      pb.appendChild(ul);
      const doneN = V.todos.filter((t) => t.status === 'completed').length; const cur = V.todos.findIndex((t) => t.status === 'in_progress');
      $('progressLabel').textContent = doneN === V.todos.length ? tr('{done} of {total} done', { done: doneN, total: V.todos.length }) : tr('step {n} of {total}', { n: (cur >= 0 ? cur : doneN) + 1, total: V.todos.length });
    } else { pb.appendChild(el('div', 'empty-note', V.working ? (V.current || tr('Working')) + '…' : tr('When a task has several steps, Claude\'s plan shows up here.'))); $('progressLabel').textContent = ''; }
    const out = $('outputs'); out.innerHTML = '';
    const files = [...V.files.entries()]; $('outCount').textContent = files.length || '';
    if (!files.length) out.appendChild(el('div', 'empty-note', tr('Files Claude creates or changes appear here.')));
    for (const [p, f] of files) { const b = el('button', 'out'); b.title = p; b.innerHTML = `${icon('file')}<span class="nm"></span><span class="tag"></span>`; b.querySelector('.nm').textContent = base(p); b.querySelector('.tag').textContent = f.action || ''; b.onclick = () => openPreview(p); out.appendChild(b); }
    $('stepCount').textContent = V.stepCount || '';
    renderContext();
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
    if (s.output != null && !row.querySelector(':scope > .detail > .out-pre')) row.querySelector('.detail').appendChild(el('pre', 'out-pre', s.output || tr('(no output)')));
    if (s.images?.length && !row.querySelector(':scope > .detail > img')) for (const p of s.images) { const im = el('img'); im.src = fileUrl(p); im.onclick = () => openPreview(p); row.querySelector('.detail').appendChild(im); }
  }

  // ------------------------------------------------------------- panes: Browser, Files, Terminal, Progress
  // Stacked on the right of the chat; each can be closed, put full screen and resized (drag the handles between
  // them, or the left edge of the column). Which ones are open is remembered per browser.
  // 'voice' has no header button and is never remembered: voice.js opens and closes it.
  const PANES = ['voice', 'browser', 'files', 'term', 'progress'];
  const PANE_EL = { voice: 'voiceView', browser: 'paneBrowser', files: 'paneFiles', term: 'paneTerm', progress: 'paneProgress' };
  const PANE_BTN = { browser: 'browserBtn', files: 'filesBtn', term: 'termBtn', progress: 'panelBtn' };
  const paneState = Object.assign({ browser: false, files: false, term: false, progress: true }, store.get('panes', {}), { voice: false });
  let fullPane = null;
  function layoutPanes() {
    document.body.classList.toggle('panel-open', PANES.some((n) => paneState[n]));
    store.set('panes', { ...paneState, voice: undefined });
    for (const n of PANES) { $(PANE_EL[n]).hidden = !paneState[n]; $(PANE_BTN[n])?.classList.toggle('on', paneState[n]); }
    let before = false;
    for (const c of $('panel').children) {
      if (c.classList.contains('pane')) { before = before || !c.hidden; continue; }
      if (c.classList.contains('pane-gap')) { const next = c.nextElementSibling; c.hidden = !(before && next && !next.hidden); }
    }
  }
  function togglePane(n, v) {
    v = v == null ? !paneState[n] : !!v; if (paneState[n] === v) return;
    paneState[n] = v; if (!v && fullPane === n) setFull(n, false);
    layoutPanes(); if (v) paneShown(n); else paneHidden(n);
  }
  function openPanel(v, user) { togglePane('progress', v); if (user && S.info) store.set('panel.' + S.info.kind, !!v); }
  function panelDefault(kind) { return store.get('panel.' + kind, kind !== 'chat'); }
  function setFull(n, v) {
    const p = $(PANE_EL[n]); v = v == null ? !p.classList.contains('full') : v;
    for (const m of PANES) $(PANE_EL[m]).classList.remove('full');
    if (v) p.classList.add('full'); fullPane = v ? n : null;
    p.querySelector('.pane-full use').setAttribute('href', v ? '#i-shrink' : '#i-expand'); p.querySelector('.pane-full').title = v ? tr('Exit full screen') : tr('Full screen');
  }
  for (const n of PANES) {
    const p = $(PANE_EL[n]);
    p.querySelector('.pane-close').onclick = () => togglePane(n, false);
    p.querySelector('.pane-full').onclick = () => setFull(n);
    if (PANE_BTN[n]) $(PANE_BTN[n]).onclick = () => (n === 'progress' ? openPanel(!paneState.progress, true) : togglePane(n));
  }
  // resize: the column width (left edge) and the pane heights (handles between panes)
  const PANEL_MIN = 300;
  const setPanelW = (w) => document.documentElement.style.setProperty('--panel-w', Math.max(PANEL_MIN, Math.min(window.innerWidth * 0.75, w)) + 'px');
  { const saved = store.get('panelW', 0); if (saved) setPanelW(saved); }
  $('panelResize').onpointerdown = (e) => {
    e.preventDefault(); const x0 = e.clientX, w0 = $('panel').getBoundingClientRect().width; document.body.classList.add('resizing');
    const move = (ev) => setPanelW(w0 - (ev.clientX - x0));
    const up = (ev) => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); store.set('panelW', Math.round(Math.max(PANEL_MIN, w0 - (ev.clientX - x0)))); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  };
  for (const gap of document.querySelectorAll('#panel .pane-gap')) gap.onpointerdown = (e) => {
    e.preventDefault();
    let above = gap.previousElementSibling; while (above && (above.hidden || !above.classList.contains('pane'))) above = above.previousElementSibling;
    let below = gap.nextElementSibling; while (below && (below.hidden || !below.classList.contains('pane'))) below = below.nextElementSibling;
    if (!above || !below) return;
    const y0 = e.clientY, hA = above.getBoundingClientRect().height, hB = below.getBoundingClientRect().height, total = hA + hB;
    const unit = total / ((parseFloat(above.style.flexGrow) || 1) + (parseFloat(below.style.flexGrow) || 1));
    document.body.classList.add('resizing-y'); gap.classList.add('active');
    const move = (ev) => { const a = Math.max(110, Math.min(total - 110, hA + ev.clientY - y0)); above.style.flexGrow = a / unit; below.style.flexGrow = (total - a) / unit; };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('resizing-y'); gap.classList.remove('active'); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  };
  function paneShown(n) {
    if (n === 'browser') { send({ type: 'browserWatch', on: true, lazy: true }); requestLaunchList(); }
    if (n === 'files') filesInit();
    if (n === 'term') termInit();
    if (n === 'progress') renderPanel();
  }
  function paneHidden(n) { if (n === 'browser') send({ type: 'browserWatch', on: false }); if (n === 'voice') window.Voice?.close(); }
  function paneAutoOpen(n) { if (!paneState[n] && !paneUserClosed[n]) togglePane(n, true); }
  const paneUserClosed = {}; const workPanes = {};
  for (const n of PANES) $(PANE_EL[n]).querySelector('.pane-close').addEventListener('click', () => { paneUserClosed[n] = true; });
  function syncPaneBtns() { for (const n of PANES) $(PANE_BTN[n])?.classList.toggle('on', paneState[n]); }
  // a new session was opened in the view: reset per-session content
  function panesOnSession() {
    for (const n of PANES) paneUserClosed[n] = false;
    const kind = S.info?.kind || 'code';
    paneState.progress = panelDefault(kind);
    // A Chat has no folder, so no Browser, Files or Terminal pane (claude.ai shows none); they come back on the next Cowork or Code session.
    if (kind === 'chat') { for (const n of ['browser', 'files', 'term']) { if (paneState[n]) workPanes[n] = true; paneState[n] = false; } }
    else { for (const n of ['browser', 'files', 'term']) if (workPanes[n]) { paneState[n] = true; workPanes[n] = false; } }
    clearBrowserFrame(); B.tabs = []; B.page = null; renderTabs(); $('bUrl').value = ''; L.items = []; renderLaunch(); $('bLogs').hidden = true;
    filesReset(); termReset();
    layoutPanes();
    if (paneState.browser) { send({ type: 'browserWatch', on: true, lazy: true }); requestLaunchList(); }
    if (paneState.files) filesInit();
    if (paneState.term) termInit();
  }
  function syncPanes() { /* session settings changed (browser on/off): nothing to force */ }

  // ---- Browser pane: Chrome's tabs and pages, streamed from the server; clicks, keys and the address bar go back to it
  const B = { tabs: [], active: null, page: null, live: false, following: true, w: 0, h: 0, src: '', shot: false, interact: true, lastFrameAt: 0 };
  const isBlankUrl = (u) => !u || /^about:blank/.test(u);
  function clearBrowserFrame() { $('bBody').classList.remove('has'); $('browserImg').src = ''; B.src = ''; B.shot = false; }
  function browserState(m) {
    B.live = !!m.live; B.tabs = m.tabs || []; B.active = m.active || null; B.page = m.page || null; B.following = m.following !== false;
    const blank = !B.page || isBlankUrl(B.page.url);
    if (m.frame && !blank) showBrowserFrame('data:image/jpeg;base64,' + m.frame, B.page?.title);
    else if (blank && !B.shot) clearBrowserFrame();
    renderTabs(); renderUrl(); renderHint();
    $('bFollow').classList.toggle('on', B.following); $('bFollow').hidden = !B.live;
    for (const id of ['bBack', 'bFwd', 'bReload']) $(id).disabled = !B.live || blank;
  }
  function browserFrame(m) {
    if (isBlankUrl(m.url)) { if (!B.shot) clearBrowserFrame(); return; }
    B.w = m.w || B.w; B.h = m.h || B.h; B.lastFrameAt = Date.now(); B.shot = false;
    showBrowserFrame('data:image/jpeg;base64,' + m.data, m.title || m.url);
  }
  function showBrowserFrame(src, title, isShot) {
    if (isShot) { if (Date.now() - B.lastFrameAt < 5000) return; paneAutoOpen('browser'); B.shot = true; }
    B.src = src; $('browserImg').src = src; $('bBody').classList.add('has');
  }
  function renderTabs() {
    const box = $('btabs'); box.innerHTML = '';
    for (const t of B.tabs) {
      const b = el('button', 'btab' + (t.id === B.active ? ' active' : '')); b.title = t.url || '';
      const nm = el('span', 'nm', isBlankUrl(t.url) ? tr('New tab') : (t.title || hostOf(t.url)));
      if (/^https?:/.test(t.favicon || '')) { const im = el('img'); im.src = t.favicon; im.alt = ''; im.onerror = () => im.remove(); b.appendChild(im); }
      const x = el('span', 'x'); x.innerHTML = icon('close'); x.title = tr('Close tab'); x.onclick = (e) => { e.stopPropagation(); send({ type: 'browserAction', action: 'closeTab', id: t.id }); };
      b.append(nm, x); b.onclick = () => send({ type: 'browserAction', action: 'selectTab', id: t.id });
      box.appendChild(b);
    }
    if (!B.tabs.length) box.appendChild(el('span', 'btab active', tr('New tab')));
  }
  const hostOf = (u) => { try { return new URL(u).host || u; } catch { return u || ''; } };
  function renderUrl() { const inp = $('bUrl'); if (document.activeElement === inp) return; inp.value = B.page && !isBlankUrl(B.page.url) ? B.page.url : ''; }
  function renderHint() {
    const h = $('bHint');
    if (!B.live) h.innerHTML = tr('Enter a URL or run a server: the browser opens here.<br>Claude uses this same browser when it browses the web.');
    else if (L.items.length) h.innerHTML = tr('Run a server to preview your app, or enter a URL.<br>Edit this list in <code>.claude/launch.json</code>.');
    else h.innerHTML = tr('Enter a URL above, or add dev servers to <code>.claude/launch.json</code> to start them from here.');
  }
  $('bUrl').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const u = $('bUrl').value.trim(); if (u) { send({ type: 'browserAction', action: 'navigate', url: u }); $('bUrl').blur(); $('bBody').focus(); } } if (e.key === 'Escape') { renderUrl(); $('bUrl').blur(); } };
  $('bUrl').onfocus = () => $('bUrl').select();
  $('bBack').onclick = () => send({ type: 'browserAction', action: 'back' });
  $('bFwd').onclick = () => send({ type: 'browserAction', action: 'forward' });
  $('bReload').onclick = () => send({ type: 'browserAction', action: 'reload' });
  $('btabNew').onclick = () => { send({ type: 'browserAction', action: 'newTab' }); setTimeout(() => $('bUrl').focus(), 300); };
  $('bFollow').onclick = () => send({ type: 'browserAction', action: 'follow' });
  $('bPointer').onclick = () => { B.interact = !B.interact; $('bPointer').classList.toggle('on', B.interact); $('bBody').classList.toggle('interact', B.interact); };
  $('bBody').classList.add('interact');
  $('paneBrowser').querySelector('.pane-more').onclick = (e) => {
    const url = B.page?.url; const entries = [];
    if (url && !isBlankUrl(url)) entries.push([tr('Open in your own browser'), () => send({ type: 'openUrl', url })], [tr('Copy address'), () => copyText(url)]);
    entries.push([tr('Save a screenshot'), () => { if (!B.src) return toast(tr('No page to capture.')); const a = document.createElement('a'); a.href = B.src; a.download = 'screenshot.jpg'; a.click(); }]);
    for (const it of L.items) if (it.status === 'running' || it.status === 'starting') entries.push([tr('Logs of {name}', { name: it.name }), () => showLogs(it.name)], [tr('Stop {name}', { name: it.name }), () => send({ type: 'launchStop', sid: S.sid, name: it.name })]);
    menu(e, entries, tr('Browser'));
  };
  // input relay: coordinates in CSS pixels of the streamed page
  const pos = (e) => { const r = $('browserImg').getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) / r.width * (B.w || r.width)), y: Math.round((e.clientY - r.top) / r.height * (B.h || r.height)) }; };
  const mods = (e) => ({ alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
  const canInteract = () => B.interact && B.live && $('bBody').classList.contains('has') && !B.shot;
  let lastMove = 0;
  const img = $('browserImg');
  img.addEventListener('pointerdown', (e) => { if (!canInteract()) return; e.preventDefault(); $('bBody').focus(); send({ type: 'browserInput', kind: 'mouse', event: 'mousePressed', ...pos(e), button: e.button, buttons: e.buttons, clicks: e.detail || 1, ...mods(e) }); });
  img.addEventListener('pointerup', (e) => { if (!canInteract()) return; e.preventDefault(); send({ type: 'browserInput', kind: 'mouse', event: 'mouseReleased', ...pos(e), button: e.button, buttons: e.buttons, clicks: e.detail || 1, ...mods(e) }); });
  img.addEventListener('pointermove', (e) => { if (!canInteract()) return; const now = Date.now(); if (now - lastMove < 40 && !e.buttons) return; lastMove = now; send({ type: 'browserInput', kind: 'mouse', event: 'mouseMoved', ...pos(e), button: e.buttons & 1 ? 0 : e.buttons & 2 ? 2 : -1, buttons: e.buttons, ...mods(e) }); });
  img.addEventListener('contextmenu', (e) => { if (canInteract()) e.preventDefault(); });
  img.addEventListener('wheel', (e) => { if (!canInteract()) return; e.preventDefault(); send({ type: 'browserInput', kind: 'wheel', ...pos(e), dx: Math.round(e.deltaX), dy: Math.round(e.deltaY), ...mods(e) }); }, { passive: false });
  const KEEP = new Set(['r', 'l', 'w', 't', 'n', 'q', 'k', '.', 'Tab']); // app shortcuts that stay with this window
  $('bBody').addEventListener('keydown', (e) => {
    if (!canInteract()) return; if ((e.metaKey || e.ctrlKey) && KEEP.has(e.key)) return;
    e.preventDefault(); send({ type: 'browserInput', kind: 'key', event: 'keydown', key: e.key, code: e.code, keyCode: e.keyCode, repeat: e.repeat, ...mods(e) });
  });
  $('bBody').addEventListener('keyup', (e) => { if (!canInteract()) return; if ((e.metaKey || e.ctrlKey) && KEEP.has(e.key)) return; e.preventDefault(); send({ type: 'browserInput', kind: 'key', event: 'keyup', key: e.key, code: e.code, keyCode: e.keyCode, ...mods(e) }); });
  $('bBody').addEventListener('paste', (e) => { if (!canInteract()) return; const t = e.clipboardData?.getData('text'); if (t) { e.preventDefault(); send({ type: 'browserInput', kind: 'text', text: t }); } });
  // dev servers from .claude/launch.json
  const L = { items: [], cwd: '' };
  function requestLaunchList() { if (S.sid && S.info?.kind !== 'chat') send({ type: 'launchList', sid: S.sid }); }
  function onLaunchList(m) { if (m.cwd !== S.info?.cwd) return; L.items = m.items || []; L.cwd = m.cwd; renderLaunch(); renderHint(); }
  function renderLaunch() {
    const box = $('launchList'); box.innerHTML = '';
    for (const it of L.items) {
      const row = el('div', 'launch-row ' + (it.status || 'stopped')); row.innerHTML = `${icon('server')}<span class="nm"></span><span class="port"></span><button class="lb"></button>`;
      row.querySelector('.nm').textContent = it.name; row.title = it.command || it.url || '';
      row.querySelector('.port').textContent = it.status === 'running' && it.livePort ? ':' + it.livePort : it.port ? ':' + it.port : (it.url ? hostOf(it.url) : '');
      const b = row.querySelector('.lb');
      if (it.status === 'starting') { b.innerHTML = '<span class="spin"></span>'; b.title = tr('Starting… (click to stop)'); }
      else if (it.status === 'running') { b.innerHTML = icon('square'); b.title = tr('Stop'); }
      else { b.innerHTML = icon('play'); b.title = tr('Run and open in the browser'); }
      b.onclick = (e) => { e.stopPropagation(); if (it.status === 'running' || it.status === 'starting') send({ type: 'launchStop', sid: S.sid, name: it.name }); else { send({ type: 'launchStart', sid: S.sid, name: it.name }); send({ type: 'browserWatch', on: true }); } };
      row.onclick = () => { if (it.status === 'running' && it.liveUrl) send({ type: 'browserAction', action: 'navigate', url: it.liveUrl }); else if (it.status !== 'stopped') showLogs(it.name); };
      box.appendChild(row);
    }
  }
  function showLogs(name) { $('bLogs').hidden = false; $('bLogsName').textContent = name; $('bLogsPre').textContent = ''; $('bLogs').dataset.name = name; send({ type: 'launchLogs', sid: S.sid, name }); }
  function onLaunchLogs(m) { if ($('bLogs').dataset.name !== m.name) return; const pre = $('bLogsPre'); pre.textContent = (m.lines || []).join('\n'); pre.scrollTop = pre.scrollHeight; }
  function onLaunchLog(m) { if ($('bLogs').hidden || $('bLogs').dataset.name !== m.name || m.cwd !== S.info?.cwd) return; const pre = $('bLogsPre'); pre.textContent += (pre.textContent ? '\n' : '') + m.line; pre.scrollTop = pre.scrollHeight; }
  $('bLogsClose').onclick = () => { $('bLogs').hidden = true; };

  // ---- Files pane: the session folder as a tree, and a viewer with tabs
  const F = { root: '', nodes: new Map(), tabs: [], active: null, q: '', ref: 0 };
  function filesReset() { F.root = ''; F.nodes.clear(); F.tabs = []; F.active = null; F.q = ''; $('fFilter').value = ''; $('ftree').innerHTML = ''; $('ftabs').innerHTML = ''; showEmptyFile(); }
  function filesInit() {
    const cwd = S.info?.cwd; if (!cwd || S.info.kind === 'chat') { $('ftree').innerHTML = '<div class="fnote">' + tr('This chat has no folder.') + '</div>'; return; }
    if (F.root === cwd && F.nodes.size) return;
    F.root = cwd; F.nodes.clear(); $('ftree').innerHTML = ''; loadDir(cwd, $('ftree'));
  }
  function loadDir(p, into) { const ref = ++F.ref; F.nodes.set(p, { into, ref }); send({ type: 'fsList', ref, path: p }); }
  function onFsList(m) {
    const n = [...F.nodes.values()].find((x) => x.ref === m.ref); if (!n) return;
    n.into.innerHTML = ''; n.loaded = true; n.items = m.items;
    if (!m.items.length) n.into.appendChild(el('div', 'fnote', tr('Empty folder')));
    for (const it of m.items) n.into.appendChild(fileNode(it));
  }
  function fileNode(it, meta) {
    const row = el('div', 'fnode' + (it.dir ? ' dir' : '')); row.title = it.path;
    row.innerHTML = (it.dir ? `<svg class="arr"><use href="#i-chev" style="transform:rotate(-90deg);transform-origin:center"/></svg>` : '<span class="arr"></span>') + `<svg class="fi"><use href="#i-${it.dir ? 'folder' : fileIcon(it.name)}"/></svg><span class="nm"></span>`;
    row.querySelector('.nm').textContent = it.name; if (meta) row.appendChild(el('span', 'meta', meta));
    if (it.dir) {
      const kids = el('div', 'fkids'); kids.hidden = true; const wrap = el('div'); wrap.append(row, kids);
      row.onclick = () => { const open = row.classList.toggle('open'); kids.hidden = !open; if (open && !F.nodes.get(it.path)?.loaded) loadDir(it.path, kids); };
      return wrap;
    }
    row.onclick = () => openFile(it.path, it.line); if (it.path === F.active) row.classList.add('active');
    return row;
  }
  function fileIcon(name) { const e = (name.split('.').pop() || '').toLowerCase(); if (['js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'sh', 'yml', 'yaml', 'toml'].includes(e)) return 'code'; if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) return 'dash'; if (['md', 'txt'].includes(e)) return 'skill'; return 'file'; }
  let fFilterTimer = null;
  $('fFilter').oninput = () => { clearTimeout(fFilterTimer); fFilterTimer = setTimeout(runFilter, 250); };
  $('fFilter').onkeydown = (e) => { if (e.key === 'Escape') { $('fFilter').value = ''; runFilter(); $('fFilter').blur(); } };
  function runFilter() {
    const q = $('fFilter').value.trim(); F.q = q;
    if (!q || q === '?') { if (F.nodes.get(F.root)?.into !== $('ftree') || !F.nodes.get(F.root)?.loaded) { F.nodes.clear(); $('ftree').innerHTML = ''; if (F.root) loadDir(F.root, $('ftree')); } else { $('ftree').innerHTML = ''; for (const it of F.nodes.get(F.root).items) $('ftree').appendChild(fileNode(it)); for (const [p, n] of F.nodes) if (p !== F.root) F.nodes.delete(p); } return; }
    const content = q.startsWith('?'); const ref = ++F.ref; F.searchRef = ref;
    $('ftree').innerHTML = '<div class="fnote">' + tr('Searching…') + '</div>';
    send({ type: 'fsSearch', ref, root: F.root, q: content ? q.slice(1).trim() : q, content });
  }
  function onFsSearch(m) {
    if (m.ref !== F.searchRef) return; const box = $('ftree'); box.innerHTML = '';
    if (!m.items.length) { box.appendChild(el('div', 'fnote', tr('No match.'))); return; }
    for (const it of m.items) { const dir = it.rel.includes('/') || it.rel.includes('\\') ? it.rel.slice(0, Math.max(it.rel.lastIndexOf('/'), it.rel.lastIndexOf('\\'))) : ''; box.appendChild(fileNode({ name: it.line ? `${it.name}:${it.line}  ${it.text || ''}` : it.name, path: it.path, line: it.line }, dir)); }
    if (m.items.length >= 100) box.appendChild(el('div', 'fnote', tr('Only the first 100 matches are shown.')));
  }
  $('fSearchBtn').onclick = () => { const f = $('fFilter'); if (!f.value.startsWith('?')) f.value = '?' + f.value; f.focus(); };
  $('paneFiles').querySelector('.pane-more').onclick = (e) => menu(e, [
    [tr('Refresh'), () => { F.nodes.clear(); $('ftree').innerHTML = ''; if (F.root) loadDir(F.root, $('ftree')); }],
    [tr('Show folder in {app}', { app: navigator.platform.startsWith('Mac') ? 'Finder' : 'Explorer' }), () => F.root && send({ type: 'reveal', path: F.root })],
    [tr('Close all files'), () => { F.tabs = []; F.active = null; renderFileTabs(); showEmptyFile(); }],
  ], tr('Files'));
  function showEmptyFile() { $('fcontent').innerHTML = `<div class="fempty">${icon('folder')}<b>${tr('Open files appear here')}</b><span>${tr('Pick a file in the tree, or click a file path in the conversation.')}</span></div>`; }
  function renderFileTabs() {
    const box = $('ftabs'); box.innerHTML = '';
    for (const t of F.tabs) {
      const b = el('button', 'ftab' + (t.path === F.active ? ' active' : '')); b.title = t.path; b.innerHTML = '<span class="nm"></span><span class="x">' + icon('close') + '</span>';
      b.querySelector('.nm').textContent = t.name; b.onclick = () => openFile(t.path, null, t.src);
      b.querySelector('.x').onclick = (e) => { e.stopPropagation(); F.tabs = F.tabs.filter((x) => x !== t); if (F.active === t.path) { F.active = null; const last = F.tabs[F.tabs.length - 1]; if (last) openFile(last.path, null, last.src); else { renderFileTabs(); showEmptyFile(); } } else renderFileTabs(); };
      box.appendChild(b);
    }
    for (const n of document.querySelectorAll('#ftree .fnode')) n.classList.toggle('active', n.title === F.active);
  }
  async function openFile(p, line, src) {
    togglePane('files', true);
    if (!F.tabs.some((t) => t.path === p)) F.tabs.push({ path: p, name: src ? (p.split(/[\\/]/).pop() || tr('Image')) : base(p), src });
    F.active = p; renderFileTabs();
    const body = $('fcontent'); body.innerHTML = '';
    const head = el('div', 'fpath'); head.innerHTML = '<span class="nm"></span>'; head.querySelector('.nm').textContent = src ? p : shortPath(p); body.appendChild(head);
    if (!src) { const rv = el('button', 'btn', tr('Show in folder')); rv.onclick = () => send({ type: 'reveal', path: p }); const op = el('a', 'btn', tr('Open in new tab')); op.href = fileUrl(p); op.target = '_blank'; op.rel = 'noopener'; head.append(rv, op); }
    const ext = src ? 'png' : (base(p).split('.').pop() || '').toLowerCase();
    if (src) { const im = el('img'); im.src = src; body.appendChild(im); return; }
    if (['html', 'htm', 'pdf'].includes(ext)) { const f = el('iframe'); f.src = fileUrl(p); f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups'); body.appendChild(f); }
    else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) { const im = el('img'); im.src = fileUrl(p) + '&v=' + Date.now(); body.appendChild(im); }
    else if (['mp4', 'webm', 'mov'].includes(ext)) { const v = el('video'); v.src = fileUrl(p); v.controls = true; body.appendChild(v); }
    else if (['docx', 'xlsx', 'pptx', 'zip', 'exe', 'dmg', 'pkg'].includes(ext)) body.appendChild(el('div', 'fnote', tr('This file type can\'t be previewed here. Use "Show in folder" to open it.')));
    else {
      try {
        const r = await fetch(fileUrl(p, true)); const t = await r.text(); if (!r.ok) throw new Error(t);
        if (F.active !== p) return;
        if (ext === 'md' || ext === 'markdown') { const d = el('div', 'prose'); renderInto(d, t, true); body.appendChild(d); }
        else { const pre = el('pre', 'src'); const lines = t.split('\n'); if (lines.length > 20000) lines.length = 20000; for (let i = 0; i < lines.length; i++) { const s = el('span', 'ln' + (line && i + 1 === line ? ' hit' : ''), lines[i] + '\n'); pre.appendChild(s); } body.appendChild(pre); if (line) pre.querySelector('.hit')?.scrollIntoView({ block: 'center' }); }
      } catch { body.appendChild(el('div', 'fnote', tr('This file isn\'t available yet.'))); }
    }
  }
  function openPreview(p) { openFile(p); }
  function openImageSrc(src, name) { openFile(name || 'image', null, src); }
  $('fSplit').onpointerdown = (e) => {
    e.preventDefault(); const x0 = e.clientX, w0 = $('paneFiles').querySelector('.ftree').getBoundingClientRect().width; document.body.classList.add('resizing');
    const move = (ev) => document.documentElement.style.setProperty('--ftree-w', Math.max(140, w0 + ev.clientX - x0) + 'px');
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  };

  // ---- Terminal pane: a shell in the session folder (plain pipes: commands run one after the other)
  const T = { sid: null, hist: [], hi: 0, buf: '' };
  function termReset() { T.sid = null; T.hist = []; T.hi = 0; T.buf = ''; $('termOut').textContent = ''; $('termCwd').textContent = ''; }
  function termInit() { if (!S.sid || S.info?.kind === 'chat') { $('termOut').textContent = tr('This chat has no folder to open a shell in.'); return; } if (T.sid !== S.sid) { T.sid = S.sid; $('termOut').textContent = ''; $('termCwd').textContent = shortPath(S.info.cwd); send({ type: 'termOpen', sid: S.sid }); } setTimeout(() => $('termIn').focus(), 50); }
  function onTermOpened(m) { if (m.sid !== S.sid) return; $('termCwd').textContent = shortPath(m.cwd); if (m.restarted) termWrite('\n[shell restarted]\n'); }
  function onTermOut(m) {
    if (m.sid !== S.sid) return;
    let data = T.buf + m.data; T.buf = '';
    data = data.replace(/\u001e([^\u001e]*)\u001e\r?\n?/g, (_, cwd) => { if (cwd) $('termCwd').textContent = shortPath(cwd.trim()); return ''; });
    const i = data.lastIndexOf('\u001e'); if (i >= 0 && data.length - i < 2048) { T.buf = data.slice(i); data = data.slice(0, i); }
    data = data.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
    if (data) termWrite(data);
  }
  function termWrite(text) { const pre = $('termOut'); const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40; pre.appendChild(document.createTextNode(text)); if (pre.childNodes.length > 4000) pre.removeChild(pre.firstChild); if (stick) pre.scrollTop = pre.scrollHeight; }
  $('termIn').onkeydown = (e) => {
    const inp = $('termIn');
    if (e.key === 'Enter') {
      e.preventDefault(); const cmd = inp.value; inp.value = ''; if (!cmd.trim()) return;
      T.hist.push(cmd); T.hi = T.hist.length;
      if (cmd.trim() === 'clear' || cmd.trim() === 'cls') { $('termOut').textContent = ''; return; }
      const c = el('span', 'cmd', cmd); $('termOut').appendChild(c); termWrite('\n'); send({ type: 'termRun', sid: S.sid, cmd });
    } else if (e.key === 'ArrowUp') { e.preventDefault(); if (T.hi > 0) { T.hi--; inp.value = T.hist[T.hi] || ''; } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (T.hi < T.hist.length) { T.hi++; inp.value = T.hist[T.hi] || ''; } }
    else if (e.key === 'c' && e.ctrlKey) { e.preventDefault(); termWrite('^C\n'); send({ type: 'termKill', sid: S.sid }); }
    else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); $('termOut').textContent = ''; }
  };
  $('tBody').onclick = (e) => { if (!window.getSelection()?.toString()) $('termIn').focus(); };
  $('paneTerm').querySelector('.pane-more').onclick = (e) => menu(e, [
    [tr('Clear'), () => { $('termOut').textContent = ''; }],
    [tr('Restart the shell'), () => send({ type: 'termKill', sid: S.sid })],
    [tr('Copy output'), () => copyText($('termOut').textContent)],
  ], tr('Terminal'));
  layoutPanes();

  // files served by the local server (only inside project folders and the app's data folder)
  const fileUrl = (p, raw) => `/file?t=${encodeURIComponent(token || '')}&path=${encodeURIComponent(p)}${raw ? '&raw=1' : ''}`;

  // Minimal, safe Markdown (escape first, then format), with copy buttons on code blocks.
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function imgSrc(src) { if (/^(https?:|data:)/.test(src)) return src; const cwd = S.info?.cwd || ''; const abs = /^([a-zA-Z]:[\\/]|\/)/.test(src) ? src : cwd.replace(/[\\/]+$/, '') + '/' + src.replace(/^\.\//, ''); return fileUrl(abs); }
  function inline(s) {
    return s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => `<img class="md-img" alt="${alt}" src="${imgSrc(src)}" data-path="${esc(src)}">`)
      .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
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
  const LANG_TAG = /^\s*\[lang:[a-z]{2}(?:-[a-z]{2})?\]\s*/i;   // voice turns start with the detected language; voice.js reads it, the chat hides it
  function renderInto(node, src, final) {
    src = String(src).replace(LANG_TAG, '');
    node.innerHTML = md(src); node.dataset.raw = src;
    if (final) for (const pre of node.querySelectorAll('pre')) { const lbl = tr('Copy'); const b = el('button', 'copy-btn', lbl); b.onclick = () => { const t = pre.innerText; copyText(t.endsWith(lbl) ? t.slice(0, -lbl.length) : t); }; pre.appendChild(b); }
    for (const im of node.querySelectorAll('img.md-img')) im.onclick = () => openImageSrc(im.src, im.dataset.path || tr('Image'));
  }
  function copyText(t) { navigator.clipboard?.writeText(t).then(() => toast(tr('Copied')), () => toast(tr('Copy failed'), true)); }

  // ------------------------------------------------------------ composer
  function makeComposer(host, onSubmit, opts = {}) {
    // claude.ai layout: text on top; below it "+", the slot (Chat/Cowork, folder), then model, mic and the send button, which only shows once there is something to send.
    host.innerHTML = `<div class="box"><div class="chips"></div><div class="top"><textarea rows="1" placeholder="${tr('Write a message…')}"></textarea></div><div class="interim"></div>
      <div class="crow"><button class="icon attach" title="${tr('Add files, skills and more')}">${icon('plus')}</button><input type="file" multiple hidden><span class="slot"></span>
      <span class="slot-r"><span class="spin" hidden title="${tr('Claude is working')}"></span><button class="icon vm" title="${tr('Voice mode')} (⌥V)">${icon('voice')}</button><button class="icon mic" title="${tr('Dictate (click to start / stop)') + ' (⌥D)'}">${icon('mic')}</button><button class="send" title="${tr('Send (Enter)')}" hidden>${icon('up')}</button></span></div></div>`;
    const ta = host.querySelector('textarea'), chips = host.querySelector('.chips'), fileIn = host.querySelector('input[type=file]');
    const sendBtn = host.querySelector('.send'), mic = host.querySelector('.mic'), interim = host.querySelector('.interim'), spin = host.querySelector('.spin');
    const attachments = []; let busy = false;
    const syncSend = () => { sendBtn.hidden = !busy && !ta.value.trim() && !attachments.length; };
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; syncSend(); };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      else if (e.key === 'ArrowUp' && !ta.value.trim() && opts.onArrowUp) { e.preventDefault(); opts.onArrowUp(); }
      else if (e.key === 'Escape' && opts.onEscape) opts.onEscape();
    });
    function renderChips() {
      chips.innerHTML = '';
      for (const a of attachments) {
        const c = el('span', 'fchip' + (a.path ? '' : ' loading') + (a.url ? ' img' : ''));
        if (a.url) { const im = el('img'); im.src = a.url; im.alt = a.name; c.appendChild(im); }
        c.appendChild(el('span', 'nm', a.name + (a.path ? '' : tr(' (uploading…)'))));
        const x = el('button', null, '×'); x.title = tr('Remove'); x.onclick = () => { attachments.splice(attachments.indexOf(a), 1); if (a.url) URL.revokeObjectURL(a.url); renderChips(); }; c.appendChild(x); chips.appendChild(c);
      }
      syncSend();
    }
    function addFiles(list) {
      for (const f of list) {
        if (f.size > 25 * 1024 * 1024) { toast(tr('{name} is larger than 25 MB.', { name: f.name }), true); continue; }
        const ref = Math.random().toString(36).slice(2); attachments.push({ ref, name: f.name, path: null, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null }); renderChips();
        const r = new FileReader(); r.onload = () => send({ type: 'upload', ref, name: f.name, data: String(r.result).split(',')[1] || '' }); r.readAsDataURL(f);
      }
    }
    // "+" menu like claude.ai: files, project folder, skills, connectors, plugins.
    host.querySelector('.attach').onclick = (e) => {
      const items = [{ label: tr('Add files or photos'), icon: 'attach', right: IS_MAC ? '⌘U' : 'Ctrl+U', fn: () => fileIn.click() }];
      if (opts.welcome) items.push({ label: tr('Add to project'), icon: 'folder', arrow: true, fn: () => { if (S.tab === 'chat') { store.set('chatKind', 'cowork'); setTab('cowork'); } $('projectChip').click(); } });
      items.push({ sep: true }, { label: tr('Skills'), icon: 'skill', arrow: true, fn: () => skillsMenu(e, (name) => { ta.value = `/${name} ` + ta.value; autosize(); ta.focus(); }) },
        { label: tr('Connectors'), icon: 'plug', arrow: true, fn: () => showCustomize('mcp') }, { label: tr('Add plugins'), icon: 'puzzle', fn: () => showCustomize('plugins') });
      richMenu(e, items);
    };
    fileIn.onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
    host.querySelector('.vm').onclick = () => window.Voice?.open();
    host.addFilesDialog = () => fileIn.click();
    function submit() {
      if (attachments.some((a) => !a.path)) { toast(tr('Files are still uploading — one moment.')); return; }
      const text = ta.value.trim(); if (!text && !attachments.length) return;
      onSubmit({ text, files: attachments.map((a) => a.path), queued: busy });
      ta.value = ''; autosize(); for (const a of attachments) if (a.url) URL.revokeObjectURL(a.url); attachments.length = 0; renderChips();
      if (rec.active) { rec.stop(); if (store.get('handsFree', false)) rec.wait(); }
    }
    sendBtn.onclick = () => { if (busy) onSubmit(null); else submit(); };
    const rec = voice(ta, interim, mic, autosize, submit);
    let placeholder = opts.placeholder || tr('Write a message…');
    return {
      focus: () => ta.focus(), addFiles, slot: host.querySelector('.slot'), slotR: host.querySelector('.slot-r'), openFiles: () => fileIn.click(),
      setPlaceholder: (t) => { placeholder = t; if (!busy) ta.placeholder = t; },
      listen: () => { rec.wait(); rec.start(); }, voiceIdle: () => rec.idle(),
      uploaded(m) { const a = attachments.find((x) => x.ref === m.ref); if (a) { a.path = m.path; renderChips(); } },
      setBusy(v) { busy = v; sendBtn.classList.toggle('stop', v); sendBtn.title = v ? tr('Stop') : tr('Send (Enter)'); sendBtn.innerHTML = icon(v ? 'stop' : 'up'); spin.hidden = !v; ta.placeholder = v ? tr('Type a message to send when Claude is done, or press Stop…') : placeholder; syncSend(); },
      setText(t) { ta.value = t; autosize(); ta.focus(); ta.setSelectionRange(t.length, t.length); },
      getText: () => ta.value,
    };
  }
  function skillsMenu(e, onPick) {
    const open = () => { const list = (S.skills || []).slice(0, 14); if (!list.length) { toast(tr('No skills installed yet. Add some under Customize.')); showCustomize('skills'); return; } richMenu(e, list.map((s) => ({ label: s.name, desc: (s.description || '').slice(0, 70), fn: () => onPick(s.name) })).concat([{ sep: true }, { label: tr('Manage skills'), arrow: true, fn: () => showCustomize('skills') }])); };
    if (S.skills === null) { send({ type: 'skills' }); onceHandlers.push((m) => { if (m.type === 'skills') open(); }); } else open();
  }
  let pendingFirst = null;
  // A new session from the welcome screen (the composer, or voice mode): the current space's kind, folder, mode and model.
  // `m` is the first message, sent once the session is open; voice mode passes none and talks afterwards.
  function newSessionFromWelcome(m) {
    store.set('chatKind', S.tab === 'cowork' ? 'cowork' : 'chat');
    let kind = S.tab; let cwd = kind === 'chat' ? '' : S.newFolder;
    if (kind !== 'chat' && !cwd) { if (m) return toast(tr('Choose a project folder first.'), true); kind = 'chat'; }
    if (kind !== 'chat') { store.set('lastFolder', cwd); send({ type: 'addProject', path: cwd }); }
    pendingFirst = m || null;
    send({ type: 'new', kind, cwd, mode: kind === 'chat' ? undefined : (S.newMode || undefined), model: S.newModel ?? undefined, effort: S.newEffort ?? undefined });
  }
  const welcomeComposer = makeComposer($('welcomeComposer'), (m) => { if (m && !m.queued) newSessionFromWelcome(m); }, { welcome: true, placeholder: tr('How can I help you today?') });
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
  // Like claude.ai: the mode, browser and connector chips sit inside the box, left of the text row; the model sits by the send button.
  sessionComposer.slot.append($('sModeChip'), $('sBrowserChip'), $('sConnChip'));
  sessionComposer.slotR.prepend($('sModelChip'));
  function startEdit(turn) { editing = turn; $('editHint').hidden = false; $('editHint').querySelector('span').textContent = tr('Editing your message. Sending will branch the conversation from there.'); sessionComposer.setText(stripAttachLine(turn.dataset.text)); }
  $('editHint').querySelector('button').onclick = () => { editing = null; $('editHint').hidden = true; sessionComposer.setText(''); };
  function renderQueue() {
    const box = $('queue'); box.innerHTML = ''; const q = queues.get(S.sid) || [];
    for (const m of q) {
      const d = el('div', 'qmsg'); const b = el('div', 'bubble', m.text + (m.files?.length ? '\n📎 ' + tr('{n} file(s)', { n: m.files.length }) : '')); b.title = tr('Click to edit'); b.style.cursor = 'text';
      b.onclick = () => { q.splice(q.indexOf(m), 1); renderQueue(); sessionComposer.setText(m.text); };
      const acts = el('div', 'acts'); const now = el('button', 'btn link', tr('Send now')); now.title = tr('Stop the current work and send this'); now.onclick = () => { q.splice(q.indexOf(m), 1); q.unshift(m); renderQueue(); send({ type: 'stop', sid: S.sid }); };
      const x = el('button', 'ib'); x.innerHTML = '✕'; x.title = tr('Remove'); x.onclick = () => { q.splice(q.indexOf(m), 1); renderQueue(); };
      acts.append(now, x); d.append(b, acts); box.appendChild(d);
    }
  }
  function flushQueue(sid) { const q = queues.get(sid); if (!q?.length) return; const m = q.shift(); if (sid === S.sid) renderQueue(); send({ type: 'send', sid, text: m.text, files: m.files, voice: !!m.voice, lang: m.lang }); }
  // Inside the welcome composer: Chat/Cowork toggle and project folder on the left, the model picker on the right (like claude.ai).
  welcomeComposer.slot.append($('kindSeg'), $('projectChip'), $('modeChip')); welcomeComposer.slotR.prepend($('modelChip'));
  $('welcomeChips').remove();
  const activeComposer = () => (S.view === 'session' ? sessionComposer : welcomeComposer);
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); if (e.dataTransfer?.files?.length) activeComposer().addFiles(e.dataTransfer.files); });
  window.addEventListener('paste', (e) => { const f = e.clipboardData?.files; if (f?.length && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); activeComposer().addFiles(f); } });

  // Hands-free (Settings › Voice): a pause sends what was said, the reply is read aloud, then the microphone listens again.
  // HF.on is true from the moment a dictated message is sent until the user clicks the microphone to end the conversation.
  const HF = { on: false };
  function voice(ta, interimEl, mic, autosize, onSilence) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; const api = { active: false, stop() {}, start() {} };
    if (!SR) { mic.disabled = true; mic.title = tr('Dictation needs Microsoft Edge or Google Chrome'); return api; }
    const r = new SR(); r.continuous = true; r.interimResults = true; let baseText = '', wanted = false, silence = 0;
    const handsFree = () => store.get('handsFree', false);
    r.onstart = () => { api.active = true; mic.classList.add('rec'); baseText = ta.value; };
    r.onend = () => { api.active = false; mic.classList.remove('rec'); interimEl.textContent = ''; clearTimeout(silence); if (wanted && handsFree()) setTimeout(() => { if (wanted && !api.active) api.start(); }, 300); };   // Chrome stops after a while of silence: keep listening
    r.onerror = (e) => { if (e.error === 'not-allowed') { wanted = false; HF.on = false; toast(tr('Microphone access was blocked. Allow it in the address bar and try again.'), true); } };
    r.onresult = (e) => {
      let fin = '', inter = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) fin += x[0].transcript; else inter += x[0].transcript; }
      if (fin) { baseText = (baseText ? baseText.replace(/\s*$/, ' ') : '') + fin.trim(); ta.value = baseText; autosize(); } interimEl.textContent = inter;
      clearTimeout(silence); if (handsFree() && !inter && ta.value.trim()) silence = setTimeout(() => { if (api.active && ta.value.trim()) onSilence(); }, 3000);
    };
    api.start = () => { speechSynthesis?.cancel(); wanted = true; r.lang = S.settings.lang || 'fr-FR'; try { r.start(); } catch { /* already started */ } };
    api.stop = () => { wanted = false; clearTimeout(silence); r.stop(); };
    mic.onclick = () => { if (api.active || HF.on) { HF.on = false; speechSynthesis?.cancel(); api.stop(); mic.classList.remove('hf'); return; } api.start(); };
    api.wait = () => { HF.on = true; mic.classList.add('hf'); mic.title = tr('Hands-free: click to end'); };
    api.idle = () => { mic.classList.remove('hf'); mic.title = tr('Dictate (click to start / stop)') + ' (⌥D)'; };
    return api;
  }
  function speak(text, onEnd) {
    if (!window.speechSynthesis) { onEnd?.(); return; }
    const plain = text.replace(/```[\s\S]*?```/g, ' (code) ').replace(/[`*#>_]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(plain.slice(0, 4000)); u.lang = S.settings.lang || 'fr-FR'; const vv = window.Voice?.pickVoice(u.lang); if (vv) u.voice = vv; u.rate = window.Voice?.rate() || 1;
    let done = false; const end = () => { if (!done) { done = true; onEnd?.(); } }; u.onend = end; u.onerror = end; speechSynthesis.speak(u);
  }

  // ------------------------------------------------------------- dashboard
  function showDashboard() { showView('dashboard'); send({ type: 'dashboard' }); if (S.dash) renderDashboard(); else $('dashStats').innerHTML = '<div class="muted">' + tr('Loading…') + '</div>'; }
  function renderDashboard() {
    const D = S.dash; if (!D) return;
    const now = Date.now(); const day = 86400000; const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    // On a claude.ai subscription nothing is billed per token: the dashboard counts tokens instead of dollars.
    const sub = S.auth?.billing === 'subscription';
    const tok = (u) => (u.in || 0) + (u.out || 0);
    const sum = (arr) => arr.reduce((a, u) => a + (sub ? tok(u) : (u.cost || 0)), 0);
    const amount = (v) => (sub ? fmtK(v) : '$' + v.toFixed(2));
    const today = D.usage.filter((u) => u.at >= d0.getTime()), week = D.usage.filter((u) => u.at >= now - 7 * day), month = D.usage.filter((u) => u.at >= now - 30 * day);
    const stat = (v, l) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('dashStats').innerHTML = sub
      ? stat(fmtK(sum(today)), tr('Tokens today')) + stat(fmtK(sum(week)), tr('Last 7 days')) + stat(fmtK(sum(month)), tr('Last 30 days')) + stat(String(month.length), tr('Turns, 30 days'))
      : stat('$' + sum(today).toFixed(2), tr('Spent today')) + stat('$' + sum(week).toFixed(2), tr('Last 7 days')) + stat('$' + sum(month).toFixed(2), tr('Last 30 days')) + stat(fmtK(month.reduce((a, u) => a + tok(u), 0)), tr('Tokens, 30 days'));
    $('dashNote').textContent = sub ? tr('{n} turns recorded. Included in your {plan} subscription, nothing is billed per token.', { n: D.usage.length, plan: S.auth.plan || 'claude.ai' })
      : D.usage.length ? tr('{n} turns recorded. Estimates reported by Claude Code, not a bill.', { n: D.usage.length }) : tr('Spend is recorded from now on, for every turn run through this app.');
    $('dashBarsT').textContent = tr(sub ? 'Tokens, last 14 days' : 'Spend, last 14 days');
    const pend = $('dashPending'); pend.innerHTML = '';
    const waiting = D.items.filter((s) => s.status === 'waiting');
    if (!waiting.length) pend.appendChild(el('div', 'empty-note', tr('Nothing is waiting for you.')));
    for (const s of waiting) for (const p of (s.pending || [])) {
      const d = describe(p.tool, p.input); const row = el('div', 'pend');
      row.innerHTML = `<div class="t"></div><div class="arg"></div><div class="btns"></div>`;
      row.querySelector('.t').textContent = `${s.title} · ${d.label}`; row.querySelector('.arg').textContent = formatInput(p.tool, p.input).split('\n')[0];
      const mk = (label, cls, allow) => { const b = el('button', 'btn ' + cls, label); b.onclick = () => { send({ type: 'permit', sid: s.sid, id: p.id, tool: p.tool, allow, always: false }); row.remove(); }; return b; };
      const open = el('button', 'btn', tr('Open')); open.onclick = () => openSession(s);
      row.querySelector('.btns').append(mk(tr('Allow'), 'dark', true), mk(tr('Refuse'), '', false), open); pend.appendChild(row);
    }
    const run = $('dashRunning'); run.innerHTML = '';
    const running = D.items.filter((s) => s.status === 'running');
    if (!running.length) run.appendChild(el('div', 'empty-note', tr('No chat is working right now.')));
    for (const s of running) { const b = el('button', 'row'); b.innerHTML = '<span class="st running"></span><span class="t"><span class="tt"></span><small></small></span>'; b.querySelector('.tt').textContent = s.title; b.querySelector('small').textContent = `${KIND_LABEL[s.kind]} · ${s.kind === 'chat' ? '' : folderName(s.cwd) + ' · '}${ago(s.when)}`; b.onclick = () => openSession(s); run.appendChild(b); }
    const bars = $('dashBars'); bars.innerHTML = '';
    const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(d0.getTime() - i * day); days.push({ d, v: 0 }); }
    for (const u of D.usage) { const idx = Math.floor((u.at - (d0.getTime() - 13 * day)) / day); if (idx >= 0 && idx < 14) days[idx].v += sub ? tok(u) : (u.cost || 0); }
    const max = Math.max(0.01, ...days.map((x) => x.v));
    for (const x of days) { const b = el('div', 'b'); b.innerHTML = '<i></i><small></small>'; b.querySelector('i').style.height = Math.max(2, Math.round(x.v / max * 90)) + 'px'; b.title = `${x.d.toLocaleDateString()} · ${amount(x.v)}`; b.querySelector('small').textContent = x.d.toLocaleDateString(LOCALE, { weekday: 'short' })[0] + ' ' + x.d.getDate(); bars.appendChild(b); }
    const agg = (key, label) => { const m = new Map(); for (const u of month) { const k = u[key] || 'unknown'; const a = m.get(k) || { cost: 0, n: 0, tok: 0 }; a.cost += u.cost || 0; a.n++; a.tok += (u.in || 0) + (u.out || 0); m.set(k, a); } const box = $(label); box.innerHTML = ''; if (!m.size) box.appendChild(el('div', 'empty-note', tr('No data yet.'))); for (const [k, a] of [...m.entries()].sort((x, y) => (sub ? y[1].tok - x[1].tok : y[1].cost - x[1].cost))) { const r = el('div', 'kv'); r.innerHTML = '<span></span><span class="m"></span>'; r.querySelector('span').textContent = key === 'kind' ? (KIND_LABEL[k] || k) : shortModel(k); r.querySelector('.m').textContent = sub ? tr('{n} turns · {tok} tok', { n: a.n, tok: fmtK(a.tok) }) : tr('${cost} · {n} turns · {tok} tok', { cost: a.cost.toFixed(2), n: a.n, tok: fmtK(a.tok) }); box.appendChild(r); } };
    agg('model', 'dashModels'); agg('kind', 'dashKinds');
    const ctx = $('dashContext'); ctx.innerHTML = '';
    const withCtx = D.items.filter((s) => s.context && s.context.window).slice(0, 8);
    if (!withCtx.length) ctx.appendChild(el('div', 'empty-note', tr('Context use appears for chats that ran through this app.')));
    for (const s of withCtx) { const r = el('div', 'kv'); r.innerHTML = '<span class="n"></span><span class="ctx"><span class="bar"><i></i></span><span class="pct"></span></span>'; r.querySelector('.n').textContent = `${s.title} · ${KIND_LABEL[s.kind]}${s.cost && !sub ? ' · ~$' + s.cost.toFixed(2) : ''}`; renderCtx(r.querySelector('.ctx'), s.context); r.style.cursor = 'pointer'; r.onclick = () => openSession(s); ctx.appendChild(r); }
    const rb = $('dashRoutines'); rb.innerHTML = '';
    if (!D.routines.length) rb.appendChild(el('div', 'empty-note', tr('No routines. Create one from the Routines page.')));
    for (const r of D.routines) { const row = el('div', 'kv'); row.innerHTML = '<span></span><span class="m"></span>'; row.querySelector('span').textContent = r.name; const last = r.runs?.[0]; row.querySelector('.m').textContent = (r.enabled ? (r.nextRun ? tr('next {when}', { when: fmtWhen(r.nextRun) }) : tr('on')) : tr('paused')) + (last ? ' · ' + tr('last {status} {ago}', { status: last.ok === false ? tr('failed') : last.ok ? tr('ok') : tr('running'), ago: ago(last.at) }) : ''); row.style.cursor = 'pointer'; row.onclick = () => showRoutine(r.id); rb.appendChild(row); }
  }

  // ------------------------------------------------------------- home
  // "Needs you": every session waiting for a permission, in any space, answered from Home with the same 'permit'
  // message as the card in the chat. The count pill sits in the header of every other view and opens Home.
  const waitingSessions = () => S.sessions.filter((s) => s.status === 'waiting' && (s.pending || []).length);
  function mountWaitPills() {
    for (const head of document.querySelectorAll('.s-head, .page-head')) {
      const b = el('button', 'wait-pill'); b.hidden = true; b.innerHTML = '<i></i><span></span>'; b.title = tr('Waiting for your approval. Open Home to answer.');
      b.onclick = () => showWelcome();
      const sp = head.querySelector('.spacer'); sp ? head.insertBefore(b, sp) : head.appendChild(b);
    }
  }
  function renderNeeds() {
    const items = waitingSessions(); const n = items.reduce((k, s) => k + s.pending.length, 0);
    for (const b of document.querySelectorAll('.wait-pill')) { b.hidden = !n; b.querySelector('span').textContent = n === 1 ? tr('1 waiting') : tr('{n} waiting', { n }); }
    const box = $('needsYou'); box.hidden = !n;
    $('needsCount').textContent = n ? (n === 1 ? tr('1 permission to answer') : tr('{n} permissions to answer', { n })) : '';
    const list = $('needsList'); list.innerHTML = '';
    for (const s of items) for (const p of s.pending) {
      const d = describe(p.tool, p.input); const row = el('div', 'need');
      const who = el('div', 'who'); who.innerHTML = '<b></b> · <span></span>';
      who.querySelector('b').textContent = s.title; who.querySelector('span').textContent = KIND_LABEL[s.kind] + (s.kind === 'chat' ? '' : ' · ' + folderName(s.cwd));
      const q = el('div', 'q', askText(p.tool, p.input, d));
      const arg = el('div', 'arg', formatInput(p.tool, p.input).split('\n')[0]);
      const btns = el('div', 'btns');
      const answer = (allow, always) => {
        send({ type: 'permit', sid: s.sid, id: p.id, tool: p.tool, allow, always });
        s.pending = s.pending.filter((x) => x.id !== p.id); if (!s.pending.length) s.status = 'running';   // until the next sessions broadcast
        renderNeeds(); renderHomeDash();
      };
      const mk = (label, cls, allow, always) => { const b = el('button', 'btn ' + cls, label); b.onclick = () => answer(allow, always); return b; };
      const open = el('button', 'btn link', tr('Open')); open.onclick = () => openSession(s);
      btns.append(mk(tr('Allow'), 'dark', true, false), ...(p.noAlways ? [] : [mk(tr('Always allow'), '', true, true)]), mk(tr('Refuse'), '', false, false), open);
      row.append(who, q, arg, btns); list.appendChild(row);
    }
  }
  // The Dashboard page as four compact cards. Usage comes from the same 'dashboard' message, refreshed at most every 15 s.
  let homeDashAt = 0;
  function refreshHomeDash(force) { if (!force && Date.now() - homeDashAt < 15000) return; homeDashAt = Date.now(); send({ type: 'dashboard' }); }
  function renderHomeDash() {
    if (S.view !== 'welcome') return;
    const run = $('homeRunning'); run.innerHTML = '';
    const running = S.sessions.filter((s) => s.status === 'running' || s.status === 'waiting').slice(0, 4);
    if (!running.length) run.appendChild(el('div', 'empty-note', tr('No chat is working right now.')));
    for (const s of running) { const b = el('button', 'row'); b.innerHTML = '<span class="st"></span><span class="t"><span class="tt"></span><small></small></span>'; b.querySelector('.st').classList.add(s.status); b.querySelector('.tt').textContent = s.title; b.querySelector('small').textContent = KIND_LABEL[s.kind] + (s.kind === 'chat' ? '' : ' · ' + folderName(s.cwd)); b.onclick = () => openSession(s); run.appendChild(b); }
    const D = S.dash; const sub = S.auth?.billing === 'subscription';
    $('homeSpendT').textContent = tr(sub ? 'Tokens today' : 'Spent today');
    const sp = $('homeSpend'); sp.innerHTML = '';
    if (!D) sp.appendChild(el('div', 'empty-note', tr('Loading…')));
    else {
      const d0 = new Date(); d0.setHours(0, 0, 0, 0); const day = 86400000;
      const val = (arr) => arr.reduce((a, u) => a + (sub ? (u.in || 0) + (u.out || 0) : (u.cost || 0)), 0);
      const amount = (v) => (sub ? fmtK(v) : '$' + v.toFixed(2));
      const today = D.usage.filter((u) => u.at >= d0.getTime()), week = D.usage.filter((u) => u.at >= Date.now() - 7 * day);
      sp.appendChild(el('div', 'big', amount(val(today))));
      sp.appendChild(el('div', 'sub', tr('{n} turns · {x} in 7 days', { n: today.length, x: amount(val(week)) })));
    }
    const rb = $('homeRoutines'); rb.innerHTML = '';
    const routines = (S.routines || []).filter((r) => r.enabled && r.nextRun).sort((a, b) => a.nextRun - b.nextRun).slice(0, 4);
    if (!routines.length) rb.appendChild(el('div', 'empty-note', tr('Nothing scheduled.')));
    for (const r of routines) { const row = el('div', 'kv'); row.innerHTML = '<span></span><span class="m"></span>'; row.querySelector('span').textContent = r.name; row.querySelector('.m').textContent = fmtWhen(r.nextRun); row.onclick = () => showRoutine(r.id); rb.appendChild(row); }
    const ab = $('homeArtifacts'); ab.innerHTML = '';
    const arts = [...S.artifacts].sort((a, b) => b.when - a.when).slice(0, 4);
    if (!arts.length) ab.appendChild(el('div', 'empty-note', S.artifactsLoaded ? tr('No artifacts yet.') : tr('Loading…')));
    for (const a of arts) { const row = el('div', 'kv'); row.innerHTML = '<span></span><span class="m"></span>'; row.querySelector('span').textContent = base(a.path); row.querySelector('.m').textContent = ago(a.when); row.title = a.path; row.onclick = () => openArtifact(a); ab.appendChild(row); }
  }
  mountWaitPills();
  $('homeDashMore').onclick = $('homeSpendCard').onclick = () => showDashboard();

  // ------------------------------------------------------------- projects
  function showProjects()
 { showView('projects'); renderProjects(); }
  function renderProjects() {
    const box = $('projectList'); box.innerHTML = '';
    if (!S.projects.length) { box.innerHTML = '<div class="empty-page">' + tr('No projects yet. Add a folder to start.') + '</div>'; return; }
    // Cards like claude.ai's Projects page: name, folder, session count and last activity; actions on hover.
    for (const p of S.projects) {
      const mine = S.sessions.filter((s) => s.cwd === p.path && !s.archived); const n = mine.length; const last = mine.reduce((m, s) => Math.max(m, s.when), 0);
      const r = el('div', 'card p'); r.innerHTML = `<b class="nm"></b><div class="path"></div><div class="foot"><span class="when"></span><span class="acts"></span></div>`;
      r.querySelector('.nm').textContent = p.name; r.querySelector('.path').textContent = shortPath(p.path); r.title = p.path;
      const sids = new Set(mine.map((s) => s.sid)); const nArt = visibleArts().reduce((k, a) => k + (sids.has(a.sid) ? 1 : 0), 0);
      r.querySelector('.when').textContent = (n === 1 ? tr('1 session') : tr('{n} sessions', { n })) + (nArt ? ' · ' + (nArt === 1 ? tr('1 file') : tr('{n} files', { n: nArt })) : '') + (last ? ' · ' + ago(last) : '');
      const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
      const a = el('button', 'btn', tr('New session')); a.onclick = stop(() => { setTab(S.tab === 'cowork' ? 'cowork' : 'code'); showWelcome(p.path); });
      const b = el('button', 'btn', tr('Cowork task')); b.onclick = stop(() => { setTab('cowork'); showWelcome(p.path); });
      const x = el('button', 'ib sm'); x.innerHTML = icon('trash'); x.title = tr('Remove from list (files are not deleted)'); x.onclick = stop(() => send({ type: 'removeProject', path: p.path }));
      r.querySelector('.acts').append(a, b, x); r.onclick = () => { setTab(S.tab === 'cowork' ? 'cowork' : 'code'); showWelcome(p.path); }; box.appendChild(r);
    }
  }
  $('addProjectBtn').onclick = () => pickFolder(S.newFolder || S.home, (p) => send({ type: 'addProject', path: p }));

  // -------------------------------------------------------------- artifacts page
  // Same server index as the ⌘K palette (every file Claude wrote or edited, newest session first); the filter ignores accents.
  // An artifact in the claude.ai sense: a page Claude published on claude.ai, or an HTML / SVG page it created in a
  // Chat / Cowork / routine session. Edits, other file types and the files of Code sessions are project files, not
  // artifacts; "Show all" (remembered per browser) lists the whole index anyway.
  let artAll = store.get('artAll', false);
  const ART_PAGE = /\.(html?|svg)$/i;
  // A published page shows once even when several branches of a conversation share the publish: the newest session keeps it.
  function visibleArts() {
    const seen = new Set();
    return (artAll ? S.artifacts : S.artifacts.filter((a) => a.url || (a.action === 'Created' && a.kind !== 'code' && ART_PAGE.test(a.path))))
      .slice().sort((a, b) => b.when - a.when).filter((a) => !a.url || (!seen.has(a.url) && seen.add(a.url)));
  }
  const artName = (a) => a.name || base(a.path);
  function updateArtifactCount() { const n = visibleArts().length; $('artifactCount').textContent = n; $('artifactCount').hidden = !n; }
  $('artAll').checked = artAll;
  $('artAll').onchange = () => { artAll = $('artAll').checked; store.set('artAll', artAll); updateArtifactCount(); renderList(); renderArtifacts(); };
  let artifactsAt = 0;
  function refreshArtifacts() { if (Date.now() - artifactsAt < 10000) return; artifactsAt = Date.now(); send({ type: 'artifacts' }); }
  function showArtifacts() { showView('artifacts'); send({ type: 'artifacts' }); renderArtifacts(); $('artifactFilter').focus({ preventScroll: true }); }
  function openArtifact(a) { if (!a.path) { if (!(S.view === 'session' && S.info?.sid === a.sid)) openSession(a); return; } if (S.view === 'session' && S.info?.sid === a.sid) openFile(a.path); else { S.openAfter = a.path; openSession(a); } }
  $('artifactFilter').oninput = renderArtifacts;
  // List or grid, like Google Drive's switcher; the grid shows a preview "screenshot" of each file.
  let artView = store.get('artView', 'list');
  $('artView').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; artView = b.dataset.v; store.set('artView', artView); renderArtifacts(); };
  const TEXT_EXT = ['md', 'markdown', 'txt', 'csv', 'json', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'sh', 'css', 'scss', 'yml', 'yaml', 'toml', 'xml', 'sql', 'html', 'htm', 'svg', 'log', 'env', 'ini'];
  function artPreview(a) {
    const box = el('div', 'apv'); const ext = (base(a.path).split('.').pop() || '').toLowerCase();
    if (!a.path) { box.innerHTML = icon('expand'); box.classList.add('ico'); box.appendChild(el('span', null, 'claude.ai')); return box; }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) { const im = el('img'); im.src = fileUrl(a.path); im.alt = ''; im.loading = 'lazy'; box.appendChild(im); box.classList.add('img'); }
    else if (['html', 'htm', 'svg'].includes(ext)) {
      // a live, scaled-down render of the page as the thumbnail
      const f = el('iframe'); f.setAttribute('sandbox', ''); f.src = fileUrl(a.path); f.loading = 'lazy'; f.tabIndex = -1; box.appendChild(f); box.classList.add('page');
      requestAnimationFrame(() => { box.style.setProperty('--s', (box.clientWidth / 1000).toFixed(3)); });
    } else if (TEXT_EXT.includes(ext)) {
      const pre = el('pre', null, '…'); box.appendChild(pre); box.classList.add('txt');
      fetch(fileUrl(a.path, true)).then((r) => (r.ok ? r.text() : '')).then((t) => { pre.textContent = t.slice(0, 700); }).catch(() => {});
    } else { box.innerHTML = icon(ext === 'pdf' ? 'file' : 'file'); box.classList.add('ico'); box.appendChild(el('span', null, ext ? '.' + ext : '')); }
    return box;
  }
  // "View": the file itself in a new tab — rendered when the browser can show it (HTML, SVG, images, PDF, text), as plain text otherwise
  const RENDERABLE = /\.(html?|svg|png|jpe?g|gif|webp|pdf|mp4|webm|json|css|txt|md|csv)$/i;
  function viewLink(a, cls, label) {
    const v = el('a', cls, label); if (!label) v.innerHTML = icon('expand');
    v.href = a.url || fileUrl(a.path, !RENDERABLE.test(a.path)); v.target = '_blank'; v.rel = 'noopener'; v.title = a.url ? tr('Open on claude.ai') : tr('Open in new tab');
    v.onclick = (e) => e.stopPropagation();
    return v;
  }
  function renderArtifacts() {
    document.querySelectorAll('#artView button').forEach((b) => b.classList.toggle('active', b.dataset.v === artView));
    const box = $('artifactList'); box.innerHTML = ''; box.classList.toggle('grid', artView === 'grid');
    const q = fold($('artifactFilter').value.trim());
    const list = visibleArts().filter((a) => !q || fold(artName(a) + ' ' + a.title + ' ' + a.path).includes(q)).slice(0, 300);
    if (!list.length) { box.innerHTML = `<div class="empty-page">${icon('file')}<div>${visibleArts().length ? tr('No match.') : S.artifactsLoaded ? (artAll || !S.artifacts.length ? tr('No artifacts yet.') : tr('No artifacts yet. "Show all" lists every file Claude wrote.')) : tr('Loading…')}</div></div>`; return; }
    // One group per session (newest first), headed by the session's title: click it to open the conversation.
    const groups = new Map();
    for (const a of list) { if (!groups.has(a.sid)) groups.set(a.sid, { s: a, files: [] }); groups.get(a.sid).files.push(a); }
    for (const { s, files } of groups.values()) {
      const h = el('button', 'grp'); h.innerHTML = `${icon(s.kind === 'cowork' ? 'cowork' : s.kind === 'code' ? 'code' : 'chat')}<span class="tt"></span><small></small>`;
      h.querySelector('.tt').textContent = s.title; h.querySelector('small').textContent = `${KIND_LABEL[s.kind] || ''} · ${ago(s.when)} · ${files.length === 1 ? tr('1 file') : tr('{n} files', { n: files.length })}`;
      h.onclick = () => openSession(s); box.appendChild(h);
      if (artView === 'grid') {
        const g = el('div', 'agrid');
        for (const a of files) {
          const c = el('div', 'acard'); c.title = a.url || a.path;
          c.appendChild(artPreview(a));
          const t = el('div', 'at'); t.innerHTML = `${icon('file')}<span class="nm"></span><span class="acts"></span>`;
          t.querySelector('.nm').textContent = artName(a);
          const f = el('button', 'ib sm'); f.innerHTML = icon('folder'); f.title = tr('Show in folder'); f.onclick = (e) => { e.stopPropagation(); send({ type: 'reveal', path: a.path }); }; f.hidden = !a.path;
          t.querySelector('.acts').append(viewLink(a, 'ib sm'), f);
          const m = el('div', 'am', `${tr(a.action)} · ${ago(s.when)}`);
          c.append(t, m); c.onclick = () => openArtifact(a); g.appendChild(c);
        }
        box.appendChild(g); continue;
      }
      for (const a of files) {
        const r = el('div', 'prow click'); r.innerHTML = `<span class="icon">${icon('file')}</span><span class="t"><b></b><small></small></span>`;
        r.querySelector('b').textContent = artName(a); r.querySelector('small').textContent = `${tr(a.action)} · ${a.url || shortPath(a.path)}`;
        r.onclick = (e) => { if (!e.target.closest('button, a')) openArtifact(a); };
        const v = viewLink(a, 'btn', tr('View'));
        const o = el('button', 'btn', tr('Open chat')); o.title = tr('Open the conversation that made it'); o.onclick = () => openArtifact(a);
        const f = el('button', 'ib'); f.innerHTML = icon('folder'); f.title = tr('Show in folder'); f.onclick = () => send({ type: 'reveal', path: a.path }); f.hidden = !a.path;
        r.append(v, o, f); box.appendChild(r);
      }
    }
  }

  // -------------------------------------------------------------- routines
  let routineTab = 'yours';
  function showRoutines() { showView('routines'); renderRoutinesPage(); }
  $('routineTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; routineTab = b.dataset.t; renderRoutinesPage(); };
  $('newRoutineBtn').onclick = () => showRoutineEdit(null);
  // Like claude.ai's Scheduled tasks page: your tasks as cards (status dot, prompt excerpt, schedule chip), templates listed below.
  function renderRoutinesPage() {
    $('routinesTitle').textContent = space() === 'code' ? tr('Routines') : tr('Scheduled tasks');
    const y = $('routinesYours'); y.innerHTML = '';
    if (!S.routines.length) y.innerHTML = `<div class="empty-note wide">${tr('No tasks yet. Pick a template below, or create one.')}</div>`;
    for (const r of S.routines) {
      const running = S.sessions.some((s) => s.routineId === r.id && s.status !== 'idle');
      const c = el('div', 'card task'); c.innerHTML = `<div class="head"><b></b><span class="st"></span></div><div class="desc"></div><div class="foot"><span class="sched"></span><span class="sched soft"></span></div>`;
      c.querySelector('b').textContent = r.name; c.querySelector('.desc').textContent = r.prompt || '';
      c.querySelector('.st').className = 'st ' + (running ? 'running' : r.enabled ? 'on' : 'off'); c.querySelector('.st').title = running ? tr('Running') : r.enabled ? tr('On') : tr('Paused');
      c.querySelector('.sched').textContent = describeSchedule(r.schedule) + (r.enabled && r.nextRun ? ' · ' + tr('next {when}', { when: fmtWhen(r.nextRun) }) : '');
      c.querySelector('.sched.soft').textContent = folderName(r.cwd);
      c.onclick = () => showRoutine(r.id); y.appendChild(c);
    }
    const t = $('routinesTemplates'); t.innerHTML = '';
    for (const tpl of ROUTINE_TEMPLATES) {
      const c = el('button', 'tpl'); c.innerHTML = `<span class="icon">${icon('clock')}</span><span class="t"><b></b><span class="d"></span><span class="s">${icon('clock')}<span></span></span></span>`;
      c.querySelector('b').textContent = tpl.name; c.querySelector('.d').textContent = tpl.desc; c.querySelector('.s span').textContent = describeSchedule(tpl.schedule);
      c.onclick = () => showRoutineEdit(null, tpl); t.appendChild(c);
    }
  }
  function showRoutine(id, keep) {
    const r = S.routines.find((x) => x.id === id);
    if (!r) { if (!keep) showRoutines(); return; }
    showView('routine'); S.routineId = id;
    $('rName').textContent = r.name; $('rEnabled').checked = !!r.enabled;
    $('rSchedule').textContent = describeSchedule(r.schedule);
    $('rNext').textContent = r.enabled ? (r.nextRun ? tr('Next run: {when}', { when: fmtWhen(r.nextRun) }) : tr('No next run scheduled')) : tr('Paused');
    $('rCwd').textContent = r.cwd; $('rPrompt').textContent = r.prompt;
    $('rMode').textContent = MODE_LABEL[r.mode] + (r.model ? ' · ' + tr('model {model}', { model: r.model }) : '');
    renderRoutineRuns();
  }
  function renderRoutineRuns() {
    const r = S.routines.find((x) => x.id === S.routineId); if (!r) return;
    const box = $('rRuns'); box.innerHTML = '';
    if (!r.runs?.length) { box.innerHTML = '<div class="muted">' + tr('No runs yet. Press “Run now” to try it.') + '</div>'; return; }
    const dur = (ms) => ms < 60000 ? Math.round(ms / 1000) + ' s' : Math.round(ms / 60000) + ' min';
    for (const run of r.runs) {
      const live = S.sessions.find((s) => s.sid === run.sid || (run.sdkId && s.sdkId === run.sdkId));
      const st = run.skipped ? 'hollow' : live && live.status !== 'idle' ? 'running' : run.ok === true ? 'ok' : run.ok === false ? 'bad' : '';
      const b = el('button', 'run' + (run.skipped ? ' skipped' : '')); b.innerHTML = `<span class="st ${st}"></span><span class="t"><span class="when"></span><small class="log"></small></span><span class="spacer"></span><span class="muted small"></span>`;
      b.querySelector('.when').textContent = fmtWhen(run.at) + (run.manual ? ' · ' + tr('manual') : '');
      const info = st === 'running' ? tr('Running…') : run.skipped ? tr('Skipped') : [run.ok === false ? tr('Failed') : run.ok ? tr('Done') : '', run.ms ? dur(run.ms) : '', run.cost ? `$${run.cost.toFixed(3)}` : ''].filter(Boolean).join(' · ');
      b.querySelector('.muted').textContent = info;
      const log = run.error || run.summary || ''; b.querySelector('.log').textContent = log; b.title = log;
      if (run.skipped) b.disabled = true; else b.onclick = () => send({ type: 'open', sid: run.sdkId || run.sid, cwd: r.cwd });
      box.appendChild(b);
    }
  }
  $('rBack').onclick = showRoutines;
  $('rEnabled').onchange = () => send({ type: 'routineToggle', id: S.routineId, enabled: $('rEnabled').checked });
  $('rRun').onclick = () => send({ type: 'routineRun', id: S.routineId });
  $('rEdit').onclick = () => showRoutineEdit(S.routineId);
  $('rDelete').onclick = () => { const r = S.routines.find((x) => x.id === S.routineId); if (r && confirm(tr('Delete routine “{name}”?', { name: r.name }))) { send({ type: 'routineDelete', id: r.id }); showRoutines(); } };

  let editingId = null;
  function showRoutineEdit(id, tpl) {
    editingId = id; const r = S.routines.find((x) => x.id === id) || tpl || {};
    showView('routineEdit');
    $('reTitle').textContent = id ? tr('Edit routine') : tr('New routine');
    $('reName').value = r.name || ''; $('rePrompt').value = r.prompt || '';
    $('reCwd').value = r.cwd || S.newFolder || S.projects[0]?.path || S.home;
    $('reMode').value = r.mode || S.settings.coworkMode || 'auto'; $('reModel').value = r.model || '';
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
    onceHandlers.push((m) => { if (m.type === 'routines') { const r = m.items.find((x) => editingId ? x.id === editingId : x.name === routine.name); if (r) { toast(tr('Routine saved.')); showRoutine(r.id); } } });
  };
  function describeSchedule(s) {
    if (!s) return ''; const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((x) => tr(x));
    if (s.type === 'interval') return tr('Every {n} min', { n: s.every });
    if (s.type === 'once') return tr('Once, {when}', { when: fmtWhen(Date.parse(s.at)) });
    const d = s.days || []; const days = !d.length || d.length === 7 ? tr('daily') : d.length === 5 && !d.includes(0) && !d.includes(6) ? tr('weekdays') : d.map((x) => D[x]).join(', ');
    return tr('{days} at {time}', { days: days[0].toUpperCase() + days.slice(1), time: s.time });
  }

  // -------------------------------------------------------------- customize
  let custTab = 'skills', plugTab = 'installed';
  function showCustomize(tab) {
    showView('customize'); if (tab) custTab = tab;
    document.querySelectorAll('#custTabs button').forEach((b) => b.classList.toggle('active', b.dataset.t === custTab));
    $('custSkills').hidden = custTab !== 'skills'; $('custMcp').hidden = custTab !== 'mcp'; $('custPlugins').hidden = custTab !== 'plugins';
    $('toolSkills').hidden = custTab !== 'skills'; $('toolMcp').hidden = custTab !== 'mcp'; $('toolPlugins').hidden = custTab !== 'plugins';
    if (custTab === 'skills') { send({ type: 'skills' }); renderSkills(); }
    if (custTab === 'mcp') { send({ type: 'mcp' }); renderMcp(); }
    if (custTab === 'plugins') { send({ type: 'plugins' }); renderPlugins(); }
  }
  $('custTabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showCustomize(b.dataset.t); };
  $('skillSearch').oninput = renderSkills; $('plugSearch').oninput = renderPlugins; $('plugCat').onchange = renderPlugins;
  $('plugTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; plugTab = b.dataset.t; renderPlugins(); };
  function renderSkills() {
    const box = $('skillList'); box.innerHTML = '';
    if (S.skills === null) { box.innerHTML = '<div class="empty-page">' + tr('Loading…') + '</div>'; return; }
    const q = $('skillSearch').value.trim().toLowerCase();
    const items = S.skills.filter((s) => !q || (s.name + ' ' + s.description).toLowerCase().includes(q));
    if (!items.length) { box.innerHTML = `<div class="empty-page">${icon('skill')}<div>${S.skills.length ? tr('No match.') : tr('No skills installed yet.')}</div></div>`; return; }
    for (const s of items) {
      const r = el('div', 'card c'); r.style.cursor = 'default'; r.innerHTML = `<span class="icon">${icon('skill')}</span><span class="t"><b></b><div></div><small></small></span><span class="acts"></span>`;
      r.querySelector('b').textContent = s.name; r.querySelector('small').textContent = s.scope === 'user' ? tr('Personal') : tr('Project: {scope}', { scope: s.scope }); r.querySelector('div').textContent = s.description; r.querySelector('div').title = s.dir;
      const use = el('button', 'btn', tr('Use')); use.onclick = () => { setTab(S.tab === 'chat' ? 'code' : S.tab); showWelcome(); welcomeComposer.setText(`/${s.name} `); };
      if (s.disabled) { r.style.opacity = '.55'; r.querySelector('small').textContent += ' · ' + tr('Disabled'); }
      const edit = el('button', 'btn', tr('Edit')); edit.onclick = () => openSkillEdit(s);
      const upd = el('button', 'btn', tr('Update with Claude')); upd.onclick = () => { setTab('code'); S.newFolder = S.home; showWelcome(); welcomeComposer.setText(`Update the Claude Code skill in ${s.dir}/SKILL.md${s.disabled ? '.off' : ''}: `); };
      const tog = el('button', 'btn', s.disabled ? tr('Enable') : tr('Disable')); tog.onclick = () => send({ type: 'skillToggle', dir: s.dir, enabled: s.disabled });
      const x = el('button', 'ib'); x.innerHTML = icon('trash'); x.title = tr('Delete skill'); x.onclick = () => { if (confirm(tr('Delete skill “{name}”?', { name: s.name }))) send({ type: 'skillDelete', dir: s.dir }); };
      r.querySelector('.acts').append(...(s.disabled ? [] : [use]), edit, upd, tog, x); box.appendChild(r);
    }
  }
  function openSkillEdit(s) {
    const d = $('skillEditDlg'); d.dataset.dir = s.dir; $('skeName').textContent = s.name;
    $('skeText').value = tr('Loading…'); $('skeText').disabled = true; d.showModal(); send({ type: 'skillRead', dir: s.dir });
  }
  $('skeClose').onclick = () => $('skillEditDlg').close();
  $('skeSave').onclick = () => { const d = $('skillEditDlg'); if ($('skeText').disabled) return; send({ type: 'skillSave', dir: d.dataset.dir, text: $('skeText').value }); d.close(); };
  $('skillAddBtn').onclick = () => $('skillDlg').showModal();
  $('skClose').onclick = () => $('skillDlg').close();
  $('skUrlBtn').onclick = () => { const v = $('skUrl').value.trim(); if (v) { send({ type: 'skillAdd', source: v }); toast(tr('Installing skill…')); $('skillDlg').close(); } };
  $('skPathBtn').onclick = () => { const v = $('skPath').value.trim(); if (v) { send({ type: 'skillAdd', source: v }); $('skillDlg').close(); } };
  $('skPathBrowse').onclick = () => pickFolder($('skPath').value || S.home, (p) => ($('skPath').value = p));
  $('skFileBtn').onclick = () => { const f = $('skFile').files[0]; if (!f) return; const r = new FileReader(); r.onload = () => send({ type: 'upload', ref: 'skill', name: f.name, data: String(r.result).split(',')[1] || '' }); r.readAsDataURL(f); $('skillDlg').close(); toast(tr('Installing skill…')); };
  $('skIdeaBtn').onclick = () => {
    const idea = $('skIdea').value.trim(); if (!idea) return; $('skillDlg').close();
    setTab('code'); S.newFolder = S.home; showWelcome();
    welcomeComposer.setText(`Create a new Claude Code skill for this workflow: ${idea}\n\nWrite it as ~/.claude/skills/<short-name>/SKILL.md with YAML frontmatter (name, description that says when to trigger) followed by clear step-by-step instructions. Ask me at most 3 questions first if something important is unclear, then create the file.`);
  };
  function renderMcp() {
    const box = $('mcpList'); box.innerHTML = '';
    if (S.mcp === null) { box.innerHTML = '<div class="empty-page">' + tr('Loading…') + '</div>'; return; }
    if (!S.mcp.length) { box.innerHTML = `<div class="empty-page">${icon('plug')}<div>${tr('No connectors configured.')}</div></div>`; return; }
    for (const c of S.mcp) {
      const r = el('div', 'card c'); r.style.cursor = 'default'; r.innerHTML = `<span class="icon">${icon('plug')}</span><span class="t"><b></b><div></div><small></small></span><span class="acts"></span>`;
      r.querySelector('b').textContent = c.name; r.querySelector('small').textContent = c.scope === 'user' ? tr('Personal') : c.scope === 'plugin' ? tr('From plugin') : c.scope;
      r.querySelector('div').textContent = [c.type && c.type.toUpperCase(), c.target, c.health].filter(Boolean).join(' · ');
      if (c.scope === 'user') { const x = el('button', 'ib'); x.innerHTML = icon('trash'); x.title = tr('Remove'); x.onclick = () => { if (confirm(tr('Remove connector “{name}”?', { name: c.name }))) send({ type: 'mcpRemove', name: c.name }); }; r.querySelector('.acts').append(x); }
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
    $('plugSearch').parentElement.hidden = plugTab !== 'discover'; $('plugCat').hidden = plugTab !== 'discover';
    const P = S.plugins;
    if (!P) { $('plugInstalled').innerHTML = $('plugDiscover').innerHTML = '<div class="empty-page">' + tr('Loading…') + '</div>'; return; }
    const inst = $('plugInstalled'); inst.innerHTML = '';
    if (!P.cliOk) inst.innerHTML = '<div class="empty-page">' + tr('The claude command was not found, so plugins cannot be managed from here.') + '</div>';
    else if (!P.installed.length) inst.innerHTML = `<div class="empty-page">${icon('puzzle')}<div>${tr('No plugins installed. Look in Discover.')}</div></div>`;
    for (const p of P.installed) {
      const meta = P.available.find((a) => a.id === p.id) || {};
      const r = el('div', 'card c'); r.style.cursor = 'default'; r.innerHTML = `<span class="icon">${icon('puzzle')}</span><span class="t"><b></b><div></div><small></small></span><span class="acts"></span>`;
      r.querySelector('b').textContent = p.id.split('@')[0]; r.querySelector('small').textContent = `v${p.version}` + (p.enabled ? '' : ' · ' + tr('disabled'));
      r.querySelector('div').textContent = meta.description || p.id;
      const sw = el('label', 'switch'); sw.innerHTML = `<input type="checkbox" ${p.enabled ? 'checked' : ''}><span></span>`; sw.title = tr('Enabled');
      sw.querySelector('input').onchange = (e) => send({ type: 'pluginAction', action: e.target.checked ? 'enable' : 'disable', id: p.id });
      const x = el('button', 'ib'); x.innerHTML = icon('trash'); x.title = tr('Uninstall'); x.onclick = () => { if (confirm(tr('Uninstall plugin “{name}”?', { name: p.id }))) send({ type: 'pluginAction', action: 'uninstall', id: p.id }); };
      r.querySelector('.acts').append(sw, x); inst.appendChild(r);
    }
    const cat = $('plugCat');
    if (cat.options.length <= 1) for (const c of [...new Set(P.available.map((a) => a.category).filter(Boolean))].sort()) { const o = el('option', null, c[0].toUpperCase() + c.slice(1)); o.value = c; cat.appendChild(o); }
    const q = $('plugSearch').value.trim().toLowerCase(), cv = cat.value;
    const disc = $('plugDiscover'); disc.innerHTML = '';
    const installedIds = new Set(P.installed.map((p) => p.id));
    const list = P.available.filter((a) => (!cv || a.category === cv) && (!q || (a.name + ' ' + a.description + ' ' + a.author).toLowerCase().includes(q))).slice(0, 80);
    if (!list.length) disc.innerHTML = `<div class="empty-page" style="grid-column:1/-1">${P.available.length ? tr('No match.') : tr('No marketplace catalog found. Add a marketplace (for example anthropics/claude-plugins-official).')}</div>`;
    for (const a of list) {
      const c = el('div', 'card c'); c.style.cursor = 'default';
      c.innerHTML = `<span class="icon">${icon('puzzle')}</span><span class="t"><b></b><div></div><small></small></span>`;
      c.querySelector('b').textContent = a.name; c.querySelector('div').textContent = a.description; c.querySelector('small').textContent = [a.author && tr('by {author}', { author: a.author }), a.category, a.marketplace].filter(Boolean).join(' · ');
      const b = el('button', 'btn add ' + (installedIds.has(a.id) ? '' : 'dark'), installedIds.has(a.id) ? tr('Installed') : tr('Add')); b.disabled = installedIds.has(a.id);
      b.onclick = () => { b.disabled = true; b.textContent = tr('Installing…'); send({ type: 'pluginAction', action: 'install', id: a.id }); };
      c.appendChild(b); disc.appendChild(c);
    }
  }
  $('mkAddBtn').onclick = () => { const s = prompt(tr('Marketplace source (GitHub owner/repo, URL or folder):'), 'anthropics/claude-plugins-official'); if (s) send({ type: 'marketplaceAdd', source: s.trim() }); };

  // --------------------------------------------------------- request a fix
  let reportKind = 'bug';
  const REPORT_COPY = {
    bug: { intro: tr('Tell us what you saw. The app version, system and recent errors come with it automatically.'), title: tr('The reply stops after the first line'), p: tr('What happened'), pp: tr('The message you saw, the button that did nothing…'), s: tr('What should have happened'), sp: tr('The result you were expecting instead.'), btn: tr('Send report') },
    feature: { intro: tr('Describe what you need. The app version and system come with it automatically.'), title: tr('Export a chat to PDF'), p: tr('What it should do'), pp: tr('The feature itself: where it lives and how you would use it.'), s: tr('Why it matters'), sp: tr('What you do today instead, and what it costs you.'), btn: tr('Send request') },
  };
  let reportImpact = 'slowing';
  function openReport(prefill = {}) {
    reportKind = prefill.kind || 'bug'; reportKindUi();
    reportImpact = 'slowing'; reportImpactUi();
    const nErr = log ? log.querySelectorAll('.note.err').length : 0;
    $('rpErrCount').textContent = nErr === 1 ? tr('1 error message from this session will be attached.') : nErr ? tr('{n} error messages from this session will be attached.', { n: nErr }) : tr('No error was recorded in this session yet.');
    $('rpErrors').checked = nErr > 0;
    $('rpTitle').value = prefill.title || ''; $('rpPrimary').value = prefill.primary || ''; $('rpSecondary').value = ''; $('rpResult').textContent = '';
    $('rpSend').disabled = false; $('rpSend').textContent = REPORT_COPY[reportKind].btn;
    $('reportDlg').showModal(); $('rpTitle').focus();
  }
  function reportKindUi() {
    const c = REPORT_COPY[reportKind];
    document.querySelectorAll('#reportKind button').forEach((b) => b.classList.toggle('active', b.dataset.k === reportKind));
    $('reportIntro').textContent = c.intro; $('rpTitle').placeholder = c.title;
    $('rpPrimaryLbl').firstChild.textContent = c.p + ' '; $('rpPrimary').placeholder = c.pp; $('rpSecondaryLbl').firstChild.textContent = c.s + ' '; $('rpSecondary').placeholder = c.sp;
    $('rpImpactLbl').hidden = reportKind !== 'bug'; $('rpErrorsLbl').hidden = reportKind !== 'bug'; $('rpSend').textContent = c.btn;
    $('reportDlg').querySelector('.rp-title').textContent = reportKind === 'bug' ? tr('Request a fix') : tr('Request a feature');
  }
  function reportImpactUi() { document.querySelectorAll('#rpImpact button').forEach((b) => b.classList.toggle('active', b.dataset.v === reportImpact)); }
  $('rpImpact').onclick = (e) => { const b = e.target.closest('button'); if (b) { reportImpact = b.dataset.v; reportImpactUi(); } };
  $('rpClose').onclick = () => $('reportDlg').close();
  $('reportKind').onclick = (e) => { const b = e.target.closest('button'); if (b) { reportKind = b.dataset.k; reportKindUi(); } };
  $('reportBtn').onclick = () => openReport();
  $('setReportTry').onclick = () => { $('settingsDlg').close(); openReport(); };
  $('rpCancel').onclick = () => $('reportDlg').close();
  $('reportForm').onsubmit = (e) => {
    e.preventDefault();
    const errors = reportKind === 'bug' && $('rpErrors').checked ? [...log.querySelectorAll('.note.err')].map((n) => n.firstChild?.textContent || n.textContent).slice(-5).join('\n---\n') : '';
    const view = S.view === 'session' && S.info ? `${KIND_LABEL[S.info.kind]} session "${S.info.title || ''}" (${S.info.model || 'default model'}, ${S.info.mode})` : S.view;
    send({ type: 'report', kind: reportKind, title: $('rpTitle').value.trim(), primary: $('rpPrimary').value.trim(), secondary: $('rpSecondary').value.trim(), impact: reportImpact, errors, view, userAgent: navigator.userAgent });
    $('rpSend').disabled = true; $('rpSend').textContent = tr('Sending…'); $('rpResult').textContent = '';
  };
  function onReported(m) {
    $('rpSend').disabled = false; $('rpSend').textContent = REPORT_COPY[reportKind].btn;
    if (m.error) { $('rpResult').style.color = 'var(--danger)'; $('rpResult').textContent = m.error; return; }
    $('rpResult').style.color = '';
    if (m.via === 'browser') { window.open(m.url, '_blank'); $('rpResult').textContent = tr('A GitHub page with your report opened in a new tab. Press "Submit new issue" there to file it.'); }
    else { $('rpResult').innerHTML = tr('Filed:') + ' <a target="_blank" rel="noopener"></a>'; const a = $('rpResult').querySelector('a'); a.href = m.url; a.textContent = m.url; toast(tr('Issue filed on GitHub.')); }
  }

  // --------------------------------------------------------------- search
  // ⌘K / Ctrl+K or "/" anywhere. Filters: All, Chat, Cowork, Code, Projects, Routines, Artifacts. ←/→ change the filter, ↑/↓ move, ↵ opens.
  // Matching ignores accents and case ("depot" finds "Dépôt"). Artifacts are the files Claude wrote in any session (server index).
  const FILTERS = ['all', 'chat', 'cowork', 'code', 'projects', 'routines', 'artifacts'];
  const fold = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let selIdx = 0, results = [], searchFilter = 'all';
  function openSearch() { $('search').hidden = false; $('searchInput').value = ''; searchFilter = 'all'; renderSearch(); $('searchInput').focus(); send({ type: 'artifacts' }); }
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
    const q = fold($('searchInput').value.trim()); const f = searchFilter;
    const hit = (t) => !q || fold(t).includes(q);
    const sessions = []; const others = []; const arts = [];
    if (f === 'all' || f === 'artifacts') for (const a of visibleArts()) if (hit(artName(a) + ' ' + a.title) && (q || f === 'artifacts')) arts.push({ icon: a.url ? 'expand' : 'file', label: artName(a), sub: `${tr(a.action)} · ${a.title} · ${ago(a.when)}`, reveal: a.path || undefined, go: () => openArtifact(a) });
    if (f === 'all' || f === 'projects') for (const p of S.projects) if (hit(p.name + ' ' + p.path) && (q || f === 'projects')) others.push({ icon: 'folder', label: p.name, sub: tr('Project · new session'), go: () => { setTab('code'); showWelcome(p.path); } });
    if (f === 'all' || f === 'routines') for (const r of S.routines) if (hit(r.name) && (q || f === 'routines')) others.push({ icon: 'clock', label: r.name, sub: tr('Routine') + ' · ' + describeSchedule(r.schedule), go: () => showRoutine(r.id) });
    for (const s of S.sessions) if (!s.archived && s.kind !== 'routine' && (f === 'all' || f === s.kind) && hit(s.title + ' ' + s.cwd)) sessions.push({ icon: s.kind, label: s.title, sub: `${KIND_LABEL[s.kind]}${s.kind === 'chat' ? '' : ' · ' + folderName(s.cwd)} · ${ago(s.when)}`, go: () => openSession(s) });
    const box = $('searchResults'); box.innerHTML = ''; results = []; selIdx = 0;
    const section = (title, list) => { if (!list.length) return; box.appendChild(el('div', 'sh', title)); for (const r of list) { const b = el('button', 'row'); b.innerHTML = `${icon(r.icon)}<span class="t"><span class="tt"></span><small></small></span>`; b.querySelector('.tt').textContent = r.label; b.querySelector('small').textContent = r.sub; b.onclick = () => { r.go(); closeSearch(); };
      if (r.reveal) { const f = el('span', 'ib reveal'); f.innerHTML = icon('folder'); f.title = tr('Show in folder'); f.onclick = (e) => { e.stopPropagation(); send({ type: 'reveal', path: r.reveal }); }; b.appendChild(f); }
      box.appendChild(b); results.push(r); } };
    section(q ? tr('Results') : tr('Recents'), sessions.slice(0, q ? 30 : 10)); section(tr('Projects and routines'), others.slice(0, 15)); section(tr('Artifacts'), arts.slice(0, f === 'artifacts' ? 60 : 15));
    if (!q) section(tr('Actions'), [{ icon: 'plus', label: S.tab === 'chat' ? tr('New chat') : S.tab === 'cowork' ? tr('New task') : tr('New session'), sub: tr('In {space}', { space: S.tab === 'chat' ? tr('Chat') : S.tab === 'cowork' ? tr('Cowork') : tr('Code') }), go: () => showWelcome() }, { icon: 'dash', label: tr('Dashboard'), sub: tr('Spend, approvals, context'), go: showDashboard }]);
    if (!results.length) box.appendChild(el('div', 'empty-list', tr('No match.')));
    paintSel();
  }
  function paintSel() { [...$('searchResults').querySelectorAll('.row')].forEach((x, i) => x.classList.toggle('sel', i === selIdx)); }
  // e.code names the QWERTY position, so on an AZERTY Mac "M" is not KeyM: map the physical key to the letter it prints.
  const keyByCode = {}; navigator.keyboard?.getLayoutMap?.().then((m) => m.forEach((v, c) => { if (/^[vmd]$/i.test(v)) keyByCode[c] = 'Key' + v.toUpperCase(); })).catch(() => {});
  // Without the layout map (Safari, Firefox), the AZERTY "M" key sits where QWERTY has ";": accept both positions.
  const voiceKey = (e) => { const k = keyByCode[e.code] || (Object.keys(keyByCode).length ? '' : e.code === 'Semicolon' ? 'KeyM' : e.code); return ['KeyV', 'KeyM', 'KeyD'].includes(k) ? k : ''; };
  $('keysBtn').onclick = () => $('keysDlg').showModal(); $('keysClose').onclick = () => $('keysDlg').close();
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey; const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
    else if (e.key === '/' && !typing && !mod) { e.preventDefault(); openSearch(); }
    else if (e.key === '?' && !typing && !mod) { e.preventDefault(); $('keysDlg').showModal(); }
    else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); showWelcome(); }
    else if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); activeComposer().openFiles(); }
    else if (mod && e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); if (S.view === 'session' && S.info) deleteSession({ sid: S.info.sid, sdkId: S.info.sdkId, title: S.info.title }); }
    else if (mod && e.key.toLowerCase() === '.') { e.preventDefault(); if (S.view === 'session') openPanel(!paneState.progress, true); }
    // Voice shortcuts (Option + key, read from e.code since Option changes the character on a Mac):
    // ⌥V voice mode on/off, ⌥M mute / unmute the microphone in voice mode, ⌥D dictate into the composer, ⌥Space talk now.
    else if (e.altKey && !mod && (voiceKey(e) || e.code === 'Space')) {
      e.preventDefault(); const V = window.Voice; const k = e.code === 'Space' ? 'Space' : voiceKey(e);
      if (k === 'KeyV') { if (V?.isOpen()) V.close(); else document.querySelector('#viewSession:not([hidden]) .composer-box .icon.vm, #viewWelcome:not([hidden]) .composer-box .icon.vm')?.click(); }
      else if (k === 'KeyM') { if (V?.isOpen()) V.toggleMute(); }
      else if (k === 'Space') { if (V?.isOpen()) V.talkNow(); }
      else document.querySelector('#viewSession:not([hidden]) .composer-box .icon.mic, #viewWelcome:not([hidden]) .composer-box .icon.mic')?.click();
    }
    else if (e.key === 'Escape') { closeSearch(); $('menu').hidden = true; if (fullPane) setFull(fullPane, false); if (S.selecting && !S.suggesting) setSelecting(false); }
  });

  // ------------------------------------------------------------- settings
  function openSettings(page) { applySettingsToUi(); setPage(page || 'general'); $('settingsDlg').showModal(); }
  function setPage(p) { document.querySelectorAll('.set-nav button[data-p]').forEach((b) => b.classList.toggle('active', b.dataset.p === p)); document.querySelectorAll('.set-page').forEach((x) => (x.hidden = x.dataset.page !== p)); }
  document.querySelectorAll('.set-nav button[data-p]').forEach((b) => (b.onclick = () => setPage(b.dataset.p)));
  $('setSearch').oninput = () => { const q = $('setSearch').value.trim().toLowerCase(); document.querySelectorAll('.set-nav button').forEach((b) => (b.hidden = !!q && !b.textContent.toLowerCase().includes(q))); const first = q && [...document.querySelectorAll('.set-nav button[data-p]')].find((b) => !b.hidden); if (first) setPage(first.dataset.p); };
  document.querySelectorAll('.set-nav button[data-go]').forEach((b) => (b.onclick = () => { $('settingsDlg').close(); showCustomize(b.dataset.go); }));
  $('settingsClose').onclick = () => $('settingsDlg').close();
  function applySettingsToUi() {
    const s = S.settings || {};
    fillModelSelect($('setModel'), s.model || '');
    $('setEffort').value = s.effort || '';
    $('setMode').value = s.mode || 'auto'; $('setCoworkMode').value = s.coworkMode || 'auto';
    $('setBrowser').checked = s.browser !== false; $('setChatShell').checked = !!s.chatShell; $('setLang').value = s.lang || 'fr-FR'; $('setUiLang').value = store.get('uiLang', 'auto');
    $('setSpeak').checked = store.get('speak', false); $('setHandsFree').checked = store.get('handsFree', false); $('setArchived').checked = S.showArchived;
    if (document.activeElement !== $('setName')) $('setName').value = s.name || S.user || '';
    if (document.activeElement !== $('setRepo')) $('setRepo').value = s.repo || S.repo || '';
    $('setToken').placeholder = s.hasToken ? tr('Saved (enter a new one to replace)') : 'github_pat_…';
    pills('themePills', store.get('theme', 'auto')); pills('sizePills', store.get('size', 'm')); pills('widthPills', store.get('width', 'm'));
    $('aboutLine').textContent = tr('Claude Web UI {v} · runs locally on this computer · shortcuts: ⌘K or / search, ⌘N new, ⌘. panel', { v: S.version + (S.auth?.cli ? ' · ' + S.auth.cli : '') });
  }
  function pills(id, v) { document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('active', b.dataset.v === v)); }
  $('themePills').onclick = (e) => { const b = e.target.closest('button'); if (b) { store.set('theme', b.dataset.v); applyTheme(); pills('themePills', b.dataset.v); } };
  $('sizePills').onclick = (e) => { const b = e.target.closest('button'); if (b) { store.set('size', b.dataset.v); applyTheme(); pills('sizePills', b.dataset.v); } };
  $('widthPills').onclick = (e) => { const b = e.target.closest('button'); if (b) { store.set('width', b.dataset.v); applyTheme(); pills('widthPills', b.dataset.v); } };
  $('setModel').onchange = () => { const v = modelValue($('setModel')); if (v === null) { applySettingsToUi(); return; } send({ type: 'settings', model: v }); };
  $('setEffort').onchange = () => send({ type: 'settings', effort: $('setEffort').value });
  $('setName').onchange = () => send({ type: 'settings', name: $('setName').value });
  $('setRepo').onchange = () => send({ type: 'settings', repo: $('setRepo').value });
  $('setToken').onchange = () => { send({ type: 'settings', githubToken: $('setToken').value }); $('setToken').value = ''; toast(tr('Token saved.')); };
  $('setMode').onchange = () => send({ type: 'settings', mode: $('setMode').value });
  $('setCoworkMode').onchange = () => send({ type: 'settings', coworkMode: $('setCoworkMode').value });
  $('setBrowser').onchange = () => send({ type: 'settings', browser: $('setBrowser').checked });
  $('setChatShell').onchange = () => send({ type: 'settings', chatShell: $('setChatShell').checked });
  $('setLang').onchange = () => { send({ type: 'settings', lang: $('setLang').value }); setTimeout(() => window.Voice?.populateVoices(), 300); };
  // Interface language: remembered per browser like the theme; the page reloads so every string is rebuilt.
  $('setUiLang').onchange = () => { store.set('uiLang', $('setUiLang').value); location.reload(); };
  $('setSpeak').onchange = () => { store.set('speak', $('setSpeak').checked); if (!$('setSpeak').checked) speechSynthesis?.cancel(); };
  $('setHandsFree').onchange = () => { store.set('handsFree', $('setHandsFree').checked); if (!$('setHandsFree').checked) { HF.on = false; welcomeComposer.voiceIdle(); sessionComposer.voiceIdle(); } };
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
  function pickFolder(start, cb) { dlgCb = cb; pickRef = Math.random().toString(36).slice(2); send({ type: 'pickFolder', ref: pickRef, start }); toast(tr('Choose a folder in the window that opened.'), false, 2500); }
  function onPicked(m) {
    if (m.ref !== pickRef) return;
    if (m.path) { dlgCb?.(m.path); return; }
    if (m.unavailable) { send({ type: 'ls', path: S.home }); $('folderDlg').showModal(); }
  }
  $('dlgCancel').onclick = () => $('folderDlg').close();
  $('dlgChoose').onclick = () => { if (dlgCurrent && dlgCurrent !== 'drives') dlgCb?.(dlgCurrent); $('folderDlg').close(); };
  function renderDirs(m) {
    dlgCurrent = m.path; $('dlgPath').textContent = m.path === 'drives' ? tr('This PC') : m.path; $('dlgChoose').disabled = m.path === 'drives';
    const box = $('dirs'); box.innerHTML = '';
    const add = (label, p) => { const b = el('button', null, label); b.onclick = () => send({ type: 'ls', path: p }); box.appendChild(b); };
    if (m.parent) add('⬆  ' + tr('Up'), m.parent); if (m.home && m.path !== m.home) add('🏠  ' + tr('Home'), m.home);
    for (const d of m.dirs) add('📁  ' + d.name, d.path);
    if (!m.dirs.length) box.insertAdjacentHTML('beforeend', '<div class="muted" style="padding:6px 10px">' + tr('No subfolders.') + '</div>');
  }

  // ---------------------------------------------------------------- utils
  function menu(e, entries, head) {
    const m = $('menu'); m.innerHTML = ''; m.classList.remove('rich');
    if (head) m.appendChild(el('div', 'mh', head));
    for (const ent of entries) { if (!ent) { m.appendChild(el('div', 'sep')); continue; } const [label, fn, cls, keys] = ent; const b = el('button', cls || '', label); if (keys) b.appendChild(el('kbd', '', keys)); b.onclick = (ev) => { ev.stopPropagation(); m.hidden = true; fn(); }; m.appendChild(b); }
    placeMenu(e, m, entries.length);
  }
  // Menu with descriptions, check marks and right-hand text (the claude.ai model picker).
  function richMenu(e, items) {
    const m = $('menu'); m.innerHTML = ''; m.classList.add('rich');
    for (const it of items) {
      if (it.sep) { m.appendChild(el('div', 'sep')); continue; }
      const b = el('button', 'mi' + (it.check ? ' on' : ''));
      b.innerHTML = `${it.icon ? icon(it.icon) : ''}<span class="mt"><span class="ml"></span><small class="md"></small></span><span class="mr"></span>`;
      b.querySelector('.ml').textContent = it.label; b.querySelector('.md').textContent = it.desc || ''; if (!it.desc) b.querySelector('.md').remove();
      b.querySelector('.mr').innerHTML = (it.right ? `<span class="rt"></span>` : '') + (it.check ? icon('check') : '') + (it.arrow ? '<span class="arr">›</span>' : '');
      if (it.right) b.querySelector('.rt').textContent = it.right;
      b.onclick = (ev) => { ev.stopPropagation(); m.hidden = true; it.fn(); }; m.appendChild(b);
    }
    placeMenu(e, m, items.length);
  }
  function placeMenu(e, m, n) {
    m.hidden = false;
    const r = (e.currentTarget && e.currentTarget.getBoundingClientRect) ? e.currentTarget.getBoundingClientRect() : (e.target?.closest?.('button')?.getBoundingClientRect?.());
    const h = m.offsetHeight || n * 34 + 20, w = m.offsetWidth || 240;
    let x = Math.min(r ? r.left : e.clientX, window.innerWidth - w - 8), y = r ? r.bottom + 4 : e.clientY;
    if (y + h > window.innerHeight - 8) y = Math.max(8, (r ? r.top : e.clientY) - h - 4);
    m.style.left = x + 'px'; m.style.top = y + 'px';
    menuOpening = true; // the click that opened the menu is still bubbling; the document handler below lets it through
  }
  let menuOpening = false;
  document.addEventListener('click', (ev) => { if (menuOpening) { menuOpening = false; return; } if (!$('menu').contains(ev.target)) $('menu').hidden = true; });
  function toast(text, err, ms) { const t = el('div', 'toast' + (err ? ' err' : ''), text); $('toasts').appendChild(t); setTimeout(() => t.remove(), ms || (err ? 7000 : 3500)); }
  function ago(ts) { const d = Date.now() - ts; if (d < 60000) return tr('just now'); if (d < 3600000) return tr('{n} min ago', { n: Math.floor(d / 60000) }); if (d < 86400000) return tr('{n} h ago', { n: Math.floor(d / 3600000) }); if (d < 7 * 86400000) return tr('{n} d ago', { n: Math.floor(d / 86400000) }); return new Date(ts).toLocaleDateString(LOCALE); }
  function fmtWhen(ts) { const d = new Date(ts); const same = d.toDateString() === new Date().toDateString(); return (same ? tr('today') + ' ' : d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' }) + ' ') + d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }); }
  const fmtDur = (s) => (s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's');
  const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
  const shortModel = (m) => { const s = String(m || '').replace(/^(anthropic\.|us\.|eu\.|apac\.|global\.)/, '').replace(/^claude-/, '').replace(/-\d{8}.*$/, '').replace(/-v\d+:\d+$/, ''); return s || m; };
  function toLocalInput(iso) { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  function baseName(p) { return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }
  function shortPath(p) { if (!p) return ''; return S.home && p.startsWith(S.home) ? '~' + p.slice(S.home.length) : p; }

  // ---------------------------------------------------------------- start
  // voice mode (public/voice.js): what it needs from the app
  window.Voice?.init({
    lang: () => S.settings.lang || LOCALE || 'fr-FR',
    toast,
    setLang(code) { S.settings.lang = code; const sel = $('setLang'); if (sel) sel.value = code; send({ type: 'settings', lang: code }); },
    stop() { if (S.view === 'session' && S.sid) send({ type: 'stop', sid: S.sid }); },
    pane(v) { togglePane('voice', v); if (v && S.view !== 'session') newSessionFromWelcome(null); },
    // "yes" / "no" said while a permission is pending answers the oldest open prompt (Allow once, or Refuse)
    approve(allow) { const card = $('log').querySelector('.perm:not(.answered)'); if (!card) return false; const b = card.querySelectorAll('button'); (allow ? b[0] : b[b.length - 1]).click(); return true; },   // from the welcome screen: open a conversation first, the pane lives next to it
    send(text) {
      const lang = S.settings.lang || LOCALE || 'fr-FR';
      if (S.view === 'session' && S.info) {
        if (S.info.status !== 'idle') { const q = queues.get(S.sid) || []; q.push({ text, files: [], voice: true, lang }); queues.set(S.sid, q); renderQueue(); send({ type: 'stop', sid: S.sid }); }
        else send({ type: 'send', sid: S.sid, text, files: [], voice: true, lang });
      } else newSessionFromWelcome({ text, files: [], voice: true, lang });
    },
  });
  resetView(); setTab(S.tab); showWelcome(); connect();
})();
