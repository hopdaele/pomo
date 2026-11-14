#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

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

#[allow(dead_code)]
fn fmt_mmss(ms: u64) -> String {
    let s = ms.div_ceil(1000);
    format!("{:02}:{:02}", s / 60, s % 60)
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
fn sync_timer(ticker: State<'_, Arc<Ticker>>, end_at: Option<u64>, label: String, id: u64) {
    #[cfg(debug_assertions)]
    eprintln!("[pomo] {} sync end_at={:?} label={} id={}", now_ms(), end_at, label, id);
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
        let (id, ver) = (st.id, st.version);
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
        .manage(ticker.clone())
        .invoke_handler(tauri::generate_handler![sync_timer, quit])
        .setup(move |app| {
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
