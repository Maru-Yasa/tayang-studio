//! AI images and voice for agents, paid with the user's Tayang credits. Tayang listens on
//! 127.0.0.1 (a random port) and gives each agent session `TAYANG_AI_URL` and its own
//! `TAYANG_AI_TOKEN`. The token is tied to that session's chat, so an agent can only save into its
//! own folder, and the user's sign-in token never leaves Tayang.
//!
//!   POST $TAYANG_AI_URL/image  { "prompt", "aspect"?, "count"?, "out"? }
//!   POST $TAYANG_AI_URL/voice  { "text", "language"?, "voice"?, "out"? }
//!
//! The answer is `{ "files": [...], "creditsCharged", "creditsLeft" }` with paths relative to the
//! agent's folder, or `{ "error": "<code>", "message" }`.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Requests are small JSON; anything bigger is refused.
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
const IMAGE_MAX_BYTES: u64 = 25 * 1024 * 1024;
const VOICE_MAX_BYTES: u64 = 60 * 1024 * 1024;

/// What a request asks for, once read and checked.
#[derive(Debug, Clone, PartialEq)]
pub enum AiJob {
    Image { prompt: String, aspect: Option<String>, count: u32, out: PathBuf },
    Voice { text: String, language: Option<String>, voice: Option<String>, out: PathBuf },
    /// `GET /usage`: the credits and auto-posts left, so the agent knows before it plans.
    Usage,
}

/// Does the work for a checked request: calls the API and saves into `folder`. Injected so the
/// server can be tested without the API.
pub type Runner = Arc<dyn Fn(AiJob, PathBuf) -> RunFuture + Send + Sync>;
/// Maps a chat to the folder its agent works in.
pub type FolderFor = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;
pub type RunFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, (u16, Value)>> + Send>>;

/// The running endpoint: its port and the token of each agent session.
pub struct AiProxy {
    pub port: u16,
    tokens: Mutex<HashMap<String, String>>,
}

impl AiProxy {
    /// A new token for `chat_id`'s session (any older one of the chat stops working), as the env
    /// vars the agent process gets.
    pub fn session_env(&self, chat_id: &str) -> Vec<(String, String)> {
        let token = format!("tai_{}", uuid::Uuid::new_v4().simple());
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        tokens.retain(|_, c| c != chat_id);
        tokens.insert(token.clone(), chat_id.to_string());
        vec![
            ("TAYANG_AI_URL".into(), format!("http://127.0.0.1:{}", self.port)),
            ("TAYANG_AI_TOKEN".into(), token),
        ]
    }

    fn chat_for(&self, token: &str) -> Option<String> {
        self.tokens.lock().unwrap_or_else(|e| e.into_inner()).get(token).cloned()
    }
}

/// Hands an agent's request to the app: `(chat, name, context)` with name `pick_topic` (start a video)
/// or `schedule_videos` (put videos on the calendar). The app asks the user; the agent only asks.
pub type Actor = Arc<dyn Fn(&str, &str, Value) + Send + Sync>;

/// `POST /video` and `POST /schedule`: what the agent sends, checked, as the app's action context.
pub fn parse_action(path: &str, b: &Value) -> Option<Result<(&'static str, Value), String>> {
    let text = |k: &str| b.get(k).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
    match path.split('?').next().unwrap_or("").trim_end_matches('/') {
        "/video" => Some((|| {
            let title = text("title").ok_or("title is required")?;
            if title.chars().count() > 120 {
                return Err("title must be 120 characters or fewer".into());
            }
            let mut ctx = json!({ "title": title });
            for k in ["kind", "styleId", "notes"] {
                if let Some(v) = text(k) {
                    ctx[k] = json!(v.chars().take(600).collect::<String>());
                }
            }
            if let Some(n) = b.get("lengthSec").and_then(Value::as_f64) {
                ctx["lengthSec"] = json!(n);
            }
            Ok(("pick_topic", ctx))
        })()),
        "/schedule" => Some((|| {
            let items = b.get("items").and_then(Value::as_array).ok_or("items must be a list")?;
            if items.is_empty() || items.len() > 20 {
                return Err("items must hold 1 to 20 videos".into());
            }
            Ok(("schedule_videos", json!({ "items": items })))
        })()),
        // The wizard checks every field again and the user confirms there: this only keeps it small.
        "/autopilot" => Some((|| {
            text("name").ok_or("name is required")?;
            if !b.is_object() || b.to_string().len() > 8 * 1024 {
                return Err("the autopilot must be a JSON object under 8 KB".into());
            }
            Ok(("create_autopilot", b.clone()))
        })()),
        _ => None,
    }
}

