//! Adding skills from a GitHub link: read the link, download the repo's zip, unpack it safely and
//! find the folders with a SKILL.md. The chosen folders then go through `skills::import`.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// The download is refused past this: a repo of skills is text and a few small files.
pub const DOWNLOAD_LIMIT: u64 = 50 * 1024 * 1024;
/// Unpacked, the files may not add up to more than this (a zip can be small and unpack huge).
const UNPACK_LIMIT: u64 = 200 * 1024 * 1024;
/// How deep under the linked folder to look for SKILL.md files.
const SEARCH_DEPTH: usize = 6;
/// Shown when a skill has more files that can run than this.
const SCRIPTS_SHOWN: usize = 12;

/// A GitHub link: the repo, and optionally a branch or tag and a folder in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubLink {
    pub owner: String,
    pub repo: String,
    /// A branch, tag or commit; the default branch when absent.
    pub reference: Option<String>,
    /// The folder inside the repo, `""` for the whole repo.
    pub path: String,
}

impl GithubLink {
    pub fn archive_url(&self) -> String {
        format!(
            "https://github.com/{}/{}/archive/{}.zip",
            self.owner,
            self.repo,
            self.reference.as_deref().unwrap_or("HEAD")
        )
    }

    /// The page for a folder in the repo, kept with each skill so the user can see where it came from.
    pub fn folder_url(&self, folder: &str) -> String {
        let base = format!("https://github.com/{}/{}", self.owner, self.repo);
        if folder.is_empty() && self.reference.is_none() {
            return base;
        }
        format!("{base}/tree/{}/{folder}", self.reference.as_deref().unwrap_or("HEAD")).trim_end_matches('/').to_string()
    }
}

fn plain(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Reads `github.com/owner/repo`, `…/tree/<ref>/<folder>` or `…/blob/<ref>/<folder>/SKILL.md`,
/// with or without `https://`.
pub fn parse_link(text: &str) -> Result<GithubLink, String> {
    let bad = || "Paste a GitHub link, like https://github.com/owner/repo or a folder in it".to_string();
    let t = text.trim();
    let t = t.strip_prefix("https://").or_else(|| t.strip_prefix("http://")).unwrap_or(t);
    let t = t.strip_prefix("www.").unwrap_or(t);
    let rest = t.strip_prefix("github.com/").ok_or_else(bad)?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    let [owner, repo, more @ ..] = parts.as_slice() else { return Err(bad()) };
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !plain(owner) || !plain(repo) {
        return Err(bad());
    }
    let (reference, mut path) = match more {
        [] => (None, Vec::new()),
        [kind, reference, path @ ..] if matches!(*kind, "tree" | "blob") => (Some(reference.to_string()), path.to_vec()),
        _ => return Err(bad()),
    };
    if path.last().is_some_and(|f| f.eq_ignore_ascii_case("SKILL.md")) {
        path.pop();
    }
    if reference.as_deref().is_some_and(|r| !plain(r)) || path.iter().any(|p| *p == ".." || *p == ".") {
        return Err(bad());
    }
    Ok(GithubLink { owner: owner.to_string(), repo: repo.to_string(), reference, path: path.join("/") })
}

/// Unpacks a GitHub zip into `dest`, dropping the archive's top folder (`repo-<sha>/`). Paths that
/// would leave `dest` and symlinks are skipped.
pub fn unpack(zip_bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|_| "The download isn't a zip".to_string())?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name() else { continue };
        // GitHub puts everything under one `repo-<sha>/` folder.
        let inner: PathBuf = name.components().skip(1).collect();
        if inner.as_os_str().is_empty() || inner.components().any(|c| !matches!(c, Component::Normal(_))) {
            continue;
        }
        let is_link = entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000);
        if is_link {
            continue;
        }
        let out = dest.join(&inner);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        total += entry.size();
        if total > UNPACK_LIMIT {
            return Err("That repo is too big to add skills from".into());
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        fs::write(&out, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A skill found in the download, for the user to choose.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundSkill {
    /// The folder in the repo, `""` when SKILL.md is at the top.
    pub folder: String,
    pub name: String,
    pub description: String,
    /// Files the agent could run (scripts, programs), relative to the skill's folder.
    pub scripts: Vec<String>,
    /// How many runnable files there are when `scripts` shows only the first few.
    pub script_count: usize,
    /// The skill's folder on GitHub, kept with it once added.
    pub source: String,
}

const RUNNABLE: &[&str] = &[
    "sh", "bash", "zsh", "fish", "py", "js", "mjs", "cjs", "ts", "mts", "rb", "pl", "php", "ps1", "bat", "cmd", "exe", "bin", "jar", "go", "rs",
    "swift", "lua",
];

fn runnable(file: &Path) -> bool {
    file.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RUNNABLE.contains(&e.to_ascii_lowercase().as_str()))
}

fn files_in(dir: &Path, base: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => files_in(&p, base, out),
            Ok(t) if t.is_file() && runnable(&p) => {
                out.push(p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/"));
            }
            _ => {}
        }
    }
}

