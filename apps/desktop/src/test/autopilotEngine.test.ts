import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUpdate, Autopilot, AutopilotSlot, MessagePart, Project, Settings, Style } from '@tayang/shared';

// A small in-memory stand-in for the Rust side: autopilots, slots and projects behave like the commands.
const db = vi.hoisted(() => ({
  autopilots: [] as Autopilot[],
  slots: [] as AutopilotSlot[],
  projects: [] as Project[],
  renders: new Set<string>(),
  seq: 0,
}));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const utc = (at: string) => new Date(at).toISOString().replace('.000Z', 'Z');

vi.mock('@/lib/ipc', () => ({
  getSettings: vi.fn(),
  listAutopilots: vi.fn(async () => clone(db.autopilots)),
  setAutopilotStatus: vi.fn(async (id: string, status: Autopilot['status']) => {
    const a = db.autopilots.find((x) => x.id === id)!;
    a.status = status;
    return clone(a);
  }),
  listSlots: vi.fn(async (from: string, to: string) =>
    clone(db.slots.filter((s) => Date.parse(s.dueAt) >= Date.parse(from) && Date.parse(s.dueAt) <= Date.parse(to))),
  ),
  upsertSlot: vi.fn(async (autopilotId: string, dueAt: string) => {
    const at = utc(dueAt);
    let s = db.slots.find((x) => x.autopilotId === autopilotId && x.dueAt === at);
    if (!s) {
      s = { id: `s${++db.seq}`, autopilotId, dueAt: at, status: 'planned', projectId: null, error: null };
      db.slots.push(s);
    }
    return clone(s);
  }),
  updateSlot: vi.fn(async (id: string, patch: Partial<AutopilotSlot>) => {
    const s = db.slots.find((x) => x.id === id);
    if (!s) throw new Error(`No slot ${id}`);
    Object.assign(s, patch);
    return clone(s);
  }),
  listProjects: vi.fn(async () => clone(db.projects)),
  makeStyleSheets: vi.fn(async () => []),
  keepStyleRefs: vi.fn(async () => []),
  copyStyleRefs: vi.fn(async () => 0),
  createProject: vi.fn(async (input: { title: string; kind: Project['kind']; language: Project['language']; styleId?: string }) => {
    const p = {
      id: `p${++db.seq}`,
      slug: '',
      folder: '',
      format: '9:16',
      status: 'draft',
      styleId: input.styleId ?? null,
      scheduledAt: null,
      reviewState: 'none',
      postedAt: null,
      remindedAt: null,
      reviewRemindedAt: null,
      durationSec: null,
      createdAt: '',
      updatedAt: '',
      ...input,
    } as Project;
    db.projects.push(p);
    return clone(p);
  }),
  updateProject: vi.fn(async (id: string, patch: Partial<Project>) => {
    const p = db.projects.find((x) => x.id === id)!;
    Object.assign(p, patch);
    return clone(p);
  }),
  setSchedule: vi.fn(async (id: string, at: string | null) => {
    const p = db.projects.find((x) => x.id === id)!;
    p.scheduledAt = at;
    return clone(p);
  }),
  createChat: vi.fn(async (projectId: string, agentId: string, title: string) => ({ id: `chat-${projectId}`, projectId, agentId, title })),
  listStyles: vi.fn(),
  syncStyles: vi.fn().mockResolvedValue(null),
  installStyleTemplate: vi.fn(),
  writeBrief: vi.fn().mockResolvedValue(undefined),
  mediaLatestRender: vi.fn(async (projectId: string) => (db.renders.has(projectId) ? `/w/${projectId}/renders/a.mp4` : null)),
  latestRenderInfo: vi.fn(async (projectId: string) =>
    db.renders.has(projectId) ? { path: `/w/${projectId}/renders/a.mp4`, name: 'a.mp4', size: 10, modifiedAt: '2026-11-04T01:00:00.000Z' } : null,
  ),
  mediaProbe: vi.fn().mockResolvedValue({ durationSec: 31.5, fps: 30, frames: 945, width: 1080, height: 1920 }),
  getChat: vi.fn().mockResolvedValue(null),
  listMessages: vi.fn().mockResolvedValue([]),
  addMessage: vi.fn().mockResolvedValue(null),
  upsertJob: vi.fn().mockResolvedValue(undefined),
  listJobs: vi.fn().mockResolvedValue([]),
  agentStart: vi.fn().mockResolvedValue(false),
  agentPrompt: vi.fn(),
  agentCancel: vi.fn().mockResolvedValue(undefined),
  agentStop: vi.fn().mockResolvedValue(undefined),
  agentSetAuto: vi.fn().mockResolvedValue(undefined),
  agentRespondPermission: vi.fn().mockResolvedValue(undefined),
  updateChatAgent: vi.fn(),
  listChats: vi.fn(async (projectId: string) => [{ id: `chat-${projectId}` }]),
}));

