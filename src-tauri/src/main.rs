// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

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

/// Bento's private folder for crash-recovery copies (created if missing).
#[tauri::command]
fn recovery_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Names of the files in a folder (used only for the recovery folder).
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            out.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    Ok(out)
}

/// Delete a recovery copy. Missing files are fine.
#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Files the OS asked us to open before the UI was listening. On Windows
/// they come on the command line; on a Mac, Finder sends them as events.
#[derive(Default)]
struct Launch {
    ready: std::sync::atomic::AtomicBool,
    pending: std::sync::Mutex<Vec<String>>,
}

/// Files passed on the command line (e.g. via "Open with" / double-click).
#[tauri::command]
fn launch_files(state: tauri::State<'_, Launch>) -> Vec<String> {
    let mut files = file_args(std::env::args().collect());
    files.append(&mut state.pending.lock().unwrap());
    state.ready.store(true, std::sync::atomic::Ordering::SeqCst);
    files
}

/// The Mac menu bar. Copy/paste live here so they work in text boxes
/// (and fire the page's copy/paste events on the grid); Quit goes through
/// the window's close so unsaved changes still get asked about.
#[cfg(target_os = "macos")]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let quit = MenuItem::with_id(app, "quit", "Quit Bento", true, Some("CmdOrCtrl+Q"))?;
    let bento = Submenu::with_items(app, "Bento", true, &[
        &PredefinedMenuItem::about(app, Some("About Bento"), None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &quit,
    ])?;
    let edit = Submenu::with_items(app, "Edit", true, &[
        &PredefinedMenuItem::undo(app, None)?,
        &PredefinedMenuItem::redo(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
    ])?;
    let window = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::maximize(app, None)?,
        &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;
    Menu::with_items(app, &[&bento, &edit, &window])
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
    let builder = tauri::Builder::default().manage(Launch::default());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| mac_menu(app))
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
        });
    builder
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
        // Visibility isn't restored: the window starts hidden and the UI shows
        // it once it's in place and painted, so it never jumps or flashes.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .setup(|app| {
            // Safety net: if the UI somehow never loads, show the window anyway.
            if let Some(w) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            launch_files,
            recovery_dir,
            list_dir,
            remove_file
        ])
        .build(tauri::generate_context!())
        .expect("error while running Bento")
        .run(|_app, _event| {
            // Finder double-click / "Open With" on a Mac.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let files: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let state = _app.state::<Launch>();
                if state.ready.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = _app.emit("open-files", files);
                    if let Some(w) = _app.get_webview_window("main") {
                        let _ = w.set_focus();
                    }
                } else {
                    state.pending.lock().unwrap().extend(files);
                }
            }
        });
}
