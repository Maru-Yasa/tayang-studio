//! Agent Client Protocol client: drives the user's coding agent over stdio.
//!
//! Hand-rolled newline-delimited JSON-RPC 2.0 following the ACP v1 schema
//! (https://agentclientprotocol.com). One agent process per chat.

use crate::projects;
use crate::types::{
    AgentQuestion, AgentUpdate, ModelChoice, PermissionOption, PermissionOptionKind, PermissionRequest, ToolCallStatus,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpError(pub String);

impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AcpError {}

pub type Result<T> = std::result::Result<T, AcpError>;

/// Receives everything the agent streams back.
pub trait AcpSink: Send + Sync {
    fn update(&self, chat_id: &str, u: AgentUpdate);
    fn permission(&self, req: PermissionRequest);
    /// The agent asks the user something (`elicitation/create`). A sink that can't show it
    /// leaves it unanswered until the turn ends, which answers `cancel`.
    fn question(&self, _q: AgentQuestion) {}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptPart {
    Text(String),
    Image { path: PathBuf },
}

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;
const INTERNAL_ERROR: i64 = -32603;
const RESOURCE_NOT_FOUND: i64 = -32002;
/// ACP's "authentication required".
const AUTH_REQUIRED: i64 = -32000;
/// Local-only code for "the connection is gone"; never sent over the wire.
const CONNECTION_CLOSED: i64 = -1;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    fn closed() -> Self {
        Self::new(CONNECTION_CLOSED, "connection closed")
    }

    fn is_closed(&self) -> bool {
        self.code == CONNECTION_CLOSED
    }
}

type RpcResult = std::result::Result<Value, RpcError>;

/// One decoded line from the agent.
#[derive(Debug, PartialEq)]
enum Incoming {
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
    Response { id: u64, result: RpcResult },
}

/// A JSON-RPC error's message plus its `data` detail when the agent sent one.
fn error_text(err: &Value) -> String {
    let message = err.get("message").and_then(Value::as_str).unwrap_or("agent error").trim();
    let detail = match err.get("data") {
        Some(Value::String(s)) => Some(s.as_str()),
        Some(d) => ["message", "details", "error"].iter().find_map(|k| d.get(*k)?.as_str()),
        None => None,
    }
    .map(str::trim)
    .filter(|d| !d.is_empty() && *d != message);
    match detail {
        Some(d) => format!("{message} ({d})"),
        None => message.to_string(),
    }
}

fn parse_message(line: &str) -> Option<Incoming> {
    let mut v: Value = serde_json::from_str(line).ok()?;
    let obj = v.as_object_mut()?;
    let params = obj.remove("params").unwrap_or(Value::Null);
    match (obj.remove("method"), obj.remove("id")) {
        (Some(Value::String(method)), Some(id)) if !id.is_null() => {
            Some(Incoming::Request { id, method, params })
        }
        (Some(Value::String(method)), _) => Some(Incoming::Notification { method, params }),
        (None, Some(id)) => {
            let id = id.as_u64()?;
            let result = match obj.remove("error") {
                Some(err) if !err.is_null() => Err(RpcError::new(
                    err.get("code").and_then(Value::as_i64).unwrap_or(INTERNAL_ERROR),
                    error_text(&err),
                )),
                _ => Ok(obj.remove("result").unwrap_or(Value::Null)),
            };
            Some(Incoming::Response { id, result })
        }
        _ => None,
    }
}

#[derive(Default)]
struct Waiters {
    closed: bool,
    map: HashMap<u64, oneshot::Sender<RpcResult>>,
}

/// Outgoing half of the connection plus the table of in-flight requests.
struct Rpc {
    out: mpsc::UnboundedSender<String>,
    waiters: Mutex<Waiters>,
    next_id: AtomicU64,
}

impl Rpc {
    fn new(out: mpsc::UnboundedSender<String>) -> Self {
        Self { out, waiters: Mutex::new(Waiters::default()), next_id: AtomicU64::new(1) }
    }

    fn send(&self, msg: Value) -> std::result::Result<(), RpcError> {
        self.out.send(msg.to_string()).map_err(|_| RpcError::closed())
    }

    async fn request(&self, method: &str, params: Value) -> RpcResult {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut w = self.waiters.lock().unwrap();
            if w.closed {
                return Err(RpcError::closed());
            }
            w.map.insert(id, tx);
        }
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.send(msg) {
            self.waiters.lock().unwrap().map.remove(&id);
            return Err(e);
        }
        rx.await.unwrap_or_else(|_| Err(RpcError::closed()))
    }

    fn notify(&self, method: &str, params: Value) -> std::result::Result<(), RpcError> {
        if self.is_closed() {
            return Err(RpcError::closed());
        }
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn respond(&self, id: Value, result: RpcResult) {
        let msg = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(e) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": e.code, "message": e.message },
            }),
        };
        // A closed connection has nobody left to answer.
        let _ = self.send(msg);
    }

    fn resolve(&self, id: u64, result: RpcResult) {
        if let Some(tx) = self.waiters.lock().unwrap().map.remove(&id) {
            let _ = tx.send(result);
        }
    }

    fn is_closed(&self) -> bool {
        self.waiters.lock().unwrap().closed
    }

    /// Fails every in-flight request; later requests fail immediately.
    fn close(&self) {
        let drained: Vec<_> = {
            let mut w = self.waiters.lock().unwrap();
            w.closed = true;
            w.map.drain().map(|(_, tx)| tx).collect()
        };
        for tx in drained {
            let _ = tx.send(Err(RpcError::closed()));
        }
    }
}

async fn write_loop(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = rx.recv().await {
        let ok = stdin.write_all(line.as_bytes()).await.is_ok()
            && stdin.write_all(b"\n").await.is_ok()
            && stdin.flush().await.is_ok();
        if !ok {
            break;
        }
    }
}

/// How many of the agent's last stderr lines are kept, to say why it exited at start.
const STDERR_TAIL: usize = 8;

/// The agent's stderr is diagnostics only: drain it so the pipe never fills, keeping the last
/// few lines in `tail`.
async fn drain_stderr(stderr: impl AsyncRead + Unpin, label: String, tail: Arc<Mutex<VecDeque<String>>>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("[agent {label}] {line}");
        let line = line.trim();
        if !line.is_empty() {
            let mut t = tail.lock().unwrap();
            if t.len() == STDERR_TAIL {
                t.pop_front();
            }
            t.push_back(line.to_string());
        }
    }
}

/// "The agent exited before it was ready", with what it printed last, so the user (and we)
/// can see why: a missing runtime, a crash, a bad config.
fn exited_with(e: AcpError, tail: &VecDeque<String>) -> AcpError {
    if e.0 != EXITED_MESSAGE || tail.is_empty() {
        return e;
    }
    let said: Vec<&str> = tail.iter().map(String::as_str).collect();
    let mut said = said.join(" | ");
    if said.chars().count() > 400 {
        said = format!("…{}", said.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect::<String>());
    }
    AcpError(format!("{EXITED_MESSAGE}: {said}"))
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Extras for one agent session: `meta` is sent as `_meta` on `session/new`,
/// `env` is set on the agent process.
#[derive(Debug, Clone, Default)]
pub struct SessionOptions {
    pub meta: Option<Value>,
    pub env: Vec<(String, String)>,
    /// Start in auto mode: commands run without asking (see `AcpManager::set_auto`).
    pub auto: bool,
    /// Use the agent's own `auto` mode (`session/set_mode`) for auto mode. Only Claude's
    /// adapter has one that means "run commands without asking"; every other agent is
    /// approved by Tayang.
    pub use_modes: bool,
    /// How long `session/set_mode` may take before Tayang approves requests itself.
    pub mode_timeout: Option<Duration>,
    /// The model to switch to once the session is open, when the agent offers it.
    pub model: Option<String>,
    /// A log the agent writes its model errors to (opencode). Some agents log a failed model call
    /// and then never answer the prompt; while a turn runs, Tayang reads it and ends the turn with
    /// the error.
    pub error_log: Option<PathBuf>,
    /// Where each finished turn's token usage is appended, one JSON line per turn.
    pub usage_log: Option<UsageLog>,
}

/// A local log of what each turn cost, to see where an agent's tokens go.
#[derive(Debug, Clone)]
pub struct UsageLog {
    pub path: PathBuf,
    /// The agent's key, such as `claude`.
    pub agent: String,
    /// What the chat is for: `project`, `chat`, `setup`, `study` or `autopilot`.
    pub kind: String,
}

/// One usage log line, or None when the agent reported nothing. `usage` is the prompt result's
/// (tokens of this turn); `last` is the agent's latest `usage_update` (context size, cost).
pub fn usage_line(
    log: &UsageLog,
    chat_id: &str,
    model: Option<&str>,
    stop_reason: &str,
    usage: Option<&Value>,
    last: Option<&Value>,
    at: &str,
) -> Option<Value> {
    if usage.is_none() && last.is_none() {
        return None;
    }
    let mut line = json!({
        "at": at,
        "chat": chat_id,
        "kind": log.kind,
        "agent": log.agent,
        "model": model,
        "stop": stop_reason,
    });
    if let Some(u) = usage {
        line["usage"] = u.clone();
    }
    if let Some(l) = last {
        for key in ["used", "size", "cost"] {
            if let Some(v) = l.get(key) {
                line[key] = v.clone();
            }
        }
    }
    Some(line)
}

/// How auto mode was applied to a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoMethod {
    /// The agent's own `auto` mode (`session/set_mode`).
    Mode,
    /// Tayang answers permission requests with the allow-once option.
    Approve,
    /// Auto mode is off: every request is shown to the user.
    Off,
}

