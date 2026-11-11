//! The user's own skills, kept as a Claude Code plugin in Tayang's data folder:
//! `<root>/skills/<id>/SKILL.md` are on, `<root>/disabled/<id>/SKILL.md` are off.
//! Claude loads the folder as a plugin; other agents get a list of the skills in their first prompt.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const ON: &str = "skills";
const OFF: &str = "disabled";
const PLUGIN_JSON: &str = r#"{"name":"my-skills","description":"Your own skills, added in Tayang Studio","version":"0.1.0"}"#;
/// An imported folder bigger than this is refused: a skill is instructions and a few small files.
const IMPORT_LIMIT: u64 = 20 * 1024 * 1024;
/// Claude Code's limit for a skill name.
const NAME_LIMIT: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// The folder name, which is also the skill's name for the agent.
    pub id: String,
    pub description: String,
    pub enabled: bool,
    /// The SKILL.md on disk.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub skill: Skill,
    /// SKILL.md without its frontmatter.
    pub body: String,
}

/// `<app data>/user-skills`, set up as a plugin.
pub fn root(app_data: &Path) -> Result<PathBuf, String> {
    let root = app_data.join("user-skills");
    let manifest = root.join(".claude-plugin").join("plugin.json");
    if !manifest.is_file() {
        fs::create_dir_all(manifest.parent().unwrap()).map_err(io)?;
        fs::write(&manifest, PLUGIN_JSON).map_err(io)?;
    }
    fs::create_dir_all(root.join(ON)).map_err(io)?;
    Ok(root)
}

fn io(e: std::io::Error) -> String {
    e.to_string()
}

/// Lowercase letters, digits and dashes, as Claude Code wants a skill name.
/// Empty when `name` has no letters or digits.
pub fn skill_id(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let mut out = String::new();
    let mut dash = false;
    for c in name.nfkd().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else if !('\u{300}'..='\u{36f}').contains(&c) {
            dash = true;
        }
    }
    out.truncate(NAME_LIMIT);
    out.trim_end_matches('-').to_string()
}

/// An id is a single plain folder name: nothing that could step outside the root.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= NAME_LIMIT && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The frontmatter's lines and the body after it. No frontmatter: no lines, all body.
fn split(text: &str) -> (Vec<String>, String) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n");
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let head = rest[..end].lines().map(str::to_string).collect();
            let after = &rest[end + 4..];
            let body = after.split_once('\n').map(|(_, b)| b).unwrap_or("");
            return (head, body.trim_start_matches('\n').to_string());
        }
    }
    (Vec::new(), text)
}

/// A top-level `key: value` from the frontmatter, unquoted.
fn field(head: &[String], key: &str) -> Option<String> {
    head.iter().find_map(|line| {
        let (k, v) = line.split_once(':')?;
        if k.trim() != key || line.starts_with(' ') {
            return None;
        }
        let v = v.trim();
        let unquoted = if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
            serde_json::from_str::<String>(v).unwrap_or_else(|_| v[1..v.len() - 1].to_string())
        } else if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
            v[1..v.len() - 1].replace("''", "'")
        } else {
            v.to_string()
        };
        Some(unquoted)
    })
}

/// Sets `key` in the frontmatter, keeping every other line (an imported skill's own fields).
fn set_field(head: &mut Vec<String>, key: &str, value: &str) {
    let line = format!("{key}: {}", serde_json::to_string(value).unwrap_or_default());
    let at = head.iter().position(|l| !l.starts_with(' ') && l.split_once(':').is_some_and(|(k, _)| k.trim() == key));
    match at {
        Some(i) => {
            head[i] = line;
            // A multi-line value's continuation lines go with it.
            while head.get(i + 1).is_some_and(|l| l.starts_with(' ')) {
                head.remove(i + 1);
            }
        }
        None => head.push(line),
    }
}

fn compose(head: &[String], body: &str) -> String {
    format!("---\n{}\n---\n\n{}\n", head.join("\n"), body.trim())
}

fn read_skill(dir: &Path, enabled: bool) -> Option<Skill> {
    let id = dir.file_name()?.to_str()?.to_string();
    let file = dir.join("SKILL.md");
    let text = fs::read_to_string(&file).ok()?;
    let (head, _) = split(&text);
    Some(Skill {
        description: field(&head, "description").unwrap_or_default(),
        id,
        enabled,
        path: file.to_string_lossy().into_owned(),
    })
}

