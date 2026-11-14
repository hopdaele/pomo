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
    modes: [...document.querySelectorAll('.mode')],
  };

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

  function onPhaseEnd() {
    pulse();
  }

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
  function openPanel(name) {
    closePanel();
    const p = name === 'help' ? el.help : null;
    if (!p) return;
    panel = name;
    p.inert = false;
    p.classList.add('open');
  }
  function closePanel() {
    if (!panel) return;
    const p = panel === 'help' ? el.help : null;
    if (p) { p.classList.remove('open'); p.inert = true; }
    panel = null;
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
    if (e.repeat && k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown' && k !== '-' && k !== '+') return;
    switch (k) {
      case ' ': e.preventDefault(); press(el.toggle); toggle(); break;
      case 'r': case 'R': press(el.reset); reset(); break;
      case 's': case 'S': press(el.skip); skip(); break;
      case '1': setMode('focus'); break;
      case '2': setMode('short'); break;
      case '3': setMode('long'); break;
      case '?': panel === 'help' ? closePanel() : openPanel('help'); break;
      default: return;
    }
  });
  // stop Space/Enter keyup from re-activating a focused button
  addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });
  addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- mouse ----------
  el.toggle.addEventListener('click', toggle);
  el.reset.addEventListener('click', reset);
  el.skip.addEventListener('click', skip);
  el.modes.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#btn-help').addEventListener('click', () => (panel === 'help' ? closePanel() : openPanel('help')));
  $('#btn-close').addEventListener('click', hideToTray);
  $('#btn-min').addEventListener('click', () => { setVisible(false); win.minimize(); });
  el.help.addEventListener('click', closePanel);

  // ---------- Rust events ----------
  listen('phase-end', (e) => complete(e.payload));
  listen('win-visibility', (e) => setVisible(!!e.payload));

  // ---------- boot ----------
  root.dataset.theme = cfg.theme;
  root.dataset.phase = S.mode;
  render();
  setRing(S.total, 0);
  syncRust();
  if (!cfg.startMin) {
    win.show().then(() => win.setFocus()).catch(() => {});
  }
})();
