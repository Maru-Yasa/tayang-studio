// A tiny Agent Client Protocol agent for the acp_test integration tests.
// Speaks newline-delimited JSON-RPC 2.0 over stdio. No dependencies.
//
// Prompts (the concatenated text blocks of session/prompt):
//   hello      -> text "Hel", text "lo", end_turn
//   think      -> thought, tool_call pending, update in_progress, update completed, end_turn
//   install    -> tool_call + session/request_permission (allow-once / reject-once),
//                 then text "installed" (allowed) or "skipped" (rejected or cancelled)
//   crash      -> one text chunk, then exit code 1 mid-turn
//   wait       -> waits for session/cancel, then stopReason "cancelled"
//   fs-outside -> fs/write_text_file to a path outside cwd, reports "fs-ok" or "fs-error: <message>"
//   fs-inside  -> writes then reads line 2 of notes/inside.txt, reports "read: <JSON content>"
//   pids       -> starts a long-lived helper process, reports "pids <agent pid> <helper pid>"
//   fail       -> session/prompt error -32603 "Internal error" with data.details "quota exceeded"
//   ask        -> tool_call + session/request_permission (allow-once / reject-once) for
//                 "ls -la"; reports "ran" when allowed, otherwise "denied"
//   ask-reject-only -> same request with only a reject-once option; reports "ran" / "denied"
//   question   -> elicitation/create (a single choice "Topic" and a free-text "Note") when the client
//                 offers form elicitation; reports "answer <JSON result>", or "no-elicitation"
//   mode       -> reports "mode <current mode id>"
//   usage      -> a usage_update (context and cost), then end_turn with the turn's token usage
//   whoami     -> reports "whoami <JSON {meta, env}>": the session/new `_meta` and TAYANG_STUDIO
//   any prompt with an image block -> text "image <mimeType> <data>"
//
// session/new reports `modes` (default, acceptEdits, plan, auto); --no-auto-mode leaves "auto"
// out, --bad-set-mode makes session/set_mode fail, --no-modes omits `modes` altogether.
// --clamp-auto: set_mode "auto" is accepted but the session ends up in acceptEdits (as claude-agent-acp
// does on models without Auto support); --slow-set-mode delays every set_mode answer by 150 ms;
// --bad-set-mode-default fails set_mode "default"; --hang-set-mode never answers set_mode.
// Every accepted set_mode is followed by a current_mode_update before its answer, unless
// --no-mode-update (the real adapter only reports a mode it clamped). --late-set-mode answers
// set_mode "auto" after 600 ms (no update), i.e. after a short Tayang timeout.
// With the --hang argument, initialize is never answered.
// With the --needs-auth argument, session/new fails with -32000 "Authentication required".
import { createInterface } from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";

// --crash: exits at start with an error on stderr, like an agent missing a runtime.
if (process.argv.includes("--crash")) {
  process.stderr.write("Error: cannot find module 'opencode-windows-x64'\n");
  process.exit(1);
}

let nextId = 1;
const pending = new Map();
let sessionId = null;
let sessionCwd = null;
let sessionMeta = null;
let clientCaps = {};
let cancelWaiter = null;
let cancelled = false;
let currentMode = "default";
// --config-models: session/new reports a `model` config option (set with session/set_config_option);
// --legacy-models: the older `models` field (set with session/set_model). Prompt "model" reports it.
let currentModel = "fast";
const MODELS = [
  { value: "fast", name: "Fast" },
  { value: "smart-free", name: "Smart (free)" },
];
const modelOption = () => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: currentModel,
  options: [{ group: "zen", name: "Zen", options: MODELS }],
});

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function update(u) {
  send({ method: "session/update", params: { sessionId, update: u } });
}

function text(t) {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
}

