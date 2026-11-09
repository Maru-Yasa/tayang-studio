export type AgentId = 'claude' | 'opencode' | 'gemini' | 'codex' | 'custom';

export interface AgentInfo {
  id: AgentId;
  name: string;
  installed: boolean;
  version: string | null;
  acpCommand: string[];
  recommended: boolean;
}

export type OsKind = 'macos' | 'windows' | 'linux';
export type PackageManager = 'brew' | 'winget' | 'apt' | 'dnf' | 'pacman';

export interface SystemInfo {
  os: OsKind;
  osVersion: string;
  packageManager: PackageManager | null;
}

export type ToolId = 'node' | 'ffmpeg' | 'chrome' | 'ytdlp' | 'elevenlabs-mcp';

export interface ToolStatus {
  id: ToolId;
  name: string;
  required: boolean;
  found: boolean;
  version: string | null;
  ok: boolean;
  detail: string;
}

export type VideoKind = 'explainer' | 'promo' | 'quote' | 'news' | 'tutorial' | 'data' | 'event';
export type VideoFormat = '9:16' | '1:1' | '16:9';
export type VideoLanguage = 'id' | 'en';
/** Language of Tayang's own interface (not of the videos). */
export type UiLanguage = 'en' | 'id';
export type ProjectStatus = 'draft' | 'building' | 'rendered' | 'scheduled';

/** Whether a finished video still waits for the user's approval. */
export type ReviewState = 'none' | 'pending' | 'approved';

export interface Project {
  id: string;
  title: string;
  slug: string;
  folder: string;
  kind: VideoKind;
  format: VideoFormat;
  language: VideoLanguage;
  status: ProjectStatus;
  styleId: string | null;
  scheduledAt: string | null;
  reviewState: ReviewState;
  /** When the user marked the video as posted (RFC 3339). */
  postedAt: string | null;
  /** When the post-time reminder was shown (RFC 3339); cleared when the schedule changes. */
  remindedAt: string | null;
  /** When the "review before it's due" reminder was shown (RFC 3339); cleared when the schedule changes. */
  reviewRemindedAt: string | null;
  /** The auto-post this video went out with (the Tayang API's post id); missing when never posted. */
  socialPostId?: string | null;
  durationSec: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewProject {
  title: string;
  kind: VideoKind;
  format: VideoFormat;
  language: VideoLanguage;
  styleId?: string | null;
}

export interface Chat {
  id: string;
  projectId: string | null;
  agentId: AgentId;
  title: string;
  createdAt: string;
}

/** A chat in the sidebar's Recent list. */
export interface RecentChat extends Chat {
  projectTitle: string | null;
  /** The newest message's time, or the chat's own when it has none (RFC 3339). */
  activeAt: string;
  /** When the thread was archived (RFC 3339); only in the archive's list. */
  archivedAt?: string;
}

/** Relative position, 0-1. */
export interface Mark {
  x: number;
  y: number;
}

/** What an agent says a tool call is (ACP tool kinds). */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/** One bar in a chat's trace. A turn's tokens add up its calls; a tool has tokens only if it ran a subagent. */
export interface TraceSpan {
  id: string;
  parentId: string | null;
  kind: 'turn' | 'llm' | 'tool';
  /** The model of a model call, the tool of a tool call; empty for a turn. */
  name: string;
  /** What a turn was asked or a tool call was for. */
  detail: string | null;
  startMs: number;
  endMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  failed: boolean;
  /** A tool call with no result yet: still running, or cut off. */
  open: boolean;
}

/** GET a chat's trace: only Claude Code's session files have one. */
export interface ChatTrace {
  spans: TraceSpan[];
  supported: boolean;
  costUsd: number | null;
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'mention'; projectId: string; title: string }
  /** A style the user @mentioned; the agent gets its prompt and notes in front of the message. */
  | { type: 'style-mention'; styleId: string; name: string }
  | {
      type: 'file';
      path: string;
      name: string;
      mime: string;
      size: number;
      /** When the file was last written (an image the agent made): a rewritten one reloads. */
      modifiedAt?: string;
    }
  | {
      type: 'frame';
      projectId: string;
      frame: number;
      timeSec: number;
      imagePath: string;
      marks: Mark[];
    }
  | {
      type: 'tool';
      toolCallId: string;
      title: string;
      status: 'pending' | 'running' | 'done' | 'failed';
      toolKind?: ToolKind;
      /** The first file the tool touches. */
      path?: string;
    }
  | { type: 'thought'; text: string }
  | { type: 'a2ui'; surfaceId: string; messages: unknown[] }
  | { type: 'a2ui-action'; summary: string; action: object };

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'agent' | 'system';
  parts: MessagePart[];
  createdAt: string;
}