/// The agent's session modes, as reported by `session/new` (`modes`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ModeState {
    available: Vec<String>,
    current: Option<String>,
    /// Bumped by every `current_mode_update` the agent sends.
    updates: u64,
}

fn parse_modes(created: &Value) -> ModeState {
    let Some(modes) = created.get("modes") else { return ModeState::default() };
    ModeState {
        available: modes
            .get("availableModes")
            .and_then(Value::as_array)
            .map(|m| {
                m.iter().filter_map(|x| x.get("id")?.as_str().map(str::to_string)).collect()
            })
            .unwrap_or_default(),
        current: modes.get("currentModeId").and_then(Value::as_str).map(str::to_string),
        updates: 0,
    }
}

/// How to take a session out of plan mode, where the agent only plans and never makes the video
/// (Tayang has no mode menu to leave it). Agents report their mode as a `mode` config option
/// (opencode: build / plan) or as `modes` (Claude: default, plan, ...).
#[derive(Debug, Clone, PartialEq, Eq)]
enum LeavePlan {
    /// `session/set_config_option` with this config id and value.
    Config { id: String, value: String },
    /// `session/set_mode` with this mode id.
    Mode(String),
}

/// The working mode to use instead of plan: `build` (opencode), else `default`, else the first other one.
fn working_mode(ids: &[String]) -> Option<String> {
    ["build", "default"]
        .iter()
        .find(|w| ids.iter().any(|m| m == *w))
        .map(|w| w.to_string())
        .or_else(|| ids.iter().find(|m| *m != "plan").cloned())
}

/// What to switch to when a `session/new` result says the session is in plan mode.
fn leave_plan(created: &Value) -> Option<LeavePlan> {
    let config = created.get("configOptions").and_then(Value::as_array).and_then(|opts| {
        opts.iter().find(|o| {
            o.get("category").and_then(Value::as_str) == Some("mode") || o.get("id").and_then(Value::as_str) == Some("mode")
        })
    });
    if let Some(o) = config {
        if o.get("currentValue").and_then(Value::as_str) != Some("plan") {
            return None;
        }
        let values: Vec<String> = o
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|x| x.get("value")?.as_str().map(str::to_string))
            .collect();
        return Some(LeavePlan::Config { id: o.get("id")?.as_str()?.to_string(), value: working_mode(&values)? });
    }
    let modes = parse_modes(created);
    if modes.current.as_deref() != Some("plan") {
        return None;
    }
    working_mode(&modes.available).map(LeavePlan::Mode)
}

/// The models a session offers. Agents report them two ways: a `model` session config option
/// (`configOptions`, switched with `session/set_config_option`) or the older `models` field
/// (switched with `session/set_model`); `config_id` says which.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelState {
    pub config_id: Option<String>,
    pub current: Option<String>,
    pub options: Vec<ModelChoice>,
}

fn choice(v: &Value, value_key: &str) -> Option<ModelChoice> {
    let value = v.get(value_key)?.as_str()?.to_string();
    Some(ModelChoice {
        name: v.get("name").and_then(Value::as_str).unwrap_or(&value).to_string(),
        description: v.get("description").and_then(Value::as_str).map(str::to_string),
        value,
    })
}

/// The models in a `session/new` (or `session/set_config_option`) result, or a
/// `config_option_update`: the `model` config option first, else the `models` field.
pub fn parse_models(v: &Value) -> Option<ModelState> {
    let config = v.get("configOptions").and_then(Value::as_array).and_then(|opts| {
        opts.iter().find(|o| {
            o.get("category").and_then(Value::as_str) == Some("model") || o.get("id").and_then(Value::as_str) == Some("model")
        })
    });
    if let Some(o) = config {
        let mut options = Vec::new();
        for item in o.get("options").and_then(Value::as_array).into_iter().flatten() {
            // Options may come in named groups.
            match item.get("options").and_then(Value::as_array) {
                Some(group) => options.extend(group.iter().filter_map(|g| choice(g, "value"))),
                None => options.extend(choice(item, "value")),
            }
        }
        return Some(ModelState {
            config_id: o.get("id").and_then(Value::as_str).map(str::to_string),
            current: o.get("currentValue").and_then(Value::as_str).map(str::to_string),
            options,
        });
    }
    let models = v.get("models")?;
    Some(ModelState {
        config_id: None,
        current: models.get("currentModelId").and_then(Value::as_str).map(str::to_string),
        options: models
            .get("availableModels")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|m| choice(m, "modelId")).collect())
            .unwrap_or_default(),
    })
}

