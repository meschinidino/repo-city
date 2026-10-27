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
pub fn remove_worktree(repo: &Path, path: &Path, session_id: &str) -> Result<(), String> {
    git(
        repo,
        &["worktree", "remove", "--force", path.to_str().ok_or("worktree path is not UTF-8")?],
    )?;
    let _ = git(repo, &["branch", "-D", &branch_for(session_id)]);
    Ok(())
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
}