async function runPrompt(params) {
  cancelled = false;
  const blocks = params.prompt ?? [];
  const image = blocks.find((b) => b.type === "image");
  if (image) {
    text(`image ${image.mimeType} ${image.data}`);
    return "end_turn";
  }
  const prompt = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  switch (prompt) {
    case "hello":
      text("Hel");
      text("lo");
      return "end_turn";
    case "think":
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" } });
      update({ sessionUpdate: "tool_call", toolCallId: "t9", title: "Read brief", kind: "read", status: "pending" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t9", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t9", status: "completed" });
      return "end_turn";
    case "install": {
      const rawInput = { command: "brew install ffmpeg" };
      update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Install FFmpeg",
        kind: "execute",
        status: "pending",
        rawInput,
      });
      const res = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "t1", title: "Install FFmpeg", rawInput },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const outcome = res.result?.outcome;
      if (outcome?.outcome === "selected" && outcome.optionId === "allow") {
        update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
        text("installed");
        return "end_turn";
      }
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
      text("skipped");
      return cancelled ? "cancelled" : "end_turn";
    }
    case "ask":
    case "ask-reject-only": {
      const rawInput = { command: "ls -la" };
      update({ sessionUpdate: "tool_call", toolCallId: "a1", title: "Run ls", kind: "execute", status: "pending", rawInput });
      const options = [{ optionId: "reject", name: "Reject", kind: "reject_once" }];
      if (prompt === "ask") options.unshift({ optionId: "allow", name: "Allow", kind: "allow_once" });
      const res = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "a1", title: "Run ls", rawInput },
        options,
      });
      const outcome = res.result?.outcome;
      text(outcome?.outcome === "selected" && outcome.optionId === "allow" ? "ran" : "denied");
      return "end_turn";
    }
    case "question": {
      if (!clientCaps.elicitation?.form) {
        text("no-elicitation");
        return "end_turn";
      }
      const res = await request("elicitation/create", {
        mode: "form",
        sessionId,
        message: "Which topic?",
        requestedSchema: {
          type: "object",
          properties: {
            topic: { type: "string", title: "Topic", oneOf: [{ const: "a", title: "Rainbows" }, { const: "b", title: "Volcanoes" }] },
            note: { type: "string", title: "Note" },
          },
          required: ["topic"],
        },
      });
      text(`answer ${JSON.stringify(res.result ?? res.error)}`);
      return "end_turn";
    }
    case "mode":
      text(`mode ${currentMode}`);
      return "end_turn";
    case "model":
      text(`model ${currentModel}`);
      return "end_turn";
    case "crash":
      text("about to crash");
      setTimeout(() => process.exit(1), 50);
      return new Promise(() => {});
    case "whoami":
      text(`whoami ${JSON.stringify({ meta: sessionMeta, env: process.env.TAYANG_STUDIO ?? null })}`);
      return "end_turn";
    case "pids": {
      const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      text(`pids ${process.pid} ${helper.pid}`);
      return "end_turn";
    }
    case "wait":
      return new Promise((resolve) => {
        cancelWaiter = resolve;
      });
    case "fs-outside": {
      const target = path.join(sessionCwd, "..", `tayang-outside-${process.pid}.txt`);
      const res = await request("fs/write_text_file", { sessionId, path: target, content: "nope" });
      text(res.error ? `fs-error: ${res.error.message}` : "fs-ok");
      return "end_turn";
    }
    case "fs-inside": {
      const target = path.join(sessionCwd, "notes", "inside.txt");
      const w = await request("fs/write_text_file", { sessionId, path: target, content: "one\ntwo\nthree" });
      if (w.error) {
        text(`fs-error: ${w.error.message}`);
        return "end_turn";
      }
      const r = await request("fs/read_text_file", { sessionId, path: target, line: 2, limit: 1 });
      text(r.error ? `fs-error: ${r.error.message}` : `read: ${JSON.stringify(r.result.content)}`);
      return "end_turn";
    }
    default:
      text(`unknown prompt: ${prompt}`);
      return "end_turn";
  }
}

