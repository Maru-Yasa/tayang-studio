import { notifyAgent } from '@/lib/agentNotify';
import { create } from 'zustand';
import { FOREGROUND_RULE, RENDERS_RULE, buildSessionPreamble, languageHint, sessionFacts, stripFramesToken, userSkillsText } from '@tayang/skills';
import type { AgentId, AgentQuestion, AgentUpdate, Chat, ChatMessage, Style, FileInfo, JobStatus, MessagePart, PermissionRequest, QuestionResponse } from '@tayang/shared';
import {
  addMessage,
  agentCancel,
  agentRespondPermission,
  agentRespondQuestion,
  agentPrompt,
  agentSetAuto,
  agentStart,
  listSkills,
  agentStop,
  getChat,
  listMessages,
  recentImages,
  updateChatAgent,
  upsertJob,
} from '@/lib/ipc';
import { onAgentAction, onAgentUpdate, onPermission, onQuestion, type AgentAction } from '@/lib/events';
import { extractA2ui } from '@/a2ui/parse';
import { agentErrorText, AGENT_NAMES, trackAgentError } from '@/lib/agents';
import { i18n, uiLanguage } from '@/i18n';
import { stored } from '@/lib/stored';
import { finishedRender } from '@/lib/renderCheck';
import { isRenderTool } from '@/lib/renderTool';
import { advanceProject, isWorkTool, resetProjectStatus } from '@/lib/projectStatus';
import { endCommand, stopAllWatches, stopWatching, watchCommand } from '@/lib/renderWatch';
import { localClock } from '@/lib/time';
import { useApp } from '@/state/app';
import { refreshJobs, useJobs } from '@/state/jobs';
import { renderArgvOf, useRender } from '@/state/render';
import { track } from '@/lib/analytics';


/** A project chat's turns show up on the Agents board as this build job. */
export interface ChatJob {
  projectId: string;
  title: string;
  /** The autopilot's job: it decides done and failed itself, so a turn's end only marks it done. */
  auto?: boolean;
}

export interface SendOpts {
  /** What the agent receives instead of the visible message (extra context, topic prompts). */
  promptParts?: MessagePart[];
  /** Track this chat's turns as a `build` job. */
  job?: ChatJob;
  /** The chat's own agent; defaults to the agent picked in Settings. */
  agentId?: AgentId;
  /** Leave the composer's attachments where they are (a message Tayang sends on the user's behalf). */
  keepAttachments?: boolean;
  /**
   * Sent by the autopilot, with nobody watching: a refusal because the agent is still working comes
   * back as an error too, and every error comes back in English (it is saved on the slot).
   */
  background?: boolean;
}

interface ChatState {
  messages: Record<string, ChatMessage[]>;
  streaming: Record<string, boolean>;
  /** When each chat's running turn started (ms since the epoch); gone once it ends. */
  turnStartedAt: Record<string, number>;
  /** Open permission requests per chat, oldest first. The card shows the head. */
  permissions: Record<string, PermissionRequest[]>;
  /** The agent's open questions per chat (ACP elicitation), oldest first. */
  questions: Record<string, AgentQuestion[]>;
  /** What the agent asked Tayang to do (POST /video, /schedule), waiting for its turn to end. */
  actions: Record<string, AgentAction[]>;
  /** Takes the chat's oldest waiting action of this kind. */
  takeAction(chatId: string, name: AgentAction['name']): AgentAction | undefined;
  attachments: Record<string, MessagePart[]>;
  /** Chats whose agent session was started in this app session. */
  started: Record<string, boolean>;
  /** Per-chat Auto toggle (in memory). Chats without an entry follow Settings. */
  auto: Record<string, boolean>;
  /** The toggle on a new chat that has no id yet. */
  pendingAuto: boolean | null;
  /** Chats whose Auto switch is being applied to the running session. */
  autoBusy: Record<string, boolean>;
  /** Chat rows seen in this app session, so a screen knows a chat's project before asking Rust. */
  rows: Record<string, Chat>;
  /** Unsent composer text and style chip per chat; `new` is the New chat screen's, which has no chat yet. */
  drafts: Record<string, Draft>;
  /** The style library as the chat screens last read it, for the @ menu and style context. */
  styles: Style[];

  /** Turns auto mode on or off; a running session switches right away. */
  setAuto(chatId: string | null, on: boolean): Promise<void>;
  rememberChat(chat: Chat): void;
  setDraft(key: string, draft: Draft): void;
  /** A new chat just got its id: it takes over the draft's Auto choice. */
  adoptPendingAuto(chatId: string): void;
  load(chatId: string): Promise<void>;
  /** Resolves to an error message when the agent could not be reached, otherwise null. */
  send(chatId: string, parts: MessagePart[], opts?: SendOpts): Promise<string | null>;
  respondPermission(chatId: string, optionId: string | null): Promise<void>;
  /** Answers the chat's oldest open question; `summary` (what was picked) goes into the chat as the user's line. */
  respondQuestion(chatId: string, response: QuestionResponse, summary: string): Promise<void>;
  /** Stops the running turn; it ends with done (cancelled). */
  cancel(chatId: string): Promise<void>;
  /** Ends the chat's agent process; the next send starts a new one. */
  stop(chatId: string): Promise<void>;
  /**
   * Ends the chat's agent process once its work is done (the autopilot's videos). The chat stays as it is;
   * the next message starts a new session that gets a recap of the chat first.
   */
  retire(chatId: string): Promise<void>;
  /** Moves the chat to another agent; it starts fresh on the next send. */
  switchAgent(chatId: string, agent: AgentId): Promise<void>;
  /**
   * Adds a system line to the chat and stores it; resolves once it is stored (best effort). `extra` parts
   * are stored with it but not drawn as text (the schedule line keeps the answer that it records).
   */
  appendSystem(chatId: string, text: string, extra?: MessagePart[]): Promise<void>;
  /** A system line shown in the live chat only, never stored (like the busy note). */
  notice(chatId: string, text: string): void;
  attach(chatId: string, part: MessagePart): void;
  detach(chatId: string, index: number): void;
  listen(): void;
  reset(): void;
}