const updateHandlers: ((e: { chatId: string; update: AgentUpdate }) => void)[] = [];
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}),
  onAgentUpdate: vi.fn(async (f: (e: { chatId: string; update: AgentUpdate }) => void) => {
    updateHandlers.push(f);
    return () => {};
  }),
  onPermission: vi.fn(async () => () => {}),
}));
const tauriListeners: Record<string, () => void> = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    tauriListeners[name] = cb;
    return () => delete tauriListeners[name];
  }),
}));
const tickHandlers: ((now: Date) => unknown)[] = [];
vi.mock('@/lib/scheduler', () => ({
  onTick: vi.fn((h: (now: Date) => unknown) => {
    tickHandlers.push(h);
    return () => tickHandlers.splice(tickHandlers.indexOf(h), 1);
  }),
}));

vi.mock('@/lib/cloud', async (original) => ({
  ...(await original<typeof import('@/lib/cloud')>()),
  socialPost: vi.fn(async () => ({ postId: 'post1', status: 'scheduled', postsCharged: 1 })),
}));

import { socialPost } from '@/lib/cloud';
import * as ipc from '@/lib/ipc';
import { setUiLanguage } from '@/i18n';
import { canStopNow, onAutopilotChanged, stopNow } from '@/lib/autopilotHooks';
import { localized } from '@/lib/stored';
import { renderTiming } from '@/lib/renderCheck';
import { useApp } from '@/state/app';
import {
  PAUSE_ALL_EVENT,
  TURN_TIMEOUT_MS,
  currentSlot,
  pass,
  resetAutopilotEngine,
  startAutopilot,
  topicChatId,
} from '@/state/autopilot';
import { useChat } from '@/state/chat';

const settings: Settings = {
  workingFolder: '/w/Tayang',
  defaultAgent: 'claude',
  frameCheck: true,
  language: 'id',
  format: '9:16',
  fps: 30,
  onboarded: true,
  apiUrl: '',
  installId: '',
  shareInstallStats: false,
  autoMode: false,
  lastPingAt: null,
  uiLanguage: null,
  backgroundMode: false,
  openAtLogin: false,
  buildJobsChecked: true,
  projectStatusChecked: true,
  agentModels: {},
};

const atlas: Style = { id: 'atlas-journey', name: 'Atlas journey', source: 'builtin', sourceUrl: null, notes: {}, prompt: 'Animated maps', createdAt: '' };

const pilot = (extra: Partial<Autopilot> = {}): Autopilot => ({
  id: 'a1',
  name: 'Coffee',
  niche: 'Home coffee brewing',
  language: 'en',
  styleId: 'atlas-journey',
  agentId: 'codex',
  frequency: { kind: 'daily', times: ['09:00'] },
  lengthSec: 30,
  review: true,
  posting: 'manual',
  nicheId: null,
  voiceId: null,
  socialAccountIds: [],
  status: 'active',
  createdAt: '',
  updatedAt: '',
  ...extra,
});

/** 08:00 local on 4 Nov 2026: today's 09:00 slot is an hour away. */
const NOW = new Date(2026, 10, 4, 8, 0);
const at = (d: number, h: number, m = 0) => utc(new Date(2026, 10, d, h, m).toISOString());

const emit = (chatId: string, update: AgentUpdate) => updateHandlers.forEach((h) => h({ chatId, update }));

/** What the fake agent does with each prompt. `hang` never answers; `reject` refuses the prompt. */
type Reply = { text?: string; error?: string; hang?: boolean; reject?: string; stopReason?: string; render?: boolean };
let respond: (chatId: string, prompt: string) => Reply;
const prompts: { chatId: string; prompt: string }[] = [];
const topicJson = (title: string) => '```json\n{"title":"' + title + '","kind":"data","lengthSec":30}\n```';
const projectOf = (chatId: string) => chatId.replace(/^chat-/, '');

/** A well-behaved agent: a topic for the topic chat, a render for the project chat. */
const happy = (title = 'Why espresso is bitter') => (chatId: string): Reply =>
  chatId.startsWith('autopilot-') ? { text: topicJson(title) } : { text: 'Rendered renders/a.mp4', render: true };

const slot = (id: string) => db.slots.find((s) => s.id === id)!;
const slotAt = (dueAt: string) => db.slots.find((s) => s.dueAt === dueAt)!;
const settle = (fn: () => void) => vi.waitFor(fn, { timeout: 2000, interval: 5 });

