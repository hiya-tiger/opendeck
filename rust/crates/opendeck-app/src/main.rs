#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use opendeck_core::analyze_mono;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const BUCKETS: usize = 2000;

#[derive(Serialize)]
struct Bands {
    low: Vec<f32>,
    mid: Vec<f32>,
    high: Vec<f32>,
}

#[derive(Serialize)]
struct AnalysisPayload {
    bpm: f32,
    confidence: f32,
    #[serde(rename = "beatPhase")]
    beat_phase: f32,
    duration: f32,
    peaks: Vec<f32>,
    bands: Bands,
    chroma: Vec<f32>,
    key: String,
    camelot: String,
    mode: String,
    #[serde(rename = "keyConfidence")]
    key_confidence: f32,
    #[serde(rename = "sampleRate")]
    sample_rate: f32,
}

fn payload(samples: Vec<f32>, sample_rate: f32) -> AnalysisPayload {
    let analysis = analyze_mono(&samples, sample_rate, BUCKETS);
    AnalysisPayload {
        bpm: analysis.bpm,
        confidence: analysis.confidence,
        beat_phase: analysis.beat_phase,
        duration: analysis.duration,
        peaks: analysis.peaks,
        bands: Bands {
            low: analysis.bands.low,
            mid: analysis.bands.mid,
            high: analysis.bands.high,
        },
        chroma: analysis.chroma.to_vec(),
        key: analysis.key.key.clone(),
        camelot: analysis.key.camelot.clone(),
        mode: if analysis.key.major { "major" } else { "minor" }.into(),
        key_confidence: analysis.key.confidence,
        sample_rate,
    }
}

fn analyse(samples: Vec<f32>, sample_rate: f32) -> AnalysisPayload {
    payload(samples, sample_rate)
}

fn mono_samples(track: &opendeck_audio::DecodedTrack) -> Vec<f32> {
    if track.channels.len() == 1 {
        return track.channels[0].clone();
    }
    let scale = 1.0 / track.channels.len() as f32;
    (0..track.frames)
        .map(|frame| {
            track
                .channels
                .iter()
                .map(|channel| channel[frame])
                .sum::<f32>()
                * scale
        })
        .collect()
}

fn analyse_track(track: opendeck_audio::DecodedTrack) -> AnalysisPayload {
    let samples = mono_samples(&track);
    analyse(samples, track.sample_rate as f32)
}

