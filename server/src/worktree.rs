//! Git worktree lifecycle for sessions (T5): one worktree per
//! spawned session, on a `repo-city/<id>` branch, so an agent never
//! edits the user's own checkout. Removal is the discard path's
//! job (step 5); it lives here so the whole lifecycle has one home.

use std::path::{Path, PathBuf};
use std::process::Command;

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Like `git` but without trimming: porcelain status lines can
/// start with a space (` M file`), which trim would eat.
fn git_raw(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn is_git_repo(repo: &Path) -> bool {
    git(repo, &["rev-parse", "--git-dir"]).is_ok()
}

/// Branch name for a session worktree.
pub fn branch_for(session_id: &str) -> String {
    format!("repo-city/{}", &session_id[..session_id.len().min(8)])
}

/// Create `root/<session_id>` as a worktree of `repo` on a fresh
/// session branch at HEAD. Fails honestly on a non-git repo.
pub fn create_worktree(repo: &Path, root: &Path, session_id: &str) -> Result<PathBuf, String> {
    if !is_git_repo(repo) {
        return Err(format!("{} is not a git repository", repo.display()));
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join(session_id);
    if path.exists() {
        return Err(format!("worktree path already exists: {}", path.display()));
    }
    git(
        repo,
        &[
            "worktree",
            "add",
            "-b",
            &branch_for(session_id),
            path.to_str().ok_or("worktree path is not UTF-8")?,
            "HEAD",
        ],
    )?;
    Ok(path)
}

/// Remove a session worktree and its branch (discard path, step 5).
/// A missing dir still prunes the stale worktree entry and the
/// session branch, so a half-gone worktree never lingers.
/// Genuinely absent resources are fine; a present branch that
/// refuses deletion (a live worktree elsewhere still holds it,
/// or the metadata is unwritable) is a real failure and
/// surfaces, so Discard can report it honestly.
pub fn remove_worktree(repo: &Path, path: &Path, session_id: &str) -> Result<(), String> {
    if path.exists() {
        git(
            repo,
            &["worktree", "remove", "--force", path.to_str().ok_or("worktree path is not UTF-8")?],
        )?;
    } else {
        prune_worktrees(repo)?;
    }
    let branch = branch_for(session_id);
    if !git(repo, &["branch", "--list", &branch])?.is_empty() {
        git(repo, &["branch", "-D", &branch])?;
    }
    Ok(())
}

/// Drop stale worktree registrations. prune exits 0 even when a
/// delete fails (it only warns), so nonempty stderr — not the
/// exit code — is the failure signal.
fn prune_worktrees(repo: &Path) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "prune"])
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let warned = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !warned.is_empty() {
        return Err(warned);
    }
    Ok(())
}

/// Branch checked out in `repo` right now. "HEAD" means detached;
/// the Accept guard refuses that as an unknown merge target.
pub fn current_branch(repo: &Path) -> Result<String, String> {
    git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
}

/// Uncommitted paths in `repo`: staged, unstaged, and untracked.
/// Empty means the checkout is clean.
pub fn dirty_files(repo: &Path) -> Result<Vec<String>, String> {
    let out = git_raw(repo, &["status", "--porcelain=v1", "-z", "-uall"])?;
    let mut files = Vec::new();
    let mut entries = out.split('\0');
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        if entry[..2].contains('R') || entry[..2].contains('C') {
            let _ = entries.next();
        }
        files.push(entry[3..].to_string());
    }
    files.sort();
    files.dedup();
    Ok(files)
}

/// HEAD sha of `repo`.
pub fn head_sha(repo: &Path) -> Result<String, String> {
    git(repo, &["rev-parse", "HEAD"])
}

/// Move HEAD and the tree back to `sha`, dropping the merge.
/// Accept rolls a merge whose checks failed back this way; the
/// main checkout was clean before the merge, so nothing of the
/// user's is lost.
pub fn reset_hard(repo: &Path, sha: &str) -> Result<(), String> {
    git(repo, &["reset", "--hard", "-q", sha])?;
    Ok(())
}

