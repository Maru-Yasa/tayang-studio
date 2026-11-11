//! Tauri commands: the thin layer between the UI and the Rust modules.

use crate::db::Db;
use crate::media::MediaTools;
use crate::system::{self, RealExec};
use crate::types::*;
use crate::media;
use crate::acp::{AcpManager, AcpSink, PromptPart};
use crate::projects;
use crate::auth::{AccountCache, Auth, AuthSink, FileStore, KeyringStore, SecureStore};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub type CmdResult<T> = Result<T, String>;

/// Shared Tauri state.
pub struct AppState {
    pub db: Db,
    pub acp: AcpManager,
    pub media: MediaTools,
    pub home: PathBuf,
    /// The working folder each study started in, so changing the working folder mid-study can't strand its files.
    pub study_working: std::sync::Mutex<std::collections::HashMap<String, PathBuf>>,
}

impl AppState {
    /// The working folder `study_dir` created this study in, else the current one.
    pub fn working_for_study(&self, study_id: &str) -> PathBuf {
        let known = self.study_working.lock().unwrap_or_else(|e| e.into_inner()).get(study_id).cloned();
        known.unwrap_or_else(|| self.working())
    }

    pub fn working(&self) -> PathBuf {
        PathBuf::from(self.db.get_settings(&self.home).working_folder)
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---- system and settings ----

#[tauri::command]
pub async fn get_system_info() -> CmdResult<SystemInfo> {
    tauri::async_runtime::spawn_blocking(|| system::system_info(&RealExec))
        .await
        .map_err(err)
}

/// The operating system's preferred language, like `id-ID` or `en-US`. The webview's own
/// `navigator.language` follows the app bundle (English only), not the system, so the first-run
/// interface language is picked from this instead.
#[tauri::command]
pub fn system_locale() -> Option<String> {
    clean_locale(sys_locale::get_locale())
}

fn clean_locale(raw: Option<String>) -> Option<String> {
    raw.map(|l| l.trim().to_string()).filter(|l| !l.is_empty() && !is_posix_default(l))
}

/// `C`, `POSIX` and values like `C.UTF-8` mean "no language chosen", not a language.
fn is_posix_default(l: &str) -> bool {
    ["C", "POSIX"].iter().any(|p| {
        l.strip_prefix(p).is_some_and(|rest| rest.is_empty() || rest.starts_with(['.', '@', '_', '-']))
    })
}

#[tauri::command]
pub async fn detect_agents(app: AppHandle) -> CmdResult<Vec<AgentInfo>> {
    let mut agents = tauri::async_runtime::spawn_blocking(|| system::detect_agents(&RealExec))
        .await
        .map_err(err)?;
    agents.push(api_agent_info(&app).await);
    Ok(agents)
}

#[tauri::command]
pub async fn check_tools(app: AppHandle, agent: AgentId) -> CmdResult<Vec<ToolStatus>> {
    let claude = claude_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || system::check_tools(&RealExec, agent, &claude))
        .await
        .map_err(err)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.db.get_settings(&state.home)
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> CmdResult<Settings> {
    let old_api = crate::styles_sync::effective_api_url(&state.db.get_settings(&state.home));
    let settings = state.db.update_settings(patch).map_err(err)?;
    let new_api = crate::styles_sync::effective_api_url(&settings);
    if new_api != old_api {
        // A token belongs to the API it came from: show the new API's own state.
        if let Some(auth) = app.try_state::<Arc<Auth>>() {
            let auth = auth.inner().clone();
            tauri::async_runtime::spawn(async move { auth.refresh(&new_api).await });
        }
    }
    allow_asset_folders(&app, &state.db, &settings.working_folder);
    if crate::scheduler::sync_tray(&app, &settings).is_err() {
        // No tray here: background mode is turned back off and the user is told why.
        crate::scheduler::background_off(&state.db)?;
        return Err(crate::scheduler::TRAY_UNAVAILABLE.into());
    }
    Ok(settings)
}

/// Folders the webview may load files (frames, thumbnails, renders) from: the working
/// folder plus every known project's own folder, which stays put when the working
/// folder changes. Nothing else is in the asset scope.
pub fn asset_folders(db: &Db, working: &str) -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from(working)];
    for p in db.list_projects().unwrap_or_default() {
        let folder = PathBuf::from(&p.folder);
        if folder.is_dir() && !out.contains(&folder) {
            out.push(folder);
        }
    }
    out
}

pub fn allow_asset_folders(app: &AppHandle, db: &Db, working: &str) {
    for folder in asset_folders(db, working) {
        let _ = app.asset_protocol_scope().allow_directory(&folder, true);
    }
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(err)
}

// ---- projects ----

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<Project>> {
    state.db.list_projects().map_err(err)
}

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    input: NewProject,
    brief: String,
) -> CmdResult<Project> {
    new_project(&state.db, Path::new(&state.working()), input, &brief)
}

/// A new draft project: its own folder in `working` with the brief, and its row.
pub fn new_project(db: &Db, working: &Path, input: NewProject, brief: &str) -> CmdResult<Project> {
    new_project_with(db, working, input, |dir| projects::write_project_brief(dir, brief))
}

/// `new_project` with the brief write passed in, so a test can make it fail. Whatever fails after the
/// folder exists removes it again: `create_project_folder` made it new.
fn new_project_with(
    db: &Db,
    working: &Path,
    input: NewProject,
    write_brief: impl FnOnce(&Path) -> std::io::Result<()>,
) -> CmdResult<Project> {
    let slugs: Vec<String> = db
        .list_projects()
        .map_err(err)?
        .into_iter()
        .map(|p| p.slug)
        .collect();
    let (slug, dir) = projects::create_project_folder(working, &input.title, &slugs)
        .map_err(|e| format!("Can't create the project folder: {e}"))?;
    if let Err(e) = write_brief(&dir) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("Can't write the project brief: {e}"));
    }
    let now = crate::db::now();
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        title: input.title,
        slug,
        folder: dir.to_string_lossy().into_owned(),
        kind: input.kind,
        format: input.format,
        language: input.language,
        status: ProjectStatus::Draft,
        style_id: input.style_id,
        scheduled_at: None,
        review_state: ReviewState::None,
        posted_at: None,
        reminded_at: None,
        review_reminded_at: None,
        social_post_id: None,
        duration_sec: None,
        created_at: now.clone(),
        updated_at: now,
    };
    if let Err(e) = db.insert_project(&project) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(err(e));
    }
    Ok(project)
}

#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    id: String,
    patch: serde_json::Value,
) -> CmdResult<Project> {
    state.db.update_project(&id, patch).map_err(err)
}

/// Moves a project to `status` (draft → building → rendered); never back unless `reset`. See `Db::set_project_status`.
#[tauri::command]
pub fn set_project_status(
    state: State<'_, AppState>,
    project_id: String,
    status: crate::types::ProjectStatus,
    reset: Option<bool>,
) -> CmdResult<Project> {
    state.db.set_project_status(&project_id, status, reset.unwrap_or(false)).map_err(err)
}

