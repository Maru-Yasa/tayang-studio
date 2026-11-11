//! SQLite storage for settings, projects, chats, styles and jobs.

use crate::types::*;
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug)]
pub struct DbError(pub String);

/// `delete_style`'s refusal while an autopilot uses the style, followed by that autopilot's name; the
/// UI says it in the user's language.
pub const STYLE_IN_USE: &str = "style-in-use:";

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        DbError(e.to_string())
    }
}
impl From<serde_json::Error> for DbError {
    fn from(e: serde_json::Error) -> Self {
        DbError(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, DbError>;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL, folder TEXT NOT NULL,
  kind TEXT NOT NULL, format TEXT NOT NULL, language TEXT NOT NULL, status TEXT NOT NULL,
  style_id TEXT, scheduled_at TEXT, duration_sec REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'none', posted_at TEXT, reminded_at TEXT,
  review_reminded_at TEXT, social_post_id TEXT
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, project_id TEXT, agent_id TEXT NOT NULL,
  title TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
  parts TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat_at ON messages(chat_id, created_at);
DROP INDEX IF EXISTS messages_chat;
CREATE TABLE IF NOT EXISTS styles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, source_url TEXT,
  notes TEXT NOT NULL, prompt TEXT NOT NULL, created_at TEXT NOT NULL,
  engine TEXT, preview_url TEXT, preview_video_url TEXT, template TEXT, version INTEGER, based_on TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, project_id TEXT, chat_id TEXT,
  agent_id TEXT NOT NULL, status TEXT NOT NULL, progress REAL, note TEXT, source_url TEXT, updated_at TEXT NOT NULL,
  render_baseline_at TEXT
);
CREATE TABLE IF NOT EXISTS autopilots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, niche TEXT NOT NULL, language TEXT NOT NULL,
  style_id TEXT NOT NULL, agent_id TEXT NOT NULL, frequency TEXT NOT NULL, length_sec INTEGER NOT NULL,
  review INTEGER NOT NULL, posting TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  niche_id TEXT, voice_id TEXT, social_account_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS autopilot_slots (
  id TEXT PRIMARY KEY, autopilot_id TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL,
  project_id TEXT, error TEXT, UNIQUE(autopilot_id, due_at)
);
";

// Column lists use camelCase aliases so rows deserialize straight into the serde types.
const PROJECT_SELECT: &str = "SELECT id, title, slug, folder, kind, format, language, status, \
    style_id AS styleId, scheduled_at AS scheduledAt, duration_sec AS durationSec, \
    created_at AS createdAt, updated_at AS updatedAt, review_state AS reviewState, \
    posted_at AS postedAt, reminded_at AS remindedAt, review_reminded_at AS reviewRemindedAt, \
    social_post_id AS socialPostId FROM projects";
const PROJECT_KEYS: [&str; 18] = [
    "id", "title", "slug", "folder", "kind", "format", "language", "status", "styleId",
    "scheduledAt", "durationSec", "createdAt", "updatedAt", "reviewState", "postedAt", "remindedAt",
    "reviewRemindedAt", "socialPostId",
];
const CHAT_SELECT: &str = "SELECT id, project_id AS projectId, agent_id AS agentId, title, \
    created_at AS createdAt FROM chats";
const JOB_SELECT: &str = "SELECT id, kind, title, project_id AS projectId, chat_id AS chatId, \
    agent_id AS agentId, status, progress, note, source_url AS sourceUrl, updated_at AS updatedAt, \
    render_baseline_at AS renderBaselineAt, archived_at AS archivedAt FROM jobs";
const JOB_KEYS: [&str; 12] = [
    "id", "kind", "title", "projectId", "chatId", "agentId", "status", "progress", "note",
    "sourceUrl", "updatedAt", "renderBaselineAt",
];

const AUTOPILOT_SELECT: &str = "SELECT id, name, niche, language, style_id AS styleId, agent_id AS agentId, \
    frequency, length_sec AS lengthSec, review, posting, status, created_at AS createdAt, \
    updated_at AS updatedAt, niche_id AS nicheId, voice_id AS voiceId, \
    social_account_ids AS socialAccountIds FROM autopilots";
const SLOT_SELECT: &str = "SELECT id, autopilot_id AS autopilotId, due_at AS dueAt, status, \
    project_id AS projectId, error FROM autopilot_slots";

pub const DEFAULT_API_URL: &str = "https://studio.tayang.app/api";

/// The API moved under `/api` (https://studio.tayang.app/api). A saved address from before
/// that is rewritten on read: the old production host becomes the default, a bare local dev
/// server gets `/api`. Anything else is the user's choice and is left alone.
fn migrate_api_url(url: &str) -> Option<String> {
    let bare = url.strip_suffix('/').unwrap_or(url);
    match bare {
        "https://api.tayang.app" => Some(DEFAULT_API_URL.to_string()),
        "http://localhost:8787" | "http://127.0.0.1:8787" => Some(format!("{bare}/api")),
        _ => None,
    }
}

/// Ids of the hard-coded built-ins older versions seeded; they now come from the API.
const LEGACY_BUILTIN_IDS: [&str; 3] =
    ["builtin-bold-explainer", "builtin-kinetic-quote", "builtin-news-recap"];

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// An RFC 3339 instant as UTC text (`...Z`, seconds), so slots compare as plain strings.
fn utc(at: &str) -> Result<String> {
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|dt| dt.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .map_err(|_| DbError(format!("That date and time isn't valid: {at}")))
}

fn valid_time(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && matches!(t[..2].parse::<u8>(), Ok(h) if h < 24)
        && matches!(t[3..].parse::<u8>(), Ok(m) if m < 60)
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit()
}

/// 1 to 6 distinct "HH:MM" times.
fn check_times(times: &[String]) -> Result<()> {
    let bad = |m: &str| Err(DbError(m.to_string()));
    if times.is_empty() || times.len() > 6 {
        return bad("Pick 1 to 6 times a day");
    }
    if times.iter().any(|t| !valid_time(t)) {
        return bad("Times must look like 09:30");
    }
    let mut sorted = times.to_vec();
    sorted.sort();
    sorted.dedup();
    if sorted.len() != times.len() {
        return bad("Each time can only be used once");
    }
    Ok(())
}

/// 1 to 7 distinct weekdays, 0 to 6.
fn check_days(days: &[u8]) -> Result<()> {
    let bad = |m: &str| Err(DbError(m.to_string()));
    if days.is_empty() || days.iter().any(|d| *d > 6) {
        return bad("Pick days between 0 and 6");
    }
    let mut sorted = days.to_vec();
    sorted.sort();
    sorted.dedup();
    if sorted.len() != days.len() {
        return bad("Each day can only be picked once");
    }
    Ok(())
}

/// Most target accounts one post may have (the API's limit).
const MAX_POST_ACCOUNTS: usize = 10;

/// The rules the wizard also follows: name and niche filled in, 1 to 6 distinct "HH:MM" times on
/// chosen days, a short-form length of 15 to 180 s, a voice name the voice route takes, and
/// automatic posting only with 1 to 10 distinct accounts.
pub fn validate_autopilot(a: &AutopilotInput) -> Result<()> {
    let bad = |m: &str| Err(DbError(m.to_string()));
    if a.name.trim().is_empty() {
        return bad("Give the autopilot a name");
    }
    if a.niche.trim().is_empty() {
        return bad("Describe the niche");
    }
    if a.style_id.trim().is_empty() {
        return bad("Pick a style");
    }
    if !(15..=180).contains(&a.length_sec) {
        return bad("The video length must be 15 to 180 seconds");
    }
    if let Some(v) = &a.voice_id {
        if v.is_empty() || v.len() > 64 || !v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-')) {
            return bad("That voice can't be used");
        }
    }
    let mut accounts = a.social_account_ids.clone();
    accounts.sort();
    accounts.dedup();
    if accounts.len() != a.social_account_ids.len() || accounts.len() > MAX_POST_ACCOUNTS {
        return bad("Pick up to 10 different accounts");
    }
    if a.posting == Posting::Automatic && accounts.is_empty() {
        return bad("Pick at least one account to post to");
    }
    match &a.frequency {
        AutopilotFrequency::Daily { times } => check_times(times)?,
        AutopilotFrequency::Weekly { days, time } => {
            check_days(days)?;
            if !valid_time(time) {
                return bad("The time must look like 09:30");
            }
        }
        AutopilotFrequency::Days { days, times } => {
            check_days(days)?;
            check_times(times)?;
        }
    }
    Ok(())
}

fn sql_from_json(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Sql::Integer(i),
            None => Sql::Real(n.as_f64().unwrap_or_default()),
        },
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn json_from_ref(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

/// Serializes `item` and returns its values in `keys` order, ready to bind.
fn bind_values<T: serde::Serialize>(item: &T, keys: &[&str]) -> Result<Vec<Sql>> {
    let v = serde_json::to_value(item)?;
    Ok(keys.iter().map(|k| sql_from_json(v.get(*k).unwrap_or(&Value::Null))).collect())
}

fn query_as<T: DeserializeOwned>(
    conn: &Connection,
    sql: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt.query_map(args, |row| {
        let mut obj = Map::new();
        for (i, n) in names.iter().enumerate() {
            obj.insert(n.clone(), json_from_ref(row.get_ref(i)?));
        }
        Ok(Value::Object(obj))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(serde_json::from_value(r?)?);
    }
    Ok(out)
}

fn merge_patch(target: &mut Value, patch: &Value) {
    if let (Value::Object(t), Value::Object(p)) = (target, patch) {
        for (k, v) in p {
            t.insert(k.clone(), v.clone());
        }
    }
}

pub struct Db {
    conn: Mutex<Connection>,
    home: Mutex<std::path::PathBuf>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Db> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Db> {
        conn.execute_batch(SCHEMA)?;
        Self::migrate_styles(&conn)?;
        Self::migrate_jobs(&conn)?;
        Self::migrate_projects(&conn)?;
        Self::migrate_autopilots(&conn)?;
        Self::migrate_archive(&conn)?;
        Ok(Db { conn: Mutex::new(conn), home: Mutex::new(Default::default()) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---- settings ----

    fn default_settings(home: &Path) -> Value {
        json!({
            "workingFolder": home.join("Tayang").to_string_lossy(),
            "defaultAgent": "claude",
            "frameCheck": true,
            "language": "id",
            "format": "9:16",
            "fps": 30,
            "onboarded": false,
            "apiUrl": DEFAULT_API_URL,
            "installId": "",
            "shareInstallStats": true,
            "lastPingAt": null,
            "autoMode": false,
            "uiLanguage": null,
            "backgroundMode": false,
            "openAtLogin": false,
            "buildJobsChecked": false,
            "projectStatusChecked": false,
            "agentModels": {},
            "voiceSource": "tayang",
        })
    }

    /// The install id, made (uuid v4) and saved the first time it's asked for.
    pub fn ensure_install_id(&self, home: &Path) -> Result<String> {
        let current = self.get_settings(home).install_id;
        if !current.is_empty() {
            return Ok(current);
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.update_settings(json!({ "installId": id }))?;
        Ok(id)
    }

    fn settings_value(&self, home: &Path) -> Result<Value> {
        let mut v = Self::default_settings(home);
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (k, raw) = row?;
            if let (Ok(val), Some(obj)) = (serde_json::from_str::<Value>(&raw), v.as_object_mut()) {
                obj.insert(k, val);
            }
        }
        if let Some(new) = v.get("apiUrl").and_then(Value::as_str).and_then(migrate_api_url) {
            v["apiUrl"] = Value::String(new);
        }
        Ok(v)
    }

    /// Stored values over defaults; a stored value that no longer parses falls back to defaults.
    pub fn get_settings(&self, home: &Path) -> Settings {
        *self.home.lock().unwrap_or_else(|e| e.into_inner()) = home.to_path_buf();
        self.settings_value(home)
            .and_then(|v| Ok(serde_json::from_value(v)?))
            .unwrap_or_else(|_| {
                serde_json::from_value(Self::default_settings(home)).expect("valid defaults")
            })
    }

    /// Merges `patch` over the current settings, validates, and persists only the patched
    /// keys, so unset keys (like the home-based working folder) keep following their defaults.
    /// The returned value uses the home from the last `get_settings` call for unset defaults.
    pub fn update_settings(&self, patch: Value) -> Result<Settings> {
        if !patch.is_object() {
            return Err(DbError("settings patch must be a JSON object".into()));
        }
        let home = self.home.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut merged = self.settings_value(&home)?;
        merge_patch(&mut merged, &patch);
        let settings: Settings = serde_json::from_value(merged)?;
        let full = serde_json::to_value(&settings)?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for k in patch.as_object().into_iter().flat_map(|o| o.keys()) {
            let Some(v) = full.get(k) else { continue };
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![k, v.to_string()],
            )?;
        }
        tx.commit()?;
        Ok(settings)
    }

    // ---- sign-in account cache ----

    /// The account last seen for a keychain account (`api:<base>`), for showing it offline.
    /// Lives in the settings table under its own key; never holds the token.
    pub fn auth_account(&self, key: &str) -> Option<Account> {
        let raw: Option<String> = self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [format!("authAccount:{key}")], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        raw.and_then(|v| serde_json::from_str(&v).ok())
    }

    /// Saves (or with `None`, forgets) the cached account for `key`.
    pub fn set_auth_account(&self, key: &str, account: Option<&Account>) -> Result<()> {
        let k = format!("authAccount:{key}");
        match account {
            Some(a) => self.conn().execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![k, serde_json::to_string(a)?],
            )?,
            None => self.conn().execute("DELETE FROM settings WHERE key = ?1", [k])?,
        };
        Ok(())
    }

    // ---- projects ----

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let sql = format!("{PROJECT_SELECT} ORDER BY updated_at DESC, rowid DESC");
        query_as(&self.conn(), &sql, &[])
    }

    pub fn insert_project(&self, p: &Project) -> Result<()> {
        let vals = bind_values(p, &PROJECT_KEYS)?;
        self.conn().execute(
            "INSERT INTO projects (id, title, slug, folder, kind, format, language, status, \
             style_id, scheduled_at, duration_sec, created_at, updated_at, \
             review_state, posted_at, reminded_at, review_reminded_at, social_post_id) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            params_from_iter(vals),
        )?;
        Ok(())
    }

    /// Removes a project row. Only for drafts a failed schedule batch created a moment ago.
    pub fn delete_project(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM projects WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn get_project(&self, id: &str) -> Result<Option<Project>> {
        let sql = format!("{PROJECT_SELECT} WHERE id = ?1");
        Ok(query_as::<Project>(&self.conn(), &sql, &[&id])?.into_iter().next())
    }

    /// Shallow-merges `patch` over the stored project. `id` cannot change; `updatedAt`
    /// is bumped unless the patch sets it.
    pub fn update_project(&self, id: &str, patch: Value) -> Result<Project> {
        if let Some(new_id) = patch.get("id") {
            if new_id != &json!(id) {
                return Err(DbError("project id cannot be changed".into()));
            }
        }
        let current = self
            .get_project(id)?
            .ok_or_else(|| DbError(format!("project not found: {id}")))?;
        let mut merged = serde_json::to_value(&current)?;
        if patch.get("updatedAt").is_none() {
            merged["updatedAt"] = json!(now());
        }
        merge_patch(&mut merged, &patch);
        let updated: Project = serde_json::from_value(merged)?;
        let mut vals = bind_values(&updated, &PROJECT_KEYS)?;
        let id_val = vals.remove(0);
        vals.push(id_val);
        self.conn().execute(
            "UPDATE projects SET title=?1, slug=?2, folder=?3, kind=?4, format=?5, language=?6, \
             status=?7, style_id=?8, scheduled_at=?9, duration_sec=?10, created_at=?11, \
             updated_at=?12, review_state=?13, posted_at=?14, reminded_at=?15, review_reminded_at=?16, \
             social_post_id=?17 WHERE id=?18",
            params_from_iter(vals),
        )?;
        Ok(updated)
    }

    /// Moves a project along draft → building → rendered. Without `reset` it never goes back, and a
    /// project already there (or `scheduled`, from older data) is returned as it is, unwritten.
    /// `scheduled` is never set: scheduling lives in `scheduledAt`. `updatedAt` never changes.
    pub fn set_project_status(&self, id: &str, status: ProjectStatus, reset: bool) -> Result<Project> {
        let rank = |s: ProjectStatus| match s {
            ProjectStatus::Draft => 0,
            ProjectStatus::Building => 1,
            ProjectStatus::Rendered => 2,
            ProjectStatus::Scheduled => 3,
        };
        if status == ProjectStatus::Scheduled {
            return Err(DbError("a project's schedule is its scheduledAt, not its status".into()));
        }
        let current = self
            .get_project(id)?
            .ok_or_else(|| DbError(format!("project not found: {id}")))?;
        let moves = if reset { current.status != status } else { rank(status) > rank(current.status) };
        if !moves {
            return Ok(current);
        }
        // Not an edit: `updatedAt` (the "recent" order and "x ago") stays as it was.
        self.update_project(id, json!({ "status": status, "updatedAt": current.updated_at }))
    }

    // ---- chats and messages ----

    pub fn create_chat(&self, project_id: Option<&str>, agent: AgentId, title: &str) -> Result<Chat> {
        let chat = Chat {
            id: new_id(),
            project_id: project_id.map(str::to_string),
            agent_id: agent,
            title: title.to_string(),
            created_at: now(),
        };
        let vals = bind_values(&chat, &["id", "projectId", "agentId", "title", "createdAt"])?;
        self.conn().execute(
            "INSERT INTO chats (id, project_id, agent_id, title, created_at) VALUES (?1,?2,?3,?4,?5)",
            params_from_iter(vals),
        )?;
        Ok(chat)
    }

    /// `Some(id)` lists that project's chats; `None` lists chats not tied to a project.
    pub fn list_chats(&self, project_id: Option<&str>) -> Result<Vec<Chat>> {
        let conn = self.conn();
        match project_id {
            Some(p) => query_as(
                &conn,
                &format!("{CHAT_SELECT} WHERE project_id = ?1 ORDER BY created_at DESC, rowid DESC"),
                &[&p],
            ),
            None => query_as(
                &conn,
                &format!("{CHAT_SELECT} WHERE project_id IS NULL ORDER BY created_at DESC, rowid DESC"),
                &[],
            ),
        }
    }

    /// Chats, project or not, newest activity first; a project once (its most active chat), at most
    /// `limit` entries. Chats of a deleted project are left out.
    pub fn list_recent_chats(&self, limit: Option<u32>) -> Result<Vec<RecentChat>> {
        let limit = limit.map_or(-1, i64::from);
        query_as(
            &self.conn(),
            "WITH active AS ( \
               SELECT c.id, c.project_id, c.agent_id, c.title, c.created_at, c.rowid AS rid, p.title AS project_title, \
                 COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.chat_id = c.id), c.created_at) AS active_at \
               FROM chats c LEFT JOIN projects p ON p.id = c.project_id \
               WHERE (c.project_id IS NULL OR p.id IS NOT NULL) AND c.archived_at IS NULL \
             ), ranked AS ( \
               SELECT *, ROW_NUMBER() OVER (PARTITION BY COALESCE(project_id, id) ORDER BY active_at DESC, rid DESC) AS n \
               FROM active \
             ) \
             SELECT id, project_id AS projectId, agent_id AS agentId, title, created_at AS createdAt, \
               project_title AS projectTitle, active_at AS activeAt \
             FROM ranked WHERE n = 1 ORDER BY active_at DESC, rid DESC LIMIT ?1",
            &[&limit],
        )
    }

    /// Archived threads, most recently archived first: a project once, like Recent.
    pub fn list_archived_chats(&self) -> Result<Vec<RecentChat>> {
        query_as(
            &self.conn(),
            "WITH arch AS ( \
               SELECT c.id, c.project_id, c.agent_id, c.title, c.created_at, c.archived_at, c.rowid AS rid, \
                 p.title AS project_title, \
                 COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.chat_id = c.id), c.created_at) AS active_at \
               FROM chats c LEFT JOIN projects p ON p.id = c.project_id \
               WHERE (c.project_id IS NULL OR p.id IS NOT NULL) AND c.archived_at IS NOT NULL \
             ), ranked AS ( \
               SELECT *, ROW_NUMBER() OVER (PARTITION BY COALESCE(project_id, id) ORDER BY active_at DESC, rid DESC) AS n \
               FROM arch \
             ) \
             SELECT id, project_id AS projectId, agent_id AS agentId, title, created_at AS createdAt, \
               project_title AS projectTitle, active_at AS activeAt, archived_at AS archivedAt \
             FROM ranked WHERE n = 1 ORDER BY archived_at DESC, rid DESC",
            &[],
        )
    }

    /// Archives or restores a whole thread: every chat of the chat's project, or the chat alone.
    pub fn set_thread_archived(&self, chat_id: &str, archived: bool) -> Result<()> {
        let stamp: Option<String> = archived.then(now);
        self.conn().execute(
            "UPDATE chats SET archived_at = ?2 \
             WHERE COALESCE(project_id, id) = (SELECT COALESCE(project_id, id) FROM chats WHERE id = ?1)",
            rusqlite::params![chat_id, stamp],
        )?;
        Ok(())
    }

    /// Archives or restores board cards. A working card is never archived: it is still going.
    pub fn set_jobs_archived(&self, ids: &[String], archived: bool) -> Result<()> {
        let stamp: Option<String> = archived.then(now);
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE jobs SET archived_at = ?2 WHERE id = ?1 AND (?2 IS NULL OR status <> 'working')",
                rusqlite::params![id, stamp],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Deletes everything archived for good: archived chats with their messages, and archived cards.
    /// Projects and their folders (the videos) stay. Returns (chats, cards) removed.
    pub fn purge_archive(&self) -> Result<(usize, usize)> {
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE archived_at IS NOT NULL)", [])?;
        let chats = tx.execute("DELETE FROM chats WHERE archived_at IS NOT NULL", [])?;
        let cards = tx.execute("DELETE FROM jobs WHERE archived_at IS NOT NULL AND status <> 'working'", [])?;
        tx.commit()?;
        Ok((chats, cards))
    }

    /// Points a chat at another agent. `None` when the chat doesn't exist.
    pub fn set_chat_agent(&self, chat_id: &str, agent: AgentId) -> Result<Option<Chat>> {
        let v = serde_json::to_value(agent)?;
        self.conn().execute(
            "UPDATE chats SET agent_id = ?1 WHERE id = ?2",
            rusqlite::params![v.as_str().unwrap_or_default(), chat_id],
        )?;
        self.get_chat(chat_id)
    }

    pub fn get_chat(&self, id: &str) -> Result<Option<Chat>> {
        let sql = format!("{CHAT_SELECT} WHERE id = ?1");
        Ok(query_as::<Chat>(&self.conn(), &sql, &[&id])?.into_iter().next())
    }

    pub fn add_message(
        &self,
        chat_id: &str,
        role: MessageRole,
        parts: &[MessagePart],
    ) -> Result<ChatMessage> {
        let msg = ChatMessage {
            id: new_id(),
            chat_id: chat_id.to_string(),
            role,
            parts: parts.to_vec(),
            created_at: now(),
        };
        let role_s = serde_json::to_value(role)?;
        self.conn().execute(
            "INSERT INTO messages (id, chat_id, role, parts, created_at) VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![
                msg.id,
                msg.chat_id,
                role_s.as_str().unwrap_or_default(),
                serde_json::to_string(&msg.parts)?,
                msg.created_at
            ],
        )?;
        // Writing in an archived thread brings it back to Recent.
        if role == MessageRole::User {
            self.set_thread_archived(chat_id, false)?;
        }
        Ok(msg)
    }

    pub fn list_messages(&self, chat_id: &str) -> Result<Vec<ChatMessage>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, chat_id AS chatId, role, parts, created_at AS createdAt \
             FROM messages WHERE chat_id = ?1 ORDER BY rowid",
        )?;
        let rows = stmt.query_map([chat_id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "chatId": r.get::<_, String>(1)?,
                "role": r.get::<_, String>(2)?,
                "parts": r.get::<_, String>(3)?,
                "createdAt": r.get::<_, String>(4)?,
            }))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut v = row?;
            let parts: Value = serde_json::from_str(v["parts"].as_str().unwrap_or("[]"))?;
            v["parts"] = parts;
            out.push(serde_json::from_value(v)?);
        }
        Ok(out)
    }

    // ---- styles ----

    /// Adds the API-backed columns to databases created before them and drops the old
    /// hard-coded built-ins (the API owns built-ins now).
    fn migrate_styles(conn: &Connection) -> Result<()> {
        let mut have: Vec<String> = Vec::new();
        {
            let mut stmt = conn.prepare("PRAGMA table_info(styles)")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
            for r in rows {
                have.push(r?);
            }
        }
        for (col, ty) in [
            ("engine", "TEXT"),
            ("preview_url", "TEXT"),
            ("preview_video_url", "TEXT"),
            ("template", "TEXT"),
            ("version", "INTEGER"),
            ("based_on", "TEXT"),
            ("build", "TEXT"),
            ("palette", "TEXT"),
            ("refs", "TEXT"),
        ] {
            if !have.iter().any(|c| c == col) {
                conn.execute_batch(&format!("ALTER TABLE styles ADD COLUMN {col} {ty}"))?;
            }
        }
        for id in LEGACY_BUILTIN_IDS {
            conn.execute("DELETE FROM styles WHERE id = ?1 AND source = 'builtin'", [id])?;
        }
        Ok(())
    }

    /// Adds the niche, voice and account columns to databases created before them.
    fn migrate_autopilots(conn: &Connection) -> Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(autopilots)")?;
        let have = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        for (col, def) in [("niche_id", "TEXT"), ("voice_id", "TEXT"), ("social_account_ids", "TEXT NOT NULL DEFAULT '[]'")] {
            if !have.iter().any(|c| c == col) {
                conn.execute_batch(&format!("ALTER TABLE autopilots ADD COLUMN {col} {def}"))?;
            }
        }
        Ok(())
    }

    /// Adds the review and posting columns to databases created before them.
    fn migrate_projects(conn: &Connection) -> Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(projects)")?;
        let have = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        for (col, def) in [
            ("review_state", "TEXT NOT NULL DEFAULT 'none'"),
            ("posted_at", "TEXT"),
            ("reminded_at", "TEXT"),
            ("review_reminded_at", "TEXT"),
            ("social_post_id", "TEXT"),
        ] {
            if !have.iter().any(|c| c == col) {
                conn.execute_batch(&format!("ALTER TABLE projects ADD COLUMN {col} {def}"))?;
            }
        }
        Ok(())
    }

    /// Adds `archived_at` to chats and jobs in databases created before the archive.
    fn migrate_archive(conn: &Connection) -> Result<()> {
        for table in ["chats", "jobs"] {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let have = stmt
                .query_map([], |r| r.get::<_, String>(1))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(stmt);
            if !have.iter().any(|c| c == "archived_at") {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN archived_at TEXT"))?;
            }
        }
        Ok(())
    }

    /// Adds `jobs.source_url` and `jobs.render_baseline_at` to databases created before them.
    fn migrate_jobs(conn: &Connection) -> Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(jobs)")?;
        let have = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        if !have.iter().any(|c| c == "source_url") {
            conn.execute_batch("ALTER TABLE jobs ADD COLUMN source_url TEXT")?;
        }
        if !have.iter().any(|c| c == "render_baseline_at") {
            conn.execute_batch("ALTER TABLE jobs ADD COLUMN render_baseline_at TEXT")?;
        }
        Ok(())
    }

    /// Replaces every built-in style with `styles` (API order is kept, styles the API no
    /// longer lists are deleted). Copied and own styles are untouched.
    pub fn replace_builtin_styles(&self, styles: &[Style]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        // A built-in the API no longer offers stays while an autopilot uses it or a clone is based on it:
        // a style in use never vanishes.
        tx.execute(
            "DELETE FROM styles WHERE source = 'builtin' \
             AND id NOT IN (SELECT style_id FROM autopilots) \
             AND id NOT IN (SELECT based_on FROM styles WHERE based_on IS NOT NULL)",
            [],
        )?;
        for s in styles {
            let existing: Option<String> =
                tx.query_row("SELECT source FROM styles WHERE id = ?1", [&s.id], |r| r.get(0)).optional()?;
            if existing.as_deref().is_some_and(|src| src != "builtin") {
                // Not a built-in: this one belongs to the user.
                eprintln!("style sync: skipping built-in \"{}\", a style of that id already exists", s.id);
                continue;
            }
            let engine = match s.engine {
                Some(e) => serde_json::to_value(e)?.as_str().map(str::to_string),
                None => None,
            };
            let template = match &s.template {
                Some(t) => Some(serde_json::to_string(t)?),
                None => None,
            };
            tx.execute(
                "INSERT OR REPLACE INTO styles (id, name, source, source_url, notes, prompt, created_at, \
                 engine, preview_url, preview_video_url, template, version) \
                 VALUES (?1,?2,'builtin',NULL,?3,?4,?5,?6,?7,?8,?9,?10)",
                rusqlite::params![
                    s.id,
                    s.name,
                    serde_json::to_string(&s.notes)?,
                    s.prompt,
                    s.created_at,
                    engine,
                    s.preview_url,
                    s.preview_video_url,
                    template,
                    s.version
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    #[cfg(test)]
    pub fn break_for_test(&self) {
        self.conn().execute_batch("DROP TABLE styles").unwrap();
    }

    pub fn get_style(&self, id: &str) -> Result<Option<Style>> {
        Ok(self.list_styles()?.into_iter().find(|s| s.id == id))
    }

    pub fn list_styles(&self) -> Result<Vec<Style>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, source, source_url AS sourceUrl, notes, prompt, created_at AS createdAt, \
             engine, preview_url AS previewUrl, preview_video_url AS previewVideoUrl, template, version, based_on AS basedOn, build, palette, refs AS \"references\" FROM styles \
             ORDER BY CASE source WHEN 'builtin' THEN 0 ELSE 1 END, \
             CASE source WHEN 'builtin' THEN rowid END, created_at, rowid",
        )?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt.query_map([], |row| {
            let mut obj = Map::new();
            for (i, n) in names.iter().enumerate() {
                obj.insert(n.clone(), json_from_ref(row.get_ref(i)?));
            }
            Ok(Value::Object(obj))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut v = row?;
            let notes: Value = serde_json::from_str(v["notes"].as_str().unwrap_or("{}"))?;
            v["notes"] = notes;
            if let Some(t) = v["template"].as_str().map(str::to_string) {
                v["template"] = serde_json::from_str(&t)?;
            }
            // JSON arrays in TEXT columns; empty or unreadable means none.
            for key in ["palette", "references"] {
                let list = v[key].as_str().and_then(|t| serde_json::from_str::<Value>(t).ok()).unwrap_or(Value::Array(vec![]));
                v[key] = list;
            }
            out.push(serde_json::from_value(v)?);
        }
        Ok(out)
    }

    /// Inserts or replaces a style. Built-in styles are read-only.
    pub fn save_style(&self, s: &Style) -> Result<()> {
        let conn = self.conn();
        if Self::is_builtin(&conn, &s.id)? || s.source == StyleSource::Builtin {
            return Err(DbError("built-in styles cannot be changed".into()));
        }
        let source = serde_json::to_value(s.source)?;
        let engine = match s.engine {
            Some(e) => serde_json::to_value(e)?.as_str().map(str::to_string),
            None => None,
        };
        let template = match &s.template {
            Some(t) => Some(serde_json::to_string(t)?),
            None => None,
        };
        conn.execute(
            "INSERT INTO styles (id, name, source, source_url, notes, prompt, created_at, engine, preview_url, \
             preview_video_url, template, version, based_on, build, palette, refs) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) ON CONFLICT(id) DO UPDATE SET name=excluded.name, \
             source=excluded.source, source_url=excluded.source_url, notes=excluded.notes, \
             prompt=excluded.prompt, created_at=excluded.created_at, engine=excluded.engine, \
             preview_url=excluded.preview_url, preview_video_url=excluded.preview_video_url, \
             template=excluded.template, version=excluded.version, based_on=excluded.based_on, \
             build=excluded.build, palette=excluded.palette, refs=excluded.refs",
            rusqlite::params![
                s.id,
                s.name,
                source.as_str().unwrap_or_default(),
                s.source_url,
                serde_json::to_string(&s.notes)?,
                s.prompt,
                s.created_at,
                engine,
                s.preview_url,
                s.preview_video_url,
                template,
                s.version,
                s.based_on,
                s.build,
                serde_json::to_string(&s.palette)?,
                serde_json::to_string(&s.references)?
            ],
        )?;
        Ok(())
    }

    pub fn delete_style(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        if Self::is_builtin(&conn, id)? {
            return Err(DbError("built-in styles cannot be deleted".into()));
        }
        // An autopilot would quietly lose its look: the user changes that autopilot first.
        let user: Option<String> = conn
            .query_row("SELECT name FROM autopilots WHERE style_id = ?1 ORDER BY created_at LIMIT 1", [id], |r| r.get(0))
            .optional()?;
        if let Some(name) = user {
            return Err(DbError(format!("{STYLE_IN_USE}{name}")));
        }
        conn.execute("DELETE FROM styles WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Tests: a style row gone the way older versions could lose it (a built-in dropped by sync).
    #[cfg(test)]
    pub fn remove_style_row(&self, id: &str) {
        self.conn().execute("DELETE FROM styles WHERE id = ?1", [id]).unwrap();
    }

    fn is_builtin(conn: &Connection, id: &str) -> Result<bool> {
        let source: Option<String> = conn
            .query_row("SELECT source FROM styles WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        Ok(source.as_deref() == Some("builtin"))
    }

    // ---- jobs ----

    pub fn upsert_job(&self, j: &Job) -> Result<()> {
        let vals = bind_values(j, &JOB_KEYS)?;
        self.conn().execute(
            "INSERT INTO jobs (id, kind, title, project_id, chat_id, agent_id, status, progress, note, source_url, updated_at, render_baseline_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, \
             title=excluded.title, project_id=excluded.project_id, chat_id=excluded.chat_id, \
             agent_id=excluded.agent_id, status=excluded.status, progress=excluded.progress, \
             note=excluded.note, source_url=excluded.source_url, updated_at=excluded.updated_at, \
             render_baseline_at=excluded.render_baseline_at, \
             archived_at=CASE WHEN jobs.status = excluded.status THEN jobs.archived_at ELSE NULL END",
            params_from_iter(vals),
        )?;
        Ok(())
    }

    /// Marks jobs still `working` as failed with `note`: their agent died with the app.
    /// Returns how many changed.
    pub fn fail_stale_jobs(&self, note: &str) -> Result<usize> {
        Ok(self.conn().execute(
            // A permission request (needs-you, no note) died with its session too; a build turn that
            // stopped without a video (needs-you with its note) still waits for the user.
            "UPDATE jobs SET status = 'failed', note = ?1, updated_at = ?2 \
             WHERE status = 'working' OR (status = 'needs-you' AND note IS NULL)",
            rusqlite::params![note, now()],
        )?)
    }

    /// Removes a job from the board. A job that is working is never deleted (the board may be
    /// stale), and deleting a job that isn't there is fine.
    pub fn delete_job(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM jobs WHERE id = ?1 AND status <> 'working'", [id])?;
        Ok(())
    }

    pub fn list_jobs(&self) -> Result<Vec<Job>> {
        let sql = format!("{JOB_SELECT} ORDER BY updated_at DESC, rowid DESC");
        query_as(&self.conn(), &sql, &[])
    }

    // ---- autopilots ----

    fn autopilot_row(mut v: Value) -> Result<Autopilot> {
        // `frequency` and `socialAccountIds` are stored as JSON text and `review` as 0/1.
        if let Some(Value::String(f)) = v.get("frequency").cloned() {
            v["frequency"] = serde_json::from_str(&f)?;
        }
        if let Some(Value::String(ids)) = v.get("socialAccountIds").cloned() {
            v["socialAccountIds"] = serde_json::from_str(&ids)?;
        }
        let review = v.get("review").and_then(Value::as_i64).unwrap_or(0) != 0;
        v["review"] = Value::Bool(review);
        Ok(serde_json::from_value(v)?)
    }

    pub fn list_autopilots(&self) -> Result<Vec<Autopilot>> {
        let sql = format!("{AUTOPILOT_SELECT} ORDER BY created_at, rowid");
        query_as::<Value>(&self.conn(), &sql, &[])?.into_iter().map(Self::autopilot_row).collect()
    }

    pub fn get_autopilot(&self, id: &str) -> Result<Option<Autopilot>> {
        let sql = format!("{AUTOPILOT_SELECT} WHERE id = ?1");
        query_as::<Value>(&self.conn(), &sql, &[&id])?.into_iter().next().map(Self::autopilot_row).transpose()
    }

    /// Creates an autopilot (no id; starts active) or edits one (keeps its status and creation time).
    pub fn save_autopilot(&self, input: &AutopilotInput) -> Result<Autopilot> {
        validate_autopilot(input)?;
        let style_known: bool = self
            .conn()
            .query_row("SELECT 1 FROM styles WHERE id = ?1", [&input.style_id], |_| Ok(true))
            .optional()?
            .unwrap_or(false);
        if !style_known {
            return Err(DbError(format!("That style isn't in your library: {}", input.style_id)));
        }
        let existing = match input.id.as_deref() {
            Some(id) => Some(self.get_autopilot(id)?.ok_or_else(|| DbError(format!("No autopilot with id {id}")))?),
            None => None,
        };
        let stamp = now();
        let a = Autopilot {
            id: existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(new_id),
            name: input.name.trim().to_string(),
            niche: input.niche.trim().to_string(),
            niche_id: input.niche_id.clone(),
            language: input.language,
            style_id: input.style_id.clone(),
            voice_id: input.voice_id.clone(),
            agent_id: input.agent_id,
            frequency: input.frequency.clone(),
            length_sec: input.length_sec,
            review: input.review,
            posting: input.posting,
            social_account_ids: input.social_account_ids.clone(),
            status: existing.as_ref().map(|e| e.status).unwrap_or(AutopilotStatus::Active),
            created_at: existing.as_ref().map(|e| e.created_at.clone()).unwrap_or_else(|| stamp.clone()),
            updated_at: stamp,
        };
        let v = serde_json::to_value(&a)?;
        let text = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        // An edit may change when videos are due, so its future planned slots are dropped with it;
        // the engine's slot upkeep plans them again from the new settings on its next pass.
        if existing.is_some() {
            tx.execute(
                "DELETE FROM autopilot_slots WHERE autopilot_id = ?1 AND status = 'planned' AND due_at > ?2",
                rusqlite::params![a.id, now()],
            )?;
        }
        tx.execute(
            "INSERT INTO autopilots (id, name, niche, language, style_id, agent_id, frequency, length_sec, review, posting, status, created_at, updated_at, niche_id, voice_id, social_account_ids) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) ON CONFLICT(id) DO UPDATE SET name=excluded.name, \
             niche=excluded.niche, language=excluded.language, style_id=excluded.style_id, agent_id=excluded.agent_id, \
             frequency=excluded.frequency, length_sec=excluded.length_sec, review=excluded.review, \
             posting=excluded.posting, updated_at=excluded.updated_at, niche_id=excluded.niche_id, \
             voice_id=excluded.voice_id, social_account_ids=excluded.social_account_ids",
            rusqlite::params![
                a.id, a.name, a.niche, text("language"), a.style_id, text("agentId"),
                serde_json::to_string(&a.frequency)?, a.length_sec, a.review as i64, text("posting"),
                text("status"), a.created_at, a.updated_at, a.niche_id, a.voice_id,
                serde_json::to_string(&a.social_account_ids)?
            ],
        )?;
        tx.commit()?;
        Ok(a)
    }

    pub fn set_autopilot_status(&self, id: &str, status: AutopilotStatus) -> Result<Autopilot> {
        let text = serde_json::to_value(status)?.as_str().unwrap_or_default().to_string();
        {
            let conn = self.conn();
            let tx = conn.unchecked_transaction()?;
            let n = tx.execute(
                "UPDATE autopilots SET status = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![text, now(), id],
            )?;
            if n == 0 {
                return Err(DbError(format!("No autopilot with id {id}")));
            }
            // Pausing drops the future planned slots. Resuming leaves them empty: the engine's
            // slot upkeep plans the next 7 days again on its next pass.
            if status == AutopilotStatus::Paused {
                tx.execute(
                    "DELETE FROM autopilot_slots WHERE autopilot_id = ?1 AND status = 'planned' AND due_at > ?2",
                    rusqlite::params![id, now()],
                )?;
            }
            tx.commit()?;
        }
        self.get_autopilot(id)?.ok_or_else(|| DbError(format!("No autopilot with id {id}")))
    }

    /// Removes an autopilot and its slots that have not produced a video (planned, failed, skipped).
    /// Done slots and a slot being made stay; the videos themselves are never touched.
    pub fn delete_autopilot(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM autopilot_slots WHERE autopilot_id = ?1 AND status IN ('planned', 'failed', 'skipped')",
            [id],
        )?;
        tx.execute("DELETE FROM autopilots WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Slots due in `[from, to]` (RFC 3339 instants), earliest first.
    pub fn list_slots(&self, from: &str, to: &str) -> Result<Vec<AutopilotSlot>> {
        let (from, to) = (utc(from)?, utc(to)?);
        let sql = format!("{SLOT_SELECT} WHERE due_at >= ?1 AND due_at <= ?2 ORDER BY due_at, rowid");
        query_as(&self.conn(), &sql, &[&from, &to])
    }

    /// Makes sure a planned slot exists for (autopilot, dueAt) and returns it. A slot that already
    /// exists is returned untouched, so planning again never undoes progress.
    pub fn upsert_slot(&self, autopilot_id: &str, due_at: &str) -> Result<AutopilotSlot> {
        let due = utc(due_at)?;
        if self.get_autopilot(autopilot_id)?.is_none() {
            return Err(DbError(format!("No autopilot with id {autopilot_id}")));
        }
        let conn = self.conn();
        // Only an active autopilot gets new slots (checked in the same statement, so a pause that lands
        // during the engine's upkeep can't leave planned slots behind); an existing slot is returned as is.
        conn.execute(
            "INSERT OR IGNORE INTO autopilot_slots (id, autopilot_id, due_at, status) \
             SELECT ?1, ?2, ?3, 'planned' WHERE EXISTS (SELECT 1 FROM autopilots WHERE id = ?2 AND status = 'active')",
            rusqlite::params![new_id(), autopilot_id, due],
        )?;
        let sql = format!("{SLOT_SELECT} WHERE autopilot_id = ?1 AND due_at = ?2");
        query_as::<AutopilotSlot>(&conn, &sql, &[&autopilot_id, &due])?
            .into_iter()
            .next()
            .ok_or_else(|| DbError("This autopilot is paused, so it gets no new slots".into()))
    }

    /// Changes a slot's status, project or error. Keys left out stay as they are; `null` clears.
    pub fn update_slot(&self, id: &str, patch: Value) -> Result<AutopilotSlot> {
        let sql = format!("{SLOT_SELECT} WHERE id = ?1");
        let conn = self.conn();
        let current = query_as::<AutopilotSlot>(&conn, &sql, &[&id])?
            .into_iter()
            .next()
            .ok_or_else(|| DbError(format!("No slot with id {id}")))?;
        let mut v = serde_json::to_value(&current)?;
        for key in ["status", "projectId", "error"] {
            if let Some(x) = patch.get(key) {
                v[key] = x.clone();
            }
        }
        let next: AutopilotSlot = serde_json::from_value(v)?;
        let status = serde_json::to_value(next.status)?.as_str().unwrap_or_default().to_string();
        conn.execute(
            "UPDATE autopilot_slots SET status = ?1, project_id = ?2, error = ?3 WHERE id = ?4",
            rusqlite::params![status, next.project_id, next.error, id],
        )?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    #[test]
    fn auth_account_cache_is_per_api_and_stays_out_of_settings() {
        let db = db();
        let home = PathBuf::from("/home/u");
        let a = Account {
            id: "acc_1".into(),
            email: Some("a@b.c".into()),
            name: Some("Ana".into()),
            plan: "pro".into(),
            features: vec!["voiceover".into()],
            credits: 310,
        };
        assert_eq!(db.auth_account("api:https://studio.tayang.app/api"), None);
        db.set_auth_account("api:https://studio.tayang.app/api", Some(&a)).unwrap();
        assert_eq!(db.auth_account("api:https://studio.tayang.app/api"), Some(a.clone()));
        assert_eq!(db.auth_account("api:http://localhost:8787/api"), None);
        let before = db.get_settings(&home);
        db.update_settings(json!({ "fps": 60 })).unwrap();
        assert_eq!(db.get_settings(&home).api_url, before.api_url, "settings still parse");
        assert!(!serde_json::to_string(&db.get_settings(&home)).unwrap().contains("a@b.c"));
        db.set_auth_account("api:https://studio.tayang.app/api", None).unwrap();
        assert_eq!(db.auth_account("api:https://studio.tayang.app/api"), None);
    }

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn project(id: &str, updated: &str) -> Project {
        Project {
            id: id.into(),
            title: format!("Title {id}"),
            slug: id.into(),
            folder: format!("/w/{id}"),
            kind: VideoKind::Promo,
            format: VideoFormat::Portrait,
            language: VideoLanguage::Id,
            status: ProjectStatus::Draft,
            style_id: None,
            scheduled_at: None,
            review_state: ReviewState::None,
            posted_at: None,
            reminded_at: None,
            review_reminded_at: None,
            social_post_id: None,
            duration_sec: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: updated.into(),
        }
    }

    #[test]
    fn old_api_addresses_are_migrated_on_read() {
        let home = PathBuf::from("/home/u");
        for (stored, want) in [
            ("https://api.tayang.app", DEFAULT_API_URL),
            ("https://api.tayang.app/", DEFAULT_API_URL),
            ("http://localhost:8787", "http://localhost:8787/api"),
            ("http://localhost:8787/", "http://localhost:8787/api"),
            ("http://127.0.0.1:8787", "http://127.0.0.1:8787/api"),
            ("http://127.0.0.1:8787/", "http://127.0.0.1:8787/api"),
            // Anything else is left alone.
            ("http://localhost:8787/api", "http://localhost:8787/api"),
            ("http://localhost:8787/v2", "http://localhost:8787/v2"),
            ("https://api.tayang.app/v1", "https://api.tayang.app/v1"),
            ("http://localhost:8790", "http://localhost:8790"),
            ("https://mine.test", "https://mine.test"),
        ] {
            let db = db();
            db.conn()
                .execute("INSERT INTO settings (key, value) VALUES ('apiUrl', ?1)", [json!(stored).to_string()])
                .unwrap();
            assert_eq!(db.get_settings(&home).api_url, want, "{stored}");
            assert_eq!(db.get_settings(&home).api_url, want, "idempotent: {stored}");
            // A later save of another key keeps the migrated address.
            assert_eq!(db.update_settings(json!({"fps": 60})).unwrap().api_url, want, "{stored}");
        }
    }

    #[test]
    fn settings_defaults_and_update() {
        let db = db();
        let home = PathBuf::from("/home/u");
        let s = db.get_settings(&home);
        assert_eq!(s.working_folder, home.join("Tayang").to_string_lossy());
        assert_eq!(s.default_agent, AgentId::Claude);
        assert!(s.frame_check && !s.onboarded);
        assert_eq!(s.api_url, "https://studio.tayang.app/api");
        assert_eq!((s.language, s.format, s.fps), (VideoLanguage::Id, VideoFormat::Portrait, 30));
        assert_eq!(s.ui_language, None);
        assert!(!s.background_mode && !s.open_at_login);
        let b = db.update_settings(json!({"backgroundMode": true, "openAtLogin": true})).unwrap();
        assert!(b.background_mode && b.open_at_login);
        assert!(db.get_settings(&home).background_mode);
        db.update_settings(json!({"backgroundMode": false, "openAtLogin": false})).unwrap();
        assert!(!s.build_jobs_checked, "the one-time build job check hasn't run");
        db.update_settings(json!({"buildJobsChecked": true})).unwrap();
        assert!(db.get_settings(&home).build_jobs_checked);
        assert!(!s.project_status_checked, "the one-time project status backfill hasn't run");
        db.update_settings(json!({"projectStatusChecked": true})).unwrap();
        assert!(db.get_settings(&home).project_status_checked);
        let l = db.update_settings(json!({"uiLanguage": "id"})).unwrap();
        assert_eq!(l.ui_language, Some(UiLanguage::Id));
        assert_eq!(db.get_settings(&home).ui_language, Some(UiLanguage::Id));

        let u = db.update_settings(json!({"fps": 60, "onboarded": true, "defaultAgent": "gemini"})).unwrap();
        assert_eq!(u.fps, 60);
        let again = db.get_settings(&home);
        assert_eq!(again, u);
        assert!(again.onboarded);
        assert_eq!(again.default_agent, AgentId::Gemini);
        assert_eq!(again.working_folder, home.join("Tayang").to_string_lossy());
        assert!(db.update_settings(json!({"fps": "fast"})).is_err());
        assert!(db.update_settings(json!([1])).is_err());
        assert!(db.update_settings(json!("x")).is_err());
        assert_eq!(db.get_settings(&home).fps, 60);
    }

    #[test]
    fn update_settings_before_get_keeps_home_default() {
        let db = db();
        db.update_settings(json!({"fps": 24})).unwrap();
        let home = PathBuf::from("/home/u");
        let s = db.get_settings(&home);
        assert_eq!(s.fps, 24);
        assert_eq!(s.working_folder, home.join("Tayang").to_string_lossy());
        let other = PathBuf::from("/home/v");
        assert_eq!(db.get_settings(&other).working_folder, other.join("Tayang").to_string_lossy());
    }

    #[test]
    fn project_insert_list_update() {
        let db = db();
        db.insert_project(&project("a", "2026-01-01T00:00:00Z")).unwrap();
        db.insert_project(&project("b", "2026-02-01T00:00:00Z")).unwrap();
        let ids: Vec<_> = db.list_projects().unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(db.get_project("zzz").unwrap(), None);

        let up = db
            .update_project("a", json!({"title": "New", "status": "rendered", "durationSec": 12.5, "styleId": "builtin-news-recap"}))
            .unwrap();
        assert_eq!(up.title, "New");
        assert_eq!(up.status, ProjectStatus::Rendered);
        assert_eq!(up.duration_sec, Some(12.5));
        assert_eq!(db.get_project("a").unwrap().unwrap(), up);
        let ids: Vec<_> = db.list_projects().unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["a", "b"]);

        assert!(db.update_project("a", json!({"id": "other"})).is_err());
        assert!(db.update_project("a", json!({"status": "bogus"})).is_err());
        assert!(db.update_project("missing", json!({"title": "x"})).is_err());
        assert_eq!(db.get_project("a").unwrap().unwrap().title, "New");
    }

    #[test]
    fn project_status_only_moves_forward_unless_reset() {
        let db = db();
        db.insert_project(&project("a", "2026-01-01T00:00:00Z")).unwrap();
        let b = db.set_project_status("a", ProjectStatus::Building, false).unwrap();
        assert_eq!(b.status, ProjectStatus::Building);
        // A status move is not an edit: the project keeps its place in "recent" lists.
        assert_eq!(b.updated_at, "2026-01-01T00:00:00Z");
        assert_eq!(db.get_project("a").unwrap().unwrap().updated_at, "2026-01-01T00:00:00Z");
        // The same status again changes nothing, not even the time.
        let again = db.set_project_status("a", ProjectStatus::Building, false).unwrap();
        assert_eq!(again, b);
        let r = db.set_project_status("a", ProjectStatus::Rendered, false).unwrap();
        assert_eq!(r.status, ProjectStatus::Rendered);
        assert_eq!(r.updated_at, "2026-01-01T00:00:00Z");
        assert_eq!(db.set_project_status("a", ProjectStatus::Draft, true).unwrap().updated_at, "2026-01-01T00:00:00Z");
        db.set_project_status("a", ProjectStatus::Rendered, false).unwrap();
        // Never backwards on its own.
        assert_eq!(db.set_project_status("a", ProjectStatus::Building, false).unwrap().status, ProjectStatus::Rendered);
        assert_eq!(db.set_project_status("a", ProjectStatus::Draft, false).unwrap().status, ProjectStatus::Rendered);
        // An explicit reset may.
        assert_eq!(db.set_project_status("a", ProjectStatus::Draft, true).unwrap().status, ProjectStatus::Draft);
        assert_eq!(db.get_project("a").unwrap().unwrap().status, ProjectStatus::Draft);
        // Scheduling lives in scheduledAt, not in the status.
        assert!(db.set_project_status("a", ProjectStatus::Scheduled, false).is_err());
        assert!(db.set_project_status("a", ProjectStatus::Scheduled, true).is_err());
        assert!(db.set_project_status("missing", ProjectStatus::Building, false).is_err());
        // A project that somehow has `scheduled` keeps it.
        db.update_project("a", json!({"status": "scheduled"})).unwrap();
        assert_eq!(db.set_project_status("a", ProjectStatus::Rendered, false).unwrap().status, ProjectStatus::Scheduled);
    }

    #[test]
    fn set_chat_agent_persists_and_misses_unknown_chats() {
        let db = Db::open_in_memory().unwrap();
        let chat = db.create_chat(Some("a"), AgentId::Claude, "Fix intro").unwrap();
        let updated = db.set_chat_agent(&chat.id, AgentId::Codex).unwrap().unwrap();
        assert_eq!(updated.agent_id, AgentId::Codex);
        assert_eq!(updated.title, "Fix intro");
        assert_eq!(db.get_chat(&chat.id).unwrap().unwrap().agent_id, AgentId::Codex);
        assert_eq!(db.set_chat_agent("nope", AgentId::Gemini).unwrap(), None);
    }

    #[test]
    fn an_archived_thread_leaves_recent_until_restored_or_written_in() {
        let db = db();
        db.insert_project(&project("a", "2026-01-01T00:00:00Z")).unwrap();
        let first = db.create_chat(Some("a"), AgentId::Claude, "First").unwrap();
        let second = db.create_chat(Some("a"), AgentId::Claude, "Second").unwrap();
        let loose = db.create_chat(None, AgentId::Claude, "Loose").unwrap();
        // Archiving one chat of a project archives the whole thread.
        db.set_thread_archived(&first.id, true).unwrap();
        let ids = |v: Vec<RecentChat>| v.into_iter().map(|c| c.id).collect::<Vec<_>>();
        assert_eq!(ids(db.list_recent_chats(None).unwrap()), vec![loose.id.clone()]);
        let archived = db.list_archived_chats().unwrap();
        assert_eq!(archived.len(), 1, "a project shows once");
        assert_eq!(archived[0].project_id.as_deref(), Some("a"));
        assert!(archived[0].archived_at.is_some());
        db.set_thread_archived(&second.id, false).unwrap();
        assert_eq!(db.list_recent_chats(None).unwrap().len(), 2);
        assert!(db.list_archived_chats().unwrap().is_empty());
        // The user writing in an archived thread brings it back; the agent writing does not.
        db.set_thread_archived(&loose.id, true).unwrap();
        db.add_message(&loose.id, MessageRole::Agent, &[]).unwrap();
        assert_eq!(db.list_archived_chats().unwrap().len(), 1);
        db.add_message(&loose.id, MessageRole::User, &[]).unwrap();
        assert!(db.list_archived_chats().unwrap().is_empty());
    }

    #[test]
    fn purging_the_archive_deletes_archived_chats_and_cards_only() {
        let db = db();
        let gone = db.create_chat(None, AgentId::Claude, "Gone").unwrap();
        let kept = db.create_chat(None, AgentId::Claude, "Kept").unwrap();
        db.add_message(&gone.id, MessageRole::User, &[]).unwrap();
        db.add_message(&kept.id, MessageRole::User, &[]).unwrap();
        db.set_thread_archived(&gone.id, true).unwrap();
        let job = |id: &str, status: JobStatus| Job {
            id: id.into(),
            kind: JobKind::Build,
            title: id.into(),
            project_id: None,
            chat_id: None,
            agent_id: AgentId::Claude,
            status,
            progress: None,
            note: None,
            source_url: None,
            render_baseline_at: None,
            updated_at: "2026-01-01T00:00:00Z".into(),
            archived_at: None,
        };
        db.upsert_job(&job("done", JobStatus::Done)).unwrap();
        db.upsert_job(&job("busy", JobStatus::Working)).unwrap();
        db.upsert_job(&job("other", JobStatus::Done)).unwrap();
        db.set_jobs_archived(&["done".into(), "busy".into()], true).unwrap();
        let archived = |id: &str| db.list_jobs().unwrap().into_iter().find(|j| j.id == id).unwrap().archived_at.is_some();
        assert!(archived("done"));
        assert!(!archived("busy"), "a working card is never archived");
        // Rewriting a card with the same status keeps it archived; a new status brings it back.
        db.upsert_job(&job("done", JobStatus::Done)).unwrap();
        assert!(archived("done"));
        db.upsert_job(&job("other", JobStatus::Done)).unwrap();
        db.set_jobs_archived(&["other".into()], true).unwrap();
        db.upsert_job(&job("other", JobStatus::Working)).unwrap();
        assert!(!archived("other"));

        assert_eq!(db.purge_archive().unwrap(), (1, 1));
        assert!(db.get_chat(&gone.id).unwrap().is_none());
        assert!(db.list_messages(&gone.id).unwrap().is_empty());
        assert_eq!(db.list_messages(&kept.id).unwrap().len(), 1);
        let left: Vec<String> = db.list_jobs().unwrap().into_iter().map(|j| j.id).collect();
        assert!(!left.contains(&"done".to_string()) && left.contains(&"busy".to_string()));
    }

    #[test]
    fn recent_chats_newest_activity_first_with_project_titles() {
        let db = db();
        db.insert_project(&project("a", "2026-01-01T00:00:00Z")).unwrap();
        let video = db.create_chat(Some("a"), AgentId::Claude, "Video chat").unwrap();
        let loose = db.create_chat(None, AgentId::Codex, "Loose").unwrap();
        let quiet = db.create_chat(None, AgentId::Claude, "Quiet").unwrap();
        // A chat of a deleted project has nowhere to go: it is left out.
        let orphan = db.create_chat(Some("gone"), AgentId::Claude, "Orphan").unwrap();
        let conn = db.conn();
        conn.execute("UPDATE chats SET created_at = '2026-01-01T00:00:00Z'", []).unwrap();
        for (chat, at) in [(&video, "2026-01-02T00:00:00Z"), (&loose, "2026-01-03T00:00:00Z"), (&orphan, "2026-01-09T00:00:00Z")] {
            conn.execute(
                "INSERT INTO messages (id, chat_id, role, parts, created_at) VALUES (?1, ?2, 'user', '[]', ?3)",
                rusqlite::params![format!("m-{}", chat.id), chat.id, at],
            )
            .unwrap();
        }
        drop(conn);

        let recent = db.list_recent_chats(None).unwrap();
        let ids: Vec<&str> = recent.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec![loose.id.as_str(), video.id.as_str(), quiet.id.as_str()]);
        assert_eq!(recent[0].project_title, None);
        assert_eq!(recent[0].active_at, "2026-01-03T00:00:00Z");
        assert_eq!(recent[1].project_title.as_deref(), Some("Title a"));
        assert_eq!(recent[1].project_id.as_deref(), Some("a"));
        // No messages yet: the chat counts from when it was made.
        assert_eq!(recent[2].active_at, "2026-01-01T00:00:00Z");
        assert_eq!(recent[2].title, "Quiet");

        let top = db.list_recent_chats(Some(1)).unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].id, loose.id);
    }

    #[test]
    fn messages_have_a_chat_and_time_index_that_survives_reopening() {
        let db = db();
        let names = |db: &Db| -> Vec<String> {
            let conn = db.conn();
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' ORDER BY name")
                .unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert!(names(&db).contains(&"messages_chat_at".to_string()));
        // Running the schema again (every start) changes nothing.
        db.conn().execute_batch(SCHEMA).unwrap();
        assert_eq!(names(&db).iter().filter(|n| n.as_str() == "messages_chat_at").count(), 1);
        let conn = db.conn();
        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT MAX(created_at) FROM messages WHERE chat_id = 'x'",
                [],
                |r| r.get(3),
            )
            .unwrap();
        assert!(plan.contains("messages_chat_at"), "{plan}");
    }

    #[test]
    fn recent_chats_count_a_project_once_before_the_limit() {
        let db = db();
        db.insert_project(&project("a", "2026-01-01T00:00:00Z")).unwrap();
        let busy: Vec<Chat> = (0..5).map(|i| db.create_chat(Some("a"), AgentId::Claude, &format!("A{i}")).unwrap()).collect();
        let loose = db.create_chat(None, AgentId::Claude, "Loose").unwrap();
        let conn = db.conn();
        conn.execute("UPDATE chats SET created_at = '2026-01-01T00:00:00Z'", []).unwrap();
        conn.execute("UPDATE chats SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?1", [&busy[2].id]).unwrap();
        conn.execute("UPDATE chats SET created_at = '2026-01-03T00:00:00Z' WHERE project_id = 'a' AND id != ?1", [&busy[2].id])
            .unwrap();
        drop(conn);
        let recent = db.list_recent_chats(Some(2)).unwrap();
        let ids: Vec<&str> = recent.iter().map(|c| c.id.as_str()).collect();
        // The project's most active chat stands for it; the limit counts distinct entries.
        assert_eq!(ids.len(), 2);
        assert_eq!(recent[0].project_id.as_deref(), Some("a"));
        assert_ne!(recent[0].id, busy[2].id);
        assert_eq!(ids[1], loose.id.as_str());
    }

    #[test]
    fn chat_and_messages_round_trip() {
        let db = db();
        db.insert_project(&project("a", "2026-01-01T00:00:00Z")).unwrap();
        let chat = db.create_chat(Some("a"), AgentId::Claude, "Fix intro").unwrap();
        let global = db.create_chat(None, AgentId::Codex, "General").unwrap();
        assert_eq!(db.list_chats(Some("a")).unwrap(), vec![chat.clone()]);
        assert_eq!(db.list_chats(None).unwrap(), vec![global]);
        assert_eq!(db.get_chat(&chat.id).unwrap(), Some(chat.clone()));
        assert_eq!(db.get_chat("nope").unwrap(), None);

        let frame = MessagePart::Frame {
            project_id: "a".into(),
            frame: 42,
            time_sec: 1.4,
            image_path: "/x.png".into(),
            marks: vec![Mark { x: 0.5, y: 0.25 }],
        };
        let m1 = db.add_message(&chat.id, MessageRole::User, &[MessagePart::Text { text: "look".into() }, frame.clone()]).unwrap();
        let m2 = db.add_message(&chat.id, MessageRole::Agent, &[MessagePart::Text { text: "ok".into() }]).unwrap();
        let got = db.list_messages(&chat.id).unwrap();
        assert_eq!(got, vec![m1, m2]);
        assert_eq!(got[0].parts[1], frame);
    }

    fn builtin(id: &str, template: bool) -> Style {
        Style {
            id: id.into(),
            name: id.into(),
            source: StyleSource::Builtin,
            source_url: None,
            notes: BTreeMap::new(),
            prompt: "p".into(),
            created_at: "2026-11-04T00:00:00Z".into(),
            engine: Some(StyleEngine::Remotion),
            preview_url: Some(format!("https://api/v1/styles/{id}/preview")),
            preview_video_url: Some(format!("https://api/v1/styles/{id}/preview-video")),
            based_on: None,
            template: template
                .then(|| StyleTemplate { sha256: "ab".repeat(32), size: 10, version: 2 }),
            version: Some(2),
            build: None,
            palette: vec![],
            references: vec![],
        }
    }

    #[test]
    fn a_copied_style_keeps_its_recipe_palette_and_references() {
        let db = db();
        let copied = Style {
            source: StyleSource::Copied,
            source_url: Some("https://youtu.be/x".into()),
            template: None,
            preview_url: None,
            preview_video_url: None,
            build: Some("three.js in Remotion".into()),
            palette: vec!["#5BC8F5".into(), "#F2C14E".into()],
            references: vec!["/d/style-refs/copied-1/ref-1.jpg".into()],
            ..builtin("copied-1", false)
        };
        db.save_style(&copied).unwrap();
        assert_eq!(db.get_style("copied-1").unwrap(), Some(copied));
    }

    #[test]
    fn no_builtins_without_sync_and_user_styles_work() {
        let db = db();
        assert!(db.list_styles().unwrap().is_empty());
        let mine = Style {
            source: StyleSource::Mine,
            engine: None,
            preview_url: None,
            preview_video_url: None,
            template: None,
            based_on: None,
            version: None,
            ..builtin("s1", false)
        };
        db.save_style(&mine).unwrap();
        assert_eq!(db.list_styles().unwrap(), vec![mine.clone()]);
        db.delete_style("s1").unwrap();
        assert!(db.list_styles().unwrap().is_empty());
    }

    #[test]
    fn replace_builtins_upserts_orders_and_deletes_stale() {
        let db = db();
        let mine = Style { source: StyleSource::Mine, ..builtin("mine", false) };
        db.save_style(&mine).unwrap();
        db.replace_builtin_styles(&[builtin("b", true), builtin("a", false)]).unwrap();
        let ids = |db: &Db| db.list_styles().unwrap().into_iter().map(|s| s.id).collect::<Vec<_>>();
        assert_eq!(ids(&db), ["b", "a", "mine"]);
        assert_eq!(db.get_style("b").unwrap().unwrap().template.unwrap().size, 10);
        assert_eq!(
            db.get_style("b").unwrap().unwrap().preview_video_url.as_deref(),
            Some("https://api/v1/styles/b/preview-video")
        );
        // "a" disappears from the API, "c" is new.
        db.replace_builtin_styles(&[builtin("b", true), builtin("c", true)]).unwrap();
        assert_eq!(ids(&db), ["b", "c", "mine"]);
        assert!(db.delete_style("b").is_err(), "built-ins stay read-only");
    }

    #[test]
    fn a_clone_keeps_template_previews_and_based_on_and_survives_sync() {
        let db = db();
        db.replace_builtin_styles(&[builtin("atlas", true)]).unwrap();
        let clone = Style {
            id: "mine-1".into(),
            name: "atlas (copy)".into(),
            source: StyleSource::Mine,
            based_on: Some("atlas".into()),
            ..builtin("atlas", true)
        };
        db.save_style(&clone).unwrap();
        assert_eq!(db.get_style("mine-1").unwrap().unwrap(), clone);
        // Editing keeps every field; a later sync neither touches nor deletes it, nor the original
        // it is based on (a style in use never vanishes).
        let edited = Style { name: "Mine".into(), ..clone.clone() };
        db.save_style(&edited).unwrap();
        db.replace_builtin_styles(&[]).unwrap();
        assert_eq!(db.get_style("mine-1").unwrap().unwrap(), edited);
        assert!(db.get_style("atlas").unwrap().is_some());
    }

    #[test]
    fn sync_never_overwrites_a_row_that_is_not_built_in() {
        let db = db();
        let mine = Style { id: "clash".into(), name: "Mine".into(), source: StyleSource::Mine, ..builtin("clash", false) };
        let copied = Style { id: "clash2".into(), name: "Copied".into(), source: StyleSource::Copied, ..builtin("clash2", false) };
        db.save_style(&mine).unwrap();
        db.save_style(&copied).unwrap();
        db.replace_builtin_styles(&[builtin("clash", true), builtin("clash2", true), builtin("ok", true)]).unwrap();
        assert_eq!(db.get_style("clash").unwrap().unwrap(), mine);
        assert_eq!(db.get_style("clash2").unwrap().unwrap(), copied);
        assert_eq!(db.get_style("ok").unwrap().unwrap().source, StyleSource::Builtin);
    }

    #[test]
    fn migration_adds_columns_and_drops_legacy_builtins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tayang.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE styles (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, \
                 source_url TEXT, notes TEXT NOT NULL, prompt TEXT NOT NULL, created_at TEXT NOT NULL);
                 INSERT INTO styles VALUES ('builtin-bold-explainer','x','builtin',NULL,'{}','p','t');
                 INSERT INTO styles VALUES ('keep','y','mine',NULL,'{}','p','t');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let styles = db.list_styles().unwrap();
        assert_eq!(styles.len(), 1);
        assert_eq!(styles[0].id, "keep");
        assert_eq!(styles[0].template, None);
        assert_eq!(styles[0].preview_video_url, None);
        assert_eq!(styles[0].based_on, None);
        drop(db);
        assert_eq!(Db::open(&path).unwrap().list_styles().unwrap().len(), 1);
    }

    #[test]
    fn jobs_upsert_and_list() {
        let db = db();
        let mut j = Job {
            id: "j1".into(),
            kind: JobKind::Render,
            title: "Render".into(),
            project_id: None,
            chat_id: None,
            agent_id: AgentId::Claude,
            status: JobStatus::Queued,
            progress: None,
            note: None,
            source_url: None,
            render_baseline_at: None,
            archived_at: None,
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        db.upsert_job(&j).unwrap();
        j.status = JobStatus::Working;
        j.progress = Some(0.5);
        j.updated_at = "2026-01-02T00:00:00Z".into();
        j.render_baseline_at = Some("2026-01-01T23:59:00.000Z".into());
        db.upsert_job(&j).unwrap();
        assert_eq!(db.list_jobs().unwrap(), vec![j.clone()]);
        // A job written without it (an older UI) has none.
        let raw = serde_json::json!({ "id": "j2", "kind": "build", "title": "B", "projectId": null, "chatId": null, "agentId": "claude",
            "status": "done", "progress": null, "note": null, "sourceUrl": null, "updatedAt": "2026-01-03T00:00:00Z" });
        db.upsert_job(&serde_json::from_value(raw).unwrap()).unwrap();
        assert_eq!(db.list_jobs().unwrap()[0].render_baseline_at, None);
    }

    #[test]
    fn jobs_migration_adds_source_url_to_an_old_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tayang.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, \
                 project_id TEXT, chat_id TEXT, agent_id TEXT NOT NULL, status TEXT NOT NULL, \
                 progress REAL, note TEXT, updated_at TEXT NOT NULL);
                 INSERT INTO jobs VALUES ('old','study-style','Study','{}',NULL,'claude','failed',NULL,'n','t');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let jobs = db.list_jobs().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].source_url, None);
        assert_eq!(jobs[0].render_baseline_at, None);
        drop(db);
        // Opening again must not try to add the column twice.
        assert_eq!(Db::open(&path).unwrap().list_jobs().unwrap().len(), 1);
    }

    #[test]
    fn autopilots_migration_keeps_old_autopilots_and_adds_the_new_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tayang.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE autopilots (id TEXT PRIMARY KEY, name TEXT NOT NULL, niche TEXT NOT NULL, language TEXT NOT NULL, \
                 style_id TEXT NOT NULL, agent_id TEXT NOT NULL, frequency TEXT NOT NULL, length_sec INTEGER NOT NULL, \
                 review INTEGER NOT NULL, posting TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                 INSERT INTO autopilots VALUES ('old','Kopi','Coffee','id','s1','claude','{\"kind\":\"weekly\",\"days\":[1],\"time\":\"08:00\"}',30,1,'manual','active','c','u');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let a = db.get_autopilot("old").unwrap().unwrap();
        assert_eq!((a.niche_id, a.voice_id, a.social_account_ids.len(), a.length_sec), (None, None, 0, 30));
        assert_eq!(a.frequency, AutopilotFrequency::Weekly { days: vec![1], time: "08:00".into() });
    }

    #[test]
    fn projects_migration_adds_review_and_posting_columns_to_an_old_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tayang.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL, \
                 folder TEXT NOT NULL, kind TEXT NOT NULL, format TEXT NOT NULL, language TEXT NOT NULL, \
                 status TEXT NOT NULL, style_id TEXT, scheduled_at TEXT, duration_sec REAL, \
                 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                 INSERT INTO projects VALUES ('old','T','t','/w/t','promo','9:16','id','rendered',NULL,'2026-11-05T09:00:00Z',NULL,'c','u');",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let p = db.get_project("old").unwrap().unwrap();
        assert_eq!(p.review_state, ReviewState::None);
        assert_eq!(p.posted_at, None);
        assert_eq!(p.reminded_at, None);
        assert_eq!(p.review_reminded_at, None);
        assert_eq!(p.scheduled_at.as_deref(), Some("2026-11-05T09:00:00Z"));
        drop(db);
        // Opening again must not try to add the columns twice.
        assert_eq!(Db::open(&path).unwrap().list_projects().unwrap().len(), 1);
    }

    #[test]
    fn review_and_posting_fields_round_trip() {
        let db = db();
        db.insert_project(&project("a", "2026-01-01T00:00:00Z")).unwrap();
        let u = db
            .update_project(
                "a",
                json!({"reviewState": "pending", "postedAt": "2026-11-05T10:00:00Z", "remindedAt": "2026-11-05T08:00:00Z", "reviewRemindedAt": "2026-11-05T07:00:00Z"}),
            )
            .unwrap();
        assert_eq!(u.review_state, ReviewState::Pending);
        assert_eq!(u.review_reminded_at.as_deref(), Some("2026-11-05T07:00:00Z"));
        assert_eq!(db.get_project("a").unwrap().unwrap(), u);
    }

    #[test]
    fn delete_job_removes_only_that_job() {
        let db = db();
        let job = |id: &str| Job {
            id: id.into(),
            kind: JobKind::Build,
            title: id.into(),
            project_id: None,
            chat_id: None,
            agent_id: AgentId::Claude,
            status: JobStatus::Failed,
            progress: None,
            note: None,
            source_url: None,
            render_baseline_at: None,
            archived_at: None,
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        db.upsert_job(&job("a")).unwrap();
        db.upsert_job(&job("b")).unwrap();
        let mut working = job("w");
        working.status = JobStatus::Working;
        db.upsert_job(&working).unwrap();
        db.delete_job("a").unwrap();
        db.delete_job("missing").unwrap();
        // A job that is working again (stale board) is never deleted.
        db.delete_job("w").unwrap();
        let ids: Vec<_> = db.list_jobs().unwrap().into_iter().map(|j| j.id).collect();
        assert!(ids.contains(&"w".to_string()) && ids.contains(&"b".to_string()) && !ids.contains(&"a".to_string()));
    }

    #[test]
    fn stale_working_jobs_fail_on_start() {
        let db = db();
        let job = |id: &str, status: JobStatus| Job {
            id: id.into(),
            kind: JobKind::Build,
            title: id.into(),
            project_id: None,
            chat_id: None,
            agent_id: AgentId::Claude,
            status,
            progress: None,
            note: None,
            source_url: None,
            render_baseline_at: None,
            archived_at: None,
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let mut w = job("w", JobStatus::Working);
        w.source_url = Some("https://youtu.be/abc".into());
        db.upsert_job(&w).unwrap();
        db.upsert_job(&job("d", JobStatus::Done)).unwrap();
        db.upsert_job(&job("p", JobStatus::NeedsYou)).unwrap();
        let mut stopped = job("s", JobStatus::NeedsYou);
        stopped.note = Some("No video yet. The agent stopped before rendering".into());
        db.upsert_job(&stopped).unwrap();
        assert_eq!(db.fail_stale_jobs("closed").unwrap(), 2);
        let after = db.list_jobs().unwrap();
        assert_eq!(after.iter().find(|j| j.id == "p").unwrap().status, JobStatus::Failed);
        assert_eq!(after.iter().find(|j| j.id == "s").unwrap().status, JobStatus::NeedsYou);
        let jobs = db.list_jobs().unwrap();
        let w = jobs.iter().find(|j| j.id == "w").unwrap();
        assert_eq!((w.status, w.note.as_deref()), (JobStatus::Failed, Some("closed")));
        assert_eq!(w.source_url.as_deref(), Some("https://youtu.be/abc"));
        assert_eq!(jobs.iter().find(|j| j.id == "d").unwrap().status, JobStatus::Done);
    }

    /// A database whose library holds the styles `s1` and `s2`.
    fn adb() -> Db {
        let db = db();
        for id in ["s1", "s2"] {
            db.conn()
                .execute(
                    "INSERT INTO styles (id, name, source, notes, prompt, created_at) VALUES (?1, ?1, 'mine', '{}', '', 'x')",
                    [id],
                )
                .unwrap();
        }
        db
    }

    fn input(name: &str) -> AutopilotInput {
        AutopilotInput {
            id: None,
            name: name.into(),
            niche: "Coffee tips".into(),
            language: VideoLanguage::Id,
            style_id: "s1".into(),
            agent_id: AgentId::Claude,
            frequency: AutopilotFrequency::Daily { times: vec!["12:00".into(), "19:00".into()] },
            length_sec: 30,
            review: true,
            posting: Posting::Manual,
            niche_id: None,
            voice_id: None,
            social_account_ids: vec![],
        }
    }

    #[test]
    fn autopilot_keeps_niche_voice_accounts_and_chosen_days() {
        let db = adb();
        let mut i = input("Kopi");
        i.niche_id = Some("science-explained".into());
        i.voice_id = Some("Rachel".into());
        i.posting = Posting::Automatic;
        i.social_account_ids = vec!["sa_1".into(), "sa_2".into()];
        i.frequency = AutopilotFrequency::Days { days: vec![1, 2, 3, 4, 5], times: vec!["09:00".into(), "18:00".into()] };
        let a = db.save_autopilot(&i).unwrap();
        assert_eq!(db.get_autopilot(&a.id).unwrap().unwrap(), a);
        assert_eq!(a.social_account_ids, vec!["sa_1", "sa_2"]);
        assert_eq!(a.voice_id.as_deref(), Some("Rachel"));
    }

    #[test]
    fn autopilot_refuses_automatic_posting_it_cant_do() {
        let refused = |change: &dyn Fn(&mut AutopilotInput)| {
            let mut i = input("Kopi");
            change(&mut i);
            assert!(validate_autopilot(&i).is_err());
        };
        refused(&|i| i.posting = Posting::Automatic);
        refused(&|i| i.social_account_ids = vec!["a".into(), "a".into()]);
        refused(&|i| i.social_account_ids = (0..11).map(|n| n.to_string()).collect());
        refused(&|i| i.voice_id = Some("bad\"voice".into()));
        refused(&|i| i.frequency = AutopilotFrequency::Days { days: vec![], times: vec!["09:00".into()] });
        refused(&|i| i.frequency = AutopilotFrequency::Days { days: vec![1], times: vec![] });
    }

    #[test]
    fn autopilot_create_edit_status_and_round_trip() {
        let db = adb();
        let a = db.save_autopilot(&input("  Kopi  ")).unwrap();
        assert_eq!((a.name.as_str(), a.status, a.review), ("Kopi", AutopilotStatus::Active, true));
        assert_eq!(db.get_autopilot(&a.id).unwrap().unwrap(), a);
        let paused = db.set_autopilot_status(&a.id, AutopilotStatus::Paused).unwrap();
        assert_eq!(paused.status, AutopilotStatus::Paused);
        // Editing keeps the id, the status and the creation time.
        let mut edit = input("Kopi 2");
        edit.id = Some(a.id.clone());
        edit.review = false;
        edit.frequency = AutopilotFrequency::Weekly { days: vec![1, 3], time: "08:15".into() };
        let b = db.save_autopilot(&edit).unwrap();
        assert_eq!((b.id.as_str(), b.status, b.created_at.as_str()), (a.id.as_str(), AutopilotStatus::Paused, a.created_at.as_str()));
        let listed = db.list_autopilots().unwrap();
        assert_eq!(listed, vec![b]);
        assert!(!listed[0].review);
        assert!(db.set_autopilot_status("nope", AutopilotStatus::Active).is_err());
        let mut ghost = input("x");
        ghost.id = Some("nope".into());
        assert!(db.save_autopilot(&ghost).is_err());
    }

    #[test]
    fn autopilot_validation() {
        let db = adb();
        let reject = |f: &dyn Fn(&mut AutopilotInput)| {
            let mut i = input("A");
            f(&mut i);
            assert!(db.save_autopilot(&i).is_err());
        };
        reject(&|i| i.name = "  ".into());
        reject(&|i| i.niche = "".into());
        reject(&|i| i.style_id = "".into());
        reject(&|i| i.length_sec = 14);
        reject(&|i| i.length_sec = 181);
        reject(&|i| i.frequency = AutopilotFrequency::Daily { times: vec![] });
        reject(&|i| i.frequency = AutopilotFrequency::Daily { times: (0..7).map(|h| format!("0{h}:00")).collect() });
        for bad in ["24:00", "9:00", "12:60", "ab:cd", "12-00", ""] {
            reject(&|i| i.frequency = AutopilotFrequency::Daily { times: vec![bad.into()] });
        }
        reject(&|i| i.frequency = AutopilotFrequency::Daily { times: vec!["09:00".into(), "09:00".into()] });
        reject(&|i| i.frequency = AutopilotFrequency::Weekly { days: vec![], time: "09:00".into() });
        reject(&|i| i.frequency = AutopilotFrequency::Weekly { days: vec![7], time: "09:00".into() });
        reject(&|i| i.frequency = AutopilotFrequency::Weekly { days: vec![1, 1], time: "09:00".into() });
        reject(&|i| i.frequency = AutopilotFrequency::Weekly { days: vec![1], time: "9am".into() });
        let mut ok = input("A");
        ok.length_sec = 15;
        ok.frequency = AutopilotFrequency::Daily { times: (10..16).map(|h| format!("{h}:00")).collect() };
        assert!(db.save_autopilot(&ok).is_ok());
        ok.length_sec = 180;
        ok.frequency = AutopilotFrequency::Weekly { days: vec![0, 6], time: "23:59".into() };
        assert!(db.save_autopilot(&ok).is_ok());
    }

    #[test]
    fn a_paused_autopilot_gets_no_new_slots() {
        let db = adb();
        let a = db.save_autopilot(&input("A")).unwrap();
        let kept = db.upsert_slot(&a.id, "2026-11-01T09:00:00Z").unwrap();
        db.set_autopilot_status(&a.id, AutopilotStatus::Paused).unwrap();
        assert!(db.upsert_slot(&a.id, "2026-12-05T09:00:00Z").is_err());
        assert!(db.list_slots("2026-12-05T09:00:00Z", "2026-12-05T09:00:00Z").unwrap().is_empty());
        // An existing slot is still returned as it is.
        assert_eq!(db.upsert_slot(&a.id, "2026-11-01T09:00:00Z").unwrap(), kept);
    }

    #[test]
    fn slots_are_unique_normalised_listed_and_patched() {
        let db = adb();
        let a = db.save_autopilot(&input("A")).unwrap();
        assert!(db.upsert_slot("nope", "2026-11-05T09:00:00Z").is_err());
        assert!(db.upsert_slot(&a.id, "soon").is_err());
        let s = db.upsert_slot(&a.id, "2026-11-05T16:00:00+07:00").unwrap();
        assert_eq!((s.due_at.as_str(), s.status), ("2026-11-05T09:00:00Z", SlotStatus::Planned));
        db.upsert_slot(&a.id, "2026-11-06T09:00:00Z").unwrap();
        // The same instant in another offset is the same slot, and progress is never undone.
        let done = db.update_slot(&s.id, json!({"status": "making", "projectId": "p1"})).unwrap();
        assert_eq!((done.status, done.project_id.as_deref()), (SlotStatus::Making, Some("p1")));
        let again = db.upsert_slot(&a.id, "2026-11-05T09:00:00Z").unwrap();
        assert_eq!(again, done);
        let all = db.list_slots("2026-11-05T00:00:00Z", "2026-11-07T00:00:00Z").unwrap();
        assert_eq!(all.len(), 2);
        assert!(all[0].due_at < all[1].due_at);
        let one = db.list_slots("2026-11-05T09:00:00Z", "2026-11-05T09:00:00Z").unwrap();
        assert_eq!(one.len(), 1);
        assert!(db.list_slots("2026-11-07T00:00:00Z", "2026-11-08T00:00:00Z").unwrap().is_empty());
        // A patch changes only the keys it carries; null clears.
        let failed = db.update_slot(&s.id, json!({"status": "failed", "error": "No video"})).unwrap();
        assert_eq!((failed.project_id.as_deref(), failed.error.as_deref()), (Some("p1"), Some("No video")));
        let back = db.update_slot(&s.id, json!({"status": "planned", "error": null, "projectId": null})).unwrap();
        assert_eq!((back.status, back.project_id, back.error), (SlotStatus::Planned, None, None));
        assert!(db.update_slot("nope", json!({"status": "done"})).is_err());
        assert!(db.update_slot(&s.id, json!({"status": "bogus"})).is_err());
    }

    #[test]
    fn deleting_an_autopilot_drops_unfinished_slots_and_keeps_videos_and_other_autopilots() {
        let db = adb();
        db.insert_project(&project("p", "2026-01-01T00:00:00Z")).unwrap();
        let a = db.save_autopilot(&input("A")).unwrap();
        let b = db.save_autopilot(&input("B")).unwrap();
        let slot = |id: &str, at: &str, status: &str| {
            let s = db.upsert_slot(id, at).unwrap();
            db.update_slot(&s.id, json!({"status": status})).unwrap();
        };
        slot(&a.id, "2026-11-05T09:00:00Z", "planned");
        slot(&a.id, "2026-11-06T09:00:00Z", "failed");
        slot(&a.id, "2026-11-07T09:00:00Z", "skipped");
        slot(&a.id, "2026-11-08T09:00:00Z", "done");
        slot(&b.id, "2026-11-05T09:00:00Z", "planned");
        db.delete_autopilot(&a.id).unwrap();
        db.delete_autopilot("missing").unwrap();
        assert_eq!(db.list_autopilots().unwrap().len(), 1);
        let left = db.list_slots("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z").unwrap();
        let kept: Vec<_> = left.iter().map(|s| (s.autopilot_id.as_str(), s.status)).collect();
        assert_eq!(kept, vec![(b.id.as_str(), SlotStatus::Planned), (a.id.as_str(), SlotStatus::Done)]);
        assert_eq!(db.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn a_style_an_autopilot_uses_cannot_be_deleted() {
        let db = adb();
        db.save_autopilot(&input("Kopi pagi")).unwrap();
        assert_eq!(db.delete_style("s1").unwrap_err().0, "style-in-use:Kopi pagi");
        assert!(db.get_style("s1").unwrap().is_some());
        db.delete_style("s2").unwrap();
    }

    #[test]
    fn sync_keeps_a_built_in_an_autopilot_or_a_clone_still_uses() {
        let db = adb();
        db.replace_builtin_styles(&[builtin("used", false), builtin("cloned", false), builtin("gone", false)]).unwrap();
        let mut i = input("A");
        i.style_id = "used".into();
        db.save_autopilot(&i).unwrap();
        db.save_style(&Style { id: "mine-1".into(), source: StyleSource::Mine, based_on: Some("cloned".into()), ..builtin("x", false) })
            .unwrap();
        // The API stops offering all three: only the unused one goes.
        db.replace_builtin_styles(&[builtin("new", false)]).unwrap();
        for id in ["used", "cloned", "new", "mine-1"] {
            assert!(db.get_style(id).unwrap().is_some(), "{id}");
        }
        assert!(db.get_style("gone").unwrap().is_none());
        // Offered again later, the kept row is updated in place.
        let mut back = builtin("used", true);
        back.name = "Used v2".into();
        db.replace_builtin_styles(&[back]).unwrap();
        assert_eq!(db.get_style("used").unwrap().unwrap().name, "Used v2");
    }

    #[test]
    fn an_unknown_style_is_refused_and_a_known_one_saves() {
        let db = adb();
        let mut i = input("A");
        i.style_id = "gone".into();
        assert!(db.save_autopilot(&i).unwrap_err().0.contains("gone"));
        i.style_id = "s2".into();
        assert!(db.save_autopilot(&i).is_ok());
    }

    /// Slots at `days` days from now with the given status, for autopilot `id`.
    fn slots_at(db: &Db, id: &str, days: &[(i64, &str)]) {
        for (d, status) in days {
            let at = (chrono::Utc::now() + chrono::Duration::days(*d)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let s = db.upsert_slot(id, &at).unwrap();
            db.update_slot(&s.id, json!({"status": status})).unwrap();
        }
    }

    fn statuses(db: &Db, id: &str) -> Vec<(String, SlotStatus)> {
        let from = (chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        let to = (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339();
        db.list_slots(&from, &to).unwrap().into_iter().filter(|s| s.autopilot_id == id).map(|s| (s.due_at, s.status)).collect()
    }

    #[test]
    fn editing_drops_future_planned_slots_only() {
        let db = adb();
        let a = db.save_autopilot(&input("A")).unwrap();
        let b = db.save_autopilot(&input("B")).unwrap();
        slots_at(&db, &a.id, &[(-2, "planned"), (1, "planned"), (2, "making"), (3, "failed"), (4, "planned")]);
        slots_at(&db, &b.id, &[(1, "planned")]);
        let mut edit = input("A");
        edit.id = Some(a.id.clone());
        edit.frequency = AutopilotFrequency::Daily { times: vec!["09:00".into()] };
        db.save_autopilot(&edit).unwrap();
        let left: Vec<_> = statuses(&db, &a.id).into_iter().map(|x| x.1).collect();
        assert_eq!(left, vec![SlotStatus::Planned, SlotStatus::Making, SlotStatus::Failed]);
        assert_eq!(statuses(&db, &b.id).len(), 1);
    }

    #[test]
    fn creating_keeps_slots_and_a_failed_edit_keeps_them_too() {
        let db = adb();
        let a = db.save_autopilot(&input("A")).unwrap();
        slots_at(&db, &a.id, &[(1, "planned")]);
        let mut bad = input("A");
        bad.id = Some(a.id.clone());
        bad.length_sec = 5;
        assert!(db.save_autopilot(&bad).is_err());
        assert_eq!(statuses(&db, &a.id).len(), 1);
    }

    #[test]
    fn pausing_drops_future_planned_slots_and_resuming_leaves_them_empty() {
        let db = adb();
        let a = db.save_autopilot(&input("A")).unwrap();
        slots_at(&db, &a.id, &[(-1, "planned"), (1, "planned"), (2, "making"), (3, "planned")]);
        db.set_autopilot_status(&a.id, AutopilotStatus::Paused).unwrap();
        let left: Vec<_> = statuses(&db, &a.id).into_iter().map(|x| x.1).collect();
        assert_eq!(left, vec![SlotStatus::Planned, SlotStatus::Making]);
        db.set_autopilot_status(&a.id, AutopilotStatus::Active).unwrap();
        assert_eq!(statuses(&db, &a.id).len(), 2);
        // Setting an unknown autopilot fails without touching anything.
        assert!(db.set_autopilot_status("nope", AutopilotStatus::Paused).is_err());
    }
}
