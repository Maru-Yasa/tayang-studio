import { act, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import type { AgentUpdate, FileInfo } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  getChat: vi.fn().mockResolvedValue(null),
  listMessages: vi.fn().mockResolvedValue([]),
  addMessage: vi.fn().mockResolvedValue(null),
  agentStart: vi.fn().mockResolvedValue(undefined),
  agentPrompt: vi.fn().mockResolvedValue(undefined),
  agentCancel: vi.fn(),
  agentStop: vi.fn().mockResolvedValue(undefined),
  agentRespondPermission: vi.fn(),
  upsertJob: vi.fn().mockResolvedValue(undefined),
  listJobs: vi.fn().mockResolvedValue([]),
  latestRenderInfo: vi.fn().mockResolvedValue(null),
  mediaProbe: vi.fn().mockResolvedValue({ durationSec: 12, fps: 30, frames: 360, width: 1080, height: 1920 }),
  assetUrl: (p: string) => p,
}));
const updates: ((e: { chatId: string; update: AgentUpdate }) => void)[] = [];
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}),
  onAgentUpdate: vi.fn(async (cb: (e: { chatId: string; update: AgentUpdate }) => void) => {
    updates.push(cb);
    return () => {};
  }),
  onPermission: vi.fn(async () => () => {}),
}));

import { latestRenderInfo, mediaProbe, upsertJob } from '@/lib/ipc';
import { renderTiming, resetRenderCheck } from '@/lib/renderCheck';
import { resetLateRenders, settleLateRenders } from '@/lib/buildJobs';
import { isRenderTool } from '@/lib/renderTool';
import { setUiLanguage } from '@/i18n';
import { localized } from '@/lib/stored';
import { useChat, waitsForAnswer } from '@/state/chat';
import { setRenderArgv, useRender } from '@/state/render';

const emit = (chatId: string, update: AgentUpdate) => act(async () => updates.forEach((cb) => cb({ chatId, update })));
const lastJob = () => vi.mocked(upsertJob).mock.calls.at(-1)![0];
const render = (at: Date, size = 10): FileInfo => ({ path: '/w/p1/renders/v.mp4', name: 'v.mp4', size, modifiedAt: at.toISOString() });
const job = { projectId: 'p1', title: 'Jalur Rempah' };

beforeEach(() => {
  vi.clearAllMocks();
  renderTiming.stableMs = 0;
  vi.mocked(latestRenderInfo).mockResolvedValue(null);
  updates.length = 0;
  useChat.getState().reset();
  useChat.getState().listen();
});

describe('isRenderTool', () => {
  it.each([
    ['Run npx -y hyperframes@0.9.10 render --output renders/a-1.mp4', true],
    ['`npx hyperframes render`', true],
    ['npx remotion render src/index.ts Main out/v.mp4', true],
    ['npx -y @remotion/cli render Main', true],
    ['npx remotion studio', true],
    ['npm run render', true],
    ['pnpm render', true],
    ['pnpm run render -- --quality high', true],
    ['ffmpeg -y -i frames/%04d.png -c:v libx264 renders/final.mp4', true],
    ['ffmpeg -i in.mp4 -vf scale=320:-1 thumb.png', false],
    ['npx hyperframes preview', false],
    ['npm run build', false],
    ['Read renders/a.mp4', false],
    // Piped, chained, or with flags after the output.
    ['ffmpeg -y -i frames/%04d.png -c:v libx264 renders/final.mp4 2>&1 | tail -5', true],
    ['ffmpeg -i in.mov renders/out.mp4 -y', true],
    ['nohup /opt/homebrew/bin/ffmpeg -i in.mov out.mp4 > log.txt &', true],
    ['cd p && ffmpeg -i a.mov -c:v libx264 out.mp4 && ls renders', true],
    ['npx hyperframes render --output renders/a.mp4 2>&1 | tail -20', true],
    ['ffmpeg -i in.mp4 -vf scale=320:-1 thumb.png 2>&1 | tail -3', false],
    ['npx hyperframes render --help', false],
    ['npx remotion --version', false],
    ['', false],
  ])('%s → %s', (title, expected) => {
    expect(isRenderTool(title, null)).toBe(expected);
  });

  it("matches the project's own render command from tayang.json", () => {
    expect(isRenderTool('Run node scripts/make-video.mjs --out renders', ['node', 'scripts/make-video.mjs'])).toBe(true);
    expect(isRenderTool('Run node scripts/other.mjs', ['node', 'scripts/make-video.mjs'])).toBe(false);
    // Whole words only: `make` is not `cmake`.
    expect(isRenderTool('cmake --build .', ['make'])).toBe(false);
    expect(isRenderTool('cd p && make 2>&1 | tail', ['make'])).toBe(true);
  });
});

