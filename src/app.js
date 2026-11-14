'use strict';
(() => {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;
  const win = T.window.getCurrentWindow();

  const $ = (s) => document.querySelector(s);
  const root = document.documentElement;
  const C = 678.584; // 2 * PI * 108
  const LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- storage ----------
  const store = {
    get(k, d) { try { return { ...d, ...JSON.parse(localStorage.getItem(k)) }; } catch { return { ...d }; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const DEFAULTS = {
    focus: 25, short: 5, long: 15, interval: 4,
    autoStart: false, sound: true, volume: 60, notify: true,
    onTop: false, theme: 'dark', globalKeys: true, startMin: false,
  };
  const cfg = store.get('pomo.settings', DEFAULTS);

  const dayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const freshDay = () => ({ date: dayKey(), sessions: 0, minutes: 0 });
  let today = store.get('pomo.today', freshDay());
  if (today.date !== dayKey()) today = freshDay();

  // ---------- elements ----------
  const el = {
    time: $('#time'), phase: $('#phase'), ring: $('#ring'), dots: $('#dots'),
    toggle: $('#btn-toggle'), reset: $('#btn-reset'), skip: $('#btn-skip'),
    today: $('#today'), help: $('#help'), pulse: $('#pulse'), toast: $('#toast'),
    settings: $('#settings'), rows: $('#rows'), pin: $('#btn-pin'), app: $('.app'),
    modes: [...document.querySelectorAll('.mode')],
  };

  // ---------- settings model ----------
  const ROWS = [
    { k: 'focus', label: 'Focus', type: 'num', min: 1, max: 180, unit: 'min' },
    { k: 'short', label: 'Short break', type: 'num', min: 1, max: 180, unit: 'min' },
    { k: 'long', label: 'Long break', type: 'num', min: 1, max: 180, unit: 'min' },
    { k: 'interval', label: 'Long break every', type: 'num', min: 2, max: 8, unit: '' },
    { k: 'autoStart', label: 'Auto-start next', type: 'bool' },
    { k: 'sound', label: 'Sound', type: 'bool' },
    { k: 'volume', label: 'Volume', type: 'num', min: 0, max: 100, step: 5, unit: '%' },
    { k: 'notify', label: 'Notifications', type: 'bool' },
    { k: 'onTop', label: 'Always on top', type: 'bool' },
    { k: 'theme', label: 'Theme', type: 'choice', options: ['dark', 'light'] },
    { k: 'globalKeys', label: 'Global shortcuts', type: 'bool' },
    { k: 'startMin', label: 'Start minimized', type: 'bool' },
  ];
  const rowEls = {};

  function buildRows() {
    for (const r of ROWS) {
      const d = document.createElement('div');
      d.className = 'row';
      d.tabIndex = 0;
      d.dataset.k = r.k;
      d.setAttribute('role', r.type === 'bool' ? 'switch' : 'listitem');
      const val = r.type === 'num'
        ? `<button class="step" tabindex="-1" data-d="-1">‹</button><b></b>${r.unit ? `<span>${r.unit}</span>` : ''}<button class="step" tabindex="-1" data-d="1">›</button>`
        : r.type === 'bool' ? '<span class="switch"></span>'
        : `<span class="choice">${r.options.map((o) => `<span data-o="${o}">${o}</span>`).join('')}</span>`;
      d.innerHTML = `<span class="row-label">${r.label}</span><span class="row-val">${val}</span>`;
      d.addEventListener('click', (e) => {
        const step = e.target.closest('.step');
        if (step) changeRow(r, +step.dataset.d);
        else if (r.type !== 'num') changeRow(r, 1);
      });
      el.rows.appendChild(d);
      rowEls[r.k] = d;
      paintRow(r);
    }
  }

  function paintRow(r) {
    const d = rowEls[r.k];
    if (!d) return;
    const v = cfg[r.k];
    if (r.type === 'num') d.querySelector('b').textContent = v;
    else if (r.type === 'bool') d.setAttribute('aria-checked', String(!!v));
    else d.querySelectorAll('[data-o]').forEach((s) => s.classList.toggle('on', s.dataset.o === v));
  }

  function changeRow(r, dir, big) {
    let v = cfg[r.k];
    if (r.type === 'num') {
      const step = (r.step || 1) * (big ? 5 : 1);
      v = Math.min(r.max, Math.max(r.min, v + dir * step));
    } else if (r.type === 'bool') {
      v = !v;
    } else {
      const i = r.options.indexOf(v);
      v = r.options[(i + (dir < 0 ? r.options.length - 1 : 1)) % r.options.length];
    }
    setCfg(r.k, v);
  }

  function setCfg(k, v) {
    if (cfg[k] === v) return;
    cfg[k] = v;
    store.set('pomo.settings', cfg);
    paintRow(ROWS.find((r) => r.k === k));
    applyCfg(k);
  }

  let previewT = 0;
  function applyCfg(k) {
    switch (k) {
      case 'focus': case 'short': case 'long':
        if (S.mode === k && !S.running && S.remaining === S.total) {
          S.total = S.remaining = dur(k);
          syncRust();
          render();
          setRing(S.total, 0);
        }
        break;
      case 'interval': renderDots(); break;
      case 'sound': if (cfg.sound) chime('preview'); break;
      case 'volume':
        clearTimeout(previewT);
        previewT = setTimeout(() => chime('preview'), 220);
        break;
      case 'onTop':
        win.setAlwaysOnTop(cfg.onTop).catch(() => {});
        el.pin.classList.toggle('on', cfg.onTop);
        break;
      case 'theme': root.dataset.theme = cfg.theme; break;
      case 'globalKeys':
        invoke('set_global_shortcuts', { enabled: cfg.globalKeys })
          .catch((err) => toast(`In use by another app: ${err}`));
        break;
      default: break;
    }
  }

  function settingsKey(e) {
    const rows = [...el.rows.children];
    const cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.row') : null;
    const idx = rows.indexOf(cur);
    const r = cur ? ROWS.find((x) => x.k === cur.dataset.k) : null;
    switch (e.key) {
      case 'ArrowDown': rows[Math.min(rows.length - 1, idx + 1)].focus(); break;
      case 'ArrowUp': rows[Math.max(0, idx < 0 ? 0 : idx - 1)].focus(); break;
      case 'ArrowLeft': case '-': case '_': if (r) changeRow(r, -1, e.shiftKey); break;
      case 'ArrowRight': case '+': case '=': if (r) changeRow(r, 1, e.shiftKey); break;
      case 'Enter': case ' ': if (r && r.type !== 'num') changeRow(r, 1); break;
      case 'Home': rows[0].focus(); break;
      case 'End': rows[rows.length - 1].focus(); break;
      default: return false;
    }
    e.preventDefault();
    if (document.activeElement) document.activeElement.scrollIntoView({ block: 'nearest' });
    return true;
  }

  // ---------- sound: soft synthesized bell (no audio files) ----------
  let actx = null;
  let audioIdleT = 0;
  function audio() {
    if (!actx) { try { actx = new AudioContext(); } catch { return null; } }
    return actx;
  }
  function bell(ctx, out, f, t) {
    for (const [mul, amp, len] of [[1, 1, 1.9], [2.0, 0.22, 1.1], [3.01, 0.07, 0.6]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f * mul;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + len + 0.05);
    }
  }
  function chime(kind) {
    if (!cfg.sound || cfg.volume <= 0) return;
    const ctx = audio();
    if (!ctx) return;
    ctx.resume().then(() => {
      const t = ctx.currentTime + 0.04;
      const out = ctx.createGain();
      out.gain.value = (cfg.volume / 100) ** 2 * 0.35;
      out.connect(ctx.destination);
      const notes = kind === 'toBreak' ? [783.99, 659.25, 523.25]
        : kind === 'toFocus' ? [523.25, 659.25, 783.99] : [659.25];
      notes.forEach((f, i) => bell(ctx, out, f, t + i * 0.22));
      // release the audio thread when quiet -> ~0% idle CPU
      clearTimeout(audioIdleT);
      audioIdleT = setTimeout(() => ctx.suspend().catch(() => {}), 3000);
    }).catch(() => {});
  }

  // ---------- notifications ----------
  function notify(title, body) {
    if (!cfg.notify || !T.notification) return;
    const n = T.notification;
    n.isPermissionGranted()
      .then((ok) => ok || n.requestPermission().then((p) => p === 'granted'))
      .then((ok) => { if (ok) n.sendNotification({ title, body }); })
      .catch(() => {});
  }

  // ---------- timer state (all timing from timestamps) ----------
  const dur = (m) => cfg[m] * 60000;
  const S = { mode: 'focus', running: false, endAt: 0, remaining: dur('focus'), total: dur('focus'), cycle: 0, runId: 0 };
  let visible = !document.hidden;
  let tickT = 0;
  let panel = null; // 'help' | 'settings' | null

  const remainingNow = () => (S.running ? Math.max(0, S.endAt - Date.now()) : S.remaining);
  const mmss = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  function syncRust() {
    const label = S.running
      ? LABEL[S.mode]
      : `${mmss(S.remaining)} · ${LABEL[S.mode]}${S.remaining < S.total ? ' (paused)' : ''}`;
    invoke('sync_timer', { endAt: S.running ? S.endAt : null, label, id: S.runId }).catch(() => {});
  }

  function setRing(remTarget, ms, ease) {
    const off = C * Math.min(1, Math.max(0, 1 - remTarget / S.total));
    const st = el.ring.style;
    st.setProperty('--dur', `${ms}ms`);
    st.setProperty('--ring-ease', ease || 'linear');
    st.setProperty('--off', off.toFixed(2));
  }

  function renderToday() {
    el.today.textContent = `today · ${today.sessions} session${today.sessions === 1 ? '' : 's'} · ${today.minutes} min`;
  }

  function renderDots() {
    const n = Math.max(1, Math.min(8, cfg.interval));
    const filled = S.mode === 'long' ? n : S.cycle % n;
    if (el.dots.childElementCount !== n) {
      el.dots.textContent = '';
      for (let i = 0; i < n; i++) el.dots.appendChild(document.createElement('i')).className = 'dot';
    }
    [...el.dots.children].forEach((d, i) => d.classList.toggle('on', i < filled));
  }

  function render() {
    const rem = remainingNow();
    el.time.textContent = mmss(rem);
    el.phase.textContent = LABEL[S.mode];
    el.toggle.textContent = S.running ? 'Pause' : (S.remaining < S.total ? 'Resume' : 'Start');
    root.classList.toggle('running', S.running);
    el.modes.forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
    renderDots();
    renderToday();
  }

  // 1 Hz, only while running AND visible. Aligned to whole-second boundaries of remaining time.
  function tick() {
    clearTimeout(tickT);
    tickT = 0;
    if (!S.running || !visible) return;
    const rem = S.endAt - Date.now();
    if (rem <= 0) { complete(S.runId); return; }
    const d = rem % 1000 || 1000;
    el.time.textContent = mmss(rem);
    setRing(rem - d, d); // glide to where we will be at the next tick
    tickT = setTimeout(tick, d + 4);
  }

  // ---------- actions ----------
  function start() {
    if (S.running) return;
    S.running = true;
    S.endAt = Date.now() + S.remaining;
    S.runId++;
    syncRust();
    render();
    tick();
  }

  function pause() {
    if (!S.running) return;
    S.remaining = remainingNow();
    S.running = false;
    clearTimeout(tickT);
    tickT = 0;
    syncRust();
    render();
    setRing(S.remaining, 300, 'ease-out');
  }

  const toggle = () => (S.running ? pause() : start());

  function setMode(mode) {
    const changed = mode !== S.mode;
    S.running = false;
    clearTimeout(tickT);
    tickT = 0;
    S.mode = mode;
    S.total = S.remaining = dur(mode);
    root.dataset.phase = mode;
    syncRust();
    render();
    setRing(S.total, 700, 'cubic-bezier(.2,.8,.2,1)'); // sweep back to full
    if (changed && !reduceMotion.matches) {
      el.time.animate(
        [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
  }

  function reset() { setMode(S.mode); }

  function nextMode(completedFocus) {
    if (S.mode === 'focus') {
      if (completedFocus) S.cycle++;
      return completedFocus && S.cycle % cfg.interval === 0 ? 'long' : 'short';
    }
    if (S.mode === 'long') S.cycle = 0;
    return 'focus';
  }

  function skip() { setMode(nextMode(false)); }

  function complete(id) {
    if (!S.running || id !== S.runId) return; // already handled (JS tick or Rust deadline)
    const finished = S.mode;
    if (finished === 'focus') {
      if (today.date !== dayKey()) today = freshDay();
      today.sessions++;
      today.minutes += Math.round(S.total / 60000);
      store.set('pomo.today', today);
    }
    const next = nextMode(finished === 'focus');
    setMode(next);
    onPhaseEnd(finished, next);
    if (cfg.autoStart) start();
  }

  function onPhaseEnd(finished, next) {
    const mins = cfg[next];
    if (finished === 'focus') {
      notify(next === 'long' ? 'Cycle complete 🍂' : 'Focus complete',
        `${cfg.autoStart ? 'Started' : 'Time for'} a ${next === 'long' ? 'long' : 'short'} break · ${mins} min`);
    } else {
      notify('Break over', `${cfg.autoStart ? 'Focus started' : 'Back to focus'} · ${mins} min`);
    }
    chime(finished === 'focus' ? 'toBreak' : 'toFocus');
    if (visible) {
      pulse();
      if (!document.hasFocus()) win.requestUserAttention(2).catch(() => {});
    } else {
      pendingPulse = true;
    }
  }
  let pendingPulse = false;

  function pulse() {
    if (reduceMotion.matches) return;
    el.pulse.animate(
      [{ opacity: 0 }, { opacity: 0.9 }, { opacity: 0 }, { opacity: 0.6 }, { opacity: 0 }],
      { duration: 1600, easing: 'ease-in-out' },
    );
  }

  let toastT = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.toast.classList.remove('show'), 1400);
  }

  function press(btn) {
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 110);
  }

  // ---------- panels ----------
  const panelEl = (name) => (name === 'help' ? el.help : name === 'settings' ? el.settings : null);
  function openPanel(name) {
    closePanel();
    const p = panelEl(name);
    if (!p) return;
    panel = name;
    p.inert = false;
    el.app.inert = true;
    p.classList.add('open');
    if (name === 'settings') rowEls[ROWS[0].k].focus({ preventScroll: true });
  }
  function closePanel() {
    if (!panel) return;
    const p = panelEl(panel);
    if (p) { p.classList.remove('open'); p.inert = true; }
    el.app.inert = false;
    panel = null;
    if (document.activeElement) document.activeElement.blur();
  }
  const togglePanel = (name) => (panel === name ? closePanel() : openPanel(name));

  function toggleMute() {
    setCfg('sound', !cfg.sound);
    toast(cfg.sound ? 'Sound on' : 'Muted');
  }
  function toggleOnTop() {
    setCfg('onTop', !cfg.onTop);
    toast(cfg.onTop ? 'Pinned on top' : 'Unpinned');
  }

  // ---------- visibility: no per-second work while hidden/minimized ----------
  function setVisible(v) {
    if (v === visible) return;
    visible = v;
    root.classList.toggle('asleep', !v);
    if (v) {
      if (today.date !== dayKey()) today = freshDay();
      render();
      if (S.running) tick(); else setRing(S.remaining, 0);
      if (pendingPulse) { pendingPulse = false; pulse(); }
    } else {
      clearTimeout(tickT);
      tickT = 0;
    }
  }
  document.addEventListener('visibilitychange', () => setVisible(!document.hidden));

  function hideToTray() { setVisible(false); win.hide(); }

  // ---------- keyboard ----------
  addEventListener('keydown', (e) => {
    const k = e.key;
    if (e.ctrlKey && (k === 'q' || k === 'Q')) { e.preventDefault(); invoke('quit'); return; }
    if (e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(k)) { e.preventDefault(); return; } // block browser accelerators
    if (k === 'Escape') { e.preventDefault(); closePanel(); return; }
    if (k === 'Tab' && panel === 'help') { e.preventDefault(); return; }
    if (panel === 'settings' && settingsKey(e)) return;
    if (e.repeat) return;
    switch (k) {
      case ' ': e.preventDefault(); if (!panel) { press(el.toggle); toggle(); } break;
      case 'Enter': if (!panel && !document.activeElement.closest('button')) { e.preventDefault(); press(el.toggle); toggle(); } break;
      case ',': togglePanel('settings'); break;
      case 'm': case 'M': toggleMute(); break;
      case 'p': case 'P': toggleOnTop(); break;
      case 'r': case 'R': press(el.reset); reset(); break;
      case 's': case 'S': press(el.skip); skip(); break;
      case '1': setMode('focus'); break;
      case '2': setMode('short'); break;
      case '3': setMode('long'); break;
      case '?': togglePanel('help'); break;
      default: return;
    }
  });
  // first user gesture unlocks WebAudio, then park it until a chime is needed
  const unlockAudio = () => {
    const ctx = audio();
    if (ctx) ctx.resume().then(() => ctx.suspend()).catch(() => {});
    removeEventListener('keydown', unlockAudio, true);
    removeEventListener('pointerdown', unlockAudio, true);
  };
  addEventListener('keydown', unlockAudio, true);
  addEventListener('pointerdown', unlockAudio, true);
  // stop Space/Enter keyup from re-activating a focused button
  addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });
  addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- mouse ----------
  el.toggle.addEventListener('click', toggle);
  el.reset.addEventListener('click', reset);
  el.skip.addEventListener('click', skip);
  el.modes.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#btn-help').addEventListener('click', () => togglePanel('help'));
  $('#btn-settings').addEventListener('click', () => togglePanel('settings'));
  el.pin.addEventListener('click', toggleOnTop);
  $('#btn-close').addEventListener('click', hideToTray);
  $('#btn-min').addEventListener('click', () => { setVisible(false); win.minimize(); });
  el.help.addEventListener('click', closePanel);

  // ---------- Rust events ----------
  listen('phase-end', (e) => complete(e.payload));
  listen('win-visibility', (e) => setVisible(!!e.payload));
  listen('tray-action', (e) => (e.payload === 'skip' ? skip() : toggle()));

  // ---------- boot ----------
  root.dataset.theme = cfg.theme;
  root.dataset.phase = S.mode;
  buildRows();
  render();
  setRing(S.total, 0);
  syncRust();
  el.pin.classList.toggle('on', cfg.onTop);
  if (cfg.onTop) win.setAlwaysOnTop(true).catch(() => {});
  applyCfg('globalKeys');
  if (!cfg.startMin) {
    win.show().then(() => win.setFocus()).catch(() => {});
  }
})();
