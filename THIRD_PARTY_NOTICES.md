# Third-party notices

Pomo is proprietary (see [LICENSE](LICENSE)), but it is built on the open-source components below. Each component remains under its own license, and those terms take precedence for that component.

| Component | Use | License |
|---|---|---|
| [Tauri](https://github.com/tauri-apps/tauri) v2 | Application framework | MIT or Apache-2.0 |
| tauri-plugin-global-shortcut, tauri-plugin-notification, tauri-plugin-single-instance | Global hotkeys, notifications, single instance | MIT or Apache-2.0 |
| Rust crates pulled in by the above (see `src-tauri/Cargo.lock`) | Runtime dependencies | Predominantly MIT and/or Apache-2.0 |
| [Cascadia Mono](https://github.com/microsoft/cascadia-code) (latin subset, regular + bold) | UI font, bundled in `src/fonts` | SIL Open Font License 1.1 ([full text](src/fonts/OFL.txt)) |
| Microsoft Edge WebView2 Runtime | Web rendering engine. Not bundled: installed with Windows or downloaded by the installer | Microsoft Software License Terms |

To produce the full list of Rust crate licenses for a release, run `cargo install cargo-about` and then `cargo about generate` in `src-tauri/`.
