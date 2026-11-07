//! One chat's trace: its turns, model calls and tool calls on a time axis, with the tokens of each
//! call. Tayang's own chat history has no timings, so this reads the session files Claude Code
//! keeps in `~/.claude/projects`. They are an internal format: anything unknown is skipped, and a
//! chat with no readable file has an empty trace. Other agents don't write these files.

use chrono::DateTime;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::path::{Path, PathBuf};

const DETAIL_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpanKind {
    Turn,
    Llm,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSpan {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: SpanKind,
    /// The model of a model call, the tool of a tool call; empty for a turn.
    pub name: String,
    /// What a turn was asked or a tool call was for.
    pub detail: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_read_tokens: u64,
    pub failed: bool,
    /// A tool call with no result yet: still running, or cut off.
    pub open: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTrace {
    pub spans: Vec<TraceSpan>,
    /// False for an agent that doesn't write these files.
    pub supported: bool,
    /// What the session files report having spent. Absent while a session is still running.
    pub cost_usd: Option<f64>,
}

/// Where Claude Code keeps the sessions of a working folder: every other character becomes `-`.
pub fn transcripts_dir(home: &Path, cwd: &Path) -> PathBuf {
    let name: String = cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    home.join(".claude").join("projects").join(name)
}

fn millis(row: &Value) -> Option<i64> {
    DateTime::parse_from_rfc3339(row.get("timestamp")?.as_str()?).ok().map(|t| t.timestamp_millis())
}

fn short(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= DETAIL_CHARS {
        return flat;
    }
    flat.chars().take(DETAIL_CHARS).collect::<String>() + "…"
}

/// The most telling input of a tool call.
fn tool_detail(input: &Value) -> Option<String> {
    ["description", "file_path", "query", "pattern", "skill", "prompt", "command"]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .filter(|s| !s.trim().is_empty())
        .map(short)
}

fn prompt_text(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let blocks = content.as_array()?;
    if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
        return None;
    }
    // The app puts its context first and the request last.
    blocks.iter().rev().find_map(|b| b.get("text").and_then(Value::as_str)).map(str::to_string)
}

fn span(id: String, parent_id: Option<String>, kind: SpanKind, name: String, detail: Option<String>, at: i64) -> TraceSpan {
    TraceSpan {
        id,
        parent_id,
        kind,
        name,
        detail,
        start_ms: at,
        end_ms: at,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        failed: false,
        open: false,
    }
}

#[derive(Default)]
struct Parsed {
    spans: Vec<TraceSpan>,
    cost_usd: Option<f64>,
    tool_ids: HashSet<String>,
}

/// One session file, in order. A model call is logged as one row per content block and each row
/// carries the call's usage so far, so the last row of a message id has its true numbers.
fn parse(reader: impl BufRead, key: &str) -> Parsed {
    let mut out = Parsed::default();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut turn: Option<String> = None;
    let mut turns = 0;
    let mut last_input: Option<i64> = None;
    let mut last_at = None;

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(row) = serde_json::from_str::<Value>(&line) else { continue };
        let kind = row.get("type").and_then(Value::as_str).unwrap_or_default();
        if kind == "cost-state" {
            out.cost_usd = row.get("totalCostUSD").and_then(Value::as_f64).or(out.cost_usd);
            continue;
        }
        if !matches!(kind, "user" | "assistant") || row.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let (Some(at), Some(message)) = (millis(&row), row.get("message")) else { continue };
        last_at = Some(at);
        let content = message.get("content").cloned().unwrap_or(Value::Null);

        if kind == "user" {
            for b in content.as_array().into_iter().flatten() {
                if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let Some(i) = b.get("tool_use_id").and_then(Value::as_str).and_then(|id| index.get(id)) else { continue };
                let s = &mut out.spans[*i];
                s.end_ms = at;
                s.open = false;
                s.failed = b.get("is_error").and_then(Value::as_bool) == Some(true);
            }
            let injected = row.get("isMeta").and_then(Value::as_bool) == Some(true)
                || row.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
                || row.get("sourceToolUseID").is_some();
            if !injected {
                if let Some(text) = prompt_text(&content) {
                    turns += 1;
                    let id = format!("{key}:turn:{turns}");
                    out.spans.push(span(id.clone(), None, SpanKind::Turn, String::new(), Some(short(&text)), at));
                    index.insert(id.clone(), out.spans.len() - 1);
                    turn = Some(id);
                }
            }
            last_input = Some(at);
            continue;
        }

        let Some(mid) = message.get("id").and_then(Value::as_str) else { continue };
        let model = message.get("model").and_then(Value::as_str).unwrap_or_default();
        if model == "<synthetic>" {
            continue;
        }
        if turn.is_none() {
            turns += 1;
            let id = format!("{key}:turn:{turns}");
            out.spans.push(span(id.clone(), None, SpanKind::Turn, String::new(), None, last_input.unwrap_or(at)));
            index.insert(id.clone(), out.spans.len() - 1);
            turn = Some(id);
        }
        let i = *index.entry(mid.to_string()).or_insert_with(|| {
            out.spans.push(span(mid.to_string(), turn.clone(), SpanKind::Llm, model.to_string(), None, last_input.unwrap_or(at)));
            out.spans.len() - 1
        });
        let s = &mut out.spans[i];
        s.end_ms = at;
        if let Some(u) = message.get("usage") {
            let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
            s.input_tokens = n("input_tokens");
            s.output_tokens = n("output_tokens");
            s.cache_write_tokens = n("cache_creation_input_tokens");
            s.cache_read_tokens = n("cache_read_input_tokens");
        }
        for b in content.as_array().into_iter().flatten() {
            if b.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(id) = b.get("id").and_then(Value::as_str) else { continue };
            if index.contains_key(id) {
                continue;
            }
            let name = b.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            let mut t = span(id.to_string(), turn.clone(), SpanKind::Tool, name, b.get("input").and_then(tool_detail), at);
            t.open = true;
            out.spans.push(t);
            index.insert(id.to_string(), out.spans.len() - 1);
            out.tool_ids.insert(id.to_string());
        }
    }

    // A tool still open runs to the last thing the file knows about; a turn ends with its last call.
    let mut ends: HashMap<String, i64> = HashMap::new();
    for s in &mut out.spans {
        if s.open {
            s.end_ms = last_at.unwrap_or(s.end_ms).max(s.start_ms);
        }
        if let Some(p) = &s.parent_id {
            let e = ends.entry(p.clone()).or_insert(s.end_ms);
            *e = (*e).max(s.end_ms);
        }
    }
    let totals: Vec<(String, [u64; 4])> = out
        .spans
        .iter()
        .filter(|s| s.kind == SpanKind::Llm)
        .filter_map(|s| Some((s.parent_id.clone()?, [s.input_tokens, s.output_tokens, s.cache_write_tokens, s.cache_read_tokens])))
        .collect();
    for s in out.spans.iter_mut().filter(|s| s.kind == SpanKind::Turn) {
        s.end_ms = ends.get(&s.id).copied().unwrap_or(s.start_ms).max(s.start_ms);
        for (_, n) in totals.iter().filter(|(p, _)| *p == s.id) {
            s.input_tokens += n[0];
            s.output_tokens += n[1];
            s.cache_write_tokens += n[2];
            s.cache_read_tokens += n[3];
        }
    }
    out
}