/// Starts listening; `folder_for` maps a chat to the folder its agent works in, `act` takes the
/// agent's /video and /schedule requests.
pub async fn start(
    folder_for: FolderFor,
    run: Runner,
    act: Actor,
) -> std::io::Result<Arc<AiProxy>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let proxy = Arc::new(AiProxy { port: listener.local_addr()?.port(), tokens: Mutex::default() });
    let p = proxy.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (p, folder_for, run, act) = (p.clone(), folder_for.clone(), run.clone(), act.clone());
            tokio::spawn(async move {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(300), serve(stream, &p, &*folder_for, &run, &act)).await;
            });
        }
    });
    Ok(proxy)
}

struct Request {
    method: String,
    path: String,
    token: Option<String>,
    body: Vec<u8>,
}

async fn read_request(s: &mut tokio::net::TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let read = async {
        loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..i]).to_string();
                let len = head
                    .lines()
                    .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("content-length")).map(|(_, v)| v.trim().parse::<usize>().ok()))
                    .flatten()
                    .unwrap_or(0);
                if len > MAX_BODY {
                    return None;
                }
                while buf.len() < i + 4 + len {
                    let n = s.read(&mut chunk).await.ok()?;
                    if n == 0 {
                        return None;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let mut first = head.lines().next().unwrap_or("").split(' ');
                let method = first.next().unwrap_or("").to_string();
                let path = first.next().unwrap_or("").to_string();
                let token = head.lines().find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.trim().eq_ignore_ascii_case("authorization").then(|| v.trim().strip_prefix("Bearer ").map(|t| t.trim().to_string()))?
                });
                return Some(Request { method, path, token, body: buf[i + 4..i + 4 + len].to_vec() });
            }
            if buf.len() > MAX_HEAD {
                return None;
            }
            let n = s.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), read).await.ok().flatten()
}

async fn respond(s: &mut tokio::net::TcpStream, status: u16, body: &Value) {
    let text = body.to_string();
    let res = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        if status < 400 { "OK" } else { "Error" },
        text.len()
    );
    let _ = s.write_all(res.as_bytes()).await;
    let _ = s.shutdown().await;
}

fn fail(code: &str, message: &str) -> Value {
    json!({ "error": code, "message": message })
}

