// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod access;

use access::Access;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::StateFlags;

/// Error text the UI recognises: the path wasn't chosen by the user.
const NOT_ALLOWED: &str = "Bento isn't allowed to use that file — open or save it with the dialog";

type AccessState = Mutex<Access>;

fn check(state: &AccessState, path: &Path) -> Result<(), String> {
    if state.lock().unwrap().allowed(path) { Ok(()) } else { Err(NOT_ALLOWED.into()) }
}

/// Read a file and hand the raw bytes to the UI (decoding happens there).
#[tauri::command]
fn read_file(state: tauri::State<'_, AccessState>, path: String) -> Result<Response, String> {
    check(&state, Path::new(&path))?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Couldn't open {}: {}", path, e))
}

/// Write raw bytes sent from the UI. The target path travels in the
/// `x-path` header (percent-encoded). Writes to a temp file first, flushes
/// it to disk, then swaps it in — so neither a failed save nor a power cut
/// leaves a half-written file behind.
#[tauri::command]
fn write_file(state: tauri::State<'_, AccessState>, request: Request<'_>) -> Result<(), String> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing file path")?;
    let path = percent_decode(raw)?;
    check(&state, Path::new(&path))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected file contents".into());
    };
    let tmp = format!("{}.bento-tmp", path);
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        // Keep the original file's permissions (e.g. read-only for others).
        if let Ok(meta) = std::fs::metadata(&path) {
            let _ = std::fs::set_permissions(&tmp, meta.permissions());
        }
        std::fs::rename(&tmp, &path)?;
        // Make the rename itself durable on systems that need it.
        #[cfg(unix)]
        if let Some(dir) = Path::new(&path).parent() {
            if let Ok(d) = std::fs::File::open(dir) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    })();
    result.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't save {}: {}", path, e)
    })
}

/// Bento's private folder for crash-recovery copies (created if missing).
fn make_recovery_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?.join("recovery");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

#[tauri::command]
fn recovery_dir(app: tauri::AppHandle) -> Result<String, String> {
    make_recovery_dir(&app)
        .map(|d| d.to_string_lossy().into_owned())
        .ok_or_else(|| "No recovery folder".into())
}

/// Names of the files in the recovery folder.
#[tauri::command]
fn list_recovery(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = make_recovery_dir(&app).ok_or("No recovery folder")?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            out.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    Ok(out)
}

/// Delete a recovery copy. Missing files are fine. Nothing outside the
/// recovery folder can be deleted.
#[tauri::command]
fn remove_file(state: tauri::State<'_, AccessState>, path: String) -> Result<(), String> {
    if !state.lock().unwrap().in_recovery(Path::new(&path)) {
        return Err(NOT_ALLOWED.into());
    }
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/* ------------------------------ dialogs ------------------------------ */

/// The Open dialog. Whatever the user picks becomes readable (and writable).
#[tauri::command]
async fn pick_open(app: tauri::AppHandle, state: tauri::State<'_, AccessState>) -> Result<Vec<String>, String> {
    let mut d = app
        .dialog()
        .file()
        .add_filter("Sheets", &["bento", "csv", "tsv", "txt", "tab"])
        .add_filter("All files", &["*"]);
    if let Some(w) = app.get_webview_window("main") {
        d = d.set_parent(&w);
    }
    let picked = d.blocking_pick_files().unwrap_or_default();
    let mut access = state.lock().unwrap();
    Ok(picked
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .filter_map(|p| access.grant(&p))
        .collect())
}

/// The Save dialog. `kind` is "bento" or "csv"; the right extension is added
/// if the user leaves it off. The chosen path becomes writable.
#[tauri::command]
async fn pick_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, AccessState>,
    suggested: String,
    kind: String,
) -> Result<Option<String>, String> {
    let mut d = app.dialog().file();
    d = if kind == "bento" {
        d.add_filter("Bento sheet", &["bento"])
    } else {
        d.add_filter("CSV", &["csv"]).add_filter("TSV", &["tsv"])
    };
    let s = Path::new(&suggested);
    if let Some(name) = s.file_name() {
        d = d.set_file_name(name.to_string_lossy());
    }
    if let Some(dir) = s.parent().filter(|p| p.is_dir()) {
        d = d.set_directory(dir);
    }
    if let Some(w) = app.get_webview_window("main") {
        d = d.set_parent(&w);
    }
    let Some(picked) = d.blocking_save_file() else { return Ok(None) };
    let mut path = picked.into_path().map_err(|e| e.to_string())?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let ok = if kind == "bento" { ext == "bento" } else { matches!(ext.as_str(), "csv" | "tsv" | "txt") };
    if !ok {
        let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        name.push(if kind == "bento" { ".bento" } else { ".csv" });
        path.set_file_name(name);
    }
    Ok(state.lock().unwrap().grant(&path))
}

/* ---------------------------- recent files ---------------------------- */

fn recent_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("recent.json"))
}