beforeEach(() => {
  vi.clearAllMocks();
  renderTiming.stableMs = 0;
  resetAutopilotEngine();
  useChat.getState().reset();
  updateHandlers.length = 0;
  tickHandlers.length = 0;
  prompts.length = 0;
  db.autopilots = [pilot()];
  db.slots = [];
  db.projects = [];
  db.renders = new Set();
  db.seq = 0;
  useApp.setState({ settings, route: { name: 'videos' } });
  vi.mocked(ipc.listStyles).mockResolvedValue([atlas]);
  vi.mocked(ipc.agentCancel).mockResolvedValue(undefined);
  vi.mocked(ipc.agentStop).mockResolvedValue(undefined);
  respond = happy();
  vi.mocked(ipc.agentPrompt).mockImplementation(async (chatId: string, parts: MessagePart[]) => {
    const prompt = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    prompts.push({ chatId, prompt });
    const r = respond(chatId, prompt);
    if (r.reject) throw new Error(r.reject);
    if (r.hang) return;
    void Promise.resolve().then(() => {
      if (r.render) db.renders.add(projectOf(chatId));
      if (r.text) emit(chatId, { kind: 'text', text: r.text });
      if (r.error) emit(chatId, { kind: 'error', message: r.error });
      else emit(chatId, { kind: 'done', stopReason: r.stopReason ?? 'end_turn' });
    });
  });
  startAutopilot();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs a pass and waits until the video being made is finished one way or the other. */
async function runOnce(now = NOW) {
  await pass(now);
  await settle(() => expect(currentSlot()).toBeNull());
}

describe('slot upkeep', () => {
  it('plans the next 7 days per active autopilot, and a second pass changes nothing', async () => {
    db.autopilots.push(pilot({ id: 'a2', status: 'paused' }));
    respond = () => ({ hang: true });
    await pass(NOW);
    const planned = db.slots.filter((s) => s.autopilotId === 'a1').map((s) => s.dueAt);
    expect(planned).toHaveLength(7);
    expect(planned[0]).toBe(at(4, 9));
    expect(planned[6]).toBe(at(10, 9));
    expect(db.slots.some((s) => s.autopilotId === 'a2')).toBe(false);
    const upserts = vi.mocked(ipc.upsertSlot).mock.calls.length;
    await pass(NOW);
    expect(vi.mocked(ipc.upsertSlot).mock.calls.length).toBe(upserts);
    expect(db.slots).toHaveLength(7);
  });

  it('skips planned slots whose time has passed, and leaves the others alone', async () => {
    db.slots.push(
      { id: 'old', autopilotId: 'a1', dueAt: at(3, 9), status: 'planned', projectId: null, error: null },
      { id: 'gone', autopilotId: 'a1', dueAt: at(1, 9), status: 'failed', projectId: null, error: 'x' },
    );
    respond = () => ({ hang: true });
    await pass(NOW);
    expect(slot('old').status).toBe('skipped');
    expect(slot('gone').status).toBe('failed');
  });

  it('fails slots still making from an earlier run, once, with the closed note', async () => {
    db.slots.push({ id: 'm', autopilotId: 'a1', dueAt: at(4, 7), status: 'making', projectId: 'p0', error: null });
    respond = () => ({ hang: true });
    vi.mocked(ipc.listJobs).mockResolvedValueOnce([
      { id: 'build-chat-p0', kind: 'build', title: 'T', projectId: 'p0', chatId: 'chat-p0', agentId: 'claude', status: 'working', progress: null, note: null, sourceUrl: null, updatedAt: 'x' },
    ]);
    await pass(NOW);
    expect(slot('m')).toMatchObject({ status: 'failed', error: 'Tayang was closed while this was running', projectId: 'p0' });
    // Its build job leaves Working too (a reload skips Rust's start-up check).
    expect(ipc.upsertJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'build-chat-p0', status: 'failed', note: 'Tayang was closed while this was running' }));
  });

  it('reads every older slot on the first pass only, then just the last day', async () => {
    respond = () => ({ hang: true });
    await pass(NOW);
    expect(vi.mocked(ipc.listSlots).mock.calls.some(([from]) => from === '1970-01-01T00:00:00Z')).toBe(true);
    vi.mocked(ipc.listSlots).mockClear();
    await pass(new Date(NOW.getTime() + 30_000));
    const froms = vi.mocked(ipc.listSlots).mock.calls.map(([from]) => from);
    expect(froms).toContain(new Date(NOW.getTime() + 30_000 - 24 * 60 * 60_000).toISOString());
  });

  it('tells the Calendar when something changed', async () => {
    const seen = vi.fn();
    const off = onAutopilotChanged(seen);
    respond = () => ({ hang: true });
    await pass(NOW);
    expect(seen).toHaveBeenCalled();
    off();
  });
});

describe('picking the next slot', () => {
  it('starts the earliest planned slot due within 24 hours, across autopilots', async () => {
    db.autopilots = [pilot({ frequency: { kind: 'daily', times: ['20:00'] } }), pilot({ id: 'a2', frequency: { kind: 'daily', times: ['10:00'] } })];
    respond = () => ({ hang: true });
    await pass(NOW);
    expect(currentSlot()).toMatchObject({ autopilotId: 'a2', dueAt: at(4, 10), status: 'making' });
    expect(slotAt(at(4, 10)).status).toBe('making');
    expect(db.slots.filter((s) => s.status === 'making')).toHaveLength(1);
  });

  it('waits when the next slot is more than 24 hours away', async () => {
    db.autopilots = [pilot({ frequency: { kind: 'weekly', days: [0], time: '09:00' } })]; // Sundays; 4 Nov 2026 is a Wednesday
    await pass(NOW);
    expect(currentSlot()).toBeNull();
    expect(db.slots.every((s) => s.status === 'planned')).toBe(true);
  });

  it('never picks a slot of a paused autopilot', async () => {
    db.slots.push({ id: 'p', autopilotId: 'a1', dueAt: at(4, 9), status: 'planned', projectId: null, error: null });
    db.autopilots = [pilot({ status: 'paused' })];
    await pass(NOW);
    expect(currentSlot()).toBeNull();
    expect(slot('p').status).toBe('planned');
  });

  it('makes one video at a time', async () => {
    db.autopilots = [pilot({ frequency: { kind: 'daily', times: ['09:00', '10:00'] } }), pilot({ id: 'a2', frequency: { kind: 'daily', times: ['09:30'] } })];
    respond = () => ({ hang: true });
    await pass(NOW);
    await pass(NOW);
    await pass(new Date(NOW.getTime() + 60_000));
    expect(db.slots.filter((s) => s.status === 'making').map((s) => s.dueAt)).toEqual([at(4, 9)]);
    expect(prompts.filter((p) => p.chatId.startsWith('autopilot-'))).toHaveLength(1);
  });

  it('runs from the scheduler tick', async () => {
    respond = () => ({ hang: true });
    expect(tickHandlers).toHaveLength(1);
    await tickHandlers[0]!(NOW);
    expect(currentSlot()?.dueAt).toBe(at(4, 9));
  });
});

