//! Live preview: plays a project from its code, with no render. One Node process per open project runs
//! `packages/preview-server` (shipped as the `preview-server` resource) with the user's own Node; the
//! Preview panel loads its harness page in an iframe. This module picks the engine, starts and stops
//! those servers, and asks them for exact stills.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

type Result<T> = std::result::Result<T, String>;

pub const ENGINES: [&str; 2] = ["hyperframes", "remotion"];
const START_TIMEOUT: Duration = Duration::from_secs(20);
const STILL_TIMEOUT: Duration = Duration::from_secs(240);

fn engine_name(v: Option<&serde_json::Value>) -> Option<&'static str> {
    let s = v?.as_str()?.trim().to_ascii_lowercase();
    ENGINES.iter().copied().find(|e| *e == s)
}

/// The engine the preview plays the project with: `tayang.json` (`preview.engine`, then `engine`), then
/// the files (`remotion` in package.json → Remotion; an index.html with HyperFrames compositions →
/// HyperFrames). `None`: no live preview (another toolchain, or nothing built yet).
pub fn detect_engine(folder: &Path) -> Option<&'static str> {
    if let Ok(raw) = std::fs::read_to_string(folder.join("tayang.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(e) = engine_name(json.get("preview").and_then(|p| p.get("engine"))).or_else(|| engine_name(json.get("engine"))) {
                return Some(e);
            }
            // A template with its own render command and no engine: not something the preview can play.
            if json.get("render").is_some() {
                return None;
            }
        }
    }
    if let Ok(raw) = std::fs::read_to_string(folder.join("package.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            let has = |key: &str| json.get(key).and_then(|d| d.get("remotion")).is_some();
            if has("dependencies") || has("devDependencies") {
                return Some("remotion");
            }
        }
    }
    if folder.join("hyperframes.json").is_file() {
        return Some("hyperframes");
    }
    match std::fs::read_to_string(folder.join("index.html")) {
        Ok(html) if html.contains("data-composition-id") => Some("hyperframes"),
        _ => None,
    }
}

/// Changes in these never make the code newer than the render (the preview server ignores them too).
fn ignored(rel: &Path) -> bool {
    let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
    if ["renders", "out", "build", "dist", "snapshots"].contains(&first.as_str()) {
        return true;
    }
    let ext = rel.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    ["mp4", "mov", "webm", "log"].contains(&ext.as_str())
}

/// Whether a code file changed after `since` (the newest render). No render: always newer.
pub fn code_newer_than(folder: &Path, since: Option<SystemTime>) -> bool {
    let Some(since) = since else { return true };
    let mut newer = false;
    crate::media::walk_files(folder, |path, meta| {
        if newer {
            return;
        }
        let rel = path.strip_prefix(folder).unwrap_or(&path);
        if !ignored(rel) && meta.modified().map(|m| m > since).unwrap_or(false) {
            newer = true;
        }
    });
    newer
}