fn save_recent(app: &tauri::AppHandle, access: &Access) {
    if let Some(f) = recent_file(app) {
        if let Ok(json) = serde_json::to_string(&access.recent()) {
            let _ = std::fs::create_dir_all(f.parent().unwrap());
            let _ = std::fs::write(f, json);
        }
    }
}

#[tauri::command]
fn recent_files(state: tauri::State<'_, AccessState>) -> Vec<String> {
    state.lock().unwrap().recent()
}

#[tauri::command]
fn note_recent(app: tauri::AppHandle, state: tauri::State<'_, AccessState>, path: String) -> bool {
    let mut a = state.lock().unwrap();
    let ok = a.note_recent(Path::new(&path));
    if ok {
        save_recent(&app, &a);
    }
    ok
}

#[tauri::command]
fn forget_recent(app: tauri::AppHandle, state: tauri::State<'_, AccessState>, path: String) {
    let mut a = state.lock().unwrap();
    a.forget_recent(Path::new(&path));
    save_recent(&app, &a);
}

/// One-time move of an older version's recent list (kept in the page) into ours.
#[tauri::command]
fn import_recent(app: tauri::AppHandle, state: tauri::State<'_, AccessState>, paths: Vec<String>) -> Vec<String> {
    let mut a = state.lock().unwrap();
    if a.import_recent(&paths) {
        save_recent(&app, &a);
    }
    a.recent()
}

/// Restart after an update has been installed (on Windows the installer
/// restarts Bento itself; elsewhere it's up to us).
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/* ---------------------------- launching ---------------------------- */

/// Files the OS asked us to open before the UI was listening. On Windows
/// they come on the command line; on a Mac, Finder sends them as events.
#[derive(Default)]
struct Launch {
    ready: std::sync::atomic::AtomicBool,
    pending: Mutex<Vec<String>>,
}

/// Files passed on the command line (e.g. via "Open with" / double-click).
#[tauri::command]
fn launch_files(state: tauri::State<'_, Launch>, access: tauri::State<'_, AccessState>) -> Vec<String> {
    // Take the pending list and flip `ready` under the same lock, so a file
    // Finder sends in between can't fall through the gap.
    let mut pending = state.pending.lock().unwrap();
    let mut files = grant_all(&access, file_args(std::env::args().collect(), None));
    files.append(&mut pending);
    state.ready.store(true, std::sync::atomic::Ordering::SeqCst);
    files
}

fn grant_all(access: &AccessState, paths: Vec<String>) -> Vec<String> {
    let mut a = access.lock().unwrap();
    paths.iter().filter_map(|p| a.grant(Path::new(p))).collect()
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
        // Without this, ⌘A does nothing in text boxes (the formula bar, Find…).
        &PredefinedMenuItem::select_all(app, None)?,
    ])?;
    let window = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::maximize(app, None)?,
        &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;
    Menu::with_items(app, &[&bento, &edit, &window])
}

/// The files in an argument list (skipping the program and any flags).
/// Relative paths are taken relative to `cwd` (the launching process's
/// folder when a second copy hands its arguments over).
fn file_args(argv: Vec<String>, cwd: Option<&str>) -> Vec<String> {
    argv.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| match cwd {
            Some(dir) if Path::new(&a).is_relative() => Path::new(dir).join(&a).to_string_lossy().into_owned(),
            _ => a,
        })
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = grant_all(&app.state::<AccessState>(), file_args(argv, Some(&cwd)));
            let _ = app.emit("open-files", files);
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
        // Dropping files on the window counts as choosing them.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state = window.state::<AccessState>();
                let mut a = state.lock().unwrap();
                for p in paths {
                    a.grant(p);
                }
            }
        })
        .setup(|app| {
            let handle = app.handle();
            let recent = recent_file(handle)
                .and_then(|f| std::fs::read_to_string(f).ok())
                .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok());
            app.manage::<AccessState>(Mutex::new(Access::new(make_recovery_dir(handle), recent)));
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
            list_recovery,
            remove_file,
            pick_open,
            pick_save,
            recent_files,
            note_recent,
            forget_recent,
            import_recent,
            restart_app
        ])
        .build(tauri::generate_context!())
        .expect("error while running Bento")
        .run(|_app, _event| {
            match _event {
                // Finder double-click / "Open With" on a Mac.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let paths: Vec<String> = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    let files = grant_all(&_app.state::<AccessState>(), paths);
                    let state = _app.state::<Launch>();
                    let mut pending = state.pending.lock().unwrap();
                    if state.ready.load(std::sync::atomic::Ordering::SeqCst) {
                        drop(pending);
                        let _ = _app.emit("open-files", files);
                        if let Some(w) = _app.get_webview_window("main") {
                            let _ = w.set_focus();
                        }
                    } else {
                        pending.extend(files);
                    }
                }
                // Quitting from the Dock, or logging out, on a Mac: go through
                // the window's close so unsaved changes are asked about.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::ExitRequested { api, code: None, .. } => {
                    if let Some(w) = _app.get_webview_window("main") {
                        api.prevent_exit();
                        let _ = w.close();
                    }
                }
                _ => {}
            }
        });
}
