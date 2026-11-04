//! Tauri 2 deck mock: the same 4 waveforms + jog platters drawn by canvas 2D / CSS in the OS
//! webview (WebView2 / WKWebView / WebKitGTK). JS measures rAF intervals and script time and
//! reports through an invoke command; Rust prints RESULT and exits.
use std::time::Instant;
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

#[tauri::command]
fn first_frame() { println!("FIRST_FRAME {:.1}", START.get().unwrap().elapsed().as_secs_f64() * 1e3); }
#[tauri::command]
fn report(app: tauri::AppHandle, json: String) { println!("RESULT {json}"); app.exit(0); }
#[tauri::command]
fn args() -> Vec<String> { std::env::args().skip(1).collect() }

fn main() {
    START.get_or_init(Instant::now);
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![first_frame, report, args])
        .run(tauri::generate_context!())
        .expect("tauri run");
}
