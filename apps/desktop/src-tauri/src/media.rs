//! ffmpeg/ffprobe helpers: probing, frame extraction, thumbnails, HyperFrames rendering.
//! Every process is spawned with an args array (never a shell string), so paths
//! containing spaces or quotes are safe.

use crate::types::{FileInfo, MediaInfo};
use std::path::{Path, PathBuf};
use std::process::Command;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone)]
pub struct MediaTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl MediaTools {
    /// Uses `FFMPEG_PATH` / `FFPROBE_PATH` when set, else resolves `ffmpeg` / `ffprobe`
    /// (falling back to the bare names).
    pub fn from_env_or_path() -> Self {
        let pick = |var: &str, default: &str| {
            std::env::var_os(var)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .or_else(|| crate::system::Exec::which(&crate::system::RealExec, default))
                .unwrap_or_else(|| PathBuf::from(default))
        };
        Self { ffmpeg: pick("FFMPEG_PATH", "ffmpeg"), ffprobe: pick("FFPROBE_PATH", "ffprobe") }
    }
}

/// Builds a command that never flashes a console window on Windows.
#[allow(unused_mut)]
fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", crate::system::augmented_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Like `run`, but kills the process and fails when it runs longer than `limit`.
fn run_within(mut cmd: Command, what: &str, limit: std::time::Duration) -> Result<std::process::Output> {
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {what}: {e}"))?;
    // Drain the pipes on threads so a chatty process can't block on a full pipe.
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut v);
        }
        v
    });
    let err_t = std::thread::spawn(move || {
        let mut v = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut v);
        }
        v
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if started.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_t.join();
                let _ = err_t.join();
                return Err(format!("{what} timed out"));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(e) => return Err(format!("could not run {what}: {e}")),
        }
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    if status.success() {
        Ok(std::process::Output { status, stdout, stderr })
    } else {
        Err(format!("{what} failed: {}", clean_output(&String::from_utf8_lossy(&stderr))))
    }
}

/// The error a render gives when the project has nothing to render: no `tayang.json` and no HyperFrames
/// `index.html` (the agent hasn't built the video yet). The UI recognizes it.
pub const NOTHING_TO_RENDER: &str = "nothing to render yet";

/// Lines a tool prints that never explain a failure: npm's own notices and HyperFrames' telemetry notice.
const NOISE: [&str; 5] = [
    "npm notice",
    "Hyperframes collects usage data",
    "File paths and composition content are never collected",
    "If you sign in to HeyGen",
    "Disable anytime: hyperframes telemetry disable",
];

/// A tool's output as the user should read it: no colour codes, no noise lines, no runs of blank lines.
pub fn clean_output(raw: &str) -> String {
    let mut plain = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ params final-letter.
            if chars.peek() == Some(&'[') {
                chars.next();
                for x in chars.by_ref() {
                    if x.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c != '\r' {
            plain.push(c);
        }
    }
    let mut lines: Vec<&str> = Vec::new();
    for line in plain.lines() {
        let t = line.trim();
        if NOISE.iter().any(|n| t.starts_with(n)) {
            continue;
        }
        if t.is_empty() && lines.last().is_none_or(|l| l.trim().is_empty()) {
            continue;
        }
        lines.push(line.trim_end());
    }
    lines.join("\n").trim().to_string()
}

/// The last lines of what a finished render printed, to say where its video may have gone.
fn output_tail(out: &std::process::Output) -> String {
    let all = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let clean = clean_output(&all);
    let lines: Vec<&str> = clean.lines().collect();
    lines[lines.len().saturating_sub(12)..].join("\n")
}

fn no_mp4(out: &std::process::Output) -> String {
    match output_tail(out) {
        t if t.is_empty() => "render finished but no mp4 was found".to_string(),
        t => format!("render finished but no mp4 was found. The render printed:\n{t}"),
    }
}

/// Remotion stopped because it has no browser to render frames with (its download never happened).
fn is_no_browser(error: &str) -> bool {
    error.contains("No browser found for rendering frames")
}

/// A `remotion` command run through a package runner (`npx remotion render ...`).
fn is_remotion(argv: &[String]) -> bool {
    argv.iter().take(3).any(|a| a == "remotion" || a.starts_with("@remotion/cli"))
}

/// The same runner's `remotion browser ensure`, which downloads Remotion's browser.
fn browser_ensure(argv: &[String]) -> Vec<String> {
    let at = argv.iter().position(|a| a == "remotion" || a.starts_with("@remotion/cli")).unwrap_or(0);
    let mut v = argv[..=at].to_vec();
    v.extend(["browser".to_string(), "ensure".to_string()]);
    v
}

/// The render command using the computer's Google Chrome, unless it already names a browser.
fn with_chrome(argv: &[String], chrome: &Path) -> Vec<String> {
    if argv.iter().any(|a| a.starts_with("--browser-executable")) {
        return argv.to_vec();
    }
    let mut v = argv.to_vec();
    v.push(format!("--browser-executable={}", chrome.display()));
    // Chrome itself only has the new headless mode, which Remotion calls chrome-for-testing.
    v.push("--chrome-mode=chrome-for-testing".into());
    v
}

fn run(mut cmd: Command, what: &str) -> Result<std::process::Output> {
    let out = cmd.output().map_err(|e| format!("could not run {what}: {e}"))?;
    if out.status.success() {
        Ok(out)
    } else {
        Err(format!("{what} failed: {}", clean_output(&String::from_utf8_lossy(&out.stderr))))
    }
}

/// A real folder: not a symlink, not a dot folder, not dependencies or git.
fn plain_dir(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    !name.starts_with('.')
        && !SKIP_DIRS.contains(&name.as_str())
        && std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

/// Where a render lands, in this order: `renders/`, the project root, `out/`, then each `runs/<run>/out/`
/// and `runs/<run>/<version>/out/` (a template pipeline's, also with one folder per version). Symlinks, dot folders, `node_modules` and `.git` are never looked in.
fn render_dirs(folder: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![folder.join("renders"), folder.to_path_buf(), folder.join("out")];
    dirs.retain(|d| d == folder || plain_dir(d));
    let runs = folder.join("runs");
    if plain_dir(&runs) {
        if let Ok(entries) = std::fs::read_dir(&runs) {
            let mut outs: Vec<PathBuf> = Vec::new();
            for run in entries.flatten().map(|e| e.path()).filter(|run| plain_dir(run)) {
                outs.push(run.join("out"));
                if let Ok(versions) = std::fs::read_dir(&run) {
                    outs.extend(versions.flatten().map(|e| e.path()).filter(|v| plain_dir(v)).map(|v| v.join("out")));
                }
            }
            outs.retain(|out| plain_dir(out));
            outs.sort();
            dirs.extend(outs);
        }
    }
    dirs
}

/// The `*.mp4` files directly in the render folders (see `render_dirs`), inside `folder`, newest first; on
/// the same time the earlier folder comes first. Empty files only with `empty`: a render that just started.
fn render_candidates(folder: &Path, empty: bool) -> Vec<(PathBuf, std::fs::Metadata)> {
    let mut found: Vec<(std::time::SystemTime, PathBuf, std::fs::Metadata)> = Vec::new();
    for dir in render_dirs(folder) {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            // `symlink_metadata` describes the link itself: a link is never followed.
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if !meta.is_file() || !path.extension().is_some_and(|x| x.eq_ignore_ascii_case("mp4")) {
                continue;
            }
            // An empty file is a render that never got written (killed halfway): not a video.
            if meta.len() == 0 && !empty {
                continue;
            }
            let Ok(m) = meta.modified() else { continue };
            if crate::projects::ensure_inside(folder, &path) {
                found.push((m, path, meta));
            }
        }
    }
    // A stable sort: the folder order decides between equal times.
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    found.into_iter().map(|(_, p, meta)| (p, meta)).collect()
}

fn newest_render(folder: &Path, empty: bool) -> Option<(PathBuf, std::fs::Metadata)> {
    render_candidates(folder, empty).into_iter().next()
}

/// The project's newest non-empty render: `renders/`, the root, `out/` or a pipeline's `runs/<run>/out/`.
pub fn latest_render(folder: &Path) -> Option<PathBuf> {
    newest_render(folder, false).map(|(p, _)| p)
}

/// What the UI knows about a file: its path, name, size and modification time.
pub fn file_info(path: &Path) -> Option<FileInfo> {
    info_from(path, &path.metadata().ok()?)
}

/// `file_info` from metadata already read.
fn info_from(path: &Path, meta: &std::fs::Metadata) -> Option<FileInfo> {
    let modified: chrono::DateTime<chrono::Utc> = meta.modified().ok()?.into();
    Some(FileInfo {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        size: meta.len(),
        modified_at: modified.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

/// `latest_render` with its size and modification time.
pub fn latest_render_info(folder: &Path) -> Option<FileInfo> {
    file_info(&latest_render(folder)?)
}

/// When a file last changed in any way: the newest of its modification time, its status change time
/// (unix) and its creation time (macOS, Windows). A download or copy that keeps an old modification
/// time (`wget`, `curl -R`, `cp -p`, unzip) still changed or was created just now.
fn changed_at(meta: &std::fs::Metadata) -> Option<std::time::SystemTime> {
    let mut times = vec![meta.modified().ok(), meta.created().ok()];
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(s), Ok(ns)) = (u64::try_from(meta.ctime()), u32::try_from(meta.ctime_nsec())) {
            times.push(std::time::SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::new(s, ns)));
        }
    }
    times.into_iter().flatten().max()
}

const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
/// Folders never searched for images: dependencies, git, Tayang's own scratch, and every dot folder.
const SKIP_DIRS: [&str; 3] = ["node_modules", ".git", ".tayang"];
const IMAGES_MAX_DEPTH: usize = 6;
const IMAGES_MAX_ENTRIES: usize = 5_000;
const IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const IMAGES_MAX_LIMIT: usize = 50;

/// Every file in `folder` with its metadata, as read by the walk. Symlinks are never followed;
/// dependency, git and dot folders are skipped; the walk stops 6 levels down and after 5 000 entries.
fn walk_files(folder: &Path, mut visit: impl FnMut(PathBuf, std::fs::Metadata)) {
    let mut stack = vec![(folder.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > IMAGES_MAX_ENTRIES {
                return;
            }
            let path = entry.path();
            // `symlink_metadata` describes the link itself: a link is never followed.
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if depth + 1 < IMAGES_MAX_DEPTH && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if meta.is_file() {
                visit(path, meta);
            }
        }
    }
}

/// Images (png, jpg, jpeg, webp, gif) in `folder` changed or created after `since` (see `changed_at`),
/// newest first, at most
/// `limit` (≤ 50). Symlinks are never followed; dependency, git and dot folders are skipped; the walk
/// stops 6 levels down and after 5 000 entries. Only non-empty files up to 20 MB inside `folder`.
/// Known limits: past the 5 000-entry cap (a frames folder) the rest of the folder is not seen, and of
/// more than 50 new images only the newest 50 are listed.
pub fn recent_images(folder: &Path, since: chrono::DateTime<chrono::Utc>, limit: usize) -> Vec<FileInfo> {
    let mut found: Vec<(std::time::SystemTime, PathBuf, std::fs::Metadata)> = Vec::new();
    let since: std::time::SystemTime = since.into();
    walk_files(folder, |path, meta| {
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !IMAGE_EXTS.contains(&ext.as_str()) || meta.len() == 0 || meta.len() > IMAGE_MAX_BYTES {
            return;
        }
        match changed_at(&meta) {
            Some(m) if m > since && crate::projects::ensure_inside(folder, &path) => found.push((m, path, meta)),
            _ => {}
        }
    });
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    found
        .into_iter()
        .take(limit.min(IMAGES_MAX_LIMIT))
        // From what the walk read: no second look that a swap for a symlink could change.
        .filter_map(|(_, p, meta)| info_from(&p, &meta))
        .collect()
}

/// `latest_render`, empty files too: a render that just started. Lets the UI see a pipeline's render
/// (`npm run make`) being written.
pub fn newest_video_info(folder: &Path) -> Option<FileInfo> {
    newest_render(folder, true).and_then(|(p, meta)| info_from(&p, &meta))
}

fn parse_fps(s: &str) -> Option<f64> {
    let (n, d) = match s.split_once('/') {
        Some((n, d)) => (n.trim().parse::<f64>().ok()?, d.trim().parse::<f64>().ok()?),
        None => (s.trim().parse::<f64>().ok()?, 1.0),
    };
    if d == 0.0 || n <= 0.0 {
        None
    } else {
        Some(n / d)
    }
}

pub fn probe(tools: &MediaTools, video: &Path) -> Result<MediaInfo> {
    probe_within(tools, video, None)
}

fn probe_within(tools: &MediaTools, video: &Path, limit: Option<std::time::Duration>) -> Result<MediaInfo> {
    let mut cmd = command(&tools.ffprobe);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate,nb_frames:format=duration",
        "-of",
        "json",
    ])
    .arg(video);
    let out = match limit {
        Some(l) => run_within(cmd, "ffprobe", l)?,
        None => run(cmd, "ffprobe")?,
    };
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("bad ffprobe output: {e}"))?;
    let stream = v["streams"].get(0).ok_or("no video stream found")?;
    let width = stream["width"].as_u64().ok_or("missing width")? as u32;
    let height = stream["height"].as_u64().ok_or("missing height")? as u32;
    let fps = stream["r_frame_rate"].as_str().and_then(parse_fps).ok_or("missing frame rate")?;
    let duration_sec = v["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .ok_or("missing duration")?;
    let frames = stream["nb_frames"]
        .as_str()
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or_else(|| (duration_sec * fps).round() as u64);
    Ok(MediaInfo { duration_sec, fps, frames, width, height })
}