describe('making a video', () => {
  it('asks the hidden topic chat in auto mode, with the niche, style, language and earlier titles', async () => {
    db.projects.push({ ...(await ipc.createProject({ title: 'Old one', kind: 'data', format: '9:16', language: 'en' }, '')) });
    db.slots.push({ id: 'done1', autopilotId: 'a1', dueAt: at(3, 9), status: 'done', projectId: db.projects[0]!.id, error: null });
    db.projects.splice(1);
    await runOnce();
    const chatId = topicChatId('a1');
    expect(ipc.agentStart).toHaveBeenCalledWith(chatId, 'codex', true);
    const topicPrompt = prompts.find((p) => p.chatId === chatId)!.prompt;
    expect(topicPrompt).toContain('Home coffee brewing');
    expect(topicPrompt).toContain('Atlas journey');
    expect(topicPrompt).toContain('English');
    expect(topicPrompt).toContain('- Old one');
    // Hidden: no chat row and nothing stored.
    expect(ipc.createChat).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining('Coffee'));
    expect(vi.mocked(ipc.addMessage).mock.calls.some((c) => c[0] === chatId)).toBe(false);
  });

  it('creates the project in the style and language, builds it in auto mode, and finishes the slot', async () => {
    await runOnce();
    const s = slotAt(at(4, 9));
    const p = db.projects.find((x) => x.title === 'Why espresso is bitter')!;
    expect(vi.mocked(ipc.createProject).mock.calls[0]![0]).toMatchObject({ title: 'Why espresso is bitter', language: 'en', styleId: 'atlas-journey' });
    expect(ipc.createChat).toHaveBeenCalledWith(p.id, 'codex', 'Why espresso is bitter');
    expect(ipc.agentStart).toHaveBeenCalledWith(`chat-${p.id}`, 'codex', true);
    const build = prompts.find((x) => x.chatId === `chat-${p.id}`)!.prompt;
    expect(build).toContain('"Why espresso is bitter", about 30 seconds in English');
    expect(build).toMatch(/Check frames/);
    // The visible message is short and in the interface language.
    expect(useChat.getState().messages[`chat-${p.id}`]![0]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'Make "Why espresso is bitter", about 30 seconds, and render it' }],
    });
    // On the Agents board as the chat's build job.
    expect(vi.mocked(ipc.upsertJob).mock.calls.some(([j]) => j.kind === 'build' && j.title === 'Why espresso is bitter' && j.projectId === p.id)).toBe(true);
    expect(ipc.setSchedule).toHaveBeenCalledWith(p.id, s.dueAt);
    expect(p).toMatchObject({ status: 'rendered', reviewState: 'pending', durationSec: 31.5, scheduledAt: s.dueAt });
    expect(s).toMatchObject({ status: 'done', projectId: p.id, error: null });
    // Never takes the user anywhere.
    expect(useApp.getState().route).toEqual({ name: 'videos' });
  });

  it('fully automatic with accounts: posts the finished video for its slot, once', async () => {
    // Posting reads the real clock: pin it to the test's "now", so the slot is still ahead.
    vi.setSystemTime(NOW);
    db.autopilots = [pilot({ review: false, posting: 'automatic', socialAccountIds: ['sa_1'], voiceId: 'Rachel' })];
    await runOnce();
    vi.useRealTimers();
    const s = db.slots.find((x) => x.status === 'done')!;
    expect(socialPost).toHaveBeenCalledTimes(1);
    expect(socialPost).toHaveBeenCalledWith(expect.objectContaining({ projectId: db.projects[0]!.id, accountIds: ['sa_1'], scheduledAt: new Date(s.dueAt).toISOString() }));
    expect(prompts.some((p) => p.prompt.includes('"voice":"Rachel"'))).toBe(true);
    expect(s.error).toBeNull();
  });

  it('review first: waits for Approve instead of posting', async () => {
    db.autopilots = [pilot({ review: true, posting: 'automatic', socialAccountIds: ['sa_1'] })];
    await runOnce();
    expect(socialPost).not.toHaveBeenCalled();
    expect(db.projects[0]!.reviewState).toBe('pending');
  });

  it('a failed post keeps the video: the slot is done and says what happened', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(socialPost).mockRejectedValueOnce(new Error('plan_required'));
    db.autopilots = [pilot({ review: false, posting: 'automatic', socialAccountIds: ['sa_1'] })];
    await runOnce();
    const slot = db.slots.find((x) => x.projectId === db.projects[0]!.id)!;
    expect(slot.status).toBe('done');
    expect(localized(slot.error!)).toMatch(/couldn't be posted/);
  });

  it('marks the video approved when the autopilot does not review first', async () => {
    db.autopilots = [pilot({ review: false })];
    await runOnce();
    expect(db.projects[0]!.reviewState).toBe('approved');
  });

  it('skips the frame check when it is off in Settings', async () => {
    useApp.setState({ settings: { ...settings, frameCheck: false } });
    await runOnce();
    const build = prompts.find((x) => x.chatId.startsWith('chat-'))!.prompt;
    expect(build).toContain('Skip the frame check this time.\nThis video is made by an autopilot');
    expect(build).not.toMatch(/Check frames/);
  });

  it('asks once more for a topic it can read, then uses it', async () => {
    let n = 0;
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: ++n === 1 ? 'Sure, here is an idea: espresso.' : topicJson('Second try') } : happy()(chatId));
    await runOnce();
    const asked = prompts.filter((p) => p.chatId.startsWith('autopilot-'));
    expect(asked).toHaveLength(2);
    expect(asked[1]!.prompt).toMatch(/^I could not use that/);
    expect(db.projects[0]!.title).toBe('Second try');
    expect(slotAt(at(4, 9)).status).toBe('done');
  });

  it('treats a repeated title as unusable', async () => {
    db.projects.push({ ...(await ipc.createProject({ title: 'Why espresso is bitter', kind: 'data', format: '9:16', language: 'en' }, '')) });
    db.slots.push({ id: 'done1', autopilotId: 'a1', dueAt: at(3, 9), status: 'done', projectId: db.projects[0]!.id, error: null });
    vi.mocked(ipc.createProject).mockClear();
    await runOnce();
    expect(prompts.filter((p) => p.chatId.startsWith('autopilot-'))).toHaveLength(2);
    expect(ipc.createProject).not.toHaveBeenCalled();
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: "The agent didn't suggest a topic Tayang could use" });
  });

  it('fails the slot when the topic can not be read twice, and moves on next time', async () => {
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: 'no idea' } : happy()(chatId));
    await runOnce();
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: "The agent didn't suggest a topic Tayang could use", projectId: null });
    expect(ipc.createProject).not.toHaveBeenCalled();
    respond = happy();
    await runOnce(new Date(2026, 10, 4, 10, 0));
    expect(slotAt(at(4, 9)).status).toBe('failed');
    expect(slotAt(at(5, 9)).status).toBe('done');
  });

  it("fails the slot clearly when the autopilot's style is missing, and builds nothing without it", async () => {
    vi.mocked(ipc.listStyles).mockResolvedValue([]);
    await runOnce();
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: "This autopilot's style is missing", projectId: null });
    expect(ipc.createProject).not.toHaveBeenCalled();
    setUiLanguage('id');
    expect(localized(slotAt(at(4, 9)).error!)).toBe('Gaya autopilot ini sudah tidak ada');
  });

  it('a render still being written is no video: it asks to render now, and a finished one is fine', async () => {
    // The first render was left running in the background: ffprobe can't read it yet.
    vi.mocked(ipc.mediaProbe).mockRejectedValueOnce(new Error('no video stream found'));
    await runOnce();
    const p = db.projects[0]!;
    const sent = prompts.filter((x) => x.chatId === `chat-${p.id}`);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.prompt).toMatch(/^Render it now/);
    expect(slotAt(at(4, 9)).status).toBe('done');
  });

  it('asks to render once more when the turn ends without a file, then fails and keeps the project', async () => {
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('No file') } : { text: 'All done' });
    await runOnce();
    const p = db.projects[0]!;
    const sent = prompts.filter((x) => x.chatId === `chat-${p.id}`);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.prompt).toMatch(/^Render it now/);
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'No video file was rendered', projectId: p.id });
    expect(ipc.setSchedule).not.toHaveBeenCalled();
    expect(p.reviewState).toBe('none');
  });

  it('finishes when the follow-up renders', async () => {
    let builds = 0;
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Late file') } : { text: 'ok', render: ++builds === 2 });
    await runOnce();
    expect(slotAt(at(4, 9)).status).toBe('done');
  });

  it('fails the slot with the agent error', async () => {
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Err') } : { error: 'boom' });
    await runOnce();
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('fails the slot, without retrying, when the agent is still working', async () => {
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { reject: 'The agent is still working on the last message' } : happy()(chatId));
    await runOnce();
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'The agent was still working on an earlier message' });
    expect(prompts).toHaveLength(1);
  });

  it('cancels a turn after 45 minutes and fails the slot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Slow') } : { hang: true });
    await pass(NOW);
    await vi.waitFor(() => expect(prompts.some((p) => p.chatId.startsWith('chat-'))).toBe(true));
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS - 1000);
    expect(currentSlot()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(currentSlot()).toBeNull());
    const p = db.projects[0]!;
    expect(ipc.agentCancel).toHaveBeenCalledWith(`chat-${p.id}`);
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'The agent took longer than 45 minutes, so Tayang stopped it', projectId: p.id });
  });

  it('stops the topic session after the topic step, so the next slot starts a fresh one, on its current agent', async () => {
    await runOnce();
    const topic = topicChatId('a1');
    expect(ipc.agentStop).toHaveBeenCalledWith(topic);
    const stopAt = vi.mocked(ipc.agentStop).mock.invocationCallOrder[vi.mocked(ipc.agentStop).mock.calls.findIndex((c) => c[0] === topic)]!;
    expect(stopAt).toBeLessThan(vi.mocked(ipc.createProject).mock.invocationCallOrder[0]!);
    db.autopilots = [pilot({ agentId: 'claude' })];
    respond = happy('A new topic');
    await runOnce(new Date(2026, 10, 4, 10, 0));
    expect(slotAt(at(5, 9)).status).toBe('done');
    expect(vi.mocked(ipc.agentStart).mock.calls.filter((c) => c[0] === topic).map((c) => c[1])).toEqual(['codex', 'claude']);
  });

  it('stops the topic session when the topic step fails too', async () => {
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: 'no idea' } : happy()(chatId));
    await runOnce();
    expect(prompts.filter((p) => p.chatId.startsWith('autopilot-'))).toHaveLength(2);
    expect(ipc.agentStop).toHaveBeenCalledWith(topicChatId('a1'));
  });

  it('stops the project chat session when the slot ends, done or failed; the chat stays', async () => {
    await runOnce();
    const p1 = db.projects[0]!;
    expect(ipc.agentStop).toHaveBeenCalledWith(`chat-${p1.id}`);
    expect(useChat.getState().started[`chat-${p1.id}`]).toBe(false);
    expect(useChat.getState().messages[`chat-${p1.id}`]!.length).toBeGreaterThan(0);
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Fails') } : { error: 'boom' });
    await runOnce(new Date(2026, 10, 4, 10, 0));
    const p2 = db.projects.find((p) => p.title === 'Fails')!;
    expect(ipc.agentStop).toHaveBeenCalledWith(`chat-${p2.id}`);
  });
});

