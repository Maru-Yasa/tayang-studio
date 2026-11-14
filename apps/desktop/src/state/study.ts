import { create } from 'zustand';
import type { AgentId, AgentUpdate, Job, JobStatus, PermissionRequest } from '@tayang/shared';
import { buildStudyStylePrompt, parseStyleResult } from '@tayang/skills';
import {
  agentCancel,
  agentPrompt,
  agentRespondPermission,
  agentStart,
  agentStop,
  assetUrl,
  deleteJob,
  listStyles,
  keepStyleRefs,
  makeStyleSheets,
  makeStylePreview,
  readStyleResult,
  saveStyle,
  removeStudyDir,
  studyDir,
  upsertJob,
} from '@/lib/ipc';
import { i18n } from '@/i18n';
import { stored } from '@/lib/stored';
import { agentErrorText, trackAgentError } from '@/lib/agents';
import { onAgentUpdate, onPermission } from '@/lib/events';
import { refreshJobs } from '@/state/jobs';
import { track } from '@/lib/analytics';

/** `finishing`: the agent is done and Tayang is saving the style and making its preview; it can't be cancelled. */
export type StudyPhase = 'idle' | 'running' | 'finishing' | 'done' | 'failed';

interface StudyState {
  phase: StudyPhase;
  url: string;
  studyId: string | null;
  /** Number of agent tool calls so far; drives the progress steps. */
  toolCalls: number;
  /** "Ran without asking: …" lines from auto mode, oldest first. */
  ranLog: string[];
  request: PermissionRequest | null;
  /** Requests that arrived while `request` was open, oldest first. */
  queue: PermissionRequest[];
  error: string | null;
  /** Bumped when a style was saved so the library reloads. */
  savedVersion: number;
  /** `replaceJobId`: a failed study's job, deleted once this study's own job is written. */
  /** `restyleId`: study the link again and save the result over that copied style (same id and date). */
  start(url: string, agent: AgentId, replaceJobId?: string, restyleId?: string): Promise<void>;
  /** Allow once only. Null cancels the study. */
  respond(optionId: string | null): Promise<void>;
  /** Stop a running study; its job ends failed "Cancelled". */
  cancel(): Promise<void>;
  dismiss(): void;
}

export const studyChatId = (studyId: string) => `study-${studyId}`;

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
    .replace(/-/g, '')
    .slice(0, 10);

let unlisten: Promise<() => void>[] = [];

