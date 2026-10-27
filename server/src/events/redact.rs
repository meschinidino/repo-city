//! Secret redaction (design L1 / T8 seam): values of known credential
//! environment variables plus common token shapes are scrubbed from
//! event text before it reaches SQLite or the WebSocket. Matching is
//! deliberately fail-closed for shaped tokens: a string that looks
//! like a credential is replaced even if it is not a live secret.

const REDACTED: &str = "[redacted]";

/// Env var names whose values count as secrets. Name matching, not an
/// allowlist of spellings: any name containing one of these markers
/// qualifies, in any case.
const SECRET_NAME_MARKERS: [&str; 6] =
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL"];

/// Values of credential-looking environment variables, long enough to
/// be meaningful (short values would redact half the dictionary).
pub fn secret_values_from_env() -> Vec<String> {
    std::env::vars()
        .filter(|(name, _)| {
            let upper = name.to_ascii_uppercase();
            SECRET_NAME_MARKERS.iter().any(|m| upper.contains(m))
        })
        .map(|(_, value)| value)
        .filter(|value| value.len() >= 8)
        .collect()
}

fn looks_like_token_prefix(text: &str, at: usize) -> Option<usize> {
    // A token starts at a word boundary: start of text or a preceding
    // character that cannot be part of a word. Without this, ordinary
    // prose like "task-runner" matches the "sk-" shape mid-word.
    if at > 0 {
        let prev = text[..at].chars().next_back().unwrap_or(' ');
        if prev.is_ascii_alphanumeric() || matches!(prev, '-' | '_' | '.') {
            return None;
        }
    }
    let rest = &text[at..];
    // (prefix, chars to consume after the prefix, minimum total length)
    const SHAPES: [(&str, usize, usize); 7] = [
        ("sk-", 24, 20),
        ("ghp_", 36, 20),
        ("gho_", 36, 20),
        ("ghu_", 36, 20),
        ("github_pat_", 40, 20),
        ("xoxb-", 24, 16),
        ("AKIA", 16, 20),
    ];
    for (prefix, tail, min_len) in SHAPES {
        if rest.starts_with(prefix) {
            let token_len = rest
                .char_indices()
                .take_while(|(i, c)| {
                    *i < prefix.len() + tail
                        && (c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
                })
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(prefix.len());
            if token_len >= min_len {
                return Some(token_len);
            }
        }
    }
    None
}

/// Replace every secret value and every token-shaped substring.
pub fn redact_text(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    // Longest first so a short value cannot partially mask a longer one.
    let mut sorted: Vec<&String> = secrets.iter().filter(|s| s.len() >= 8).collect();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for secret in sorted {
        if out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), REDACTED);
        }
    }
    // Token shapes, scanned on bytes (prefixes are ASCII).
    let bytes = out.as_bytes();
    let mut result = String::with_capacity(out.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(len) = looks_like_token_prefix(&out, i) {
            result.push_str(REDACTED);
            i += len;
        } else {
            let ch_len = out[i..].chars().next().map(char::len_utf8).unwrap_or(1);
            result.push_str(&out[i..i + ch_len]);
            i += ch_len;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_env_secret_values() {
        let secrets = vec!["hunter2-super-secret".to_string()];
        let out = redact_text("token is hunter2-super-secret ok", &secrets);
        assert_eq!(out, "token is [redacted] ok");
    }

    #[test]
    fn redacts_token_shapes_without_knowing_the_value() {
        // Tokens assembled at runtime so no literal credential sits in source.
        let sk = ["sk-", "abcdefghijklmnopqrst", "uvwxyz0123456789"].concat();
        let out = redact_text(&format!("key {sk} end"), &[]);
        assert!(!out.contains(&sk[..9]), "got: {out}");
        assert!(out.contains("[redacted]"));
        let ghp = ["ghp_", "abcdefghijklmnopqrst", "uvwxyz0123456789"].concat();
        let out = redact_text(&ghp, &[]);
        assert_eq!(out, "[redacted]");
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let text = "cargo test --release finished in 3.2s, 16 passed";
        assert_eq!(redact_text(text, &[]), text);
        // Words that merely contain a token prefix mid-word survive.
        let prose = "the task-runner is risk-free; check disk-usage first";
        assert_eq!(redact_text(prose, &[]), prose);
    }
}
