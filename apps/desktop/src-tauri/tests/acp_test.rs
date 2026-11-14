//! Integration tests for the ACP client against `tests/fake_agent.mjs` (needs `node` on PATH).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tayang_studio_lib::acp::{AcpManager, AcpSink, AutoMethod, PromptPart, SessionOptions, UsageLog};
use tayang_studio_lib::types::{AgentQuestion, AgentUpdate, PermissionOptionKind, PermissionRequest, ToolCallStatus};

#[derive(Default)]
struct RecordingSink {
    updates: Mutex<Vec<(String, AgentUpdate)>>,
    permissions: Mutex<Vec<PermissionRequest>>,
    questions: Mutex<Vec<AgentQuestion>>,
}

impl AcpSink for RecordingSink {
    fn update(&self, chat_id: &str, u: AgentUpdate) {
        self.updates.lock().unwrap().push((chat_id.to_string(), u));
    }
    fn permission(&self, req: PermissionRequest) {
        self.permissions.lock().unwrap().push(req);
    }
    fn question(&self, q: AgentQuestion) {
        self.questions.lock().unwrap().push(q);
    }
}

impl RecordingSink {
    fn updates(&self) -> Vec<AgentUpdate> {
        self.updates.lock().unwrap().iter().map(|(_, u)| u.clone()).collect()
    }

    fn texts(&self) -> Vec<String> {
        self.updates()
            .into_iter()
            .filter_map(|u| match u {
                AgentUpdate::Text { text } => Some(text),
                _ => None,
            })
            .collect()
    }

