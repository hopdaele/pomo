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
#[derive(Default)]
struct Deadline {
    end_at: Option<u64>, // unix ms (same clock as JS Date.now())
    label: String,
    id: u64,
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
#[tauri::command]
fn sync_timer(app: AppHandle, ticker: State<'_, Arc<Ticker>>, end_at: Option<u64>, label: String, id: u64) {
    #[cfg(debug_assertions)]
    eprintln!("[pomo] {} sync end_at={:?} label={} id={}", now_ms(), end_at, label, id);
    match end_at {
        Some(e) => set_tip(&app, &format!("{} · {}", fmt_mmss(e.saturating_sub(now_ms())), label)),
        None => set_tip(&app, &label),
    }
    let mut st = ticker.state.lock().unwrap();
    st.end_at = end_at;
    st.label = label;
    st.id = id;
    st.version += 1;
    ticker.cv.notify_all();
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn spawn_ticker(app: AppHandle, t: Arc<Ticker>) {
    std::thread::spawn(move || loop {
        let mut st = t.state.lock().unwrap();
        while st.end_at.is_none() {
            st = t.cv.wait(st).unwrap();
        }
        let end = st.end_at.unwrap();
        let (id, ver, label) = (st.id, st.version, st.label.clone());
        let now = now_ms();
        if now >= end {
            st.end_at = None;
            drop(st);
            #[cfg(debug_assertions)]
            eprintln!("[pomo] {} phase-end id={} late={}ms", now, id, now - end);
            let _ = app.emit("phase-end", id);
            continue;
        }
        drop(st);
        let rem = end - now;
        set_tip(&app, &format!("{} · {}", fmt_mmss(rem), label));
        // Sleep until the next whole-second boundary of the remaining time (or a change).
        let wait = match rem % 1000 { 0 => 1000, r => r };
        let st = t.state.lock().unwrap();
        if st.version == ver {
            let _ = t.cv.wait_timeout(st, Duration::from_millis(wait)).unwrap();
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