/// Sets or clears when a video is due to be posted. `at` must be RFC 3339; a new time is
/// reminded afresh, so `remindedAt` is cleared with it.
pub fn schedule_project(db: &Db, project_id: &str, at: Option<String>) -> CmdResult<Project> {
    // Stored as UTC so every schedule compares as plain text.
    let at = at
        .map(|at| {
            chrono::DateTime::parse_from_rfc3339(&at)
                .map(|dt| dt.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                .map_err(|_| format!("That date and time isn't valid: {at}"))
        })
        .transpose()?;
    db.update_project(project_id, serde_json::json!({ "scheduledAt": at, "remindedAt": null, "reviewRemindedAt": null }))
        .map_err(err)
}

pub fn mark_posted(db: &Db, project_id: &str, posted: bool) -> CmdResult<Project> {
    let at = posted.then(crate::db::now);
    db.update_project(project_id, serde_json::json!({ "postedAt": at })).map_err(err)
}

pub fn approve(db: &Db, project_id: &str) -> CmdResult<Project> {
    db.update_project(project_id, serde_json::json!({ "reviewState": "approved" })).map_err(err)
}

/// One video of a confirmed schedule card: an existing project, or a new draft (its input and brief).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub project_id: Option<String>,
    pub at: String,
    pub draft: Option<BatchDraft>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BatchDraft {
    pub input: NewProject,
    pub brief: String,
}

const BATCH_MAX: usize = 20;

/// Checks every item first, exactly as `set_schedule` will, then writes: drafts first, then the
/// schedules. Any failure undoes the batch: its drafts are removed (row and folder) and videos already
/// moved get their old schedule and reminders back. Errors are codes the UI says in the user's
/// language: `schedule:count`, `schedule:<badTime|past|tooFar|unknown|twice|badItem>:<n>` (1-based) and
/// `schedule:write`.
pub fn schedule_batch(
    db: &Db,
    working: &Path,
    items: Vec<BatchItem>,
    now: chrono::DateTime<chrono::Utc>,
) -> CmdResult<Vec<Project>> {
    schedule_batch_with(db, working, items, now, |db, id, at| schedule_project(db, id, Some(at)))
}

/// `schedule_batch` with the per-video write passed in, so a test can make it fail part-way.
fn schedule_batch_with(
    db: &Db,
    working: &Path,
    items: Vec<BatchItem>,
    now: chrono::DateTime<chrono::Utc>,
    schedule: impl Fn(&Db, &str, String) -> CmdResult<Project>,
) -> CmdResult<Vec<Project>> {
    if items.is_empty() || items.len() > BATCH_MAX {
        return Err("schedule:count".into());
    }
    let mut checked = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let n = i + 1;
        let at = chrono::DateTime::parse_from_rfc3339(&item.at)
            .map_err(|_| format!("schedule:badTime:{n}"))?
            .with_timezone(&chrono::Utc);
        if at <= now {
            return Err(format!("schedule:past:{n}"));
        }
        if at - now > chrono::Duration::days(365) {
            return Err(format!("schedule:tooFar:{n}"));
        }
        match (&item.project_id, &item.draft) {
            (Some(id), None) => {
                if db.get_project(id).map_err(err)?.is_none() {
                    return Err(format!("schedule:unknown:{n}"));
                }
                // A video once per batch: two times for one video can't both be undone right.
                if items[..i].iter().any(|x| x.project_id.as_deref() == Some(id.as_str())) {
                    return Err(format!("schedule:twice:{n}"));
                }
            }
            (None, Some(d)) if !d.input.title.trim().is_empty() => {}
            _ => return Err(format!("schedule:badItem:{n}")),
        }
        checked.push(at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }

    let mut created: Vec<Project> = Vec::new();
    let mut moved: Vec<Project> = Vec::new();
    let undo = |created: &[Project], moved: &[Project]| {
        for p in created {
            let _ = db.delete_project(&p.id);
            let dir = Path::new(&p.folder);
            // Only a folder this batch made, inside the working folder.
            if dir.starts_with(working) && dir != working {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        // Newest first, so each video ends with the schedule it had before the batch.
        for old in moved.iter().rev() {
            let _ = db.update_project(
                &old.id,
                serde_json::json!({
                    "scheduledAt": old.scheduled_at,
                    "remindedAt": old.reminded_at,
                    "reviewRemindedAt": old.review_reminded_at,
                    "updatedAt": old.updated_at,
                }),
            );
        }
    };
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        match (item.project_id, item.draft) {
            (Some(id), _) => ids.push(id),
            (None, Some(d)) => match new_project(db, working, d.input, &d.brief) {
                Ok(p) => {
                    ids.push(p.id.clone());
                    created.push(p);
                }
                Err(_) => {
                    undo(&created, &moved);
                    return Err("schedule:write".into());
                }
            },
            (None, None) => unreachable!("checked above"),
        }
    }
    let mut out = Vec::with_capacity(ids.len());
    for (id, at) in ids.iter().zip(checked) {
        let before = db.get_project(id).ok().flatten();
        match schedule(db, id, at) {
            Ok(p) => {
                if let Some(b) = before.filter(|b| !created.iter().any(|c| c.id == b.id)) {
                    moved.push(b);
                }
                out.push(p);
            }
            Err(_) => {
                undo(&created, &moved);
                return Err("schedule:write".into());
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn schedule_videos(state: State<'_, AppState>, items: Vec<BatchItem>) -> CmdResult<Vec<Project>> {
    schedule_batch(&state.db, &state.working(), items, chrono::Utc::now())
}

#[tauri::command]
pub fn set_schedule(state: State<'_, AppState>, project_id: String, at: Option<String>) -> CmdResult<Project> {
    schedule_project(&state.db, &project_id, at)
}

#[tauri::command]
pub fn set_posted(state: State<'_, AppState>, project_id: String, posted: bool) -> CmdResult<Project> {
    mark_posted(&state.db, &project_id, posted)
}

#[tauri::command]
pub fn approve_project(state: State<'_, AppState>, project_id: String) -> CmdResult<Project> {
    approve(&state.db, &project_id)
}

// ---- autopilots ----

#[tauri::command]
pub fn list_autopilots(state: State<'_, AppState>) -> CmdResult<Vec<Autopilot>> {
    state.db.list_autopilots().map_err(err)
}

#[tauri::command]
pub fn save_autopilot(state: State<'_, AppState>, input: AutopilotInput) -> CmdResult<Autopilot> {
    state.db.save_autopilot(&input).map_err(err)
}

#[tauri::command]
pub fn delete_autopilot(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.db.delete_autopilot(&id).map_err(err)
}

#[tauri::command]
pub fn set_autopilot_status(state: State<'_, AppState>, id: String, status: AutopilotStatus) -> CmdResult<Autopilot> {
    state.db.set_autopilot_status(&id, status).map_err(err)
}

#[tauri::command]
pub fn list_slots(state: State<'_, AppState>, from: String, to: String) -> CmdResult<Vec<AutopilotSlot>> {
    state.db.list_slots(&from, &to).map_err(err)
}

#[tauri::command]
pub fn upsert_slot(state: State<'_, AppState>, autopilot_id: String, due_at: String) -> CmdResult<AutopilotSlot> {
    state.db.upsert_slot(&autopilot_id, &due_at).map_err(err)
}

#[tauri::command]
pub fn update_slot(state: State<'_, AppState>, id: String, patch: serde_json::Value) -> CmdResult<AutopilotSlot> {
    state.db.update_slot(&id, patch).map_err(err)
}

// ---- chats ----

#[tauri::command]
pub fn list_chats(state: State<'_, AppState>, project_id: Option<String>) -> CmdResult<Vec<Chat>> {
    state.db.list_chats(project_id.as_deref()).map_err(err)
}

/// The sidebar's Recent list: chats with and without a project, newest activity first.
/// Async so the query never runs on the main thread.
#[tauri::command]
pub async fn list_recent_chats(state: State<'_, AppState>, limit: Option<u32>) -> CmdResult<Vec<RecentChat>> {
    state.db.list_recent_chats(limit).map_err(err)
}

/// Archived threads for Settings › Archive.
#[tauri::command]
pub async fn list_archived_chats(state: State<'_, AppState>) -> CmdResult<Vec<RecentChat>> {
    state.db.list_archived_chats().map_err(err)
}

/// Archives (or restores) the thread a chat belongs to.
#[tauri::command]
pub fn set_thread_archived(state: State<'_, AppState>, chat_id: String, archived: bool) -> CmdResult<()> {
    state.db.set_thread_archived(&chat_id, archived).map_err(err)
}

/// What emptying the archive removed.
#[derive(serde::Serialize)]
pub struct PurgedArchive {
    chats: usize,
    cards: usize,
}

/// Deletes archived chats and cards for good. Projects and their videos stay.
#[tauri::command]
pub fn purge_archive(state: State<'_, AppState>) -> CmdResult<PurgedArchive> {
    let (chats, cards) = state.db.purge_archive().map_err(err)?;
    Ok(PurgedArchive { chats, cards })
}

/// One chat by id, whether or not it belongs to a project.
pub fn lookup_chat(db: &Db, chat_id: &str) -> CmdResult<Option<Chat>> {
    db.get_chat(chat_id).map_err(err)
}

#[tauri::command]
pub fn get_chat(state: State<'_, AppState>, chat_id: String) -> CmdResult<Option<Chat>> {
    lookup_chat(&state.db, &chat_id)
}

#[tauri::command]
pub fn create_chat(
    state: State<'_, AppState>,
    project_id: Option<String>,
    agent_id: AgentId,
    title: String,
) -> CmdResult<Chat> {
    state
        .db
        .create_chat(project_id.as_deref(), agent_id, &title)
        .map_err(err)
}

/// Switches the chat to another agent. The agent id is validated by its enum on the way in.
#[tauri::command]
pub fn update_chat_agent(state: State<'_, AppState>, chat_id: String, agent_id: AgentId) -> CmdResult<Chat> {
    state
        .db
        .set_chat_agent(&chat_id, agent_id)
        .map_err(err)?
        .ok_or_else(|| format!("No chat {chat_id}"))
}

#[tauri::command]
pub fn list_messages(state: State<'_, AppState>, chat_id: String) -> CmdResult<Vec<ChatMessage>> {
    state.db.list_messages(&chat_id).map_err(err)
}

#[tauri::command]
pub fn add_message(
    state: State<'_, AppState>,
    chat_id: String,
    role: MessageRole,
    parts: Vec<MessagePart>,
) -> CmdResult<ChatMessage> {
    state.db.add_message(&chat_id, role, &parts).map_err(err)
}

// ---- styles ----

#[tauri::command]
pub fn list_styles(state: State<'_, AppState>) -> CmdResult<Vec<Style>> {
    state.db.list_styles().map_err(err)
}

#[tauri::command]
pub fn save_style(state: State<'_, AppState>, style: Style) -> CmdResult<()> {
    state.db.save_style(&style).map_err(err)
}

#[tauri::command]
pub fn delete_style(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.db.delete_style(&id).map_err(err)?;
    if let Ok(data) = app.path().app_data_dir() {
        media::remove_style_media(&data, &id);
    }
    Ok(())
}

/// Where copied styles keep their preview clip, poster and reference frames, and where the video cards'
/// thumbnails are cached; the webview may read them.
pub fn allow_style_media(app: &AppHandle) {
    if let Ok(data) = app.path().app_data_dir() {
        for dir in [data.join("style-media"), data.join("style-refs"), data.join("thumbs")] {
            let _ = std::fs::create_dir_all(&dir);
            let _ = app.asset_protocol_scope().allow_directory(&dir, true);
        }
    }
}

/// Makes the preview clip and poster of a finished study (from its downloaded source), then deletes the
/// source. `None` when there was no source or nothing could be made.
#[tauri::command]
pub async fn make_style_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    study_id: String,
    style_id: String,
) -> CmdResult<Option<media::StylePreview>> {
    let study = study_path(&state.working_for_study(&study_id), &study_id)?;
    let data = app.path().app_data_dir().map_err(err)?;
    let out = media::style_media_dir(&data, &style_id).ok_or("That style id isn't valid")?;
    let tools = state.media.clone();
    tauri::async_runtime::spawn_blocking(move || media::make_style_preview(&tools, &study, &out))
        .await
        .map_err(err)?
}

/// Contact sheets of a finished study's source (48 frames across the whole video, 4x3 per sheet) as the
/// style's references (`<app data>/style-refs/<style>`). Run before the preview, which deletes the source.
#[tauri::command]
pub async fn make_style_sheets(app: AppHandle, state: State<'_, AppState>, study_id: String, style_id: String) -> CmdResult<Vec<String>> {
    let study = study_path(&state.working_for_study(&study_id), &study_id)?;
    let data = app.path().app_data_dir().map_err(err)?;
    let out = media::style_refs_dir(&data, &style_id).ok_or("That style id isn't valid")?;
    let tools = state.media.clone();
    let made = tauri::async_runtime::spawn_blocking(move || media::make_style_sheets(&tools, &study, &out))
        .await
        .map_err(err)??;
    Ok(made.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// Keeps a finished study's reference frames as the style's own (`<app data>/style-refs/<style>`).
/// Returns their paths; none when the study left no refs.
#[tauri::command]
pub fn keep_style_refs(app: AppHandle, state: State<'_, AppState>, study_id: String, style_id: String) -> CmdResult<Vec<String>> {
    let study = study_path(&state.working_for_study(&study_id), &study_id)?;
    let data = app.path().app_data_dir().map_err(err)?;
    let out = media::style_refs_dir(&data, &style_id).ok_or("That style id isn't valid")?;
    Ok(media::keep_style_refs(&study, &out)?.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// Copies a style's reference frames into the project's `style-refs/` folder, where the brief points the
/// agent. Returns how many were copied.
#[tauri::command]
pub fn copy_style_refs(app: AppHandle, state: State<'_, AppState>, style_id: String, project_id: String) -> CmdResult<u32> {
    let data = app.path().app_data_dir().map_err(err)?;
    let refs = media::style_refs_dir(&data, &style_id).ok_or("That style id isn't valid")?;
    let folder = project_folder(&state, &project_id)?;
    Ok(media::copy_style_refs(&refs, &folder)? as u32)
}

/// `<working>/.tayang/style-study/<id>`, rejected if it would leave the working folder.
pub(crate) fn study_path(working: &Path, study_id: &str) -> CmdResult<PathBuf> {
    let bad = study_id.is_empty()
        || study_id == "."
        || study_id == ".."
        || study_id.contains(['/', '\\']);
    let dir = working.join(".tayang").join("style-study").join(study_id);
    let _ = std::fs::create_dir_all(working);
    if bad || !projects::ensure_inside(working, &dir) {
        return Err("That style study id isn't valid".into());
    }
    Ok(dir)
}

#[tauri::command]
pub fn read_style_result(state: State<'_, AppState>, study_id: String) -> CmdResult<Option<String>> {
    let path = study_path(&state.working_for_study(&study_id), &study_id)?.join("style.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Can't read the style result: {e}")),
    }
}

/// Deletes a study's folder (its download, frames and result) once the study is over, however it ended.
#[tauri::command]
pub fn remove_study_dir(state: State<'_, AppState>, study_id: String) -> CmdResult<()> {
    let working = state.working_for_study(&study_id);
    let out = media::remove_study_dir(&working, &study_id);
    state.study_working.lock().unwrap_or_else(|e| e.into_inner()).remove(&study_id);
    out
}

#[tauri::command]
pub fn study_dir(state: State<'_, AppState>, study_id: String) -> CmdResult<String> {
    let working = state.working();
    let dir = study_path(&working, &study_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Can't create the study folder: {e}"))?;
    state.study_working.lock().unwrap_or_else(|e| e.into_inner()).insert(study_id, working);
    Ok(dir.to_string_lossy().into_owned())
}

// ---- jobs ----

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>) -> CmdResult<Vec<Job>> {
    state.db.list_jobs().map_err(err)
}

#[tauri::command]
pub fn delete_job(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.db.delete_job(&id).map_err(err)
}

/// Archives (or restores) board cards.
#[tauri::command]
pub fn set_jobs_archived(state: State<'_, AppState>, ids: Vec<String>, archived: bool) -> CmdResult<()> {
    state.db.set_jobs_archived(&ids, archived).map_err(err)
}

#[tauri::command]
pub fn upsert_job(state: State<'_, AppState>, job: Job) -> CmdResult<()> {
    state.db.upsert_job(&job).map_err(err)
}

// ---- sign in ----

struct TauriAuthSink(AppHandle);

impl AuthSink for TauriAuthSink {
    fn changed(&self, status: &AuthStatus) {
        let _ = self.0.emit(crate::auth::EVENT, status);
    }
}

/// The account cache in the app database (managed after this is made, so looked up per call).
struct AppAccountCache(AppHandle);

impl AccountCache for AppAccountCache {
    fn load(&self, key: &str) -> Option<Account> {
        self.0.try_state::<AppState>().and_then(|s| s.db.load(key))
    }
    fn save(&self, key: &str, account: Option<&Account>) {
        if let Some(s) = self.0.try_state::<AppState>() {
            s.db.save(key, account);
        }
    }
}

/// The app's sign-in state: tokens in the OS keychain, `<app_data>/auth.json` only when it fails.
///
/// Dev builds keep the token in `<app_data>/auth-dev.json` (0600) and never touch the keychain: macOS
/// ties "Always Allow" to the binary's code signature, and every rebuild of an ad-hoc signed dev binary
/// is a new signature, so the keychain would ask for the login password after every restart.
pub fn auth_manager(app: &AppHandle, data_dir: &Path) -> Result<Arc<Auth>, String> {
    let store: Arc<dyn crate::auth::TokenStore> = if cfg!(debug_assertions) {
        Arc::new(FileStore::new(data_dir.join("auth-dev.json")))
    } else {
        Arc::new(SecureStore::new(KeyringStore, FileStore::new(data_dir.join("auth.json"))))
    };
    Auth::new(
        store,
        Arc::new(AppAccountCache(app.clone())),
        Arc::new(TauriAuthSink(app.clone())),
        std::time::Duration::from_secs(1),
    )
}

/// `TAYANG_API_URL` when it is set: it wins over the API address in Settings (a dev setup).
#[tauri::command]
pub fn api_url_override() -> Option<String> {
    std::env::var("TAYANG_API_URL").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn api_base(state: &AppState) -> String {
    crate::styles_sync::effective_api_url(&state.db.get_settings(&state.home))
}

/// `auth:<code>`, the code being the kebab-case `AuthError` the UI knows.
fn auth_err(e: AuthError) -> String {
    let code = serde_json::to_value(e).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    format!("auth:{code}")
}

/// Starts signing in: gets a code from the API, opens the browser and polls in the background.
/// Errors are `auth:<code>`; `auth:cancelled` when a cancel came first.
#[tauri::command]
pub async fn auth_start(app: AppHandle, state: State<'_, AppState>, auth: State<'_, Arc<Auth>>) -> CmdResult<AuthStart> {
    let base = api_base(&state);
    match auth.start(&base).await {
        Ok(Some(started)) => {
            use tauri_plugin_opener::OpenerExt;
            // The dialog has "Open browser again" for when this doesn't work.
            if let Err(e) = app.opener().open_url(&started.verification_uri_complete, None::<&str>) {
                eprintln!("[auth] couldn't open the browser: {e}");
            }
            Ok(started)
        }
        Ok(None) => Err("auth:cancelled".into()),
        Err(e) => Err(auth_err(e)),
    }
}

#[tauri::command]
pub fn auth_cancel(auth: State<'_, Arc<Auth>>) {
    auth.cancel();
}

#[tauri::command]
pub fn auth_status(auth: State<'_, Arc<Auth>>) -> AuthStatus {
    auth.status()
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>, auth: State<'_, Arc<Auth>>) -> CmdResult<()> {
    let base = api_base(&state);
    auth.logout(&base).await.map_err(auth_err)
}

// ---- paid plans ----

/// `billing:<code>`, the code being the kebab-case `BillingError` the UI knows.
fn billing_err(e: BillingError) -> String {
    let code = serde_json::to_value(e).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    format!("billing:{code}")
}

/// The stored token for the current API, or `billing:signed-out`.
async fn billing_token(state: &AppState, auth: &Arc<Auth>) -> Result<(String, String), String> {
    let base = api_base(state);
    let token = auth.token(&base).await.ok_or_else(|| {
        // The keychain error (if that was it) is logged by Auth; this says which call it broke.
        eprintln!("[billing] no sign-in token for {base}");
        billing_err(BillingError::SignedOut)
    })?;
    Ok((base, token))
}

/// A 401 means the token is gone at the API: let the sign-in state find out (it clears it).
fn after_billing<T>(auth: &Arc<Auth>, base: &str, r: Result<T, BillingError>) -> CmdResult<T> {
    if let Err(e) = &r {
        eprintln!("[billing] {}", billing_err(*e));
    }
    if r.as_ref().err() == Some(&BillingError::SignedOut) {
        let (auth, base) = (auth.clone(), base.to_string());
        tauri::async_runtime::spawn(async move { auth.refresh(&base).await });
    }
    r.map_err(billing_err)
}

/// Starts (or reuses) a payment for `plan` and opens its pay link (`<api>/pay/…`, which the API
/// redirects to the provider, or to a WhatsApp chat while payments are off). The token stays here; the
/// webview gets the link for "Open again". Errors are `billing:<code>`.
#[tauri::command]
pub async fn billing_checkout(app: AppHandle, state: State<'_, AppState>, auth: State<'_, Arc<Auth>>, plan: String) -> CmdResult<CheckoutStart> {
    let auth = auth.inner().clone();
    let (base, token) = billing_token(&state, &auth).await?;
    let start = after_billing(&auth, &base, crate::billing::checkout(auth.client(), &base, &token, &plan).await)?;
    let url = match &start {
        CheckoutStart::Qris(c) => c.pay_url.clone(),
        CheckoutStart::Whatsapp { url } => url.clone(),
    };
    use tauri_plugin_opener::OpenerExt;
    // The dialog has "Open again" for when this doesn't work.
    if let Err(e) = app.opener().open_url(&url, None::<&str>) {
        eprintln!("[billing] couldn't open the browser: {e}");
    }
    Ok(start)
}

/// "Open again": opens a pay link the API handed out, if it is one on this API (`<api>/pay/…`);
/// else `billing:bad_link`. The webview never opens payment pages itself.
#[tauri::command]
pub async fn billing_open(app: AppHandle, state: State<'_, AppState>, url: String) -> CmdResult<()> {
    if !crate::billing::is_pay_link(&url, &api_base(&state)) {
        return Err(billing_err(BillingError::BadLink));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url.trim(), None::<&str>).map_err(|e| {
        eprintln!("[billing] couldn't open the browser: {e}");
        billing_err(BillingError::BadLink)
    })
}

/// The signed-in account's plan and any payment in progress. Errors are `billing:<code>`.
#[tauri::command]
pub async fn billing_status(state: State<'_, AppState>, auth: State<'_, Arc<Auth>>) -> CmdResult<BillingStatus> {
    let auth = auth.inner().clone();
    let (base, token) = billing_token(&state, &auth).await?;
    after_billing(&auth, &base, crate::billing::status(auth.client(), &base, &token).await)
}

// ---- the Tayang account's credits, social accounts and auto-post ----

/// `cloud:<code>`, the code being the kebab-case `CloudError` the UI knows.
fn cloud_err(e: crate::cloud::CloudError) -> String {
    format!("cloud:{}", e.code())
}

/// The API base and the stored sign-in token, or `cloud:signed-out`.
async fn cloud_token(state: &AppState, auth: &Arc<Auth>) -> Result<(String, String), String> {
    let base = api_base(state);
    let token = auth.token(&base).await.ok_or_else(|| cloud_err(crate::cloud::CloudError::SignedOut))?;
    Ok((base, token))
}

/// A 401 means the token is gone at the API: let the sign-in state find out (it clears it).
fn after_cloud<T>(auth: &Arc<Auth>, base: &str, what: &str, r: Result<T, crate::cloud::CloudError>) -> CmdResult<T> {
    if let Err(e) = &r {
        eprintln!("[cloud] {what}: {}", e.code());
        if *e == crate::cloud::CloudError::SignedOut {
            let (auth, base) = (auth.clone(), base.to_string());
            tauri::async_runtime::spawn(async move { auth.refresh(&base).await });
        }
    }
    r.map_err(cloud_err)
}

/// Credits and auto-posts left in this cycle (`GET /v1/usage`).
#[tauri::command]
pub async fn cloud_usage(state: State<'_, AppState>, auth: State<'_, Arc<Auth>>) -> CmdResult<serde_json::Value> {
    let auth = auth.inner().clone();
    let (base, token) = cloud_token(&state, &auth).await?;
    after_cloud(&auth, &base, "usage", crate::cloud::get(auth.client(), &base, &token, "/v1/usage").await)
}

/// Redeems a gift code for this account. The API also gets this computer's hashed id (see
/// `device`), since a promo gives one gift per computer. Answers `{ gift }`.
#[tauri::command]
pub async fn redeem_gift_code(state: State<'_, AppState>, auth: State<'_, Arc<Auth>>, code: String) -> CmdResult<serde_json::Value> {
    let auth = auth.inner().clone();
    let (base, token) = cloud_token(&state, &auth).await?;
    let install_id = state.db.ensure_install_id(&state.home).unwrap_or_default();
    // ioreg / reg run as processes: off the async runtime.
    let device_id = tokio::task::spawn_blocking(move || crate::device::device_id(&install_id)).await.map_err(err)?;
    let body = serde_json::json!({ "code": code.trim(), "deviceId": device_id });
    after_cloud(&auth, &base, "redeem", crate::cloud::send(auth.client(), reqwest::Method::POST, &base, &token, "/v1/promos/redeem", Some(&body)).await)
}

/// The social accounts connected to this Tayang account.
#[tauri::command]
pub async fn social_accounts(state: State<'_, AppState>, auth: State<'_, Arc<Auth>>) -> CmdResult<serde_json::Value> {
    let auth = auth.inner().clone();
    let (base, token) = cloud_token(&state, &auth).await?;
    after_cloud(&auth, &base, "accounts", crate::cloud::get(auth.client(), &base, &token, "/v1/social/accounts").await)
}

/// Opens the platform's sign-in page in the browser to connect an account; it shows up in
/// `social_accounts` once the user has finished there.
#[tauri::command]
pub async fn social_connect(app: AppHandle, state: State<'_, AppState>, auth: State<'_, Arc<Auth>>, platform: String) -> CmdResult<()> {
    let auth = auth.inner().clone();
    let (base, token) = cloud_token(&state, &auth).await?;
    let body = serde_json::json!({ "platform": platform });
    let out = after_cloud(&auth, &base, "connect", crate::cloud::send(auth.client(), reqwest::Method::POST, &base, &token, "/v1/social/accounts/connect", Some(&body)).await)?;
    let url = out.get("url").and_then(serde_json::Value::as_str).filter(|u| crate::cloud::is_https(u)).ok_or_else(|| cloud_err(crate::cloud::CloudError::BadUrl))?;
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
pub async fn social_disconnect(state: State<'_, AppState>, auth: State<'_, Arc<Auth>>, id: String) -> CmdResult<()> {
    let auth = auth.inner().clone();
    let (base, token) = cloud_token(&state, &auth).await?;
    let path = format!("/v1/social/accounts/{}", urlencode(&id));
    after_cloud(&auth, &base, "disconnect", crate::cloud::send(auth.client(), reqwest::Method::DELETE, &base, &token, &path, None).await).map(|_| ())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// The video's title for the platforms that show one (YouTube, TikTok), as PostForMe's per-platform
/// settings; the caption stays the description. None without a title. YouTube allows 100 characters.
pub fn title_configurations(title: Option<&str>) -> Option<serde_json::Value> {
    let t: String = title.map(str::trim).filter(|t| !t.is_empty())?.chars().take(100).collect();
    Some(serde_json::json!({
        "youtube": { "title": t },
        "tiktok": { "title": t },
        "tiktok_business": { "title": t },
    }))
}

/// Posts the project's latest render to `account_ids`, now or at `scheduled_at`: the video goes to
/// PostForMe's storage first, then the post is made and charged one auto-post per account. A retry
/// passes the same `client_request_id`, so it never posts twice. The project keeps the post id.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a Tauri command takes its fields as arguments
pub async fn social_post(
    state: State<'_, AppState>,
    auth: State<'_, Arc<Auth>>,
    project_id: String,
    title: Option<String>,
    caption: String,
    account_ids: Vec<String>,
    scheduled_at: Option<String>,
    client_request_id: String,
) -> CmdResult<serde_json::Value> {
    use crate::cloud::CloudError;
    let auth = auth.inner().clone();
    let (base, token) = cloud_token(&state, &auth).await?;
    let folder = project_folder(&state, &project_id)?;
    let video = media::latest_render(&folder).ok_or("This video has no render yet: render it first")?;
    let client = auth.client();
    let up = after_cloud(&auth, &base, "upload url", crate::cloud::send(client, reqwest::Method::POST, &base, &token, "/v1/social/media/upload-url", Some(&serde_json::json!({}))).await)?;
    let (Some(upload_url), Some(media_url)) = (up.get("uploadUrl").and_then(serde_json::Value::as_str), up.get("mediaUrl").and_then(serde_json::Value::as_str)) else {
        return Err(cloud_err(CloudError::Server));
    };
    after_cloud(&auth, &base, "upload", crate::cloud::upload(client, upload_url, &video, "video/mp4").await)?;
    let mut body = serde_json::json!({
        "caption": caption,
        "socialAccountIds": account_ids,
        "mediaUrl": media_url,
        "clientRequestId": client_request_id,
    });
    if let Some(at) = scheduled_at {
        body["scheduledAt"] = serde_json::Value::String(at);
    }
    if let Some(config) = title_configurations(title.as_deref()) {
        body["platformConfigurations"] = config;
    }
    let out = after_cloud(&auth, &base, "post", crate::cloud::send(client, reqwest::Method::POST, &base, &token, "/v1/social/posts", Some(&body)).await)?;
    if let Some(post_id) = out.get("postId").and_then(serde_json::Value::as_str) {
        let posted = out.get("status").and_then(serde_json::Value::as_str) != Some("scheduled");
        let mut patch = serde_json::json!({ "socialPostId": post_id });
        if posted {
            patch["postedAt"] = serde_json::Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
        if let Err(e) = state.db.update_project(&project_id, patch) {
            eprintln!("[cloud] posted, but couldn't save the post id on the project: {e}");
        }
    }
    Ok(out)
}

/// One auto-post and how it went on each account.
#[tauri::command]
pub async fn social_post_status(state: State<'_, AppState>, auth: State<'_, Arc<Auth>>, post_id: String) -> CmdResult<serde_json::Value> {
    let auth = auth.inner().clone();
    let (base, token) = cloud_token(&state, &auth).await?;
    let path = format!("/v1/social/posts/{}", urlencode(&post_id));
    after_cloud(&auth, &base, "post status", crate::cloud::get(auth.client(), &base, &token, &path).await)
}

// ---- AI images and voice for agents ----

/// The folder a chat's agent works in (its project's, else its own under the working folder).
fn agent_folder(state: &AppState, chat_id: &str) -> Option<PathBuf> {
    let folder = project_folder_for_chat(state, chat_id).ok()?;
    resolve_cwd(&state.working(), chat_id, folder.as_deref()).ok()
}

/// Starts the agents' AI endpoint (see `ai_proxy`) and keeps it in the app state. Jobs run with the
/// signed-in user's token, which never leaves Rust.
pub async fn start_ai_proxy(handle: AppHandle) {
    let for_folder = handle.clone();
    let folder_for = Arc::new(move |chat: &str| for_folder.try_state::<AppState>().and_then(|s| agent_folder(&s, chat)));
    let for_run = handle.clone();
    let run: crate::ai_proxy::Runner = Arc::new(move |job, folder| {
        let handle = for_run.clone();
        Box::pin(async move {
            let (Some(state), Some(auth)) = (handle.try_state::<AppState>(), handle.try_state::<Arc<Auth>>()) else {
                return Err((503, serde_json::json!({ "error": "unavailable", "message": "Tayang is still starting" })));
            };
            let auth = auth.inner().clone();
            let base = api_base(&state);
            let token = auth.token(&base).await;
            // The user's own voice (Settings › Video) speaks instead of Tayang's, signed in or not.
            let settings = state.db.get_settings(&state.home);
            let own_voice = settings.voice_source != crate::types::VoiceSource::Tayang;
            if own_voice {
                if let crate::ai_proxy::AiJob::Voice { text, language, out, .. } = &job {
                    let source = settings.voice_source;
                    let key = match (source.key_account(), handle.try_state::<ApiKeys>()) {
                        (Some(account), Some(keys)) => keys.get_account(account).await.ok().flatten(),
                        _ => None,
                    };
                    let voice_id = match source {
                        crate::types::VoiceSource::Elevenlabs => settings.eleven_voice_id.clone(),
                        crate::types::VoiceSource::Fishaudio => settings.fish_voice_id.clone(),
                        _ => None,
                    };
                    let setup = crate::voice::VoiceSetup { source, key, voice_id, base: source.base().into() };
                    return crate::voice::speak(auth.client(), &setup, text, language.as_deref(), out, &folder).await;
                }
                if job == crate::ai_proxy::AiJob::Usage {
                    let usage = match &token {
                        Some(t) => crate::ai_proxy::run_job(auth.client(), &base, t, job, &folder).await.ok(),
                        None => None,
                    };
                    return Ok(crate::voice::usage_with_own_voice(usage, settings.voice_source));
                }
            }
            let Some(token) = token else {
                return Err((401, serde_json::json!({ "error": "signed-out", "message": "The user isn't signed in to Tayang: make this without AI images or voice" })));
            };
            crate::ai_proxy::run_job(auth.client(), &base, &token, job, &folder).await
        })
    });
    let for_act = handle.clone();
    let act: crate::ai_proxy::Actor = Arc::new(move |chat, name, context| {
        let _ = for_act.emit("agent://action", serde_json::json!({ "chatId": chat, "name": name, "context": context }));
    });
    match crate::ai_proxy::start(folder_for, run, act).await {
        Ok(proxy) => {
            handle.manage(proxy);
        }
        Err(e) => eprintln!("[ai] the agents' AI endpoint couldn't start: {e}"),
    }
}

// ---- agent ----

struct TauriSink(AppHandle);

impl AcpSink for TauriSink {
    fn update(&self, chat_id: &str, u: AgentUpdate) {
        let _ = self.0.emit("agent://update", serde_json::json!({ "chatId": chat_id, "update": u }));
    }

    fn permission(&self, req: PermissionRequest) {
        let _ = self.0.emit("agent://permission", req);
    }

    fn question(&self, q: crate::types::AgentQuestion) {
        let _ = self.0.emit("agent://question", q);
    }
}

/// A chat id that is safe to use as a single folder name.
fn safe_segment(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\'])
}

/// Where this chat's agent runs. `project_folder` is the recorded folder of the chat's
/// (known) project, when it has one: that folder is used as is, even if the working
/// folder has changed since, as long as it still exists. Every other chat runs inside
/// `working`.
pub fn resolve_cwd(
    working: &Path,
    chat_id: &str,
    project_folder: Option<&Path>,
) -> CmdResult<PathBuf> {
    if let Some(folder) = project_folder {
        if !folder.is_dir() {
            return Err(format!("This project's folder is missing: {}", folder.display()));
        }
        return Ok(folder.to_path_buf());
    }
    let cwd = if chat_id == "setup" {
        working.join(".tayang").join("setup")
    } else if let Some(rest) = chat_id.strip_prefix("study-") {
        if !safe_segment(rest) {
            return Err("That chat isn't valid".into());
        }
        working.join(".tayang").join("style-study").join(rest)
    } else {
        if !safe_segment(chat_id) {
            return Err("That chat isn't valid".into());
        }
        working.join(".tayang").join("chats").join(chat_id)
    };
    std::fs::create_dir_all(working).map_err(|e| format!("Can't create the working folder: {e}"))?;
    if !projects::ensure_inside(working, &cwd) {
        return Err("The agent can only work inside your working folder".into());
    }
    std::fs::create_dir_all(&cwd).map_err(|e| format!("Can't create {}: {e}", cwd.display()))?;
    Ok(cwd)
}

fn project_folder_for_chat(state: &AppState, chat_id: &str) -> CmdResult<Option<PathBuf>> {
    let chat = state.db.get_chat(chat_id).map_err(err)?;
    let Some(project_id) = chat.and_then(|c| c.project_id) else {
        return Ok(None);
    };
    let project = state
        .db
        .get_project(&project_id)
        .map_err(err)?
        .ok_or("This chat's project no longer exists")?;
    Ok(Some(PathBuf::from(project.folder)))
}

/// Added to Claude's system prompt for sessions Tayang starts.
pub const TAYANG_APPEND: &str = "You are running inside Tayang Studio, a desktop app for making motion videos. \
Follow the tayang-studio skill. When the user has to choose, ask with your AskUserQuestion tool: Tayang shows \
it as a card with the options. Never write JSON or markup for a choice.";

/// The Tayang agent plugin in the repo, used when the bundled copy is missing (`tauri dev`).
/// Debug builds only: a release build must never reach into the build machine's checkout.
fn dev_plugin_dir() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("skills")
        .join("agent-plugin");
    dir.join(".claude-plugin").join("plugin.json").is_file().then_some(dir)
}

/// The repo copy in debug builds (it is the one being edited; the build's copy in target/ goes stale,
/// a skill deleted from the repo stays there), else `<resource dir>/agent-plugin` when it holds the plugin.
/// `None` means Claude starts without the plugin, and the skills go into its first prompt instead.
fn plugin_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let found = dev_plugin_dir().or_else(|| {
        resource_dir
            .map(|r| r.join("agent-plugin"))
            .filter(|p| p.join(".claude-plugin").join("plugin.json").is_file())
    });
    if found.is_none() {
        eprintln!(
            "[tayang] warning: agent-plugin/.claude-plugin/plugin.json is missing from the app resources; \
             Claude gets the Tayang skills in its first prompt instead"
        );
    }
    found
}

/// Internal sessions (the setup installs, style studies and the autopilots' topic chats) never
/// talk to the user in a chat, so they get neither the plugin nor the system prompt. Topic ideas
/// (`ideas-*`) do.
pub fn wants_skills(chat_id: &str) -> bool {
    !(chat_id == "setup" || chat_id.starts_with("study-") || chat_id.starts_with("autopilot-"))
}

/// What a chat is for, as the usage log names it.
pub fn chat_kind(chat_id: &str, has_project: bool) -> &'static str {
    if chat_id == "setup" {
        "setup"
    } else if chat_id.starts_with("study-") {
        "study"
    } else if chat_id.starts_with("autopilot-") {
        "autopilot"
    } else if has_project {
        "project"
    } else {
        "chat"
    }
}

/// opencode logs a failed model call (a free model's usage limit) and then never answers the prompt:
/// its log, for the session to watch. None for other agents.
fn error_log(agent: AgentId) -> Option<PathBuf> {
    if !matches!(agent, AgentId::Opencode | AgentId::Custom) {
        return None;
    }
    let home = crate::system::home_dir()?;
    let db = crate::usage::opencode_db(&home, std::env::var("XDG_DATA_HOME").ok().as_deref());
    Some(db.parent()?.join("log").join("opencode.log"))
}

/// Claude gets the plugin and the system prompt through `_meta` (so nothing is
/// installed in the user's own `~/.claude`); every agent gets `TAYANG_STUDIO=1`.
/// Without `skills` (internal sessions) there is no `_meta` at all.
fn session_options(agent: AgentId, plugin: Option<&Path>, skills: bool) -> crate::acp::SessionOptions {
    let env = vec![("TAYANG_STUDIO".to_string(), "1".to_string())];
    let use_modes = agent == AgentId::Claude;
    if agent != AgentId::Claude || !skills {
        return crate::acp::SessionOptions { meta: None, env, auto: false, use_modes, mode_timeout: None, model: None, error_log: error_log(agent), usage_log: None };
    }
    let mut meta = serde_json::json!({ "systemPrompt": { "append": TAYANG_APPEND } });
    if let Some(path) = plugin {
        meta["claudeCode"] = serde_json::json!({
            "options": { "plugins": [{ "type": "local", "path": path.to_string_lossy() }] }
        });
    }
    crate::acp::SessionOptions { meta: Some(meta), env, auto: false, use_modes, mode_timeout: None, model: None, error_log: error_log(agent), usage_log: None }
}

/// Adds a local plugin to a Claude session that has `_meta` (sessions without it get no plugins).
fn add_plugin(options: &mut crate::acp::SessionOptions, path: &Path) {
    let Some(meta) = options.meta.as_mut() else { return };
    let entry = serde_json::json!({ "type": "local", "path": path.to_string_lossy() });
    match meta["claudeCode"]["options"]["plugins"].as_array_mut() {
        Some(list) => list.push(entry),
        None => meta["claudeCode"] = serde_json::json!({ "options": { "plugins": [entry] } }),
    }
}

fn skills_root(app: &AppHandle) -> CmdResult<PathBuf> {
    crate::skills::root(&app.path().app_data_dir().map_err(err)?)
}

/// The user's own skills, on and off.
#[tauri::command]
pub fn skills_list(app: AppHandle) -> CmdResult<Vec<crate::skills::Skill>> {
    Ok(crate::skills::list(&skills_root(&app)?))
}

#[tauri::command]
pub fn skill_read(app: AppHandle, id: String) -> CmdResult<crate::skills::SkillDetail> {
    crate::skills::read(&skills_root(&app)?, &id)
}

/// Creates a skill (no `id`) or saves an existing one's description and instructions.
#[tauri::command]
pub fn skill_save(
    app: AppHandle,
    id: Option<String>,
    name: String,
    description: String,
    body: String,
) -> CmdResult<crate::skills::Skill> {
    let root = skills_root(&app)?;
    match id {
        Some(id) => crate::skills::update(&root, &id, &description, &body),
        None => crate::skills::create(&root, &name, &description, &body),
    }
}

#[tauri::command]
pub fn skill_set_enabled(app: AppHandle, id: String, enabled: bool) -> CmdResult<crate::skills::Skill> {
    crate::skills::set_enabled(&skills_root(&app)?, &id, enabled)
}

#[tauri::command]
pub fn skill_delete(app: AppHandle, id: String) -> CmdResult<()> {
    crate::skills::delete(&skills_root(&app)?, &id)
}

/// Adds a skill from a SKILL.md file or a folder with one.
#[tauri::command]
pub fn skill_import(app: AppHandle, path: String) -> CmdResult<crate::skills::Skill> {
    crate::skills::import(&skills_root(&app)?, Path::new(&path))
}

/// Skills found at a GitHub link, waiting in a download for the user to choose.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDownload {
    id: String,
    skills: Vec<crate::skills_github::FoundSkill>,
}

/// Downloads the repo at a GitHub link and lists the skills in it. Only one download is kept.
#[tauri::command]
pub async fn skill_github_fetch(app: AppHandle, url: String) -> CmdResult<SkillDownload> {
    use crate::skills_github as gh;
    let link = gh::parse_link(&url)?;
    let data = app.path().app_data_dir().map_err(err)?;
    let _ = std::fs::remove_dir_all(data.join("skill-downloads"));
    let client = api_client(std::time::Duration::from_secs(90))?;
    let mut resp = client.get(link.archive_url()).send().await.map_err(|_| "Couldn't reach GitHub. Are you online?".to_string())?;
    match resp.status().as_u16() {
        200..=299 => {}
        404 => return Err("Nothing at that link. Check it, and note that private repos can't be added".into()),
        code => return Err(format!("GitHub didn't send the repo (error {code}). Try again in a minute")),
    }
    let too_big = || format!("That repo is over {} MB, too big to add skills from", gh::DOWNLOAD_LIMIT / 1024 / 1024);
    if resp.content_length().is_some_and(|n| n > gh::DOWNLOAD_LIMIT) {
        return Err(too_big());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| "The download stopped. Try again".to_string())? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > gh::DOWNLOAD_LIMIT {
            return Err(too_big());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = gh::download_dir(&data, &id)?;
    let found = tokio::task::spawn_blocking(move || {
        let result = gh::unpack(&bytes, &dir).and_then(|_| gh::find_skills(&dir, &link.path));
        match result {
            Ok(skills) => Ok(skills.into_iter().map(|s| gh::FoundSkill { source: link.folder_url(&s.folder), ..s }).collect()),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                Err(e)
            }
        }
    })
    .await
    .map_err(err)??;
    Ok(SkillDownload { id, skills: found })
}

/// One skill the user chose from a download.
#[derive(serde::Deserialize)]
pub struct SkillPick {
    folder: String,
    source: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstall {
    added: Vec<crate::skills::Skill>,
    /// "folder: why" for each that couldn't be added.
    failed: Vec<String>,
}

/// Adds the chosen skills from a download (each with its files), then removes the download.
#[tauri::command]
pub fn skill_github_install(app: AppHandle, id: String, picks: Vec<SkillPick>) -> CmdResult<SkillInstall> {
    let dir = crate::skills_github::download_dir(&app.path().app_data_dir().map_err(err)?, &id)?;
    if !dir.is_dir() {
        return Err("That download is gone. Paste the link again".into());
    }
    let root = skills_root(&app)?;
    let base = dir.canonicalize().map_err(err)?;
    let (mut added, mut failed) = (Vec::new(), Vec::new());
    for p in picks {
        let folder = dir.join(&p.folder);
        let inside = folder.canonicalize().is_ok_and(|f| f.starts_with(&base));
        let result = if inside { crate::skills::import_from(&root, &folder, &p.source) } else { Err("not in the download".into()) };
        match result {
            Ok(s) => added.push(s),
            Err(e) => failed.push(format!("{}: {e}", if p.folder.is_empty() { "SKILL.md" } else { &p.folder })),
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    Ok(SkillInstall { added, failed })
}

/// Throws away a download the user closed without adding anything.
#[tauri::command]
pub fn skill_github_discard(app: AppHandle, id: String) -> CmdResult<()> {
    let dir = crate::skills_github::download_dir(&app.path().app_data_dir().map_err(err)?, &id)?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

/// Tayang's own Claude Code config folder (see `claude_account`), created on first use.
pub fn claude_config_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = crate::claude_account::config_dir(&app.path().app_data_dir().map_err(err)?);
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// `CLAUDE_CONFIG_DIR` for a Claude session: Tayang's own sign-in and a clean setup. Nothing for
/// other agents.
fn claude_env(app: &AppHandle, agent: AgentId) -> CmdResult<Vec<(String, String)>> {
    if agent != AgentId::Claude {
        return Ok(Vec::new());
    }
    let dir = claude_config_dir(app)?;
    Ok(vec![(crate::claude_account::CONFIG_ENV.to_string(), dir.to_string_lossy().into_owned())])
}

fn claude_program() -> CmdResult<PathBuf> {
    system::Exec::which(&RealExec, "claude").ok_or_else(|| "Can't find Claude Code on this computer".to_string())
}

/// The Claude sign-in that is waiting for the browser, so it can be cancelled.
#[derive(Default)]
pub struct ClaudeSignIn(pub std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>);

/// The event with the sign-in page, for when the browser didn't open by itself.
pub const CLAUDE_SIGN_IN_URL_EVENT: &str = "claude://sign-in-url";

/// Who is signed in to Claude in Tayang.
#[tauri::command]
pub async fn claude_account(app: AppHandle) -> CmdResult<crate::claude_account::ClaudeAccount> {
    let dir = claude_config_dir(&app)?;
    let Ok(claude) = claude_program() else { return Ok(Default::default()) };
    Ok(crate::claude_account::status(&claude, &dir).await)
}

/// Signs in to Claude for Tayang: Claude Code opens the browser and the user signs in there.
/// Resolves with the account once they're done; an error when cancelled, timed out or refused.
#[tauri::command]
pub async fn claude_sign_in(
    app: AppHandle,
    pending: State<'_, ClaudeSignIn>,
    usage: State<'_, crate::usage::UsageCache>,
) -> CmdResult<crate::claude_account::ClaudeAccount> {
    use crate::claude_account::{sign_in, status, SignInEnd, SIGN_IN_TIMEOUT};
    let dir = claude_config_dir(&app)?;
    let claude = claude_program()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    // A new sign-in replaces one still waiting.
    if let Some(old) = pending.0.lock().map_err(err)?.replace(tx) {
        let _ = old.send(());
    }
    let emitter = app.clone();
    let end = sign_in(&claude, &dir, SIGN_IN_TIMEOUT, rx, move |url| {
        let _ = emitter.emit(CLAUDE_SIGN_IN_URL_EVENT, url);
    })
    .await;
    *usage.0.lock().map_err(err)? = None;
    match end {
        SignInEnd::Done => {
            let account = status(&claude, &dir).await;
            if account.signed_in {
                Ok(account)
            } else {
                Err("Claude didn't finish signing in. Try again".into())
            }
        }
        SignInEnd::Cancelled => Err("cancelled".into()),
        SignInEnd::TimedOut => Err("Signing in took too long. Try again".into()),
        SignInEnd::Failed(why) => Err(why),
    }
}

/// Stops a sign-in that is waiting for the browser.
#[tauri::command]
pub fn claude_sign_in_cancel(pending: State<'_, ClaudeSignIn>) -> CmdResult<()> {
    if let Some(tx) = pending.0.lock().map_err(err)?.take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// Signs out of Claude in Tayang. Running Claude chats keep going until they end.
#[tauri::command]
pub async fn claude_sign_out(
    app: AppHandle,
    usage: State<'_, crate::usage::UsageCache>,
) -> CmdResult<crate::claude_account::ClaudeAccount> {
    let dir = claude_config_dir(&app)?;
    let claude = claude_program()?;
    *usage.0.lock().map_err(err)? = None;
    Ok(crate::claude_account::sign_out(&claude, &dir).await)
}

/// Starts the chat's agent. Resolves `true` when Claude started without the Tayang
/// plugin, so the caller must send the skills as text in the first prompt (other
/// agents always get them that way).
#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    agent_id: AgentId,
    auto: Option<bool>,
) -> CmdResult<bool> {
    let (command, launch_env) = agent_launch(&app, agent_id).await?;
    let folder = project_folder_for_chat(&state, &chat_id)?;
    let cwd = resolve_cwd(&state.working(), &chat_id, folder.as_deref())?;
    let resource_dir = app.path().resource_dir().ok();
    let skills = wants_skills(&chat_id);
    let plugin = if agent_id == AgentId::Claude && skills {
        plugin_dir(resource_dir.as_deref())
    } else {
        None
    };
    let mut options = session_options(agent_id, plugin.as_deref(), skills);
    // The user's own skills (the Skills screen) load as a second plugin.
    if agent_id == AgentId::Claude && skills {
        if let Some(mine) = app.path().app_data_dir().ok().and_then(|d| crate::skills::root(&d).ok()).and_then(|r| crate::skills::plugin(&r)) {
            add_plugin(&mut options, &mine);
        }
    }
    options.env.extend(claude_env(&app, agent_id)?);
    options.env.extend(launch_env);
    options.auto = wants_auto(&chat_id, auto.unwrap_or(false));
    options.model = picked_model(&state, agent_id);
    options.usage_log = app.path().app_data_dir().ok().map(|dir| crate::acp::UsageLog {
        path: dir.join("agent-usage.jsonl"),
        agent: agent_key(agent_id),
        kind: chat_kind(&chat_id, folder.is_some()).to_string(),
    });
    // AI images and voice with the user's credits: this session's own token for Tayang's endpoint.
    if let Some(proxy) = app.try_state::<Arc<crate::ai_proxy::AiProxy>>() {
        options.env.extend(proxy.session_env(&chat_id));
    }
    let skills_as_text = skills && needs_skills_text(agent_id, plugin.as_deref());
    state
        .acp
        .start_with(&chat_id, &command, &cwd, Arc::new(TauriSink(app)), options)
        .await
        .map_err(err)?;
    Ok(skills_as_text)
}

fn agent_key(agent: AgentId) -> String {
    serde_json::to_value(agent).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// The model the user picked for this agent, if any.
fn picked_model(state: &AppState, agent: AgentId) -> Option<String> {
    state.db.get_settings(&state.home).agent_models.get(&agent_key(agent)).cloned()
}

/// The models an agent offers, and the one in use.
#[derive(serde::Serialize)]
pub struct AgentModels {
    current: Option<String>,
    options: Vec<crate::types::ModelChoice>,
}

/// Picks the model for an agent (None: its own default) and, when `chat_id` has a session
/// running, switches that session now. Later sessions of the agent start on it.
#[tauri::command]
pub async fn set_agent_model(
    state: State<'_, AppState>,
    agent_id: AgentId,
    model: Option<String>,
    chat_id: Option<String>,
) -> CmdResult<Settings> {
    let settings = state
        .db
        .update_settings(serde_json::json!({ "agentModels": { agent_key(agent_id): model } }))
        .map_err(err)?;
    if let (Some(chat), Some(value)) = (chat_id.as_deref(), model.as_deref()) {
        // No session yet is fine: it starts on the picked model.
        if state.acp.models(chat).is_ok() {
            state.acp.set_model(chat, value).await.map_err(err)?;
        }
    }
    Ok(settings)
}

/// Never shows anything: a probe session's updates go nowhere.
struct QuietSink;
impl crate::acp::AcpSink for QuietSink {
    fn update(&self, _chat_id: &str, _u: AgentUpdate) {}
    fn permission(&self, _req: crate::types::PermissionRequest) {}
}

/// The models an agent offers, read by opening a short session in a scratch folder (for the picker
/// before any chat with that agent has run). None when the agent doesn't report models.
#[tauri::command]
pub async fn agent_models(app: AppHandle, state: State<'_, AppState>, agent_id: AgentId) -> CmdResult<Option<AgentModels>> {
    let (command, launch_env) = agent_launch(&app, agent_id).await?;
    let cwd = app.path().app_cache_dir().map_err(err)?.join("model-probe");
    std::fs::create_dir_all(&cwd).map_err(err)?;
    let probe = format!("models-{}", agent_key(agent_id));
    let mut options = session_options(agent_id, None, false);
    options.env.extend(claude_env(&app, agent_id)?);
    options.env.extend(launch_env);
    state.acp.start_with(&probe, &command, &cwd, Arc::new(QuietSink), options).await.map_err(err)?;
    let models = state.acp.models(&probe).ok().flatten();
    let _ = state.acp.stop(&probe).await;
    Ok(models.map(|m| AgentModels { current: m.current, options: m.options }))
}

/// Style studies and the autopilots' topic chats always run in auto mode; the install chat
/// never does (installs need the user's approval); other chats follow the chat's Auto toggle.
fn wants_auto(chat_id: &str, requested: bool) -> bool {
    if chat_id == "setup" {
        return false;
    }
    chat_id.starts_with("study-") || chat_id.starts_with("autopilot-") || requested
}

/// Claude without the plugin has no skills unless the first prompt carries them.
fn needs_skills_text(agent: AgentId, plugin: Option<&Path>) -> bool {
    agent == AgentId::Claude && plugin.is_none()
}

/// m:ss.cc, same as `formatTimecode` in `@tayang/shared`.
pub fn format_timecode(sec: f64, fps: u32) -> String {
    let fps = fps.max(1);
    let total = sec.max(0.0);
    let whole = total.floor();
    let frame = (((total - whole) * fps as f64).round() as u32).min(fps - 1);
    let cc = (frame as f64 / fps as f64 * 100.0).floor() as u32;
    let whole = whole as u64;
    format!("{}:{:02}.{:02}", whole / 60, whole % 60, cc)
}

/// How much of a mentioned project's AGENTS.md goes into the prompt.
const BRIEF_LIMIT: usize = 8 * 1024;

/// `<folder>/AGENTS.md`, cut to `BRIEF_LIMIT` bytes on a character boundary.
pub fn read_brief(folder: &Path) -> Option<String> {
    let text = std::fs::read_to_string(folder.join("AGENTS.md")).ok()?;
    Some(truncate_brief(&text))
}

fn truncate_brief(text: &str) -> String {
    if text.len() <= BRIEF_LIMIT {
        return text.to_string();
    }
    let mut end = BRIEF_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[AGENTS.md cut at 8 KB]", &text[..end])
}

/// Turns chat parts into what the agent sees. Tool parts are skipped. A mentioned
/// project's AGENTS.md (from `brief`) is inlined, since a new chat's agent runs
/// outside that project's folder.
pub fn build_prompt(
    parts: &[MessagePart],
    fps: u32,
    project: impl Fn(&str) -> Option<Project>,
    brief: impl Fn(&Path) -> Option<String>,
) -> Vec<PromptPart> {
    let mut out = Vec::new();
    for part in parts {
        match part {
            MessagePart::Text { text } => out.push(PromptPart::Text(text.clone())),
            MessagePart::Mention { project_id, title } => {
                out.push(PromptPart::Text(match project(project_id) {
                    Some(p) => {
                        let head = format!(
                            "Context: video project \"{}\". Its Tayang id is {}. Its files are in {}.",
                            p.title, p.id, p.folder
                        );
                        match brief(Path::new(&p.folder)) {
                            Some(b) if !b.trim().is_empty() => {
                                format!("{head}\nIts AGENTS.md:\n\n{}", b.trim_end())
                            }
                            _ => head,
                        }
                    }
                    None => format!(
                        "Context: video project \"{title}\" (no longer on this computer)."
                    ),
                }));
            }
            MessagePart::Frame { project_id, frame, time_sec, image_path, marks } => {
                let title = project(project_id).map(|p| p.title).unwrap_or_default();
                let marks = if marks.is_empty() {
                    "none".to_string()
                } else {
                    marks
                        .iter()
                        .map(|m| format!("({:.2}, {:.2})", m.x, m.y))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                out.push(PromptPart::Image { path: PathBuf::from(image_path) });
                out.push(PromptPart::Text(format!(
                    "Frame {frame} at {} of {title}. Marks (x,y relative): {marks}",
                    format_timecode(*time_sec, fps)
                )));
            }
            MessagePart::File { path, name, size, .. } => {
                let rel = Path::new(path)
                    .file_name()
                    .map(|f| format!("attachments/{}", f.to_string_lossy()))
                    .unwrap_or_else(|| name.clone());
                let inline = is_image_name(name) && *size <= MAX_IMAGE_BLOCK;
                let size = human_size(*size);
                if inline {
                    out.push(PromptPart::Image { path: PathBuf::from(path) });
                    out.push(PromptPart::Text(format!("Attached image: {rel} ({name}, {size})")));
                } else {
                    out.push(PromptPart::Text(format!("Attached file: {rel} ({name}, {size})")));
                }
            }
            // A style's context comes from the app, which has its prompt and notes.
            MessagePart::Tool { .. }
            | MessagePart::Thought { .. }
            | MessagePart::A2ui { .. }
            | MessagePart::StyleMention { .. } => {}
            MessagePart::A2uiAction { summary, action } => {
                out.push(PromptPart::Text(format!("{summary}\n\n```a2ui-action\n{action}\n```")));
            }
        }
    }
    out
}

pub const MAX_ATTACHMENT: u64 = 50 * 1024 * 1024;
/// Larger images go to the agent as the "Attached file" line: agents refuse big inline images.
pub const MAX_IMAGE_BLOCK: u64 = 5 * 1024 * 1024;

/// Mime type from the file extension; unknown ones are generic binary.
fn mime_for(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

/// Images the agent gets as an image block (the types ACP's `image_block` sends). A gif is a file.
fn is_image_name(name: &str) -> bool {
    matches!(mime_for(name), "image/png" | "image/jpeg" | "image/webp")
}

fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} B")
    } else if b < KB * KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{:.1} MB", b / (KB * KB))
    }
}

/// Copies `source` into `<cwd>/attachments/`, under a name that is not taken yet.
pub fn copy_attachment(cwd: &Path, source: &Path, max: u64) -> CmdResult<MessagePart> {
    let meta = std::fs::metadata(source).map_err(|e| format!("Can't read that file: {e}"))?;
    if !meta.is_file() {
        return Err("That isn't a file".into());
    }
    if meta.len() > max {
        return Err("That file is larger than 50 MB".into());
    }
    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| safe_segment(n))
        .ok_or("That file has no usable name")?;
    let dir = cwd.join("attachments");
    if !projects::ensure_inside(cwd, &dir) {
        return Err("The agent can only read files inside this chat's folder".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
    let (stem, ext) = match file_name.rfind('.') {
        Some(i) if i > 0 => (file_name[..i].to_string(), file_name[i..].to_string()),
        _ => (file_name.clone(), String::new()),
    };
    let mut name = file_name;
    let mut n = 1;
    loop {
        let dest = dir.join(&name);
        if !projects::ensure_inside(cwd, &dest) {
            return Err("The agent can only read files inside this chat's folder".into());
        }
        // create_new keeps two attachments from racing for the same name.
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&dest) {
            Ok(mut out) => {
                let mut input = std::fs::File::open(source)
                    .map_err(|e| format!("Can't read that file: {e}"))?;
                if let Err(e) = std::io::copy(&mut input, &mut out) {
                    drop(out);
                    let _ = std::fs::remove_file(&dest);
                    return Err(format!("Can't copy that file: {e}"));
                }
                return Ok(MessagePart::File {
                    path: dest.to_string_lossy().into_owned(),
                    mime: mime_for(&name).into(),
                    name,
                    size: meta.len(),
                    modified_at: None,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                n += 1;
                name = format!("{stem}-{n}{ext}");
            }
            Err(e) => return Err(format!("Can't copy that file: {e}")),
        }
    }
}

/// Attached files must live inside the chat's own folder.
pub fn check_file_parts(cwd: &Path, parts: &[MessagePart]) -> CmdResult<()> {
    for part in parts {
        if let MessagePart::File { path, .. } = part {
            if !projects::ensure_inside(cwd, Path::new(path)) {
                return Err("That file is outside this chat's folder".into());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn attach_file(
    state: State<'_, AppState>,
    chat_id: String,
    source_path: String,
) -> CmdResult<MessagePart> {
    let folder = project_folder_for_chat(&state, &chat_id)?;
    let cwd = resolve_cwd(&state.working(), &chat_id, folder.as_deref())?;
    copy_attachment(&cwd, Path::new(&source_path), MAX_ATTACHMENT)
}

/// Frame images must live inside the working folder or inside the recorded folder of
/// the frame's own (known, existing) project.
pub fn check_frame_images(
    working: &Path,
    parts: &[MessagePart],
    project_folder: impl Fn(&str) -> Option<PathBuf>,
) -> CmdResult<()> {
    for part in parts {
        if let MessagePart::Frame { image_path, project_id, .. } = part {
            let image = Path::new(image_path);
            let in_project = project_folder(project_id)
                .filter(|f| f.is_dir())
                .is_some_and(|f| projects::ensure_inside(&f, image));
            if !in_project && !projects::ensure_inside(working, image) {
                return Err("That frame image is outside your working folder".into());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_prompt(
    state: State<'_, AppState>,
    chat_id: String,
    parts: Vec<MessagePart>,
) -> CmdResult<()> {
    let settings = state.db.get_settings(&state.home);
    let fps = settings.fps;
    let working = PathBuf::from(&settings.working_folder);
    if parts.iter().any(|p| matches!(p, MessagePart::File { .. })) {
        let folder = project_folder_for_chat(&state, &chat_id)?;
        let cwd = resolve_cwd(&working, &chat_id, folder.as_deref())?;
        check_file_parts(&cwd, &parts)?;
    }
    check_frame_images(&working, &parts, |id| {
        state.db.get_project(id).ok().flatten().map(|p| PathBuf::from(p.folder))
    })?;
    let prompt = build_prompt(&parts, fps, |id| state.db.get_project(id).ok().flatten(), read_brief);
    state.acp.prompt(&chat_id, prompt).await.map_err(err)
}

/// Turns auto mode on or off for the chat's running agent. The setup chat can't.
#[tauri::command]
pub async fn agent_set_auto(
    state: State<'_, AppState>,
    chat_id: String,
    on: bool,
) -> CmdResult<()> {
    let on = wants_auto(&chat_id, on);
    state.acp.set_auto(&chat_id, on).await.map(|_| ()).map_err(err)
}

#[tauri::command]
pub async fn agent_cancel(state: State<'_, AppState>, chat_id: String) -> CmdResult<()> {
    state.acp.cancel(&chat_id).await.map_err(err)
}

/// Stops the agent process of this chat. Stopping a chat with no agent is fine.
#[tauri::command]
pub async fn agent_stop(state: State<'_, AppState>, chat_id: String) -> CmdResult<()> {
    let _ = state.acp.stop(&chat_id).await;
    Ok(())
}

/// The user's answer to an agent's question: `{action: "accept", content}`, `{action: "decline"}`
/// or `{action: "cancel"}`.
#[tauri::command]
pub fn agent_respond_question(state: State<'_, AppState>, request_id: String, response: serde_json::Value) -> CmdResult<()> {
    state.acp.respond_question(&request_id, response).map_err(err)
}

#[tauri::command]
pub fn agent_respond_permission(
    state: State<'_, AppState>,
    request_id: String,
    option_id: Option<String>,
) -> CmdResult<()> {
    state.acp.respond_permission(&request_id, option_id).map_err(err)
}

// ---- media ----

fn project_folder(state: &AppState, project_id: &str) -> CmdResult<PathBuf> {
    state
        .db
        .get_project(project_id)
        .map_err(err)?
        .map(|p| PathBuf::from(p.folder))
        .ok_or_else(|| "That project no longer exists".to_string())
}

// ---- project files (the workspace) ----

/// One folder of a project, `dir` relative to the project folder ("" is the top).
#[tauri::command]
pub async fn project_files(state: State<'_, AppState>, project_id: String, dir: String) -> CmdResult<Vec<crate::files::FileEntry>> {
    let root = project_folder(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || crate::files::list_dir(&root, &dir)).await.map_err(err)?
}

/// A project's files whose name contains `query`.
#[tauri::command]
pub async fn find_project_files(state: State<'_, AppState>, project_id: String, query: String) -> CmdResult<Vec<crate::files::FileEntry>> {
    let root = project_folder(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || crate::files::find(&root, &query)).await.map_err(err)?
}

/// One project file to show: its text, or what kind of file it is.
#[tauri::command]
pub async fn read_project_file(state: State<'_, AppState>, project_id: String, path: String) -> CmdResult<crate::files::FileContent> {
    let root = project_folder(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || crate::files::read(&root, &path)).await.map_err(err)?
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tauri::command]
pub fn media_latest_render(
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<Option<String>> {
    let folder = project_folder(&state, &project_id)?;
    Ok(media::latest_render(&folder).map(|p| path_string(&p)))
}

/// Where `recent_images` looks and from when: None for a chat without a project folder (no project,
/// an unknown chat, or a deleted project), an error for a time that is not RFC 3339.
fn images_lookup(state: &AppState, chat_id: &str, since: &str) -> CmdResult<Option<(PathBuf, chrono::DateTime<chrono::Utc>)>> {
    let since = chrono::DateTime::parse_from_rfc3339(since)
        .map_err(|_| format!("Not an RFC 3339 time: {since}"))?
        .with_timezone(&chrono::Utc);
    Ok(project_folder_for_chat(state, chat_id).ok().flatten().map(|f| (f, since)))
}

/// Images the agent made in a project chat's folder since `since` (RFC 3339), newest first.
/// A chat without a project folder has none.
#[tauri::command]
pub async fn recent_images(
    state: State<'_, AppState>,
    chat_id: String,
    since: String,
    limit: u32,
) -> CmdResult<Vec<crate::types::FileInfo>> {
    let Some((folder, since)) = images_lookup(&state, &chat_id, &since)? else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || media::recent_images(&folder, since, limit as usize))
        .await
        .map_err(err)
}

/// The newest render with its size and time, so the UI can tell whether a turn made a video.
#[tauri::command]
pub fn latest_render_info(state: State<'_, AppState>, project_id: String) -> CmdResult<Option<crate::types::FileInfo>> {
    let folder = project_folder(&state, &project_id)?;
    Ok(media::latest_render_info(&folder))
}

/// Shows a video in the file manager: its newest render selected, or its project folder before there is
/// one. The path is found here, so the webview can't ask to show any other file.
#[tauri::command]
pub async fn show_video_in_folder(app: AppHandle, state: State<'_, AppState>, project_id: String) -> CmdResult<()> {
    let folder = project_folder(&state, &project_id)?;
    let f = folder.clone();
    let video = tauri::async_runtime::spawn_blocking(move || media::latest_render(&f)).await.map_err(err)?;
    use tauri_plugin_opener::OpenerExt;
    match video {
        Some(v) => app.opener().reveal_item_in_dir(v).map_err(err),
        None => app.opener().open_path(folder.to_string_lossy(), None::<&str>).map_err(err),
    }
}

/// The newest `*.mp4` where renders land (empty too), for spotting a render that is being written.
#[tauri::command]
pub async fn newest_video_info(state: State<'_, AppState>, project_id: String) -> CmdResult<Option<crate::types::FileInfo>> {
    let folder = project_folder(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || media::newest_video_info(&folder)).await.map_err(err)
}

/// One frame of the project's newest render for its Videos card, cached in `<app data>/thumbs`; None without
/// a render or ffmpeg. Runs off the main thread, each ffmpeg run within the usual time limit.
#[tauri::command]
pub async fn video_thumbnail(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<Option<media::VideoThumb>> {
    let folder = project_folder(&state, &project_id)?;
    let thumbs = app.path().app_data_dir().map_err(err)?.join("thumbs");
    let tools = state.media.clone();
    // The newest render's thumbnail is already there: no slot needed.
    let (f, t, id) = (folder.clone(), thumbs.clone(), project_id.clone());
    if let Some(hit) = tauri::async_runtime::spawn_blocking(move || media::cached_video_thumbnail(&f, &t, &id)).await.map_err(err)? {
        return Ok(Some(hit));
    }
    // It looks in the cache again: another lookup may have made it while this one waited.
    in_thumb_slot(&THUMB_SLOTS, move || media::video_thumbnail(&tools, &folder, &thumbs, &project_id, media::THUMB_TIMEOUT)).await
}

/// At most two thumbnails are made at once: a Videos screen full of new renders must not start an ffprobe
/// and an ffmpeg per card at the same time (an agent's render may be running).
static THUMB_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Runs a blocking thumbnail job off the async runtime once one of `slots` is free.
async fn in_thumb_slot<T: Send + 'static>(
    slots: &'static tokio::sync::Semaphore,
    job: impl FnOnce() -> T + Send + 'static,
) -> CmdResult<T> {
    let _slot = slots.acquire().await.map_err(err)?;
    tokio::task::spawn_blocking(job).await.map_err(err)
}

#[tauri::command]
pub async fn media_probe(
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<Option<MediaInfo>> {
    let folder = project_folder(&state, &project_id)?;
    let tools = state.media.clone();
    tauri::async_runtime::spawn_blocking(move || match media::latest_render(&folder) {
        Some(video) => media::probe(&tools, &video).map(Some),
        None => Ok(None),
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn media_extract_frame(
    state: State<'_, AppState>,
    project_id: String,
    time_sec: f64,
) -> CmdResult<String> {
    let folder = project_folder(&state, &project_id)?;
    let tools = state.media.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let video = media::latest_render(&folder).ok_or("This project has no render yet")?;
        let out = folder.join(".tayang").join("frames");
        media::extract_frame(&tools, &video, time_sec, &out).map(|p| path_string(&p))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn media_thumbnails(
    state: State<'_, AppState>,
    project_id: String,
    count: u32,
) -> CmdResult<Vec<String>> {
    let folder = project_folder(&state, &project_id)?;
    let tools = state.media.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let video = media::latest_render(&folder).ok_or("This project has no render yet")?;
        let out = folder.join(".tayang").join("thumbs");
        media::thumbnails(&tools, &video, count, &out)
            .map(|v| v.iter().map(|p| path_string(p)).collect())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn media_render(state: State<'_, AppState>, project_id: String) -> CmdResult<String> {
    let folder = project_folder(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        media::render(&folder).map(|p| path_string(&p))
    })
    .await
    .map_err(err)?
}

/// A public catalog from the API (`/v1/niches`, `/v1/voices`), as the API sends it.
async fn catalog(state: &State<'_, AppState>, path: &str) -> CmdResult<serde_json::Value> {
    use crate::styles_sync::Fetcher;
    let api_url = crate::styles_sync::effective_api_url(&state.db.get_settings(&state.home));
    let fetcher = crate::styles_sync::HttpFetcher::new(std::time::Duration::from_secs(10))?;
    let res = fetcher.get(&crate::styles_sync::endpoint(&api_url, path), 1024 * 1024).await?;
    if !(200..300).contains(&res.status) {
        return Err(format!("{path} returned {}", res.status));
    }
    serde_json::from_slice(&res.body).map_err(err)
}

#[tauri::command]
pub async fn list_niches(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    catalog(&state, "/v1/niches").await
}

#[tauri::command]
pub async fn list_voices(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    catalog(&state, "/v1/voices").await
}

/// Fetches the built-in styles from the API; keeps the cached ones when offline.
#[tauri::command]
pub async fn sync_styles(state: State<'_, AppState>) -> CmdResult<StylesSync> {
    let api_url = crate::styles_sync::effective_api_url(&state.db.get_settings(&state.home));
    let fetcher = crate::styles_sync::HttpFetcher::new(std::time::Duration::from_secs(10))?;
    crate::styles_sync::sync_styles(&state.db, &api_url, &fetcher).await
}

/// Unpacks the project's style template into its folder (once, never over existing files).
#[tauri::command]
pub async fn install_style_template(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<InstallResult> {
    let api_url = crate::styles_sync::effective_api_url(&state.db.get_settings(&state.home));
    let templates = app.path().app_data_dir().map_err(err)?.join("templates");
    let fetcher = crate::styles_sync::HttpFetcher::new(std::time::Duration::from_secs(120))?;
    let installed =
        crate::styles_sync::install_template(&state.db, &fetcher, &api_url, &templates, &project_id)
            .await?;
    Ok(InstallResult { installed })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RenderCommand {
    pub install: Option<Vec<String>>,
    pub render: Vec<String>,
}

/// The exact command "Render video" will run when the project has a `tayang.json`.
#[tauri::command]
pub fn render_command(
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<Option<RenderCommand>> {
    let folder = project_folder(&state, &project_id)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(media::render_command(&folder, now)?.map(|p| RenderCommand { install: p.install, render: p.render }))
}

/// Rewrites the project's AGENTS.md and CLAUDE.md (e.g. after a template could not be installed).
#[tauri::command]
pub fn write_brief(state: State<'_, AppState>, project_id: String, brief: String) -> CmdResult<()> {
    let folder = project_folder(&state, &project_id)?;
    projects::write_project_brief(&folder, &brief)
        .map_err(|e| format!("Can't write the project brief: {e}"))
}

// ---- Your API (the `custom` agent: opencode with the user's provider, see api_engine) ----

/// Where the provider's key is kept: the keychain like the sign-in token (a file only when there is
/// no keychain); dev builds use a 0600 file for the reason given at `auth_manager`.
pub struct ApiKeys(pub Arc<dyn crate::auth::TokenStore>);

impl ApiKeys {
    pub fn new(data_dir: &Path) -> Self {
        let store: Arc<dyn crate::auth::TokenStore> = if cfg!(debug_assertions) {
            Arc::new(FileStore::new(data_dir.join("api-key-dev.json")))
        } else {
            Arc::new(SecureStore::new(KeyringStore, FileStore::new(data_dir.join("api-key.json"))))
        };
        Self(store)
    }

    /// The keychain can block or ask, so it runs off the async threads.
    async fn get_account(&self, account: &'static str) -> CmdResult<Option<String>> {
        let store = self.0.clone();
        tauri::async_runtime::spawn_blocking(move || store.get(account)).await.map_err(err)?.map_err(err)
    }

    async fn set_account(&self, account: &'static str, key: String) -> CmdResult<()> {
        let store = self.0.clone();
        tauri::async_runtime::spawn_blocking(move || store.set(account, &key)).await.map_err(err)?.map_err(err)
    }

    async fn delete_account(&self, account: &'static str) -> CmdResult<()> {
        let store = self.0.clone();
        tauri::async_runtime::spawn_blocking(move || store.delete(account)).await.map_err(err)?.map_err(err)
    }

    async fn get(&self) -> CmdResult<Option<String>> {
        self.get_account(crate::api_engine::KEY_ACCOUNT).await
    }

    async fn set(&self, key: String) -> CmdResult<()> {
        self.set_account(crate::api_engine::KEY_ACCOUNT, key).await
    }

    async fn delete(&self) -> CmdResult<()> {
        self.delete_account(crate::api_engine::KEY_ACCOUNT).await
    }
}

// ---- the user's own voice (Fish Audio or VoiceStudio, see voice) ----

/// What Settings › Video shows about the voice sources: which keys are saved.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    has_eleven_key: bool,
    has_fish_key: bool,
}

/// The keychain account and the Settings key of the voice id, for a source that has an API key.
fn voice_key_source(source: crate::types::VoiceSource) -> CmdResult<(&'static str, &'static str, &'static str)> {
    use crate::types::VoiceSource::*;
    let account = source.key_account().ok_or("That voice source has no API key")?;
    Ok(match source {
        Elevenlabs => (account, "elevenlabs", "elevenVoiceId"),
        _ => (account, "fishaudio", "fishVoiceId"),
    })
}

#[tauri::command]
pub async fn voice_status(keys: State<'_, ApiKeys>) -> CmdResult<VoiceStatus> {
    let mut saved = [false, false];
    for (i, source) in [crate::types::VoiceSource::Elevenlabs, crate::types::VoiceSource::Fishaudio].into_iter().enumerate() {
        if let Some(account) = source.key_account() {
            saved[i] = keys.get_account(account).await.ok().flatten().is_some_and(|k| !k.is_empty());
        }
    }
    Ok(VoiceStatus { has_eleven_key: saved[0], has_fish_key: saved[1] })
}

/// Checks the source's API key (no `key`: the saved one) and, when it is good, saves it with the
/// voice id and makes that source the voice source. A refused key changes nothing.
#[tauri::command]
pub async fn voice_key_save(
    state: State<'_, AppState>,
    keys: State<'_, ApiKeys>,
    source: crate::types::VoiceSource,
    key: Option<String>,
    voice_id: Option<String>,
) -> CmdResult<(crate::voice::VoiceCheck, Settings)> {
    let (account, name, voice_key) = voice_key_source(source)?;
    let typed = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let key = match &typed {
        Some(k) => k.clone(),
        None => keys.get_account(account).await?.unwrap_or_default(),
    };
    let client = api_client(std::time::Duration::from_secs(20))?;
    let check = crate::voice::key_check(&client, source, source.base(), &key).await;
    if !check.ok {
        return Ok((check, state.db.get_settings(&state.home)));
    }
    if let Some(k) = typed {
        keys.set_account(account, k).await?;
    }
    let voice_id = voice_id.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let mut patch = serde_json::json!({ "voiceSource": name });
    patch[voice_key] = serde_json::json!(voice_id);
    let settings = state.db.update_settings(patch).map_err(err)?;
    Ok((check, settings))
}

/// Forgets the source's API key; the voice source goes back to Tayang when it was that source.
#[tauri::command]
pub async fn voice_key_clear(state: State<'_, AppState>, keys: State<'_, ApiKeys>, source: crate::types::VoiceSource) -> CmdResult<Settings> {
    let (account, _, voice_key) = voice_key_source(source)?;
    keys.delete_account(account).await?;
    let mut patch = serde_json::json!({});
    patch[voice_key] = serde_json::Value::Null;
    if state.db.get_settings(&state.home).voice_source == source {
        patch["voiceSource"] = serde_json::json!("tayang");
    }
    state.db.update_settings(patch).map_err(err)
}

/// Whether VoiceStudio is open on this computer.
#[tauri::command]
pub async fn voice_studio_check() -> CmdResult<crate::voice::VoiceCheck> {
    let client = api_client(std::time::Duration::from_secs(5))?;
    Ok(crate::voice::voicestudio_check(&client, crate::voice::VOICESTUDIO_BASE).await)
}

/// One engine download at a time.
#[derive(Default)]
pub struct EngineInstall(pub tokio::sync::Mutex<()>);

/// The download's progress, `{ done, total }` in bytes.
pub const ENGINE_PROGRESS_EVENT: &str = "engine://progress";

fn api_client(timeout: std::time::Duration) -> CmdResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(concat!("tayang-studio/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(err)
}

/// What Your API has: the provider, whether a key is saved and whether the engine is downloaded.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatus {
    provider: Option<crate::api_engine::ApiProvider>,
    has_key: bool,
    engine_installed: bool,
}

#[tauri::command]
pub async fn api_status(app: AppHandle, state: State<'_, AppState>, keys: State<'_, ApiKeys>) -> CmdResult<ApiStatus> {
    let data = app.path().app_data_dir().map_err(err)?;
    Ok(ApiStatus {
        provider: state.db.get_settings(&state.home).api_provider,
        has_key: keys.get().await.ok().flatten().is_some_and(|k| !k.is_empty()),
        engine_installed: crate::api_engine::installed_engine(&data).is_some(),
    })
}

/// Lists the models at `base_url`, which checks the key too. No `key`: the saved one.
#[tauri::command]
pub async fn api_check(keys: State<'_, ApiKeys>, base_url: String, key: Option<String>) -> CmdResult<crate::api_engine::ApiCheck> {
    let base = crate::api_engine::clean_base_url(&base_url).ok_or("Type an address that starts with https:// or http://")?;
    let key = match key {
        Some(k) => k,
        None => keys.get().await?.unwrap_or_default(),
    };
    let client = api_client(std::time::Duration::from_secs(20))?;
    Ok(crate::api_engine::check(&client, &base, &key).await)
}

/// One real one-token call with `model`, before saving: proves the key, the balance and the model.
/// No `key`: the saved one.
#[tauri::command]
pub async fn api_try(keys: State<'_, ApiKeys>, base_url: String, key: Option<String>, model: String) -> CmdResult<crate::api_engine::ApiCheck> {
    let base = crate::api_engine::clean_base_url(&base_url).ok_or("Type an address that starts with https:// or http://")?;
    let key = match key {
        Some(k) => k,
        None => keys.get().await?.unwrap_or_default(),
    };
    let client = api_client(std::time::Duration::from_secs(60))?;
    Ok(crate::api_engine::try_model(&client, &base, &key, model.trim()).await)
}

/// Whether something answers at `base_url` (a local 9router).
#[tauri::command]
pub async fn api_reachable(base_url: String) -> CmdResult<bool> {
    let Some(base) = crate::api_engine::clean_base_url(&base_url) else { return Ok(false) };
    let client = api_client(std::time::Duration::from_millis(1500))?;
    Ok(crate::api_engine::reachable(&client, &base).await)
}

/// Saves the provider (and the key, when given) and makes Your API the default agent.
#[tauri::command]
pub async fn api_save(
    state: State<'_, AppState>,
    keys: State<'_, ApiKeys>,
    usage: State<'_, crate::usage::UsageCache>,
    provider: crate::api_engine::ApiProvider,
    key: Option<String>,
) -> CmdResult<Settings> {
    let base_url = crate::api_engine::clean_base_url(&provider.base_url).ok_or("Type an address that starts with https:// or http://")?;
    let model = provider.model.trim().to_string();
    if model.is_empty() {
        return Err("Pick a model".into());
    }
    if let Some(key) = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        keys.set(key).await?;
    }
    let mut models: Vec<String> = provider.models.iter().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect();
    models.sort();
    models.dedup();
    let provider = crate::api_engine::ApiProvider { provider: provider.provider, base_url, model, models };
    *usage.0.lock().map_err(err)? = None;
    // The model picked here is the one to use: forget a pick from the chat's model menu.
    let mut agent_models = state.db.get_settings(&state.home).agent_models;
    agent_models.remove("custom");
    state
        .db
        .update_settings(serde_json::json!({ "apiProvider": provider, "defaultAgent": "custom", "agentModels": agent_models }))
        .map_err(err)
}

/// Forgets the provider and its key. The default agent goes back to Claude Code when it was Your API.
#[tauri::command]
pub async fn api_clear(state: State<'_, AppState>, keys: State<'_, ApiKeys>) -> CmdResult<Settings> {
    keys.delete().await?;
    let mut patch = serde_json::json!({ "apiProvider": null });
    if state.db.get_settings(&state.home).default_agent == AgentId::Custom {
        patch["defaultAgent"] = serde_json::json!("claude");
    }
    state.db.update_settings(patch).map_err(err)
}

/// Downloads the engine unless it is there, sending `engine://progress` while it does.
#[tauri::command]
pub async fn engine_install(app: AppHandle, lock: State<'_, EngineInstall>) -> CmdResult<()> {
    let _one = lock.0.lock().await;
    let data = app.path().app_data_dir().map_err(err)?;
    // Large file, slow connections: no overall timeout, only a connect one.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("tayang-studio/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(err)?;
    let emitter = app.clone();
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let progress = std::sync::Mutex::new(move |done: u64, total: Option<u64>| {
        let end = total.is_some_and(|t| done >= t);
        if end || last.elapsed() >= std::time::Duration::from_millis(150) {
            last = std::time::Instant::now();
            let _ = emitter.emit(ENGINE_PROGRESS_EVENT, serde_json::json!({ "done": done, "total": total }));
        }
    });
    crate::api_engine::install_engine(&client, &data, |d, t| {
        if let Ok(mut f) = progress.lock() {
            f(d, t)
        }
    })
    .await?;
    Ok(())
}

/// The command and environment that start Your API: the engine with the saved provider and key.
async fn api_agent(app: &AppHandle) -> CmdResult<(Vec<String>, Vec<(String, String)>)> {
    let data = app.path().app_data_dir().map_err(err)?;
    let engine = crate::api_engine::installed_engine(&data).ok_or("Your API isn't set up yet. Open Settings › Agents › Your API")?;
    let state = app.state::<AppState>();
    let provider = state.db.get_settings(&state.home).api_provider.ok_or("Your API isn't set up yet. Open Settings › Agents › Your API")?;
    let key = app.state::<ApiKeys>().get().await?.filter(|k| !k.is_empty()).ok_or("Your API key is missing. Open Settings › Agents › Your API")?;
    // The provider's list today (models come and go); the saved one when it can't be read.
    let mut provider = provider;
    let fresh = crate::api_engine::check(&api_client(std::time::Duration::from_secs(8))?, &provider.base_url, &key).await;
    if fresh.ok {
        provider.models = fresh.models;
    }
    let config_dir = crate::api_engine::engine_config_dir(&data);
    std::fs::create_dir_all(&config_dir).map_err(err)?;
    let data_dir = crate::api_engine::engine_data_dir(&data);
    std::fs::create_dir_all(&data_dir).map_err(err)?;
    let config_file = crate::api_engine::write_config(&crate::api_engine::engine_root(&data), &provider).map_err(err)?;
    let command = vec![engine.to_string_lossy().into_owned(), "acp".into()];
    Ok((command, crate::api_engine::session_env(&config_file, &key, &config_dir, &data_dir)))
}

/// The command that starts `agent_id` on this computer, plus any environment of its own.
async fn agent_launch(app: &AppHandle, agent_id: AgentId) -> CmdResult<(Vec<String>, Vec<(String, String)>)> {
    if agent_id == AgentId::Custom {
        return api_agent(app).await;
    }
    let mut command = system::acp_command(agent_id).ok_or("Pick an agent first")?;
    let program = command[0].clone();
    let found = system::agent_program(&RealExec, agent_id).ok_or_else(|| format!("Can't find {program} on this computer"))?;
    command[0] = found.to_string_lossy().into_owned();
    Ok((command, Vec::new()))
}

/// Your API as a row of the agent list: ready once the engine, the provider and the key are there.
async fn api_agent_info(app: &AppHandle) -> AgentInfo {
    let data = app.path().app_data_dir().ok();
    let engine = data.as_deref().and_then(crate::api_engine::installed_engine).is_some();
    let provider = app.try_state::<AppState>().and_then(|s| s.db.get_settings(&s.home).api_provider);
    let key = match app.try_state::<ApiKeys>() {
        Some(k) => k.get().await.ok().flatten().is_some_and(|k| !k.is_empty()),
        None => false,
    };
    AgentInfo {
        id: AgentId::Custom,
        name: "Your API".into(),
        installed: engine && provider.is_some() && key,
        version: provider.map(|p| p.model),
        acp_command: Vec::new(),
        recommended: false,
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn chat_kind_names_what_the_chat_is_for() {
        assert_eq!(chat_kind("setup", false), "setup");
        assert_eq!(chat_kind("study-atlas", false), "study");
        assert_eq!(chat_kind("autopilot-1", false), "autopilot");
        assert_eq!(chat_kind("abc", true), "project");
        assert_eq!(chat_kind("abc", false), "chat");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn at_most_two_thumbnails_are_made_at_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        assert_eq!(super::THUMB_SLOTS.available_permits(), 2);
        let slots: &'static tokio::sync::Semaphore = Box::leak(Box::new(tokio::sync::Semaphore::new(2)));
        let now = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let jobs = (0..6).map(|i| {
            let (now, most) = (now.clone(), most.clone());
            tokio::spawn(super::in_thumb_slot(slots, move || {
                let n = now.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(n, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(80));
                now.fetch_sub(1, Ordering::SeqCst);
                i
            }))
        });
        let mut done = Vec::new();
        for j in jobs.collect::<Vec<_>>() {
            done.push(j.await.unwrap().unwrap());
        }
        assert_eq!(done, [0, 1, 2, 3, 4, 5]);
        assert_eq!(most.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn locale_is_trimmed_and_blank_is_none() {
        assert_eq!(super::clean_locale(Some(" id-ID ".into())), Some("id-ID".into()));
        assert_eq!(super::clean_locale(Some("  ".into())), None);
        assert_eq!(super::clean_locale(None), None);
        for unknown in ["C", "POSIX", "C.UTF-8", "POSIX.UTF-8", " C "] {
            assert_eq!(super::clean_locale(Some(unknown.into())), None, "{unknown}");
        }
        assert_eq!(super::clean_locale(Some("ca-ES".into())), Some("ca-ES".into()));
        assert_eq!(super::clean_locale(Some("Czech".into())), Some("Czech".into()));
    }

    fn seeded() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.insert_project(&Project {
            id: "p".into(),
            title: "P".into(),
            slug: "p".into(),
            folder: "/w/p".into(),
            kind: VideoKind::Promo,
            format: VideoFormat::Portrait,
            language: VideoLanguage::Id,
            status: ProjectStatus::Rendered,
            style_id: None,
            scheduled_at: None,
            review_state: ReviewState::Pending,
            posted_at: None,
            reminded_at: Some("2026-11-01T00:00:00Z".into()),
            review_reminded_at: None,
            social_post_id: None,
            duration_sec: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        })
        .unwrap();
        db
    }

    fn batch_now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-11-04T10:00:00Z").unwrap().with_timezone(&chrono::Utc)
    }
    fn existing(id: &str, at: &str) -> BatchItem {
        BatchItem { project_id: Some(id.into()), at: at.into(), draft: None }
    }
    fn draft(title: &str, at: &str) -> BatchItem {
        BatchItem {
            project_id: None,
            at: at.into(),
            draft: Some(BatchDraft {
                input: NewProject { title: title.into(), kind: VideoKind::Explainer, format: VideoFormat::Portrait, language: VideoLanguage::Id, style_id: None },
                brief: format!("# {title}\n"),
            }),
        }
    }

    #[test]
    fn schedule_batch_schedules_existing_videos_and_new_drafts() {
        let db = seeded();
        let tmp = tempfile::tempdir().unwrap();
        let out = schedule_batch(
            &db,
            tmp.path(),
            vec![existing("p", "2026-11-05T19:00:00+07:00"), draft("Jalur Rempah", "2026-11-06T12:00:00+07:00")],
            batch_now(),
        )
        .unwrap();
        assert_eq!(out[0].scheduled_at.as_deref(), Some("2026-11-05T12:00:00Z"));
        assert_eq!(out[0].reminded_at, None);
        assert_eq!(out[1].title, "Jalur Rempah");
        assert_eq!(out[1].scheduled_at.as_deref(), Some("2026-11-06T05:00:00Z"));
        assert!(Path::new(&out[1].folder).join("AGENTS.md").exists());
        assert_eq!(db.list_projects().unwrap().len(), 2);
    }

    #[test]
    fn schedule_batch_checks_everything_before_writing_anything() {
        let db = seeded();
        let tmp = tempfile::tempdir().unwrap();
        let ok = "2026-11-05T19:00:00+07:00";
        for (items, code) in [
            (vec![], "schedule:count"),
            (vec![existing("p", ok), draft("A", ok), draft("B", "2026-11-31T19:00:00+07:00")], "schedule:badTime:3"),
            (vec![draft("A", "2026-02-30T10:00:00+07:00")], "schedule:badTime:1"),
            (vec![draft("A", "2026-11-05T24:00:00+07:00")], "schedule:badTime:1"),
            (vec![draft("A", ok), draft("B", "2026-11-03T19:00:00+07:00")], "schedule:past:2"),
            (vec![draft("A", "2027-11-06T19:00:00+07:00")], "schedule:tooFar:1"),
            (vec![existing("nope", ok)], "schedule:unknown:1"),
            (vec![draft("  ", ok)], "schedule:badItem:1"),
            (vec![existing("p", ok), draft("A", ok), existing("p", "2026-11-06T19:00:00+07:00")], "schedule:twice:3"),
            (vec![BatchItem { project_id: None, at: ok.into(), draft: None }], "schedule:badItem:1"),
        ] {
            assert_eq!(schedule_batch(&db, tmp.path(), items, batch_now()).unwrap_err(), code);
        }
        let too_many = (0..21).map(|i| draft(&format!("T{i}"), ok)).collect();
        assert_eq!(schedule_batch(&db, tmp.path(), too_many, batch_now()).unwrap_err(), "schedule:count");
        // Nothing was written: no drafts, no folders, the video keeps its reminder.
        assert_eq!(db.list_projects().unwrap().len(), 1);
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
        assert!(db.get_project("p").unwrap().unwrap().reminded_at.is_some());
    }

    #[test]
    fn schedule_batch_undoes_everything_when_a_write_fails_part_way() {
        let db = seeded();
        db.update_project("p", serde_json::json!({ "scheduledAt": "2026-11-20T02:00:00Z" })).unwrap();
        let before = db.get_project("p").unwrap().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let calls = std::cell::Cell::new(0);
        let err = schedule_batch_with(
            &db,
            tmp.path(),
            vec![
                existing("p", "2026-11-05T19:00:00+07:00"),
                draft("A", "2026-11-06T19:00:00+07:00"),
                draft("B", "2026-11-07T19:00:00+07:00"),
            ],
            batch_now(),
            |db, id, at| {
                calls.set(calls.get() + 1);
                if calls.get() == 3 {
                    return Err("disk full".into());
                }
                schedule_project(db, id, Some(at))
            },
        )
        .unwrap_err();
        assert_eq!(err, "schedule:write");
        // The drafts are gone, row and folder; the moved video has its old schedule and reminder back.
        assert_eq!(db.list_projects().unwrap().len(), 1);
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
        let after = db.get_project("p").unwrap().unwrap();
        assert_eq!(after.scheduled_at, before.scheduled_at);
        assert_eq!(after.reminded_at, before.reminded_at);
    }

    #[test]
    fn a_draft_whose_brief_cant_be_written_leaves_no_folder() {
        let db = seeded();
        let tmp = tempfile::tempdir().unwrap();
        let input = NewProject { title: "Jalur Rempah".into(), kind: VideoKind::Explainer, format: VideoFormat::Portrait, language: VideoLanguage::Id, style_id: None };
        let err = new_project_with(&db, tmp.path(), input, |_| Err(std::io::Error::other("disk full"))).unwrap_err();
        assert!(err.contains("brief"), "{err}");
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
        assert_eq!(db.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn set_schedule_validates_sets_clears_and_resets_the_reminder() {
        let db = seeded();
        assert!(schedule_project(&db, "p", Some("tomorrow".into())).is_err());
        assert!(schedule_project(&db, "p", Some("2026-11-05 09:00".into())).is_err());
        assert!(schedule_project(&db, "nope", Some("2026-11-05T09:00:00+07:00".into())).is_err());
        assert!(schedule_project(&db, "nope", None).is_err());
        let p = schedule_project(&db, "p", Some("2026-11-05T09:00:00+07:00".into())).unwrap();
        assert_eq!(p.scheduled_at.as_deref(), Some("2026-11-05T02:00:00Z"));
        assert_eq!(p.reminded_at, None);
        db.update_project("p", serde_json::json!({ "remindedAt": "2026-11-05T01:00:00Z", "reviewRemindedAt": "2026-11-05T00:00:00Z" })).unwrap();
        let p = schedule_project(&db, "p", None).unwrap();
        assert_eq!(p.scheduled_at, None);
        assert_eq!(p.reminded_at, None);
        assert_eq!(p.review_reminded_at, None);
        assert_eq!(db.get_project("p").unwrap().unwrap().scheduled_at, None);
    }

    #[test]
    fn set_posted_stamps_and_clears_and_approve_approves() {
        let db = seeded();
        let p = mark_posted(&db, "p", true).unwrap();
        assert!(p.posted_at.is_some());
        assert_eq!(mark_posted(&db, "p", false).unwrap().posted_at, None);
        assert!(mark_posted(&db, "nope", true).is_err());
        assert_eq!(approve(&db, "p").unwrap().review_state, ReviewState::Approved);
        assert_eq!(db.get_project("p").unwrap().unwrap().review_state, ReviewState::Approved);
        assert!(approve(&db, "nope").is_err());
    }

    #[test]
    fn system_locale_never_panics_and_is_none_or_text() {
        assert!(super::system_locale().is_none_or(|l| !l.is_empty()));
    }

    use super::*;

    #[test]
    fn a_title_goes_to_the_platforms_that_show_one() {
        assert_eq!(title_configurations(None), None);
        assert_eq!(title_configurations(Some("  ")), None);
        let c = title_configurations(Some(" Lampu lalu lintas ")).unwrap();
        assert_eq!(c["youtube"]["title"], "Lampu lalu lintas");
        assert_eq!(c["tiktok"]["title"], "Lampu lalu lintas");
        let long = "x".repeat(150);
        assert_eq!(title_configurations(Some(&long)).unwrap()["youtube"]["title"].as_str().unwrap().len(), 100);
    }

    #[test]
    fn recent_images_looks_only_in_a_video_chats_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState {
            db: seeded(),
            acp: AcpManager::new(),
            media: MediaTools::from_env_or_path(),
            home: tmp.path().to_path_buf(),
            study_working: Default::default(),
        };
        let since = "2026-11-04T10:00:00+07:00";
        let video = state.db.create_chat(Some("p"), AgentId::Claude, "Video").unwrap();
        let loose = state.db.create_chat(None, AgentId::Claude, "Loose").unwrap();
        let (folder, at) = images_lookup(&state, &video.id, since).unwrap().unwrap();
        assert_eq!(folder, PathBuf::from("/w/p"));
        assert_eq!(at.to_rfc3339(), "2026-11-04T03:00:00+00:00");
        // No project, an unknown chat, or a project that was deleted: nothing to look in.
        assert!(images_lookup(&state, &loose.id, since).unwrap().is_none());
        assert!(images_lookup(&state, "nope", since).unwrap().is_none());
        state.db.delete_project("p").unwrap();
        assert!(images_lookup(&state, &video.id, since).unwrap().is_none());
        assert!(images_lookup(&state, &loose.id, "yesterday").is_err());
    }

    #[test]
    fn a_study_keeps_the_working_folder_it_started_in() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join("old"), tmp.path().join("new"));
        let db = Db::open_in_memory().unwrap();
        db.update_settings(serde_json::json!({ "workingFolder": old.to_string_lossy() })).unwrap();
        let state = AppState {
            db,
            acp: AcpManager::new(),
            media: MediaTools::from_env_or_path(),
            home: tmp.path().to_path_buf(),
            study_working: Default::default(),
        };
        let dir = study_path(&state.working(), "s1").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        state.study_working.lock().unwrap().insert("s1".into(), state.working());
        state.db.update_settings(serde_json::json!({ "workingFolder": new.to_string_lossy() })).unwrap();
        assert_eq!(state.working(), new);
        assert_eq!(state.working_for_study("s1"), old);
        assert_eq!(state.working_for_study("other"), new);
        media::remove_study_dir(&state.working_for_study("s1"), "s1").unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn session_options_for_claude_load_the_plugin() {
        let plugin = PathBuf::from("/res/agent-plugin");
        let o = session_options(AgentId::Claude, Some(&plugin), true);
        assert_eq!(o.env, vec![("TAYANG_STUDIO".to_string(), "1".to_string())]);
        let meta = o.meta.unwrap();
        let path = meta["claudeCode"]["options"]["plugins"][0]["path"].as_str().unwrap();
        assert_eq!(PathBuf::from(path), plugin);
        assert_eq!(meta["claudeCode"]["options"]["plugins"][0]["type"], "local");
        assert_eq!(meta["systemPrompt"]["append"], TAYANG_APPEND);
    }

    #[test]
    fn session_options_for_other_agents_only_set_env() {
        for id in [AgentId::Opencode, AgentId::Codex, AgentId::Gemini] {
            let o = session_options(id, Some(Path::new("/x")), true);
            assert!(o.meta.is_none());
            assert_eq!(o.env, vec![("TAYANG_STUDIO".to_string(), "1".to_string())]);
        }
    }

    #[test]
    fn the_users_skills_load_as_a_second_plugin() {
        let mut o = session_options(AgentId::Claude, Some(Path::new("/res/agent-plugin")), true);
        add_plugin(&mut o, Path::new("/data/user-skills"));
        let plugins = &o.meta.unwrap()["claudeCode"]["options"]["plugins"];
        assert_eq!(plugins[1]["path"], "/data/user-skills");
        assert_eq!(plugins[1]["type"], "local");

        let mut alone = session_options(AgentId::Claude, None, true);
        add_plugin(&mut alone, Path::new("/data/user-skills"));
        assert_eq!(alone.meta.unwrap()["claudeCode"]["options"]["plugins"][0]["path"], "/data/user-skills");

        let mut internal = session_options(AgentId::Claude, None, false);
        add_plugin(&mut internal, Path::new("/data/user-skills"));
        assert!(internal.meta.is_none());
    }

    #[test]
    fn claude_without_a_plugin_folder_still_gets_the_append() {
        let o = session_options(AgentId::Claude, None, true);
        let meta = o.meta.unwrap();
        assert!(meta["claudeCode"].is_null());
        assert_eq!(meta["systemPrompt"]["append"], TAYANG_APPEND);
    }

    #[test]
    fn plugin_dir_is_the_repo_copy_in_debug_builds_else_the_bundled_one() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("agent-plugin").join(".claude-plugin");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("plugin.json"), "{}").unwrap();
        let expected = if cfg!(debug_assertions) { dev_plugin_dir() } else { Some(tmp.path().join("agent-plugin")) };
        assert_eq!(plugin_dir(Some(tmp.path())), expected);
    }

    #[test]
    fn the_system_prompt_asks_with_the_question_tool_not_a2ui() {
        assert!(TAYANG_APPEND.contains("AskUserQuestion"));
        assert!(!TAYANG_APPEND.to_lowercase().contains("a2ui"));
    }

    #[test]
    fn dev_plugin_folder_exists_in_the_repo() {
        // Only debug builds look in the repo; a release build must use its bundled copy.
        assert_eq!(dev_plugin_dir().is_some(), cfg!(debug_assertions));
    }

    #[test]
    fn internal_sessions_get_no_meta() {
        assert!(!wants_skills("setup"));
        assert!(!wants_skills("study-abc"));
        assert!(!wants_skills("autopilot-a1"));
        assert!(wants_skills("ideas-2026-11-04"));
        assert!(wants_skills("c1"));
    }

    #[test]
    fn auto_mode_rules() {
        assert!(wants_auto("study-abc", false));
        assert!(wants_auto("autopilot-a1", false));
        assert!(!wants_auto("setup", true));
        assert!(wants_auto("c1", true));
        assert!(!wants_auto("c1", false));
    }

    #[test]
    fn internal_sessions_get_no_meta_options() {
        let o = session_options(AgentId::Claude, Some(Path::new("/p")), false);
        assert!(o.meta.is_none());
        assert_eq!(o.env, vec![("TAYANG_STUDIO".to_string(), "1".to_string())]);
    }

    #[test]
    fn claude_without_the_plugin_gets_the_skills_as_text() {
        assert!(needs_skills_text(AgentId::Claude, None));
        assert!(!needs_skills_text(AgentId::Claude, Some(Path::new("/p"))));
        // Other agents get them as text anyway; the app decides that itself.
        assert!(!needs_skills_text(AgentId::Codex, None));
    }

    #[test]
    fn timecode_matches_ts() {
        assert_eq!(format_timecode(0.0, 30), "0:00.00");
        assert_eq!(format_timecode(65.5, 30), "1:05.50");
        assert_eq!(format_timecode(1.999, 30), "0:01.96");
    }

    #[test]
    fn cwd_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let w = tmp.path();
        let setup = resolve_cwd(w, "setup", None).unwrap();
        assert!(setup.ends_with(".tayang/setup") || setup.ends_with(r".tayang\setup"));
        assert!(setup.is_dir());
        let topics = resolve_cwd(w, "autopilot-a1", None).unwrap();
        assert_eq!(topics, w.join(".tayang").join("chats").join("autopilot-a1"));
        let study = resolve_cwd(w, "study-abc", None).unwrap();
        assert_eq!(study, w.join(".tayang").join("style-study").join("abc"));
        let chat = resolve_cwd(w, "c1", None).unwrap();
        assert_eq!(chat, w.join(".tayang").join("chats").join("c1"));
        let proj = w.join("my-video");
        std::fs::create_dir(&proj).unwrap();
        assert_eq!(resolve_cwd(w, "c2", Some(&proj)).unwrap(), proj);
    }

    #[test]
    fn project_chats_keep_their_folder_after_the_working_folder_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let old_project = tmp.path().join("old-work").join("promo");
        std::fs::create_dir_all(&old_project).unwrap();
        let new_working = tmp.path().join("new-work");
        assert_eq!(resolve_cwd(&new_working, "c", Some(&old_project)).unwrap(), old_project);
        // A project folder that is gone is an error, not silently recreated.
        let gone = tmp.path().join("gone");
        assert!(resolve_cwd(&new_working, "c", Some(&gone)).is_err());
        assert!(!gone.exists());
    }

    #[test]
    fn cwd_rejects_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let w = tmp.path().join("work");
        let outside = tmp.path().join("elsewhere");
        std::fs::create_dir(&outside).unwrap();
        assert!(resolve_cwd(&w, "../x", None).is_err());
        assert!(resolve_cwd(&w, "study-../x", None).is_err());
        assert!(resolve_cwd(&w, "ideas-../x", None).is_err());
        let _ = outside;
    }

    #[test]
    fn frame_images_must_be_inside_working() {
        let tmp = tempfile::tempdir().unwrap();
        let w = tmp.path().join("work");
        std::fs::create_dir_all(&w).unwrap();
        let frame = |p: PathBuf| MessagePart::Frame {
            project_id: "p".into(),
            frame: 1,
            time_sec: 0.0,
            image_path: p.to_string_lossy().into_owned(),
            marks: vec![],
        };
        let none = |_: &str| None;
        assert!(check_frame_images(&w, &[frame(w.join("a/f.png"))], none).is_ok());
        assert!(check_frame_images(&w, &[frame(tmp.path().join("secret.png"))], none).is_err());
        assert!(check_frame_images(&w, &[frame(w.join("../secret.png"))], none).is_err());

        // A project left in an old working folder: its own frames are fine, others aren't.
        let old = tmp.path().join("old").join("p");
        std::fs::create_dir_all(&old).unwrap();
        let known = |id: &str| (id == "p").then(|| old.clone());
        let in_old = frame(old.join(".tayang/frames/f.png"));
        assert!(check_frame_images(&w, std::slice::from_ref(&in_old), known).is_ok());
        assert!(check_frame_images(&w, &[in_old], none).is_err());
        assert!(check_frame_images(&w, &[frame(old.join("../secret.png"))], known).is_err());
    }

    #[test]
    fn asset_folders_are_working_plus_existing_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open_in_memory().unwrap();
        let kept = tmp.path().join("old").join("kept");
        std::fs::create_dir_all(&kept).unwrap();
        let mk = |id: &str, folder: &Path| Project {
            id: id.into(),
            title: id.into(),
            slug: id.into(),
            folder: folder.to_string_lossy().into_owned(),
            kind: VideoKind::Promo,
            format: VideoFormat::Portrait,
            language: VideoLanguage::En,
            status: ProjectStatus::Draft,
            style_id: None,
            scheduled_at: None,
            review_state: ReviewState::None,
            posted_at: None,
            reminded_at: None,
            review_reminded_at: None,
            social_post_id: None,
            duration_sec: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        db.insert_project(&mk("a", &kept)).unwrap();
        db.insert_project(&mk("b", &tmp.path().join("missing"))).unwrap();
        let working = tmp.path().join("work");
        assert_eq!(
            asset_folders(&db, &working.to_string_lossy()),
            vec![working.clone(), kept]
        );
    }

    #[test]
    fn lookup_chat_finds_project_chats() {
        let db = Db::open_in_memory().unwrap();
        let chat = db.create_chat(Some("p1"), AgentId::Gemini, "Intro").unwrap();
        let loose = db.create_chat(None, AgentId::Claude, "Loose").unwrap();
        // The unfiltered list only has chats without a project, so lookups must go by id.
        assert!(!db.list_chats(None).unwrap().contains(&chat));
        assert_eq!(lookup_chat(&db, &chat.id).unwrap(), Some(chat));
        assert_eq!(lookup_chat(&db, &loose.id).unwrap(), Some(loose));
        assert_eq!(lookup_chat(&db, "missing").unwrap(), None);
    }

    #[test]
    fn brief_is_read_and_cut_at_8_kb() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_brief(tmp.path()), None);
        std::fs::write(tmp.path().join("AGENTS.md"), "# Hi\n").unwrap();
        assert_eq!(read_brief(tmp.path()).as_deref(), Some("# Hi\n"));
        // 3-byte characters straddle the limit: the cut stays on a boundary.
        let long = "é€".repeat(3000);
        std::fs::write(tmp.path().join("AGENTS.md"), &long).unwrap();
        let cut = read_brief(tmp.path()).unwrap();
        let body = cut.strip_suffix("\n[AGENTS.md cut at 8 KB]").unwrap();
        assert!(body.len() <= BRIEF_LIMIT && body.len() > BRIEF_LIMIT - 4);
        assert!(long.starts_with(body));
    }

    #[test]
    fn a2ui_action_becomes_summary_and_fenced_json() {
        let parts = vec![
            MessagePart::A2ui { surface_id: "s1".into(), messages: vec![serde_json::json!({"version":"v0.9"})] },
            MessagePart::A2uiAction {
                summary: "Picked: Kenapa rupiah melemah?".into(),
                action: serde_json::json!({"version":"v0.9","action":{"name":"pick"}}),
            },
        ];
        assert_eq!(
            build_prompt(&parts, 30, |_| None, |_| None),
            vec![PromptPart::Text(
                "Picked: Kenapa rupiah melemah?\n\n```a2ui-action\n{\"action\":{\"name\":\"pick\"},\"version\":\"v0.9\"}\n```".into()
            )]
        );
    }

    #[test]
    fn style_mention_adds_nothing_of_its_own() {
        // The app sends the style's prompt and notes in front of the message itself.
        let parts = vec![
            MessagePart::StyleMention { style_id: "s1".into(), name: "Atlas".into() },
            MessagePart::Text { text: "pakai ini".into() },
        ];
        assert_eq!(build_prompt(&parts, 30, |_| None, |_| None), vec![PromptPart::Text("pakai ini".into())]);
    }

    #[test]
    fn missing_mention_has_no_empty_folder() {
        let parts = vec![MessagePart::Mention { project_id: "x".into(), title: "Gone".into() }];
        assert_eq!(
            build_prompt(&parts, 30, |_| None, |_| None),
            vec![PromptPart::Text(
                "Context: video project \"Gone\" (no longer on this computer).".into()
            )]
        );
    }

    #[test]
    fn prompt_conversion() {
        let project = Project {
            id: "p1".into(),
            title: "Launch".into(),
            slug: "launch".into(),
            folder: "/w/launch".into(),
            kind: VideoKind::Promo,
            format: VideoFormat::Portrait,
            language: VideoLanguage::En,
            status: ProjectStatus::Draft,
            style_id: None,
            scheduled_at: None,
            review_state: ReviewState::None,
            posted_at: None,
            reminded_at: None,
            review_reminded_at: None,
            social_post_id: None,
            duration_sec: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let parts = vec![
            MessagePart::Text { text: "hi".into() },
            MessagePart::Mention { project_id: "p1".into(), title: "old".into() },
            MessagePart::Frame {
                project_id: "p1".into(),
                frame: 45,
                time_sec: 1.5,
                image_path: "/w/f.png".into(),
                marks: vec![Mark { x: 0.5, y: 0.25 }],
            },
            MessagePart::Tool {
                tool_call_id: "t".into(),
                title: "x".into(),
                status: ToolCallStatus::Done,
                tool_kind: None,
                path: None,
            },
            MessagePart::Thought { text: "hmm".into() },
        ];
        let out = build_prompt(
            &parts,
            30,
            |id| (id == "p1").then(|| project.clone()),
            |f| (f == Path::new("/w/launch")).then(|| "# Launch\n- Kind: promo\n".to_string()),
        );
        assert_eq!(
            out,
            vec![
                PromptPart::Text("hi".into()),
                PromptPart::Text(
                    "Context: video project \"Launch\". Its Tayang id is p1. Its files are in /w/launch.\nIts AGENTS.md:\n\n# Launch\n- Kind: promo"
                        .into()
                ),
                PromptPart::Image { path: PathBuf::from("/w/f.png") },
                PromptPart::Text(
                    "Frame 45 at 0:01.50 of Launch. Marks (x,y relative): (0.50, 0.25)".into()
                ),
            ]
        );
    }

    #[test]
    fn attach_copies_into_attachments_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let src = tmp.path().join("notes.pdf");
        std::fs::write(&src, b"hello").unwrap();
        let part = copy_attachment(&cwd, &src, MAX_ATTACHMENT).unwrap();
        let dest = cwd.join("attachments").join("notes.pdf");
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
        assert_eq!(
            part,
            MessagePart::File {
                path: dest.to_string_lossy().into_owned(),
                name: "notes.pdf".into(),
                mime: "application/pdf".into(),
                size: 5,
                modified_at: None,
            }
        );
    }

    #[test]
    fn attach_names_collisions_uniquely() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let src = tmp.path().join("a.png");
        std::fs::write(&src, b"1").unwrap();
        copy_attachment(&cwd, &src, MAX_ATTACHMENT).unwrap();
        std::fs::write(&src, b"22").unwrap();
        let MessagePart::File { name, path, mime, .. } =
            copy_attachment(&cwd, &src, MAX_ATTACHMENT).unwrap()
        else {
            panic!("not a file part")
        };
        assert_eq!(name, "a-2.png");
        assert_eq!(mime, "image/png");
        assert_eq!(std::fs::read(path).unwrap(), b"22");
        assert_eq!(std::fs::read(cwd.join("attachments").join("a.png")).unwrap(), b"1");
    }

    #[test]
    fn attach_rejects_big_files_and_non_files() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let src = tmp.path().join("big.bin");
        std::fs::write(&src, vec![0u8; 11]).unwrap();
        let e = copy_attachment(&cwd, &src, 10).unwrap_err();
        assert_eq!(e, "That file is larger than 50 MB");
        assert!(copy_attachment(&cwd, tmp.path(), 10).is_err());
        assert!(copy_attachment(&cwd, &tmp.path().join("missing"), 10).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn attach_rejects_a_destination_outside_the_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("cwd");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, cwd.join("attachments")).unwrap();
        let src = tmp.path().join("a.txt");
        std::fs::write(&src, b"x").unwrap();
        assert!(copy_attachment(&cwd, &src, MAX_ATTACHMENT).is_err());
        assert!(!outside.join("a.txt").exists());
    }

    #[test]
    fn file_parts_become_images_or_text() {
        let parts = vec![
            MessagePart::File {
                path: "/w/c/attachments/shot.PNG".into(),
                name: "shot.PNG".into(),
                mime: "image/png".into(),
                size: 10,
                modified_at: None,
            },
            MessagePart::File {
                path: "/w/c/attachments/brief.pdf".into(),
                name: "brief.pdf".into(),
                mime: "application/pdf".into(),
                size: 2048,
                modified_at: None,
            },
        ];
        assert_eq!(
            build_prompt(&parts, 30, |_| None, |_| None),
            vec![
                PromptPart::Image { path: PathBuf::from("/w/c/attachments/shot.PNG") },
                PromptPart::Text("Attached image: attachments/shot.PNG (shot.PNG, 10 B)".into()),
                PromptPart::Text(
                    "Attached file: attachments/brief.pdf (brief.pdf, 2.0 KB)".into()
                ),
            ]
        );
    }

    #[test]
    fn gifs_and_big_images_are_sent_as_file_lines() {
        let file = |name: &str, size: u64| MessagePart::File {
            path: format!("/w/c/attachments/{name}"),
            name: name.into(),
            mime: mime_for(name).into(),
            size,
            modified_at: None,
        };
        let parts = vec![
            file("loop.gif", 10),
            file("big.jpg", MAX_IMAGE_BLOCK + 1),
            file("edge.webp", MAX_IMAGE_BLOCK),
        ];
        let out = build_prompt(&parts, 30, |_| None, |_| None);
        assert_eq!(out[0], PromptPart::Text("Attached file: attachments/loop.gif (loop.gif, 10 B)".into()));
        assert_eq!(out[1], PromptPart::Text("Attached file: attachments/big.jpg (big.jpg, 5.0 MB)".into()));
        assert_eq!(out[2], PromptPart::Image { path: PathBuf::from("/w/c/attachments/edge.webp") });
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn file_parts_must_be_inside_the_chat_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let file = |p: PathBuf| MessagePart::File {
            path: p.to_string_lossy().into_owned(),
            name: "x".into(),
            mime: "text/plain".into(),
            size: 1,
            modified_at: None,
        };
        assert!(check_file_parts(&cwd, &[file(cwd.join("attachments").join("x"))]).is_ok());
        assert!(check_file_parts(&cwd, &[file(tmp.path().join("secret"))]).is_err());
    }
}

// ---- chat trace ----

/// A chat's turns, model calls and tool calls with their timings and tokens. Claude Code's session
/// files hold them; a chat with another agent has no trace.
#[tauri::command]
pub async fn get_chat_trace(app: AppHandle, state: State<'_, AppState>, chat_id: String) -> CmdResult<crate::trace::ChatTrace> {
    let Some(chat) = lookup_chat(&state.db, &chat_id)? else { return Ok(Default::default()) };
    if chat.agent_id != AgentId::Claude {
        return Ok(Default::default());
    }
    let project = chat.project_id.as_deref().map(|id| state.db.get_project(id)).transpose().map_err(err)?.flatten();
    let folder = project.as_ref().map(|p| PathBuf::from(&p.folder));
    let cwd = resolve_cwd(&state.working(), &chat_id, folder.as_deref())?;
    let tool_ids: std::collections::HashSet<String> = state
        .db
        .list_messages(&chat_id)
        .map_err(err)?
        .into_iter()
        .flat_map(|m| m.parts)
        .filter_map(|p| match p {
            MessagePart::Tool { tool_call_id, .. } => Some(tool_call_id),
            _ => None,
        })
        .collect();
    // A project's folder can hold other chats' sessions, so only its tool calls can tell them apart.
    if folder.is_some() && tool_ids.is_empty() {
        return Ok(crate::trace::ChatTrace { supported: true, ..Default::default() });
    }
    // Tayang's own Claude folder, then `~/.claude` for chats from before Tayang had one.
    let configs = vec![claude_config_dir(&app)?, state.home.join(".claude")];
    tauri::async_runtime::spawn_blocking(move || crate::trace::chat_trace(&configs, &cwd, &tool_ids)).await.map_err(err)
}

// ---- agent usage ----

#[tauri::command]
pub async fn get_agent_usage(
    app: AppHandle,
    state: State<'_, AppState>,
    cache: State<'_, crate::usage::UsageCache>,
    force: bool,
) -> CmdResult<Vec<AgentUsage>> {
    if !force {
        if let Some((at, v)) = cache.0.lock().map_err(err)?.as_ref() {
            if at.elapsed() < crate::usage::CACHE_TTL {
                return Ok(v.clone());
            }
        }
    }
    let claude = claude_config_dir(&app)?;
    let (agents, token) = tauri::async_runtime::spawn_blocking(move || {
        let agents = system::detect_agents(&RealExec);
        let token = if agents.iter().any(|a| a.installed && a.id == AgentId::Claude) {
            crate::usage::read_claude_token(&RealExec, &claude)
        } else {
            None
        };
        (agents, token)
    })
    .await
    .map_err(err)?;
    let now = chrono::Utc::now();
    let mut out = Vec::new();
    for a in agents.iter().filter(|a| a.installed) {
        if a.id == AgentId::Opencode {
            let db = crate::usage::opencode_db(&state.home, std::env::var("XDG_DATA_HOME").ok().as_deref());
            let usage = tauri::async_runtime::spawn_blocking(move || crate::usage::opencode_usage(&db, now)).await.map_err(err)?;
            out.push(usage);
            continue;
        }
        if a.id != AgentId::Claude {
            out.push(crate::usage::unavailable(a.id, &a.name, now));
            continue;
        }
        let usage = match &token {
            None => crate::usage::usage_from_response(401, "", now),
            Some(t) => match crate::usage::fetch_claude_usage(t).await {
                Ok(u) => u,
                Err(m) => {
                    let mut u = crate::usage::usage_from_response(0, "", now);
                    u.message = Some(m);
                    u
                }
            },
        };
        out.push(usage);
    }
    // Failures aren't cached, so the next poll retries.
    if out.iter().all(|u| u.status != UsageStatus::Error) {
        *cache.0.lock().map_err(err)? = Some((std::time::Instant::now(), out.clone()));
    }
    Ok(out)
}