    async fn wait_for(&self, what: &str, timeout: Duration, cond: impl Fn(&RecordingSink) -> bool) {
        let start = Instant::now();
        while !cond(self) {
            if start.elapsed() > timeout {
                panic!("timed out waiting for {what}; updates so far: {:?}", self.updates());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn wait_finished(&self) {
        self.wait_for("done or error", Duration::from_secs(10), |s| {
            s.updates()
                .iter()
                .any(|u| matches!(u, AgentUpdate::Done { .. } | AgentUpdate::Error { .. }))
        })
        .await;
    }

    async fn wait_question(&self) -> AgentQuestion {
        self.wait_for("question", Duration::from_secs(10), |s| !s.questions.lock().unwrap().is_empty()).await;
        self.questions.lock().unwrap()[0].clone()
    }

    async fn wait_permission(&self) -> PermissionRequest {
        self.wait_for("permission request", Duration::from_secs(10), |s| {
            !s.permissions.lock().unwrap().is_empty()
        })
        .await;
        self.permissions.lock().unwrap()[0].clone()
    }
}

fn fake_agent() -> Vec<String> {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fake_agent.mjs");
    vec!["node".to_string(), script.to_string_lossy().into_owned()]
}

/// A temp parent holding the session cwd, so "outside cwd" paths stay inside the temp dir.
struct Workspace {
    _root: tempfile::TempDir,
    parent: PathBuf,
    cwd: PathBuf,
}

fn workspace() -> Workspace {
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().to_path_buf();
    let cwd = parent.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    Workspace { _root: root, parent, cwd }
}

async fn started(chat: &str, ws: &Workspace) -> (AcpManager, Arc<RecordingSink>) {
    let manager = AcpManager::new();
    let sink = Arc::new(RecordingSink::default());
    manager
        .start(chat, &fake_agent(), &ws.cwd, sink.clone())
        .await
        .expect("agent starts");
    (manager, sink)
}

fn text(s: &str) -> AgentUpdate {
    AgentUpdate::Text { text: s.to_string() }
}

fn done(s: &str) -> AgentUpdate {
    AgentUpdate::Done { stop_reason: s.to_string() }
}

#[tokio::test]
async fn hello_streams_two_chunks_then_done() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("hello".into())]).await.unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.updates(), vec![text("Hel"), text("lo"), done("end_turn")]);
    assert!(sink.updates.lock().unwrap().iter().all(|(chat, _)| chat == "c1"));
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn thoughts_and_tool_statuses_are_mapped() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("think".into())]).await.unwrap();
    sink.wait_finished().await;
    let tool = |status| AgentUpdate::Tool {
        tool_call_id: "t9".into(),
        title: "Read brief".into(),
        status,
        tool_kind: Some("read".into()),
        path: None,
    };
    assert_eq!(
        sink.updates(),
        vec![
            AgentUpdate::Thought { text: "pondering".into() },
            tool(ToolCallStatus::Pending),
            tool(ToolCallStatus::Running),
            tool(ToolCallStatus::Done),
            done("end_turn"),
        ]
    );
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn a_question_reaches_the_user_and_their_answer_the_agent() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("question".into())]).await.unwrap();
    let q = sink.wait_question().await;
    assert_eq!((q.chat_id.as_str(), q.message.as_str()), ("c1", "Which topic?"));
    assert_eq!(q.schema["properties"]["topic"]["oneOf"][1]["title"], "Volcanoes");
    assert!(sink.texts().is_empty());
    manager
        .respond_question(&q.request_id, serde_json::json!({ "action": "accept", "content": { "topic": "b", "note": "short" } }))
        .unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec![r#"answer {"action":"accept","content":{"note":"short","topic":"b"}}"#.to_string()]);
    // Answered once only, and bad answers are refused.
    assert!(manager.respond_question(&q.request_id, serde_json::json!({ "action": "decline" })).is_err());
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn a_declined_question_and_one_left_open_by_a_stop() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("question".into())]).await.unwrap();
    let q = sink.wait_question().await;
    assert!(manager.respond_question(&q.request_id, serde_json::json!({ "action": "maybe" })).is_err());
    manager.respond_question(&q.request_id, serde_json::json!({ "action": "decline" })).unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec![r#"answer {"action":"decline"}"#.to_string()]);

    sink.updates.lock().unwrap().clear();
    sink.questions.lock().unwrap().clear();
    manager.prompt("c1", vec![PromptPart::Text("question".into())]).await.unwrap();
    sink.wait_question().await;
    manager.cancel("c1").await.unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec![r#"answer {"action":"cancel"}"#.to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn install_allowed_runs_after_permission() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("install".into())]).await.unwrap();
    let req = sink.wait_permission().await;
    assert_eq!(req.chat_id, "c1");
    assert_eq!(req.title, "Install FFmpeg");
    assert_eq!(req.commands, vec!["brew install ffmpeg".to_string()]);
    let kinds: Vec<_> = req.options.iter().map(|o| o.kind).collect();
    assert_eq!(kinds, vec![PermissionOptionKind::AllowOnce, PermissionOptionKind::RejectOnce]);
    assert_eq!(req.options[0].label, "Allow");
    // Nothing runs before the user answers.
    assert!(sink.texts().is_empty());

    let allow = req.options[0].id.clone();
    manager.respond_permission(&req.request_id, Some(allow)).unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec!["installed".to_string()]);
    assert!(sink.updates().contains(&done("end_turn")));
    assert!(sink.updates().contains(&AgentUpdate::Tool {
        tool_call_id: "t1".into(),
        title: "Install FFmpeg".into(),
        status: ToolCallStatus::Done,
        tool_kind: Some("execute".into()),
        path: None,
    }));
    // A request can be answered only once.
    assert!(manager.respond_permission(&req.request_id, None).is_err());
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn install_dismissed_is_cancelled_and_skipped() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("install".into())]).await.unwrap();
    let req = sink.wait_permission().await;
    manager.respond_permission(&req.request_id, None).unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec!["skipped".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn install_rejected_is_skipped() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("install".into())]).await.unwrap();
    let req = sink.wait_permission().await;
    let reject = req.options[1].id.clone();
    manager.respond_permission(&req.request_id, Some(reject)).unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec!["skipped".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn unknown_option_id_is_refused() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("install".into())]).await.unwrap();
    let req = sink.wait_permission().await;
    assert!(manager.respond_permission(&req.request_id, Some("made-up".into())).is_err());
    // The request is still open and can be answered properly.
    manager.respond_permission(&req.request_id, None).unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec!["skipped".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn crash_mid_turn_reports_error() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("crash".into())]).await.unwrap();
    sink.wait_for("error update", Duration::from_secs(5), |s| {
        s.updates().iter().any(|u| matches!(u, AgentUpdate::Error { .. }))
    })
    .await;
    assert_eq!(
        sink.updates().last().unwrap(),
        &AgentUpdate::Error { message: "The agent stopped unexpectedly".into() }
    );
    // The dead session refuses new prompts instead of hanging.
    assert!(manager.prompt("c1", vec![PromptPart::Text("hello".into())]).await.is_err());
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn fs_write_outside_cwd_is_refused() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("fs-outside".into())]).await.unwrap();
    sink.wait_finished().await;
    let texts = sink.texts();
    assert_eq!(texts.len(), 1, "{texts:?}");
    assert!(texts[0].starts_with("fs-error"), "{texts:?}");
    assert!(texts[0].contains("outside the project folder"), "{texts:?}");
    let leaked: Vec<_> = std::fs::read_dir(&ws.parent)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("tayang-outside"))
        .collect();
    assert!(leaked.is_empty(), "file written outside cwd");
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn fs_inside_cwd_writes_and_reads_lines() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("fs-inside".into())]).await.unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec!["read: \"two\\n\"".to_string()]);
    let written = std::fs::read_to_string(ws.cwd.join("notes").join("inside.txt")).unwrap();
    assert_eq!(written, "one\ntwo\nthree");
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn image_parts_are_sent_as_base64_with_mime() {
    let ws = workspace();
    let img = ws.cwd.join("frame.png");
    std::fs::write(&img, b"PNGDATA").unwrap();
    let (manager, sink) = started("c1", &ws).await;
    manager
        .prompt(
            "c1",
            vec![PromptPart::Image { path: img }, PromptPart::Text("look".into())],
        )
        .await
        .unwrap();
    sink.wait_finished().await;
    // base64("PNGDATA") == "UE5HREFUQQ=="
    assert_eq!(sink.texts(), vec!["image image/png UE5HREFUQQ==".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn missing_image_fails_the_prompt_call() {
    let ws = workspace();
    let (manager, _sink) = started("c1", &ws).await;
    let res = manager
        .prompt("c1", vec![PromptPart::Image { path: ws.cwd.join("nope.png") }])
        .await;
    assert!(res.is_err());
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn cancel_ends_turn_with_cancelled() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("wait".into())]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    manager.cancel("c1").await.unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.updates(), vec![done("cancelled")]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn cancel_answers_pending_permission_with_cancelled() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("install".into())]).await.unwrap();
    let req = sink.wait_permission().await;
    manager.cancel("c1").await.unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec!["skipped".to_string()]);
    assert_eq!(sink.updates().last().unwrap(), &done("cancelled"));
    assert!(manager.respond_permission(&req.request_id, None).is_err());
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn stop_cancels_pending_permission_and_ends_turn() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("install".into())]).await.unwrap();
    let req = sink.wait_permission().await;
    manager.stop("c1").await.unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.updates().last().unwrap(), &done("cancelled"));
    assert!(!sink.texts().contains(&"installed".to_string()));
    assert!(manager.respond_permission(&req.request_id, None).is_err());
    assert!(manager.prompt("c1", vec![PromptPart::Text("hello".into())]).await.is_err());
}