/// `packages/preview-server/src/server.mjs` from the repo in debug builds, else from the app resources.
pub fn server_script(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let dev = cfg!(debug_assertions).then(|| {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/preview-server/src/server.mjs")
    });
    dev.filter(|p| p.is_file())
        .or_else(|| resource_dir.map(|r| r.join("preview-server").join("src").join("server.mjs")).filter(|p| p.is_file()))
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ReadyLine {
    ready: bool,
    port: Option<u16>,
    token: Option<String>,
    control: Option<String>,
    error: Option<String>,
}

struct Running {
    child: Child,
    /// Closing it asks the server to quit (it closes Remotion's browser first).
    stdin: Option<ChildStdin>,
    port: u16,
    token: String,
    control: String,
    engine: &'static str,
    folder: PathBuf,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub url: String,
    pub engine: String,
}

/// The running preview servers, by project id.
#[derive(Default)]
pub struct PreviewServers(Mutex<HashMap<String, Running>>);

/// Parses the server's first stdout line.
fn parse_ready(line: &str) -> Result<(u16, String, String)> {
    let r: ReadyLine = serde_json::from_str(line.trim()).map_err(|_| format!("The preview server said: {}", line.trim()))?;
    match (r.ready, r.port, r.token, r.control) {
        (true, Some(port), Some(token), Some(control)) if !token.is_empty() && !control.is_empty() => Ok((port, token, control)),
        _ => Err(r.error.unwrap_or_else(|| "The preview server did not start".into())),
    }
}

fn stop_running(mut r: Running) {
    drop(r.stdin.take());
    std::thread::spawn(move || {
        for _ in 0..30 {
            if matches!(r.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = r.child.kill();
        let _ = r.child.wait();
    });
}

impl PreviewServers {
    /// Starts the project's server, or reuses the one running for the same folder and engine.
    pub fn start(&self, project_id: &str, folder: &Path, engine: &'static str, script: &Path) -> Result<Started> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = map.get_mut(project_id) {
            let alive = matches!(r.child.try_wait(), Ok(None));
            if alive && r.engine == engine && r.folder == folder {
                return Ok(Started { url: format!("http://127.0.0.1:{}/{}/", r.port, r.token), engine: engine.into() });
            }
            if let Some(old) = map.remove(project_id) {
                stop_running(old);
            }
        }
        let node = crate::system::Exec::which(&crate::system::RealExec, "node").ok_or("Live preview needs Node.js")?;
        let mut cmd = crate::media::command(node);
        cmd.arg(script)
            .arg("--project")
            .arg(folder)
            .arg("--engine")
            .arg(engine)
            .current_dir(folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Could not start the live preview: {e}"))?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            if let Some(Ok(first)) = lines.next() {
                let _ = tx.send(first);
            }
            // Keep draining so the server never blocks on a full pipe.
            for _ in lines {}
        });
        if let Some(err) = stderr {
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(std::result::Result::ok) {
                    eprintln!("[tayang] {line}");
                }
            });
        }
        let line = match rx.recv_timeout(START_TIMEOUT) {
            Ok(l) => l,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The live preview took too long to start".into());
            }
        };
        let (port, token, control) = match parse_ready(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let stdin = child.stdin.take();
        let url = format!("http://127.0.0.1:{port}/{token}/");
        map.insert(
            project_id.to_string(),
            Running { child, stdin, port, token, control, engine, folder: folder.to_path_buf() },
        );
        Ok(Started { url, engine: engine.into() })
    }

    pub fn stop(&self, project_id: &str) {
        let r = self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(project_id);
        if let Some(r) = r {
            stop_running(r);
        }
    }

    pub fn stop_all(&self) {
        let all: Vec<Running> = self.0.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, r)| r).collect();
        for r in all {
            stop_running(r);
        }
    }

    /// Asks the project's server for frame `frame` exactly as a render would draw it, written to `out`.
    pub async fn still(&self, project_id: &str, frame: u32, out: &Path) -> Result<PathBuf> {
        let (port, token, control) = {
            let map = self.0.lock().unwrap_or_else(|e| e.into_inner());
            let r = map.get(project_id).ok_or("The live preview is not running")?;
            (r.port, r.token.clone(), r.control.clone())
        };
        let client = reqwest::Client::builder().timeout(STILL_TIMEOUT).build().map_err(|e| e.to_string())?;
        let res = client
            .post(format!("http://127.0.0.1:{port}/{token}/still"))
            .query(&[("frame", frame.to_string()), ("out", out.to_string_lossy().into_owned())])
            .header("x-tayang-control", control)
            .send()
            .await
            .map_err(|e| format!("Could not reach the live preview: {e}"))?;
        let text = res.text().await.map_err(|e| e.to_string())?;
        let body: serde_json::Value = serde_json::from_str(&text).map_err(|_| format!("The live preview said: {text}"))?;
        if let Some(e) = body.get("error").and_then(|e| e.as_str()) {
            return Err(e.to_string());
        }
        if out.is_file() {
            Ok(out.to_path_buf())
        } else {
            Err("The live preview wrote no picture".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn detects_the_engine_from_tayang_json_first() {
        let d = dir();
        std::fs::write(d.path().join("tayang.json"), r#"{"render":["npm","run","render"],"engine":"Remotion"}"#).unwrap();
        assert_eq!(detect_engine(d.path()), Some("remotion"));
        std::fs::write(d.path().join("tayang.json"), r#"{"engine":"remotion","preview":{"engine":"hyperframes"}}"#).unwrap();
        assert_eq!(detect_engine(d.path()), Some("hyperframes"));
    }

    #[test]
    fn a_template_with_its_own_toolchain_has_no_live_preview() {
        let d = dir();
        std::fs::write(d.path().join("tayang.json"), r#"{"render":["npm","run","make"]}"#).unwrap();
        std::fs::write(d.path().join("index.html"), "<div data-composition-id=\"x\"></div>").unwrap();
        assert_eq!(detect_engine(d.path()), None);
    }

    #[test]
    fn detects_the_engine_from_the_files() {
        let d = dir();
        assert_eq!(detect_engine(d.path()), None);
        std::fs::write(d.path().join("index.html"), "<html>plain</html>").unwrap();
        assert_eq!(detect_engine(d.path()), None);
        std::fs::write(d.path().join("index.html"), "<div data-composition-id=\"main\"></div>").unwrap();
        assert_eq!(detect_engine(d.path()), Some("hyperframes"));
        std::fs::write(d.path().join("package.json"), r#"{"devDependencies":{"remotion":"4.0.0"}}"#).unwrap();
        assert_eq!(detect_engine(d.path()), Some("remotion"));
        let h = dir();
        std::fs::write(h.path().join("hyperframes.json"), "{}").unwrap();
        assert_eq!(detect_engine(h.path()), Some("hyperframes"));
    }

    #[test]
    fn code_is_newer_only_for_code_files_changed_after_the_render() {
        let d = dir();
        std::fs::create_dir_all(d.path().join("renders")).unwrap();
        std::fs::write(d.path().join("index.html"), "x").unwrap();
        assert!(code_newer_than(d.path(), None));
        let later = SystemTime::now() + Duration::from_secs(60);
        assert!(!code_newer_than(d.path(), Some(later)));
        let earlier = SystemTime::now() - Duration::from_secs(60);
        assert!(code_newer_than(d.path(), Some(earlier)));
        // Only renders and logs changed: not newer.
        let d2 = dir();
        std::fs::create_dir_all(d2.path().join("renders")).unwrap();
        std::fs::write(d2.path().join("renders").join("a.mp4"), "v").unwrap();
        std::fs::write(d2.path().join("render.log"), "l").unwrap();
        assert!(!code_newer_than(d2.path(), Some(earlier)));
    }

    /// Starts the real server (needs Node; skipped without it) on a HyperFrames folder.
    #[test]
    fn starts_reuses_and_stops_a_real_server() {
        if crate::system::Exec::which(&crate::system::RealExec, "node").is_none() {
            eprintln!("skipped: no node");
            return;
        }
        let script = server_script(None).expect("repo server script");
        let d = dir();
        std::fs::write(d.path().join("index.html"), "<div data-composition-id=\"main\"></div>").unwrap();
        let servers = PreviewServers::default();
        let started = servers.start("p1", d.path(), "hyperframes", &script).unwrap();
        assert!(started.url.starts_with("http://127.0.0.1:"));
        assert_eq!(servers.start("p1", d.path(), "hyperframes", &script).unwrap().url, started.url);
        let body = tauri::async_runtime::block_on(async {
            reqwest::get(&started.url).await.unwrap().text().await.unwrap()
        });
        assert!(body.contains("hyperframes-player"));
        servers.stop("p1");
        assert!(servers.0.lock().unwrap().is_empty());
    }

    #[test]
    fn reads_the_ready_line() {
        assert_eq!(
            parse_ready(r#"{"ready":true,"port":4000,"token":"t","control":"c"}"#).unwrap(),
            (4000, "t".into(), "c".into())
        );
        assert_eq!(parse_ready(r#"{"ready":false,"error":"no node_modules"}"#).unwrap_err(), "no node_modules");
        assert!(parse_ready("Error: boom").unwrap_err().contains("boom"));
        assert!(parse_ready(r#"{"ready":true,"port":4000,"token":"","control":"c"}"#).is_err());
    }
}