describe('waitsForAnswer', () => {
  const agent = (text: string) => ({ id: 'a', chatId: 'c', role: 'agent' as const, parts: [{ type: 'text' as const, text }], createdAt: '' });
  it('is true for a question at the end or an open surface', () => {
    expect(waitsForAnswer(agent('Mau pakai suara yang mana?'))).toBe(true);
    expect(waitsForAnswer(agent('Which one？ '))).toBe(true);
    expect(waitsForAnswer(agent('Pick one\n\n```a2ui\n{"version":"v0.9","createSurface":{"surfaceId":"s","catalogId":"c"}}\n```'))).toBe(true);
    expect(waitsForAnswer(agent('Is it ok? I made the scenes.'))).toBe(false);
    expect(waitsForAnswer(undefined)).toBe(false);
  });
});

describe('a project chat build job at the end of a turn', () => {
  it('is done only with a video rendered during the turn, named in the note', async () => {
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    vi.mocked(latestRenderInfo).mockResolvedValue(render(new Date(Date.now() + 500)));
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(lastJob()).toMatchObject({ status: 'done', note: 'v.mp4' }));
    expect(latestRenderInfo).toHaveBeenCalledWith('p1');
    expect(mediaProbe).toHaveBeenCalledWith('p1');
  });

  it('done only once the video is finished: it reads as a video and stays the same for 3 s', async () => {
    renderTiming.stableMs = 3000;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
      vi.mocked(latestRenderInfo).mockResolvedValue(render(new Date(Date.now() + 500)));
      await emit('c1', { kind: 'done', stopReason: 'end_turn' });
      await act(async () => vi.advanceTimersByTimeAsync(2900));
      expect(lastJob()).toMatchObject({ status: 'working' });
      await act(async () => vi.advanceTimersByTimeAsync(200));
      await waitFor(() => expect(lastJob()).toMatchObject({ status: 'done', note: 'v.mp4' }));
      expect(latestRenderInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['ffprobe finds no video in it yet', () => vi.mocked(mediaProbe).mockRejectedValueOnce(new Error('no video stream found'))],
    ['ffprobe reads no length', () => vi.mocked(mediaProbe).mockResolvedValueOnce({ durationSec: 0, fps: 30, frames: 0, width: 1080, height: 1920 })],
    [
      'it is still growing',
      () => {
        const at = new Date(Date.now() + 500);
        vi.mocked(latestRenderInfo).mockResolvedValueOnce(render(at, 10)).mockResolvedValueOnce(render(at, 4000));
      },
    ],
  ])('needs you while a render left running in the background is still being written (%s)', async (_, arrange) => {
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    vi.mocked(latestRenderInfo).mockResolvedValue(render(new Date(Date.now() + 500)));
    arrange();
    await emit('c1', { kind: 'text', text: 'Render jalan di latar belakang.' });
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(lastJob()).toMatchObject({ status: 'needs-you', note: 'No video yet. The agent stopped before rendering' }));
  });

  it('needs you, "stopped before rendering", without a new video', async () => {
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    // An older render does not count, and neither does an empty file.
    vi.mocked(latestRenderInfo).mockResolvedValueOnce(render(new Date(Date.now() - 60_000)));
    await emit('c1', { kind: 'text', text: 'Pipeline sedang berjalan di latar belakang.' });
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(lastJob()).toMatchObject({ status: 'needs-you', note: 'No video yet. The agent stopped before rendering' }));
    setUiLanguage('id');
    expect(localized(lastJob().note!)).toBe('Belum ada video. Agen berhenti sebelum videonya jadi');
  });

  it('needs your answer when the agent ended on a question', async () => {
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    vi.mocked(latestRenderInfo).mockResolvedValueOnce(render(new Date(), 0));
    await emit('c1', { kind: 'text', text: 'Mau pakai suara yang mana?' });
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(lastJob()).toMatchObject({ status: 'needs-you', note: 'The agent is waiting for your answer' }));
    setUiLanguage('id');
    expect(localized(lastJob().note!)).toBe('Agen menunggu jawabanmu');
  });

  it('still needs your answer when a system line landed after the question', async () => {
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    await emit('c1', { kind: 'text', text: 'Mau pakai suara yang mana?' });
    useChat.getState().notice('c1', 'The agent is still working. Wait for it to finish, then send again.');
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(lastJob()).toMatchObject({ status: 'needs-you', note: 'The agent is waiting for your answer' }));
  });

  it('a render that finished between two turns counts, even when the second turn rendered nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await useChat.getState().send('c1', [{ type: 'text', text: 'render it' }], { agentId: 'claude', job });
      const first = Date.now();
      await emit('c1', { kind: 'done', stopReason: 'end_turn' });
      await waitFor(() => expect(lastJob()).toMatchObject({ status: 'needs-you' }));
      expect(Date.parse(lastJob().renderBaselineAt!)).toBe(first);
      // The background render finishes; a minute later the user asks about it.
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      const finished = render(new Date());
      await act(async () => vi.advanceTimersByTimeAsync(50_000));
      await useChat.getState().send('c1', [{ type: 'text', text: 'is it done?' }], { agentId: 'claude' });
      // Still the first turn's start while the job waits.
      expect(Date.parse(lastJob().renderBaselineAt!)).toBe(first);
      vi.mocked(latestRenderInfo).mockResolvedValue(finished);
      await emit('c1', { kind: 'done', stopReason: 'end_turn' });
      await waitFor(() => expect(lastJob()).toMatchObject({ status: 'done', note: 'v.mp4', renderBaselineAt: null }));
      // The next turn starts a new baseline.
      vi.mocked(latestRenderInfo).mockResolvedValue(null);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await useChat.getState().send('c1', [{ type: 'text', text: 'make another' }], { agentId: 'claude' });
      expect(Date.parse(lastJob().renderBaselineAt!)).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it('a file that probes fine but changes within 3 s waits for the late check, which settles it from the turn start', async () => {
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    const at = new Date(Date.now() + 200);
    const rewritten = { ...render(new Date(at.getTime() + 300)), size: 12 };
    vi.mocked(latestRenderInfo).mockResolvedValueOnce(render(at)).mockResolvedValue(rewritten);
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(lastJob()).toMatchObject({ status: 'needs-you' }));
    resetLateRenders();
    // Written well after the file's last change: only the baseline lets the late check accept it.
    const waiting = { ...lastJob(), updatedAt: new Date(at.getTime() + 60_000).toISOString() };
    await settleLateRenders(Date.now() + 120_000, [waiting]);
    expect(lastJob()).toMatchObject({ status: 'done', note: 'v.mp4' });
  });

  it('without ffprobe, a video that stays the same is done; the skipped probe is logged once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetRenderCheck();
    try {
      vi.mocked(mediaProbe).mockRejectedValue(new Error('could not run ffprobe: No such file or directory (os error 2)'));
      for (const text of ['go', 'again']) {
        await useChat.getState().send('c1', [{ type: 'text', text }], { agentId: 'claude', job });
        vi.mocked(latestRenderInfo).mockResolvedValue(render(new Date(Date.now() + 500)));
        await emit('c1', { kind: 'done', stopReason: 'end_turn' });
        await waitFor(() => expect(lastJob()).toMatchObject({ status: 'done', note: 'v.mp4' }));
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('ffprobe');
      // A file ffprobe can run on but can't read is still no video.
      vi.mocked(mediaProbe).mockRejectedValue(new Error('no video stream found'));
      await useChat.getState().send('c1', [{ type: 'text', text: 'third' }], { agentId: 'claude', job });
      await emit('c1', { kind: 'done', stopReason: 'end_turn' });
      await waitFor(() => expect(lastJob()).toMatchObject({ status: 'needs-you' }));
    } finally {
      warn.mockRestore();
      vi.mocked(mediaProbe).mockResolvedValue({ durationSec: 12, fps: 30, frames: 360, width: 1080, height: 1920 });
    }
  });

  it("leaves the autopilot's job to the autopilot: done at the turn's end, no lookup", async () => {
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job, background: true });
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    expect(lastJob()).toMatchObject({ status: 'done', note: null });
    expect(latestRenderInfo).not.toHaveBeenCalled();
  });

  it('a check from an earlier turn never overwrites a newer turn', async () => {
    let resolve!: (v: FileInfo | null) => void;
    vi.mocked(latestRenderInfo).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await useChat.getState().send('c1', [{ type: 'text', text: 'again' }], { agentId: 'claude', job });
    await act(async () => resolve(null));
    expect(lastJob()).toMatchObject({ status: 'working' });
  });
});