#[tokio::test]
async fn sessions_are_independent_per_chat() {
    let ws = workspace();
    let manager = AcpManager::new();
    let a = Arc::new(RecordingSink::default());
    let b = Arc::new(RecordingSink::default());
    manager.start("a", &fake_agent(), &ws.cwd, a.clone()).await.unwrap();
    manager.start("b", &fake_agent(), &ws.cwd, b.clone()).await.unwrap();
    manager.prompt("a", vec![PromptPart::Text("hello".into())]).await.unwrap();
    manager.prompt("b", vec![PromptPart::Text("think".into())]).await.unwrap();
    a.wait_finished().await;
    b.wait_finished().await;
    assert_eq!(a.texts(), vec!["Hel".to_string(), "lo".to_string()]);
    assert!(b.texts().is_empty());
    assert!(b.updates.lock().unwrap().iter().all(|(chat, _)| chat == "b"));
    manager.stop("a").await.unwrap();
    manager.stop("b").await.unwrap();
}

#[tokio::test]
async fn auth_required_on_session_new_says_sign_in() {
    let ws = workspace();
    let manager = AcpManager::new();
    let mut cmd = fake_agent();
    cmd.push("--needs-auth".into());
    let err = manager
        .start("c1", &cmd, &ws.cwd, Arc::new(RecordingSink::default()))
        .await
        .unwrap_err();
    assert_eq!(err.0, "The agent needs you to sign in first (Authentication required)");
}

