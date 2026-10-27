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
        files.push(FileDiff {
            path: path.to_string(),
            insertions: ins.parse().unwrap_or(0),
            deletions: del.parse().unwrap_or(0),
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
                    });
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
        .filter(|f| f.insertions == 0 && f.deletions == 0)
        .map(|f| f.path.as_str())
        .collect();
    if !new.is_empty() {
        summary.push_str(&format!(" New files: {}.", new.join(", ")));
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
}