fn skill_at(dir: &Path, unpacked: &Path) -> Option<FoundSkill> {
    let text = fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let (name, description) = crate::skills::name_and_description(&text);
    let folder = dir.strip_prefix(unpacked).ok()?.to_string_lossy().replace('\\', "/");
    let fallback = || dir.file_name().and_then(|n| n.to_str()).unwrap_or("skill").to_string();
    let mut scripts = Vec::new();
    files_in(dir, dir, &mut scripts);
    let script_count = scripts.len();
    scripts.truncate(SCRIPTS_SHOWN);
    Some(FoundSkill { folder, name: name.unwrap_or_else(fallback), description: description.unwrap_or_default(), scripts, script_count, source: String::new() })
}

/// The skills under `folder` of the unpacked repo: the folder itself when it has a SKILL.md,
/// otherwise every folder with one below it (a skill's own subfolders aren't searched).
pub fn find_skills(unpacked: &Path, folder: &str) -> Result<Vec<FoundSkill>, String> {
    let start = unpacked.join(folder);
    if !start.is_dir() {
        return Err(format!("There's no folder “{folder}” in that repo"));
    }
    fn walk(dir: &Path, unpacked: &Path, depth: usize, out: &mut Vec<FoundSkill>) {
        if dir.join("SKILL.md").is_file() {
            out.extend(skill_at(dir, unpacked));
            return;
        }
        if depth == 0 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else { return };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| e.file_name().to_str().is_some_and(|n| !n.starts_with('.') && n != "node_modules"))
            .map(|e| e.path())
            .collect();
        dirs.sort();
        for d in dirs {
            walk(&d, unpacked, depth - 1, out);
        }
    }
    let mut out = Vec::new();
    walk(&start, unpacked, SEARCH_DEPTH, &mut out);
    if out.is_empty() {
        return Err("No SKILL.md in that link. Link the repo, or the folder that has the SKILL.md".into());
    }
    Ok(out)
}