fn spawn_agent(command: &[String], cwd: &Path, env: &[(String, String)]) -> Result<Child> {
    let (program, args) = command
        .split_first()
        .ok_or_else(|| AcpError("No agent command was given".into()))?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .env("PATH", crate::system::augmented_path())
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Own process group, so stopping also reaches helpers such as the
    // package an `npx` launcher starts.
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
        .map_err(|e| AcpError(format!("Could not start the agent ({program}): {e}")))
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION: u64 = 1;
/// How long `session/set_mode` may take before Tayang approves requests itself.
const SET_MODE_TIMEOUT: Duration = Duration::from_secs(10);
const CRASH_MESSAGE: &str = "The agent stopped unexpectedly";
/// How long a stopped agent gets to exit after SIGTERM before SIGKILL.
const KILL_GRACE: Duration = Duration::from_millis(1500);
/// The first `npx` run downloads the agent's ACP adapter, which can take minutes.
const START_TIMEOUT: Duration = Duration::from_secs(300);
const START_TIMEOUT_MESSAGE: &str =
    "The agent took too long to start. Check your internet connection and try again";
/// After the process exits, how long to keep reading output it already wrote.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
struct ToolState {
    title: String,
    status: ToolCallStatus,
    raw_input: Option<Value>,
    /// ACP `kind` (read, edit, execute ...), remembered from the first update that has it.
    kind: Option<String>,
    /// The first `locations[].path`.
    path: Option<String>,
}

impl ToolState {
    fn new() -> Self {
        ToolState {
            title: "Tool call".into(),
            status: ToolCallStatus::Pending,
            raw_input: None,
            kind: None,
            path: None,
        }
    }

    fn apply(&mut self, call: &Value) {
        if let Some(title) = call.get("title").and_then(Value::as_str) {
            self.title = title.to_string();
        }
        if let Some(status) = call.get("status").and_then(Value::as_str).and_then(map_tool_status) {
            self.status = status;
        }
        if let Some(raw) = call.get("rawInput").filter(|v| !v.is_null()) {
            self.raw_input = Some(raw.clone());
        }
        if let Some(kind) = call.get("kind").and_then(Value::as_str) {
            self.kind = Some(kind.to_string());
        }
        if self.path.is_none() {
            self.path = call
                .get("locations")
                .and_then(Value::as_array)
                .and_then(|l| l.first())
                .and_then(|l| l.get("path"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
}

fn map_tool_status(s: &str) -> Option<ToolCallStatus> {
    match s {
        "pending" => Some(ToolCallStatus::Pending),
        "in_progress" => Some(ToolCallStatus::Running),
        "completed" => Some(ToolCallStatus::Done),
        "failed" => Some(ToolCallStatus::Failed),
        _ => None,
    }
}

fn map_option_kind(s: &str) -> Option<PermissionOptionKind> {
    match s {
        "allow_once" => Some(PermissionOptionKind::AllowOnce),
        "allow_always" => Some(PermissionOptionKind::AllowAlways),
        "reject_once" => Some(PermissionOptionKind::RejectOnce),
        "reject_always" => Some(PermissionOptionKind::RejectAlways),
        _ => None,
    }
}

/// The shell command a tool call wants to run: `rawInput.command` as a string,
/// or an argv array joined with spaces.
fn raw_command(raw_input: &Value) -> Option<String> {
    match raw_input.get("command")? {
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::Array(items) => {
            let words: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            (!words.is_empty()).then(|| words.join(" "))
        }
        _ => None,
    }
}

struct PendingPermission {
    session_uid: u64,
    option_ids: Vec<String>,
    answer: oneshot::Sender<Option<String>>,
}

struct PendingQuestion {
    session_uid: u64,
    /// The `elicitation/create` result: `{action: accept, content}`, `{action: decline}` or `{action: cancel}`.
    answer: oneshot::Sender<Value>,
}

/// Permission requests and questions waiting for the user, keyed by request id.
#[derive(Default)]
struct Permissions {
    pending: Mutex<HashMap<String, PendingPermission>>,
    questions: Mutex<HashMap<String, PendingQuestion>>,
}

impl Permissions {
    fn answer(&self, request_id: &str, option_id: Option<String>) -> Result<()> {
        let mut pending = self.pending.lock().unwrap();
        let entry = pending
            .get(request_id)
            .ok_or_else(|| AcpError("This permission request is no longer open".into()))?;
        if let Some(option) = &option_id {
            if !entry.option_ids.contains(option) {
                return Err(AcpError(format!("Unknown permission option: {option}")));
            }
        }
        let entry = pending.remove(request_id).expect("entry checked above");
        entry
            .answer
            .send(option_id)
            .map_err(|_| AcpError("This permission request is no longer open".into()))
    }

    /// Answers every open request of one session with `cancelled`.
    fn cancel_session(&self, session_uid: u64) {
        // Dropping the senders resolves the waiting tasks with `cancelled` / `cancel`.
        self.pending.lock().unwrap().retain(|_, p| p.session_uid != session_uid);
        self.questions.lock().unwrap().retain(|_, q| q.session_uid != session_uid);
    }

    /// Answers a question: `accept` (with `content`, an object of field values), `decline` or `cancel`.
    fn answer_question(&self, request_id: &str, response: Value) -> Result<()> {
        let action = response.get("action").and_then(Value::as_str).unwrap_or_default();
        let answer = match action {
            "accept" => {
                let content = response.get("content").cloned().unwrap_or_else(|| json!({}));
                if !content.is_object() {
                    return Err(AcpError("An answer's content must be an object".into()));
                }
                json!({ "action": "accept", "content": content })
            }
            "decline" | "cancel" => json!({ "action": action }),
            other => return Err(AcpError(format!("Unknown answer action: {other}"))),
        };
        let entry = self
            .questions
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or_else(|| AcpError("This question is no longer open".into()))?;
        let _ = entry.answer.send(answer);
        Ok(())
    }
}

fn content_text(content: &Value) -> Option<String> {
    (content.get("type")?.as_str()? == "text")
        .then(|| content.get("text")?.as_str().map(str::to_string))
        .flatten()
}

/// State shared by the reader, the supervisor and prompt tasks of one agent process.
struct SessionCore {
    uid: u64,
    chat_id: String,
    cwd: PathBuf,
    rpc: Rpc,
    sink: Arc<dyn AcpSink>,
    permissions: Arc<Permissions>,
    session_id: OnceLock<String>,
    modes: Mutex<ModeState>,
    /// The models the agent offers; None when it reports none.
    models: Mutex<Option<ModelState>>,
    /// Answer permission requests with allow-once instead of asking the user.
    auto_approve: AtomicBool,
    /// The user wants auto mode. While the agent's own `auto` mode isn't the current mode
    /// (it was clamped, or is still switching), Tayang approves requests itself.
    want_auto: AtomicBool,
    /// Tayang has asked the agent for its `auto` mode (even if the answer never came, or came
    /// late): turning auto off must then send `default`, whatever mode is tracked.
    requested_auto: AtomicBool,
    use_modes: bool,
    mode_timeout: Duration,
    /// Serializes `set_auto` calls of this session.
    auto_lock: tokio::sync::Mutex<()>,
    tools: Mutex<HashMap<String, ToolState>>,
    prompting: AtomicBool,
    stopping: AtomicBool,
    error_log: Option<PathBuf>,
    usage_log: Option<UsageLog>,
    /// The agent's latest `usage_update`, taken by the next finished turn.
    last_usage: Mutex<Option<Value>>,
}

impl SessionCore {
    fn emit(&self, u: AgentUpdate) {
        self.sink.update(&self.chat_id, u);
    }

    fn handle_line(self: &Arc<Self>, line: &str) {
        match parse_message(line) {
            Some(Incoming::Response { id, result }) => self.rpc.resolve(id, result),
            Some(Incoming::Notification { method, params }) if method == "session/update" => {
                self.on_session_update(&params);
            }
            Some(Incoming::Request { id, method, params }) => self.on_request(id, &method, params),
            Some(Incoming::Notification { .. }) | None => {}
        }
    }

    fn on_request(self: &Arc<Self>, id: Value, method: &str, params: Value) {
        match method {
            "session/request_permission" => self.on_permission(id, &params),
            "elicitation/create" => self.on_elicitation(id, &params),
            "fs/read_text_file" => self.rpc.respond(id, self.read_text_file(&params)),
            "fs/write_text_file" => self.rpc.respond(id, self.write_text_file(&params)),
            _ => self.rpc.respond(
                id,
                Err(RpcError::new(METHOD_NOT_FOUND, format!("Method not found: {method}"))),
            ),
        }
    }

    /// Forwards a permission request to the user and answers the agent once
    /// they choose (or with `cancelled` if the request is dropped).
    fn on_permission(self: &Arc<Self>, id: Value, params: &Value) {
        let empty = json!({});
        let call = params.get("toolCall").unwrap_or(&empty);
        let tool = self.merge_tool(call).map(|(_, state)| state);
        let title = call
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| tool.as_ref().map(|t| t.title.clone()))
            .unwrap_or_else(|| "The agent wants to use a tool".into());
        let command = call
            .get("rawInput")
            .and_then(raw_command)
            .or_else(|| tool.as_ref()?.raw_input.as_ref().and_then(raw_command));
        let options: Vec<PermissionOption> = params
            .get("options")
            .and_then(Value::as_array)
            .map(|opts| {
                opts.iter()
                    .filter_map(|o| {
                        Some(PermissionOption {
                            id: o.get("optionId")?.as_str()?.to_string(),
                            label: o.get("name")?.as_str()?.to_string(),
                            kind: map_option_kind(o.get("kind")?.as_str()?)?,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        if self.approving() {
            if let Some(allow) = options.iter().find(|o| o.kind == PermissionOptionKind::AllowOnce) {
                let what = command.clone().unwrap_or_else(|| title.clone());
                self.rpc.respond(
                    id,
                    Ok(json!({ "outcome": { "outcome": "selected", "optionId": allow.id } })),
                );
                self.emit(AgentUpdate::Tool {
                    tool_call_id: format!("auto-{}", uuid::Uuid::new_v4()),
                    title: format!("Ran without asking: {what}"),
                    status: ToolCallStatus::Done,
                    tool_kind: None,
                    path: None,
                });
                return;
            }
        }

        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.permissions.pending.lock().unwrap().insert(
            request_id.clone(),
            PendingPermission {
                session_uid: self.uid,
                option_ids: options.iter().map(|o| o.id.clone()).collect(),
                answer: tx,
            },
        );
        if self.rpc.is_closed() {
            self.permissions.cancel_session(self.uid);
        }
        let core = self.clone();
        tokio::spawn(async move {
            let outcome = match rx.await.ok().flatten() {
                Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
                None => json!({ "outcome": "cancelled" }),
            };
            core.rpc.respond(id, Ok(json!({ "outcome": outcome })));
        });
        self.sink.permission(PermissionRequest {
            chat_id: self.chat_id.clone(),
            request_id,
            commands: vec![command.unwrap_or_else(|| title.clone())],
            title,
            options,
        });
    }

    /// A question for the user (`elicitation/create`). Only form mode is shown; a URL elicitation
    /// (sign in somewhere) is declined. Unanswered when the turn ends: `cancel`.
    fn on_elicitation(self: &Arc<Self>, id: Value, params: &Value) {
        let form = params.get("mode").and_then(Value::as_str).unwrap_or("form") == "form";
        let schema = params.get("requestedSchema").cloned().unwrap_or(Value::Null);
        if !form || !schema.get("properties").is_some_and(Value::is_object) {
            self.rpc.respond(id, Ok(json!({ "action": "decline" })));
            return;
        }
        let message = params.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.permissions
            .questions
            .lock()
            .unwrap()
            .insert(request_id.clone(), PendingQuestion { session_uid: self.uid, answer: tx });
        if self.rpc.is_closed() {
            self.permissions.cancel_session(self.uid);
        }
        let core = self.clone();
        tokio::spawn(async move {
            let answer = rx.await.unwrap_or_else(|_| json!({ "action": "cancel" }));
            core.rpc.respond(id, Ok(answer));
        });
        self.sink.question(AgentQuestion { chat_id: self.chat_id.clone(), request_id, message, schema });
    }

    fn on_session_update(&self, params: &Value) {
        if let (Some(ours), Some(theirs)) =
            (self.session_id.get(), params.get("sessionId").and_then(Value::as_str))
        {
            if ours != theirs {
                return;
            }
        }
        let Some(update) = params.get("update") else { return };
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "agent_message_chunk" | "agent_thought_chunk" => {
                let Some(text) = update.get("content").and_then(content_text) else { return };
                self.emit(if kind == "agent_message_chunk" {
                    AgentUpdate::Text { text }
                } else {
                    AgentUpdate::Thought { text }
                });
            }
            "tool_call" | "tool_call_update" => {
                if let Some((id, state)) = self.merge_tool(update) {
                    self.emit(AgentUpdate::Tool {
                        tool_call_id: id,
                        title: state.title,
                        status: state.status,
                        tool_kind: state.kind,
                        path: state.path,
                    });
                }
            }
            "config_option_update" => {
                if let Some(fresh) = parse_models(update) {
                    *self.models.lock().unwrap() = Some(fresh);
                    self.emit_models();
                }
            }
            "usage_update" => {
                *self.last_usage.lock().unwrap() = Some(update.clone());
            }
            "current_mode_update" => {
                if let Some(mode) = update.get("currentModeId").and_then(Value::as_str) {
                    let mut modes = self.modes.lock().unwrap();
                    modes.current = Some(mode.to_string());
                    modes.updates += 1;
                }
            }
            _ => {}
        }
    }

    /// Whether Tayang answers permission requests itself: it is asked to, or the user wants
    /// auto mode but the agent isn't in its own `auto` mode.
    fn approving(&self) -> bool {
        self.auto_approve.load(Ordering::SeqCst)
            || (self.want_auto.load(Ordering::SeqCst)
                && self.modes.lock().unwrap().current.as_deref() != Some("auto"))
    }

    /// Merges a `tool_call` / `tool_call_update` (or a permission's `toolCall`)
    /// into the remembered state of that tool call and returns it.
    fn merge_tool(&self, call: &Value) -> Option<(String, ToolState)> {
        let id = call.get("toolCallId")?.as_str()?;
        let mut tools = self.tools.lock().unwrap();
        let state = tools.entry(id.to_string()).or_insert_with(ToolState::new);
        state.apply(call);
        Some((id.to_string(), state.clone()))
    }

    fn read_text_file(&self, params: &Value) -> RpcResult {
        let path = resolve_inside(&self.cwd, params.get("path"))?;
        let content = std::fs::read_to_string(&path).map_err(|e| io_error("read", &path, e))?;
        let line = params.get("line").and_then(Value::as_u64);
        let limit = params.get("limit").and_then(Value::as_u64);
        Ok(json!({ "content": slice_lines(&content, line, limit) }))
    }

    fn write_text_file(&self, params: &Value) -> RpcResult {
        let path = resolve_inside(&self.cwd, params.get("path"))?;
        let content = params
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::new(INVALID_PARAMS, "content is required"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_error("write", &path, e))?;
        }
        std::fs::write(&path, content).map_err(|e| io_error("write", &path, e))?;
        Ok(json!({}))
    }

    /// Opens the session; the answer says how to leave plan mode when it opened in it.
    async fn handshake(&self, meta: Option<Value>) -> Result<Option<LeavePlan>> {
        let init = self
            .rpc
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {
                        "fs": { "readTextFile": true, "writeTextFile": true },
                        "terminal": false,
                        // Questions with options (Claude's AskUserQuestion, opencode's question tool)
                        // come as `elicitation/create` forms that Tayang draws.
                        "elicitation": { "form": {} },
                    },
                    "clientInfo": {
                        "name": "tayang-studio",
                        "title": "Tayang Studio",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }),
            )
            .await
            .map_err(start_error)?;
        let version = init.get("protocolVersion").and_then(Value::as_u64);
        if version != Some(PROTOCOL_VERSION) {
            return Err(AcpError(format!(
                "This agent speaks an unsupported protocol version ({})",
                version.map_or_else(|| "unknown".to_string(), |v| v.to_string())
            )));
        }
        let mut new_params = json!({ "cwd": self.cwd.to_string_lossy(), "mcpServers": [] });
        if let Some(meta) = meta {
            new_params["_meta"] = meta;
        }
        let created = self
            .rpc
            .request("session/new", new_params)
            .await
            .map_err(start_error)?;
        let session_id = created
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| AcpError("The agent did not open a session".into()))?;
        let _ = self.session_id.set(session_id.to_string());
        *self.modes.lock().unwrap() = parse_modes(&created);
        *self.models.lock().unwrap() = parse_models(&created);
        Ok(leave_plan(&created))
    }

    /// Switches a session that opened in plan mode to the agent's working mode.
    async fn leave_plan(&self, how: LeavePlan) -> Result<()> {
        match how {
            LeavePlan::Mode(id) => self.set_mode(&id).await,
            LeavePlan::Config { id, value } => {
                let sent = self.rpc.request(
                    "session/set_config_option",
                    json!({ "sessionId": self.session_id(), "configId": id, "value": value }),
                );
                match tokio::time::timeout(self.mode_timeout, sent).await {
                    Err(_) => Err(AcpError("The agent did not answer the mode change".into())),
                    Ok(Err(e)) => Err(AcpError(e.message)),
                    Ok(Ok(_)) => Ok(()),
                }
            }
        }
    }

    /// Tells the UI the session's models (nothing when the agent reports none).
    fn emit_models(&self) {
        let state = self.models.lock().unwrap().clone();
        if let Some(m) = state {
            self.emit(AgentUpdate::Models { current: m.current, options: m.options });
        }
    }

    /// Switches the session's model; the error text is the agent's message. A value the agent
    /// didn't offer is refused before asking it.
    async fn set_model(&self, value: &str) -> Result<()> {
        let config_id = {
            let models = self.models.lock().unwrap();
            let m = models.as_ref().ok_or_else(|| AcpError("This agent doesn't let Tayang pick its model".into()))?;
            if !m.options.iter().any(|o| o.value == value) {
                return Err(AcpError(format!("This agent doesn't offer the model {value}")));
            }
            m.config_id.clone()
        };
        let session_id = self.session_id().to_string();
        let reply = match &config_id {
            Some(id) => {
                self.rpc
                    .request("session/set_config_option", json!({ "sessionId": session_id, "configId": id, "value": value }))
                    .await
            }
            None => self.rpc.request("session/set_model", json!({ "sessionId": session_id, "modelId": value })).await,
        }
        .map_err(|e| AcpError(e.message))?;
        {
            let mut models = self.models.lock().unwrap();
            // The reply may carry the options as they are now; otherwise the pick is the current one.
            match parse_models(&reply) {
                Some(fresh) if fresh.current.is_some() => *models = Some(fresh),
                _ => {
                    if let Some(m) = models.as_mut() {
                        m.current = Some(value.to_string());
                    }
                }
            }
        }
        self.emit_models();
        Ok(())
    }

    /// `session/set_mode`; the error text is the agent's message. Gives up after the
    /// session's mode timeout.
    async fn set_mode(&self, mode_id: &str) -> Result<()> {
        let before = self.modes.lock().unwrap().updates;
        let sent = self
            .rpc
            .request("session/set_mode", json!({ "sessionId": self.session_id(), "modeId": mode_id }));
        match tokio::time::timeout(self.mode_timeout, sent).await {
            Err(_) => return Err(AcpError("The agent did not answer the mode change".into())),
            Ok(Err(e)) if e.is_closed() => return Err(AcpError("The agent is not running".into())),
            Ok(Err(e)) => return Err(AcpError(e.message)),
            Ok(Ok(_)) => {}
        }
        // The agent reports the mode it really ended up in (`current_mode_update`); only
        // assume the requested one when it said nothing.
        let mut modes = self.modes.lock().unwrap();
        if modes.updates == before {
            modes.current = Some(mode_id.to_string());
        }
        Ok(())
    }

    fn has_mode(&self, mode_id: &str) -> bool {
        self.modes.lock().unwrap().available.iter().any(|m| m == mode_id)
    }

    /// Turns auto mode on or off. Calls are serialized per session. Turning it off fails
    /// (and the caller must stop the session) when the agent can't leave its auto mode.
    async fn set_auto(&self, on: bool) -> Result<AutoMethod> {
        let _turn = self.auto_lock.lock().await;
        if !on {
            self.want_auto.store(false, Ordering::SeqCst);
            self.auto_approve.store(false, Ordering::SeqCst);
            let asked = self.requested_auto.load(Ordering::SeqCst);
            let in_auto = self.modes.lock().unwrap().current.as_deref() == Some("auto");
            if self.use_modes && (asked || in_auto) {
                // Idempotent, so it is sent even when the tracked mode says it isn't needed: a
                // clamp, a late answer or a missing update can all leave it out of date.
                if !self.has_mode("default") {
                    return Err(AcpError("The agent has no mode to leave auto mode with".into()));
                }
                self.set_mode("default").await?;
                self.requested_auto.store(false, Ordering::SeqCst);
            }
            return Ok(AutoMethod::Off);
        }
        self.want_auto.store(true, Ordering::SeqCst);
        if self.use_modes && self.has_mode("auto") {
            self.requested_auto.store(true, Ordering::SeqCst);
            match self.set_mode("auto").await {
                Ok(()) if self.modes.lock().unwrap().current.as_deref() == Some("auto") => {
                    self.auto_approve.store(false, Ordering::SeqCst);
                    return Ok(AutoMethod::Mode);
                }
                Ok(()) => eprintln!(
                    "[agent {}] the agent did not stay in auto mode; approving requests from Tayang",
                    self.chat_id
                ),
                Err(e) => eprintln!(
                    "[agent {}] auto mode unavailable ({e}); approving requests from Tayang",
                    self.chat_id
                ),
            }
        }
        self.auto_approve.store(true, Ordering::SeqCst);
        Ok(AutoMethod::Approve)
    }

    fn session_id(&self) -> &str {
        self.session_id.get().map(String::as_str).unwrap_or_default()
    }

    /// Runs one `session/prompt` turn and reports how it ended.
    async fn run_turn(&self, prompt: Vec<Value>) {
        let request = self.rpc.request("session/prompt", json!({ "sessionId": self.session_id(), "prompt": prompt }));
        let res = match &self.error_log {
            None => request.await,
            Some(log) => {
                let from = std::fs::metadata(log).map(|m| m.len()).unwrap_or(0);
                tokio::select! {
                    r = request => r,
                    message = watch_error_log(log.clone(), from, self.session_id().to_string()) => {
                        // The agent won't answer this turn: stop it, and say why.
                        let _ = self.rpc.notify("session/cancel", json!({ "sessionId": self.session_id() }));
                        self.permissions.cancel_session(self.uid);
                        self.prompting.store(false, Ordering::SeqCst);
                        self.emit(AgentUpdate::Error { message });
                        return;
                    }
                }
            }
        };
        self.prompting.store(false, Ordering::SeqCst);
        let update = match res {
            Ok(v) => {
                let stop_reason = v.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn").to_string();
                self.log_usage(&stop_reason, v.get("usage"));
                AgentUpdate::Done { stop_reason }
            }
            Err(e) if e.is_closed() => {
                if self.stopping.load(Ordering::SeqCst) {
                    AgentUpdate::Done { stop_reason: "cancelled".into() }
                } else {
                    AgentUpdate::Error { message: CRASH_MESSAGE.into() }
                }
            }
            Err(e) if e.code == AUTH_REQUIRED => AgentUpdate::Error { message: auth_message(&e) },
            Err(e) => AgentUpdate::Error { message: format!("The agent reported an error: {}", e.message) },
        };
        self.emit(update);
    }

    /// Appends this turn's usage to the usage log. Best effort: a failed write is ignored.
    fn log_usage(&self, stop_reason: &str, usage: Option<&Value>) {
        let Some(log) = &self.usage_log else { return };
        let last = self.last_usage.lock().unwrap().take();
        let model = self.models.lock().unwrap().as_ref().and_then(|m| m.current.clone());
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let Some(line) = usage_line(log, &self.chat_id, model.as_deref(), stop_reason, usage, last.as_ref(), &at) else {
            return;
        };
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log.path) {
            let _ = writeln!(f, "{line}");
        }
    }

    /// Called once the agent's output is finished (or the process is gone).
    fn on_closed(&self) {
        self.rpc.close();
        self.permissions.cancel_session(self.uid);
    }
}

/// Resolves an agent-supplied path and refuses anything outside `cwd`, including
/// paths that escape through a symlinked folder that already exists.
fn resolve_inside(cwd: &Path, raw: Option<&Value>) -> std::result::Result<PathBuf, RpcError> {
    let raw = raw
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "path is required"))?;
    let p = Path::new(raw);
    let full = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    let outside = || RpcError::new(INVALID_PARAMS, format!("{raw} is outside the project folder"));
    if !projects::ensure_inside(cwd, &full) {
        return Err(outside());
    }
    let existing = full.ancestors().find(|a| a.exists());
    if let (Some(existing), Ok(root)) = (existing, std::fs::canonicalize(cwd)) {
        match std::fs::canonicalize(existing) {
            Ok(real) if real.starts_with(&root) => {}
            _ => return Err(outside()),
        }
    }
    Ok(full)
}

fn io_error(action: &str, path: &Path, e: std::io::Error) -> RpcError {
    let code = if e.kind() == std::io::ErrorKind::NotFound { RESOURCE_NOT_FOUND } else { INTERNAL_ERROR };
    RpcError::new(code, format!("Could not {action} {}: {e}", path.display()))
}

/// ACP `line` is 1-based; `limit` counts lines. Line endings are kept.
fn slice_lines(content: &str, line: Option<u64>, limit: Option<u64>) -> String {
    if line.is_none() && limit.is_none() {
        return content.to_string();
    }
    let skip = line.unwrap_or(1).saturating_sub(1) as usize;
    let lines = content.split_inclusive('\n').skip(skip);
    match limit {
        Some(n) => lines.take(n as usize).collect(),
        None => lines.collect(),
    }
}

/// The UI turns any message mentioning sign in into "how to sign in" copy.
/// How often a running turn looks at the agent's error log.
const ERROR_LOG_EVERY: Duration = Duration::from_secs(3);

/// Resolves with the model error the agent logged for `session_id` after byte `from` of `log`;
/// never resolves while there is none.
async fn watch_error_log(log: PathBuf, from: u64, session_id: String) -> String {
    loop {
        tokio::time::sleep(ERROR_LOG_EVERY).await;
        let tail = tokio::task::spawn_blocking({
            let log = log.clone();
            move || -> Option<String> {
                use std::io::{Read, Seek, SeekFrom};
                let mut f = std::fs::File::open(&log).ok()?;
                f.seek(SeekFrom::Start(from)).ok()?;
                let mut buf = Vec::new();
                f.take(4 * 1024 * 1024).read_to_end(&mut buf).ok()?;
                Some(String::from_utf8_lossy(&buf).into_owned())
            }
        })
        .await
        .ok()
        .flatten();
        if let Some(message) = tail.as_deref().and_then(|t| opencode_turn_error(t, &session_id)) {
            return message;
        }
    }
}

/// The error that ended this session's turn in opencode's log: a `stream error` of its main agent
/// (`small=false`; the title agent's failures don't stop the turn), as the words shown in the chat.
pub fn opencode_turn_error(log: &str, session_id: &str) -> Option<String> {
    let line = log.lines().find(|l| {
        l.contains("level=ERROR")
            && l.contains("message=\"stream error\"")
            && l.contains(&format!("session.id={session_id} "))
            && l.contains("small=false")
    })?;
    let raw = line.split("error.error=\"").nth(1).map(|r| r.split('"').next().unwrap_or(r)).unwrap_or("");
    let detail = raw.split_once(": ").map(|(_, m)| m).unwrap_or(raw).trim();
    if detail.contains("Free usage limit reached") {
        return Some("opencode's free model has reached its usage limit. Pick another model in the model menu, or subscribe to OpenCode Go (opencode.ai/go)".into());
    }
    Some(if detail.is_empty() {
        "The agent's model failed, so it stopped this turn. Try again, or pick another model".into()
    } else {
        format!("The agent's model failed: {detail}")
    })
}

fn auth_message(e: &RpcError) -> String {
    format!("The agent needs you to sign in first ({})", e.message)
}

const EXITED_MESSAGE: &str = "The agent exited before it was ready";

fn start_error(e: RpcError) -> AcpError {
    if e.is_closed() {
        AcpError(EXITED_MESSAGE.into())
    } else if e.code == AUTH_REQUIRED {
        AcpError(auth_message(&e))
    } else {
        AcpError(format!("The agent could not start a session: {}", e.message))
    }
}

async fn read_loop(stdout: impl AsyncRead + Unpin, core: Arc<SessionCore>) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() {
            core.handle_line(&line);
        }
    }
    core.on_closed();
}

