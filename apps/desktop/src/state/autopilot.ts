import { listen } from '@tauri-apps/api/event';
import type { AgentId, AgentUpdate, Autopilot, AutopilotSlot, MessagePart } from '@tayang/shared';
import {
  AUTOPILOT_RENDER_NOW,
  AUTOPILOT_TOPIC_RETRY,
  buildAutopilotBuildPrompt,
  buildAutopilotTopicPrompt,
  parseAutopilotTopic,
  SKIP_FRAME_CHECK,
  type AutopilotTopic,
} from '@tayang/skills';
import { i18n } from '@/i18n';
import { agentErrorText } from '@/lib/agents';
import { planSlots } from '@/lib/autopilot';
import { notifyAutopilotChanged, setStopNowHandler } from '@/lib/autopilotHooks';
import { postAutopilotVideo } from '@/lib/autopilotPost';
import { onAgentUpdate } from '@/lib/events';
import {
  agentStop,
  getSettings,
  listAutopilots,
  listChats,
  listJobs,
  listProjects,
  listSlots,
  listStyles,
  mediaProbe,
  setAutopilotStatus,
  setSchedule,
  updateProject,
  updateSlot,
  upsertJob,
  upsertSlot,
} from '@/lib/ipc';
import { finishedRender } from '@/lib/renderCheck';
import { onTick } from '@/lib/scheduler';
import { stored } from '@/lib/stored';
import { createTopicProject } from '@/lib/topics';
import { useApp } from '@/state/app';
import { buildJobId, failChatJob, isBusyRefusal, useChat, type SendOpts } from '@/state/chat';

/**
 * The autopilot engine. It runs in the app (also while it is hidden in the tray), on every scheduler
 * tick and once at start:
 *
 * 1. Upkeep: every active autopilot has its slots for the next 7 days planned; planned slots whose time
 *    has passed are skipped; slots still `making` when the app starts are failed (the app was closed).
 * 2. When nothing is being made, the earliest planned slot of an active autopilot due within 24 h is taken.
 * 3. Its topic comes from the autopilot's hidden topic chat (`autopilot-<id>`), then the video is made in a
 *    normal project chat in auto mode, and checked for a rendered file.
 *
 * One video at a time across all autopilots. Nothing here navigates or takes focus.
 */

/** Rust emits this when the tray's "Pause all autopilots" is picked (scheduler.rs `PAUSE_ALL_EVENT`). */
export const PAUSE_ALL_EVENT = 'autopilot://pause-all';
/** A turn that runs longer than this is cancelled and its slot failed. */
export const TURN_TIMEOUT_MS = 45 * 60_000;
export const PLAN_DAYS = 7;
/** Production starts for a slot due within this long. */
export const START_WITHIN_MS = 24 * 60 * 60_000;
/** How many of the autopilot's earlier titles the topic prompt lists. */
export const PREVIOUS_TITLES = 50;

/** The hidden chat that picks an autopilot's topics. No chat row: it never shows in a chat list. */
export const topicChatId = (autopilotId: string) => `autopilot-${autopilotId}`;

const EPOCH = '1970-01-01T00:00:00Z';
const FOREVER = '9999-12-31T23:59:59Z';

type TurnEnd =
  | { kind: 'done'; stopReason: string; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'stopped' };

interface Run {
  slot: AutopilotSlot;
  autopilot: Autopilot;
  /** The chat whose turn is running now. */
  chatId: string | null;
  /** The video's project chat, once it exists. */
  projectChatId: string | null;
  /** "Stop now" was pressed: the slot is already failed, nothing else may be written. */
  stopped: boolean;
  /** Ends the running turn early. */
  endTurn: ((e: TurnEnd) => void) | null;
  /** When the running turn started (ms); every tick checks it too, in case the JS timer was throttled. */
  turnStartedAt: number | null;
  /** Cancels the running turn and ends it as timed out (what the timer does). */
  timeOut: (() => Promise<void>) | null;
  /** The engine's last turn was cut short (stopped, timed out) and may still be winding down. */
  cutShort: boolean;
}