export const useStudy = create<StudyState>((set, get) => {
  let agent: AgentId = 'claude';

  /** A failed study's job that this one replaces: deleted once this study's own job is written. */
  let staleJobId: string | null = null;
  /** The copied style a running study re-learns, or null for a new one. */
  let restyle: string | null = null;

  const dropStaleJob = async () => {
    const old = staleJobId;
    if (!old) return;
    staleJobId = null;
    await deleteJob(old).catch(() => {});
    await refreshJobs().catch(() => {});
  };

  /** Resolves true when the job was written. */
  const writeJob = async (
    status: JobStatus,
    note: string | null,
    studyId: string | null = get().studyId,
    url: string = get().url,
  ): Promise<boolean> => {
    if (!studyId) return false;
    const job: Job = {
      id: studyChatId(studyId),
      kind: 'study-style',
      title: stored('agents.studyTitle'),
      projectId: null,
      chatId: studyChatId(studyId),
      agentId: agent,
      status,
      progress: null,
      sourceUrl: url,
      note: note ?? (status === 'working' ? url : null),
      updatedAt: new Date().toISOString(),
    };
    try {
      await upsertJob(job);
    } catch {
      /* the job board is best effort */
      return false;
    }
    await refreshJobs().catch(() => {});
    return true;
  };

  /** Answers every open request with null (cancelled) and empties the queue. */
  const dropRequests = () => {
    const { request, queue } = get();
    set({ request: null, queue: [] });
    for (const r of [...(request ? [request] : []), ...queue]) {
      void agentRespondPermission(r.requestId, null).catch(() => {});
    }
  };

  /** The study's agent has nothing left to do once it ends, however it ends. */
  const stopAgent = async (studyId: string | null) => {
    if (studyId) await agentStop(studyChatId(studyId)).catch(() => {});
  };

  /** The study folder (download, frames, result) is only ever needed while the study runs. */
  const cleanUp = async (studyId: string | null) => {
    if (studyId) await removeStudyDir(studyId).catch(() => {});
  };

  /** `note` is what the job board keeps; it defaults to the message shown now. */
  const fail = async (message: string, note: string = message) => {
    track('style study failed', { agent });
    const { studyId, url } = get();
    dropRequests();
    set({ phase: 'failed', error: message });
    // Stop the agent first (it may still be writing the download), then delete what it left behind.
    await stopAgent(studyId);
    await cleanUp(studyId);
    // The old study's job is always written (it must not stay on Working); only the current study may drop
    // the stale job it replaces.
    const written = await writeJob('failed', note, studyId, url);
    if (written && get().studyId === studyId) await dropStaleJob();
  };

  const finish = async () => {
    const { studyId, url } = get();
    if (!studyId || get().phase !== 'running') return;
    // From here the study can't be cancelled and late agent events are ignored.
    set({ phase: 'finishing' });
    dropRequests();
    await stopAgent(studyId);
    const mine = () => get().studyId === studyId && get().phase === 'finishing';
    try {
      const raw = await readStyleResult(studyId);
      const parsed = raw ? parseStyleResult(raw, url) : null;
      if (!mine()) return;
      if (!parsed) return fail(i18n.t('agents.studyUnreadable'), stored('agents.studyUnreadable'));
      // Studied again: the same style, its id and date kept, everything else from this study.
      const before = restyle ? await listStyles().then((all) => all.find((x) => x.id === restyle)).catch(() => undefined) : undefined;
      if (!mine()) return;
      const style = {
        ...parsed,
        id: before?.id ?? `copied-${studyId}`,
        createdAt: before?.createdAt ?? new Date().toISOString(),
        ...(before ? { previewUrl: before.previewUrl ?? null, previewVideoUrl: before.previewVideoUrl ?? null, references: before.references ?? [] } : {}),
      };
      await saveStyle(style);
      // A short silent preview from the downloaded video, and the reference frames the study picked.
      // Neither fails the study.
      let made: Awaited<ReturnType<typeof makeStylePreview>> = null;
      let references: string[] = [];
      // Contact sheets of the whole source first: the preview deletes the source.
      try {
        references = await makeStyleSheets(studyId, style.id);
      } catch {
        /* no sheets: the frames the agent kept, if any */
      }
      try {
        made = await makeStylePreview(studyId, style.id);
      } catch {
        /* the style is saved without a preview */
      }
      if (!references.length) {
        try {
          references = await keepStyleRefs(studyId, style.id);
        } catch {
          /* the style is saved without reference frames */
        }
      }
      if (made || references.length) {
        await saveStyle({
          ...style,
          ...(made ? { previewUrl: assetUrl(made.posterPath), previewVideoUrl: made.previewPath ? assetUrl(made.previewPath) : null } : {}),
          // No new frames (an older agent, or none picked): keep the ones the style had.
          references: references.length ? references : (style.references ?? []),
        });
      }
      await cleanUp(studyId);
      if (!mine()) return;
      set((s) => ({ phase: 'done', request: null, error: null, savedVersion: s.savedVersion + 1 }));
      track('style copied', { engine: parsed.engine ?? 'unknown', restudy: !!restyle, agent, sheets: references.length });
      await writeJob('done', parsed.name, studyId, url);
    } catch (e) {
      if (mine()) await fail(e instanceof Error ? e.message : String(e));
      else await cleanUp(studyId);
    }
  };

  const listen = () => {
    if (unlisten.length) return;
    unlisten = [
      onAgentUpdate(({ chatId, update }: { chatId: string; update: AgentUpdate }) => {
        const id = get().studyId;
        if (!id || chatId !== studyChatId(id) || get().phase !== 'running') return;
        if (update.kind === 'tool') {
          if (update.toolCallId.startsWith('auto-')) set((s) => ({ ranLog: [...s.ranLog, update.title] }));
          else set((s) => ({ toolCalls: s.toolCalls + (update.status === 'done' ? 1 : 0) }));
        }
        else if (update.kind === 'error') {
          trackAgentError(update.message, agent);
          void fail(agentErrorText(update.message, agent), agentErrorText(update.message, agent, 'en'));
        }
        else if (update.kind === 'done') void finish();
      }),
      onPermission((req) => {
        const id = get().studyId;
        if (!id || req.chatId !== studyChatId(id) || get().phase !== 'running') return;
        if (get().request) set((s) => ({ queue: [...s.queue, req] }));
        else set({ request: req });
      }),
    ];
  };

  return {
    phase: 'idle',
    url: '',
    studyId: null,
    toolCalls: 0,
    ranLog: [],
    request: null,
    queue: [],
    error: null,
    savedVersion: 0,

    async start(url, agentId, replaceJobId, restyleId) {
      if (get().phase === 'running' || get().phase === 'finishing') return;
      agent = agentId;
      const studyId = newId();
      set({ phase: 'running', url, studyId, toolCalls: 0, ranLog: [], request: null, queue: [], error: null });
      staleJobId = replaceJobId ?? null;
      restyle = restyleId ?? null;
      listen();
      /** Cancelled (or replaced) while a step was pending: nothing may be left running or on disk. */
      const gone = () => get().studyId !== studyId || get().phase !== 'running';
      const abandon = async () => {
        await stopAgent(studyId);
        await cleanUp(studyId);
      };
      try {
        const dir = await studyDir(studyId);
        if (gone()) return await abandon();
        if (await writeJob('working', null, studyId, url)) await dropStaleJob();
        // Style studies always run in auto mode (the app enforces it too).
        await agentStart(studyChatId(studyId), agentId, true);
        if (gone()) return await abandon();
        await agentPrompt(studyChatId(studyId), [{ type: 'text', text: buildStudyStylePrompt(url, dir) }]);
      } catch (e) {
        if (gone()) return await abandon();
        {
          const message = e instanceof Error ? e.message : String(e);
          await fail(agentErrorText(message, agentId), agentErrorText(message, agentId, 'en'));
        }
      }
    },

    async respond(optionId) {
      const { request, queue, studyId } = get();
      if (!request || !studyId) return;
      const [next = null, ...rest] = queue;
      set({ request: next, queue: rest });
      await agentRespondPermission(request.requestId, optionId).catch(() => {});
      if (optionId === null) {
        await agentCancel(studyChatId(studyId)).catch(() => {});
        await fail(i18n.t('agents.cancelledStudy'), stored('agents.cancelledStudy'));
      }
    },

    async cancel() {
      const { phase, studyId } = get();
      if (phase !== 'running' || !studyId) return;
      await agentCancel(studyChatId(studyId)).catch(() => {});
      await fail(i18n.t('agents.cancelled'), stored('agents.cancelled'));
    },

    dismiss: () => set({ phase: 'idle', error: null, studyId: null, url: '' }),
  };
});