/// Owns the child process: waits for it to exit or for a stop request.
async fn supervise(
    mut child: Child,
    kill_rx: oneshot::Receiver<()>,
    mut reader: JoinHandle<()>,
    core: Arc<SessionCore>,
) {
    #[cfg(unix)]
    let pid = child.id().and_then(|p| libc::pid_t::try_from(p).ok());
    // A dropped `kill_rx` (the session was dropped) also means stop.
    let stop_requested = tokio::select! {
        _ = child.wait() => false,
        _ = kill_rx => true,
    };
    if stop_requested {
        terminate(&mut child).await;
    } else {
        // The agent exited on its own: clear out helpers it left behind.
        #[cfg(unix)]
        if let Some(pid) = pid {
            kill_group(pid, libc::SIGKILL);
        }
    }
    // Let the reader finish output the agent already wrote, but don't wait on
    // a stray process that still holds the pipe open.
    if tokio::time::timeout(DRAIN_GRACE, &mut reader).await.is_err() {
        reader.abort();
    }
    core.on_closed();
}

#[cfg(unix)]
fn kill_group(pgid: libc::pid_t, signal: libc::c_int) {
    // SAFETY: kill(2) has no memory-safety preconditions; the negative pid
    // targets the process group created for this agent in `spawn_agent`.
    unsafe { libc::kill(-pgid, signal) };
}