/** A slot failure with the (stored, English) text the slot keeps. */
class SlotError extends Error {}

let running: Run | null = null;
let recovered = false;
/** Turns being waited for, by chat id: the text so far and how to end the wait. */
const waiters = new Map<string, { text: string; agent: AgentId; end: (e: TurnEnd) => void }>();

/** The slot being made now, if any (the tests watch it). */
export const currentSlot = (): AutopilotSlot | null => running?.slot ?? null;

function onUpdate(chatId: string, u: AgentUpdate) {
  const w = waiters.get(chatId);
  if (!w) return;
  if (u.kind === 'text') w.text += u.text;
  else if (u.kind === 'done') w.end({ kind: 'done', stopReason: u.stopReason, text: w.text });
  else if (u.kind === 'error') w.end({ kind: 'error', message: agentErrorText(u.message, w.agent, 'en') });
}

/**
 * Sends `parts` and waits for that turn to end (done or error), at most `TURN_TIMEOUT_MS`, after which the
 * turn is cancelled. A send the agent refuses (it is still working) ends the turn with that error.
 */
function turn(run: Run, chatId: string, parts: MessagePart[], opts: SendOpts & { agentId: AgentId }): Promise<TurnEnd> {
  if (run.stopped) return Promise.resolve({ kind: 'stopped' });
  run.chatId = chatId;
  return new Promise<TurnEnd>((resolve) => {
    let over = false;
    let firing = false;
    const end = (e: TurnEnd) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      if (waiters.get(chatId)?.end === end) waiters.delete(chatId);
      if (run.endTurn === end) {
        run.cutShort = e.kind === 'stopped' || e.kind === 'timeout';
        run.endTurn = null;
        run.turnStartedAt = null;
        run.timeOut = null;
      }
      resolve(e);
    };
    // The cancel request is sent before the turn ends; the agent is really stopped by the stop/retire
    // in pickTopic's and produce's finally blocks, before the engine is free.
    const timeOut = async () => {
      if (over || firing) return;
      firing = true;
      await useChat.getState().cancel(chatId);
      end({ kind: 'timeout' });
    };
    const timer = setTimeout(() => void timeOut(), TURN_TIMEOUT_MS);
    waiters.set(chatId, { text: '', agent: opts.agentId, end });
    run.endTurn = end;
    run.turnStartedAt = Date.now();
    run.timeOut = timeOut;
    useChat
      .getState()
      .send(chatId, parts, { ...opts, background: true })
      .then(
        (err) => err && end({ kind: 'error', message: err }),
        (e) => end({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
      );
  });
}

/** The reply text of a turn that ended well; any other end fails the slot. */
function replyOf(end: TurnEnd): string {
  switch (end.kind) {
    case 'done':
      // Cancelled from the chat itself counts as stopped.
      if (end.stopReason === 'cancelled') throw new SlotError(stored('autopilot.slot.stopped'));
      return end.text;
    case 'error':
      // Refused because the agent was still working: our own text, saved so it can be said in any language.
      throw new SlotError(isBusyRefusal(end.message) ? stored('autopilot.slot.busy') : end.message);
    case 'timeout':
      throw new SlotError(stored('autopilot.slot.timedOut'));
    case 'stopped':
      throw new SlotError(stored('autopilot.slot.stopped'));
  }
}

const sameTitle = (t: string) => t.trim().toLowerCase();

/** The titles of the autopilot's earlier videos, newest first. */
async function previousTitles(autopilotId: string): Promise<string[]> {
  const [slots, projects] = await Promise.all([listSlots(EPOCH, FOREVER), listProjects()]);
  const titles = new Map(projects.map((p) => [p.id, p.title]));
  return slots
    .filter((s) => s.autopilotId === autopilotId && s.projectId && titles.has(s.projectId))
    .sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt))
    .map((s) => titles.get(s.projectId!)!)
    .slice(0, PREVIOUS_TITLES);
}

