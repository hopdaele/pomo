Build "Pomo": a Windows 10/11 Pomodoro desktop app. Priorities in order: lightweight, smooth, keyboard-first, cozy.

STACK (fixed, don't deviate)
- Tauri v2 (Rust) + plain HTML/CSS/JS. No framework, no bundler, no UI/CSS libs. Only npm devDependency: @tauri-apps/cli. frontendDist=./src, withGlobalTauri=true.
- Rust plugins only: global-shortcut, notification, single-instance. Timer logic lives in JS.
- Release profile: opt-level="s", lto=true, codegen-units=1, panic="abort", strip=true.
- Bundle Cascadia Mono (woff2, regular+bold, latin subset, OFL) in src/fonts. font-family: "Cascadia Mono", Consolas, monospace, used everywhere.

WINDOW
- Frameless, 360x520, fixed size, centered. Custom titlebar (drag region, minimize, close = hide to tray). Remember always-on-top state.
- Tray icon: tooltip "MM:SS · Focus" (update 1Hz while running only), left-click toggles window, menu: Start/Pause, Skip, Quit.

TIMER
- Modes: Focus 25, Short 5, Long 15; long break after every 4 focus sessions. All configurable (1-180 min).
- Compute from timestamps (endAt - Date.now()), never count ticks. Survives sleep/throttling. Text ticks at 1Hz; no timers run while paused.
- Phase end must fire on time while hidden to tray. Test it; if WebView throttles, move the single end timer into Rust.
- Auto-start next phase: setting, default off.
- Phase end: native toast + soft chime synthesised with WebAudio (no audio files) + window pulse. Volume setting + mute.
- UI: big MM:SS, phase label, 4 session dots, today's completed focus sessions + focus minutes (localStorage, resets at local midnight).

KEYBOARD (show in a "?" overlay and as tiny hints under buttons)
Space start/pause · R reset · S skip · 1/2/3 Focus/Short/Long · , settings · Esc close panel · M mute · P always-on-top · ? shortcuts · Ctrl+Q quit
Global (toggleable, defaults): Ctrl+Alt+Space start/pause, Ctrl+Alt+P show/hide.
Settings panel fully keyboard-operable: ↑/↓ move between rows, ←/→ or -/+ change values, Enter/Space toggles, Tab works too, clear focus ring, Esc closes.
Settings: durations, long-break interval, auto-start, sound on/off + volume, notifications, always-on-top, theme (dark/light), global shortcuts, start minimized. Persist on change (localStorage).

THEME: gruvbox, warm and cozy
Dark (default): bg #1d2021, surface #282828, raised #3c3836, border #504945, fg #ebdbb2, muted #a89984.
Phase accents: Focus #fe8019 (ring gradient to #fb4934), Short #b8bb26, Long #83a598.
Light: bg #fbf1c7, surface #f2e5bc, fg #3c3836, accents #af3a03 / #98971a / #458588.
All colours are CSS variables. Theme/phase switch = variable change with a 400ms transition. Radius 10-14px, soft shadows, subtle warm vignette only.

ANIMATION (60fps, GPU-only)
- Animate only transform/opacity/stroke-dashoffset. No layout-triggering props. No rAF loops.
- SVG progress ring: dashoffset updated at 1Hz with CSS transition 1s linear (looks continuous, zero rAF).
- Phase change: colour crossfade + ring sweep + digits fade/slide 200ms. Button press scale .96. Settings panel slide-up + fade 220ms, cubic-bezier(.2,.8,.2,1). Gentle ring glow "breathing" (opacity, 4s) while running.
- Honor prefers-reduced-motion. When the window is hidden/minimized, pause animations and do no per-second DOM work; resync on show.

PERF TARGETS (measure and report, don't guess)
Installer < 10 MB, ~0% CPU when idle/paused/hidden, < 80 MB RAM including WebView2 children, cold start < 500 ms. No console output in release.

WORKFLOW (fully autonomous, one run)
1. Check prerequisites (node, rustc/cargo, git, MSVC Build Tools C++ workload, WebView2). Install anything missing via winget, silently where possible. After installs, refresh PATH in-session ($env:Path = [Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")) or use full paths. Don't stop to ask.
2. No plan approval, no questions, no stopping between phases. Pick sensible defaults and note them in the final report.
3. Build in order: A) scaffold+window+timer+ring+core keys, B) settings+persistence+sound+notification+tray+global shortcuts, C) animation polish+perf pass. After each phase: build, launch, confirm no errors, `git commit`. Fix errors yourself.
4. Finish with `npx tauri build`. Report the installer path, size, and measured idle RAM/CPU.
5. Use Edit for changes, never rewrite whole files, don't re-read files you just wrote. README max 10 lines.
6. Final report max 10 lines: what works, measured numbers, anything unverified (e.g. tray, global shortcuts, end-of-phase while hidden).