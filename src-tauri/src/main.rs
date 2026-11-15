#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const TRAY_ID: &str = "pomo-tray";

/// The single phase-end deadline. JS owns all timer logic; Rust only guarantees
/// that the end fires on time even when the WebView is hidden/throttled.
#[derive(Default, Clone)]
struct Deadline {
    end_at: Option<u64>, // unix ms (same clock as JS Date.now())
    label: String,       // running: phase label; paused/idle: full tooltip text
    id: u64,
    total: u64,     // phase length, ms
    remaining: u64, // ms left when paused/idle
    phase: String,  // "focus" | "short" | "long"
    version: u64,
}

#[derive(Default)]
struct Ticker {
    state: Mutex<Deadline>,
    cv: Condvar,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn fmt_mmss(ms: u64) -> String {
    let s = ms.div_ceil(1000);
    format!("{:02}:{:02}", s / 60, s % 60)
}

/// Never call while holding the ticker lock: tray calls hop to the main thread.
fn set_tip(app: &AppHandle, tip: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tip));
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let shown = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
        if shown { hide_window(app) } else { show_window(app) }
    }
}

fn shortcut_toggle() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}
fn shortcut_window() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyP)
}

#[tauri::command]
fn set_global_shortcuts(app: AppHandle, enabled: bool) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    // Register independently so one conflict doesn't disable the other.
    let mut failed = Vec::new();
    if enabled {
        if gs.register(shortcut_toggle()).is_err() {
            failed.push("Ctrl+Alt+Space");
        }
        if gs.register(shortcut_window()).is_err() {
            failed.push("Ctrl+Alt+P");
        }
    }
    let res = if failed.is_empty() { Ok(()) } else { Err(failed.join(", ")) };
    #[cfg(debug_assertions)]
    eprintln!("[pomo] global shortcuts enabled={} -> {:?}", enabled, res);
    res
}

/// Tauri only sets the window's small icon on Windows; the taskbar reads the big one and otherwise
/// falls back to Explorer's (possibly stale) per-path icon cache. Set ICON_BIG from the exe's own
/// icon resource (id 32512, written by tauri-build) so the taskbar always matches the installed app.
#[cfg(windows)]
fn set_taskbar_icon(w: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn LoadImageW(inst: *mut c_void, name: *const u16, ty: u32, cx: i32, cy: i32, flags: u32) -> *mut c_void;
        fn SendMessageW(hwnd: *mut c_void, msg: u32, wp: usize, lp: isize) -> isize;
        fn GetSystemMetrics(i: i32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    }
    const IMAGE_ICON: u32 = 1;
    const WM_SETICON: u32 = 0x0080;
    const ICON_BIG: usize = 1;
    const SM_CXICON: i32 = 11;
    const SM_CYICON: i32 = 12;
    if let Ok(hwnd) = w.hwnd() {
        unsafe {
            let inst = GetModuleHandleW(std::ptr::null());
            let icon = LoadImageW(inst, 32512 as *const u16, IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), 0);
            if !icon.is_null() {
                SendMessageW(hwnd.0 as *mut c_void, WM_SETICON, ICON_BIG, icon as isize);
            }
        }
    }
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit("win-visibility", true);
    }
}

fn hide_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
        let _ = app.emit("win-visibility", false);
    }
}

/// JS -> Rust: running deadline (end_at) or None when paused/idle.
/// All tray/taskbar visuals are drawn by the ticker thread, so they never race.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn sync_timer(
    ticker: State<'_, Arc<Ticker>>,
    end_at: Option<u64>,
    label: String,
    id: u64,
    total: u64,
    remaining: u64,
    phase: String,
) {
    #[cfg(debug_assertions)]
    eprintln!("[pomo] {} sync end_at={:?} label={} id={} total={} rem={} phase={}", now_ms(), end_at, label, id, total, remaining, phase);
    let mut st = ticker.state.lock().unwrap();
    st.end_at = end_at;
    st.label = label;
    st.id = id;
    st.total = total.max(1);
    st.remaining = remaining;
    st.phase = phase;
    st.version += 1;
    ticker.cv.notify_all();
}

// ---------- live tray icon + taskbar progress ----------

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Idle,
    Running,
    Paused,
}

/// 3x5 pixel digits, one u16 per glyph (row-major, 15 bits).
const DIGITS: [u16; 10] = [
    0b111_101_101_101_111, 0b010_110_010_010_111, 0b111_001_111_100_111, 0b111_001_111_001_111,
    0b101_101_111_001_001, 0b111_100_111_001_111, 0b111_100_111_101_111, 0b111_001_001_001_001,
    0b111_101_111_101_111, 0b111_101_111_001_111,
];