fn grab(
    tools: &MediaTools,
    video: &Path,
    time_sec: f64,
    out: &Path,
    scale_height: Option<u32>,
) -> Result<()> {
    let mut cmd = command(&tools.ffmpeg);
    cmd.args(["-v", "error", "-y", "-ss"])
        .arg(format!("{:.3}", time_sec.max(0.0)))
        .arg("-i")
        .arg(video)
        .args(["-frames:v", "1"]);
    if let Some(h) = scale_height {
        cmd.arg("-vf").arg(format!("scale=-2:{h}"));
    }
    cmd.arg(out);
    run(cmd, "ffmpeg")?;
    if out.exists() {
        Ok(())
    } else {
        Err("ffmpeg produced no frame (time past end of video?)".into())
    }
}

/// `<out_dir>/frame-<ms>.png`
pub fn extract_frame(
    tools: &MediaTools,
    video: &Path,
    time_sec: f64,
    out_dir: &Path,
) -> Result<PathBuf> {
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let ms = (time_sec.max(0.0) * 1000.0).round() as u64;
    let out = out_dir.join(format!("frame-{ms}.png"));
    grab(tools, video, time_sec, &out, None)?;
    Ok(out)
}

/// `count` evenly spaced frames (centred in equal segments), scaled to height 96.
pub fn thumbnails(
    tools: &MediaTools,
    video: &Path,
    count: u32,
    out_dir: &Path,
) -> Result<Vec<PathBuf>> {
    if count == 0 {
        return Ok(Vec::new());
    }
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let info = probe(tools, video)?;
    let last = (info.duration_sec - 0.05).max(0.0);
    (0..count)
        .map(|i| {
            let t = (info.duration_sec * (i as f64 + 0.5) / count as f64).min(last);
            let out = out_dir.join(format!("thumb-{i:03}.png"));
            grab(tools, video, t, &out, Some(96))?;
            Ok(out)
        })
        .collect()
}

// ---- video thumbnails (the Videos cards) ----

/// One frame of a project's newest render, cached by the render's time.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoThumb {
    pub path: String,
    /// The render's modification time (RFC 3339 UTC, ms): a new render is a new thumbnail.
    pub modified_at: String,
    /// The render's length, when ffprobe could read it.
    pub duration_sec: Option<f64>,
}

/// Each ffmpeg/ffprobe run for a thumbnail is killed after this long.
pub const THUMB_TIMEOUT: std::time::Duration = PREVIEW_TIMEOUT;

/// Where the frame is taken: 1 s in, or 10% of a video shorter than 10 s; the start when the length is unknown.
fn thumb_time(duration: Option<f64>) -> f64 {
    match duration {
        Some(d) if d < 10.0 => d * 0.1,
        Some(_) => 1.0,
        None => 0.0,
    }
}

/// A temp file name no other lookup uses, even for the same project and render at the same time.
fn thumb_temp_name(project_id: &str, ms: i64) -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!(".{project_id}-{ms}.{}-{n}.tmp.jpg", std::process::id())
}

/// A render last written this recently may still be being written.
const SETTLED: std::time::Duration = std::time::Duration::from_secs(3);
/// How many renders, newest first, are checked for a complete one.
const THUMB_CANDIDATES: usize = 5;

/// The length of `video` when it is a complete render (Rust's take on the UI's stable check): last written
/// at least 3 s ago, ffprobe reads a video with a length, and the file is the same after the probe.
fn complete_render(tools: &MediaTools, video: &Path, meta: &std::fs::Metadata, limit: std::time::Duration) -> Option<f64> {
    let written = meta.modified().ok()?;
    if written.elapsed().map_or(true, |age| age < SETTLED) {
        return None;
    }
    let info = probe_within(tools, video, Some(limit)).ok()?;
    let after = std::fs::symlink_metadata(video).ok()?;
    (info.duration_sec > 0.0 && after.len() == meta.len() && after.modified().ok() == Some(written)).then_some(info.duration_sec)
}

/// `<project_id>-<render ms>` with its extension, when `name` is one of this project's cached files.
fn thumb_stamp<'a>(name: &'a str, project_id: &str) -> Option<&'a str> {
    let stem = name.strip_suffix(".jpg").or_else(|| name.strip_suffix(".txt"))?;
    let (id, ms) = stem.rsplit_once('-')?;
    (id == project_id && !ms.is_empty() && ms.bytes().all(|b| b.is_ascii_digit())).then_some(ms)
}

/// A JPEG of the project's newest complete render (see `complete_render`; of the 5 newest), 360 px wide,
/// cached as `<thumbs>/<project_id>-<render ms>.jpg` (its length beside it in a `.txt`) and reused while that
/// render's time is the same; older ones of the project are deleted. Only when no render is complete is the
/// newest file used, so a render being written never replaces a finished one as the poster. None without a
/// render, or when ffmpeg can't make one within `limit`.
pub fn video_thumbnail(
    tools: &MediaTools,
    folder: &Path,
    thumbs: &Path,
    project_id: &str,
    limit: std::time::Duration,
) -> Option<VideoThumb> {
    if !valid_style_id(project_id) {
        return None;
    }
    let candidates = render_candidates(folder, false);
    for (video, meta) in candidates.iter().take(THUMB_CANDIDATES) {
        if let Some(hit) = cached_thumb(thumbs, project_id, meta) {
            return Some(hit);
        }
        if let Some(duration) = complete_render(tools, video, meta, limit) {
            return make_thumb(tools, video, meta, Some(duration), thumbs, project_id, limit);
        }
    }
    let (video, meta) = candidates.first()?;
    let duration = probe_within(tools, video, Some(limit)).ok().map(|i| i.duration_sec);
    make_thumb(tools, video, meta, duration, thumbs, project_id, limit)
}

/// The cached thumbnail of the project's newest render, when it is already made (no ffmpeg, no probe).
pub fn cached_video_thumbnail(folder: &Path, thumbs: &Path, project_id: &str) -> Option<VideoThumb> {
    if !valid_style_id(project_id) {
        return None;
    }
    let (_, meta) = newest_render(folder, false)?;
    cached_thumb(thumbs, project_id, &meta)
}

/// The cache files for the render with this metadata.
fn thumb_files(thumbs: &Path, project_id: &str, meta: &std::fs::Metadata) -> Option<(i64, String, PathBuf, PathBuf)> {
    let modified: chrono::DateTime<chrono::Utc> = meta.modified().ok()?.into();
    let ms = modified.timestamp_millis();
    let at = modified.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Some((ms, at, thumbs.join(format!("{project_id}-{ms}.jpg")), thumbs.join(format!("{project_id}-{ms}.txt"))))
}

/// The cached thumbnail of the render with this metadata, if there is one.
fn cached_thumb(thumbs: &Path, project_id: &str, meta: &std::fs::Metadata) -> Option<VideoThumb> {
    let (_, modified_at, jpg, txt) = thumb_files(thumbs, project_id, meta)?;
    if !jpg.metadata().is_ok_and(|m| m.is_file() && m.len() > 0) {
        return None;
    }
    let duration_sec = std::fs::read_to_string(&txt).ok().and_then(|s| s.trim().parse::<f64>().ok());
    Some(VideoThumb { path: jpg.to_string_lossy().into_owned(), modified_at, duration_sec })
}

fn make_thumb(
    tools: &MediaTools,
    video: &Path,
    meta: &std::fs::Metadata,
    duration: Option<f64>,
    thumbs: &Path,
    project_id: &str,
    limit: std::time::Duration,
) -> Option<VideoThumb> {
    let (ms, modified_at, jpg, txt) = thumb_files(thumbs, project_id, meta)?;
    std::fs::create_dir_all(thumbs).ok()?;
    // Written next to it and renamed, so a half-written frame is never shown.
    let tmp = thumbs.join(thumb_temp_name(project_id, ms));
    let os = |s: &str| std::ffi::OsString::from(s);
    let args = vec![
        os("-ss"),
        os(&format!("{:.3}", thumb_time(duration))),
        os("-i"),
        video.as_os_str().to_owned(),
        os("-frames:v"),
        os("1"),
        os("-vf"),
        os("scale=360:-2"),
        os("-q:v"),
        os("4"),
        tmp.as_os_str().to_owned(),
    ];
    let made = ffmpeg_ok(tools, &args, limit) && tmp.metadata().is_ok_and(|m| m.len() > 0) && std::fs::rename(&tmp, &jpg).is_ok();
    if !made {
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    if let Some(d) = duration {
        let _ = std::fs::write(&txt, d.to_string());
    }
    let keep = ms.to_string();
    if let Ok(rd) = std::fs::read_dir(thumbs) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if thumb_stamp(&name, project_id).is_some_and(|s| s != keep) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Some(VideoThumb { path: jpg.to_string_lossy().into_owned(), modified_at, duration_sec: duration })
}

// ---- style previews (styles copied from a video) ----

/// What `make_style_preview` produced. `preview_path` is None when the clip came out over 3 MB.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StylePreview {
    pub preview_path: Option<PathBuf>,
    pub poster_path: PathBuf,
}