/// Stops the agent and everything it started (its process group on Unix,
/// its process tree on Windows).
async fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|p| libc::pid_t::try_from(p).ok()) {
        kill_group(pid, libc::SIGTERM);
        let _ = tokio::time::timeout(KILL_GRACE, child.wait()).await;
        // Reaches helpers that ignored SIGTERM.
        kill_group(pid, libc::SIGKILL);
    }
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = child.kill().await;
}

fn image_block(path: &Path) -> Result<Value> {
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return Err(AcpError(format!("Unsupported image type: {}", path.display()))),
    };
    let bytes = std::fs::read(path)
        .map_err(|e| AcpError(format!("Could not read image {}: {e}", path.display())))?;
    Ok(json!({ "type": "image", "mimeType": mime, "data": BASE64.encode(bytes) }))
}

/// One running agent process bound to a chat.
pub struct AgentSession {
    core: Arc<SessionCore>,
    kill_tx: Mutex<Option<oneshot::Sender<()>>>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

impl AgentSession {
    #[allow(clippy::too_many_arguments)]
    async fn launch(
        uid: u64,
        permissions: Arc<Permissions>,
        chat_id: &str,
        command: &[String],
        cwd: &Path,
        sink: Arc<dyn AcpSink>,
        start_timeout: Duration,
        options: SessionOptions,
    ) -> Result<AgentSession> {
        let cwd = std::path::absolute(cwd)
            .map_err(|e| AcpError(format!("Invalid working folder {}: {e}", cwd.display())))?;
        let mut child = spawn_agent(command, &cwd, &options.env)?;
        let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(i), Some(o), Some(e)) => (i, o, e),
            _ => return Err(AcpError("Could not connect to the agent".into())),
        };
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let core = Arc::new(SessionCore {
            uid,
            chat_id: chat_id.to_string(),
            cwd,
            rpc: Rpc::new(out_tx),
            sink,
            permissions,
            session_id: OnceLock::new(),
            modes: Mutex::new(ModeState::default()),
            models: Mutex::new(None),
            auto_approve: AtomicBool::new(false),
            want_auto: AtomicBool::new(false),
            requested_auto: AtomicBool::new(false),
            use_modes: options.use_modes,
            mode_timeout: options.mode_timeout.unwrap_or(SET_MODE_TIMEOUT),
            auto_lock: tokio::sync::Mutex::new(()),
            tools: Mutex::new(HashMap::new()),
            prompting: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            error_log: options.error_log.clone(),
            usage_log: options.usage_log.clone(),
            last_usage: Mutex::new(None),
        });
        tokio::spawn(write_loop(stdin, out_rx));
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let drain = tokio::spawn(drain_stderr(stderr, chat_id.to_string(), tail.clone()));
        let reader = tokio::spawn(read_loop(stdout, core.clone()));
        let (kill_tx, kill_rx) = oneshot::channel();
        let supervisor = tokio::spawn(supervise(child, kill_rx, reader, core.clone()));
        let session = AgentSession {
            core,
            kill_tx: Mutex::new(Some(kill_tx)),
            supervisor: Mutex::new(Some(supervisor)),
        };
        match tokio::time::timeout(start_timeout, session.core.handshake(options.meta)).await {
            Ok(Ok(plan)) => {
                // A failed switch out of plan mode keeps the session rather than failing the start.
                if let Some(how) = plan {
                    if let Err(e) = session.core.leave_plan(how).await {
                        eprintln!("[agent {}] couldn't leave plan mode: {e}", session.core.chat_id);
                    }
                }
                // The model picked for this agent, when it still offers it; a failed switch keeps
                // the agent's own default rather than failing the start.
                if let Some(want) = options.model.as_deref() {
                    let offered = session.core.models.lock().unwrap().as_ref().is_some_and(|m| {
                        m.current.as_deref() != Some(want) && m.options.iter().any(|o| o.value == want)
                    });
                    if offered {
                        if let Err(e) = session.core.set_model(want).await {
                            eprintln!("[agent {}] couldn't switch to the model {want}: {e}", session.core.chat_id);
                        }
                    }
                }
                session.core.emit_models();
                Ok(session)
            }
            Ok(Err(e)) => {
                session.shutdown().await;
                // The process is gone; give its last stderr lines a moment to arrive.
                let _ = tokio::time::timeout(Duration::from_millis(500), drain).await;
                let tail = tail.lock().unwrap().clone();
                Err(exited_with(e, &tail))
            }
            Err(_) => {
                session.shutdown().await;
                Err(AcpError(START_TIMEOUT_MESSAGE.into()))
            }
        }
    }

    /// Kills the process and waits until it is gone. Any turn in flight ends
    /// with `done { stopReason: "cancelled" }` and open permission requests
    /// are answered `cancelled`.
    async fn shutdown(&self) {
        self.core.stopping.store(true, Ordering::SeqCst);
        if let Some(tx) = self.kill_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        let handle = self.supervisor.lock().unwrap().take();
        if let Some(handle) = handle {
            let _ = handle.await;
        }
        self.core.on_closed();
    }
}

