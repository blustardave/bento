// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

/// Read a file and hand the raw bytes to the UI (decoding happens there).
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Couldn't open {}: {}", path, e))
}

/// Write raw bytes sent from the UI. The target path travels in the
/// `x-path` header (percent-encoded). Writes to a temp file first, then
/// swaps it in, so a failed save never leaves a half-written file.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing file path")?;
    let path = percent_decode(raw)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected file contents".into());
    };
    let tmp = format!("{}.bento-tmp", path);
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn't save {}: {}", path, e));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn't save {}: {}", path, e));
    }
    Ok(())
}

/// Files passed on the command line (e.g. via "Open with" / double-click).
#[tauri::command]
fn launch_files() -> Vec<String> {
    file_args(std::env::args().collect())
}

fn file_args(argv: Vec<String>) -> Vec<String> {
    argv.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect()
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        // A second launch (double-clicking another CSV) opens it in the
        // existing window instead of starting a new copy of the app.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let _ = app.emit("open-files", file_args(argv));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Reopen at the size/position (and maximised state) it was closed at.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![read_file, write_file, launch_files])
        .run(tauri::generate_context!())
        .expect("error while running Bento");
}