describe('a render the agent runs', () => {
  it('shows as working "Rendering video" while it runs, and ends with the tool or the turn', async () => {
    setRenderArgv('p1', null);
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    const started = useChat.getState().turnStartedAt.c1;
    expect(started).toBeGreaterThan(0);
    await emit('c1', { kind: 'tool', toolCallId: 't1', title: 'Run npx hyperframes render --output renders/a.mp4', status: 'running', toolKind: 'execute' });
    expect(useRender.getState().runs.p1).toMatchObject({ source: 'agent', chatId: 'c1', toolCallId: 't1' });
    expect(lastJob()).toMatchObject({ status: 'working', note: 'Rendering video' });
    // Another tool finishing is not the render ending.
    await emit('c1', { kind: 'tool', toolCallId: 't2', title: 'Read STYLE.md', status: 'done', toolKind: 'read' });
    expect(useRender.getState().runs.p1).toBeDefined();
    await emit('c1', { kind: 'tool', toolCallId: 't1', title: 'Run npx hyperframes render --output renders/a.mp4', status: 'done', toolKind: 'execute' });
    expect(useRender.getState().runs.p1).toBeUndefined();
    expect(lastJob()).toMatchObject({ status: 'working', note: null });

    await emit('c1', { kind: 'tool', toolCallId: 't3', title: 'npm run render', status: 'pending', toolKind: 'execute' });
    expect(useRender.getState().runs.p1).toBeDefined();
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    expect(useRender.getState().runs.p1).toBeUndefined();
    expect(useChat.getState().turnStartedAt.c1).toBeUndefined();
  });

  it('keeps saying "Rendering video" after a permission prompt during the render is answered', async () => {
    setRenderArgv('p1', null);
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    await emit('c1', { kind: 'tool', toolCallId: 't1', title: 'npx hyperframes render', status: 'running', toolKind: 'execute' });
    useChat.setState({ permissions: { c1: [{ chatId: 'c1', requestId: 'r1', title: 't', commands: [], options: [] }] } });
    await act(async () => useChat.getState().respondPermission('c1', 'allow'));
    expect(lastJob()).toMatchObject({ status: 'working', note: 'Rendering video' });
  });

  it('an error ends it too, and chats without a project never track one', async () => {
    await useChat.getState().send('c1', [{ type: 'text', text: 'go' }], { agentId: 'claude', job });
    await emit('c1', { kind: 'tool', toolCallId: 't1', title: 'pnpm render', status: 'running', toolKind: 'execute' });
    await emit('c1', { kind: 'error', message: 'boom' });
    expect(useRender.getState().runs).toEqual({});
    await useChat.getState().send('c2', [{ type: 'text', text: 'go' }], { agentId: 'claude' });
    await emit('c2', { kind: 'tool', toolCallId: 't1', title: 'pnpm render', status: 'running', toolKind: 'execute' });
    expect(useRender.getState().runs).toEqual({});
  });
});