#[tauri::command]
async fn analyze_file(path: String) -> Result<AnalysisPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let track = opendeck_audio::decode_file(&path)
            .map_err(|error| format!("cannot decode {path}: {error}"))?;
        Ok(analyse_track(track))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn analyze_bytes(bytes: Vec<u8>) -> Result<AnalysisPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let track = opendeck_audio::decode_bytes(bytes, None).map_err(|error| error.to_string())?;
        Ok(analyse_track(track))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn analyze_bytes_raw(request: Request<'_>) -> Result<AnalysisPayload, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("expected raw audio bytes".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let track = opendeck_audio::decode_bytes(bytes, None).map_err(|error| error.to_string())?;
        Ok(analyse_track(track))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn media_fetch_raw(url: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let response = ureq::get(&url)
            .set("User-Agent", "OpenDecks/0.1 (open source DJ app)")
            .call()
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        response
            .into_reader()
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read response: {error}"))?;
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn media_fetch(url: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let response = ureq::get(&url)
            .set("User-Agent", "OpenDecks/0.1 (open source DJ app)")
            .call()
            .map_err(|error| error.to_string())?;
        let content_type = response
            .header("Content-Type")
            .unwrap_or("application/octet-stream")
            .to_string();
        let mut bytes = Vec::new();
        response
            .into_reader()
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read response: {error}"))?;
        Ok(serde_json::json!({
            "ok": true,
            "bytes": bytes,
            "type": content_type,
            "status": 200
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn recording_save(name: String, bytes: Vec<u8>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chosen = rfd::FileDialog::new()
            .set_title("Save OpenDecks mix")
            .set_file_name(&name)
            .save_file();
        match chosen {
            Some(path) => {
                fs::write(&path, &bytes)
                    .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
                Ok(serde_json::json!({ "ok": true, "path": path.display().to_string() }))
            }
            None => Ok(serde_json::json!({ "ok": false })),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn recording_save_raw(request: Request<'_>) -> Result<serde_json::Value, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("expected raw recording bytes".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let chosen = rfd::FileDialog::new()
            .set_title("Save OpenDecks mix")
            .set_file_name("opendeck-mix.webm")
            .save_file();
        match chosen {
            Some(path) => {
                fs::write(&path, &bytes)
                    .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
                Ok(serde_json::json!({ "ok": true, "path": path.display().to_string() }))
            }
            None => Ok(serde_json::json!({ "ok": false })),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn open_provider_window(
    app: &tauri::AppHandle,
    provider: &str,
    url: &str,
) -> Result<(), String> {
    let label = format!("provider-{provider}");
    let parsed: tauri::Url = url.parse().map_err(|error| format!("invalid url: {error}"))?;
    if let Some(window) = app.get_webview_window(&label) {
        window.navigate(parsed).map_err(|error| error.to_string())?;
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title(format!("OpenDecks - {provider}"))
        .inner_size(1180.0, 800.0)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn streaming_status(
    app: tauri::AppHandle,
    provider: String,
    hints: Vec<String>,
) -> Result<serde_json::Value, String> {
    let cookies = provider_cookies(&app, &provider);
    let matched: Vec<String> = hints
        .into_iter()
        .filter(|hint| cookies.iter().any(|(name, _)| name.eq_ignore_ascii_case(hint)))
        .collect();
    Ok(serde_json::json!({ "loggedIn": !matched.is_empty(), "matched": matched }))
}

fn provider_cookies(app: &tauri::AppHandle, provider: &str) -> Vec<(String, String)> {
    let window = app
        .get_webview_window(&format!("provider-{provider}"))
        .or_else(|| app.get_webview_window("main"));
    window
        .and_then(|window| window.cookies().ok())
        .unwrap_or_default()
        .into_iter()
        .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
        .collect()
}

fn cookie_header_for(app: &tauri::AppHandle, provider: &str, url: &str) -> String {
    let host = url
        .parse::<tauri::Url>()
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()));
    let cookies = app
        .get_webview_window(&format!("provider-{provider}"))
        .or_else(|| app.get_webview_window("main"))
        .and_then(|window| window.cookies().ok())
        .unwrap_or_default();
    let Some(host) = host else {
        return String::new();
    };
    cookies
        .into_iter()
        .filter(|cookie| match cookie.domain() {
            Some(domain) => {
                let domain = domain.trim_start_matches('.').to_ascii_lowercase();
                host == domain || host.ends_with(&format!(".{domain}"))
            }
            None => true,
        })
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ")
}

#[tauri::command]
async fn streaming_login(
    app: tauri::AppHandle,
    provider: String,
    url: String,
    hints: Vec<String>,
) -> Result<serde_json::Value, String> {
    open_provider_window(&app, &provider, &url).await?;
    watch_login(app.clone(), provider.clone(), hints);
    Ok(serde_json::json!({ "ok": true, "loggedIn": false }))
}

fn watch_login(app: tauri::AppHandle, provider: String, hints: Vec<String>) {
    std::thread::spawn(move || {
        for _ in 0..150 {
            std::thread::sleep(Duration::from_secs(2));
            let cookies = provider_cookies(&app, &provider);
            let matched = hints
                .iter()
                .any(|hint| cookies.iter().any(|(name, _)| name.eq_ignore_ascii_case(hint)));
            if matched {
                let _ = app.emit(
                    "streaming:login",
                    serde_json::json!({ "provider": provider, "loggedIn": true }),
                );
                return;
            }
        }
    });
}

#[tauri::command]
async fn streaming_open(
    app: tauri::AppHandle,
    provider: String,
    url: String,
    _hints: Vec<String>,
) -> Result<serde_json::Value, String> {
    open_provider_window(&app, &provider, &url).await?;
    Ok(serde_json::json!({ "ok": true, "loggedIn": false }))
}

#[tauri::command]
fn streaming_logout(_provider: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn streaming_search(
    _app: tauri::AppHandle,
    provider: String,
    _url: String,
) -> Result<serde_json::Value, String> {
    // D42: page/cookie scraping of streaming services was removed. Stream
    // sources now use official partner APIs, implemented in the Electron build.
    Err(format!("{provider}: search uses official partner APIs in the Electron build (docs/decisions.md D42)"))
}

#[allow(dead_code)]
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

#[allow(dead_code)]
fn cookie_value(app: &tauri::AppHandle, provider: &str, host: &str, name: &str) -> Option<String> {
    let window = app
        .get_webview_window(&format!("provider-{provider}"))
        .or_else(|| app.get_webview_window("main"))?;
    let cookies = window.cookies().ok()?;
    cookies
        .into_iter()
        .find(|cookie| {
            cookie.name() == name
                && cookie
                    .domain()
                    .map(|domain| {
                        let domain = domain.trim_start_matches('.').to_ascii_lowercase();
                        host == domain || host.ends_with(&format!(".{domain}"))
                    })
                    .unwrap_or(false)
        })
        .map(|cookie| cookie.value().to_string())
}

#[allow(dead_code)]
fn extract_ytmusic_tracks(body: &str) -> Vec<serde_json::Value> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let mut tracks = Vec::new();
    let mut seen = std::collections::HashSet::new();
    visit_ytmusic(&root, &mut tracks, &mut seen);
    tracks
}

fn visit_ytmusic(
    value: &serde_json::Value,
    tracks: &mut Vec<serde_json::Value>,
    seen: &mut std::collections::HashSet<String>,
) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                visit_ytmusic(item, tracks, seen);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(renderer) = map.get("musicResponsiveListItemRenderer") {
                if let Some(track) = ytmusic_track(renderer) {
                    if let Some(id) = track.get("id").and_then(|id| id.as_str()) {
                        if seen.insert(id.to_string()) {
                            tracks.push(track);
                        }
                    }
                }
                return;
            }
            for nested in map.values() {
                visit_ytmusic(nested, tracks, seen);
            }
        }
        _ => {}
    }
}

fn ytmusic_track(renderer: &serde_json::Value) -> Option<serde_json::Value> {
    let title = renderer
        .pointer("/flexColumns/0")
        .map(column_text)
        .unwrap_or_default();
    let subtitle = renderer
        .pointer("/flexColumns/1")
        .map(column_text)
        .unwrap_or_default();
    let id = renderer
        .pointer("/playlistItemData/videoId")
        .and_then(|id| id.as_str())
        .map(|id| id.to_string())
        .or_else(|| find_video_id(renderer, 0))?;
    if title.is_empty() {
        return None;
    }
    let parts: Vec<&str> = subtitle
        .split(['•', '\u{2022}'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let is_kind = |part: &str| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "song" | "video" | "album" | "single" | "ep" | "playlist" | "podcast"
        )
    };
    let artist = parts
        .iter()
        .copied()
        .find(|part| !is_kind(part) && parse_yt_duration(part) == 0)
        .unwrap_or("");
    Some(serde_json::json!({
        "id": id,
        "title": title,
        "artist": if artist.is_empty() { "Unknown artist" } else { artist },
        "durationSec": parse_yt_duration(&subtitle),
        "provider": "youtube-music",
        "url": format!("https://music.youtube.com/watch?v={id}"),
    }))
}

fn column_text(column: &serde_json::Value) -> String {
    column
        .pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs")
        .and_then(|runs| runs.as_array())
        .map(|runs| {
            runs.iter()
                .filter_map(|run| run.get("text").and_then(|text| text.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn find_video_id(value: &serde_json::Value, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match value {
        serde_json::Value::Object(map) => {
            if let Some(id) = map.get("videoId").and_then(|id| id.as_str()) {
                return Some(id.to_string());
            }
            map.values().find_map(|nested| find_video_id(nested, depth + 1))
        }
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|nested| find_video_id(nested, depth + 1)),
        _ => None,
    }
}

fn parse_yt_duration(text: &str) -> u64 {
    for token in text.split_whitespace() {
        let parts: Vec<&str> = token.split(':').collect();
        if parts.len() < 2 || parts.len() > 3 {
            continue;
        }
        if parts.iter().all(|part| part.chars().all(|char| char.is_ascii_digit())) {
            let seconds = parts
                .iter()
                .rev()
                .enumerate()
                .map(|(index, part)| part.parse::<u64>().unwrap_or(0) * 60u64.pow(index as u32))
                .sum();
            return seconds;
        }
    }
    0
}

#[derive(Clone, Default)]
struct RtmpState(Arc<Mutex<Option<Child>>>);

fn ffmpeg_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("OPENDECK_FFMPEG") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return path;
        }
    }
    PathBuf::from("ffmpeg")
}

fn ffmpeg_command() -> Command {
    let mut command = Command::new(ffmpeg_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

#[tauri::command]
fn rtmp_available() -> bool {
    ffmpeg_command()
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[tauri::command]
fn rtmp_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, RtmpState>,
    endpoint: String,
    key: String,
) -> Result<serde_json::Value, String> {
    let mut slot = state.0.lock().map_err(|_| "RTMP state is locked")?;
    if slot.is_some() {
        return Ok(serde_json::json!({ "ok": false, "detail": "already streaming" }));
    }
    if !endpoint.starts_with("rtmp://") && !endpoint.starts_with("rtmps://") {
        return Ok(serde_json::json!({
            "ok": false,
            "detail": "endpoint must be rtmp:// or rtmps://"
        }));
    }
    let target = if key.is_empty() {
        endpoint
    } else {
        format!("{}/{}", endpoint.trim_end_matches('/'), key)
    };
    let mut child = ffmpeg_command()
        .args([
            "-hide_banner",
            "-loglevel",
            "warning",
            "-i",
            "pipe:0",
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-f",
            "flv",
        ])
        .arg(&target)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot start ffmpeg: {error}"))?;

    if let Some(mut stderr) = child.stderr.take() {
        let log_app = app.clone();
        let secret = key.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).replace(&secret, "***");
                        let line: String = text.chars().take(400).collect();
                        let _ = log_app.emit("rtmp:log", line);
                    }
                }
            }
        });
    }

    *slot = Some(child);
    drop(slot);

    let shared = state.0.clone();
    let exit_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(400));
        let mut guard = match shared.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    *guard = None;
                    let _ = exit_app.emit(
                        "rtmp:exit",
                        serde_json::json!({ "code": status.code().unwrap_or(-1) }),
                    );
                    return;
                }
                Ok(None) => {}
                Err(_) => {
                    *guard = None;
                    let _ = exit_app.emit("rtmp:exit", serde_json::json!({ "code": -1 }));
                    return;
                }
            },
            None => return,
        }
    });

    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn rtmp_chunk(state: tauri::State<'_, RtmpState>, chunk: Vec<u8>) -> Result<serde_json::Value, String> {
    let mut slot = state.0.lock().map_err(|_| "RTMP state is locked")?;
    if let Some(child) = slot.as_mut() {
        if let Some(stdin) = child.stdin.as_mut() {
            if stdin.write_all(&chunk).is_ok() {
                let _ = stdin.flush();
                return Ok(serde_json::json!({ "ok": true }));
            }
        }
    }
    Ok(serde_json::json!({ "ok": false }))
}