describe('pause, stop now and try again', () => {
  it('registers Stop now, which cancels the running turn and fails the slot "Stopped"', async () => {
    expect(canStopNow()).toBe(true);
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Stop me') } : { hang: true });
    await pass(NOW);
    await vi.waitFor(() => expect(prompts.some((p) => p.chatId.startsWith('chat-'))).toBe(true));
    const making = currentSlot()!;
    await stopNow(making);
    await settle(() => expect(currentSlot()).toBeNull());
    const p = db.projects[0]!;
    expect(ipc.agentCancel).toHaveBeenCalledWith(`chat-${p.id}`);
    expect(slot(making.id)).toMatchObject({ status: 'failed', error: 'Stopped', projectId: p.id });
    // A turn that ends late writes nothing more.
    emit(`chat-${p.id}`, { kind: 'done', stopReason: 'cancelled' });
    db.renders.add(p.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(slot(making.id).status).toBe('failed');
    expect(ipc.setSchedule).not.toHaveBeenCalled();
  });

  it('stops while the topic is being picked', async () => {
    respond = () => ({ hang: true });
    await pass(NOW);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    await stopNow(currentSlot()!);
    await settle(() => expect(currentSlot()).toBeNull());
    expect(ipc.agentCancel).toHaveBeenCalledWith(topicChatId('a1'));
    expect(ipc.createProject).not.toHaveBeenCalled();
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'Stopped' });
  });

  it('a paused autopilot finishes the video it is making but starts no new one', async () => {
    let release: () => void = () => {};
    respond = (chatId) => {
      if (chatId.startsWith('autopilot-')) return { text: topicJson('Keep going') };
      release = () => {
        db.renders.add(projectOf(chatId));
        emit(chatId, { kind: 'done', stopReason: 'end_turn' });
      };
      return { hang: true };
    };
    await pass(NOW);
    await vi.waitFor(() => expect(prompts.some((p) => p.chatId.startsWith('chat-'))).toBe(true));
    tauriListeners[PAUSE_ALL_EVENT]!();
    await settle(() => expect(db.autopilots[0]!.status).toBe('paused'));
    release();
    await settle(() => expect(currentSlot()).toBeNull());
    expect(slotAt(at(4, 9)).status).toBe('done');
    await pass(new Date(2026, 10, 5, 8, 0));
    expect(currentSlot()).toBeNull();
  });

  it('the tray pauses every autopilot', async () => {
    db.autopilots = [pilot(), pilot({ id: 'a2' }), pilot({ id: 'a3', status: 'paused' })];
    await vi.waitFor(() => expect(tauriListeners[PAUSE_ALL_EVENT]).toBeDefined());
    tauriListeners[PAUSE_ALL_EVENT]!();
    await settle(() => expect(db.autopilots.map((a) => a.status)).toEqual(['paused', 'paused', 'paused']));
    expect(ipc.setAutopilotStatus).toHaveBeenCalledTimes(2);
  });

  it('a failed slot set back to planned (Try again) is made again', async () => {
    db.slots.push({ id: 'f', autopilotId: 'a1', dueAt: at(4, 9), status: 'failed', projectId: null, error: 'Stopped' });
    await pass(NOW);
    expect(currentSlot()).toBeNull();
    await ipc.updateSlot('f', { status: 'planned', error: null, projectId: null });
    await runOnce();
    expect(slot('f')).toMatchObject({ status: 'done', error: null });
  });
});

