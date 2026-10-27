//! English report from the real diff (design: finish flow and the
//! Llama-unavailable fallback). Until Llama naming/reports land, this
//! is the deterministic template built from `git diff` output — and
//! it says so in `generated_by`. A session never shows a polished
//! report that was not generated from its real diff: when git cannot
//! answer, the report is explicitly unavailable and the caller falls
//! back to the raw event list.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub insertions: i64,
    pub deletions: i64,
    /// git reports binary files as `-` in numstat; they are changed,
    /// never "new" just because their line counts are zero.
    pub binary: bool,
    /// True only for untracked files (from `git status`), the one
    /// honest source for "new".
    pub new_file: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffReport {
    /// Always "template_from_diff" until the Llama report lands.
    pub generated_by: String,
    pub available: bool,
    pub reason: Option<String>,
    pub files: Vec<FileDiff>,
    pub insertions: i64,
    pub deletions: i64,
    /// Deterministic English built only from the numbers above.
    pub summary: String,
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn unavailable(reason: String) -> DiffReport {
    DiffReport {
        generated_by: "template_from_diff".to_string(),
        available: false,
        reason: Some(reason),
        files: Vec::new(),
        insertions: 0,
        deletions: 0,
        summary: String::new(),
    }
}

/// Report on uncommitted plus committed-vs-HEAD changes in `root`.
/// Untracked files appear with 0/0 line counts and are named as new.
pub fn diff_report(root: &Path) -> DiffReport {
    let numstat = match git(root, &["diff", "--numstat", "HEAD"]) {
        Ok(s) => s,
        Err(e) => return unavailable(format!("git diff failed: {e}")),
    };
    let mut files: Vec<FileDiff> = Vec::new();
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let (Some(ins), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let binary = ins == "-" && del == "-";
        files.push(FileDiff {
            path: path.to_string(),
            insertions: ins.parse().unwrap_or(0),
            deletions: del.parse().unwrap_or(0),
            binary,
            new_file: false,
        });
    }
    if let Ok(status) = git(root, &["status", "--porcelain=v1"]) {
        for line in status.lines() {
            if let Some(path) = line.strip_prefix("?? ") {
                if !files.iter().any(|f| f.path == path) {
                    files.push(FileDiff {
                        path: path.to_string(),
                        insertions: 0,
                        deletions: 0,
                        binary: false,
                        new_file: true,
                    });
                }
            } else if let Some(path) = line.strip_prefix("A  ") {
                // Staged-new: already in the numstat list with real
                // counts; just mark it as new.
                if let Some(f) = files.iter_mut().find(|f| f.path == path) {
                    f.new_file = true;
                }
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let insertions: i64 = files.iter().map(|f| f.insertions).sum();
    let deletions: i64 = files.iter().map(|f| f.deletions).sum();
    let summary = summarize(&files, insertions, deletions);
    DiffReport {
        generated_by: "template_from_diff".to_string(),
        available: true,
        reason: None,
        files,
        insertions,
        deletions,
        summary,
    }
}

fn summarize(files: &[FileDiff], insertions: i64, deletions: i64) -> String {
    if files.is_empty() {
        return "No files changed.".to_string();
    }
    let noun = if files.len() == 1 { "file" } else { "files" };
    let mut summary = format!(
        "Changed {} {} (+{} -{} lines).",
        files.len(),
        noun,
        insertions,
        deletions
    );
    if let Some(big) = files.iter().max_by_key(|f| f.insertions + f.deletions) {
        if big.insertions + big.deletions > 0 {
            summary.push_str(&format!(
                " The largest change is {} (+{} -{}).",
                big.path, big.insertions, big.deletions
            ));
        }
    }
    let new: Vec<&str> = files
        .iter()
        .filter(|f| f.new_file)
        .map(|f| f.path.as_str())
        .collect();
    if !new.is_empty() {
        summary.push_str(&format!(" New files: {}.", new.join(", ")));
    }
    let binaries: Vec<&str> = files
        .iter()
        .filter(|f| f.binary)
        .map(|f| f.path.as_str())
        .collect();
    if !binaries.is_empty() {
        summary.push_str(&format!(" Binary files changed: {}.", binaries.join(", ")));
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_unavailable_outside_a_git_repo() {
        let dir = tempfile::tempdir().unwrap();
        let report = diff_report(dir.path());
        assert!(!report.available);
        assert_eq!(report.generated_by, "template_from_diff");
        assert!(report.reason.is_some());
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn modified_binary_is_changed_not_new_and_untracked_is_new() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "t@t"]);
        git(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("img.bin"), [0u8, 1, 2, 3]).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);
        std::fs::write(root.join("img.bin"), [9u8, 8, 7]).unwrap();
        std::fs::write(root.join("fresh.txt"), "hi\n").unwrap();

        let report = diff_report(root);
        assert!(report.available);
        let bin = report.files.iter().find(|f| f.path == "img.bin").unwrap();
        assert!(bin.binary && !bin.new_file, "files: {:?}", report.files);
        let fresh = report.files.iter().find(|f| f.path == "fresh.txt").unwrap();
        assert!(fresh.new_file && !fresh.binary, "files: {:?}", report.files);
        assert!(
            report.summary.contains("Binary files changed: img.bin"),
            "{}",
            report.summary
        );
        assert!(
            report.summary.contains("New files: fresh.txt"),
            "{}",
            report.summary
        );
        assert!(
            !report.summary.contains("New files: img.bin"),
            "{}",
            report.summary
        );
    }
}