/// True while a merge (or cherry-pick/revert) is unresolved in
/// `repo`. Accept refuses then: it must not stack a second merge
/// on top of the user's unfinished one.
pub fn merge_in_progress(repo: &Path) -> bool {
    // --git-path resolves linked worktrees too, where .git is a
    // file, not a directory.
    git(repo, &["rev-parse", "--git-path", "MERGE_HEAD"])
        .map(|p| repo.join(p).exists())
        .unwrap_or(false)
}

/// Stage and commit everything in `repo`, returning the new HEAD
/// sha. Accept lands the agent's uncommitted work on the session
/// branch this way; the message says so.
pub fn commit_all(repo: &Path, message: &str) -> Result<String, String> {
    git(repo, &["add", "-A"])?;
    git(repo, &["commit", "-qm", message])?;
    git(repo, &["rev-parse", "HEAD"])
}

/// Outcome of merging a session branch into the main checkout.
#[derive(Debug)]
pub enum MergeOutcome {
    /// Merged (or already up to date): sha is the new HEAD.
    Merged { sha: String },
    /// The merge conflicted; it was aborted, so the checkout is
    /// clean again, and these are the conflicting paths.
    Conflict { files: Vec<String> },
}

/// Merge `branch` into the current checkout of `repo` with an
/// explicit merge commit (no fast-forward, so every Accept shows
/// in history). The caller must have checked the guards: right
/// branch, clean tree, no merge already in progress.
pub fn merge_branch(repo: &Path, branch: &str) -> Result<MergeOutcome, String> {
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["merge", "--no-ff", "--no-commit", branch])
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !status.status.success() {
        let files = conflict_files(repo)?;
        if files.is_empty() {
            // Not a conflict (missing branch, ...): report git's
            // own error instead of inventing a conflict.
            return Err(String::from_utf8_lossy(&status.stderr).trim().to_string());
        }
        git(repo, &["merge", "--abort"])?;
        return Ok(MergeOutcome::Conflict { files });
    }
    if git(repo, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_err() {
        // No merge commit pending: the branch was already merged.
        let sha = git(repo, &["rev-parse", "HEAD"])?;
        return Ok(MergeOutcome::Merged { sha });
    }
    // A failing hook (or a missing identity) must not leave a
    // half-merge behind: abort, so the checkout is clean and a
    // retry starts fresh. The hooks still run — a rejection
    // surfaces as an error, never as a stuck MERGE_HEAD.
    if let Err(e) = git(repo, &["commit", "--no-edit", "-q"]) {
        let _ = git(repo, &["merge", "--abort"]);
        return Err(e);
    }
    let sha = git(repo, &["rev-parse", "HEAD"])?;
    Ok(MergeOutcome::Merged { sha })
}

/// Paths with unresolved conflict markers in `repo`.
fn conflict_files(repo: &Path) -> Result<Vec<String>, String> {
    let out = git_raw(repo, &["status", "--porcelain=v1", "-z"])?;
    let mut files = Vec::new();
    for entry in out.split('\0') {
        if entry.len() < 4 {
            continue;
        }
        let code = &entry[..2];
        if matches!(code, "UU" | "AA" | "DD" | "UD" | "DU" | "UA" | "AU") {
            files.push(entry[3..].to_string());
        }
    }
    files.sort();
    Ok(files)
}

/// A discovered test command: what to run and where to run it.
#[derive(Debug, Clone, PartialEq)]
pub struct TestCommand {
    /// Directory to run in (the one holding the config file).
    pub dir: PathBuf,
    /// Shell words, e.g. "npm test". Run without a shell.
    pub command: String,
    /// Which config file named it, e.g. "frontend/package.json".
    pub source: String,
}