/// What a subagent's session file spent, by message id so a call counts once.
fn subagent_tokens(path: &Path) -> [u64; 4] {
    let Ok(file) = std::fs::File::open(path) else { return [0; 4] };
    let mut calls: HashMap<String, [u64; 4]> = HashMap::new();
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(row) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(message) = row.get("message").filter(|_| row.get("type").and_then(Value::as_str) == Some("assistant")) else { continue };
        let (Some(id), Some(u)) = (message.get("id").and_then(Value::as_str), message.get("usage")) else { continue };
        let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        calls.insert(id.to_string(), [n("input_tokens"), n("output_tokens"), n("cache_creation_input_tokens"), n("cache_read_input_tokens")]);
    }
    calls.values().fold([0; 4], |a, c| [a[0] + c[0], a[1] + c[1], a[2] + c[2], a[3] + c[3]])
}

/// Puts each subagent's tokens on the tool call that started it, and on that call's turn.
fn add_subagents(session: &Path, spans: &mut [TraceSpan]) {
    let Ok(dir) = std::fs::read_dir(session.with_extension("").join("subagents")) else { return };
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(meta) = std::fs::read_to_string(path.with_extension("meta.json")).ok().and_then(|m| serde_json::from_str::<Value>(&m).ok()) else { continue };
        let Some(tool) = meta.get("toolUseId").and_then(Value::as_str) else { continue };
        let Some(parent) = spans.iter().find(|s| s.id == tool).map(|s| s.parent_id.clone()) else { continue };
        let n = subagent_tokens(&path);
        for s in spans.iter_mut().filter(|s| s.id == tool || Some(&s.id) == parent.as_ref()) {
            s.input_tokens += n[0];
            s.output_tokens += n[1];
            s.cache_write_tokens += n[2];
            s.cache_read_tokens += n[3];
        }
    }
}

