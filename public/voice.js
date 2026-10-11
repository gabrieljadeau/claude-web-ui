/* Claude Web UI — voice mode: a hands-free spoken conversation, like the voice mode of the claude.ai apps.
   Speech recognition and synthesis come from the browser (Chrome / Edge); the words go to Claude as a normal
   message and the reply is read aloud sentence by sentence while it streams. Loaded before app.js, which
   wires it with Voice.init() and forwards the streaming events. */
(() => {
  const tr = (k, v) => (window.I18N?.t ? window.I18N.t(k, v) : k);
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cwui.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cwui.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const getSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  const TTS = window.speechSynthesis;
  const PAUSE_MS = 1400;            // silence after the last words before they are sent
  const MIN_BARGE_WORDS = 3;        // words needed to interrupt Claude while it speaks (filters noise and echo)

  let app = null;                   // bridge given by app.js: { lang(), send(text), stop(), toast(msg, bad) }
  let open = false, state = 'idle', muted = false, turnRunning = false;
  let rec = null, recActive = false, recWanted = false;
  let heard = '', silenceTimer = 0;
  let buffer = '', spokenRecent = '', queued = 0;

  const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const LABEL = { idle: '', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking… tap the circle to interrupt', muted: 'Microphone off' };
  function setState(s) {
    state = s; const v = $('voiceView'); if (!v) return;
    v.dataset.state = s; $('voiceStatus').textContent = LABEL[s] ? tr(LABEL[s]) : '';
  }

  // ---- recognition
  function ensureRec() {
    if (rec) return rec;
    rec = new (getSR())(); rec.continuous = true; rec.interimResults = true;
    rec.onstart = () => { recActive = true; };
    rec.onend = () => { recActive = false; if (open && recWanted) setTimeout(() => { if (open && recWanted && !recActive) tryStart(); }, 250); }; // Chrome stops by itself now and then
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { recWanted = false; app.toast(tr('Microphone access was blocked. Allow it in the address bar and try again.'), true); closeView(); }
    };
    rec.onresult = (e) => {
      let fin = '', inter = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) fin += x[0].transcript; else inter += x[0].transcript; }
      handleResult(fin.trim(), inter.trim());
    };
    return rec;
  }
  function tryStart() { rec.lang = app.lang(); try { rec.start(); } catch { /* already started */ } }
  function startListening() { recWanted = true; ensureRec(); tryStart(); if (state !== 'speaking' && state !== 'thinking') setState(muted ? 'muted' : 'listening'); }
  function stopListening() { recWanted = false; clearTimeout(silenceTimer); try { rec?.stop(); } catch { /* not running */ } }

  function isEcho(txt) { const n = norm(txt); return n.length < 8 || (spokenRecent && norm(spokenRecent).includes(n)); }
  function handleResult(fin, inter) {
    if (muted || !open) return;
    const txt = fin || inter;
    if (state === 'speaking' || state === 'thinking') {
      // barge-in: the user talks over Claude. Ignore short noises and the synthesizer's own voice picked up by the microphone.
      if (!txt || txt.split(/\s+/).length < MIN_BARGE_WORDS || isEcho(txt)) return;
      interrupt();
    }
    if (fin) heard = (heard ? heard.replace(/\s*$/, ' ') : '') + fin;
    $('voiceTranscript').textContent = heard + (inter ? (heard ? ' ' : '') + inter : '');
    clearTimeout(silenceTimer);
    if (heard && !inter) silenceTimer = setTimeout(sendHeard, PAUSE_MS);
  }
  function sendHeard() {
    clearTimeout(silenceTimer);
    const text = heard.trim(); if (!text || !open) return;
    heard = ''; $('voiceTranscript').textContent = text; $('voiceReply').textContent = '';
    buffer = ''; spokenRecent = ''; queued = 0; turnRunning = true;
    setState('thinking'); app.send(text);
  }
  function interrupt() { cancelSpeech(); if (turnRunning) app.stop(); turnRunning = false; buffer = ''; heard = ''; setState(muted ? 'muted' : 'listening'); }

  // ---- synthesis
  function voices() { return TTS ? TTS.getVoices() : []; }
  // Quality order: the voice chosen in Settings, then the browser's online neural voices (Edge: "… Online (Natural)",
  // Chrome: "Google …"), then enhanced local voices, then anything in the language.
  const NATURAL = /online \(natural\)|\bnatural\b|\bneural\b|^google /i, ENHANCED = /enhanced|premium|siri/i;
  const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|kathy|fred|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;  // macOS novelty / toy voices
  function voiceScore(v, lang) {
    const base = (lang || '').slice(0, 2).toLowerCase(); const vl = (v.lang || '').toLowerCase();
    if (!vl.startsWith(base)) return -1;
    if (NOVELTY.test(v.name)) return -1;
    let s = vl === lang.toLowerCase() ? 10 : 0;
    if (NATURAL.test(v.name)) s += 100; else if (ENHANCED.test(v.name)) s += 50; else if (!v.localService) s += 20;
    return s;
  }
  function pickVoice(lang) {
    const all = voices(); if (!all.length) return null;
    const want = store.get('voiceName', '');
    const chosen = want && all.find((v) => v.name === want && voiceScore(v, lang) >= 0); if (chosen) return chosen;
    return all.map((v) => [voiceScore(v, lang), v]).filter(([sc]) => sc >= 0).sort((a, b) => b[0] - a[0])[0]?.[1] || null;
  }
  const rate = () => Number(store.get('voiceRate', 1)) || 1;
  function cleanForSpeech(s) {
    return String(s)
      .replace(/```[\s\S]*?```/g, ' ' + tr('(code)') + ' ').replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, tr('(link)'))
      .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '').replace(/^\s*\|.*\|\s*$/gm, (l) => l.split('|').filter((c) => c.trim() && !/^[\s:-]+$/.test(c)).map((c) => c.trim()).join(', '))
      .replace(/[*_>~]/g, '').replace(/[ \t]+/g, ' ').trim();
  }
  // Chrome's online (Google) voices stop after ~15 s of audio: keep each utterance short, cutting at punctuation.
  function chunks(plain, max = 170) {
    const out = []; let rest = plain;
    while (rest.length > max) {
      let cut = -1; for (const re of [/[.!?…]\s/g, /[;:,]\s/g, /\s/g]) { let m; while ((m = re.exec(rest)) && m.index < max) cut = m.index + 1; if (cut > 20) break; cut = -1; }
      if (cut < 0) cut = max;
      out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
  }
  function say(text) {
    if (!TTS) return;
    const whole = cleanForSpeech(text); if (!whole) return;
    for (const part of chunks(whole)) sayOne(part);
  }
  function sayOne(plain) {
    const u = new SpeechSynthesisUtterance(plain); u.lang = app.lang(); const v = pickVoice(u.lang); if (v) u.voice = v; u.rate = rate();
    queued++;
    u.onstart = () => { spokenRecent = (spokenRecent + ' ' + plain).slice(-900); if (open) setState('speaking'); };
    const end = () => { queued = Math.max(0, queued - 1); if (open && !queued && !turnRunning) afterSpeech(); };
    u.onend = end; u.onerror = end;
    TTS.speak(u);
    const r = $('voiceReply'); if (r) { r.textContent += (r.textContent ? ' ' : '') + plain; r.scrollTop = r.scrollHeight; }
  }
  function flushSentences(final) {
    // speak whole sentences as they arrive; keep the unfinished tail for the next delta
    let text = buffer;
    if (!final) {
      const m = text.match(/^[\s\S]*?[.!?…][»")\]]*\s(?=\S)|^[\s\S]*?\n+(?=\S)/); // through the last complete sentence or paragraph
      if (!m) return;
      let cut = m[0].length; const more = text.slice(cut).match(/^[\s\S]*[.!?…][»")\]]*\s(?=\S)|^[\s\S]*\n+(?=\S)/); if (more) cut += more[0].length;
      text = buffer.slice(0, cut); buffer = buffer.slice(cut);
    } else buffer = '';
    if (text.trim()) say(text);
  }
  function afterSpeech() { if (!open) return; heard = ''; setState(muted ? 'muted' : 'listening'); }
  function cancelSpeech() { queued = 0; try { TTS?.cancel(); } catch { /* ignore */ } }

  // ---- events forwarded by app.js
  function onDelta(t) { if (!open || !turnRunning) return; buffer += t; flushSentences(false); }
  function onAssistantText() { if (!open || !turnRunning) return; flushSentences(true); }
  function onDone() { if (!open) return; turnRunning = false; flushSentences(true); if (!queued) afterSpeech(); }
  function onStatus(status) {
    if (!open) return;
    if (status === 'waiting') { turnRunning = true; say(tr('I need your approval in the chat before I can continue.')); }
    else if (status === 'idle' && turnRunning && !buffer && !queued) { turnRunning = false; afterSpeech(); }
  }

  // ---- view
  function openView() {
    if (!getSR()) { app.toast(tr('Voice mode needs Google Chrome or Microsoft Edge.'), true); return; }
    open = true; muted = false; heard = ''; buffer = ''; turnRunning = false;
    const v = $('voiceView'); v.hidden = false; document.body.classList.add('voice-open');
    $('voiceTranscript').textContent = ''; $('voiceReply').textContent = tr('Say something, I am listening.');
    populateLangs(); syncMute(); startListening();
  }
  function closeView() {
    if (!open) return;
    open = false; stopListening(); cancelSpeech(); clearTimeout(silenceTimer);
    $('voiceView').hidden = true; document.body.classList.remove('voice-open'); setState('idle');
  }
  function syncMute() { const b = $('voiceMute'); b.classList.toggle('on', muted); b.querySelector('span').textContent = muted ? tr('Unmute') : tr('Mute'); }
  function toggleMute() { muted = !muted; syncMute(); heard = ''; $('voiceTranscript').textContent = ''; if (state === 'listening' || state === 'muted') setState(muted ? 'muted' : 'listening'); }
  function orbTap() {
    if (state === 'speaking' || state === 'thinking') interrupt();
    else if (heard.trim()) sendHeard();
  }

  // ---- settings (voice picker, rate, test)
  function populateVoices() {
    const sel = $('setVoice'); if (!sel) return;
    const lang = app ? app.lang() : 'fr-FR';
    const list = voices().map((v) => [voiceScore(v, lang), v]).filter(([sc]) => sc >= 0).sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).map(([, v]) => v);
    const cur = store.get('voiceName', '');
    sel.innerHTML = '';
    const o = document.createElement('option'); o.value = ''; o.textContent = tr('Automatic (best available)'); sel.appendChild(o);
    for (const v of list) { const x = document.createElement('option'); x.value = v.name; x.textContent = (NATURAL.test(v.name) ? '★ ' : '') + `${v.name} (${v.lang})`; if (v.name === cur) x.selected = true; sel.appendChild(x); }
    const r = $('setRate'); if (r) r.value = rate();
  }
  function populateLangs() {
    const sel = $('voiceLang'), src = $('setLang'); if (!sel || !src) return;
    sel.innerHTML = ''; for (const o of src.options) { const x = document.createElement('option'); x.value = o.value; x.textContent = o.textContent; sel.appendChild(x); }
    sel.value = app.lang();
  }
  function changeLang(code) {
    app.setLang(code); cancelSpeech(); heard = ''; $('voiceTranscript').textContent = '';
    if (recWanted) { try { rec.stop(); } catch { /* restarts with the new language via onend */ } }
    populateVoices();
  }
  function wireSettings() {
    const sel = $('setVoice'), r = $('setRate'), t = $('setVoiceTest');
    if (sel) sel.onchange = () => store.set('voiceName', sel.value);
    if (r) r.oninput = () => store.set('voiceRate', Number(r.value));
    if (t) t.onclick = () => { cancelSpeech(); say(tr('Hello! This is how I will sound when I read replies to you.')); };
    if (TTS) { TTS.onvoiceschanged = populateVoices; populateVoices(); }
  }

  function init(bridge) {
    app = bridge;
    $('voiceClose').onclick = closeView; $('voiceEnd').onclick = closeView; $('voiceText').onclick = closeView;
    $('voiceMute').onclick = toggleMute; $('voiceOrb').onclick = orbTap;
    $('voiceLang').onchange = (e) => changeLang(e.target.value);
    window.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') closeView(); });
    wireSettings();
  }

  window.Voice = { init, open: openView, close: closeView, isOpen: () => open, onDelta, onAssistantText, onDone, onStatus, pickVoice, rate, populateVoices, get supported() { return !!getSR(); } };
})();
