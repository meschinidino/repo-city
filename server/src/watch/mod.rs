//! Filesystem watcher ground truth (design D8/T4): `notify` plus
//! `git status`. CLI events carry intent only; a file counts as
//! touched when the watcher or git says so, including edits made by
//! shell commands that no CLI event names.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};

use crate::events::{ChangeKind, EventPayload};

/// One debounced file change, path relative to the watched root.
#[derive(Debug, Clone, PartialEq)]
pub struct FileChange {
    pub path: String,
    pub change: ChangeKind,
}

fn kind_of(kind: &EventKind) -> Option<ChangeKind> {
    match kind {
        notify::EventKind::Create(_) => Some(ChangeKind::Created),
        notify::EventKind::Remove(_) => Some(ChangeKind::Deleted),
        notify::EventKind::Modify(_) => Some(ChangeKind::Modified),
        _ => None,
    }
}

fn is_noise(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == ".git")
}

/// Files changed per `git status`, for the polling backstop and for
/// tests that prove shell-only edits are seen. Paths are relative to
/// `root`; untracked files count as created.
pub fn git_status_changes(root: &Path) -> Result<Vec<FileChange>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain=v1", "-z"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Porcelain -z entries are "XY <path>"; renames/copies carry a
    // second NUL-separated field with the original path, consumed here
    // so it is never parsed as a bogus entry of its own.
    let mut entries = text.split('\0').peekable();
    let mut changes = Vec::new();
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = &entry[..2];
        let path = entry[3..].to_string();
        if code.contains('R') || code.contains('C') {
            let _ = entries.next(); // original path of the rename/copy
        }
        let change = if code == "??" {
            ChangeKind::Created
        } else if code.contains('D') {
            ChangeKind::Deleted
        } else {
            ChangeKind::Modified
        };
        changes.push(FileChange { path, change });
    }
    Ok(changes)
}

/// A running watcher. Dropping it (or calling `stop`) ends the
/// debounce thread; pending changes inside the window are flushed
/// first only on a clean stop.
pub struct RepoWatcher {
    stop: Arc<AtomicBool>,
    _watcher: RecommendedWatcher,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl RepoWatcher {
    /// Watch `root` recursively; every debounced change is handed to
    /// `sink` as a normalized `FileTouched` payload.
    pub fn spawn<F>(root: &Path, debounce: Duration, sink: F) -> Result<RepoWatcher, String>
    where
        F: Fn(EventPayload) + Send + 'static,
    {
        // Canonicalize so event paths (which the OS reports resolved,
        // e.g. /private/var on macOS) strip against the same root.
        let root: PathBuf = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let (tx, rx) = std::sync::mpsc::channel::<(PathBuf, ChangeKind)>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if let Some(change) = kind_of(&event.kind) {
                    for path in event.paths {
                        if !is_noise(&path) {
                            let _ = tx.send((path, change));
                        }
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        // Even under steady churn the oldest pending change flushes
        // within this cap; the debounce only coalesces bursts.
        let max_wait = debounce.max(Duration::from_millis(250)) * 8;
        let handle = std::thread::spawn(move || {
            let mut pending: BTreeMap<String, ChangeKind> = BTreeMap::new();
            let mut last = Instant::now();
            let mut first_pending: Option<Instant> = None;
            loop {
                match rx.recv_timeout(Duration::from_millis(25)) {
                    Ok((path, change)) => {
                        if let Ok(rel) = path.strip_prefix(&root) {
                            if pending.is_empty() {
                                first_pending = Some(Instant::now());
                            }
                            pending.insert(rel.to_string_lossy().replace('\\', "/"), change);
                            last = Instant::now();
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
                let due = last.elapsed() >= debounce
                    || first_pending.is_some_and(|t| t.elapsed() >= max_wait);
                if !pending.is_empty() && due {
                    first_pending = None;
                    for (path, change) in std::mem::take(&mut pending) {
                        // Atomic-write temp files (write-then-rename)
                        // vanish inside the window; they were never
                        // repo files and must not light a building.
                        // Directories are not buildings either.
                        if change != ChangeKind::Deleted {
                            let full = root.join(&path);
                            if !full.exists() || full.is_dir() {
                                continue;
                            }
                        }
                        sink(EventPayload::FileTouched { path, change });
                    }
                }
                if stop_thread.load(Ordering::Relaxed) {
                    for (path, change) in std::mem::take(&mut pending) {
                        if change != ChangeKind::Deleted && !root.join(&path).exists() {
                            continue;
                        }
                        sink(EventPayload::FileTouched { path, change });
                    }
                    break;
                }
            }
        });
        Ok(RepoWatcher {
            stop,
            _watcher: watcher,
            handle: Some(handle),
        })
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn git_status_sees_modified_untracked_and_renames_without_bogus_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "t@t"]);
        git(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        git(root, &["mv", "a.txt", "b.txt"]);

        let changes = git_status_changes(root).unwrap();
        let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        // a.txt must not appear as its own bogus entry from the
        // rename's second -z field.
        assert!(!paths.contains(&"a.txt"), "changes: {paths:?}");
        assert!(paths.contains(&"b.txt"), "changes: {paths:?}");
        assert!(
            changes
                .iter()
                .any(|c| c.path == "new.txt" && c.change == ChangeKind::Created),
            "changes: {changes:?}"
        );
    }
}