/// Every skill, on and off, by name.
pub fn list(root: &Path) -> Vec<Skill> {
    let mut out: Vec<Skill> = [(ON, true), (OFF, false)]
        .into_iter()
        .flat_map(|(sub, enabled)| {
            fs::read_dir(root.join(sub))
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(move |e| read_skill(&e.path(), enabled))
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Where a skill's folder is, and whether it is on.
fn find(root: &Path, id: &str) -> Result<(PathBuf, bool), String> {
    if !valid_id(id) {
        return Err("That skill doesn't exist".into());
    }
    for (sub, enabled) in [(ON, true), (OFF, false)] {
        let dir = root.join(sub).join(id);
        if dir.join("SKILL.md").is_file() {
            return Ok((dir, enabled));
        }
    }
    Err("That skill doesn't exist".into())
}

fn taken(root: &Path, id: &str) -> bool {
    root.join(ON).join(id).exists() || root.join(OFF).join(id).exists()
}

/// A free id from `name`: `name`, then `name-2`, `name-3`…
fn free_id(root: &Path, name: &str) -> Result<String, String> {
    let base = skill_id(name);
    if base.is_empty() {
        return Err("Give the skill a name with letters or numbers".into());
    }
    if !taken(root, &base) {
        return Ok(base);
    }
    (2..1000)
        .map(|n| {
            let suffix = format!("-{n}");
            let mut b = base.clone();
            b.truncate(NAME_LIMIT - suffix.len());
            format!("{}{suffix}", b.trim_end_matches('-'))
        })
        .find(|id| !taken(root, id))
        .ok_or_else(|| "Too many skills with that name".to_string())
}

pub fn read(root: &Path, id: &str) -> Result<SkillDetail, String> {
    let (dir, enabled) = find(root, id)?;
    let text = fs::read_to_string(dir.join("SKILL.md")).map_err(io)?;
    let skill = read_skill(&dir, enabled).ok_or("That skill doesn't exist")?;
    Ok(SkillDetail { skill, body: split(&text).1.trim().to_string() })
}

fn check(description: &str, body: &str) -> Result<(), String> {
    if description.trim().is_empty() {
        return Err("Say when the agent should use this skill".into());
    }
    if body.trim().is_empty() {
        return Err("Write what the agent should do".into());
    }
    Ok(())
}

/// A new skill, on, named from `name`.
pub fn create(root: &Path, name: &str, description: &str, body: &str) -> Result<Skill, String> {
    check(description, body)?;
    let id = free_id(root, name)?;
    let dir = root.join(ON).join(&id);
    fs::create_dir_all(&dir).map_err(io)?;
    let mut head = Vec::new();
    set_field(&mut head, "name", &id);
    set_field(&mut head, "description", description.trim());
    fs::write(dir.join("SKILL.md"), compose(&head, body)).map_err(io)?;
    read_skill(&dir, true).ok_or_else(|| "Couldn't save the skill".into())
}

/// New description and instructions for a skill; its other frontmatter fields stay.
pub fn update(root: &Path, id: &str, description: &str, body: &str) -> Result<Skill, String> {
    check(description, body)?;
    let (dir, enabled) = find(root, id)?;
    let file = dir.join("SKILL.md");
    let (mut head, _) = split(&fs::read_to_string(&file).map_err(io)?);
    set_field(&mut head, "name", id);
    set_field(&mut head, "description", description.trim());
    fs::write(&file, compose(&head, body)).map_err(io)?;
    read_skill(&dir, enabled).ok_or_else(|| "Couldn't save the skill".into())
}

pub fn set_enabled(root: &Path, id: &str, enabled: bool) -> Result<Skill, String> {
    let (dir, was) = find(root, id)?;
    if was == enabled {
        return read_skill(&dir, enabled).ok_or_else(|| "That skill doesn't exist".into());
    }
    let to = root.join(if enabled { ON } else { OFF }).join(id);
    fs::create_dir_all(to.parent().unwrap()).map_err(io)?;
    fs::rename(&dir, &to).map_err(io)?;
    read_skill(&to, enabled).ok_or_else(|| "That skill doesn't exist".into())
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let (dir, _) = find(root, id)?;
    fs::remove_dir_all(dir).map_err(io)
}

fn folder_size(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => folder_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Copies files and folders; symlinks are skipped so nothing outside the skill comes along.
fn copy_folder(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let t = entry.file_type()?;
        let target = to.join(entry.file_name());
        if t.is_dir() {
            copy_folder(&entry.path(), &target)?;
        } else if t.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Copying one folder into the other would never end (or copy the skills into themselves).
fn overlaps(folder: &Path, root: &Path) -> bool {
    let (Ok(a), Ok(b)) = (folder.canonicalize(), root.canonicalize()) else { return false };
    a.starts_with(&b) || b.starts_with(&a)
}

/// Adds a skill from a SKILL.md file, or a folder with one (its other files come too). It starts on.
/// A file named SKILL.md brings its folder along when that folder is small enough to be the skill's own.
pub fn import(root: &Path, source: &Path) -> Result<Skill, String> {
    let (file, folder) = if source.is_dir() {
        (source.join("SKILL.md"), Some(source))
    } else {
        let own = source.parent().filter(|p| {
            source.file_name().is_some_and(|n| n == "SKILL.md") && !overlaps(p, root) && folder_size(p) <= IMPORT_LIMIT
        });
        (source.to_path_buf(), own)
    };
    let text = fs::read_to_string(&file).map_err(|_| "Pick a SKILL.md file, or a folder with one".to_string())?;
    let (mut head, body) = split(&text);
    let fallback = folder
        .and_then(|f| f.file_name())
        .or_else(|| file.file_stem())
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let name = field(&head, "name").filter(|n| !skill_id(n).is_empty()).unwrap_or(fallback);
    let description = field(&head, "description").unwrap_or_default();
    if description.trim().is_empty() {
        return Err("This SKILL.md doesn't say when to use it (its description is missing)".into());
    }
    if body.trim().is_empty() {
        return Err("This SKILL.md has no instructions".into());
    }
    if let Some(f) = folder {
        if overlaps(f, root) {
            return Err("That folder is already part of your skills".into());
        }
        if folder_size(f) > IMPORT_LIMIT {
            return Err("That folder is too big for a skill (over 20 MB)".into());
        }
    }
    let id = free_id(root, &name)?;
    let dir = root.join(ON).join(&id);
    match folder {
        Some(f) => copy_folder(f, &dir).map_err(io)?,
        None => fs::create_dir_all(&dir).map_err(io)?,
    }
    set_field(&mut head, "name", &id);
    fs::write(dir.join("SKILL.md"), compose(&head, &body)).map_err(io)?;
    read_skill(&dir, true).ok_or_else(|| "Couldn't add the skill".into())
}

/// The plugin folder for Claude, when at least one skill is on.
pub fn plugin(root: &Path) -> Option<PathBuf> {
    list(root).iter().any(|s| s.enabled).then(|| root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = root(tmp.path()).unwrap();
        (tmp, root)
    }

    #[test]
    fn root_is_a_claude_plugin() {
        let (_t, root) = setup();
        let manifest = fs::read_to_string(root.join(".claude-plugin/plugin.json")).unwrap();
        assert!(manifest.contains("\"name\":\"my-skills\""));
        assert!(plugin(&root).is_none(), "no skills yet: no plugin");
    }

    #[test]
    fn create_writes_a_skill_claude_can_load() {
        let (_t, root) = setup();
        let s = create(&root, "Hook ideas!", "Use when: writing hooks", "Start with a question.").unwrap();
        assert_eq!(s.id, "hook-ideas");
        assert!(s.enabled);
        let text = fs::read_to_string(&s.path).unwrap();
        assert!(text.starts_with("---\nname: \"hook-ideas\"\ndescription: \"Use when: writing hooks\"\n---\n\nStart with a question.\n"));
        assert_eq!(s.description, "Use when: writing hooks");
        assert_eq!(plugin(&root), Some(root.clone()));
    }

    #[test]
    fn same_name_gets_a_number() {
        let (_t, root) = setup();
        create(&root, "Hooks", "d", "b").unwrap();
        assert_eq!(create(&root, "hooks", "d", "b").unwrap().id, "hooks-2");
    }

    #[test]
    fn create_needs_a_name_description_and_body() {
        let (_t, root) = setup();
        assert!(create(&root, "!!!", "d", "b").is_err());
        assert!(create(&root, "a", " ", "b").is_err());
        assert!(create(&root, "a", "d", "").is_err());
    }

    #[test]
    fn turning_off_moves_it_out_of_the_plugin() {
        let (_t, root) = setup();
        create(&root, "a", "d", "b").unwrap();
        let off = set_enabled(&root, "a", false).unwrap();
        assert!(!off.enabled);
        assert!(root.join("disabled/a/SKILL.md").is_file());
        assert!(plugin(&root).is_none());
        assert!(set_enabled(&root, "a", true).unwrap().enabled);
        assert_eq!(list(&root).len(), 1);
    }

    #[test]
    fn update_keeps_other_frontmatter() {
        let (_t, root) = setup();
        let dir = root.join("skills/x");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: x\ndescription: >\n  old\n  text\nallowed-tools: Read\n---\nold body\n").unwrap();
        let s = update(&root, "x", "new", "new body").unwrap();
        assert_eq!(s.description, "new");
        let text = fs::read_to_string(&s.path).unwrap();
        assert!(text.contains("allowed-tools: Read"));
        assert!(!text.contains("old"));
        assert_eq!(read(&root, "x").unwrap().body, "new body");
    }

    #[test]
    fn ids_cannot_leave_the_root() {
        let (_t, root) = setup();
        assert!(delete(&root, "../user-skills").is_err());
        assert!(read(&root, "a/b").is_err());
    }

    #[test]
    fn import_a_folder_brings_its_files() {
        let (t, root) = setup();
        let src = t.path().join("src/My Skill");
        fs::create_dir_all(src.join("scripts")).unwrap();
        fs::write(src.join("SKILL.md"), "---\nname: 'Fancy Thing'\ndescription: \"Does it\"\n---\nDo it.\n").unwrap();
        fs::write(src.join("scripts/run.sh"), "echo").unwrap();
        let s = import(&root, &src).unwrap();
        assert_eq!(s.id, "fancy-thing");
        assert_eq!(s.description, "Does it");
        assert!(root.join("skills/fancy-thing/scripts/run.sh").is_file());
        assert!(fs::read_to_string(&s.path).unwrap().contains("name: \"fancy-thing\""));
    }

    #[test]
    fn import_a_file_named_from_its_stem_without_a_name() {
        let (t, root) = setup();
        let file = t.path().join("captions.md");
        fs::write(&file, "---\ndescription: Captions\n---\nWrite captions.\n").unwrap();
        assert_eq!(import(&root, &file).unwrap().id, "captions");
    }

    #[test]
    fn picking_a_skill_md_brings_its_folder() {
        let (t, root) = setup();
        let src = t.path().join("downloads/captions");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("SKILL.md"), "---\ndescription: Captions\n---\nWrite captions.\n").unwrap();
        fs::write(src.join("styles.md"), "bold").unwrap();
        let s = import(&root, &src.join("SKILL.md")).unwrap();
        assert_eq!(s.id, "captions");
        assert!(root.join("skills/captions/styles.md").is_file());
    }

    #[test]
    fn a_skill_md_next_to_the_skills_folder_comes_alone() {
        let (t, root) = setup();
        let file = t.path().join("SKILL.md");
        fs::write(&file, "---\ndescription: d\n---\nb\n").unwrap();
        let s = import(&root, &file).unwrap();
        assert!(!root.join("skills").join(&s.id).join("user-skills").exists());
        assert!(import(&root, &root).is_err());
    }

    #[test]
    fn import_refuses_without_description() {
        let (t, root) = setup();
        let file = t.path().join("SKILL.md");
        fs::write(&file, "just text").unwrap();
        assert!(import(&root, &file).is_err());
        assert!(list(&root).is_empty());
    }

    #[test]
    fn delete_removes_it() {
        let (_t, root) = setup();
        create(&root, "a", "d", "b").unwrap();
        delete(&root, "a").unwrap();
        assert!(list(&root).is_empty());
    }
}