impl Drop for AgentSession {
    fn drop(&mut self) {
        // Dropping `kill_tx` wakes the supervisor, which kills the process.
        self.core.stopping.store(true, Ordering::SeqCst);
    }
}

/// All agent sessions, keyed by chat id. Shared Tauri state.
pub struct AcpManager {
    sessions: Mutex<HashMap<String, Arc<AgentSession>>>,
    permissions: Arc<Permissions>,
    next_uid: AtomicU64,
    start_timeout: Duration,
}

impl Default for AcpManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::default(),
            permissions: Arc::default(),
            next_uid: AtomicU64::default(),
            start_timeout: START_TIMEOUT,
        }
    }
}

impl AcpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// How long an agent gets to finish the ACP handshake (300 s by default).
    pub fn with_start_timeout(mut self, timeout: Duration) -> Self {
        self.start_timeout = timeout;
        self
    }

    fn session(&self, chat_id: &str) -> Result<Arc<AgentSession>> {
        self.sessions
            .lock()
            .unwrap()
            .get(chat_id)
            .cloned()
            .ok_or_else(|| AcpError("No agent is running for this chat".into()))
    }

    /// Spawns the agent in `cwd` and opens an ACP session there. Replaces any
    /// agent already running for this chat.
    pub async fn start(
        &self,
        chat_id: &str,
        command: &[String],
        cwd: &Path,
        sink: Arc<dyn AcpSink>,
    ) -> Result<()> {
        self.start_with(chat_id, command, cwd, sink, SessionOptions::default()).await
    }

    /// Like `start`, with `_meta` for `session/new` and extra environment variables.
    pub async fn start_with(
        &self,
        chat_id: &str,
        command: &[String],
        cwd: &Path,
        sink: Arc<dyn AcpSink>,
        options: SessionOptions,
    ) -> Result<()> {
        let _ = self.stop(chat_id).await;
        let auto = options.auto;
        let uid = self.next_uid.fetch_add(1, Ordering::SeqCst);
        let session =
            AgentSession::launch(
                uid,
                self.permissions.clone(),
                chat_id,
                command,
                cwd,
                sink,
                self.start_timeout,
                options,
            )
            .await?;
        let previous = self
            .sessions
            .lock()
            .unwrap()
            .insert(chat_id.to_string(), Arc::new(session));
        if let Some(previous) = previous {
            previous.shutdown().await;
        }
        if auto {
            self.set_auto(chat_id, true).await?;
        }
        Ok(())
    }

    /// Turns auto mode on or off for a running session. On: the agent's `auto`
    /// mode when it lists one, otherwise (or when switching fails) Tayang approves
    /// each request with its allow-once option. Off: asking again; when the agent can't leave
    /// its auto mode that is an error and the session is stopped.
    pub async fn set_auto(&self, chat_id: &str, on: bool) -> Result<AutoMethod> {
        let session = self.session(chat_id)?;
        let result = session.core.set_auto(on).await;
        if result.is_err() {
            // Fail closed: a session that may still be in auto mode must not outlive the toggle.
            // Only that session: the chat may have moved on to a new one meanwhile.
            let uid = session.core.uid;
            let stale = {
                let mut sessions = self.sessions.lock().unwrap();
                if sessions.get(chat_id).is_some_and(|s| s.core.uid == uid) {
                    sessions.remove(chat_id)
                } else {
                    None
                }
            };
            match stale {
                Some(s) => s.shutdown().await,
                None => session.shutdown().await,
            }
        }
        result
    }

    /// Sends `session/set_mode`; the error is the agent's message.
    pub async fn set_mode(&self, chat_id: &str, mode_id: &str) -> Result<()> {
        self.session(chat_id)?.core.set_mode(mode_id).await
    }

    /// Switches a running session's model (see `parse_models` for how agents offer them).
    pub async fn set_model(&self, chat_id: &str, value: &str) -> Result<()> {
        self.session(chat_id)?.core.set_model(value).await
    }

    /// The models a running session offers.
    pub fn models(&self, chat_id: &str) -> Result<Option<ModelState>> {
        Ok(self.session(chat_id)?.core.models.lock().unwrap().clone())
    }

    /// Mode ids the agent listed in `session/new`.
    pub fn available_modes(&self, chat_id: &str) -> Result<Vec<String>> {
        Ok(self.session(chat_id)?.core.modes.lock().unwrap().available.clone())
    }

    /// Sends a prompt; the turn runs in the background and streams to the sink,
    /// ending with a `done` or `error` update.
    pub async fn prompt(&self, chat_id: &str, parts: Vec<PromptPart>) -> Result<()> {
        let session = self.session(chat_id)?;
        let core = session.core.clone();
        if core.rpc.is_closed() {
            return Err(AcpError("The agent is not running".into()));
        }
        let prompt = parts
            .iter()
            .map(|p| match p {
                PromptPart::Text(text) => Ok(json!({ "type": "text", "text": text })),
                PromptPart::Image { path } => image_block(path),
            })
            .collect::<Result<Vec<_>>>()?;
        if core.prompting.swap(true, Ordering::SeqCst) {
            return Err(AcpError("The agent is still working on the last message".into()));
        }
        tokio::spawn(async move { core.run_turn(prompt).await });
        Ok(())
    }

    /// Answers a permission request: `Some(option_id)` selects that option,
    /// `None` answers `cancelled`.
    /// Answers an agent's question (see `on_elicitation`).
    pub fn respond_question(&self, request_id: &str, response: Value) -> Result<()> {
        self.permissions.answer_question(request_id, response)
    }

    pub fn respond_permission(&self, request_id: &str, option_id: Option<String>) -> Result<()> {
        self.permissions.answer(request_id, option_id)
    }

    /// Asks the agent to stop the current turn (`session/cancel`).
    pub async fn cancel(&self, chat_id: &str) -> Result<()> {
        let session = self.session(chat_id)?;
        let core = &session.core;
        core.rpc
            .notify("session/cancel", json!({ "sessionId": core.session_id() }))
            .map_err(|_| AcpError("The agent is not running".into()))?;
        // ACP: the client answers every open permission request with `cancelled`.
        self.permissions.cancel_session(core.uid);
        Ok(())
    }

    /// Kills the agent process for this chat.
    pub async fn stop(&self, chat_id: &str) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(chat_id)
            .ok_or_else(|| AcpError("No agent is running for this chat".into()))?;
        session.shutdown().await;
        Ok(())
    }

    /// Kills every running agent. Called when the app quits.
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_turns_model_error_from_opencodes_log() {
        let log = concat!(
            "timestamp=1 level=INFO run=a message=evaluated permission=bash\n",
            "timestamp=2 level=ERROR run=a message=\"stream error\" providerID=opencode modelID=big-pickle session.id=ses_other small=false agent=build error.error=\"AI_APICallError: boom\"\n",
            "timestamp=3 level=ERROR run=a message=\"stream error\" providerID=opencode modelID=big-pickle session.id=ses_1 small=true agent=title error.error=\"AI_RetryError: x\"\n",
        );
        assert_eq!(opencode_turn_error(log, "ses_1"), None);
        let limit = format!("{log}timestamp=4 level=ERROR run=a message=\"stream error\" providerID=opencode modelID=big-pickle session.id=ses_1 small=false agent=build mode=primary error.error=\"AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe\"\n");
        assert!(opencode_turn_error(&limit, "ses_1").unwrap().contains("free model has reached its usage limit"));
        let other = "level=ERROR message=\"stream error\" session.id=ses_2 small=false agent=build error.error=\"AI_APICallError: Overloaded\"";
        assert_eq!(opencode_turn_error(other, "ses_2").unwrap(), "The agent's model failed: Overloaded");
        assert_eq!(opencode_turn_error(other, "ses_22"), None);
    }

    #[test]
    fn parses_requests_notifications_and_responses() {
        let req = parse_message(
            r#"{"jsonrpc":"2.0","id":"a1","method":"fs/read_text_file","params":{"path":"/x"}}"#,
        );
        assert_eq!(
            req,
            Some(Incoming::Request {
                id: json!("a1"),
                method: "fs/read_text_file".into(),
                params: json!({"path": "/x"}),
            })
        );
        let note = parse_message(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#);
        assert_eq!(
            note,
            Some(Incoming::Notification { method: "session/update".into(), params: json!({}) })
        );
        let ok = parse_message(r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#);
        assert_eq!(
            ok,
            Some(Incoming::Response { id: 3, result: Ok(json!({"stopReason": "end_turn"})) })
        );
        let err = parse_message(r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"auth"}}"#);
        assert_eq!(
            err,
            Some(Incoming::Response { id: 4, result: Err(RpcError::new(-32000, "auth")) })
        );
        assert_eq!(parse_message("not json"), None);
        assert_eq!(parse_message("[1,2]"), None);
    }

    #[test]
    fn parses_session_modes() {
        let m = parse_modes(&json!({"modes": {"currentModeId": "default",
            "availableModes": [{"id": "default", "name": "Default"}, {"id": "auto", "name": "Auto"}]}}));
        assert_eq!(m.available, vec!["default".to_string(), "auto".to_string()]);
        assert_eq!(m.current.as_deref(), Some("default"));
        assert_eq!(parse_modes(&json!({})), ModeState::default());
    }

    #[test]
    fn plan_mode_is_left_for_the_working_mode() {
        let opencode = json!({"configOptions": [
            {"id": "model", "category": "model", "currentValue": "x", "options": [{"value": "x"}]},
            {"id": "mode", "category": "mode", "currentValue": "plan", "options": [{"value": "build"}, {"value": "plan"}]}]});
        assert_eq!(leave_plan(&opencode), Some(LeavePlan::Config { id: "mode".into(), value: "build".into() }));
        let claude = json!({"modes": {"currentModeId": "plan",
            "availableModes": [{"id": "default"}, {"id": "acceptEdits"}, {"id": "plan"}]}});
        assert_eq!(leave_plan(&claude), Some(LeavePlan::Mode("default".into())));
        let other = json!({"modes": {"currentModeId": "plan", "availableModes": [{"id": "plan"}, {"id": "write"}]}});
        assert_eq!(leave_plan(&other), Some(LeavePlan::Mode("write".into())));
        // Already working, or nothing to switch to: left alone.
        let building = json!({"configOptions": [{"id": "mode", "category": "mode", "currentValue": "build", "options": [{"value": "build"}, {"value": "plan"}]}]});
        assert_eq!(leave_plan(&building), None);
        assert_eq!(leave_plan(&json!({"modes": {"currentModeId": "plan", "availableModes": [{"id": "plan"}]}})), None);
        assert_eq!(leave_plan(&json!({})), None);
    }

    #[test]
    fn manager_is_shareable_tauri_state() {
        fn assert_send_sync<T: Send + Sync + 'static>() {}
        assert_send_sync::<AcpManager>();
        assert_send_sync::<AgentSession>();
    }

    #[test]
    fn tool_state_remembers_kind_and_first_location() {
        let mut st = ToolState::new();
        st.apply(&json!({
            "toolCallId": "t", "title": "Edit a.ts", "kind": "edit", "status": "pending",
            "locations": [{ "path": "/w/a.ts", "line": 3 }, { "path": "/w/b.ts" }]
        }));
        assert_eq!(st.kind.as_deref(), Some("edit"));
        assert_eq!(st.path.as_deref(), Some("/w/a.ts"));
        // An update without them keeps what was learned.
        st.apply(&json!({ "toolCallId": "t", "status": "completed" }));
        assert_eq!(st.kind.as_deref(), Some("edit"));
        assert_eq!(st.path.as_deref(), Some("/w/a.ts"));
        assert_eq!(st.status, ToolCallStatus::Done);
    }

    #[test]
    fn maps_acp_enums_to_app_literals() {
        assert_eq!(map_tool_status("in_progress"), Some(ToolCallStatus::Running));
        assert_eq!(map_tool_status("completed"), Some(ToolCallStatus::Done));
        assert_eq!(map_tool_status("bogus"), None);
        assert_eq!(map_option_kind("allow_always"), Some(PermissionOptionKind::AllowAlways));
        assert_eq!(map_option_kind("reject_always"), Some(PermissionOptionKind::RejectAlways));
        assert_eq!(map_option_kind("allow-once"), None);
    }

    #[test]
    fn image_mime_comes_from_the_extension() {
        let dir = tempfile::tempdir().unwrap();
        for (name, mime) in [("a.PNG", "image/png"), ("b.jpg", "image/jpeg"), ("c.jpeg", "image/jpeg"), ("d.webp", "image/webp")] {
            let p = dir.path().join(name);
            std::fs::write(&p, b"x").unwrap();
            let block = image_block(&p).unwrap();
            assert_eq!(block["mimeType"], mime);
            assert_eq!(block["data"], "eA==");
            assert_eq!(block["type"], "image");
        }
        let gif = dir.path().join("e.gif");
        std::fs::write(&gif, b"x").unwrap();
        assert!(image_block(&gif).is_err());
    }

    #[test]
    fn slices_lines_one_based() {
        let text = "a\nb\nc\n";
        assert_eq!(slice_lines(text, None, None), text);
        assert_eq!(slice_lines(text, Some(2), None), "b\nc\n");
        assert_eq!(slice_lines(text, Some(2), Some(1)), "b\n");
        assert_eq!(slice_lines(text, None, Some(2)), "a\nb\n");
        assert_eq!(slice_lines(text, Some(9), Some(1)), "");
    }

    #[test]
    fn fs_paths_must_stay_inside_cwd() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        let p = |s: &str| json!(s);
        let inside = cwd.join("src").join("a.txt");
        assert_eq!(resolve_inside(&cwd, Some(&p(&inside.to_string_lossy()))).unwrap(), inside);
        assert_eq!(resolve_inside(&cwd, Some(&p("new/b.txt"))).unwrap(), cwd.join("new/b.txt"));
        let sibling = root.path().join("other.txt");
        assert!(resolve_inside(&cwd, Some(&p(&sibling.to_string_lossy()))).is_err());
        assert!(resolve_inside(&cwd, Some(&p("../other.txt"))).is_err());
        assert!(resolve_inside(&cwd, None).is_err());
        assert!(resolve_inside(&cwd, Some(&p(""))).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn fs_paths_cannot_escape_through_symlinked_folders() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("project");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, cwd.join("link")).unwrap();
        let target = cwd.join("link").join("new").join("x.txt");
        assert!(resolve_inside(&cwd, Some(&json!(target.to_string_lossy()))).is_err());
    }

    #[test]
    fn raw_command_accepts_string_or_argv() {
        assert_eq!(raw_command(&json!({"command": "brew install ffmpeg"})).as_deref(), Some("brew install ffmpeg"));
        assert_eq!(raw_command(&json!({"command": ["npm", "i", "-g", "x"]})).as_deref(), Some("npm i -g x"));
        assert_eq!(raw_command(&json!({"path": "/x"})), None);
        assert_eq!(raw_command(&json!({"command": ""})), None);
    }

    #[tokio::test]
    async fn requests_resolve_by_id_and_fail_when_closed() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let rpc = Arc::new(Rpc::new(tx));
        let r = rpc.clone();
        let call = tokio::spawn(async move { r.request("initialize", json!({"a": 1})).await });
        let sent: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(sent["method"], "initialize");
        assert_eq!(sent["jsonrpc"], "2.0");
        rpc.resolve(sent["id"].as_u64().unwrap(), Ok(json!(7)));
        assert_eq!(call.await.unwrap(), Ok(json!(7)));

        let r = rpc.clone();
        let call = tokio::spawn(async move { r.request("session/prompt", json!({})).await });
        rx.recv().await.unwrap();
        rpc.close();
        assert!(call.await.unwrap().unwrap_err().is_closed());
        assert!(rpc.request("x", json!({})).await.unwrap_err().is_closed());
        assert!(rpc.notify("session/cancel", json!({})).is_err());
    }
}