#[tauri::command]
fn rtmp_chunk_raw(
    state: tauri::State<'_, RtmpState>,
    request: Request<'_>,
) -> Result<serde_json::Value, String> {
    let chunk = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("expected raw RTMP bytes".into()),
    };
    let mut slot = state.0.lock().map_err(|_| "RTMP state is locked")?;
    if let Some(child) = slot.as_mut() {
        if let Some(stdin) = child.stdin.as_mut() {
            if stdin.write_all(chunk).is_ok() {
                let _ = stdin.flush();
                return Ok(serde_json::json!({ "ok": true }));
            }
        }
    }
    Ok(serde_json::json!({ "ok": false }))
}

#[tauri::command]
fn rtmp_stop(state: tauri::State<'_, RtmpState>) -> Result<serde_json::Value, String> {
    let mut slot = state.0.lock().map_err(|_| "RTMP state is locked")?;
    if let Some(mut child) = slot.take() {
        child.stdin.take();
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[cfg(windows)]
fn allow_midi_permission(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2PermissionRequestedEventArgs,
        COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let _ = window.with_webview(|webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(_) => return,
        };
        let handler = PermissionRequestedEventHandler::create(Box::new(
            move |_sender: Option<ICoreWebView2>,
                  args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES;
                    if args.PermissionKind(&mut kind).is_ok()
                        && kind == COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES
                    {
                        let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    }
                }
                Ok(())
            },
        ));
        let mut token = 0;
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

fn main() {
    tauri::Builder::default()
        .manage(RtmpState::default())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                allow_midi_permission(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            analyze_file,
            analyze_bytes,
            analyze_bytes_raw,
            media_fetch,
            media_fetch_raw,
            recording_save,
            recording_save_raw,
            streaming_status,
            streaming_login,
            streaming_open,
            streaming_logout,
            streaming_search,
            rtmp_available,
            rtmp_start,
            rtmp_chunk,
            rtmp_chunk_raw,
            rtmp_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenDecks");
}



#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_downmix_averages_stereo_channels() {
        let track = opendeck_audio::DecodedTrack {
            channels: vec![vec![1.0, -1.0, 0.5], vec![0.0, 1.0, 0.5]],
            sample_rate: 48_000,
            frames: 3,
            duration: 3.0 / 48_000.0,
        };
        assert_eq!(mono_samples(&track), vec![0.5, 0.0, 0.5]);
    }

    #[test]
    fn analysis_downmix_keeps_mono_untouched() {
        let track = opendeck_audio::DecodedTrack {
            channels: vec![vec![0.25, -0.25]],
            sample_rate: 44_100,
            frames: 2,
            duration: 2.0 / 44_100.0,
        };
        assert_eq!(mono_samples(&track), vec![0.25, -0.25]);
    }
}