const MAX_PREVIEW_BYTES: u64 = 3 * 1024 * 1024;

/// A style id that is safe as a single folder name.
pub fn valid_style_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `<data_dir>/style-media/<style_id>`, None for an id that is not a plain folder name.
pub fn style_media_dir(data_dir: &Path, style_id: &str) -> Option<PathBuf> {
    valid_style_id(style_id).then(|| data_dir.join("style-media").join(style_id))
}

/// Removes a style's preview files; a missing folder or an invalid id is fine.
pub fn remove_style_media(data_dir: &Path, style_id: &str) {
    if let Some(dir) = style_media_dir(data_dir, style_id) {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Some(dir) = style_refs_dir(data_dir, style_id) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// `<data_dir>/style-refs/<style_id>`, None for an id that is not a plain folder name.
pub fn style_refs_dir(data_dir: &Path, style_id: &str) -> Option<PathBuf> {
    valid_style_id(style_id).then(|| data_dir.join("style-refs").join(style_id))
}

const MAX_REFS: usize = 8;
const MAX_REF_BYTES: u64 = 3 * 1024 * 1024;

/// Reference frames in `dir`: real `.jpg`/`.jpeg`/`.png` files (never a symlink), at most 3 MB each,
/// sorted by name, at most eight.
fn ref_images(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter(|e| e.metadata().map(|m| m.len() > 0 && m.len() <= MAX_REF_BYTES).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            matches!(ext.as_str(), "jpg" | "jpeg" | "png")
        })
        .collect();
    out.sort();
    out.truncate(MAX_REFS);
    out
}

/// Keeps a finished study's reference frames (`<study>/refs`) as the style's own, replacing any it had.
/// Returns the kept files; none when the study left no refs (the old ones are kept then).
pub fn keep_style_refs(study_dir: &Path, out_dir: &Path) -> Result<Vec<PathBuf>> {
    let src = study_dir.join("refs");
    if std::fs::symlink_metadata(&src).map(|m| !m.is_dir()).unwrap_or(true) {
        return Ok(Vec::new());
    }
    let files = ref_images(&src);
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let _ = std::fs::remove_dir_all(out_dir);
    std::fs::create_dir_all(out_dir).map_err(|e| format!("Can't keep the reference frames: {e}"))?;
    let mut kept = Vec::new();
    for f in files {
        let Some(name) = f.file_name() else { continue };
        let to = out_dir.join(name);
        std::fs::copy(&f, &to).map_err(|e| format!("Can't keep the reference frames: {e}"))?;
        kept.push(to);
    }
    Ok(kept)
}

/// Frames per contact sheet (columns x rows) and frames sampled across the whole source.
pub const SHEET_COLS: u32 = 4;
pub const SHEET_ROWS: u32 = 3;
const SHEET_FRAMES: u32 = 48;
const SHEETS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// Contact sheets of a finished study's source: 48 frames sampled evenly across the whole video, 320 px
/// wide, tiled 4x3 in time order into `sheet-01.jpg` … `sheet-04.jpg` in `out_dir` (replacing what it had).
/// The source is left for the preview. None made (no source, no ffmpeg) leaves `out_dir` as it was.
pub fn make_style_sheets(tools: &MediaTools, study_dir: &Path, out_dir: &Path) -> Result<Vec<PathBuf>> {
    let Some(source) = source_files(study_dir).into_iter().max_by_key(|p| p.metadata().map(|m| m.len()).unwrap_or(0)) else {
        return Ok(Vec::new());
    };
    let Ok(info) = probe_within(tools, &source, Some(SHEETS_TIMEOUT)) else { return Ok(Vec::new()) };
    if info.duration_sec <= 0.0 {
        return Ok(Vec::new());
    }
    let Some(name) = out_dir.file_name().map(|n| n.to_string_lossy().into_owned()) else { return Ok(Vec::new()) };
    let tmp = out_dir.with_file_name(format!(".{name}.sheets.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Can't make the contact sheets: {e}"))?;
    let os = |s: &str| std::ffi::OsString::from(s);
    let sheets = SHEET_FRAMES / (SHEET_COLS * SHEET_ROWS);
    let filter = format!(
        "fps={SHEET_FRAMES}/{:.3},scale=320:-2,tile={SHEET_COLS}x{SHEET_ROWS}",
        info.duration_sec
    );
    let mut args: Vec<std::ffi::OsString> = vec![os("-i")];
    args.push(source.as_os_str().to_owned());
    for a in ["-map", "0:v:0", "-an", "-sn", "-dn", "-vf", &filter, "-frames:v", &sheets.to_string(), "-q:v", "4"] {
        args.push(os(a));
    }
    args.push(tmp.join("sheet-%02d.jpg").into_os_string());
    if !ffmpeg_ok(tools, &args, SHEETS_TIMEOUT) || ref_images(&tmp).is_empty() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Ok(Vec::new());
    }
    let _ = std::fs::remove_dir_all(out_dir);
    if let Some(parent) = out_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(&tmp, out_dir).map_err(|e| format!("Can't keep the contact sheets: {e}"))?;
    Ok(ref_images(out_dir))
}

/// Copies a style's reference frames into `<project>/style-refs/`, where the brief points the agent.
/// Returns how many were copied; a style without refs copies none.
pub fn copy_style_refs(refs_dir: &Path, project_folder: &Path) -> Result<usize> {
    if std::fs::symlink_metadata(refs_dir).map(|m| !m.is_dir()).unwrap_or(true) {
        return Ok(0);
    }
    let files = ref_images(refs_dir);
    if files.is_empty() {
        return Ok(0);
    }
    let dest = project_folder.join("style-refs");
    if std::fs::symlink_metadata(&dest).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err("The project's style-refs folder is a link".to_string());
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("Can't copy the reference frames: {e}"))?;
    let mut n = 0;
    for f in files {
        let Some(name) = f.file_name() else { continue };
        std::fs::copy(&f, dest.join(name)).map_err(|e| format!("Can't copy the reference frames: {e}"))?;
        n += 1;
    }
    Ok(n)
}

/// The study's downloaded `source.*` files: real files only (a symlink could point anywhere).
fn source_files(study_dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(study_dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("source."))
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .collect()
}

fn ffmpeg_ok(tools: &MediaTools, args: &[std::ffi::OsString], limit: std::time::Duration) -> bool {
    let mut cmd = command(&tools.ffmpeg);
    cmd.args(["-v", "error", "-y"]).args(args);
    run_within(cmd, "ffmpeg", limit).is_ok()
}

const PREVIEW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Cuts a short silent preview and a poster from the study's `source.*` into `out_dir`
/// (`preview.mp4`, `poster.jpg`), then deletes the source and any frames folder, whatever happened.
/// `Ok(None)` when there is no source or no poster could be made. Each ffmpeg/ffprobe run is killed after 60 s.
pub fn make_style_preview(tools: &MediaTools, study_dir: &Path, out_dir: &Path) -> Result<Option<StylePreview>> {
    make_style_preview_within(tools, study_dir, out_dir, PREVIEW_TIMEOUT)
}

fn make_style_preview_within(
    tools: &MediaTools,
    study_dir: &Path,
    out_dir: &Path,
    limit: std::time::Duration,
) -> Result<Option<StylePreview>> {
    let sources = source_files(study_dir);
    let Some(source) = sources
        .iter()
        .max_by_key(|p| p.metadata().map(|m| m.len()).unwrap_or(0))
        .cloned()
    else {
        return Ok(None);
    };
    let made = build_style_preview(tools, &source, out_dir, limit);
    for f in &sources {
        let _ = std::fs::remove_file(f);
    }
    let _ = std::fs::remove_dir_all(study_dir.join("frames"));
    Ok(made)
}

/// Builds into a temp folder next to `out_dir` and swaps it in only on success, so a failed run never
/// touches an existing preview.
fn build_style_preview(tools: &MediaTools, source: &Path, out_dir: &Path, limit: std::time::Duration) -> Option<StylePreview> {
    let name = out_dir.file_name()?.to_string_lossy().into_owned();
    let tmp = out_dir.with_file_name(format!(".{name}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    let built = build_into(tools, source, &tmp, limit);
    let Some(has_clip) = built else {
        let _ = std::fs::remove_dir_all(&tmp);
        return None;
    };
    // Swap with a backup so a failure at any step leaves the old preview in place.
    let backup = out_dir.with_file_name(format!(".{name}.old"));
    let _ = std::fs::remove_dir_all(&backup);
    let had_old = out_dir.exists();
    if had_old && std::fs::rename(out_dir, &backup).is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
        return None;
    }
    if std::fs::rename(&tmp, out_dir).is_err() {
        if had_old {
            let _ = std::fs::rename(&backup, out_dir);
        }
        let _ = std::fs::remove_dir_all(&tmp);
        return None;
    }
    let _ = std::fs::remove_dir_all(&backup);
    Some(StylePreview { preview_path: has_clip.then(|| out_dir.join("preview.mp4")), poster_path: out_dir.join("poster.jpg") })
}

/// Writes preview.mp4 and poster.jpg into `dir`; `Some(has_clip)` when the poster was made.
fn build_into(tools: &MediaTools, source: &Path, dir: &Path, limit: std::time::Duration) -> Option<bool> {
    let duration = probe_within(tools, source, Some(limit)).ok()?.duration_sec;
    std::fs::create_dir_all(dir).ok()?;
    // Skip a cold open: 3 s in, or 10% of a short video.
    let start = (duration * 0.1).min(3.0);
    let os = |s: &str| std::ffi::OsString::from(s);
    let preview = dir.join("preview.mp4");
    let mut args: Vec<std::ffi::OsString> = vec![os("-ss"), os(&format!("{start:.3}")), os("-t"), os("10"), os("-i")];
    args.push(source.as_os_str().to_owned());
    args.extend(
        [
            "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-vf",
            "scale=540:-2:out_range=tv,fps=30", "-c:v", "libx264", "-crf", "30", "-preset", "slow", "-pix_fmt",
            "yuv420p", "-color_range", "tv", "-movflags", "+faststart",
        ]
        .iter()
        .map(|s| os(s)),
    );
    args.push(preview.as_os_str().to_owned());
    let clip_ok = ffmpeg_ok(tools, &args, limit)
        && preview.metadata().map(|m| m.len() > 0 && m.len() <= MAX_PREVIEW_BYTES).unwrap_or(false);
    if !clip_ok {
        let _ = std::fs::remove_file(&preview);
    }

    // A frame 1 s into the clip.
    let poster = dir.join("poster.jpg");
    let at = (start + 1.0).min((duration - 0.05).max(0.0));
    let poster_args: Vec<std::ffi::OsString> = vec![
        os("-ss"),
        os(&format!("{at:.3}")),
        os("-i"),
        source.as_os_str().to_owned(),
        os("-frames:v"),
        os("1"),
        os("-vf"),
        os("scale=540:-2"),
        os("-q:v"),
        os("4"),
        poster.as_os_str().to_owned(),
    ];
    if !ffmpeg_ok(tools, &poster_args, limit) || !poster.exists() {
        return None;
    }
    Some(clip_ok)
}

/// `<working>/.tayang/style-study`, only when it is the real thing: the working folder is absolute, and neither
/// `.tayang` nor `style-study` is a symlink (so nothing can point the deletes elsewhere). `Ok(None)` when it
/// doesn't exist yet.
fn confined_study_root(working: &Path) -> Result<Option<PathBuf>> {
    if !working.is_absolute() {
        return Err("The working folder must be an absolute path".into());
    }
    let tayang = working.join(".tayang");
    let root = tayang.join("style-study");
    for p in [&tayang, &root] {
        match std::fs::symlink_metadata(p) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
            Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
                return Err(format!("{} is not a plain folder", p.display()))
            }
            Ok(_) => {}
        }
    }
    let want = std::fs::canonicalize(working).map_err(|e| e.to_string())?.join(".tayang").join("style-study");
    if std::fs::canonicalize(&root).map_err(|e| e.to_string())? != want {
        return Err("The study folder is not where it should be".into());
    }
    Ok(Some(root))
}