/** A style picked from the @ menu, waiting in the composer. */
export interface StyleRef {
  styleId: string;
  name: string;
}

/** What the composer holds before it is sent. */
export interface Draft {
  text: string;
  style: StyleRef | null;
}

export const EMPTY_DRAFT: Draft = { text: '', style: null };

/** The draft key of the New chat screen, which has no chat id yet. */
export const NEW_CHAT_DRAFT = 'new';

const isLocal = (m: ChatMessage) => m.id.startsWith('local-');

/** Agent chats that have no chat row: the setup installs, style studies, calendar ideas and the autopilots' topic chats. */
export const isScratchChat = (chatId: string) =>
  chatId === 'setup' || chatId.startsWith('study-') || chatId.startsWith('ideas-') || chatId.startsWith('autopilot-');

/** Sessions that never show A2UI (setup installs, style studies, autopilot topics): no skills preamble. Same rule as Rust. */
export const isInternalChat = (chatId: string) => chatId === 'setup' || chatId.startsWith('study-') || chatId.startsWith('autopilot-');

/** Chats this store loaded or sent to; updates for any other chat id are not ours. */
const tracked = new Set<string>();
/** The agent each chat last started with, for error copy. */
const chatAgent = new Map<string, AgentId>();
/** Project chats whose turns are tracked as a build job. */
const chatJobs = new Map<string, ChatJob>();

/** Stored message id → the local id it had before it was stored, so the list keeps its React key. */
const clientKeys = new Map<string, string>();
/** A key for a message that stays the same when the local copy is swapped for the stored one. */
export const messageKey = (m: ChatMessage) => clientKeys.get(m.id) ?? m.id;

/** Things the agent should know before the user's next message, such as a schedule Tayang made from its card. */
const agentNotes = new Map<string, string[]>();
/** Tells the agent `text` in front of the next prompt in this chat, without a turn of its own. */
export const noteForAgent = (chatId: string, text: string) => agentNotes.set(chatId, [...(agentNotes.get(chatId) ?? []), text]);

/** Recaps waiting for the first prompt of a new session: after an agent switch, or a retired session. */
const pendingRecap = new Map<string, { text: string; switched: boolean }>();

/** What `agent_prompt` says when a turn is still running; that turn goes on untouched. */
const BUSY = /still working/i;
/** Whether an error from `send` is the agent refusing a prompt because it is still working. */
export const isBusyRefusal = (message: string) => BUSY.test(message);
export const BUSY_NOTE = stored('chat.busyNote');

const RECAP_MESSAGES = 6;
const RECAP_CHARS = 1500;

/** The last 6 text messages as "You:"/"Agent:" lines, oldest first, within 1,500 characters, without A2UI blocks. */
export function buildRecap(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    // A2UI blocks are drawn cards, not words: the next agent gets the prose only.
    const text = extractA2ui(stripFramesToken(m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))).text.trim();
    if (text) lines.push(`${m.role === 'user' ? 'You' : 'Agent'}: ${text}`);
  }
  const kept: string[] = [];
  let used = 0;
  for (const line of lines.slice(-RECAP_MESSAGES).reverse()) {
    const room = RECAP_CHARS - used - (kept.length ? 1 : 0);
    if (room <= 0) break;
    const cut = line.length > room ? `${line.slice(0, Math.max(0, room - 1))}…` : line;
    kept.unshift(cut);
    used += cut.length + (kept.length > 1 ? 1 : 0);
    if (line.length > room) break;
  }
  return kept.join('\n');
}

/** A system line that shows in the live chat and is stored with it. */
export const appendSystem = (chatId: string, text: string, extra?: MessagePart[]) =>
  useChat.getState().appendSystem(chatId, text, extra);

export const buildJobId = (chatId: string) => `build-${chatId}`;

/**
 * Marks the chat's build job failed with `note` (saved text) and stops tracking it, so a `done` that
 * arrives later (a cancelled turn) can't turn it back. For the autopilot, whose slot failed.
 */
export async function failChatJob(chatId: string, note: string): Promise<void> {
  const job = chatJobs.get(chatId);
  if (!job) return;
  chatJobs.delete(chatId);
  try {
    await upsertJob({
      id: buildJobId(chatId),
      kind: 'build',
      title: job.title,
      projectId: job.projectId,
      chatId,
      agentId: chatAgent.get(chatId) ?? 'claude',
      status: 'failed',
      progress: null,
      sourceUrl: null,
      note,
      updatedAt: new Date().toISOString(),
    });
    await refreshJobs();
  } catch {
    /* the job board is best effort */
  }
}