#[tokio::test]
async fn an_agent_that_exits_at_start_says_what_it_printed() {
    let ws = workspace();
    let manager = AcpManager::new();
    let mut cmd = fake_agent();
    cmd.push("--crash".into());
    let err = manager
        .start("c1", &cmd, &ws.cwd, Arc::new(RecordingSink::default()))
        .await
        .unwrap_err();
    assert_eq!(err.0, "The agent exited before it was ready: Error: cannot find module 'opencode-windows-x64'");
}

#[tokio::test]
async fn prompt_error_carries_the_agent_message() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("fail".into())]).await.unwrap();
    sink.wait_finished().await;
    assert_eq!(
        sink.updates().last().unwrap(),
        &AgentUpdate::Error {
            message: "The agent reported an error: Internal error (quota exceeded)".into()
        }
    );
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn slow_start_times_out_with_a_helpful_message() {
    let ws = workspace();
    let manager = AcpManager::new().with_start_timeout(Duration::from_millis(500));
    let mut cmd = fake_agent();
    cmd.push("--hang".into());
    let err = manager
        .start("c1", &cmd, &ws.cwd, Arc::new(RecordingSink::default()))
        .await
        .unwrap_err();
    assert_eq!(
        err.0,
        "The agent took too long to start. Check your internet connection and try again"
    );
}

#[tokio::test]
async fn unknown_chat_and_bad_command_are_errors() {
    let ws = workspace();
    let manager = AcpManager::new();
    assert!(manager.prompt("nope", vec![PromptPart::Text("hello".into())]).await.is_err());
    let sink = Arc::new(RecordingSink::default());
    let bad = vec!["tayang-definitely-not-a-binary".to_string()];
    assert!(manager.start("c1", &bad, &ws.cwd, sink.clone()).await.is_err());
    assert!(manager.start("c1", &[], &ws.cwd, sink).await.is_err());
}

#[cfg(unix)]
fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(unix)]
async fn agent_pids(manager: &AcpManager, sink: &RecordingSink) -> Vec<String> {
    manager.prompt("c1", vec![PromptPart::Text("pids".into())]).await.unwrap();
    sink.wait_finished().await;
    let line = sink.texts().pop().unwrap();
    let pids: Vec<String> = line.split_whitespace().skip(1).map(str::to_string).collect();
    assert_eq!(pids.len(), 2, "{line}");
    assert!(pids.iter().all(|p| alive(p)));
    pids
}