/// Deletes one study's folder `<working>/.tayang/style-study/<id>` (the download, frames, everything). The id
/// is validated and the study root must be the real folder inside the working folder; a missing folder is
/// fine, a symlinked study folder is removed as a link without following it.
pub fn remove_study_dir(working: &Path, study_id: &str) -> Result<()> {
    if !valid_style_id(study_id) {
        return Err("That style study id isn't valid".into());
    }
    let Some(root) = confined_study_root(working)? else { return Ok(()) };
    let dir = root.join(study_id);
    match std::fs::symlink_metadata(&dir) {
        Err(_) => Ok(()),
        Ok(m) if m.file_type().is_symlink() => std::fs::remove_file(&dir).map_err(|e| e.to_string()),
        Ok(_) => std::fs::remove_dir_all(&dir).map_err(|e| e.to_string()),
    }
}

/// Startup sweep: nothing can be running when the app starts, so every leftover study folder goes. Only direct
/// children named like study ids are touched, and nothing at all unless the study root is confined.
pub fn sweep_study_dirs(working: &Path) {
    let Ok(Some(root)) = confined_study_root(working) else { return };
    let Ok(rd) = std::fs::read_dir(&root) else { return };
    for e in rd.flatten() {
        if !valid_style_id(&e.file_name().to_string_lossy()) {
            continue;
        }
        let p = e.path();
        let Ok(t) = e.file_type() else { continue };
        let _ = if t.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
    }
}

/// Arguments for `npx` (pinned, non-interactive), run with `folder` as the working directory.
/// `--output` pins the file into `<folder>/renders/`.
pub fn render_args(folder: &Path) -> Vec<String> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out = folder.join("renders").join(format!("render-{secs}.mp4"));
    vec![
        "-y".into(),
        "hyperframes@0.9.10".into(),
        "render".into(),
        "--output".into(),
        out.to_string_lossy().into_owned(),
        "--quiet".into(),
    ]
}

/// What `tayang.json` asks for (`engine` and `readme` are for the agent, not for rendering).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
struct RenderManifest {
    #[serde(deserialize_with = "argv")]
    render: Vec<String>,
    #[serde(default, deserialize_with = "optional_argv")]
    install: Option<Vec<String>>,
}

/// A command as a list of arguments, or written as one line (`"npm install"`), which agents sometimes do.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum Argv {
    List(Vec<String>),
    Line(String),
}

impl From<Argv> for Vec<String> {
    fn from(a: Argv) -> Self {
        match a {
            Argv::List(v) => v,
            Argv::Line(l) => l.split_whitespace().map(str::to_string).collect(),
        }
    }
}

fn argv<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Vec<String>, D::Error> {
    <Argv as serde::Deserialize>::deserialize(d).map(Into::into)
}

fn optional_argv<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Vec<String>>, D::Error> {
    <Option<Argv> as serde::Deserialize>::deserialize(d).map(|a| a.map(Into::into))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderPlan {
    /// Argv to run first when `node_modules` is missing.
    pub install: Option<Vec<String>>,
    /// Argv with `{output}` already replaced.
    pub render: Vec<String>,
    /// Output path relative to the project folder.
    pub output: PathBuf,
}

const ALLOWED_PROGRAMS: [&str; 6] = ["npx", "npm", "node", "pnpm", "bun", "yarn"];

/// Templates may only run JavaScript tooling: a bare allow-listed program name.
fn check_allowed_program(argv: &[String]) -> Result<()> {
    let name = argv.first().map(String::as_str).unwrap_or("");
    let base = if cfg!(windows) {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".exe") {
            name[..name.len() - 4].to_string()
        } else {
            name.to_string()
        }
    } else {
        name.to_string()
    };
    let bare = !name.contains('/') && !name.contains('\\') && !name.contains("..");
    if bare && ALLOWED_PROGRAMS.contains(&base.as_str()) {
        Ok(())
    } else {
        Err(format!("This template asks to run {name}, which Tayang doesn't allow"))
    }
}

/// `Ok(None)` when the folder has no `tayang.json` (use the HyperFrames default).
pub fn render_plan(folder: &Path, unix_secs: u64) -> Result<Option<RenderPlan>> {
    let path = folder.join("tayang.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read tayang.json: {e}")),
    };
    let m: RenderManifest =
        serde_json::from_str(&raw).map_err(|e| format!("tayang.json is not valid: {e}"))?;
    if m.render.is_empty() {
        return Err("tayang.json has an empty render command".into());
    }
    check_allowed_program(&m.render)?;
    if let Some(install) = &m.install {
        check_allowed_program(install)?;
    }
    let slug = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let slug = if slug.is_empty() { "render".to_string() } else { slug };
    let output = Path::new("renders").join(format!("{slug}-{unix_secs}.mp4"));
    let out_s = output.to_string_lossy().into_owned();
    let render = m.render.iter().map(|a| a.replace("{output}", &out_s)).collect();
    let install = m
        .install
        .filter(|i| !i.is_empty() && !folder.join("node_modules").exists());
    Ok(Some(RenderPlan { install, render, output }))
}

/// The render command to show the user: the `tayang.json` one, or `None` for the HyperFrames default.
pub fn render_command(folder: &Path, unix_secs: u64) -> Result<Option<RenderPlan>> {
    render_plan(folder, unix_secs)
}

/// Resolves argv[0] the way detection does (GUI apps can start with a minimal PATH).
fn argv_command(argv: &[String], folder: &Path) -> Command {
    let exec = crate::system::RealExec;
    let program = crate::system::Exec::which(&exec, &argv[0])
        .or_else(|| {
            cfg!(windows)
                .then(|| crate::system::Exec::which(&exec, &format!("{}.cmd", argv[0])))
                .flatten()
        })
        .unwrap_or_else(|| PathBuf::from(&argv[0]));
    let mut cmd = command(program);
    cmd.args(&argv[1..]).current_dir(folder);
    cmd
}

pub fn render(folder: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(folder.join("renders")).map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(plan) = render_plan(folder, secs)? {
        if let Some(install) = &plan.install {
            run(argv_command(install, folder), "template install")?;
        }
        let done = match run(argv_command(&plan.render, folder), "template render") {
            Err(e) if is_no_browser(&e) && is_remotion(&plan.render) => render_with_a_browser(folder, &plan.render, e)?,
            r => r?,
        };
        let out = folder.join(&plan.output);
        if out.exists() {
            return Ok(out);
        }
        return latest_render(folder).ok_or_else(|| no_mp4(&done));
    }
    // HyperFrames renders the folder's index.html; without it the agent hasn't built anything yet.
    if !folder.join("index.html").exists() {
        return Err(NOTHING_TO_RENDER.to_string());
    }
    // GUI apps can start with a minimal PATH, so resolve npx the way detection does.
    let npx = crate::system::Exec::which(&crate::system::RealExec, "npx")
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "npx.cmd" } else { "npx" }));
    let mut cmd = command(npx);
    cmd.args(render_args(folder)).current_dir(folder);
    let done = run(cmd, "hyperframes render")?;
    latest_render(folder).ok_or_else(|| no_mp4(&done))
}