/**
 * Each chat's render baseline (RFC 3339): when the first turn since its build job was last done started.
 * Any finished render after it is the job's video. A turn that ends without one leaves it where it is.
 */
const baselines = new Map<string, string>();

/** A turn starts in a chat with a build job: it keeps the job's baseline, or sets it now. */
function holdBaseline(chatId: string, startedAt: number) {
  if (baselines.has(chatId)) return;
  // After a restart the stored job still has it, until it is done.
  const stored = useJobs.getState().jobs.find((j) => j.id === buildJobId(chatId) && j.status !== 'done');
  baselines.set(chatId, stored?.renderBaselineAt ?? new Date(startedAt).toISOString());
}

/** The job is done: the next turn starts a new baseline. The late check calls this too. */
export const dropRenderBaseline = (chatId: string) => baselines.delete(chatId);

/** Turns started per chat, so a slow check from an earlier turn can't overwrite a newer one. */
const turnSeq = new Map<string, number>();
/** How many turns the chat has started in this app session; a change means a newer turn. */
export const turnCount = (chatId: string) => turnSeq.get(chatId) ?? 0;

/** Best effort: the job board must never break a chat. */
function writeJob(chatId: string, status: JobStatus, note: string | null = null) {
  const job = chatJobs.get(chatId);
  if (!job) return;
  if (status === 'done') dropRenderBaseline(chatId);
  void upsertJob({
    id: buildJobId(chatId),
    kind: 'build',
    title: job.title,
    projectId: job.projectId,
    chatId,
    agentId: chatAgent.get(chatId) ?? 'claude',
    status,
    progress: null,
    sourceUrl: null,
    note,
    renderBaselineAt: baselines.get(chatId) ?? null,
    updatedAt: new Date().toISOString(),
  })
    .then(() => refreshJobs())
    .catch(() => {});
}
/** Whether the agent's last message waits on the user: an open A2UI surface, or a question at the end. */
export function waitsForAnswer(m: ChatMessage | undefined): boolean {
  if (!m || m.role !== 'agent') return false;
  const { text, blocks } = extractA2ui(stripFramesToken(m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')));
  const asks = blocks.some((b) => b.some((x) => typeof x === 'object' && x !== null && ('createSurface' in x || 'updateComponents' in x)));
  return asks || /[?？]\s*$/.test(text.trim());
}

/** Images from this close before the turn started still count (file times can be coarse). */
const IMAGE_SLACK_MS = 1000;

/** Images an agent may make; the mime type of a found image comes from its extension. */
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
export const imageMime = (name: string) => IMAGE_MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * `parts` with the images found added: a new path goes at the end (oldest first), a path already
 * there whose file was rewritten is updated in place (its new time reloads it). Null when nothing changed.
 */
export function withImages(parts: MessagePart[], found: FileInfo[]): MessagePart[] | null {
  const out = [...parts];
  let changed = false;
  for (const f of [...found].reverse()) {
    const part: MessagePart = { type: 'file', path: f.path, name: f.name, mime: imageMime(f.name), size: f.size, modifiedAt: f.modifiedAt };
    const i = out.findIndex((p) => p.type === 'file' && p.path === f.path);
    if (i < 0) {
      out.push(part);
      changed = true;
    } else if ((out[i] as { modifiedAt?: string }).modifiedAt !== f.modifiedAt) {
      out[i] = part;
      changed = true;
    }
  }
  return changed ? out : null;
}

/**
 * When each chat's latest turn started (RFC 3339), a second early for file systems with coarse times,
 * for the images it made; kept after the turn ends.
 */
const imageSince = new Map<string, string>();
const imageTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** The image lookup running per chat; the next one waits for it. */
const imageRuns = new Map<string, Promise<void>>();
/** A finished turn's message waiting for its last image lookup; calling it saves the message now. */
const pendingSaves = new Map<string, () => void>();
const IMAGE_DEBOUNCE_MS = 500;
/** One lookup may take this long (a hung network volume); the turn's last one, waits included, too. */
const IMAGE_LOOKUP_MS = 5000;

/** `p`, or `fallback` once `ms` have passed without an answer. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

let seq = 0;
const localMessage = (chatId: string, role: ChatMessage['role'], parts: MessagePart[]): ChatMessage => ({
  id: `local-${++seq}`,
  chatId,
  role,
  parts,
  createdAt: new Date().toISOString(),
});

let unlisten: Promise<() => void>[] = [];

const NO_PERMISSION = null;
/** The permission request a chat's card shows: the oldest open one. */
const NO_QUESTION = null;
/** The question a chat's card shows: the oldest open one. */
export const headQuestion = (s: { questions: Record<string, AgentQuestion[]> }, chatId: string | null) =>
  (chatId ? s.questions[chatId]?.[0] : undefined) ?? NO_QUESTION;

export const headPermission = (s: { permissions: Record<string, PermissionRequest[]> }, chatId: string | null) =>
  (chatId ? s.permissions[chatId]?.[0] : undefined) ?? NO_PERMISSION;

/** Whether the Auto toggle is on: the chat's own value (the unsent New chat uses its draft), else Settings. */
export const autoOn = (
  s: { auto: Record<string, boolean>; pendingAuto: boolean | null },
  chatId: string | null,
  settingsAuto: boolean,
) => (chatId ? s.auto[chatId] : s.pendingAuto) ?? settingsAuto;

/** The user's own skills that are on, as text for an agent; empty when none are (or they can't be read). */
async function userSkills(): Promise<string> {
  try {
    return userSkillsText(await listSkills());
  } catch {
    return '';
  }
}

export const useChat = create<ChatState>((set, get) => {
  const append = (chatId: string, m: ChatMessage) =>
    set((s) => ({ messages: { ...s.messages, [chatId]: [...(s.messages[chatId] ?? []), m] } }));

  /**
   * Changes the message with this id, wherever it is in the chat; nothing when it is gone. A local id
   * still finds its message once it is stored (the stored copy keeps the local id as its key).
   */
  const replaceById = (chatId: string, id: string, fn: (m: ChatMessage) => ChatMessage) =>
    set((s) => ({ messages: { ...s.messages, [chatId]: (s.messages[chatId] ?? []).map((m) => (messageKey(m) === id ? fn(m) : m)) } }));

  /** The agent's message in the chat's latest turn: the last one after the last user message. */
  const turnMessage = (chatId: string): ChatMessage | undefined => {
    const list = get().messages[chatId] ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.role === 'agent') return list[i];
      if (list[i]!.role === 'user') return undefined;
    }
    return undefined;
  };

  const replaceLast = (chatId: string, fn: (m: ChatMessage) => ChatMessage) =>
    set((s) => {
      const list = [...(s.messages[chatId] ?? [])];
      list[list.length - 1] = fn(list[list.length - 1]!);
      return { messages: { ...s.messages, [chatId]: list } };
    });

  /** Persist a local message and swap in the stored one. Best effort. */
  const persist = async (chatId: string, m: ChatMessage) => {
    if (isScratchChat(chatId)) return;
    try {
      const saved = await addMessage(chatId, m.role, m.parts);
      if (!saved) return;
      clientKeys.set(saved.id, m.id);
      set((s) => ({
        messages: {
          ...s.messages,
          [chatId]: (s.messages[chatId] ?? []).map((x) => (x.id === m.id ? { ...saved } : x)),
        },
      }));
    } catch {
      /* keep the local copy */
    }
  };

  /** The turn is over: answer whatever is still queued with null and clear the queue. */
  const finish = (chatId: string) => {
    const open = get().permissions[chatId] ?? [];
    const { [chatId]: _, ...turns } = get().turnStartedAt;
    set((s) => ({
      streaming: { ...s.streaming, [chatId]: false },
      permissions: { ...s.permissions, [chatId]: [] },
      questions: { ...s.questions, [chatId]: [] },
      turnStartedAt: turns,
    }));
    // Whatever the turn was rendering is over with it.
    stopWatching(chatId);
    useRender.getState().endChat(chatId);
    for (const req of open) void agentRespondPermission(req.requestId, null).catch(() => {});
  };

  /** The turn is over: a tool the agent never finished must not look like it is still running. */
  const settleTools = (chatId: string, status: 'done' | 'failed') => {
    const last = (get().messages[chatId] ?? []).at(-1);
    if (!last || last.role !== 'agent') return;
    if (!last.parts.some((p) => p.type === 'tool' && (p.status === 'pending' || p.status === 'running'))) return;
    replaceLast(chatId, (m) => ({
      ...m,
      parts: m.parts.map((p) => (p.type === 'tool' && (p.status === 'pending' || p.status === 'running') ? { ...p, status } : p)),
    }));
  };

  /** The agent's render command shows on the chat, the Preview, Videos and the job board while it runs. */
  const trackRender = (chatId: string, toolCallId: string, title: string, status: string) => {
    const projectId = chatJobs.get(chatId)?.projectId;
    if (!projectId || !get().streaming[chatId]) return;
    const render = useRender.getState();
    const running = status === 'pending' || status === 'running';
    if (running && isRenderTool(title, renderArgvOf(projectId))) {
      if (render.runs[projectId]) return;
      render.start(projectId, { source: 'agent', chatId, toolCallId });
      writeJob(chatId, 'working', stored('agents.rendering'));
    } else if (!running && render.runs[projectId]?.toolCallId === toolCallId) {
      render.end(projectId, toolCallId);
      writeJob(chatId, 'working');
    }
  };

  /**
   * A command in a video's chat may render without saying so (a template's `npm run make` renders at the
   * end of its pipeline): while it runs, the project's newest mp4 tells (lib/renderWatch).
   */
  const watchRenderFile = (chatId: string, toolCallId: string, status: string, toolKind: string | undefined) => {
    const projectId = chatJobs.get(chatId)?.projectId;
    if (!projectId || toolKind !== 'execute') return;
    if (status !== 'pending' && status !== 'running') return endCommand(chatId, toolCallId);
    if (!get().streaming[chatId]) return;
    // A command the render check already knows shows as a render by itself.
    if (useRender.getState().runs[projectId]?.toolCallId === toolCallId) return;
    watchCommand(chatId, projectId, toolCallId, get().turnStartedAt[chatId] ?? Date.now(), {
      rendering(id) {
        const render = useRender.getState();
        if (render.runs[projectId] || !get().streaming[chatId]) return;
        render.start(projectId, { source: 'agent', chatId, toolCallId: id });
        writeJob(chatId, 'working', stored('agents.rendering'));
      },
      idle(id) {
        if (useRender.getState().runs[projectId]?.toolCallId !== id) return;
        useRender.getState().end(projectId, id);
        writeJob(chatId, 'working');
      },
    });
  };

  /** Adds the images made since `since` to the agent message `targetId`, wherever it is by then. */
  const scanImages = async (chatId: string, since: string, targetId: string) => {
    let found: FileInfo[] = [];
    try {
      found = await within(recentImages(chatId, since, 50), IMAGE_LOOKUP_MS, []);
    } catch {
      return;
    }
    if (!found.length) return;
    replaceById(chatId, targetId, (m) => {
      const parts = withImages(m.parts, found);
      return parts ? { ...m, parts } : m;
    });
  };

  /**
   * One lookup at a time per chat: a new one starts once the running one is over. The turn and its
   * message are fixed when the lookup is asked for, so a turn that starts meanwhile never gets them.
   */
  const runImages = (chatId: string, since: string, targetId: string): Promise<void> => {
    const before = imageRuns.get(chatId) ?? Promise.resolve();
    const run = before.then(() => scanImages(chatId, since, targetId));
    imageRuns.set(chatId, run);
    void run.finally(() => imageRuns.get(chatId) === run && imageRuns.delete(chatId));
    return run;
  };

  /** Only a video's chat has a folder to look in. */
  const looksForImages = (chatId: string) => !isScratchChat(chatId) && chatJobs.has(chatId);

  /** A step finished: look for new images once things settle (500 ms). Not once the turn is over. */
  const queueImages = (chatId: string) => {
    if (!looksForImages(chatId) || !get().streaming[chatId]) return;
    clearTimeout(imageTimers.get(chatId));
    imageTimers.set(
      chatId,
      setTimeout(() => {
        imageTimers.delete(chatId);
        const since = imageSince.get(chatId);
        const target = turnMessage(chatId);
        if (since && target) void runImages(chatId, since, target.id);
      }, IMAGE_DEBOUNCE_MS),
    );
  };

  /**
   * The turn is over: one last look for images (5 s at most), then `save` stores the agent's message
   * `targetId` with them. A send in the meantime saves it at once, so the chat keeps its order.
   */
  const endTurnImages = (chatId: string, targetId: string | undefined, save: boolean) => {
    clearTimeout(imageTimers.get(chatId));
    imageTimers.delete(chatId);
    const since = imageSince.get(chatId);
    let saved = false;
    const saveNow = () => {
      if (saved || !save || !targetId) return;
      saved = true;
      if (pendingSaves.get(chatId) === saveNow) pendingSaves.delete(chatId);
      const m = (get().messages[chatId] ?? []).find((x) => x.id === targetId);
      if (m && isLocal(m)) void persist(chatId, m);
    };
    if (save && targetId) pendingSaves.set(chatId, saveNow);
    const look = looksForImages(chatId) && since && targetId ? runImages(chatId, since, targetId) : Promise.resolve();
    void within(look, IMAGE_LOOKUP_MS, undefined)
      .catch(() => {})
      .finally(saveNow);
  };

  /**
   * A project chat's turn is over: its build job is done only when the turn left a video. Otherwise it
   * needs the user, saying whether the agent asked them something or stopped before rendering.
   */
  const settleBuildJob = async (chatId: string, job: ChatJob, startedAt: number, seq: number) => {
    // A render still being written (left running in the background) is no video yet; the late check settles
    // it. Any finished render since the job's baseline counts, also one that finished between turns.
    const baseline = baselines.get(chatId);
    const info = await finishedRender(job.projectId, baseline ? Date.parse(baseline) : startedAt);
    // The video exists whatever happens to the job: the project is rendered.
    if (info) void advanceProject(job.projectId, 'rendered');
    // A newer turn has started since: its own end decides.
    if ((turnSeq.get(chatId) ?? 0) !== seq || get().streaming[chatId]) return;
    if (info) {
      writeJob(chatId, 'done', info.name);
      track('video rendered', { by: 'agent', agent: chatAgent.get(chatId) ?? 'unknown' });
      return;
    }
    // The agent's last word, past any system line that landed after it (a busy note, a schedule line).
    const asked = waitsForAnswer([...(get().messages[chatId] ?? [])].reverse().find((m) => m.role === 'agent'));
    writeJob(chatId, 'needs-you', stored(asked ? 'agents.waitingAnswer' : 'agents.noVideo'));
  };

  const onUpdate = (chatId: string, u: AgentUpdate) => {
    if (!tracked.has(chatId)) return;
    if (u.kind === 'text' || u.kind === 'thought' || u.kind === 'tool') {
      const list = get().messages[chatId] ?? [];
      const last = list[list.length - 1];
      if (!last || last.role !== 'agent') {
        append(chatId, localMessage(chatId, 'agent', []));
      }
      replaceLast(chatId, (m) => {
        const parts = [...m.parts];
        if (u.kind === 'text' || u.kind === 'thought') {
          const tail = parts[parts.length - 1];
          if (tail?.type === u.kind) parts[parts.length - 1] = { type: u.kind, text: tail.text + u.text };
          else parts.push({ type: u.kind, text: u.text });
        } else {
          const part: MessagePart = {
            type: 'tool',
            toolCallId: u.toolCallId,
            title: u.title,
            status: u.status,
            ...(u.toolKind ? { toolKind: u.toolKind } : {}),
            ...(u.path ? { path: u.path } : {}),
          };
          const i = parts.findIndex((p) => p.type === 'tool' && p.toolCallId === u.toolCallId);
          if (i >= 0) parts[i] = part;
          else parts.push(part);
        }
        return { ...m, parts };
      });
      if (u.kind === 'tool') {
        trackRender(chatId, u.toolCallId, u.title, u.status);
        watchRenderFile(chatId, u.toolCallId, u.status, u.toolKind);
        if (u.status === 'done') queueImages(chatId);
        // The first edit or command that finishes in a video's chat: it is being built.
        const projectId = chatJobs.get(chatId)?.projectId;
        if (projectId && isWorkTool({ type: 'tool', toolCallId: u.toolCallId, title: u.title, status: u.status, toolKind: u.toolKind })) {
          void advanceProject(projectId, 'building');
        }
      }
      return;
    }
    if (u.kind === 'done') {
      const startedAt = get().turnStartedAt[chatId] ?? Date.now();
      const job = chatJobs.get(chatId);
      // A Stop is the user's choice, not a failure: done, with a note saying so (never "needs you").
      // The autopilot's own failures go through failChatJob, which has already dropped the job by now.
      if (u.stopReason === 'cancelled') writeJob(chatId, 'done', stored('agents.cancelled'));
      else if (job && !job.auto) void settleBuildJob(chatId, job, startedAt, turnSeq.get(chatId) ?? 0);
      else writeJob(chatId, 'done');
      settleTools(chatId, u.stopReason === 'cancelled' ? 'failed' : 'done');
      finish(chatId);
      // The message is stored once, with every image the turn made.
      endTurnImages(chatId, turnMessage(chatId)?.id, true);
      // Tell the user, unless they stopped it themselves: it waits for their pick, or it is done.
      if (u.stopReason !== 'cancelled') {
        const last = [...(get().messages[chatId] ?? [])].reverse().find((m) => m.role === 'agent');
        void notifyAgent(chatId, waitsForAnswer(last) ? 'asks' : 'done');
      }
      return;
    }
    // The session's models are the models store's (see state/models), not part of the conversation.
    if (u.kind === 'models') return;
    // error: the session is gone, so the next send must start a new one
    settleTools(chatId, 'failed');
    finish(chatId);
    endTurnImages(chatId, turnMessage(chatId)?.id, false);
    set((s) => ({ started: { ...s.started, [chatId]: false } }));
    // Saved in English; the chat and the job board say it in the user's language when they show it.
    trackAgentError(u.message, chatAgent.get(chatId) ?? 'claude');
    const text = agentErrorText(u.message, chatAgent.get(chatId) ?? 'claude', 'en');
    writeJob(chatId, 'failed', text);
    const sys = localMessage(chatId, 'system', [{ type: 'text', text }]);
    append(chatId, sys);
    void persist(chatId, sys);
  };

  return {
    messages: {},
    streaming: {},
    turnStartedAt: {},
    permissions: {},
    questions: {},
    actions: {},
    attachments: {},
    started: {},
    auto: {},
    pendingAuto: null,
    autoBusy: {},
    rows: {},
    drafts: {},
    styles: [],

    rememberChat: (chat) => set((s) => ({ rows: { ...s.rows, [chat.id]: chat } })),

    setDraft(key, draft) {
      const was = get().drafts[key] ?? EMPTY_DRAFT;
      if (was.text === draft.text && was.style?.styleId === draft.style?.styleId) return;
      set((s) => ({ drafts: { ...s.drafts, [key]: draft } }));
    },

    async setAuto(chatId, on) {
      if (!chatId) {
        set({ pendingAuto: on });
        return;
      }
      if (!get().started[chatId]) {
        set((s) => ({ auto: { ...s.auto, [chatId]: on } }));
        return;
      }
      if (get().autoBusy[chatId]) return;
      set((s) => ({ autoBusy: { ...s.autoBusy, [chatId]: true } }));
      try {
        await agentSetAuto(chatId, on);
        set((s) => ({ auto: { ...s.auto, [chatId]: on } }));
      } catch (e) {
        if (on) return; // still asking, as before
        // Fail closed: the agent may still be in auto mode, so the app stopped it. The next
        // message starts a new session with Auto off.
        set((s) => ({ auto: { ...s.auto, [chatId]: false }, started: { ...s.started, [chatId]: false } }));
        const reason = e instanceof Error ? e.message : String(e);
        await get().appendSystem(
          chatId,
          stored('chat.autoOffFailed', { reason }),
        );
      } finally {
        set((s) => ({ autoBusy: { ...s.autoBusy, [chatId]: false } }));
      }
    },

    adoptPendingAuto(chatId) {
      const pending = get().pendingAuto;
      if (pending === null) return;
      set((s) => ({ auto: { ...s.auto, [chatId]: pending }, pendingAuto: null }));
    },

    async load(chatId) {
      if (isScratchChat(chatId)) return;
      tracked.add(chatId);
      const agent = (async () => {
        try {
          // After a restart the chat row is the only record of the chat's agent.
          const row = await getChat(chatId);
          if (row && !chatAgent.has(chatId)) chatAgent.set(chatId, row.agentId);
        } catch {
          /* the next send falls back to the default agent */
        }
      })();
      try {
        const list = await listMessages(chatId);
        // Never clobber a conversation that is already live in memory.
        if (!get().messages[chatId]?.length) set((s) => ({ messages: { ...s.messages, [chatId]: list } }));
      } catch {
        /* an empty chat is fine */
      }
      await agent;
    },

    async send(chatId, parts, opts) {
      tracked.add(chatId);
      const attached = opts?.keepAttachments ? [] : (get().attachments[chatId] ?? []);
      const visible = [...attached, ...parts];
      turnSeq.set(chatId, (turnSeq.get(chatId) ?? 0) + 1);
      // The last turn's message, still waiting for its images, is stored before this one.
      pendingSaves.get(chatId)?.();
      if (!get().streaming[chatId]) imageSince.set(chatId, new Date(Date.now() - IMAGE_SLACK_MS).toISOString());
      set((s) => ({
        attachments: opts?.keepAttachments ? s.attachments : { ...s.attachments, [chatId]: [] },
        streaming: { ...s.streaming, [chatId]: true },
        // A send refused because a turn is running keeps that turn's start.
        turnStartedAt: { ...s.turnStartedAt, [chatId]: s.streaming[chatId] ? (s.turnStartedAt[chatId] ?? Date.now()) : Date.now() },
      }));
      const user = localMessage(chatId, 'user', visible);
      append(chatId, user);
      void persist(chatId, user);
      try {
        const agent = opts?.agentId ?? chatAgent.get(chatId) ?? useApp.getState().settings?.defaultAgent ?? 'claude';
        chatAgent.set(chatId, agent);
        if (opts?.job) chatJobs.set(chatId, opts.background ? { ...opts.job, auto: true } : opts.job);
        if (chatJobs.has(chatId)) holdBaseline(chatId, get().turnStartedAt[chatId] ?? Date.now());
        writeJob(chatId, 'working');
        let fresh = false;
        let noPlugin = false;
        if (!get().started[chatId]) {
          const auto = autoOn(get(), chatId, useApp.getState().settings?.autoMode ?? false);
          // Keep the toggle's value with the chat once it has a session.
          set((s) => ({ auto: { ...s.auto, [chatId]: auto } }));
          noPlugin = (auto ? await agentStart(chatId, agent, true) : await agentStart(chatId, agent)) === true;
          set((s) => ({ started: { ...s.started, [chatId]: true } }));
          fresh = true;
        }
        const sent = opts?.promptParts ? [...attached, ...opts.promptParts] : visible;
        const lead: MessagePart[] = [];
        // Claude loads the Tayang plugin itself (unless the app shipped without it); other agents get
        // the skills as text, once per session.
        const uiLang = uiLanguage();
        if (fresh && !isInternalChat(chatId)) {
          // The agent's clock for scheduling, and the id that lets it schedule this project's video.
          const projectId = opts?.job?.projectId ?? chatJobs.get(chatId)?.projectId;
          const facts = { ...localClock(), ...(projectId ? { projectId } : {}) };
          if (agent !== 'claude' || noPlugin) lead.push({ type: 'text', text: buildSessionPreamble(uiLang, facts) });
          // The foreground and renders/ rules too: a project made before them has no copy in its AGENTS.md or CLAUDE.md.
          else lead.push({ type: 'text', text: [languageHint(uiLang), sessionFacts(facts), FOREGROUND_RULE, RENDERS_RULE].filter(Boolean).join('\n\n') });
          // Claude loads the user's own skills as a plugin; other agents get a list of them.
          if (agent !== 'claude') {
            const mine = await userSkills();
            if (mine) lead.push({ type: 'text', text: mine });
          }
        }
        const recap = pendingRecap.get(chatId);
        if (recap?.text) {
          // i18n-ignore: this goes to the agent, not the user
          const intro = recap.switched ? 'Earlier in this chat, with another agent:' : 'Earlier in this chat:';
          // i18n-ignore: this goes to the agent, not the user
          lead.push({ type: 'text', text: `${intro}\n${recap.text}\n\nContinue from here.` });
        }
        const notes = agentNotes.get(chatId);
        if (notes?.length) lead.push({ type: 'text', text: notes.join('\n') });
        await agentPrompt(chatId, [...lead, ...sent]);
        pendingRecap.delete(chatId);
        agentNotes.delete(chatId);
        return null;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (BUSY.test(message)) {
          // The running turn is fine: leave its permissions, job and session alone and just say so.
          append(chatId, localMessage(chatId, 'system', [{ type: 'text', text: BUSY_NOTE }]));
          return opts?.background ? message : null;
        }
        onUpdate(chatId, { kind: 'error', message });
        return agentErrorText(message, chatAgent.get(chatId) ?? 'claude', opts?.background ? 'en' : undefined);
      }
    },

    async respondPermission(chatId, optionId) {
      const [req, ...rest] = get().permissions[chatId] ?? [];
      if (!req) return;
      set((s) => ({ permissions: { ...s.permissions, [chatId]: rest } }));
      if (!rest.length && get().streaming[chatId]) {
        // A render the agent is still running keeps its note.
        const projectId = chatJobs.get(chatId)?.projectId;
        const rendering = !!projectId && useRender.getState().runs[projectId]?.chatId === chatId;
        writeJob(chatId, 'working', rendering ? stored('agents.rendering') : null);
      }
      await agentRespondPermission(req.requestId, optionId);
    },

    takeAction(chatId, name) {
      const list = get().actions[chatId] ?? [];
      const i = list.findIndex((a) => a.name === name);
      if (i < 0) return undefined;
      set((s) => ({ actions: { ...s.actions, [chatId]: list.filter((_, j) => j !== i) } }));
      return list[i];
    },

    async respondQuestion(chatId, response, summary) {
      const [q, ...rest] = get().questions[chatId] ?? [];
      if (!q) return;
      set((s) => ({ questions: { ...s.questions, [chatId]: rest } }));
      if (!rest.length && get().streaming[chatId]) writeJob(chatId, 'working');
      // The answer is part of the conversation: kept in the chat as the user's line.
      const text = response.action === 'accept' && summary ? summary : i18n.t('question.skipped');
      const line = localMessage(chatId, 'user', [{ type: 'text', text }]);
      append(chatId, line);
      void persist(chatId, line);
      await agentRespondQuestion(q.requestId, response);
    },

    async cancel(chatId) {
      await agentCancel(chatId).catch(() => {});
    },

    async stop(chatId) {
      set((s) => ({ started: { ...s.started, [chatId]: false } }));
      await agentStop(chatId).catch(() => {});
    },

    async retire(chatId) {
      pendingRecap.set(chatId, { text: buildRecap(get().messages[chatId] ?? []), switched: false });
      await get().stop(chatId);
    },

    async switchAgent(chatId, agent) {
      const earlier = get().messages[chatId] ?? [];
      const row = await updateChatAgent(chatId, agent);
      await get().stop(chatId);
      chatAgent.set(chatId, agent);
      pendingRecap.set(chatId, { text: buildRecap(earlier), switched: true });
      const name = AGENT_NAMES[agent];
      const sys = localMessage(chatId, 'system', [
        {
          type: 'text',
          text: stored(row?.projectId ? 'chat.switchedProject' : 'chat.switched', { name }),
        },
      ]);
      append(chatId, sys);
      void persist(chatId, sys);
    },

    async appendSystem(chatId, text, extra = []) {
      const sys = localMessage(chatId, 'system', [{ type: 'text', text }, ...extra]);
      append(chatId, sys);
      await persist(chatId, sys);
    },

    notice(chatId, text) {
      append(chatId, localMessage(chatId, 'system', [{ type: 'text', text }]));
    },

    attach: (chatId, part) =>
      set((s) => ({ attachments: { ...s.attachments, [chatId]: [...(s.attachments[chatId] ?? []), part] } })),

    detach: (chatId, index) =>
      set((s) => ({
        attachments: { ...s.attachments, [chatId]: (s.attachments[chatId] ?? []).filter((_, i) => i !== index) },
      })),

    listen() {
      if (unlisten.length) return;
      unlisten = [
        onAgentUpdate(({ chatId, update }) => onUpdate(chatId, update)),
        onAgentAction((a) => {
          if (!tracked.has(a.chatId)) return;
          set((s) => ({ actions: { ...s.actions, [a.chatId]: [...(s.actions[a.chatId] ?? []), a] } }));
        }),
        onQuestion((q) => {
          if (!tracked.has(q.chatId)) return;
          writeJob(q.chatId, 'needs-you', stored('agents.waitingAnswer'));
          void notifyAgent(q.chatId, 'asks');
          set((s) => ({ questions: { ...s.questions, [q.chatId]: [...(s.questions[q.chatId] ?? []), q] } }));
        }),
        onPermission((req) => {
          if (!tracked.has(req.chatId)) return;
          writeJob(req.chatId, 'needs-you');
          void notifyAgent(req.chatId, 'permission');
          set((s) => ({
            permissions: { ...s.permissions, [req.chatId]: [...(s.permissions[req.chatId] ?? []), req] },
          }));
        }),
      ];
    },

    reset() {
      unlisten.forEach((p) => void p.then((fn) => fn()));
      unlisten = [];
      tracked.clear();
      chatAgent.clear();
      chatJobs.clear();
      pendingRecap.clear();
      clientKeys.clear();
      turnSeq.clear();
      agentNotes.clear();
      imageSince.clear();
      imageTimers.forEach((t) => clearTimeout(t));
      imageTimers.clear();
      imageRuns.clear();
      pendingSaves.clear();
      baselines.clear();
      resetProjectStatus();
      stopAllWatches();
      useRender.setState({ runs: {} });
      set({ messages: {}, streaming: {}, turnStartedAt: {}, permissions: {}, questions: {}, actions: {}, attachments: {}, started: {}, auto: {}, pendingAuto: null, autoBusy: {}, rows: {}, drafts: {}, styles: [] });
    },
  };
});
