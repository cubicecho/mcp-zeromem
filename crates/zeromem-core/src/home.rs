//! Where the store lives.
//!
//! `ZEROMEM_HOME` wins; otherwise `$HOME/.zeromem`. There is deliberately no
//! fall-through to the working directory: a process that cannot find its home
//! must fail rather than quietly create a second store wherever it happens to
//! be running, which is the kind of thing that is only discovered weeks later
//! when two stores disagree.

use std::path::PathBuf;

pub const HOME_ENV: &str = "ZEROMEM_HOME";

#[derive(Debug, thiserror::Error)]
#[error("cannot locate the zeromem home: set {HOME_ENV}, or HOME so that $HOME/.zeromem can be used")]
pub struct NoHome;

pub fn resolve_home() -> Result<PathBuf, NoHome> {
    resolve_home_from(|key| std::env::var_os(key).map(PathBuf::from))
}

/// Same rule, with the environment supplied — so it can be tested without
/// mutating the process environment.
pub fn resolve_home_from(get: impl Fn(&str) -> Option<PathBuf>) -> Result<PathBuf, NoHome> {
    if let Some(explicit) = get(HOME_ENV).filter(|p| !p.as_os_str().is_empty()) {
        return Ok(explicit);
    }
    match get("HOME").filter(|p| !p.as_os_str().is_empty()) {
        Some(home) => Ok(home.join(".zeromem")),
        None => Err(NoHome),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_home_wins() {
        let got = resolve_home_from(|k| match k {
            HOME_ENV => Some("/data".into()),
            "HOME" => Some("/home/x".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(got, PathBuf::from("/data"));
    }

    #[test]
    fn falls_back_to_dot_dir_under_home() {
        let got = resolve_home_from(|k| (k == "HOME").then(|| PathBuf::from("/home/x"))).unwrap();
        assert_eq!(got, PathBuf::from("/home/x/.zeromem"));
    }

    #[test]
    fn empty_values_count_as_unset() {
        let got = resolve_home_from(|k| match k {
            HOME_ENV => Some("".into()),
            "HOME" => Some("/home/x".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(got, PathBuf::from("/home/x/.zeromem"));
    }

    #[test]
    fn refuses_rather_than_using_cwd() {
        assert!(resolve_home_from(|_| None).is_err());
    }
}