/// Remotion found no browser: download its own (`remotion browser ensure`) and try again, then fall back
/// to the computer's Google Chrome. Each step runs only after the one before still found no browser.
fn render_with_a_browser(folder: &Path, render: &[String], first: String) -> Result<std::process::Output> {
    let mut last = first;
    if run(argv_command(&browser_ensure(render), folder), "remotion browser download").is_ok() {
        match run(argv_command(render, folder), "template render") {
            Err(e) if is_no_browser(&e) => last = e,
            r => return r,
        }
    }
    let os = crate::system::os_kind();
    match crate::system::chrome_executable(&crate::system::RealExec, os) {
        Some(chrome) => run(argv_command(&with_chrome(render, &chrome), folder), "template render"),
        None => Err(last),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn test_tools() -> Option<MediaTools> {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg = std::env::var_os("FFMPEG_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| manifest.join("../node_modules/ffmpeg-static/ffmpeg"));
        let ffprobe = std::env::var_os("FFPROBE_PATH").map(PathBuf::from).unwrap_or_else(|| {
            let os = match std::env::consts::OS {
                "macos" => "darwin",
                "windows" => "win32",
                o => o,
            };
            let arch = match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                a => a,
            };
            let exe = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
            manifest.join("../node_modules/ffprobe-static/bin").join(os).join(arch).join(exe)
        });
        if ffmpeg.exists() && ffprobe.exists() {
            Some(MediaTools { ffmpeg, ffprobe })
        } else {
            eprintln!("skipping media test: ffmpeg/ffprobe not found (set FFMPEG_PATH/FFPROBE_PATH or run pnpm install)");
            None
        }
    }

    /// Returns (tempdir guard, clip path). The directory name contains a space (and `"` on unix).
    fn make_clip(tools: &MediaTools) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let name = if cfg!(unix) { "my \"clip\" dir" } else { "my clip dir" };
        let dir = tmp.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        let out = Command::new(&tools.ffmpeg)
            .args(["-y", "-f", "lavfi", "-i", "testsrc=size=270x480:rate=30", "-t", "2", "-pix_fmt", "yuv420p"])
            .arg(&clip)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        (tmp, clip)
    }

    #[test]
    fn probe_reads_clip_metadata() {
        let Some(t) = test_tools() else { return };
        let (_g, clip) = make_clip(&t);
        let info = probe(&t, &clip).unwrap();
        assert!((info.duration_sec - 2.0).abs() < 0.1, "{info:?}");
        assert_eq!(info.fps, 30.0);
        assert_eq!((info.width, info.height), (270, 480));
        assert_eq!(info.frames, 60);
    }

    #[test]
    fn parse_fps_handles_rationals() {
        assert_eq!(parse_fps("30/1"), Some(30.0));
        assert!((parse_fps("30000/1001").unwrap() - 29.97).abs() < 0.01);
        assert_eq!(parse_fps("0/0"), None);
        assert_eq!(parse_fps("25"), Some(25.0));
    }

    #[test]
    fn probe_missing_file_errors() {
        let Some(t) = test_tools() else { return };
        assert!(probe(&t, Path::new("/definitely/not/here.mp4")).is_err());
    }

    #[test]
    fn extract_frame_writes_png() {
        let Some(t) = test_tools() else { return };
        let (g, clip) = make_clip(&t);
        let out_dir = g.path().join("out dir");
        let p = extract_frame(&t, &clip, 1.0, &out_dir).unwrap();
        assert!(p.exists());
        assert_eq!(p.file_name().unwrap(), "frame-1000.png");
        assert!(std::fs::metadata(&p).unwrap().len() > 0);
    }

    #[test]
    fn thumbnails_returns_count_files() {
        let Some(t) = test_tools() else { return };
        let (g, clip) = make_clip(&t);
        let out_dir = g.path().join("thumbs");
        let v = thumbnails(&t, &clip, 6, &out_dir).unwrap();
        assert_eq!(v.len(), 6);
        assert!(v.iter().all(|p| p.exists()));
        assert!(thumbnails(&t, &clip, 0, &out_dir).unwrap().is_empty());
    }

    fn stream_info(tools: &MediaTools, file: &Path) -> serde_json::Value {
        let mut cmd = Command::new(&tools.ffprobe);
        cmd.args(["-v", "error", "-show_entries", "stream=codec_type,pix_fmt,width,height:format=duration", "-of", "json"]).arg(file);
        serde_json::from_slice(&cmd.output().unwrap().stdout).unwrap()
    }

    /// A 5 s 360x640 clip with audio at `<dir>/<name>`.
    fn make_source(tools: &MediaTools, dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        let out = Command::new(&tools.ffmpeg)
            .args(["-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=5", "-f", "lavfi", "-i", "sine=duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
            .arg(&p)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        p
    }

    #[test]
    fn contact_sheets_cover_the_whole_source_in_four_by_three_grids_and_keep_the_source() {
        let Some(t) = test_tools() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let study = tmp.path().join("study dir");
        let source = make_source(&t, &study, "source.mp4");
        let out = style_refs_dir(tmp.path(), "copied-1").unwrap();
        let sheets = make_style_sheets(&t, &study, &out).unwrap();
        let names: Vec<_> = sheets.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["sheet-01.jpg", "sheet-02.jpg", "sheet-03.jpg", "sheet-04.jpg"]);
        // One sheet is 4 frames of 320 px across and 3 rows of 320x569 frames down.
        let dims = Command::new(&t.ffprobe)
            .args(["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0"])
            .arg(&sheets[0])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&dims.stdout).trim(), "1280,1704");
        assert!(source.is_file(), "the preview still needs the source");
        // A study without a source makes none and leaves earlier sheets alone.
        assert!(make_style_sheets(&t, &tmp.path().join("nothing"), &out).unwrap().is_empty());
        assert!(out.join("sheet-01.jpg").is_file());
    }

    #[test]
    fn style_preview_makes_a_silent_clip_and_poster_and_deletes_the_source() {
        let Some(t) = test_tools() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let study = tmp.path().join("study dir");
        let source = make_source(&t, &study, "source.mp4");
        std::fs::write(study.join("style.json"), "{}").unwrap();
        std::fs::create_dir_all(study.join("frames")).unwrap();
        std::fs::write(study.join("frames").join("f1.png"), "x").unwrap();
        let out = tmp.path().join("style-media").join("copied-1");
        let r = make_style_preview(&t, &study, &out).unwrap().expect("a preview");
        let mp4 = r.preview_path.clone().expect("a clip");
        assert_eq!(mp4, out.join("preview.mp4"));
        assert_eq!(r.poster_path, out.join("poster.jpg"));
        let info = stream_info(&t, &mp4);
        let streams = info["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 1, "no audio: {info}");
        assert_eq!(streams[0]["codec_type"], "video");
        assert_eq!(streams[0]["pix_fmt"], "yuv420p");
        assert_eq!(streams[0]["width"], 540);
        assert_eq!(streams[0]["height"].as_u64().unwrap() % 2, 0);
        let dur: f64 = info["format"]["duration"].as_str().unwrap().parse().unwrap();
        assert!(dur <= 10.1 && dur > 3.0, "{dur}");
        assert!(std::fs::metadata(&mp4).unwrap().len() <= 3 * 1024 * 1024);
        let poster = stream_info(&t, &r.poster_path);
        assert_eq!(poster["streams"][0]["width"], 540);
        assert!(!source.exists(), "source deleted");
        assert!(!study.join("frames").exists(), "frames deleted");
        assert!(study.join("style.json").exists(), "style.json stays");
    }

    #[test]
    fn style_preview_without_a_source_is_none() {
        let Some(t) = test_tools() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let study = tmp.path().join("study");
        std::fs::create_dir_all(&study).unwrap();
        std::fs::write(study.join("style.json"), "{}").unwrap();
        assert_eq!(make_style_preview(&t, &study, &tmp.path().join("out")).unwrap(), None);
        assert!(!tmp.path().join("out").exists());
    }

    #[test]
    fn style_preview_deletes_the_source_even_when_ffmpeg_fails() {
        let Some(t) = test_tools() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let study = tmp.path().join("study");
        std::fs::create_dir_all(&study).unwrap();
        let bad = study.join("source.webm");
        std::fs::write(&bad, "not a video").unwrap();
        assert_eq!(make_style_preview(&t, &study, &tmp.path().join("out")).unwrap(), None);
        assert!(!bad.exists());
    }

    #[cfg(unix)]
    #[test]
    fn style_preview_ignores_a_symlinked_source() {
        let Some(t) = test_tools() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let real = make_source(&t, &tmp.path().join("elsewhere"), "private.mp4");
        let study = tmp.path().join("study");
        std::fs::create_dir_all(&study).unwrap();
        std::os::unix::fs::symlink(&real, study.join("source.mp4")).unwrap();
        assert_eq!(make_style_preview(&t, &study, &tmp.path().join("out")).unwrap(), None);
        assert!(real.exists(), "the link target is never touched");
    }

    #[test]
    fn removing_style_media_deletes_only_that_styles_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let a = style_media_dir(tmp.path(), "copied-1").unwrap();
        let b = style_media_dir(tmp.path(), "copied-2").unwrap();
        for d in [&a, &b] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("poster.jpg"), "x").unwrap();
        }
        remove_style_media(tmp.path(), "copied-1");
        assert!(!a.exists() && b.exists());
        remove_style_media(tmp.path(), "copied-1"); // already gone
        remove_style_media(tmp.path(), "../style-media"); // invalid: ignored
        assert!(b.exists());
        assert_eq!(style_media_dir(tmp.path(), ".."), None);
    }

    #[cfg(unix)]
    fn script_tool(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_ffmpeg_or_ffprobe_is_killed_and_the_source_still_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let study = tmp.path().join("study");
        std::fs::create_dir_all(&study).unwrap();
        let hang = script_tool(tmp.path(), "hang.sh", "exec sleep 30");
        let tools = MediaTools { ffmpeg: hang.clone(), ffprobe: hang };
        let source = study.join("source.mp4");
        std::fs::write(&source, "x").unwrap();
        let started = std::time::Instant::now();
        let r = make_style_preview_within(&tools, &study, &tmp.path().join("out"), std::time::Duration::from_millis(700)).unwrap();
        assert_eq!(r, None);
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
        assert!(!source.exists());
        assert!(!tmp.path().join("out").exists());
    }

    #[test]
    fn a_failed_run_keeps_an_existing_good_preview() {
        let Some(t) = test_tools() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let study = tmp.path().join("study");
        std::fs::create_dir_all(&study).unwrap();
        std::fs::write(study.join("source.webm"), "not a video").unwrap();
        let out = tmp.path().join("style-media").join("copied-1");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("poster.jpg"), "old poster").unwrap();
        assert_eq!(make_style_preview(&t, &study, &out).unwrap(), None);
        assert_eq!(std::fs::read_to_string(out.join("poster.jpg")).unwrap(), "old poster");
        // No temp folder is left next to it either.
        let names: Vec<_> = std::fs::read_dir(out.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["copied-1"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_swap_that_fails_restores_the_old_preview() {
        use std::os::unix::fs::PermissionsExt;
        let Some(t) = test_tools() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let study = tmp.path().join("study");
        make_source(&t, &study, "source.mp4");
        let parent = tmp.path().join("style-media");
        let out = parent.join("copied-1");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("poster.jpg"), "old poster").unwrap();
        // Building into the temp folder works, but the parent turns read-only, so no rename can succeed.
        let ro = std::fs::Permissions::from_mode(0o555);
        let rw = std::fs::Permissions::from_mode(0o755);
        std::fs::create_dir_all(parent.join(".copied-1.tmp")).unwrap();
        std::fs::set_permissions(&parent, ro).unwrap();
        let r = make_style_preview(&t, &study, &out);
        std::fs::set_permissions(&parent, rw).unwrap();
        // (Running as root ignores permissions; then the run simply succeeds and there is nothing to restore.)
        if let Ok(None) = r {
            assert_eq!(std::fs::read_to_string(out.join("poster.jpg")).unwrap(), "old poster");
        }
    }

    #[test]
    fn a_successful_run_replaces_an_existing_preview() {
        let Some(t) = test_tools() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let study = tmp.path().join("study");
        make_source(&t, &study, "source.mp4");
        let out = tmp.path().join("style-media").join("copied-1");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("stale.txt"), "x").unwrap();
        let r = make_style_preview(&t, &study, &out).unwrap().unwrap();
        assert!(r.preview_path.unwrap().exists() && r.poster_path.exists());
        assert!(!out.join("stale.txt").exists());
        let names: Vec<_> = std::fs::read_dir(out.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["copied-1"], "no backup or temp folder is left");
    }

    #[test]
    fn study_dirs_are_removed_inside_the_working_folder_only() {
        let tmp = tempfile::tempdir().unwrap();
        let working = tmp.path().join("work");
        let root = working.join(".tayang").join("style-study");
        let a = root.join("a1");
        let b = root.join("b2");
        for d in [&a, &b] {
            std::fs::create_dir_all(d.join("frames")).unwrap();
            std::fs::write(d.join("source.mp4"), "x").unwrap();
        }
        remove_study_dir(&working, "a1").unwrap();
        assert!(!a.exists() && b.exists());
        remove_study_dir(&working, "a1").unwrap(); // already gone
        for bad in ["", ".", "..", "../x", "a/b", "a\\b"] {
            assert!(remove_study_dir(&working, bad).is_err(), "{bad}");
        }
        assert!(working.exists() && b.exists());
    }

    #[cfg(unix)]
    #[test]
    fn removing_a_study_dir_that_is_a_symlink_only_removes_the_link() {
        let tmp = tempfile::tempdir().unwrap();
        let working = tmp.path().join("work");
        let root = working.join(".tayang").join("style-study");
        std::fs::create_dir_all(&root).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("evil")).unwrap();
        let _ = remove_study_dir(&working, "evil");
        assert!(outside.join("keep.txt").exists());
    }

    /// `<tmp>/work` with `.tayang`, and a victim folder with a file that must survive.
    #[cfg(unix)]
    fn confinement_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let victim = tmp.path().join("victim");
        std::fs::create_dir_all(victim.join("study1")).unwrap();
        std::fs::write(victim.join("precious.txt"), "x").unwrap();
        std::fs::write(victim.join("study1").join("a.txt"), "x").unwrap();
        (tmp, work, victim)
    }

    #[cfg(unix)]
    fn assert_untouched(victim: &Path) {
        assert!(victim.join("precious.txt").exists() && victim.join("study1").join("a.txt").exists(), "victim was touched");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_tayang_folder_is_never_swept_or_followed() {
        let (_t, work, victim) = confinement_fixture();
        std::fs::create_dir_all(victim.join("style-study").join("study1")).unwrap();
        std::fs::write(victim.join("style-study").join("study1").join("b.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&victim, work.join(".tayang")).unwrap();
        sweep_study_dirs(&work);
        assert!(remove_study_dir(&work, "study1").is_err());
        assert_untouched(&victim);
        assert!(victim.join("style-study").join("study1").join("b.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_study_root_is_never_swept_or_followed() {
        for target in ["victim", "work"] {
            let (_t, work, victim) = confinement_fixture();
            std::fs::create_dir_all(work.join(".tayang")).unwrap();
            let goal = if target == "victim" { victim.clone() } else { work.clone() };
            std::os::unix::fs::symlink(&goal, work.join(".tayang").join("style-study")).unwrap();
            if target == "work" {
                std::fs::create_dir_all(work.join("study1")).unwrap();
                std::fs::write(work.join("study1").join("project.txt"), "x").unwrap();
            }
            sweep_study_dirs(&work);
            assert!(remove_study_dir(&work, "study1").is_err(), "{target}");
            assert_untouched(&victim);
            if target == "work" {
                assert!(work.join("study1").join("project.txt").exists());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_study_folder_is_unlinked_not_followed_by_the_sweep() {
        let (_t, work, victim) = confinement_fixture();
        let root = work.join(".tayang").join("style-study");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&victim, root.join("evil")).unwrap();
        std::fs::create_dir_all(root.join("real1")).unwrap();
        sweep_study_dirs(&work);
        assert!(std::fs::symlink_metadata(root.join("evil")).is_err(), "the link is gone");
        assert!(!root.join("real1").exists());
        assert_untouched(&victim);
    }

    #[test]
    fn the_sweep_only_deletes_children_named_like_study_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        let root = work.join(".tayang").join("style-study");
        for n in ["abc123", "has space", ".hidden", "é"] {
            std::fs::create_dir_all(root.join(n)).unwrap();
        }
        sweep_study_dirs(&work);
        assert!(!root.join("abc123").exists());
        for n in ["has space", ".hidden", "é"] {
            assert!(root.join(n).exists(), "{n}");
        }
    }

    #[test]
    fn a_relative_working_folder_is_refused() {
        let rel = PathBuf::from(format!("target/rel-sweep-{}", std::process::id()));
        let kept = rel.join(".tayang").join("style-study").join("a1");
        std::fs::create_dir_all(&kept).unwrap();
        sweep_study_dirs(&rel);
        assert!(remove_study_dir(&rel, "a1").is_err());
        assert!(kept.exists());
        let _ = std::fs::remove_dir_all(&rel);
        sweep_study_dirs(Path::new("")); // must not touch the current folder either
    }

    #[test]
    fn the_startup_sweep_deletes_every_study_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let working = tmp.path().join("work");
        let root = working.join(".tayang").join("style-study");
        for id in ["a", "b"] {
            std::fs::create_dir_all(root.join(id)).unwrap();
            std::fs::write(root.join(id).join("source.mp4"), "x").unwrap();
        }
        sweep_study_dirs(&working);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        sweep_study_dirs(&tmp.path().join("nothing")); // no folder: fine
    }

    #[test]
    fn style_ids_are_validated() {
        for ok in ["copied-1a2b", "mine_9", "A-z_0"] {
            assert!(valid_style_id(ok), "{ok}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "../x", "a b", "é"] {
            assert!(!valid_style_id(bad), "{bad}");
        }
    }

    #[test]
    fn latest_render_picks_newest_mp4() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(latest_render(tmp.path()), None);
        let renders = tmp.path().join("renders");
        std::fs::create_dir_all(&renders).unwrap();
        let old = renders.join("a.mp4");
        std::fs::write(&old, b"x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let new = renders.join("b.mp4");
        std::fs::write(&new, b"x").unwrap();
        std::fs::write(renders.join("c.txt"), b"x").unwrap();
        assert_eq!(latest_render(tmp.path()), Some(new));
    }

    fn since_epoch() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp(0, 0).unwrap()
    }

    #[test]
    fn recent_images_finds_new_images_and_skips_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let w = |rel: &str, bytes: &[u8]| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, bytes).unwrap();
        };
        w("a.png", b"x");
        w("art/b.JPG", b"x");
        w("art/c.jpeg", b"x");
        w("art/d.webp", b"x");
        w("art/e.gif", b"x");
        w("art/notes.txt", b"x");
        w("art/empty.png", b"");
        w("node_modules/pkg/f.png", b"x");
        w(".git/g.png", b"x");
        w(".tayang/frames/h.png", b"x");
        w(".cache/i.png", b"x");
        w("1/2/3/4/5/deep.png", b"x");
        w("1/2/3/4/5/6/too-deep.png", b"x");
        let mut names: Vec<String> = recent_images(root, since_epoch(), 50).into_iter().map(|f| f.name).collect();
        names.sort();
        assert_eq!(names, ["a.png", "b.JPG", "c.jpeg", "d.webp", "deep.png", "e.gif"]);
    }

    #[test]
    fn recent_images_only_after_since_newest_first_and_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("old.png"), b"x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let since = chrono::Utc::now();
        std::thread::sleep(std::time::Duration::from_millis(50));
        for i in 0..3 {
            std::fs::write(root.join(format!("n{i}.png")), b"x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let got: Vec<String> = recent_images(root, since, 50).into_iter().map(|f| f.name).collect();
        assert_eq!(got, ["n2.png", "n1.png", "n0.png"]);
        assert_eq!(recent_images(root, since, 2).len(), 2);
        // 51 asked, 50 at most.
        for i in 0..60 {
            std::fs::write(root.join(format!("m{i}.png")), b"x").unwrap();
        }
        assert_eq!(recent_images(root, since, 51).len(), 50);
        let big = root.join("big.png");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(IMAGE_MAX_BYTES + 1).unwrap();
        assert!(recent_images(root, since, 50).iter().all(|i| i.name != "big.png"));
    }

    #[cfg(unix)]
    #[test]
    fn recent_images_never_follows_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        let root = tmp.path().join("project");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(outside.join("secret.png"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked-dir")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.png"), root.join("linked.png")).unwrap();
        assert!(recent_images(&root, since_epoch(), 50).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn recent_images_works_when_the_project_folder_is_a_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(real.join("art")).unwrap();
        std::fs::write(real.join("art/a.png"), b"x").unwrap();
        let link = tmp.path().join("project");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let got = recent_images(&link, since_epoch(), 50);
        assert_eq!(got.len(), 1);
        // The path keeps the folder's own spelling; the asset scope resolves it.
        assert_eq!(PathBuf::from(&got[0].path), link.join("art/a.png"));
        assert_eq!(got[0].size, 1);
    }

    #[test]
    fn recent_images_counts_a_new_file_with_an_old_mtime() {
        // `wget`, `curl -R`, `cp -p` and unzip keep a file's old modification time.
        let tmp = tempfile::tempdir().unwrap();
        let since = chrono::Utc::now() - chrono::Duration::seconds(5);
        let p = tmp.path().join("downloaded.png");
        std::fs::write(&p, b"x").unwrap();
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(946_684_800);
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(old).unwrap();
        assert_eq!(p.metadata().unwrap().modified().unwrap(), old);
        let got = recent_images(tmp.path(), since, 50);
        assert_eq!(got.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["downloaded.png"]);
        // Its reported time is still the file's own (it is what reloads the picture).
        assert!(got[0].modified_at.starts_with("2000-01-01"));
    }

    #[test]
    fn recent_images_takes_exactly_20_mb() {
        let tmp = tempfile::tempdir().unwrap();
        let f = std::fs::File::create(tmp.path().join("edge.png")).unwrap();
        f.set_len(IMAGE_MAX_BYTES).unwrap();
        let got = recent_images(tmp.path(), since_epoch(), 50);
        assert_eq!(got.iter().map(|i| (i.name.as_str(), i.size)).collect::<Vec<_>>(), [("edge.png", IMAGE_MAX_BYTES)]);
    }

    #[test]
    fn recent_images_stops_after_5000_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for i in 0..IMAGES_MAX_ENTRIES + 10 {
            std::fs::write(root.join(format!("f{i:05}.txt")), b"x").unwrap();
        }
        std::fs::create_dir(root.join("zz")).unwrap();
        std::fs::write(root.join("zz/late.png"), b"x").unwrap();
        // The root alone has more entries than the cap: the walk stops before it reaches `zz`.
        assert!(recent_images(root, since_epoch(), 50).is_empty());
        // With room under the cap for `zz` and its image, it is found.
        for i in 0..20 {
            std::fs::remove_file(root.join(format!("f{i:05}.txt"))).unwrap();
        }
        assert_eq!(recent_images(root, since_epoch(), 50).len(), 1);
    }

    #[test]
    fn latest_render_info_has_name_size_and_time() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(latest_render_info(tmp.path()), None);
        let renders = tmp.path().join("renders");
        std::fs::create_dir_all(&renders).unwrap();
        let before = chrono::Utc::now() - chrono::Duration::seconds(2);
        std::fs::write(renders.join("a.mp4"), b"abc").unwrap();
        let info = latest_render_info(tmp.path()).unwrap();
        assert_eq!(info.name, "a.mp4");
        assert_eq!(info.size, 3);
        assert!(info.path.ends_with("a.mp4"));
        let at = chrono::DateTime::parse_from_rfc3339(&info.modified_at).unwrap();
        assert!(at > before);
        assert!(info.modified_at.ends_with('Z'));
    }

    #[test]
    fn latest_render_skips_empty_files() {
        let tmp = tempfile::tempdir().unwrap();
        let renders = tmp.path().join("renders");
        std::fs::create_dir_all(&renders).unwrap();
        let good = renders.join("a.mp4");
        std::fs::write(&good, b"x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(renders.join("b.mp4"), b"").unwrap();
        assert_eq!(latest_render(tmp.path()), Some(good));
        std::fs::remove_file(renders.join("a.mp4")).unwrap();
        assert_eq!(latest_render(tmp.path()), None);
    }

    /// A project folder for render lookups: `w(rel, bytes, secs)` writes a file with that modification time.
    fn render_tree() -> (tempfile::TempDir, impl Fn(&str, &[u8], u64)) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let w = move |rel: &str, bytes: &[u8], secs: u64| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, bytes).unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000 + secs);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        };
        (tmp, w)
    }

    fn render_name(folder: &Path) -> Option<String> {
        latest_render(folder).map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
    }

    // ---- video thumbnails ----

    const THUMB_LIMIT: std::time::Duration = std::time::Duration::from_secs(20);

    /// A fake ffmpeg that writes its last argument (the output) and logs its arguments; ffprobe fails.
    #[cfg(unix)]
    fn fake_thumb_tools(dir: &Path) -> (MediaTools, PathBuf) {
        let log = dir.join("ffmpeg.log");
        let body = format!("echo \"$@\" >> '{}'\nfor last; do :; done\nprintf jpg > \"$last\"", log.display());
        let ffmpeg = script_tool(dir, "ffmpeg.sh", &body);
        let ffprobe = script_tool(dir, "ffprobe.sh", "exit 1");
        (MediaTools { ffmpeg, ffprobe }, log)
    }

    fn missing_tools() -> MediaTools {
        MediaTools { ffmpeg: PathBuf::from("/nonexistent/ffmpeg"), ffprobe: PathBuf::from("/nonexistent/ffprobe") }
    }

    /// Times in the past (2023): a complete render was last written a while ago.
    fn set_mtime(p: &Path, secs: u64) {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + secs);
        std::fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
    }

    fn thumb_names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        v.sort();
        v
    }

    #[test]
    fn thumb_time_is_1_s_or_a_tenth_of_a_short_video() {
        assert_eq!(thumb_time(Some(66.0)), 1.0);
        assert_eq!(thumb_time(Some(10.0)), 1.0);
        assert!((thumb_time(Some(5.0)) - 0.5).abs() < 1e-9);
        assert_eq!(thumb_time(None), 0.0);
    }

    #[test]
    fn no_render_or_no_ffmpeg_means_no_thumbnail() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("p");
        let thumbs = tmp.path().join("thumbs");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(video_thumbnail(&missing_tools(), &project, &thumbs, "p1", THUMB_LIMIT), None);
        std::fs::create_dir_all(project.join("renders")).unwrap();
        std::fs::write(project.join("renders/a.mp4"), b"x").unwrap();
        assert_eq!(video_thumbnail(&missing_tools(), &project, &thumbs, "p1", THUMB_LIMIT), None);
        assert!(thumb_names(&thumbs).is_empty(), "nothing half-made is left");
    }

    #[cfg(unix)]
    #[test]
    fn a_thumbnail_is_made_once_per_render_and_replaced_when_the_render_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let (tools, log) = fake_thumb_tools(tmp.path());
        let project = tmp.path().join("p");
        let thumbs = tmp.path().join("thumbs");
        let video = project.join("runs/jalur-rempah/out/video.mp4");
        std::fs::create_dir_all(video.parent().unwrap()).unwrap();
        std::fs::write(&video, b"x").unwrap();
        set_mtime(&video, 0);
        std::fs::create_dir_all(&thumbs).unwrap();
        std::fs::write(thumbs.join("other-1800000000000.jpg"), b"x").unwrap();

        // Miss: one ffmpeg run, 360 px wide, JPEG q 4.
        let first = video_thumbnail(&tools, &project, &thumbs, "p1", THUMB_LIMIT).unwrap();
        assert!(first.path.ends_with("p1-1700000000000.jpg"), "{}", first.path);
        assert_eq!(first.modified_at, "2023-11-14T22:13:20.000Z");
        assert_eq!(first.duration_sec, None, "this ffprobe can't read it");
        let args = std::fs::read_to_string(&log).unwrap();
        assert_eq!(args.lines().count(), 1);
        assert!(args.contains("-frames:v 1") && args.contains("scale=360:-2") && args.contains("-q:v 4"), "{args}");

        // Hit: the same render reuses it, even with no ffmpeg at all.
        let again = video_thumbnail(&missing_tools(), &project, &thumbs, "p1", THUMB_LIMIT).unwrap();
        assert_eq!(again, first);
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 1);

        assert_eq!(cached_video_thumbnail(&project, &thumbs, "p1"), Some(first.clone()));
        // A new render: a new thumbnail, the old one for this project gone, other projects' kept.
        set_mtime(&video, 60);
        assert_eq!(cached_video_thumbnail(&project, &thumbs, "p1"), None, "the new render has none yet");
        let next = video_thumbnail(&tools, &project, &thumbs, "p1", THUMB_LIMIT).unwrap();
        assert!(next.path.ends_with("p1-1700000060000.jpg"));
        assert_eq!(thumb_names(&thumbs), ["other-1800000000000.jpg", "p1-1700000060000.jpg"]);
    }

    /// Like `fake_thumb_tools`, with an ffprobe that reads every video but those named `partial`.
    #[cfg(unix)]
    fn fake_probing_tools(dir: &Path) -> (MediaTools, PathBuf) {
        let (mut tools, log) = fake_thumb_tools(dir);
        let json = r#"{"streams":[{"width":360,"height":640,"r_frame_rate":"30/1","nb_frames":"150"}],"format":{"duration":"5.0"}}"#;
        tools.ffprobe = script_tool(dir, "probe-ok.sh", &format!("case \"$*\" in *partial*) exit 1;; esac\necho '{json}'"));
        (tools, log)
    }

    #[cfg(unix)]
    #[test]
    fn the_thumbnail_comes_from_the_newest_complete_render_never_one_being_written() {
        let tmp = tempfile::tempdir().unwrap();
        let (tools, log) = fake_probing_tools(tmp.path());
        let project = tmp.path().join("p");
        let thumbs = tmp.path().join("thumbs");
        let w = |rel: &str, secs: Option<u64>| {
            let p = project.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"x").unwrap();
            if let Some(s) = secs {
                set_mtime(&p, s);
            }
        };
        w("renders/good.mp4", Some(0));
        // Newer, but ffprobe can't read it yet.
        w("runs/a/out/partial.mp4", Some(30));
        // Newest and readable, but written just now: still being written.
        w("out/fresh.mp4", None);
        let t = video_thumbnail(&tools, &project, &thumbs, "p1", THUMB_LIMIT).unwrap();
        assert!(t.path.ends_with("p1-1700000000000.jpg"), "{}", t.path);
        assert_eq!(t.duration_sec, Some(5.0));
        assert!(std::fs::read_to_string(&log).unwrap().contains("renders/good.mp4"));
        // Once it is done, it is the poster.
        set_mtime(&project.join("out/fresh.mp4"), 60);
        assert!(video_thumbnail(&tools, &project, &thumbs, "p1", THUMB_LIMIT).unwrap().path.ends_with("p1-1700000060000.jpg"));
    }

    #[cfg(unix)]
    #[test]
    fn without_a_complete_render_the_newest_file_is_used() {
        let tmp = tempfile::tempdir().unwrap();
        let (tools, log) = fake_probing_tools(tmp.path());
        let project = tmp.path().join("p");
        std::fs::create_dir_all(project.join("renders")).unwrap();
        std::fs::write(project.join("renders/partial-1.mp4"), b"x").unwrap();
        set_mtime(&project.join("renders/partial-1.mp4"), 0);
        std::fs::write(project.join("renders/partial-2.mp4"), b"x").unwrap();
        set_mtime(&project.join("renders/partial-2.mp4"), 10);
        let t = video_thumbnail(&tools, &project, &tmp.path().join("thumbs"), "p1", THUMB_LIMIT).unwrap();
        assert!(t.path.ends_with("p1-1700000010000.jpg"));
        assert_eq!(t.duration_sec, None);
        assert!(std::fs::read_to_string(&log).unwrap().contains("partial-2.mp4"));
    }

    #[test]
    fn two_lookups_at_once_never_share_a_temp_file() {
        assert_ne!(thumb_temp_name("p1", 5), thumb_temp_name("p1", 5));
        assert!(thumb_temp_name("p1", 5).starts_with(".p1-5."));
        assert!(thumb_temp_name("p1", 5).ends_with(".tmp.jpg"));
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_ffmpeg_gives_no_thumbnail_within_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let hang = script_tool(tmp.path(), "hang.sh", "exec sleep 30");
        let tools = MediaTools { ffmpeg: hang.clone(), ffprobe: hang };
        let project = tmp.path().join("p");
        std::fs::create_dir_all(project.join("renders")).unwrap();
        std::fs::write(project.join("renders/a.mp4"), b"x").unwrap();
        let started = std::time::Instant::now();
        let thumbs = tmp.path().join("thumbs");
        assert_eq!(video_thumbnail(&tools, &project, &thumbs, "p1", std::time::Duration::from_millis(500)), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(thumb_names(&thumbs).is_empty());
    }

    #[test]
    fn a_real_render_gets_a_360_px_jpeg_and_its_length() {
        let Some(t) = test_tools() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("p");
        make_source(&t, &project.join("renders"), "a.mp4");
        let thumb = video_thumbnail(&t, &project, &tmp.path().join("thumbs"), "p1", THUMB_LIMIT).unwrap();
        assert!((thumb.duration_sec.unwrap() - 5.0).abs() < 0.2);
        let info = probe(&t, Path::new(&thumb.path)).unwrap();
        assert_eq!(info.width, 360);
    }

    #[test]
    fn latest_render_finds_each_place_a_render_lands() {
        for rel in ["renders/a.mp4", "a.mp4", "out/a.mp4", "runs/jalur-rempah/out/a.mp4", "runs/jalur-rempah/v3/out/video.mp4"] {
            let (tmp, w) = render_tree();
            w(rel, b"x", 0);
            assert_eq!(latest_render(tmp.path()), Some(tmp.path().join(rel)), "{rel}");
        }
    }

    #[test]
    fn latest_render_is_the_newest_across_every_place() {
        let (tmp, w) = render_tree();
        w("renders/a.mp4", b"x", 10);
        w("b.mp4", b"x", 20);
        assert_eq!(render_name(tmp.path()).as_deref(), Some("b.mp4"), "the root's is newer than renders/");
        w("out/c.mp4", b"x", 30);
        assert_eq!(render_name(tmp.path()).as_deref(), Some("c.mp4"));
        w("runs/one/out/d.mp4", b"x", 40);
        w("runs/two/out/video.mp4", b"x", 50);
        assert_eq!(render_name(tmp.path()).as_deref(), Some("video.mp4"));
        w("renders/e.mp4", b"x", 60);
        assert_eq!(render_name(tmp.path()).as_deref(), Some("e.mp4"));
        // The same time: renders/ comes first.
        w("runs/two/out/video.mp4", b"x", 60);
        assert_eq!(render_name(tmp.path()).as_deref(), Some("e.mp4"));
    }

    #[test]
    fn latest_render_skips_other_folders_dependencies_dot_folders_and_deeper_files() {
        let (tmp, w) = render_tree();
        w("renders/kept.mp4", b"x", 0);
        for rel in [
            "public/clip.mp4",
            "src/x.mp4",
            "renders/sub/deeper.mp4",
            "out/sub/deeper.mp4",
            "runs/a/b/c/out/too-deep.mp4",
            "runs/a/b/out/sub/too-deep.mp4",
            "runs/a/node_modules/out/dep.mp4",
            "runs/a/.cache/out/dot.mp4",
            "runs/a/out/sub/too-deep.mp4",
            "runs/a/video.mp4",
            "runs/node_modules/out/dep.mp4",
            "runs/.cache/out/dot.mp4",
            "node_modules/out/dep.mp4",
            ".git/out/x.mp4",
            "runs/a/out/notes.txt",
            "runs/a/out/empty.mp4",
        ] {
            w(rel, if rel.ends_with("empty.mp4") { b"" } else { b"x" }, 100);
        }
        assert_eq!(render_name(tmp.path()).as_deref(), Some("kept.mp4"));
    }

    #[cfg(unix)]
    #[test]
    fn latest_render_never_follows_symlinks() {
        let (tmp, _) = render_tree();
        let outside = tempfile::tempdir().unwrap();
        let o = outside.path();
        std::fs::create_dir_all(o.join("out")).unwrap();
        std::fs::write(o.join("v.mp4"), b"x").unwrap();
        std::fs::write(o.join("out/v.mp4"), b"x").unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("runs/a")).unwrap();
        std::os::unix::fs::symlink(o, root.join("renders")).unwrap();
        std::os::unix::fs::symlink(o.join("out"), root.join("out")).unwrap();
        std::os::unix::fs::symlink(o, root.join("runs/linked")).unwrap();
        std::os::unix::fs::symlink(o.join("out"), root.join("runs/a/out")).unwrap();
        std::os::unix::fs::symlink(o, root.join("runs/a/v1")).unwrap();
        std::fs::create_dir_all(root.join("runs/a/v2")).unwrap();
        std::os::unix::fs::symlink(o.join("out"), root.join("runs/a/v2/out")).unwrap();
        std::os::unix::fs::symlink(o.join("v.mp4"), root.join("v.mp4")).unwrap();
        assert_eq!(latest_render(root), None);
        assert_eq!(newest_video_info(root), None);
    }

    #[test]
    fn newest_video_looks_in_the_same_places_and_counts_files_still_empty() {
        let (tmp, w) = render_tree();
        let root = tmp.path();
        assert_eq!(newest_video_info(root), None);
        w("renders/old.mp4", b"x", 0);
        w("runs/jalur-rempah/out/final.MP4", b"", 10);
        w("public/clip.mp4", b"x", 50);
        w("node_modules/pkg/demo.mp4", b"x", 50);
        let info = newest_video_info(root).unwrap();
        assert_eq!(info.name, "final.MP4");
        assert_eq!(info.size, 0, "a render that just started is still empty");
        // The finished-render lookup never takes an empty file.
        assert_eq!(render_name(root).as_deref(), Some("old.mp4"));
        // The owner's layout: one folder per version under the run.
        w("runs/jalur-rempah/v3/out/video.mp4", b"", 20);
        assert_eq!(newest_video_info(root).unwrap().path, root.join("runs/jalur-rempah/v3/out/video.mp4").to_string_lossy());
    }

    #[test]
    fn latest_render_falls_back_to_folder_root() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("out.mp4");
        std::fs::write(&f, b"x").unwrap();
        assert_eq!(latest_render(tmp.path()), Some(f));
    }

    #[test]
    fn render_args_sets_output_into_renders() {
        let folder = Path::new("proj dir");
        let args = render_args(folder);
        assert_eq!(&args[..3], ["-y", "hyperframes@0.9.10", "render"]);
        let i = args.iter().position(|a| a == "--output").unwrap();
        assert!(Path::new(&args[i + 1]).starts_with(folder.join("renders")));
        assert!(args[i + 1].ends_with(".mp4"));
    }

    #[test]
    fn render_plan_reads_tayang_json() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("my-video");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(render_plan(&folder, 1700).unwrap().is_none(), "no tayang.json means HyperFrames");
        std::fs::write(
            folder.join("tayang.json"),
            r#"{"engine":"remotion","render":["npx","remotion","render","src/index.ts","Geo","{output}","--gl=angle"],"install":["npm","install"],"readme":"STYLE.md"}"#,
        )
        .unwrap();
        let plan = render_plan(&folder, 1700).unwrap().unwrap();
        let out = Path::new("renders").join("my-video-1700.mp4");
        assert_eq!(plan.output, out);
        assert_eq!(
            plan.render,
            ["npx", "remotion", "render", "src/index.ts", "Geo", out.to_str().unwrap(), "--gl=angle"]
        );
        assert_eq!(plan.install.as_deref(), Some(&["npm".to_string(), "install".to_string()][..]));
        // Installed already: no install step.
        std::fs::create_dir_all(folder.join("node_modules")).unwrap();
        assert!(render_plan(&folder, 1700).unwrap().unwrap().install.is_none());
    }

    #[test]
    fn render_command_is_the_manifest_render_argv() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("v");
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(render_command(&folder, 5).unwrap(), None);
        std::fs::write(folder.join("tayang.json"), r#"{"render":["npx","remotion","render","{output}"]}"#).unwrap();
        let out = Path::new("renders").join("v-5.mp4");
        let plan = render_command(&folder, 5).unwrap().unwrap();
        assert_eq!(plan.render, ["npx", "remotion", "render", out.to_str().unwrap()]);
        assert_eq!(plan.install, None);
        std::fs::write(
            folder.join("tayang.json"),
            r#"{"render":["npx","remotion","render","{output}"],"install":["npm","install"]}"#,
        )
        .unwrap();
        let plan = render_command(&folder, 5).unwrap().unwrap();
        assert_eq!(plan.install, Some(vec!["npm".to_string(), "install".to_string()]));
        std::fs::create_dir_all(folder.join("node_modules")).unwrap();
        assert_eq!(render_command(&folder, 5).unwrap().unwrap().install, None, "installed already");
    }

    #[test]
    fn render_output_keeps_only_what_explains_the_failure() {
        let raw = "npm notice run npx\nnpm notice run ^\"hyperframes^\" render --quiet\n\n  Hyperframes collects usage data to improve the tool, anonymous until you sign in.\n  File paths and composition content are never collected.\n  If you sign in to HeyGen, your account (email and username) is linked to your usage.\n\n  Disable anytime: hyperframes telemetry disable\n\n\n\u{1b}[31mError: Timeout (30000ms)\u{1b}[39m exceeded\r\n";
        assert_eq!(clean_output(raw), "Error: Timeout (30000ms) exceeded");
        assert_eq!(clean_output("  \n"), "");
    }

    #[test]
    fn a_folder_with_nothing_to_render_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(render(tmp.path()).unwrap_err(), NOTHING_TO_RENDER);
    }

    #[test]
    fn install_may_be_written_as_one_command_line() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("tayang.json"), r#"{"render":"npx remotion render {output}","install":"npm install"}"#).unwrap();
        let plan = render_plan(tmp.path(), 1).unwrap().unwrap();
        assert_eq!(plan.install, Some(vec!["npm".to_string(), "install".to_string()]));
        assert_eq!(&plan.render[..3], ["npx", "remotion", "render"]);
        assert!(plan.render[3].ends_with(".mp4"));
    }

    #[test]
    fn a_render_without_an_mp4_says_what_the_tool_printed() {
        if crate::system::Exec::which(&crate::system::RealExec, "node").is_none() {
            eprintln!("skipping: node not found");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("tayang.json"),
            r#"{"render":["node","-e","console.log('Rendered to elsewhere/video.mp4')"]}"#,
        )
        .unwrap();
        let e = render(tmp.path()).unwrap_err();
        assert!(e.starts_with("render finished but no mp4 was found"), "{e}");
        assert!(e.contains("Rendered to elsewhere/video.mp4"), "{e}");
    }

    #[test]
    fn remotion_without_its_browser_can_use_chrome() {
        let e = "template render failed: TypeError: No browser found for rendering frames! Please open a GitHub issue";
        assert!(is_no_browser(e));
        assert!(!is_no_browser("template render failed: boom"));
        let argv: Vec<String> = ["npx", "remotion", "render", "src/index.ts", "Main", "out.mp4"].map(String::from).to_vec();
        assert!(is_remotion(&argv));
        assert!(!is_remotion(&["npx".to_string(), "hyperframes".to_string()]));
        let with = with_chrome(&argv, Path::new("/c/chrome"));
        assert_eq!(&with[..6], &argv[..]);
        assert_eq!(&with[6..], ["--browser-executable=/c/chrome", "--chrome-mode=chrome-for-testing"]);
        // A command that already names a browser is left alone.
        let named: Vec<String> = [&argv[..], &["--browser-executable=/x".to_string()]].concat();
        assert_eq!(with_chrome(&named, Path::new("/c/chrome")), named);
        assert_eq!(&browser_ensure(&argv), &["npx", "remotion", "browser", "ensure"]);
    }

    #[test]
    fn render_plan_rejects_bad_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("tayang.json"), r#"{"render":[]}"#).unwrap();
        assert!(render_plan(tmp.path(), 1).is_err());
        std::fs::write(tmp.path().join("tayang.json"), "nope").unwrap();
        assert!(render_plan(tmp.path(), 1).is_err());
    }

    #[test]
    fn render_runs_tayang_json_without_a_shell() {
        if crate::system::Exec::which(&crate::system::RealExec, "node").is_none() {
            eprintln!("skipping: node not found");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("p q");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("tayang.json"),
            r#"{"render":["node","-e","require('fs').writeFileSync(process.argv[1],'x')","{output}"]}"#,
        )
        .unwrap();
        let out = render(&folder).unwrap();
        assert!(out.exists());
        assert!(out.starts_with(folder.join("renders")));
    }

    #[test]
    fn render_plan_rejects_programs_outside_the_allow_list() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["sh", "./x", "/bin/sh", "curl", "../npx", "node/../sh", ""] {
            let m = format!(r#"{{"render":["{bad}","{{output}}"]}}"#);
            std::fs::write(tmp.path().join("tayang.json"), m).unwrap();
            let e = render_plan(tmp.path(), 1).unwrap_err();
            assert!(e.contains("which Tayang doesn't allow"), "{bad}: {e}");
        }
        std::fs::write(tmp.path().join("tayang.json"), r#"{"render":["npx","x"],"install":["sh","-c","x"]}"#).unwrap();
        assert!(render_plan(tmp.path(), 1).unwrap_err().contains("asks to run sh"));
        std::fs::write(tmp.path().join("tayang.json"), r#"{"render":["npx","x"],"install":[]}"#).unwrap();
        assert!(render_plan(tmp.path(), 1).is_err(), "empty install argv");
        for ok in ["npx", "npm", "node", "pnpm", "bun", "yarn"] {
            std::fs::write(tmp.path().join("tayang.json"), format!(r#"{{"render":["{ok}"]}}"#)).unwrap();
            assert!(render_plan(tmp.path(), 1).unwrap().is_some(), "{ok}");
        }
    }

    #[test]
    fn keeps_a_studys_reference_frames_and_copies_them_into_a_project() {
        let tmp = tempfile::tempdir().unwrap();
        let study = tmp.path().join("study");
        std::fs::create_dir_all(study.join("refs")).unwrap();
        for n in ["ref-2.jpg", "ref-1.jpg", "notes.txt", "empty.jpg"] {
            let bytes: &[u8] = if n == "empty.jpg" { b"" } else { b"jpg" };
            std::fs::write(study.join("refs").join(n), bytes).unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", study.join("refs").join("ref-9.jpg")).unwrap();
        let out = style_refs_dir(tmp.path(), "copied-1").unwrap();
        let kept = keep_style_refs(&study, &out).unwrap();
        let names: Vec<_> = kept.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["ref-1.jpg", "ref-2.jpg"]);

        let project = tmp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(copy_style_refs(&out, &project).unwrap(), 2);
        assert!(project.join("style-refs/ref-1.jpg").is_file());
        assert!(!project.join("style-refs/ref-9.jpg").exists());

        // A study without refs keeps the old ones; a style without refs copies none.
        assert!(keep_style_refs(&tmp.path().join("nothing"), &out).unwrap().is_empty());
        assert!(out.join("ref-1.jpg").is_file());
        assert_eq!(copy_style_refs(&tmp.path().join("none"), &project).unwrap(), 0);

        remove_style_media(tmp.path(), "copied-1");
        assert!(!out.exists());
        assert!(style_refs_dir(tmp.path(), "../x").is_none());
    }

}