#[cfg(unix)]
async fn wait_dead(pids: &[String]) {
    let start = Instant::now();
    while pids.iter().any(|p| alive(p)) {
        assert!(start.elapsed() < Duration::from_secs(5), "processes still alive: {pids:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn stop_kills_the_agent_and_its_helpers() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    let pids = agent_pids(&manager, &sink).await;
    manager.stop("c1").await.unwrap();
    wait_dead(&pids).await;
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_the_manager_kills_the_agent() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    let pids = agent_pids(&manager, &sink).await;
    drop(manager);
    wait_dead(&pids).await;
}

#[tokio::test]
async fn session_options_reach_the_agent_as_meta_and_env() {
    let ws = workspace();
    let manager = AcpManager::new();
    let sink = Arc::new(RecordingSink::default());
    let meta = serde_json::json!({
        "claudeCode": { "options": { "plugins": [{ "type": "local", "path": "/x/agent-plugin" }] } },
        "systemPrompt": { "append": "hi" }
    });
    let options = SessionOptions {
        meta: Some(meta.clone()),
        env: vec![("TAYANG_STUDIO".into(), "1".into())],
        ..Default::default()
    };
    manager
        .start_with("c1", &fake_agent(), &ws.cwd, sink.clone(), options)
        .await
        .expect("agent starts");
    manager.prompt("c1", vec![PromptPart::Text("whoami".into())]).await.unwrap();
    sink.wait_finished().await;
    let reply = sink.texts().join("");
    let json: serde_json::Value = serde_json::from_str(reply.strip_prefix("whoami ").unwrap()).unwrap();
    assert_eq!(json["meta"], meta);
    assert_eq!(json["env"], "1");
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn each_turn_appends_its_usage_to_the_usage_log() {
    let ws = workspace();
    let manager = AcpManager::new();
    let sink = Arc::new(RecordingSink::default());
    let path = ws.parent.join("agent-usage.jsonl");
    let log = UsageLog { path: path.clone(), agent: "claude".into(), kind: "project".into() };
    let options = SessionOptions { usage_log: Some(log), ..Default::default() };
    manager.start_with("c1", &fake_agent(), &ws.cwd, sink.clone(), options).await.expect("agent starts");
    manager.prompt("c1", vec![PromptPart::Text("usage".into())]).await.unwrap();
    sink.wait_finished().await;
    // A turn that reports nothing writes nothing.
    sink.updates.lock().unwrap().clear();
    manager.prompt("c1", vec![PromptPart::Text("hello".into())]).await.unwrap();
    sink.wait_finished().await;
    let lines: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 1);
    let line = &lines[0];
    assert_eq!(line["chat"], "c1");
    assert_eq!(line["kind"], "project");
    assert_eq!(line["agent"], "claude");
    assert_eq!(line["stop"], "end_turn");
    assert_eq!(line["usage"]["cachedReadTokens"], 4000);
    assert_eq!(line["used"], 5000);
    assert_eq!(line["cost"]["amount"], 0.01);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn plain_start_sends_no_meta_and_no_env() {
    let ws = workspace();
    let (manager, sink) = started("c1", &ws).await;
    manager.prompt("c1", vec![PromptPart::Text("whoami".into())]).await.unwrap();
    sink.wait_finished().await;
    let reply = sink.texts().join("");
    let json: serde_json::Value = serde_json::from_str(reply.strip_prefix("whoami ").unwrap()).unwrap();
    assert!(json["meta"].is_null());
    assert!(json["env"].is_null());
    manager.stop("c1").await.unwrap();
}

// ---- auto mode ----

/// Starts the fake agent; `claude` turns on the `session/set_mode` path (only Claude uses it).
async fn started_auto(
    chat: &str,
    ws: &Workspace,
    args: &[&str],
    claude: bool,
) -> (AcpManager, Arc<RecordingSink>) {
    let manager = AcpManager::new();
    let sink = Arc::new(RecordingSink::default());
    let mut command = fake_agent();
    command.extend(args.iter().map(|a| a.to_string()));
    let options = SessionOptions {
        use_modes: claude,
        mode_timeout: Some(Duration::from_millis(400)),
        ..Default::default()
    };
    manager.start_with(chat, &command, &ws.cwd, sink.clone(), options).await.expect("agent starts");
    (manager, sink)
}

async fn ask(manager: &AcpManager, sink: &RecordingSink, prompt: &str) {
    manager.prompt("c1", vec![PromptPart::Text(prompt.into())]).await.unwrap();
    sink.wait_finished().await;
}

fn ran_without_asking(sink: &RecordingSink) -> Vec<String> {
    sink.updates()
        .into_iter()
        .filter_map(|u| match u {
            AgentUpdate::Tool { title, status: ToolCallStatus::Done, .. }
                if title.starts_with("Ran without asking: ") =>
            {
                Some(title)
            }
            _ => None,
        })
        .collect()
}

/// Asks to run `ls -la` and returns what the agent saw: "ran" (approved) or a card was shown.
async fn ask_and_expect_auto(manager: &AcpManager, sink: &RecordingSink) {
    ask(manager, sink, "ask").await;
    assert!(sink.permissions.lock().unwrap().is_empty(), "no card in auto mode");
    assert_eq!(sink.texts().last().map(String::as_str), Some("ran"));
    assert_eq!(ran_without_asking(sink), vec!["Ran without asking: ls -la".to_string()]);
}

#[tokio::test]
async fn session_modes_are_tracked_and_set_mode_is_sent() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &[], true).await;
    let modes = manager.available_modes("c1").unwrap();
    assert!(modes.contains(&"auto".to_string()) && modes.contains(&"default".to_string()));
    manager.set_mode("c1", "plan").await.unwrap();
    ask(&manager, &sink, "mode").await;
    assert_eq!(sink.texts(), vec!["mode plan".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn claude_auto_on_uses_the_agents_auto_mode() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &[], true).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Mode);
    ask(&manager, &sink, "mode").await;
    assert_eq!(sink.texts(), vec!["mode auto".to_string()]);
    // The agent's mode handles it, so Tayang doesn't approve on its own: the card still shows.
    manager.prompt("c1", vec![PromptPart::Text("ask".into())]).await.unwrap();
    let req = sink.wait_permission().await;
    manager.respond_permission(&req.request_id, None).unwrap();
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn claude_auto_off_restores_default_mode() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &[], true).await;
    manager.set_auto("c1", true).await.unwrap();
    assert_eq!(manager.set_auto("c1", false).await.unwrap(), AutoMethod::Off);
    ask(&manager, &sink, "mode").await;
    assert_eq!(sink.texts(), vec!["mode default".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn clamped_auto_mode_falls_back_to_approving() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &["--clamp-auto"], true).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Approve);
    ask_and_expect_auto(&manager, &sink).await;
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn only_claude_uses_set_mode_other_agents_approve_from_tayang() {
    let ws = workspace();
    // This agent lists an "auto" mode, but it isn't Claude.
    let (manager, sink) = started_auto("c1", &ws, &[], false).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Approve);
    ask_and_expect_auto(&manager, &sink).await;
    manager.prompt("c1", vec![PromptPart::Text("mode".into())]).await.unwrap();
    sink.wait_for("mode reply", Duration::from_secs(10), |s| s.texts().iter().any(|t| t == "mode default")).await;
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn auto_falls_back_to_approving_when_auto_mode_is_missing() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &["--no-auto-mode"], true).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Approve);
    ask_and_expect_auto(&manager, &sink).await;
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn auto_falls_back_to_approving_when_set_mode_fails() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &["--bad-set-mode"], true).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Approve);
    ask_and_expect_auto(&manager, &sink).await;
    assert!(manager.set_mode("c1", "plan").await.unwrap_err().0.contains("mode not allowed"));
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn a_set_mode_that_never_answers_times_out_and_approves_from_tayang() {
    let ws = workspace();
    let started = Instant::now();
    let (manager, sink) = started_auto("c1", &ws, &["--hang-set-mode"], true).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Approve);
    assert!(started.elapsed() < Duration::from_secs(5));
    ask_and_expect_auto(&manager, &sink).await;
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn auto_approve_without_allow_once_shows_the_normal_card() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &["--no-modes"], false).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Approve);
    manager.prompt("c1", vec![PromptPart::Text("ask-reject-only".into())]).await.unwrap();
    let req = sink.wait_permission().await;
    assert_eq!(req.options.len(), 1);
    assert!(ran_without_asking(&sink).is_empty());
    manager.respond_permission(&req.request_id, None).unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec!["denied".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn turning_auto_off_restores_asking() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &["--no-modes"], false).await;
    manager.set_auto("c1", true).await.unwrap();
    assert_eq!(manager.set_auto("c1", false).await.unwrap(), AutoMethod::Off);
    manager.prompt("c1", vec![PromptPart::Text("ask".into())]).await.unwrap();
    let req = sink.wait_permission().await;
    assert!(ran_without_asking(&sink).is_empty());
    manager.respond_permission(&req.request_id, Some(req.options[0].id.clone())).unwrap();
    sink.wait_finished().await;
    assert_eq!(sink.texts(), vec!["ran".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn starting_with_auto_applies_it_before_the_first_prompt() {
    let ws = workspace();
    let manager = AcpManager::new();
    let sink = Arc::new(RecordingSink::default());
    let options = SessionOptions { auto: true, use_modes: true, ..Default::default() };
    manager.start_with("c1", &fake_agent(), &ws.cwd, sink.clone(), options).await.unwrap();
    ask(&manager, &sink, "mode").await;
    assert_eq!(sink.texts(), vec!["mode auto".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn concurrent_toggles_are_serialized_and_the_last_one_wins() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &["--slow-set-mode"], true).await;
    let (on, off) = tokio::join!(manager.set_auto("c1", true), manager.set_auto("c1", false));
    assert_eq!(on.unwrap(), AutoMethod::Mode);
    assert_eq!(off.unwrap(), AutoMethod::Off);
    ask(&manager, &sink, "mode").await;
    assert_eq!(sink.texts(), vec!["mode default".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn failing_to_leave_auto_mode_is_an_error_and_stops_the_session() {
    let ws = workspace();
    let (manager, _sink) = started_auto("c1", &ws, &["--bad-set-mode-default"], true).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Mode);
    let err = manager.set_auto("c1", false).await.unwrap_err();
    assert!(err.0.contains("cannot leave auto"), "{err}");
    // Fail closed: the session that may still be in auto mode is gone.
    assert!(manager.prompt("c1", vec![PromptPart::Text("hello".into())]).await.is_err());
}

#[tokio::test]
async fn off_after_a_clamp_sends_default() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &["--clamp-auto"], true).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Approve);
    assert_eq!(manager.set_auto("c1", false).await.unwrap(), AutoMethod::Off);
    ask(&manager, &sink, "mode").await;
    assert_eq!(sink.texts(), vec!["mode default".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn off_after_a_timed_out_set_mode_that_lands_late_sends_default() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &["--late-set-mode"], true).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Approve);
    // The agent finishes the switch after Tayang gave up waiting (no update, as the real adapter).
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(manager.set_auto("c1", false).await.unwrap(), AutoMethod::Off);
    ask(&manager, &sink, "mode").await;
    assert_eq!(sink.texts(), vec!["mode default".to_string()]);
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn a_switch_without_a_mode_update_is_taken_as_requested_and_off_restores_default() {
    let ws = workspace();
    let (manager, sink) = started_auto("c1", &ws, &["--no-mode-update"], true).await;
    assert_eq!(manager.set_auto("c1", true).await.unwrap(), AutoMethod::Mode);
    manager.prompt("c1", vec![PromptPart::Text("mode".into())]).await.unwrap();
    sink.wait_for("mode reply", Duration::from_secs(10), |s| s.texts().iter().any(|t| t == "mode auto")).await;
    assert_eq!(manager.set_auto("c1", false).await.unwrap(), AutoMethod::Off);
    manager.prompt("c1", vec![PromptPart::Text("mode".into())]).await.unwrap();
    sink.wait_for("mode reply", Duration::from_secs(10), |s| s.texts().iter().any(|t| t == "mode default")).await;
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn a_failed_off_stops_only_the_session_it_ran_on() {
    let ws = workspace();
    let manager = Arc::new(AcpManager::new());
    let sink = Arc::new(RecordingSink::default());
    let mut command = fake_agent();
    command.extend(["--slow-set-mode", "--bad-set-mode-default"].map(String::from));
    let options = || SessionOptions { use_modes: true, ..Default::default() };
    manager.start_with("c1", &command, &ws.cwd, sink.clone(), options()).await.unwrap();
    manager.set_auto("c1", true).await.unwrap();
    let m = manager.clone();
    let off = tokio::spawn(async move { m.set_auto("c1", false).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    // The chat moves to a new session while the old one is still leaving auto mode.
    manager.start_with("c1", &command, &ws.cwd, sink.clone(), options()).await.unwrap();
    assert!(off.await.unwrap().is_err());
    manager.prompt("c1", vec![PromptPart::Text("hello".into())]).await.expect("the new session is alive");
    manager.stop("c1").await.unwrap();
}

async fn started_with_model(ws: &Workspace, args: &[&str], model: Option<&str>) -> (AcpManager, Arc<RecordingSink>) {
    let manager = AcpManager::new();
    let sink = Arc::new(RecordingSink::default());
    let mut command = fake_agent();
    command.extend(args.iter().map(|a| a.to_string()));
    let options = SessionOptions { model: model.map(str::to_string), ..Default::default() };
    manager.start_with("c1", &command, &ws.cwd, sink.clone(), options).await.expect("agent starts");
    (manager, sink)
}

fn last_models(sink: &RecordingSink) -> Option<(Option<String>, Vec<String>)> {
    sink.updates().into_iter().rev().find_map(|u| match u {
        AgentUpdate::Models { current, options } => Some((current, options.into_iter().map(|o| o.value).collect())),
        _ => None,
    })
}

#[tokio::test]
async fn config_option_models_are_reported_and_switched() {
    let ws = workspace();
    let (manager, sink) = started_with_model(&ws, &["--config-models"], None).await;
    // Grouped options are flattened.
    assert_eq!(last_models(&sink), Some((Some("fast".into()), vec!["fast".into(), "smart-free".into()])));
    manager.set_model("c1", "smart-free").await.unwrap();
    assert_eq!(last_models(&sink).unwrap().0.as_deref(), Some("smart-free"));
    ask(&manager, &sink, "model").await;
    assert_eq!(sink.texts().last().map(String::as_str), Some("model smart-free"));
    // A model the agent didn't offer is refused before asking it.
    assert!(manager.set_model("c1", "made-up").await.is_err());
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn legacy_models_switch_with_set_model() {
    let ws = workspace();
    let (manager, sink) = started_with_model(&ws, &["--legacy-models"], None).await;
    assert_eq!(manager.models("c1").unwrap().unwrap().config_id, None);
    manager.set_model("c1", "smart-free").await.unwrap();
    ask(&manager, &sink, "model").await;
    assert_eq!(sink.texts().last().map(String::as_str), Some("model smart-free"));
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn a_session_starts_on_the_picked_model_when_offered() {
    let ws = workspace();
    let (manager, sink) = started_with_model(&ws, &["--config-models"], Some("smart-free")).await;
    assert_eq!(last_models(&sink).unwrap().0.as_deref(), Some("smart-free"));
    manager.stop("c1").await.unwrap();
    // A pick the agent no longer offers leaves its default, and the start still works.
    let (manager, sink) = started_with_model(&ws, &["--config-models"], Some("gone")).await;
    assert_eq!(last_models(&sink).unwrap().0.as_deref(), Some("fast"));
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn agents_without_models_report_none() {
    let ws = workspace();
    let (manager, sink) = started_with_model(&ws, &[], Some("fast")).await;
    assert!(manager.models("c1").unwrap().is_none());
    assert!(last_models(&sink).is_none());
    assert!(manager.set_model("c1", "fast").await.is_err());
    manager.stop("c1").await.unwrap();
}

// An agent the user left in plan mode only plans and never makes the video, and Tayang has no
// mode menu: a session that opens in plan mode is switched to the agent's working mode.
#[tokio::test]
async fn a_session_opened_in_plan_mode_leaves_it() {
    let ws = workspace();
    let (manager, sink) = started_with_model(&ws, &["--start-in-plan"], None).await;
    ask(&manager, &sink, "mode").await;
    assert_eq!(sink.texts().last().map(String::as_str), Some("mode default"));
    manager.stop("c1").await.unwrap();
}

// opencode reports its agents (build / plan) as a `mode` config option, not as `modes`.
#[tokio::test]
async fn an_opencode_session_opened_in_plan_leaves_it_for_build() {
    let ws = workspace();
    let (manager, sink) = started_with_model(&ws, &["--config-mode-plan", "--config-models"], None).await;
    ask(&manager, &sink, "mode").await;
    assert_eq!(sink.texts().last().map(String::as_str), Some("mode build"));
    // The model option is still the one reported.
    assert_eq!(last_models(&sink).unwrap().0.as_deref(), Some("fast"));
    manager.stop("c1").await.unwrap();
}

// Codex signed in with ChatGPT refuses some models ("The 'gpt-5.5' model is not supported when
// using Codex with a ChatGPT account"): the turn is sent again on a model the agent offers.
#[tokio::test]
async fn a_turn_refused_for_its_model_is_retried_on_another() {
    let ws = workspace();
    let (manager, sink) = started_with_model(&ws, &["--config-models", "--refuse-model"], None).await;
    ask(&manager, &sink, "model").await;
    assert_eq!(sink.texts().last().map(String::as_str), Some("model smart-free"));
    assert!(!sink.updates().iter().any(|u| matches!(u, AgentUpdate::Error { .. })));
    assert_eq!(last_models(&sink).unwrap().0.as_deref(), Some("smart-free"));
    manager.stop("c1").await.unwrap();
}

#[tokio::test]
async fn a_turn_refused_on_every_model_reports_the_refusal() {
    let ws = workspace();
    let (manager, sink) = started_with_model(&ws, &["--legacy-models", "--refuse-all-models"], None).await;
    ask(&manager, &sink, "hi").await;
    let error = sink.updates().into_iter().find_map(|u| match u {
        AgentUpdate::Error { message } => Some(message),
        _ => None,
    });
    assert!(error.unwrap().contains("not supported when using Codex"));
    manager.stop("c1").await.unwrap();
}