/// Discover the repo's test command (D15): a `package.json` test
/// script first, then a justfile `test` recipe, then a Makefile
/// `test` target. Each kind is tried at the root first, then one
/// level of subdirectories (sorted, dot-dirs skipped). None means
/// the report card shows "not run".
pub fn discover_test_command(root: &Path) -> Option<TestCommand> {
    let mut dirs = vec![root.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut subs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .filter(|p| !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
            .collect();
        subs.sort();
        dirs.extend(subs);
    }
    for dir in &dirs {
        if let Some(cmd) = package_test(root, dir) {
            return Some(cmd);
        }
    }
    for dir in &dirs {
        if let Some(cmd) = file_recipe(root, dir, "justfile", "just") {
            return Some(cmd);
        }
        // Just also reads Justfile (capital J).
        if let Some(cmd) = file_recipe(root, dir, "Justfile", "just") {
            return Some(cmd);
        }
    }
    for dir in &dirs {
        if let Some(cmd) = file_recipe(root, dir, "Makefile", "make") {
            return Some(cmd);
        }
    }
    None
}

/// `npm test` (or the lockfile's runner) when `dir` has a
/// package.json with a test script.
fn package_test(root: &Path, dir: &Path) -> Option<TestCommand> {
    let pkg = dir.join("package.json");
    let text = std::fs::read_to_string(&pkg).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("scripts")?.get("test")?.as_str()?;
    let runner = if dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    };
    Some(TestCommand {
        dir: dir.to_path_buf(),
        command: format!("{runner} test"),
        source: rel_display(root, &pkg),
    })
}

/// `<tool> test` when `dir/file` defines a `test` recipe/target:
/// a line starting with `test` followed by `:` or whitespace.
fn file_recipe(root: &Path, dir: &Path, file: &str, tool: &str) -> Option<TestCommand> {
    let path = dir.join(file);
    let text = std::fs::read_to_string(&path).ok()?;
    let has_test = text.lines().any(|line| {
        let line = line.trim_start();
        line.strip_prefix("test").is_some_and(|rest| {
            rest.starts_with(':') || rest.starts_with(char::is_whitespace) || rest.is_empty()
        })
    });
    if !has_test {
        return None;
    }
    Some(TestCommand {
        dir: dir.to_path_buf(),
        command: format!("{tool} test"),
        source: rel_display(root, &path),
    })
}