/// 32x32 RGBA: black disc, draining phase-coloured ring, minutes left in pixel digits.
/// Pure CPU, ~16k samples, only called when the minute or ring step changes.
fn render_tray_icon(frac_left: f32, minutes: u64, accent: [u8; 3]) -> Vec<u8> {
    const S: usize = 32;
    const TRACK: [f32; 3] = [60.0, 56.0, 54.0]; // #3c3836
    let acc = [accent[0] as f32, accent[1] as f32, accent[2] as f32];
    let mut px = vec![0u8; S * S * 4];
    for y in 0..S {
        for x in 0..S {
            let (mut disc, mut track, mut arc) = (0u32, 0u32, 0u32);
            for sy in 0..4 {
                for sx in 0..4 {
                    let fx = x as f32 + (sx as f32 + 0.5) / 4.0 - 16.0;
                    let fy = y as f32 + (sy as f32 + 0.5) / 4.0 - 16.0;
                    let r = (fx * fx + fy * fy).sqrt();
                    if r <= 16.0 {
                        disc += 1;
                    }
                    if (11.5..=15.0).contains(&r) {
                        // 0 at 12 o'clock, increasing clockwise
                        let a = (fx.atan2(-fy) / std::f32::consts::TAU + 1.0) % 1.0;
                        if a <= frac_left { arc += 1 } else { track += 1 }
                    }
                }
            }
            let (t, k) = (track as f32 / 16.0, arc as f32 / 16.0);
            let i = (y * S + x) * 4;
            for c in 0..3 {
                px[i + c] = (TRACK[c] * t + acc[c] * k).min(255.0) as u8; // over black
            }
            px[i + 3] = (disc as f32 / 16.0 * 255.0) as u8;
        }
    }
    // digits: 3x5 font at 2x -> 6x10 each, 2px gap, centred, cream #ebdbb2
    let text = minutes.min(99).to_string();
    let n = text.len();
    let w = n * 6 + (n - 1) * 2;
    let (x0, y0) = ((S - w) / 2, 11);
    for (di, ch) in text.bytes().enumerate() {
        let glyph = DIGITS[(ch - b'0') as usize];
        for row in 0..5 {
            for col in 0..3 {
                if glyph >> (14 - (row * 3 + col)) & 1 == 1 {
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let (x, y) = (x0 + di * 8 + col * 2 + dx, y0 + row * 2 + dy);
                            let i = (y * S + x) * 4;
                            px[i..i + 4].copy_from_slice(&[0xeb, 0xdb, 0xb2, 0xff]);
                        }
                    }
                }
            }
        }
    }
    px
}

fn accent_for(phase: &str, kind: Kind) -> [u8; 3] {
    match (kind, phase) {
        (Kind::Paused, _) => [0xa8, 0x99, 0x84], // muted = paused
        (_, "short") => [0xb8, 0xbb, 0x26],
        (_, "long") => [0x83, 0xa5, 0x98],
        _ => [0xfe, 0x80, 0x19],
    }
}

/// Redraws the tray icon / taskbar progress only when what they show actually changes.
#[derive(Default)]
struct Visuals {
    icon_key: Option<(u8, u64, u32, u8)>, // (kind, minutes, ring step, phase)
    bar_key: Option<(u8, u64)>,           // (kind, percent)
}

impl Visuals {
    fn update(&mut self, app: &AppHandle, d: &Deadline, rem: u64, kind: Kind) {
        use tauri::window::{ProgressBarState, ProgressBarStatus};
        let total = d.total.max(1);
        let frac_left = (rem as f32 / total as f32).clamp(0.0, 1.0);
        let minutes = rem.div_ceil(60_000);
        let step = (frac_left * 64.0).ceil() as u32;
        let phase_id = match d.phase.as_str() { "short" => 1, "long" => 2, _ => 0 };

        let icon_key = if kind == Kind::Idle { (0, 0, 0, 0) } else { (kind as u8, minutes, step, phase_id) };
        if self.icon_key != Some(icon_key) {
            self.icon_key = Some(icon_key);
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let img = if kind == Kind::Idle {
                    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok()
                } else {
                    Some(tauri::image::Image::new_owned(render_tray_icon(frac_left, minutes, accent_for(&d.phase, kind)), 32, 32))
                };
                let _ = tray.set_icon(img);
            }
        }