describe('slot errors in Indonesian', () => {
  it('are saved in English and shown in the reader’s language', () => {
    setUiLanguage('id');
    expect(localized('Stopped')).toBe('Dihentikan');
    expect(localized('No video file was rendered')).toBe('Tidak ada file video yang dirender');
    expect(localized("The agent didn't suggest a topic Tayang could use")).toBe('Agen belum memberi topik yang bisa dipakai Tayang');
    expect(localized('The agent took longer than 45 minutes, so Tayang stopped it')).toBe('Agen bekerja lebih dari 45 menit, jadi Tayang menghentikannya');
  });
});

describe('review fixes', () => {
  const jobFor = (chatId: string) => vi.mocked(ipc.upsertJob).mock.calls.filter(([j]) => j.id === `build-${chatId}`).at(-1)?.[0];

  it('the build job ends failed with the slot error: no render, busy, timeout, stop', async () => {
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('No file') } : { text: 'All done' });
    await runOnce();
    let p = db.projects.at(-1)!;
    await settle(() => expect(jobFor(`chat-${p.id}`)).toMatchObject({ status: 'failed', note: 'No video file was rendered' }));

    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Busy') } : { reject: 'The agent is still working on the last message' });
    await runOnce(new Date(2026, 10, 4, 10, 0));
    p = db.projects.at(-1)!;
    expect(slotAt(at(5, 9)).error).toBe('The agent was still working on an earlier message');
    await settle(() => expect(jobFor(`chat-${p.id}`)).toMatchObject({ status: 'failed', note: 'The agent was still working on an earlier message' }));

    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Stop it') } : { hang: true });
    await pass(new Date(2026, 10, 5, 10, 0));
    await vi.waitFor(() => expect(prompts.some((x) => x.prompt.includes('Stop it') && x.chatId.startsWith('chat-'))).toBe(true));
    p = db.projects.at(-1)!;
    await stopNow(currentSlot()!);
    await settle(() => expect(currentSlot()).toBeNull());
    emit(`chat-${p.id}`, { kind: 'done', stopReason: 'cancelled' });
    await new Promise((r) => setTimeout(r, 10));
    expect(jobFor(`chat-${p.id}`)).toMatchObject({ status: 'failed', note: 'Stopped' });
  });

  it("the user's Stop inside an autopilot chat fails the slot and its job (not done)", async () => {
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('User stop') } : { stopReason: 'cancelled' });
    await runOnce();
    const p = db.projects[0]!;
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'Stopped' });
    await settle(() => expect(jobFor(`chat-${p.id}`)).toMatchObject({ status: 'failed', note: 'Stopped' }));
  });

  it("leaves the project chat's session alone when the user started a newer turn before the slot ended", async () => {
    let userSent = false;
    respond = (chatId, prompt) => {
      if (chatId.startsWith('autopilot-')) return { text: topicJson('User jumps in') };
      if (prompt.includes('Make it bluer')) return { hang: true };
      return { text: 'Rendered', render: true };
    };
    vi.mocked(ipc.mediaProbe).mockImplementationOnce(async () => {
      // The engine's build turn is over; the user clicks a quick reply before the slot is written.
      const chatId = `chat-${db.projects[0]!.id}`;
      void useChat.getState().send(chatId, [{ type: 'text', text: 'Make it bluer' }]);
      userSent = true;
      return { durationSec: 30, fps: 30, frames: 900, width: 1080, height: 1920 };
    });
    await runOnce();
    const chatId = `chat-${db.projects[0]!.id}`;
    expect(userSent).toBe(true);
    expect(slotAt(at(4, 9)).status).toBe('done');
    expect(useChat.getState().streaming[chatId]).toBe(true);
    expect(ipc.agentStop).not.toHaveBeenCalledWith(chatId);
  });

  it('a tick past 45 minutes times the turn out even when the timer never fired, after the cancel finished', async () => {
    let finishCancel: () => void = () => {};
    vi.mocked(ipc.agentCancel).mockImplementation(() => new Promise<void>((r) => (finishCancel = r)));
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Stuck') } : { hang: true });
    await pass(NOW);
    await vi.waitFor(() => expect(prompts.some((x) => x.chatId.startsWith('chat-'))).toBe(true));
    const p = db.projects[0]!;
    const late = new Date(Date.now() + TURN_TIMEOUT_MS + 1000);
    const ticking = pass(late);
    await vi.waitFor(() => expect(ipc.agentCancel).toHaveBeenCalledWith(`chat-${p.id}`));
    // Not released until the agent's cancel is done.
    await new Promise((r) => setTimeout(r, 10));
    expect(currentSlot()).not.toBeNull();
    expect(slotAt(at(4, 9)).status).toBe('making');
    finishCancel();
    await ticking;
    await settle(() => expect(currentSlot()).toBeNull());
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'The agent took longer than 45 minutes, so Tayang stopped it' });
  });

  it('Stop now waits for the agent to cancel before the slot is written and the engine is free', async () => {
    let finishCancel: () => void = () => {};
    vi.mocked(ipc.agentCancel).mockImplementation(() => new Promise<void>((r) => (finishCancel = r)));
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Slow stop') } : { hang: true });
    await pass(NOW);
    await vi.waitFor(() => expect(prompts.some((x) => x.chatId.startsWith('chat-'))).toBe(true));
    const stopping = stopNow(currentSlot()!);
    await new Promise((r) => setTimeout(r, 10));
    expect(currentSlot()).not.toBeNull();
    expect(slotAt(at(4, 9)).status).toBe('making');
    finishCancel();
    await stopping;
    await settle(() => expect(currentSlot()).toBeNull());
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'Stopped' });
  });

  it('Stop now fails the running slot even when reading slots fails', async () => {
    respond = (chatId) => (chatId.startsWith('autopilot-') ? { text: topicJson('Read fails') } : { hang: true });
    await pass(NOW);
    await vi.waitFor(() => expect(prompts.some((x) => x.chatId.startsWith('chat-'))).toBe(true));
    const real = vi.mocked(ipc.listSlots).getMockImplementation()!;
    vi.mocked(ipc.listSlots).mockImplementation(async () => {
      throw new Error('locked');
    });
    try {
      await stopNow(currentSlot()!);
      await settle(() => expect(currentSlot()).toBeNull());
    } finally {
      vi.mocked(ipc.listSlots).mockImplementation(real);
    }
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'Stopped' });
  });

  it('Stop now during the final writes takes the schedule back', async () => {
    let finish: () => void = () => {};
    const real = vi.mocked(ipc.setSchedule).getMockImplementation()!;
    vi.mocked(ipc.setSchedule).mockImplementationOnce(async (id, at) => {
      await new Promise<void>((r) => (finish = r));
      return real(id, at);
    });
    await pass(NOW);
    await vi.waitFor(() => expect(ipc.setSchedule).toHaveBeenCalled());
    const stopping = stopNow(currentSlot()!);
    finish();
    await stopping;
    await settle(() => expect(currentSlot()).toBeNull());
    expect(db.projects[0]!.scheduledAt).toBeNull();
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'Stopped' });
  });

  it('Stop now leaves a slot alone that is no longer making', async () => {
    db.slots.push({ id: 'd', autopilotId: 'a1', dueAt: at(4, 7), status: 'done', projectId: 'px', error: null });
    await stopNow(clone(slot('d')));
    expect(slot('d')).toMatchObject({ status: 'done', error: null });
    expect(ipc.updateSlot).not.toHaveBeenCalled();
  });

  it('Stop now while the project is being set up stops before anything else is written', async () => {
    let finishCreate: () => void = () => {};
    const real = vi.mocked(ipc.createChat).getMockImplementation()!;
    vi.mocked(ipc.createChat).mockImplementationOnce(async (...args) => {
      await new Promise<void>((r) => (finishCreate = r));
      return real(...args);
    });
    await pass(NOW);
    await vi.waitFor(() => expect(ipc.createChat).toHaveBeenCalled());
    const stopping = stopNow(currentSlot()!);
    finishCreate();
    await stopping;
    await settle(() => expect(currentSlot()).toBeNull());
    expect(prompts.filter((x) => x.chatId.startsWith('chat-'))).toHaveLength(0);
    expect(ipc.setSchedule).not.toHaveBeenCalled();
    expect(slotAt(at(4, 9))).toMatchObject({ status: 'failed', error: 'Stopped' });
  });

  it('does not start a slot when its autopilot was paused during upkeep', async () => {
    respond = () => ({ hang: true });
    vi.mocked(ipc.listAutopilots)
      .mockImplementationOnce(async () => clone(db.autopilots))
      .mockImplementationOnce(async () => clone(db.autopilots).map((a) => ({ ...a, status: 'paused' as const })));
    await pass(NOW);
    expect(currentSlot()).toBeNull();
    expect(db.slots.every((x) => x.status === 'planned')).toBe(true);
  });

  it('a slot Rust refuses to plan (paused meanwhile) is skipped, and upkeep goes on', async () => {
    respond = () => ({ hang: true });
    vi.mocked(ipc.upsertSlot).mockRejectedValueOnce(new Error('This autopilot is paused, so it gets no new slots'));
    await pass(NOW);
    expect(db.slots).toHaveLength(6);
    expect(db.slots.some((x) => x.dueAt === at(4, 9))).toBe(false);
    // The next slot (tomorrow 09:00) is more than 24 h away, so nothing starts.
    expect(currentSlot()).toBeNull();
  });

  it('recovery also stops the agents of a slot left making', async () => {
    db.slots.push({ id: 'm', autopilotId: 'a1', dueAt: at(4, 7), status: 'making', projectId: 'p0', error: null });
    vi.mocked(ipc.agentStop).mockRejectedValueOnce(new Error('no agent'));
    respond = () => ({ hang: true });
    await pass(NOW);
    expect(ipc.agentStop).toHaveBeenCalledWith(topicChatId('a1'));
    expect(ipc.agentStop).toHaveBeenCalledWith('chat-p0');
    expect(slot('m').status).toBe('failed');
  });

  it('the busy error is said in Indonesian', () => {
    setUiLanguage('id');
    expect(localized('The agent was still working on an earlier message')).toBe('Agen masih mengerjakan pesan sebelumnya');
  });
});