async fn serve(mut s: tokio::net::TcpStream, proxy: &AiProxy, folder_for: &(dyn Fn(&str) -> Option<PathBuf> + Send + Sync), run: &Runner, act: &Actor) {
    let Some(req) = read_request(&mut s).await else {
        return respond(&mut s, 400, &fail("invalid", "Send a POST with a JSON body under 64 KB")).await;
    };
    let Some(chat) = req.token.as_deref().and_then(|t| proxy.chat_for(t)) else {
        return respond(&mut s, 401, &fail("unauthorized", "Use the TAYANG_AI_TOKEN this session was given")).await;
    };
    // /video and /schedule: Tayang asks the user; the agent's turn should end there.
    if req.method == "POST" {
        if let Ok(body @ Value::Object(_)) = serde_json::from_slice::<Value>(&req.body) {
            match parse_action(&req.path, &body) {
                Some(Ok((name, context))) => {
                    act(&chat, name, context);
                    let message = if name == "pick_topic" {
                        "Tayang is starting this video in its own chat. End your turn now: the video is made there."
                    } else if name == "create_autopilot" {
                        "Tayang is showing the user this autopilot to check and start. End your turn now; never say it is running until the user starts it."
                    } else {
                        "Tayang is showing the user these times to confirm. End your turn now; never say they are scheduled until the user confirms."
                    };
                    return respond(&mut s, 200, &json!({ "ok": true, "message": message })).await;
                }
                Some(Err(m)) => return respond(&mut s, 400, &fail("invalid", &m)).await,
                None => {}
            }
        }
    }
    let usage = req.path.split('?').next().unwrap_or("").trim_end_matches('/') == "/usage";
    if req.method != if usage { "GET" } else { "POST" } {
        return respond(&mut s, 405, &fail("invalid", if usage { "Use GET" } else { "Use POST" })).await;
    }
    let Some(folder) = folder_for(&chat) else {
        return respond(&mut s, 404, &fail("not-found", "This chat has no folder to save into")).await;
    };
    let body: Value = if usage {
        json!({})
    } else {
        match serde_json::from_slice(&req.body) {
            Ok(v @ Value::Object(_)) => v,
            _ => return respond(&mut s, 400, &fail("invalid", "The body must be a JSON object")).await,
        }
    };
    let job = match parse_job(&req.path, &body) {
        Ok(j) => j,
        Err(m) => return respond(&mut s, 400, &fail("invalid", &m)).await,
    };
    match run(job, folder).await {
        Ok(v) => respond(&mut s, 200, &v).await,
        Err((status, v)) => respond(&mut s, status, &v).await,
    }
}

/// A relative path inside the agent's folder with one of `exts`, or a default under `assets/ai/`.
fn out_path(v: Option<&Value>, default_stem: &str, exts: &[&str]) -> Result<PathBuf, String> {
    let Some(v) = v else {
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        return Ok(PathBuf::from("assets").join("ai").join(format!("{default_stem}-{stamp}.{}", exts[0])));
    };
    let s = v.as_str().filter(|s| !s.trim().is_empty()).ok_or("out must be a file path")?;
    let p = PathBuf::from(s);
    if p.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err("out must be a path inside your folder (no .., no absolute path)".into());
    }
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !exts.contains(&ext.as_str()) {
        return Err(format!("out must end in .{}", exts.join(" or .")));
    }
    Ok(p)
}

pub fn parse_job(path: &str, b: &Value) -> Result<AiJob, String> {
    let text = |k: &str| b.get(k).and_then(Value::as_str).map(str::to_string);
    match path.split('?').next().unwrap_or("").trim_end_matches('/') {
        "/usage" => Ok(AiJob::Usage),
        "/image" => {
            let prompt = text("prompt").filter(|p| !p.trim().is_empty()).ok_or("prompt is required")?;
            let count = match b.get("count") {
                None => 1,
                Some(c) => c.as_u64().filter(|n| (1..=4).contains(n)).ok_or("count is 1 to 4")? as u32,
            };
            Ok(AiJob::Image { prompt, aspect: text("aspect"), count, out: out_path(b.get("out"), "image", &["jpg", "jpeg"])? })
        }
        "/voice" => {
            let t = text("text").filter(|t| !t.trim().is_empty()).ok_or("text is required")?;
            Ok(AiJob::Voice { text: t, language: text("language"), voice: text("voice"), out: out_path(b.get("out"), "voice", &["mp3"])? })
        }
        _ => Err("Use /image or /voice".into()),
    }
}

/// `out`, or `out` with `-2`, `-3`… before the extension for the second and later images.
pub fn nth_path(out: &Path, i: usize) -> PathBuf {
    if i == 0 {
        return out.to_path_buf();
    }
    let stem = out.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = out.extension().and_then(|s| s.to_str()).unwrap_or("jpg");
    out.with_file_name(format!("{stem}-{}.{ext}", i + 1))
}