        let pct = (((total - rem.min(total)) as f64 / total as f64) * 100.0).round() as u64;
        let bar_key = if kind == Kind::Idle { (0, 0) } else { (kind as u8, pct) };
        if self.bar_key != Some(bar_key) {
            self.bar_key = Some(bar_key);
            if let Some(w) = app.get_webview_window("main") {
                let state = match kind {
                    Kind::Idle => ProgressBarState { status: Some(ProgressBarStatus::None), progress: None },
                    Kind::Running => ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some(pct.max(1)) },
                    Kind::Paused => ProgressBarState { status: Some(ProgressBarStatus::Paused), progress: Some(pct.max(1)) },
                };
                let _ = w.set_progress_bar(state);
            }
        }
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// One thread owns the deadline and every tray/taskbar update. It parks (zero CPU) while
/// paused/idle and wakes once per displayed second while running.
fn spawn_ticker(app: AppHandle, t: Arc<Ticker>) {
    std::thread::spawn(move || {
        let mut seen = u64::MAX;
        let mut vis = Visuals::default();
        loop {
            let mut st = t.state.lock().unwrap();
            while st.end_at.is_none() && st.version == seen {
                st = t.cv.wait(st).unwrap();
            }
            let d = st.clone();
            drop(st);
            seen = d.version;
            // Never hold the lock below: tray/window calls hop to the main thread.
            match d.end_at {
                None => {
                    if d.label.is_empty() {
                        continue; // JS hasn't synced yet
                    }
                    set_tip(&app, &d.label);
                    let kind = if d.remaining < d.total { Kind::Paused } else { Kind::Idle };
                    vis.update(&app, &d, d.remaining, kind);
                }
                Some(end) => {
                    let now = now_ms();
                    if now >= end {
                        let mut st = t.state.lock().unwrap();
                        let fire = st.version == d.version && st.end_at == Some(end);
                        if fire {
                            st.end_at = None;
                        }
                        drop(st);
                        if fire {
                            #[cfg(debug_assertions)]
                            eprintln!("[pomo] {} phase-end id={} late={}ms", now, d.id, now - end);
                            let _ = app.emit("phase-end", d.id);
                        }
                        continue;
                    }
                    let rem = end - now;
                    set_tip(&app, &format!("{} · {}", fmt_mmss(rem), d.label));
                    vis.update(&app, &d, rem, Kind::Running);
                    // Sleep until the next whole-second boundary of the remaining time (or a change).
                    let wait = match rem % 1000 { 0 => 1000, r => r };
                    let st = t.state.lock().unwrap();
                    if st.version == d.version {
                        let _ = t.cv.wait_timeout(st, Duration::from_millis(wait)).unwrap();
                    }
                }
            }
        }
    });
}

fn main() {
    let ticker = Arc::new(Ticker::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, ev| {
                    #[cfg(debug_assertions)]
                    eprintln!("[pomo] hotkey {:?} {:?}", sc, ev.state());
                    if ev.state() != ShortcutState::Pressed {
                        return;
                    }
                    if *sc == shortcut_toggle() {
                        let _ = app.emit("tray-action", "toggle");
                    } else if *sc == shortcut_window() {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .manage(ticker.clone())
        .invoke_handler(tauri::generate_handler![sync_timer, quit, set_global_shortcuts])
        .setup(move |app| {
            let toggle = MenuItem::with_id(app, "toggle", "Start / Pause", true, None::<&str>)?;
            let skip = MenuItem::with_id(app, "skip", "Skip", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &skip, &sep, &quit_i])?;
            // Icons via include_bytes! so rustc tracks them: Tauri's built-in default icon is not
            // dependency-tracked and silently goes stale when the icon files change.
            let win_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?;
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_icon(win_icon);
                #[cfg(windows)]
                set_taskbar_icon(&w);
            }
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tray_icon)
                .tooltip("Pomo")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "toggle" | "skip" => {
                        let _ = app.emit("tray-action", e.id.as_ref());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;
            spawn_ticker(app.handle().clone(), ticker.clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                hide_window(window.app_handle());
            }
            WindowEvent::Focused(true) => {
                let _ = window.emit("win-visibility", true);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Pomo");
}

#[cfg(test)]
mod tests {
    /// `POMO_ICON_DUMP=<dir> cargo test` writes raw 32x32 RGBA tray frames for visual checks.
    #[test]
    fn tray_icon_renders() {
        let px = super::render_tray_icon(0.62, 18, [0xfe, 0x80, 0x19]);
        assert_eq!(px.len(), 32 * 32 * 4);
        assert_eq!(px[3], 0, "corners stay transparent");
        if let Ok(dir) = std::env::var("POMO_ICON_DUMP") {
            for (name, frac, min, acc) in [("focus", 0.62, 18, [0xfe, 0x80, 0x19]), ("short", 0.2, 1, [0xb8, 0xbb, 0x26]), ("paused", 0.9, 23, [0xa8, 0x99, 0x84])] {
                std::fs::write(format!("{dir}/{name}.rgba"), super::render_tray_icon(frac, min, acc)).unwrap();
            }
        }
    }
}