/// Where downloads wait while the user chooses; `id` comes from the UI, so only a plain id is accepted.
pub fn download_dir(app_data: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("That download is gone. Paste the link again".into());
    }
    Ok(app_data.join("skill-downloads").join(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn link(owner: &str, repo: &str, reference: Option<&str>, path: &str) -> GithubLink {
        GithubLink { owner: owner.into(), repo: repo.into(), reference: reference.map(Into::into), path: path.into() }
    }

    #[test]
    fn reads_github_links() {
        assert_eq!(parse_link("https://github.com/anthropics/skills").unwrap(), link("anthropics", "skills", None, ""));
        assert_eq!(parse_link("github.com/anthropics/skills.git/").unwrap(), link("anthropics", "skills", None, ""));
        assert_eq!(
            parse_link("https://github.com/a/b/tree/main/skills/pdf").unwrap(),
            link("a", "b", Some("main"), "skills/pdf")
        );
        assert_eq!(
            parse_link("https://www.github.com/a/b/blob/v1.2/skills/pdf/SKILL.md?plain=1").unwrap(),
            link("a", "b", Some("v1.2"), "skills/pdf")
        );
        for bad in ["https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/issues/3", "https://github.com/a/b/tree/main/../x", "not a link"] {
            assert!(parse_link(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn builds_download_and_folder_urls() {
        assert_eq!(link("a", "b", None, "").archive_url(), "https://github.com/a/b/archive/HEAD.zip");
        assert_eq!(link("a", "b", Some("v2"), "").archive_url(), "https://github.com/a/b/archive/v2.zip");
        assert_eq!(link("a", "b", None, "").folder_url(""), "https://github.com/a/b");
        assert_eq!(link("a", "b", None, "").folder_url("skills/pdf"), "https://github.com/a/b/tree/HEAD/skills/pdf");
        assert_eq!(link("a", "b", Some("main"), "x").folder_url("x"), "https://github.com/a/b/tree/main/x");
    }

    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, body) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    const SKILL: &str = "---\nname: pdf-tools\ndescription: Use for PDFs\n---\nRun scripts/fill.py.\n";

    #[test]
    fn unpacks_without_the_top_folder_and_keeps_inside() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = zip_of(&[("repo-abc/skills/pdf/SKILL.md", SKILL), ("repo-abc/../escape.txt", "x"), ("repo-abc/README.md", "hi")]);
        unpack(&bytes, dir.path()).unwrap();
        assert!(dir.path().join("skills/pdf/SKILL.md").is_file());
        assert!(dir.path().join("README.md").is_file());
        assert!(!dir.path().parent().unwrap().join("escape.txt").exists());
        assert!(unpack(b"not a zip", dir.path()).is_err());
    }

    #[test]
    fn skips_symlinks_in_the_zip() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        w.add_symlink("repo-abc/secret", "/etc/passwd", zip::write::SimpleFileOptions::default()).unwrap();
        let bytes = w.finish().unwrap().into_inner();
        unpack(&bytes, dir.path()).unwrap();
        assert!(fs::symlink_metadata(dir.path().join("secret")).is_err());
    }

    #[test]
    fn finds_skills_and_the_files_they_can_run() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = zip_of(&[
            ("r-1/skills/pdf/SKILL.md", SKILL),
            ("r-1/skills/pdf/scripts/fill.py", "print(1)"),
            ("r-1/skills/pdf/reference.md", "notes"),
            ("r-1/skills/pdf/inner/SKILL.md", SKILL),
            ("r-1/skills/hooks/SKILL.md", "---\ndescription: \"Use for hooks: short\"\n---\nShort.\n"),
            ("r-1/.github/SKILL.md", SKILL),
        ]);
        unpack(&bytes, dir.path()).unwrap();
        let all = find_skills(dir.path(), "").unwrap();
        assert_eq!(all.iter().map(|s| s.folder.as_str()).collect::<Vec<_>>(), ["skills/hooks", "skills/pdf"]);
        assert_eq!(all[0].name, "hooks", "no name falls back to the folder");
        assert_eq!(all[0].description, "Use for hooks: short");
        assert!(all[0].scripts.is_empty());
        assert_eq!(all[1].name, "pdf-tools");
        assert_eq!(all[1].scripts, ["scripts/fill.py"]);
        assert_eq!(all[1].script_count, 1);

        let one = find_skills(dir.path(), "skills/pdf").unwrap();
        assert_eq!(one.len(), 1);
        assert!(find_skills(dir.path(), "nope").is_err());
        assert!(find_skills(dir.path(), ".github/x").is_err());
    }

    #[test]
    fn says_when_a_link_has_no_skill() {
        let dir = tempfile::tempdir().unwrap();
        unpack(&zip_of(&[("r-1/README.md", "hi")]), dir.path()).unwrap();
        assert!(find_skills(dir.path(), "").unwrap_err().contains("No SKILL.md"));
    }

    #[test]
    fn download_ids_stay_in_their_folder() {
        let data = Path::new("/data");
        assert_eq!(download_dir(data, "ab12-cd").unwrap(), Path::new("/data/skill-downloads/ab12-cd"));
        assert!(download_dir(data, "../x").is_err());
        assert!(download_dir(data, "").is_err());
    }
}

#[cfg(test)]
mod real_download {
    /// `cargo test --lib downloads_a_real_link -- --ignored --nocapture` (needs the internet).
    #[tokio::test]
    #[ignore]
    async fn downloads_a_real_link() {
        let link = super::parse_link("https://github.com/anthropics/skills/tree/main/skills/pdf").unwrap();
        let bytes = reqwest::get(link.archive_url()).await.unwrap().bytes().await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        super::unpack(&bytes, dir.path()).unwrap();
        let found = super::find_skills(dir.path(), &link.path).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "pdf");
        assert!(found[0].script_count > 0);
        println!("{} MB, {:?}", bytes.len() / 1_000_000, found[0]);
    }

    /// `SKILLS_ZIP=<a GitHub repo zip> cargo test --lib real_repo_zip -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_repo_zip() {
        let bytes = std::fs::read(std::env::var("SKILLS_ZIP").unwrap()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        super::unpack(&bytes, dir.path()).unwrap();
        for s in super::find_skills(dir.path(), "").unwrap() {
            println!("{} | {} | scripts {} {:?}", s.folder, s.name, s.script_count, s.scripts.first());
        }
    }
}