/** Asks the topic chat for one topic; one retry with a short correction, else the slot fails. */
async function pickTopic(run: Run): Promise<AutopilotTopic> {
  const a = run.autopilot;
  const chatId = topicChatId(a.id);
  if (!useChat.getState().auto[chatId]) await useChat.getState().setAuto(chatId, true);
  // Nobody reads this chat: keep only the current slot's turns in memory.
  useChat.setState((s) => ({ messages: { ...s.messages, [chatId]: [] } }));

  const titles = await previousTitles(a.id);
  const style = (await listStyles()).find((s) => s.id === a.styleId);
  // Never a video without the look the user picked.
  if (!style) throw new SlotError(stored('autopilot.slot.styleMissing'));
  const used = new Set(titles.map(sameTitle));
  const ask = async (text: string) => {
    const reply = replyOf(await turn(run, chatId, [{ type: 'text', text }], { agentId: a.agentId }));
    const topic = parseAutopilotTopic(reply);
    return topic && !used.has(sameTitle(topic.title)) ? topic : null;
  };
  const first = buildAutopilotTopicPrompt({
    niche: a.niche,
    style,
    language: a.language,
    lengthSec: a.lengthSec,
    previousTitles: titles,
  });
  try {
    const topic = (await ask(first)) ?? (await ask(AUTOPILOT_TOPIC_RETRY));
    if (!topic) throw new SlotError(stored('autopilot.slot.noTopic'));
    return topic;
  } finally {
    // Each slot gets a fresh session: the prompt already lists the earlier titles, so an old session's
    // history would only cost tokens. Stopped once the topic step is over, however it ended.
    await useChat.getState().stop(chatId);
  }
}

/** Makes the slot's video; resolves once a rendered file exists, with what went wrong posting it, if anything. */
async function makeVideo(run: Run): Promise<{ projectId: string; postError: string | null }> {
  const a = run.autopilot;
  /** "Stop now" ends the work at the next step. */
  const live = () => {
    if (run.stopped) throw new SlotError(stored('autopilot.slot.stopped'));
  };
  const settings = useApp.getState().settings ?? (await getSettings());
  const topic = await pickTopic(run);
  live();

  const { project, chat } = await createTopicProject(
    { title: topic.title, kind: topic.kind, lengthSec: a.lengthSec },
    { settings: { ...settings, language: a.language }, agent: a.agentId, styleId: a.styleId },
  );
  run.projectChatId = chat.id;
  // From here a failure keeps the project, linked from the slot, for the user to look at.
  await updateSlot(run.slot.id, { projectId: project.id });
  notifyAutopilotChanged();
  live();
  await useChat.getState().setAuto(chat.id, true);

  const skip = settings.frameCheck === false;
  const agentParts = (text: string): MessagePart[] => [
    ...(skip ? [{ type: 'text' as const, text: SKIP_FRAME_CHECK }] : []),
    { type: 'text', text },
  ];
  const opts = { agentId: a.agentId, job: { projectId: project.id, title: topic.title } };
  const build = buildAutopilotBuildPrompt(topic.title, a.lengthSec, { language: a.language, frameCheck: !skip, voiceId: a.voiceId });
  replyOf(
    await turn(run, chat.id, [{ type: 'text', text: i18n.t('autopilot.slot.buildMessage', { title: topic.title, seconds: a.lengthSec }) }], {
      ...opts,
      promptParts: agentParts(build),
    }),
  );
  // A finished video only: a render the agent left running in the background is not one yet.
  const rendered = () => finishedRender(project.id);
  if (!(await rendered())) {
    replyOf(
      await turn(run, chat.id, [{ type: 'text', text: i18n.t('autopilot.slot.renderNowMessage') }], {
        ...opts,
        promptParts: agentParts(AUTOPILOT_RENDER_NOW),
      }),
    );
    if (!(await rendered())) throw new SlotError(stored('autopilot.slot.noRender'));
  }
  live();

  const info = await mediaProbe(project.id).catch(() => null);
  live();
  await updateProject(project.id, {
    status: 'rendered',
    durationSec: info?.durationSec ?? null,
    reviewState: a.review ? 'pending' : 'approved',
  });
  await setSchedule(project.id, run.slot.dueAt);
  // Stopped during the writes above: the video stays, but is no longer due at the slot's time.
  if (run.stopped) await setSchedule(project.id, null).catch(() => {});
  useApp.getState().bumpProjects();
  live();
  // Review first posts on Approve instead. A failed post keeps the video: the slot says what happened.
  const postError = a.review ? null : await postAutopilotVideo(project, a, run.slot.dueAt);
  if (!a.review) useApp.getState().bumpProjects();
  return { projectId: project.id, postError };
}