/// Display path of a config file, relative to the repo root.
fn rel_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("repo-city-t5-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            assert!(Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap().status.success());
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "T"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);
        dir
    }

    #[test]
    fn worktree_roundtrip_on_a_real_git_repo() {
        let repo = temp_repo();
        let root = repo.join("wts");
        let path = create_worktree(&repo, &root, "12345678-abcd").unwrap();
        assert!(path.join("a.txt").exists());
        assert!(git(&repo, &["branch", "--list", "repo-city/12345678"]).unwrap().contains("repo-city/12345678"));
        remove_worktree(&repo, &path, "12345678-abcd").unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn non_git_repo_is_an_honest_error() {
        let dir = std::env::temp_dir().join(format!("repo-city-t5-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let err = create_worktree(&dir, &dir.join("wts"), "12345678-abcd").unwrap_err();
        assert!(err.contains("not a git repository"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Codex review P2: absent resources are fine, but a
    // present branch that refuses deletion (a live worktree
    // elsewhere still holds it) is a real failure and surfaces.
    #[test]
    fn held_branch_refuses_deletion_honestly() {
        let repo = temp_repo();
        let wt = create_worktree(&repo, &repo.with_extension("wts"), "aaaabbbb-cccc").unwrap();
        assert!(wt.is_dir());
        // The registered dir is gone from the caller's view, but
        // the branch is still checked out in the live worktree.
        let err = remove_worktree(&repo, &repo.join("no-such-dir"), "aaaabbbb-cccc").unwrap_err();
        assert!(!err.is_empty(), "empty error");
        assert!(!git(&repo, &["branch", "--list", "repo-city/aaaabbbb"]).unwrap().is_empty());
        remove_worktree(&repo, &wt, "aaaabbbb-cccc").unwrap();
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("wts"));
    }

    // Codex review P2: removing what is already fully gone is a
    // no-op success, and a prune that warns (git still exits 0)
    // surfaces as a failure.
    #[test]
    fn missing_everything_is_fine_but_a_warning_prune_fails() {
        let repo = temp_repo();
        remove_worktree(&repo, &repo.join("no-such-dir"), "dddd1111-eeee").unwrap();

        let wt = create_worktree(&repo, &repo.with_extension("wts"), "ffff2222-gggg").unwrap();
        std::fs::remove_dir_all(&wt).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let admin = repo.join(".git").join("worktrees");
            std::fs::set_permissions(&admin, std::fs::Permissions::from_mode(0o555)).unwrap();
            let err = remove_worktree(&repo, &wt, "ffff2222-gggg").unwrap_err();
            assert!(err.contains("Permission denied") || err.contains("permission"), "{err}");
            std::fs::set_permissions(&admin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        remove_worktree(&repo, &wt, "ffff2222-gggg").unwrap();
        assert!(git(&repo, &["branch", "--list", "repo-city/*"]).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("wts"));
    }

    #[test]
    fn branch_and_dirt_are_reported_honestly() {
        let repo = temp_repo();
        let branch = current_branch(&repo).unwrap();
        assert!(!branch.is_empty() && branch != "HEAD", "{branch}");
        assert!(dirty_files(&repo).unwrap().is_empty());
        assert!(!merge_in_progress(&repo));
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        assert_eq!(dirty_files(&repo).unwrap(), vec!["a.txt".to_string(), "new.txt".to_string()]);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn clean_branch_merges_and_conflict_aborts_clean() {
        let repo = temp_repo();
        let wt = create_worktree(&repo, &repo.join("wts"), "abcdef01-zzzz").unwrap();
        let wtrun = |args: &[&str]| {
            assert!(
                Command::new("git").arg("-C").arg(&wt).args(args).output().unwrap().status.success(),
                "git {args:?} failed in worktree"
            );
        };
        wtrun(&["config", "user.email", "t@example.com"]);
        wtrun(&["config", "user.name", "T"]);
        // A clean change lands with an explicit merge commit.
        std::fs::write(wt.join("b.txt"), "from branch\n").unwrap();
        commit_all(&wt, "Repo City test commit").unwrap();
        match merge_branch(&repo, "repo-city/abcdef01").unwrap() {
            MergeOutcome::Merged { sha } => {
                assert_eq!(sha.len(), 40, "{sha}");
                assert!(repo.join("b.txt").exists());
                let log = git(&repo, &["log", "--oneline", "-1"]).unwrap();
                assert!(log.contains("repo-city/abcdef01"), "{log}");
            }
            MergeOutcome::Conflict { files } => panic!("unexpected conflict: {files:?}"),
        }
        // A conflicting change aborts and names the file; the main
        // checkout is clean again.
        std::fs::write(wt.join("a.txt"), "branch line\n").unwrap();
        commit_all(&wt, "Repo City conflicting commit").unwrap();
        std::fs::write(repo.join("a.txt"), "main line\n").unwrap();
        let run = |args: &[&str]| {
            assert!(Command::new("git").arg("-C").arg(&repo).args(args).output().unwrap().status.success());
        };
        run(&["add", "."]);
        run(&["commit", "-qm", "main moves on"]);
        match merge_branch(&repo, "repo-city/abcdef01").unwrap() {
            MergeOutcome::Conflict { files } => assert_eq!(files, vec!["a.txt".to_string()]),
            MergeOutcome::Merged { sha } => panic!("unexpected merge: {sha}"),
        }
        assert!(dirty_files(&repo).unwrap().is_empty());
        assert!(!merge_in_progress(&repo));
        remove_worktree(&repo, &wt, "abcdef01-zzzz").unwrap();
        let _ = std::fs::remove_dir_all(&repo);
    }

    // Opus review P1-6: a hook rejecting the merge commit must
    // abort the merge, not strand MERGE_HEAD in the checkout.
    #[test]
    fn rejecting_hook_aborts_the_merge_clean() {
        let repo = temp_repo();
        let hook = repo.join(".git").join("hooks").join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho no\n exit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // The worktree root sits outside the repo, like the
        // production root (~/.repo-city/worktrees): a nested
        // worktree would read as untracked dirt in main.
        let wtroot = repo.with_extension("wts");
        let wt = create_worktree(&repo, &wtroot, "beef0101-zzzz").unwrap();
        // The worktree shares main's hooks, so its setup commit
        // points at an empty hook dir; the merge commit in main
        // hits the rejecting hook.
        let nohooks = repo.with_extension("nohooks");
        std::fs::create_dir(&nohooks).unwrap();
        std::fs::write(wt.join("b.txt"), "from branch\n").unwrap();
        assert!(Command::new("git").arg("-C").arg(&wt).args(["add", "-A"]).output().unwrap().status.success());
        let out = Command::new("git")
            .arg("-C")
            .arg(&wt)
            .args(["-c", "user.email=t@example.com", "-c", "user.name=T", "-c"])
            .arg(format!("core.hooksPath={}", nohooks.display()))
            .args(["commit", "-qam", "branch work"])
            .output()
            .unwrap();
        assert!(out.status.success());
        let err = merge_branch(&repo, "repo-city/beef0101").unwrap_err();
        assert!(!err.is_empty(), "empty error");
        assert!(dirty_files(&repo).unwrap().is_empty());
        assert!(!merge_in_progress(&repo));
        // And the retry works once the hook is gone.
        std::fs::remove_file(&hook).unwrap();
        assert!(matches!(
            merge_branch(&repo, "repo-city/beef0101").unwrap(),
            MergeOutcome::Merged { .. }
        ));
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("nohooks"));
        let _ = std::fs::remove_dir_all(repo.with_extension("wts"));
    }

    #[test]
    fn missing_branch_is_an_error_not_a_conflict() {
        let repo = temp_repo();
        let err = merge_branch(&repo, "repo-city/no-such-branch").unwrap_err();
        assert!(!err.is_empty(), "empty error");
        assert!(dirty_files(&repo).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn test_discovery_prefers_package_then_just_then_make() {
        let dir = std::env::temp_dir().join(format!("repo-city-t6-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        // Sub package.json wins over a root Makefile.
        std::fs::write(dir.join("Makefile"), "test:\n\tmake -C sub test\n").unwrap();
        std::fs::write(dir.join("sub").join("package.json"), r#"{"scripts": {"test": "vitest run"}}"#).unwrap();
        let found = discover_test_command(&dir).unwrap();
        assert_eq!(found.command, "npm test");
        assert_eq!(found.dir, dir.join("sub"));
        assert_eq!(found.source, "sub/package.json");
        // A lockfile picks the runner; a test-less package.json is skipped.
        std::fs::write(dir.join("sub").join("yarn.lock"), "").unwrap();
        std::fs::write(dir.join("package.json"), r#"{"scripts": {"build": "tsc"}}"#).unwrap();
        let found = discover_test_command(&dir).unwrap();
        assert_eq!(found.command, "yarn test");
        // Without any package test, a justfile recipe wins over make.
        std::fs::remove_file(dir.join("sub").join("package.json")).unwrap();
        std::fs::write(dir.join("justfile"), "test arg=\"x\":\n\techo {{arg}}\n").unwrap();
        let found = discover_test_command(&dir).unwrap();
        assert_eq!(found.command, "just test");
        assert_eq!(found.source, "justfile");
        // "testing:" is not a test target; bare "test:" is.
        std::fs::remove_file(dir.join("justfile")).unwrap();
        std::fs::write(dir.join("Makefile"), "testing:\n\techo no\n").unwrap();
        assert!(discover_test_command(&dir).is_none());
        std::fs::write(dir.join("Makefile"), "testing:\n\techo no\n\ntest: build\n\tgo test ./...\n").unwrap();
        let found = discover_test_command(&dir).unwrap();
        assert_eq!(found.command, "make test");
        assert_eq!(found.source, "Makefile");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