/// What the agent needs from `/v1/usage`: credits and auto-posts left (gifts included), and what
/// they buy, in one small object.
pub fn usage_summary(u: &Value) -> Value {
    let left = |m: &str| u.pointer(&format!("/{m}/remaining")).and_then(Value::as_i64).unwrap_or(0);
    let credits = left("credits");
    json!({
        "signedIn": true,
        "credits": credits,
        "posts": left("posts"),
        "imagesAffordable": credits,
        "voiceMinutesAffordable": credits / 7,
        "message": if credits > 0 {
            "Use Tayang's /image and /voice for AI pictures and every voice-over"
        } else {
            "No AI credits left: make videos without AI images or voice"
        },
    })
}

/// Runs a job against the Tayang API with `token` and saves the results into `folder`.
pub async fn run_job(client: &reqwest::Client, base: &str, token: &str, job: AiJob, folder: &Path) -> Result<Value, (u16, Value)> {
    use crate::cloud::{download, send, CloudError};
    let refused = |e: CloudError| {
        let status = match e {
            CloudError::SignedOut => 401,
            CloudError::PlanRequired => 403,
            CloudError::QuotaExceeded => 402,
            CloudError::Invalid => 400,
            CloudError::Unavailable => 503,
            _ => 502,
        };
        let message = match e {
            CloudError::SignedOut => "The user isn't signed in to Tayang: make this without AI images or voice",
            CloudError::PlanRequired => "The user's Tayang plan has no AI credits: make this without AI images or voice",
            CloudError::QuotaExceeded => "The user's AI credits for this month are used up: make this without AI images or voice",
            CloudError::Unavailable => "Tayang AI isn't available right now: try once more later, else make this without it",
            _ => "The AI provider failed: try once more, else make this without it",
        };
        (status, fail(&e.code(), message))
    };
    if let AiJob::Usage = job {
        return match crate::cloud::get(client, base, token, "/v1/usage").await {
            Ok(u) => Ok(usage_summary(&u)),
            Err(CloudError::SignedOut) => Ok(json!({
                "signedIn": false,
                "credits": 0,
                "posts": 0,
                "message": "The user isn't signed in to Tayang: there are no AI credits, so make videos without AI images or voice",
            })),
            Err(e) => Err(refused(e)),
        };
    }
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let (path, body, outs, max): (&str, Value, Vec<PathBuf>, u64) = match &job {
        AiJob::Image { prompt, aspect, count, out } => {
            let mut b = json!({ "prompt": prompt, "count": count, "clientRequestId": request_id });
            if let Some(a) = aspect {
                b["aspect"] = json!(a);
            }
            ("/v1/ai/image", b, (0..*count as usize).map(|i| nth_path(out, i)).collect(), IMAGE_MAX_BYTES)
        }
        AiJob::Voice { text, language, voice, out } => {
            let mut b = json!({ "text": text, "clientRequestId": request_id });
            if let Some(l) = language {
                b["language"] = json!(l);
            }
            if let Some(v) = voice {
                b["voice"] = json!(v);
            }
            ("/v1/ai/voice", b, vec![out.clone()], VOICE_MAX_BYTES)
        }
        AiJob::Usage => unreachable!("answered above"),
    };
    let answer = send(client, reqwest::Method::POST, base, token, path, Some(&body)).await.map_err(refused)?;
    let urls: Vec<String> = match &job {
        AiJob::Image { .. } => answer
            .get("images")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|i| i.get("url").and_then(Value::as_str).map(str::to_string)).collect())
            .unwrap_or_default(),
        AiJob::Voice { .. } => answer.get("audioUrl").and_then(Value::as_str).map(|u| vec![u.to_string()]).unwrap_or_default(),
        AiJob::Usage => Vec::new(),
    };
    if urls.is_empty() {
        return Err(refused(CloudError::Provider));
    }
    let mut files = Vec::new();
    for (url, rel) in urls.iter().zip(outs.iter()) {
        download(client, url, &folder.join(rel), max).await.map_err(refused)?;
        files.push(rel.to_string_lossy().replace('\\', "/"));
    }
    Ok(json!({
        "files": files,
        "creditsCharged": answer.get("creditsCharged").cloned().unwrap_or(Value::Null),
        "creditsLeft": answer.pointer("/usage/remaining").cloned().unwrap_or(Value::Null),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jobs_are_checked_and_paths_stay_inside_the_folder() {
        let img = parse_job("/image", &json!({ "prompt": "a cat", "out": "assets/cat.jpg", "count": 2 })).unwrap();
        assert_eq!(img, AiJob::Image { prompt: "a cat".into(), aspect: None, count: 2, out: "assets/cat.jpg".into() });
        assert!(parse_job("/image", &json!({ "prompt": " " })).is_err());
        assert!(parse_job("/image", &json!({ "prompt": "x", "count": 9 })).is_err());
        for bad in ["../x.jpg", "/etc/x.jpg", "assets/x.png", "a/../../x.jpg"] {
            assert!(parse_job("/image", &json!({ "prompt": "x", "out": bad })).is_err(), "{bad}");
        }
        let v = parse_job("/voice", &json!({ "text": "halo", "language": "id" })).unwrap();
        match v {
            AiJob::Voice { out, .. } => assert!(out.starts_with("assets/ai") && out.extension().unwrap() == "mp3"),
            _ => panic!(),
        }
        assert!(parse_job("/voice", &json!({ "text": "x", "out": "a.wav" })).is_err());
        assert_eq!(parse_action("/autopilot", &json!({ "name": "Kopi" })).unwrap().unwrap().0, "create_autopilot");
        assert!(parse_action("/autopilot", &json!({})).unwrap().is_err());
        assert!(parse_action("/autopilot", &json!({ "name": "Kopi", "niche": "x".repeat(9000) })).unwrap().is_err());
        assert!(parse_job("/video", &json!({})).is_err());
        assert_eq!(nth_path(Path::new("a/b.jpg"), 0), PathBuf::from("a/b.jpg"));
        assert_eq!(nth_path(Path::new("a/b.jpg"), 2), PathBuf::from("a/b-3.jpg"));
    }

    async fn post(port: u16, path: &str, token: Option<&str>, body: &str) -> (u16, Value) {
        request(port, "POST", path, token, body).await
    }

    async fn request(port: u16, method: &str, path: &str, token: Option<&str>, body: &str) -> (u16, Value) {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
        let req = format!("{method} {path} HTTP/1.1\r\nHost: x\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        let status = out.split(' ').nth(1).unwrap().parse().unwrap();
        let body = out.split("\r\n\r\n").nth(1).unwrap_or("null");
        (status, serde_json::from_str(body).unwrap())
    }

    #[tokio::test]
    async fn only_a_session_token_gets_in_and_jobs_run_in_its_folder() {
        let seen: Arc<Mutex<Vec<(AiJob, PathBuf)>>> = Arc::default();
        let rec = seen.clone();
        let run: Runner = Arc::new(move |job, folder| {
            rec.lock().unwrap().push((job, folder));
            Box::pin(async { Ok(json!({ "files": ["assets/a.jpg"] })) })
        });
        let acted: Arc<Mutex<Vec<(String, String, Value)>>> = Arc::default();
        let rec_act = acted.clone();
        let act: Actor = Arc::new(move |chat, name, ctx| rec_act.lock().unwrap().push((chat.into(), name.into(), ctx)));
        let proxy = start(Arc::new(|chat: &str| (chat == "c1").then(|| PathBuf::from("/p/c1"))), run, act).await.unwrap();
        let env = proxy.session_env("c1");
        assert_eq!(env[0].1, format!("http://127.0.0.1:{}", proxy.port));
        let token = env[1].1.clone();

        assert_eq!(post(proxy.port, "/image", None, "{}").await.0, 401);
        assert_eq!(post(proxy.port, "/image", Some("tai_wrong"), r#"{"prompt":"x"}"#).await.0, 401);
        let (status, body) = post(proxy.port, "/image", Some(&token), r#"{"prompt":"x","out":"../x.jpg"}"#).await;
        assert_eq!((status, body["error"].as_str()), (400, Some("invalid")));
        let (status, body) = post(proxy.port, "/image", Some(&token), r#"{"prompt":"a cat","out":"assets/a.jpg"}"#).await;
        assert_eq!((status, body["files"][0].as_str()), (200, Some("assets/a.jpg")));
        assert_eq!(seen.lock().unwrap()[0].1, PathBuf::from("/p/c1"));

        // A new session of the chat replaces its token.
        let again = proxy.session_env("c1")[1].1.clone();
        assert_eq!(post(proxy.port, "/image", Some(&token), r#"{"prompt":"x"}"#).await.0, 401);
        assert_eq!(post(proxy.port, "/voice", Some(&again), r#"{"text":"halo"}"#).await.0, 200);

        // Usage is a GET with no body; the jobs stay POST.
        assert_eq!(request(proxy.port, "GET", "/usage", Some(&again), "").await.0, 200);
        assert_eq!(seen.lock().unwrap().last().unwrap().0, AiJob::Usage);
        assert_eq!(post(proxy.port, "/usage", Some(&again), "{}").await.0, 405);
        assert_eq!(request(proxy.port, "GET", "/image", Some(&again), "").await.0, 405);
        assert_eq!(request(proxy.port, "GET", "/usage", None, "").await.0, 401);

        // The agent asks Tayang to start a video or to schedule: the app gets it, the agent a note to stop.
        let (status, body) = post(proxy.port, "/video", Some(&again), r#"{"title":" What if the Moon vanished ","kind":"explainer","lengthSec":60,"styleId":"cartoon-3d-world"}"#).await;
        assert_eq!(status, 200);
        assert!(body["message"].as_str().unwrap().contains("End your turn"));
        let (status, _) = post(proxy.port, "/schedule", Some(&again), r#"{"items":[{"title":"A","at":"2099-01-01T12:00:00+07:00"}]}"#).await;
        assert_eq!(status, 200);
        assert_eq!(post(proxy.port, "/video", Some(&again), r#"{"kind":"explainer"}"#).await.0, 400);
        assert_eq!(post(proxy.port, "/schedule", Some(&again), r#"{"items":[]}"#).await.0, 400);
        assert_eq!(post(proxy.port, "/video", None, r#"{"title":"x"}"#).await.0, 401);
        let acted = acted.lock().unwrap();
        assert_eq!(acted.len(), 2);
        assert_eq!((acted[0].0.as_str(), acted[0].1.as_str()), ("c1", "pick_topic"));
        assert_eq!(acted[0].2, json!({ "title": "What if the Moon vanished", "kind": "explainer", "lengthSec": 60.0, "styleId": "cartoon-3d-world" }));
        assert_eq!(acted[1].1, "schedule_videos");
    }

    #[test]
    fn usage_says_what_the_credits_buy() {
        let u = json!({ "credits": { "allowance": 30, "used": 2, "remaining": 28 }, "posts": { "allowance": 5, "used": 0, "remaining": 5 } });
        let s = usage_summary(&u);
        assert_eq!((s["signedIn"].as_bool(), s["credits"].as_i64(), s["posts"].as_i64()), (Some(true), Some(28), Some(5)));
        assert_eq!((s["imagesAffordable"].as_i64(), s["voiceMinutesAffordable"].as_i64()), (Some(28), Some(4)));
        let none = usage_summary(&json!({ "credits": { "remaining": 0 }, "posts": { "remaining": 0 } }));
        assert!(none["message"].as_str().unwrap().contains("without AI"));
    }
}