async function produce(run: Run): Promise<void> {
  try {
    const { projectId, postError } = await makeVideo(run);
    if (!run.stopped) await updateSlot(run.slot.id, { status: 'done', projectId, error: postError });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // The Agents board says what the slot says, and a late `done` can't change it back.
    if (run.projectChatId) await failChatJob(run.projectChatId, error);
    // A stopped slot was already failed by "Stop now".
    if (!run.stopped) {
      await updateSlot(run.slot.id, { status: 'failed', error }).catch((err) => console.error('Tayang: slot update failed', err));
    }
  } finally {
    // The video's chat stays; its agent process ends (a later message starts a new one with a recap).
    // A chat still streaming after the engine's own turn ended normally is running a newer turn the user
    // started (say a quick reply): that session is theirs now, so it is left alone, not stopped.
    const chatId = run.projectChatId;
    const userTurn = !!chatId && !run.cutShort && !!useChat.getState().streaming[chatId];
    if (chatId && !userTurn) await useChat.getState().retire(chatId).catch(() => {});
    if (running === run) running = null;
    notifyAutopilotChanged();
  }
}

/**
 * Slots still `making` from an earlier run of the app: it was closed while they were made. Their agents may
 * have outlived a reload of the window, so their topic and project chats are stopped too (errors ignored).
 */
async function recover(): Promise<boolean> {
  let changed = false;
  const jobs = await listJobs().catch(() => []);
  for (const s of await listSlots(EPOCH, FOREVER)) {
    if (s.status !== 'making' || s.id === running?.slot.id) continue;
    await agentStop(topicChatId(s.autopilotId)).catch(() => {});
    if (s.projectId) {
      const chats = await listChats(s.projectId).catch(() => []);
      for (const c of chats) {
        await agentStop(c.id).catch(() => {});
        // After a reload of the window Rust's start-up check never ran: the board would say Working forever.
        const job = jobs.find((j) => j.id === buildJobId(c.id) && j.status === 'working');
        if (job) {
          await upsertJob({ ...job, status: 'failed', note: stored('agents.closedNote'), updatedAt: new Date().toISOString() }).catch(() => {});
        }
      }
    }
    await updateSlot(s.id, { status: 'failed', error: stored('agents.closedNote') });
    changed = true;
  }
  return changed;
}

