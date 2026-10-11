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
  const PAUSE_MS = 1200;            // silence after the last words before they are sent (counted from the last interim result too, Chrome finalizes late)
  const MIN_BARGE_WORDS = 3;        // words needed to interrupt Claude while it speaks (filters noise and echo)

  let app = null;                   // bridge given by app.js: { lang(), send(text), stop(), toast(msg, bad) }
  let open = false, state = 'idle', muted = false, turnRunning = false;
  let rec = null, recActive = false, recWanted = false, recPaused = false;   // paused while Claude speaks: the microphone would hear the synthesizer
  let heard = '', interim = '', silenceTimer = 0, lastSent = '', lastSentAt = 0;
  let tagDone = false;              // the [lang:xx-XX] tag at the start of the reply has been read (or there is none)
  let waitingApproval = false;      // Claude asked for a permission: "yes" / "no" answer it

  // What the assistant says on its own, in the spoken language (not the interface language)
  const SPOKEN = {
    hello: { fr: 'Dis quelque chose, je t\'écoute.', es: 'Di algo, te escucho.', en: 'Say something, I am listening.', it: 'Di qualcosa, ti ascolto.', de: 'Sag etwas, ich höre zu.' },
    approval: { fr: 'J\'ai besoin de ton accord pour continuer. Dis « oui » pour approuver, ou « non » pour refuser.', es: 'Necesito tu aprobación para continuar. Di «sí» para aprobar o «no» para rechazar.', en: 'I need your approval to continue. Say "yes" to approve, or "no" to refuse.', it: 'Ho bisogno della tua approvazione per continuare. Di «sì» per approvare o «no» per rifiutare.', de: 'Ich brauche deine Zustimmung, um weiterzumachen. Sag „ja“ zum Genehmigen oder „nein“ zum Ablehnen.' },
    approved: { fr: 'D\'accord.', es: 'Vale.', en: 'All right.', it: 'Va bene.', de: 'In Ordnung.' },
    refused: { fr: 'Refusé.', es: 'Rechazado.', en: 'Refused.', it: 'Rifiutato.', de: 'Abgelehnt.' },
    test: { fr: 'Bonjour ! Voilà comment je vais te lire les réponses.', es: '¡Hola! Así es como te leeré las respuestas.', en: 'Hello! This is how I will sound when I read replies to you.', it: 'Ciao! Ecco come ti leggerò le risposte.', de: 'Hallo! So werde ich dir die Antworten vorlesen.' },
    code: { fr: '(code)', es: '(código)', en: '(code)', it: '(codice)', de: '(Code)' },
    link: { fr: '(lien)', es: '(enlace)', en: '(link)', it: '(link)', de: '(Link)' },
  };
  const base = () => (app ? app.lang() : 'fr-FR').slice(0, 2).toLowerCase();
  const phrase = (k) => SPOKEN[k][base()] || SPOKEN[k].en;
  // yes / no, as the recognizer writes them
  const YES = { fr: /^(oui|ouais|d'accord|ok|okay|vas-y|approuv\w*|accept\w*|autoris\w*|c'est bon)\b/i, es: /^(s[ií]|vale|ok|okay|de acuerdo|adelante|aprob\w*|acept\w*|autoriz\w*|claro)\b/i, en: /^(yes|yeah|yep|ok|okay|sure|approve\w*|allow\w*|go ahead|accept\w*)\b/i, it: /^(s[iì]|va bene|ok|okay|d'accordo|approv\w*|accett\w*|autorizz\w*|procedi)\b/i, de: /^(ja|jawohl|ok|okay|in ordnung|genehmig\w*|erlaub\w*|weiter|einverstanden)\b/i };
  const NO = { fr: /^(non|refus\w*|annul\w*|stop|arr[êe]te)\b/i, es: /^(no|rechaz\w*|cancel\w*|para|stop)\b/i, en: /^(no|nope|refuse\w*|deny|cancel\w*|stop)\b/i, it: /^(no|rifiut\w*|annull\w*|stop|ferma)\b/i, de: /^(nein|ablehn\w*|abbrech\w*|stopp?|nicht)\b/i };
  function decideApproval(text) { const t = norm(text); const b = base(); if ((YES[b] || YES.en).test(t)) return true; if ((NO[b] || NO.en).test(t)) return false; return null; }
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
    rec.onend = () => { recActive = false; if (open && recWanted && !recPaused) setTimeout(() => { if (open && recWanted && !recPaused && !recActive) tryStart(); }, 250); }; // Chrome stops by itself now and then
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
  function stopListening() { recWanted = false; recPaused = false; clearTimeout(silenceTimer); try { rec?.stop(); } catch { /* not running */ } }
  function pauseRec() { if (recPaused) return; recPaused = true; heard = ''; interim = ''; clearTimeout(silenceTimer); try { rec?.abort(); } catch { /* not running */ } }
  function resumeRec() { if (!recPaused) return; recPaused = false; setTimeout(() => { if (open && recWanted && !recPaused && !recActive) tryStart(); }, 300); }

  function isEcho(txt) { const n = norm(txt); return n.length < 8 || (spokenRecent && norm(spokenRecent).includes(n)); }
  function handleResult(fin, inter) {
    if (muted || !open || recPaused || state === 'speaking') return;   // nothing while Claude speaks: it would be the synthesizer's voice
    const txt = fin || inter;
    if (state === 'thinking' && !waitingApproval) {   // (while a permission is pending, short words like "yes" must get through)
      // barge-in: the user talks over Claude. Ignore short noises and the synthesizer's own voice picked up by the microphone.
      if (!txt || txt.split(/\s+/).length < MIN_BARGE_WORDS || isEcho(txt)) return;
      interrupt();
    }
    if (fin) {
      // Chrome finalizes words seconds after they were spoken: the interim text may already have been sent, skip the duplicate
      if (lastSent && Date.now() - lastSentAt < 6000 && norm(lastSent).includes(norm(fin))) return;
      heard = (heard ? heard.replace(/\s*$/, ' ') : '') + fin;
    }
    interim = inter;
    $('voiceTranscript').textContent = heard + (inter ? (heard ? ' ' : '') + inter : '');
    clearTimeout(silenceTimer);
    if ((heard + inter).trim()) silenceTimer = setTimeout(sendHeard, PAUSE_MS);
  }
  function sendHeard() {
    clearTimeout(silenceTimer);
    const text = (heard + (interim ? (heard ? ' ' : '') + interim : '')).trim(); if (!text || !open) return;
    heard = ''; interim = ''; lastSent = text; lastSentAt = Date.now(); $('voiceTranscript').textContent = text;
    if (waitingApproval) {   // an answer to the pending permission, not a message
      const d = decideApproval(text);
      if (d !== null && app.approve(d)) { waitingApproval = false; setState('thinking'); say(phrase(d ? 'approved' : 'refused')); return; }
    }
    $('voiceReply').textContent = '';
    buffer = ''; spokenRecent = ''; queued = 0; turnRunning = true; tagDone = false;
    setState('thinking'); app.send(text);
  }
  function interrupt() { cancelSpeech(); if (turnRunning) app.stop(); turnRunning = false; buffer = ''; heard = ''; interim = ''; setState(muted ? 'muted' : 'listening'); resumeRec(); }

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
  // The voices worth offering for a language: natural, enhanced or online ones; the basic system voices (they sound
  // robotic) only when nothing better is installed.
  function goodVoices(lang) {
    const scored = voices().map((v) => [voiceScore(v, lang), v]).filter(([sc]) => sc >= 0).sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
    const good = scored.filter(([sc]) => sc >= 20);
    return (good.length ? good : scored).map(([, v]) => v);
  }
  function pickVoice(lang) {
    const list = goodVoices(lang); if (!list.length) return null;
    const want = store.get('voiceName', '');
    return (want && list.find((v) => v.name === want)) || list[0];
  }
  const rate = () => Number(store.get('voiceRate', 1)) || 1;
  function cleanForSpeech(s) {
    return String(s)
      .replace(/```[\s\S]*?```/g, ' ' + phrase('code') + ' ').replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, phrase('link'))
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
    u.onstart = () => { spokenRecent = (spokenRecent + ' ' + plain).slice(-900); if (open) { setState('speaking'); pauseRec(); } };
    const end = () => { queued = Math.max(0, queued - 1); if (open && !queued) { if (!turnRunning) afterSpeech(); else { setState('thinking'); resumeRec(); } } };   // between sentences the microphone listens again (barge-in)
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
  function afterSpeech() { if (!open) return; heard = ''; interim = ''; setState(muted ? 'muted' : 'listening'); resumeRec(); }
  function cancelSpeech() { queued = 0; try { TTS?.cancel(); } catch { /* ignore */ } }

  // ---- spoken language: Claude starts each voice reply with [lang:xx-XX], the language it heard (the recognizer may have
  // been set to another one). The tag is removed from what is read aloud; when it differs, listening and speaking switch to it.
  const TAG = /^\s*\[lang:([a-z]{2})(?:-([a-z]{2}))?\]\s*/i;
  function readTag(final) {
    if (tagDone) return true;
    const m = buffer.match(TAG);
    if (m) {
      buffer = buffer.slice(m[0].length); tagDone = true;
      const code = m[1].toLowerCase() + (m[2] ? '-' + m[2].toUpperCase() : '');
      const cur = app.lang(); if (code.slice(0, 2) !== cur.slice(0, 2)) switchLang(code);
      return true;
    }
    if (!final && buffer.length < 24 && /^\s*(\[(l(a(n(g(:[^\]]*)?)?)?)?)?)?$/i.test(buffer)) return false;   // tag still arriving
    tagDone = true; return true;
  }
  function switchLang(code) {
    const src = $('setLang'); if (!src) return;
    const opts = [...src.options].map((o) => o.value);
    const pick = opts.find((v) => v === code) || opts.find((v) => v.slice(0, 2) === code.slice(0, 2)); if (!pick) return;
    app.setLang(pick); const sel = $('voiceLang'); if (sel) sel.value = pick;
    if (recWanted) { try { rec.stop(); } catch { /* restarts with the new language via onend */ } }
    populateVoices(); app.toast(tr('Voice mode switched to {x}', { x: src.options[opts.indexOf(pick)].textContent }));
  }

  // ---- events forwarded by app.js
  function onDelta(t) { if (!open || !turnRunning) return; buffer += t; if (readTag(false)) flushSentences(false); }
  function onAssistantText() { if (!open || !turnRunning) return; readTag(true); flushSentences(true); }
  function onDone() { if (!open) return; turnRunning = false; readTag(true); flushSentences(true); if (!queued) afterSpeech(); }
  function onStatus(status) {
    if (!open) return;
    waitingApproval = status === 'waiting';
    if (status === 'waiting') { turnRunning = true; say(phrase('approval')); }
    else if (status === 'idle' && turnRunning && !buffer && !queued) { turnRunning = false; afterSpeech(); }
  }

  // ---- view
  function openView() {
    if (!getSR()) { app.toast(tr('Voice mode needs Google Chrome or Microsoft Edge.'), true); return; }
    open = true; muted = false; heard = ''; interim = ''; buffer = ''; turnRunning = false;
    app.pane(true); document.body.classList.add('voice-open');
    $('voiceTranscript').textContent = ''; $('voiceReply').textContent = phrase('hello');
    populateLangs(); syncMute(); startListening();
  }
  function closeView() {
    if (!open) return;
    open = false; waitingApproval = false; stopListening(); cancelSpeech(); clearTimeout(silenceTimer);
    document.body.classList.remove('voice-open'); setState('idle'); app.pane(false);
  }
  function syncMute() { const b = $('voiceMute'); b.classList.toggle('on', muted); b.querySelector('span').textContent = muted ? tr('Unmute') : tr('Mute'); }
  function toggleMute() { muted = !muted; syncMute(); heard = ''; interim = ''; $('voiceTranscript').textContent = ''; if (state === 'listening' || state === 'muted') setState(muted ? 'muted' : 'listening'); }
  // "Talk" button: cut Claude off (speech and turn) and listen right away, unmuting if needed
  function talkNow() { if (muted) toggleMute(); interrupt(); }
  function orbTap() {
    if (state === 'speaking' || state === 'thinking') interrupt();
    else if ((heard + interim).trim()) sendHeard();
  }

  // ---- settings (voice picker, rate, test)
  function populateVoices() {
    const sel = $('setVoice'); if (!sel) return;
    const lang = app ? app.lang() : 'fr-FR';
    const list = goodVoices(lang);
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
    app.setLang(code); cancelSpeech(); heard = ''; interim = ''; $('voiceTranscript').textContent = '';
    if (recWanted) { try { rec.stop(); } catch { /* restarts with the new language via onend */ } }
    populateVoices();
  }
  function wireSettings() {
    const sel = $('setVoice'), r = $('setRate'), t = $('setVoiceTest');
    if (sel) sel.onchange = () => store.set('voiceName', sel.value);
    if (r) r.oninput = () => store.set('voiceRate', Number(r.value));
    if (t) t.onclick = () => { cancelSpeech(); say(phrase('test')); };
    if (TTS) { TTS.onvoiceschanged = populateVoices; populateVoices(); }
  }

  function init(bridge) {
    app = bridge;
    $('voiceEnd').onclick = closeView; $('voiceMute').onclick = toggleMute; $('voiceTalk').onclick = talkNow; $('voiceOrb').onclick = orbTap;
    $('voiceLang').onchange = (e) => changeLang(e.target.value);
    window.addEventListener('keydown', (e) => { if (open && e.key === 'Escape' && !e.target.closest?.('input, textarea, [contenteditable]')) closeView(); });
    wireSettings();
  }

  window.Voice = { init, open: openView, close: closeView, isOpen: () => open, onDelta, onAssistantText, onDone, onStatus, pickVoice, rate, populateVoices, get supported() { return !!getSR(); } };
})();