export type StyleAspect = 'camera' | 'pacing' | 'type' | 'color' | 'captions' | 'transitions';

export type StyleEngine = 'hyperframes' | 'remotion';

/** A built-in style's starter project, served by the API as a zip. */
export interface StyleTemplate {
  sha256: string;
  size: number;
  version: number;
}

export interface Style {
  id: string;
  name: string;
  source: 'builtin' | 'copied' | 'mine';
  sourceUrl: string | null;
  notes: Partial<Record<StyleAspect, string>>;
  prompt: string;
  createdAt: string;
  engine?: StyleEngine;
  previewUrl?: string | null;
  /** A short silent clip of the style, played in the style popup; null when there is none. */
  previewVideoUrl?: string | null;
  template?: StyleTemplate | null;
  version?: number;
  /** Id of the built-in style this one was cloned from (its template is downloaded under that id). */
  basedOn?: string | null;
  /** Copied styles: how to build the look (rendering technique, characters, rig, captions), from the study. */
  build?: string | null;
  /** Copied styles: the look's main colours as #RRGGBB, from the study's frames. */
  palette?: string[];
  /** Copied styles: reference frames on this computer (absolute paths in the style's media folder). */
  references?: string[];
}

export type JobKind = 'build' | 'render' | 'install' | 'study-style' | 'script';
export type JobStatus = 'queued' | 'working' | 'needs-you' | 'done' | 'failed';

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  projectId: string | null;
  chatId: string | null;
  agentId: AgentId;
  status: JobStatus;
  progress: number | null;
  note: string | null;
  /** The link a style study was reading, so a failed study can be tried again. */
  sourceUrl: string | null;
  updatedAt: string;
  /**
   * A build job: when the first turn since it was last done started (RFC 3339). A render made after it
   * is this job's video. Missing on other jobs, done ones, and jobs saved before it existed.
   */
  renderBaselineAt?: string | null;
  /** When the card was archived off the board (RFC 3339); a card whose status changes comes back. */
  archivedAt?: string | null;
}

/** A file on disk as the UI needs it: a render, or an image the agent made. */
export interface FileInfo {
  path: string;
  name: string;
  size: number;
  /** RFC 3339 UTC with milliseconds. */
  modifiedAt: string;
}

export interface Settings {
  workingFolder: string;
  defaultAgent: AgentId;
  frameCheck: boolean;
  language: VideoLanguage;
  format: VideoFormat;
  fps: number;
  onboarded: boolean;
  /** Base URL of the optional Tayang API. Settings saves an empty field as the default URL. */
  apiUrl: string;
  /** Random uuid v4 made on first run (empty until then); never derived from the machine. */
  installId: string;
  /** Sends the anonymous daily install ping. */
  shareInstallStats: boolean;
  /** RFC 3339 time of the last successful ping. */
  lastPingAt: string | null;
  /** Chats start in auto mode: the agent runs commands without asking. Style studies always do. */
  autoMode: boolean;
  /** Interface language; null until the first run picks one from the system language. */
  uiLanguage: UiLanguage | null;
  /** Closing the window hides it to the tray (menu bar) instead of quitting. */
  backgroundMode: boolean;
  /** Start Tayang at login; only available while backgroundMode is on. */
  openAtLogin: boolean;
  /** Build jobs marked done before a job could only be done with its video were checked once. */
  buildJobsChecked: boolean;
  /** Project statuses were backfilled once from their renders and chats. */
  projectStatusChecked: boolean;
  /** The model picked for each agent (agent id → the agent's own model value); missing: its default. */
  agentModels: Partial<Record<AgentId, string>>;
  /** "Your API" (the `custom` agent): provider preset, address and model. The key stays in the keychain. */
  apiProvider?: ApiProvider | null;
}

/** A provider preset: `other` is any OpenAI-compatible address the user types. */
export type ApiProviderId = 'deepseek' | '9router' | 'commandcode' | 'other';

export interface ApiProvider {
  provider: ApiProviderId;
  baseUrl: string;
  model: string;
  /** Every model the key can use, offered in the chat's model menu. */
  models?: string[];
}

/** Why checking an API key failed. */
export type ApiFailure = 'unauthorized' | 'noBalance' | 'upgradeRequired' | 'unreachable' | 'notFound' | 'other';

/** The answer of `api_check`: the models the key can use, or why it can't. */
export interface ApiCheck {
  ok: boolean;
  models: string[];
  failure: ApiFailure | null;
  detail: string | null;
}