function handle(msg) {
  if (msg.method === undefined) {
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      if (process.argv.includes("--hang")) return;
      const caps = params?.clientCapabilities ?? {};
      clientCaps = caps;
      const ok =
        params?.protocolVersion === 1 &&
        caps.fs?.readTextFile === true &&
        caps.fs?.writeTextFile === true &&
        caps.terminal === false;
      if (!ok) {
        send({ id, error: { code: -32602, message: "bad initialize params" } });
        return;
      }
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: true } },
          authMethods: [],
        },
      });
      return;
    }
    case "session/new":
      if (process.argv.includes("--needs-auth")) {
        send({ id, error: { code: -32000, message: "Authentication required" } });
        return;
      }
      if (typeof params?.cwd !== "string" || !Array.isArray(params?.mcpServers)) {
        send({ id, error: { code: -32602, message: "bad session/new params" } });
        return;
      }
      sessionCwd = params.cwd;
      sessionMeta = params._meta ?? null;
      sessionId = "sess-1";
      {
        const result = { sessionId };
        if (!process.argv.includes("--no-modes")) {
          const ids = ["default", "acceptEdits", "plan", "auto"].filter(
            (m) => m !== "auto" || !process.argv.includes("--no-auto-mode"),
          );
          result.modes = {
            currentModeId: "default",
            availableModes: ids.map((id) => ({ id, name: id })),
          };
        }
        if (process.argv.includes("--config-models")) result.configOptions = [modelOption()];
        if (process.argv.includes("--legacy-models")) {
          result.models = {
            currentModelId: currentModel,
            availableModels: MODELS.map((m) => ({ modelId: m.value, name: m.name })),
          };
        }
        send({ id, result });
      }
      return;
    case "session/set_config_option":
      if (params?.configId !== "model" || !MODELS.some((m) => m.value === params?.value)) {
        send({ id, error: { code: -32602, message: "no such model" } });
        return;
      }
      currentModel = params.value;
      send({ id, result: { configOptions: [modelOption()] } });
      return;
    case "session/set_model":
      if (!MODELS.some((m) => m.value === params?.modelId)) {
        send({ id, error: { code: -32602, message: "no such model" } });
        return;
      }
      currentModel = params.modelId;
      send({ id, result: {} });
      return;
    case "session/set_mode":
      if (process.argv.includes("--bad-set-mode") || typeof params?.modeId !== "string") {
        send({ id, error: { code: -32602, message: "mode not allowed" } });
        return;
      }
      if (process.argv.includes("--hang-set-mode")) return;
      if (process.argv.includes("--bad-set-mode-default") && params.modeId === "default") {
        send({ id, error: { code: -32603, message: "cannot leave auto" } });
        return;
      }
      {
        const late = process.argv.includes("--late-set-mode") && params.modeId === "auto";
        const clamped = params.modeId === "auto" && process.argv.includes("--clamp-auto");
        setTimeout(
          () => {
            currentMode = clamped ? "acceptEdits" : params.modeId;
            if (!late && (clamped || !process.argv.includes("--no-mode-update"))) {
              update({ sessionUpdate: "current_mode_update", currentModeId: currentMode });
            }
            send({ id, result: {} });
          },
          late ? 600 : process.argv.includes("--slow-set-mode") ? 150 : 0,
        );
      }
      return;
    case "session/prompt":
      if (params?.sessionId !== sessionId) {
        send({ id, error: { code: -32602, message: "unknown session" } });
        return;
      }
      if (params.prompt?.some((b) => b.type === "text" && b.text.trim() === "fail")) {
        send({ id, error: { code: -32603, message: "Internal error", data: { details: "quota exceeded" } } });
        return;
      }
      if (params.prompt?.some((b) => b.type === "text" && b.text.trim() === "usage")) {
        update({ sessionUpdate: "usage_update", used: 5000, size: 200000, cost: { amount: 0.01, currency: "USD" } });
        send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 4000, cachedWriteTokens: 900, totalTokens: 4930 } } });
        return;
      }
      runPrompt(params).then((stopReason) => send({ id, result: { stopReason } }));
      return;
    case "session/cancel":
      cancelled = true;
      if (cancelWaiter) {
        const resolve = cancelWaiter;
        cancelWaiter = null;
        resolve("cancelled");
      }
      return;
    default:
      if (id !== undefined) {
        send({ id, error: { code: -32601, message: `method not found: ${method}` } });
      }
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  handle(JSON.parse(line));
});
rl.on("close", () => process.exit(0));
