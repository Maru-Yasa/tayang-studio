//! Project folders on disk plus the slug helpers shared with the TS side.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

/// Port of `slugify` in `packages/shared/src/helpers.ts`.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for c in title.nfkd() {
        if ('\u{300}'..='\u{36f}').contains(&c) {
            continue;
        }
        for l in c.to_lowercase() {
            if l.is_ascii_lowercase() || l.is_ascii_digit() {
                if pending_dash && !out.is_empty() {
                    out.push('-');
                }
                pending_dash = false;
                out.push(l);
            } else {
                pending_dash = true;
            }
        }
    }
    out.truncate(48);
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "video".to_string()
    } else {
        out.to_string()
    }
}

/// Port of `uniqueSlug`: `base`, then `base-2`, `base-3`, ...
pub fn unique_slug(base: &str, taken: &[String]) -> String {
    if !taken.iter().any(|t| t == base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Creates `<working>/<slug>/` with a placeholder `AGENTS.md`. A folder that already
/// exists on disk counts as taken even if the caller does not list it.
pub fn create_project_folder(
    working: &Path,
    title: &str,
    existing_slugs: &[String],
) -> io::Result<(String, PathBuf)> {
    fs::create_dir_all(working)?;
    let base = slugify(title);
    let mut taken = existing_slugs.to_vec();
    let mut slug = unique_slug(&base, &taken);
    while working.join(&slug).exists() {
        taken.push(slug);
        slug = unique_slug(&base, &taken);
    }
    let dir = working.join(&slug);
    fs::create_dir(&dir)?;
    fs::write(dir.join("AGENTS.md"), format!("# {title}\n"))?;
    Ok((slug, dir))
}

/// True when `folder` can be a video's own project folder: an absolute path inside some folder,
/// named after the project's slug. Guards deleting a folder against a bad row (an empty folder, the
/// working folder itself, a home or root folder).
pub fn is_project_folder(folder: &Path, slug: &str) -> bool {
    !slug.is_empty()
        && folder.is_absolute()
        && folder.parent().is_some_and(|p| p.parent().is_some())
        && folder.file_name().is_some_and(|n| n == slug)
}

/// Writes the same brief to `AGENTS.md` and `CLAUDE.md`.
pub fn write_project_brief(folder: &Path, brief: &str) -> io::Result<()> {
    fs::write(folder.join("AGENTS.md"), brief)?;
    fs::write(folder.join("CLAUDE.md"), brief)
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// True when `p` (relative paths resolve against `working`) stays inside `working`.
/// Resolves `..` lexically, then canonicalizes the deepest existing ancestor of the target
/// (following symlinks) and appends the not-yet-existing remainder.
pub fn ensure_inside(working: &Path, p: &Path) -> bool {
    let Ok(cw) = fs::canonicalize(working) else {
        return false;
    };
    let w = normalize(working);
    let target = normalize(&if p.is_absolute() { p.to_path_buf() } else { w.join(p) });
    if !target.starts_with(&w) {
        return false;
    }
    let mut existing = target.as_path();
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    let canon = loop {
        if let Ok(c) = fs::canonicalize(existing) {
            break c;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return false,
        }
    };
    let mut resolved = canon;
    for name in rest.into_iter().rev() {
        if name == ".." || name == "." {
            return false;
        }
        resolved.push(name);
    }
    resolved.starts_with(cw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_videos_own_folder_is_its_project_folder() {
        assert!(is_project_folder(Path::new("/Users/a/Tayang/my-video"), "my-video"));
        assert!(!is_project_folder(Path::new("/Users/a/Tayang/my-video"), "other"));
        assert!(!is_project_folder(Path::new("/Users/a/Tayang"), ""));
        assert!(!is_project_folder(Path::new("/my-video"), "my-video"));
        assert!(!is_project_folder(Path::new("/"), "my-video"));
        assert!(!is_project_folder(Path::new("Tayang/my-video"), "my-video"));
    }

    #[test]
    fn slugify_cases() {
        assert_eq!(slugify("Kopi \"Senja\""), "kopi-senja");
        assert_eq!(slugify("Café Déjà Vu"), "cafe-deja-vu");
        assert_eq!(slugify("???"), "video");
        assert_eq!(slugify(""), "video");
        assert_eq!(slugify("  --Hello   World--  "), "hello-world");
        let long = slugify(&"ab ".repeat(40));
        assert!(long.len() <= 48 && !long.ends_with('-'));
    }

    #[test]
    fn unique_slug_cases() {
        let t = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(unique_slug("promo", &t(&[])), "promo");
        assert_eq!(unique_slug("promo", &t(&["promo"])), "promo-2");
        assert_eq!(unique_slug("promo", &t(&["promo", "promo-2"])), "promo-3");
    }

    #[test]
    fn create_folder_and_brief() {
        let tmp = tempfile::tempdir().unwrap();
        let working = tmp.path().join("Video Saya");
        let (slug, dir) = create_project_folder(&working, "Kopi \"Senja\"", &[]).unwrap();
        assert_eq!(slug, "kopi-senja");
        assert!(dir.is_dir() && dir.ends_with("kopi-senja"));
        assert!(dir.join("AGENTS.md").is_file());
        write_project_brief(&dir, "# Brief").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("AGENTS.md")).unwrap(), "# Brief");
        assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "# Brief");

        let (s, _) = create_project_folder(&working, "???", &[]).unwrap();
        assert_eq!(s, "video");
        let (s, _) = create_project_folder(&working, "Promo", &[]).unwrap();
        assert_eq!(s, "promo");
        let (s, d) = create_project_folder(&working, "Promo", &["promo".to_string()]).unwrap();
        assert_eq!(s, "promo-2");
        assert!(d.is_dir());
        // folder already on disk but unknown to the caller is not reused
        let (s, _) = create_project_folder(&working, "Promo", &[]).unwrap();
        assert_eq!(s, "promo-3");
    }

    #[test]
    fn ensure_inside_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let w = tmp.path().join("work");
        std::fs::create_dir_all(&w).unwrap();
        assert!(ensure_inside(&w, &w.join("a").join("b")));
        assert!(ensure_inside(&w, &w));
        assert!(!ensure_inside(&w, Path::new("../x")));
        assert!(!ensure_inside(&w, &w.join("..").join("x")));
        assert!(!ensure_inside(&w, tmp.path()));
        assert!(!ensure_inside(&w, &tmp.path().join("work2")));
    }

    #[cfg(unix)]
    #[test]
    fn ensure_inside_follows_symlinks_for_new_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let w = tmp.path().join("work");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(w.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, w.join("link")).unwrap();
        assert!(!ensure_inside(&w, &w.join("link").join("new.txt")));
        assert!(!ensure_inside(&w, &w.join("link").join("a").join("b.txt")));
        assert!(!ensure_inside(&w, Path::new("link/new.txt")));
        assert!(ensure_inside(&w, &w.join("sub").join("new.txt")));
        assert!(ensure_inside(&w, &w.join("sub").join("x").join("new.txt")));
        assert!(!ensure_inside(&tmp.path().join("missing"), &tmp.path().join("missing").join("a")));
    }
}