/** One engine pass: startup recovery (once), slot upkeep, and starting the next video when nothing runs. */
export async function pass(now: Date = new Date()): Promise<void> {
  let changed = false;
  try {
    // Backup for the turn timer, which a hidden window may throttle: the tick still arrives.
    const r = running;
    if (r?.turnStartedAt != null && now.getTime() - r.turnStartedAt >= TURN_TIMEOUT_MS) await r.timeOut?.();
    // The first pass looks at every older slot (the app may have been closed for days); later ones only
    // at the last day, so the read stays small however long the autopilots run.
    const first = !recovered;
    if (!recovered) {
      changed = (await recover()) || changed;
      recovered = true;
    }
    const active = (await listAutopilots()).filter((a) => a.status === 'active');
    const from = first ? EPOCH : new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const slots = await listSlots(from, new Date(now.getTime() + (PLAN_DAYS + 1) * 24 * 60 * 60_000).toISOString());

    // Due times are compared as instants: Rust returns `...:00Z`, JS `...:00.000Z`.
    const have = new Set(slots.map((s) => `${s.autopilotId}|${Date.parse(s.dueAt)}`));
    for (const a of active) {
      for (const at of planSlots(a, now, PLAN_DAYS)) {
        if (have.has(`${a.id}|${at.getTime()}`)) continue;
        // Rust refuses a new slot for an autopilot paused since the list above: skip it, go on with the rest.
        const made = await upsertSlot(a.id, at.toISOString()).catch(() => null);
        if (!made) continue;
        slots.push(made);
        have.add(`${a.id}|${at.getTime()}`);
        changed = true;
      }
    }
    for (const [i, s] of slots.entries()) {
      if (s.status !== 'planned' || Date.parse(s.dueAt) >= now.getTime()) continue;
      slots[i] = await updateSlot(s.id, { status: 'skipped' });
      changed = true;
    }

    if (running) return;
    const byId = new Map(active.map((a) => [a.id, a]));
    const until = now.getTime() + START_WITHIN_MS;
    const next = slots
      .filter((s) => {
        const at = Date.parse(s.dueAt);
        return s.status === 'planned' && byId.has(s.autopilotId) && at >= now.getTime() && at <= until;
      })
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
    if (!next) return;
    // Paused (or deleted) since the list above was read: don't start.
    const owner = (await listAutopilots()).find((a) => a.id === next.autopilotId);
    if (owner?.status !== 'active') return;
    const slot = await updateSlot(next.id, { status: 'making', error: null });
    changed = true;
    const run: Run = {
      slot,
      autopilot: owner,
      chatId: null,
      projectChatId: null,
      stopped: false,
      endTurn: null,
      turnStartedAt: null,
      timeOut: null,
      cutShort: false,
    };
    running = run;
    void produce(run);
  } finally {
    if (changed) notifyAutopilotChanged();
  }
}

/**
 * "Stop now": cancels the running turn (awaited, so the agent has stopped first) and fails the slot
 * "Stopped", but only a slot that is still `making` when read again (a stale button can't fail a done one).
 */
export async function stopSlot(slot: AutopilotSlot): Promise<void> {
  const run = running;
  const mine = !!run && run.slot.id === slot.id;
  if (run && mine) {
    run.stopped = true;
    if (run.chatId) await useChat.getState().cancel(run.chatId);
    run.endTurn?.({ kind: 'stopped' });
  }
  // The running slot is known to be making; any other is read again first.
  const making = mine || (await listSlots(slot.dueAt, slot.dueAt)).find((s) => s.id === slot.id)?.status === 'making';
  if (making) await updateSlot(slot.id, { status: 'failed', error: stored('autopilot.slot.stopped') });
  notifyAutopilotChanged();
}

/** The tray's "Pause all autopilots": no new videos start; one being made finishes. */
export async function pauseAll(): Promise<void> {
  try {
    for (const a of await listAutopilots()) {
      if (a.status === 'active') await setAutopilotStatus(a.id, 'paused');
    }
  } finally {
    notifyAutopilotChanged();
  }
}

let stopEngine: (() => void) | null = null;

/** Starts the engine once (call before `startScheduler`, which runs the first pass). Returns the stop. */
export function startAutopilot(): () => void {
  if (stopEngine) return stopEngine;
  useChat.getState().listen();
  const later = (p: () => Promise<() => void> | undefined) =>
    Promise.resolve()
      .then(p)
      .catch((e) => {
        console.error('Tayang: autopilot listener failed', e);
        return undefined;
      });
  const offUpdates = later(() => onAgentUpdate(({ chatId, update }) => onUpdate(chatId, update)));
  const offPause = later(() => listen(PAUSE_ALL_EVENT, () => void pauseAll().catch((e) => console.error('Tayang: pause all failed', e))));
  const offTick = onTick(pass);
  const offStop = setStopNowHandler(stopSlot);
  const stop = () => {
    if (stopEngine !== stop) return;
    stopEngine = null;
    offTick();
    offStop();
    void offUpdates.then((f) => f?.());
    void offPause.then((f) => f?.());
  };
  stopEngine = stop;
  return stop;
}

/** Tests only: forget everything this module keeps between calls. */
export function resetAutopilotEngine(): void {
  stopEngine?.();
  running = null;
  recovered = false;
  waiters.clear();
}
