# Pomo
Tiny keyboard-first Pomodoro timer for Windows 10/11 (Tauri v2 + plain HTML/CSS/JS), flat true-black gruvbox theme.

- Dev: `npm install` then `npx tauri dev` · Release + NSIS installer: `npx tauri build`
- Keys: Space start/pause · R reset · S skip · 1/2/3 modes · , settings · M mute · P pin · ? help · Ctrl+Q quit
- Global: Ctrl+Alt+Space start/pause, Ctrl+Alt+P show/hide (toggle in settings)
- Timer logic is in `src/app.js` (timestamp-based); `src-tauri/src/main.rs` holds the single phase-end deadline + tray tooltip so ends fire on time while hidden.
- WebView2 runs with software compositing (`--disable-gpu`) because it measured lower RAM and much lower CPU than GPU mode for this small window.
- Font: Cascadia Mono (SIL OFL, `src/fonts/OFL.txt`).
