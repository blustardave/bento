//! Which files the page is allowed to read and write.
//!
//! The UI runs untrusted content (the files it opens), so the file commands
//! don't take arbitrary paths. A path becomes usable only when the *user*
//! picked it: in an Open/Save dialog, by double-clicking or dropping a file,
//! or by opening it from the recent list (which only ever holds such paths).
//! Bento's own crash-recovery folder is always usable, but nothing outside it.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

/// How many recent files are remembered (and stay openable without a dialog).
pub const MAX_RECENT: usize = 20;

/// An absolute, tidied-up path (`.` and `..` resolved without touching the disk).
pub fn normalize(p: &Path) -> Option<PathBuf> {
    let abs = std::path::absolute(p).ok()?;
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    if out.is_absolute() { Some(out) } else { None }
}

/// Paths compare case-insensitively on Windows and macOS (their usual file systems).
fn key(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if cfg!(any(windows, target_os = "macos")) { s.to_lowercase() } else { s }
}

#[derive(Default)]
pub struct Access {
    granted: HashSet<String>,
    /// Most recent first, as the user would see them.
    recent: Vec<String>,
    recovery: Option<PathBuf>,
    /// The one-time import of an older version's recent list is still open.
    can_import: bool,
}

impl Access {
    pub fn new(recovery: Option<PathBuf>, recent: Option<Vec<String>>) -> Self {
        let mut a = Access { recovery: recovery.and_then(|r| normalize(&r)), can_import: recent.is_none(), ..Default::default() };
        for p in recent.unwrap_or_default().into_iter().take(MAX_RECENT) {
            if let Some(n) = normalize(Path::new(&p)) {
                a.granted.insert(key(&n));
                a.recent.push(n.to_string_lossy().into_owned());
            }
        }
        a
    }

    /// The user chose this file: the page may now use it. Returns the tidied path.
    pub fn grant(&mut self, p: &Path) -> Option<String> {
        let n = normalize(p)?;
        self.granted.insert(key(&n));
        Some(n.to_string_lossy().into_owned())
    }

    /// A file directly inside the recovery folder (no subfolders, no escaping it).
    pub fn in_recovery(&self, p: &Path) -> bool {
        let (Some(dir), Some(n)) = (self.recovery.as_ref(), normalize(p)) else { return false };
        n.parent().map(|parent| key(parent) == key(dir)).unwrap_or(false) && n.file_name().is_some()
    }

    pub fn allowed(&self, p: &Path) -> bool {
        self.in_recovery(p) || normalize(p).map(|n| self.granted.contains(&key(&n))).unwrap_or(false)
    }

    pub fn recent(&self) -> Vec<String> {
        self.recent.clone()
    }

    /// Put a file at the top of the recent list. Only files the user already chose qualify.
    pub fn note_recent(&mut self, p: &Path) -> bool {
        let Some(n) = normalize(p) else { return false };
        if !self.granted.contains(&key(&n)) || self.in_recovery(&n) {
            return false;
        }
        let k = key(&n);
        self.recent.retain(|x| key(Path::new(x)) != k);
        self.recent.insert(0, n.to_string_lossy().into_owned());
        self.recent.truncate(MAX_RECENT);
        true
    }

    pub fn forget_recent(&mut self, p: &Path) {
        if let Some(n) = normalize(p) {
            let k = key(&n);
            self.recent.retain(|x| key(Path::new(x)) != k);
        }
    }

    /// Bring over the recent list an older Bento kept in the page. Allowed once,
    /// only when there's no list of our own yet, and only for existing sheet files.
    pub fn import_recent(&mut self, list: &[String]) -> bool {
        if !self.can_import {
            return false;
        }
        self.can_import = false;
        for p in list.iter().take(8).rev() {
            let path = Path::new(p);
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if !matches!(ext.as_str(), "bento" | "csv" | "tsv" | "txt" | "tab") || !path.is_file() {
                continue;
            }
            if self.grant(path).is_some() {
                self.note_recent(path);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("bento-access-{}", std::process::id()));
        std::fs::create_dir_all(d.join("recovery")).unwrap();
        d
    }

    #[test]
    fn only_granted_paths_are_allowed() {
        let d = tmp();
        let mut a = Access::new(Some(d.join("recovery")), Some(vec![]));
        let file = d.join("data.csv");
        assert!(!a.allowed(&file));
        a.grant(&file);
        assert!(a.allowed(&file));
        assert!(a.allowed(&d.join("sub").join("..").join("data.csv")), "same file via ..");
        assert!(!a.allowed(&d.join("other.csv")));
    }

    #[test]
    fn recovery_folder_but_nothing_outside_it() {
        let d = tmp();
        let a = Access::new(Some(d.join("recovery")), Some(vec![]));
        assert!(a.allowed(&d.join("recovery").join("abc.bento")));
        assert!(!a.allowed(&d.join("recovery").join("..").join("evil.cmd")));
        assert!(!a.allowed(&d.join("recovery").join("sub").join("x.bento")));
        assert!(!a.allowed(&d.join("recovery")));
    }

    #[test]
    fn recent_list_only_takes_granted_files() {
        let d = tmp();
        let mut a = Access::new(None, Some(vec![]));
        assert!(!a.note_recent(&d.join("x.csv")));
        a.grant(&d.join("x.csv"));
        assert!(a.note_recent(&d.join("x.csv")));
        assert_eq!(a.recent().len(), 1);
        // A saved recent list is trusted on the next run.
        let b = Access::new(None, Some(a.recent()));
        assert!(b.allowed(&d.join("x.csv")));
    }

    #[test]
    fn import_happens_once_and_only_for_real_sheet_files() {
        let d = tmp();
        let real = d.join("real.csv");
        std::fs::write(&real, "a,b").unwrap();
        let mut a = Access::new(None, None);
        let list = vec![real.to_string_lossy().into_owned(), d.join("missing.csv").to_string_lossy().into_owned(), "C:\\Windows\\win.ini".into()];
        assert!(a.import_recent(&list));
        assert!(a.allowed(&real));
        assert!(!a.allowed(&d.join("missing.csv")));
        assert!(!a.import_recent(&list), "second import refused");
        // With a list already saved, no import at all.
        let mut b = Access::new(None, Some(vec![]));
        assert!(!b.import_recent(&list));
    }
}