/** Defaults; workingFolder is `<home>/Tayang`, resolved at runtime. */
export const DEFAULT_SETTINGS: Omit<Settings, 'workingFolder'> = {
  defaultAgent: 'claude',
  frameCheck: true,
  language: 'id',
  format: '9:16',
  fps: 30,
  onboarded: false,
  apiUrl: 'https://studio.tayang.app/api',
  installId: '',
  shareInstallStats: true,
  lastPingAt: null,
  autoMode: false,
  uiLanguage: null,
  backgroundMode: false,
  openAtLogin: false,
  buildJobsChecked: false,
  projectStatusChecked: false,
  agentModels: {},
};

export type AgentUpdate =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | {
      kind: 'tool';
      toolCallId: string;
      title: string;
      status: 'pending' | 'running' | 'done' | 'failed';
      toolKind?: ToolKind;
      path?: string;
    }
  | { kind: 'done'; stopReason: string }
  | { kind: 'error'; message: string }
  /** The models the agent offers for this session and the one in use. */
  | { kind: 'models'; current: string | null; options: ModelChoice[] };

/** One model an agent offers: `value` is what the agent is told, `name` what the user reads. */
export interface ModelChoice {
  value: string;
  name: string;
  description?: string;
}

/** A question the agent asks the user (ACP `elicitation/create`, form mode). */
export interface AgentQuestion {
  chatId: string;
  requestId: string;
  message: string;
  /** JSON Schema of the answer: `properties` with options (`oneOf`), multi-select arrays, text. */
  schema: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

/** The answer to an AgentQuestion. */
export type QuestionResponse =
  | { action: 'accept'; content: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' };

export interface PermissionRequest {
  chatId: string;
  requestId: string;
  title: string;
  commands: string[];
  options: {
    id: string;
    label: string;
    kind: 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always';
  }[];
}

export interface MediaInfo {
  durationSec: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
}

export interface UsageWindow {
  usedPercent: number;
  resetsAt: string | null;
}

export type UsageStatus = 'ok' | 'signed-out' | 'unavailable' | 'error';

export interface AgentUsage {
  agentId: AgentId;
  status: UsageStatus;
  /** The 5 hour window. */
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  /** A model-scoped weekly limit, such as Fable. */
  modelWeekly: { label: string; window: UsageWindow } | null;
  updatedAt: string;
  message: string | null;
  /** For agents without plan limits (opencode): what they used today and over the last 7 days. */
  spend?: { today: Spend; week: Spend };
}

/** Replies, tokens (input, output and reasoning; cached reads left out) and cost over a period. */
export interface Spend {
  replies: number;
  tokens: number;
  costUsd: number;
}

// ---- autopilot ----

/** How often an autopilot makes a video. Times are "HH:MM" in local time; days are 0 (Sunday) to 6 (Saturday). */
export type AutopilotFrequency =
  | { kind: 'daily'; times: string[] }
  | { kind: 'weekly'; days: number[]; time: string }
  /** Weekdays, weekends or any chosen days, with the same 1 to 6 times on each. */
  | { kind: 'days'; days: number[]; times: string[] };

export interface Autopilot {
  id: string;
  name: string;
  /** What the videos are about: the agent's brief. From a catalog niche this is a copy of its prompt. */
  niche: string;
  /** The catalog niche it started from; null for a niche the user wrote. */
  nicheId: string | null;
  language: VideoLanguage;
  styleId: string;
  /** The catalog voice for voice-overs; null lets the agent use the default. */
  voiceId: string | null;
  agentId: AgentId;
  frequency: AutopilotFrequency;
  lengthSec: number;
  /** Finished videos wait for Approve (reviewState 'pending') instead of going straight to Ready. */
  review: boolean;
  /** 'automatic' posts to `socialAccountIds`, after Approve when `review` is on; 'manual' only reminds. */
  posting: 'manual' | 'automatic';
  socialAccountIds: string[];
  status: 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
}

/** What the UI sends to create (no id) or edit (with id) an autopilot; the status is kept on edit, active when new. */
export type AutopilotInput = Omit<Autopilot, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { id?: string };

export type SlotStatus = 'planned' | 'making' | 'done' | 'failed' | 'skipped';

/** One video an autopilot is due to make; unique per (autopilotId, dueAt). */
export interface AutopilotSlot {
  id: string;
  autopilotId: string;
  /** RFC 3339, stored in UTC. */
  dueAt: string;
  status: SlotStatus;
  projectId: string | null;
  error: string | null;
}

/** The fields `update_slot` may change. */
export type SlotPatch = Partial<Pick<AutopilotSlot, 'status' | 'projectId' | 'error'>>;