/// The trace of a chat that works in `cwd`. Several chats can share a project's folder, so a
/// session belongs to the chat when it holds one of the chat's tool calls (`tool_ids`). With no
/// `tool_ids` (a chat with a folder of its own that hasn't called a tool) every session counts.
pub fn chat_trace(home: &Path, cwd: &Path, tool_ids: &HashSet<String>) -> ChatTrace {
    let mut trace = ChatTrace { supported: true, ..ChatTrace::default() };
    let Ok(dir) = std::fs::read_dir(transcripts_dir(home, cwd)) else { return trace };
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(file) = std::fs::File::open(&path) else { continue };
        let key = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut parsed = parse(std::io::BufReader::new(file), &key);
        if !tool_ids.is_empty() && parsed.tool_ids.is_disjoint(tool_ids) {
            continue;
        }
        if let Some(c) = parsed.cost_usd {
            trace.cost_usd = Some(trace.cost_usd.unwrap_or(0.0) + c);
        }
        add_subagents(&path, &mut parsed.spans);
        trace.spans.extend(parsed.spans);
    }
    // A stable sort: a turn stays ahead of the calls that start at the same moment.
    trace.spans.sort_by_key(|s| s.start_ms);
    trace
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{"type":"user","timestamp":"2026-11-06T03:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"local time"},{"type":"text","text":"Make a video"}]}}
{"type":"assistant","timestamp":"2026-11-06T03:00:02.000Z","message":{"id":"m1","model":"opus","content":[{"type":"thinking","thinking":"x"}],"usage":{"input_tokens":1,"output_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":50}}}
{"type":"assistant","timestamp":"2026-11-06T03:00:03.000Z","message":{"id":"m1","model":"opus","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la","description":"List files"}}],"usage":{"input_tokens":1,"output_tokens":20,"cache_creation_input_tokens":100,"cache_read_input_tokens":50}}}
{"type":"assistant","timestamp":"2026-11-06T03:00:03.500Z","message":{"id":"m1","model":"opus","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/a.ts"}}],"usage":{"input_tokens":1,"output_tokens":30,"cache_creation_input_tokens":100,"cache_read_input_tokens":50}}}
{"type":"user","timestamp":"2026-11-06T03:00:05.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
{"type":"user","timestamp":"2026-11-06T03:00:06.000Z","isMeta":true,"sourceToolUseID":"t1","message":{"role":"user","content":[{"type":"text","text":"skill body"}]}}
{"type":"user","timestamp":"2026-11-06T03:00:07.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":"no"}]}}
not json at all
{"type":"attachment","timestamp":"2026-11-06T03:00:07.500Z"}
{"type":"assistant","isSidechain":true,"timestamp":"2026-11-06T03:00:07.600Z","message":{"id":"side","model":"haiku","content":[],"usage":{"output_tokens":999}}}
{"type":"assistant","timestamp":"2026-11-06T03:00:09.000Z","message":{"id":"m2","model":"opus","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":2,"output_tokens":7,"cache_read_input_tokens":200}}}
{"type":"cost-state","totalCostUSD":1.5}
{"type":"user","timestamp":"2026-11-06T04:00:00.000Z","message":{"role":"user","content":"Again"}}
{"type":"assistant","timestamp":"2026-11-06T04:00:01.000Z","message":{"id":"m3","model":"opus","content":[{"type":"tool_use","id":"t3","name":"Grep","input":{"pattern":"x"}}],"usage":{"output_tokens":1}}}
{"type":"assistant","timestamp":"2026-11-06T04:00:02.000Z","message":{"id":"m4","model":"<synthetic>","content":[]}}
"#;

    fn fixture() -> Parsed {
        parse(FIXTURE.as_bytes(), "s")
    }
    fn by<'a>(p: &'a Parsed, id: &str) -> &'a TraceSpan {
        p.spans.iter().find(|s| s.id == id).unwrap()
    }
    const T0: i64 = 1_793_934_000_000;

    #[test]
    fn the_last_row_of_a_model_call_has_its_usage_and_it_runs_from_the_last_input() {
        let p = fixture();
        let m = by(&p, "m1");
        assert_eq!((m.kind, m.name.as_str()), (SpanKind::Llm, "opus"));
        assert_eq!((m.start_ms, m.end_ms), (T0, T0 + 3500));
        assert_eq!((m.input_tokens, m.output_tokens, m.cache_write_tokens, m.cache_read_tokens), (1, 30, 100, 50));
        assert_eq!(by(&p, "m2").start_ms, T0 + 7000);
    }

    #[test]
    fn tool_calls_run_until_their_result_and_say_what_they_did() {
        let p = fixture();
        let t = by(&p, "t1");
        assert_eq!((t.start_ms, t.end_ms), (T0 + 3000, T0 + 5000));
        assert_eq!(t.detail.as_deref(), Some("List files"));
        assert!(!t.failed && !t.open);
        let r = by(&p, "t2");
        assert!(r.failed);
        assert_eq!(r.detail.as_deref(), Some("/a.ts"));
    }

    #[test]
    fn a_tool_with_no_result_is_open_up_to_the_last_row() {
        let p = fixture();
        let t = by(&p, "t3");
        assert!(t.open);
        assert_eq!(t.end_ms, T0 + 3_602_000);
    }

    #[test]
    fn turns_start_at_real_prompts_and_add_up_their_calls() {
        let p = fixture();
        let turns: Vec<_> = p.spans.iter().filter(|s| s.kind == SpanKind::Turn).collect();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].detail.as_deref(), Some("Make a video"));
        assert_eq!((turns[0].start_ms, turns[0].end_ms), (T0, T0 + 9000));
        assert_eq!((turns[0].input_tokens, turns[0].output_tokens, turns[0].cache_read_tokens), (3, 37, 250));
        assert_eq!(turns[1].detail.as_deref(), Some("Again"));
        assert_eq!(by(&p, "m1").parent_id, Some(turns[0].id.clone()));
        assert_eq!(by(&p, "t3").parent_id, Some(turns[1].id.clone()));
    }

    #[test]
    fn side_chains_synthetic_rows_and_junk_are_left_out_and_cost_is_kept() {
        let p = fixture();
        assert!(!p.spans.iter().any(|s| s.id == "side" || s.id == "m4"));
        assert_eq!(p.cost_usd, Some(1.5));
    }

    #[test]
    fn a_subagent_adds_its_tokens_to_its_tool_call_and_turn() {
        let home = tempfile::tempdir().unwrap();
        let cwd = Path::new("/w/p");
        let dir = transcripts_dir(home.path(), cwd);
        let sub = dir.join("a").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.jsonl"), FIXTURE).unwrap();
        std::fs::write(sub.join("agent-1.meta.json"), r#"{"toolUseId":"t1"}"#).unwrap();
        std::fs::write(
            sub.join("agent-1.jsonl"),
            r#"{"type":"assistant","isSidechain":true,"message":{"id":"s1","usage":{"output_tokens":3}}}
{"type":"assistant","isSidechain":true,"message":{"id":"s1","usage":{"input_tokens":2,"output_tokens":9,"cache_read_input_tokens":40}}}
{"type":"assistant","isSidechain":true,"message":{"id":"s2","usage":{"output_tokens":1}}}
"#,
        )
        .unwrap();
        let t = chat_trace(home.path(), cwd, &HashSet::from(["t1".to_string()]));
        let find = |id: &str| t.spans.iter().find(|s| s.id == id).unwrap();
        assert_eq!((find("t1").input_tokens, find("t1").output_tokens, find("t1").cache_read_tokens), (2, 10, 40));
        assert_eq!(find("a:turn:1").output_tokens, 47);
        assert_eq!(find("m1").output_tokens, 30);
    }

    #[test]
    fn long_details_are_cut_on_a_character_boundary() {
        let s = short(&"é ".repeat(300));
        assert_eq!(s.chars().count(), DETAIL_CHARS + 1);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn the_folder_name_replaces_every_other_character() {
        let dir = transcripts_dir(Path::new("/h"), Path::new("/home/a/Tayang/.tayang/chats/c_1"));
        assert_eq!(dir, Path::new("/h/.claude/projects/-home-a-Tayang--tayang-chats-c-1"));
    }

    #[test]
    fn a_session_belongs_to_the_chat_that_holds_its_tool_calls() {
        let home = tempfile::tempdir().unwrap();
        let cwd = Path::new("/w/p");
        let dir = transcripts_dir(home.path(), cwd);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.jsonl"), FIXTURE).unwrap();
        std::fs::write(dir.join("notes.txt"), "skip").unwrap();
        let other = FIXTURE.replace("\"t1\"", "\"x1\"").replace("\"t2\"", "\"x2\"").replace("\"t3\"", "\"x3\"").replace("\"m1\"", "\"y1\"");
        std::fs::write(dir.join("b.jsonl"), other).unwrap();

        let mine = chat_trace(home.path(), cwd, &HashSet::from(["t1".to_string()]));
        assert!(mine.spans.iter().any(|s| s.id == "t1"));
        assert!(!mine.spans.iter().any(|s| s.id == "x1"));
        assert_eq!(mine.cost_usd, Some(1.5));

        assert!(chat_trace(home.path(), cwd, &HashSet::from(["nope".to_string()])).spans.is_empty());
        assert_eq!(chat_trace(home.path(), cwd, &HashSet::new()).cost_usd, Some(3.0));
        let none = chat_trace(home.path(), Path::new("/none"), &HashSet::new());
        assert!(none.supported && none.spans.is_empty());
    }
}
