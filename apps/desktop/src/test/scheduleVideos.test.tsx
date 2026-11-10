import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { AgentUpdate, Chat, ChatMessage, Project } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  listProjects: vi.fn(),
  scheduleVideos: vi.fn(),
  listChats: vi.fn(),
  createChat: vi.fn(),
  getChat: vi.fn(),
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
  assetUrl: (p: string) => p,
}));
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}),
  onAgentUpdate: vi.fn(async (_cb: (e: { chatId: string; update: AgentUpdate }) => void) => () => {}),
  onPermission: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { addMessage, agentPrompt, getChat, listChats, listProjects, scheduleVideos } from '@/lib/ipc';
import { MessageList } from '@/components/MessageList';
import { ScheduleDialog, defaultSlot } from '@/components/ScheduleDialog';
import { extractA2ui } from '@/a2ui/parse';
import { applyMessages, emptySurfaces } from '@/a2ui/surface';
import { onAutopilotChanged } from '@/lib/autopilotHooks';
import { batchReason, checkScheduleItems, parseRfc3339 } from '@/lib/scheduleVideos';
import { setUiLanguage } from '@/i18n';
import { useApp } from '@/state/app';
import { BUSY_NOTE, useChat } from '@/state/chat';

const proj = (extra: Partial<Project> = {}): Project => ({
  id: 'p1', title: 'Jalur Rempah', slug: 'jalur', folder: '/w/jalur', kind: 'explainer', format: '9:16', language: 'id',
  status: 'rendered', styleId: null, scheduledAt: null, reviewState: 'none', postedAt: null,
  remindedAt: null, reviewRemindedAt: null, durationSec: null, createdAt: 'c', updatedAt: 'u', ...extra,
});
const chatRow = (id: string, projectId: string | null): Chat => ({ id, projectId, agentId: 'claude', title: 't', createdAt: 'c', updatedAt: 'u' }) as Chat;

const DAY = 24 * 60 * 60 * 1000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString().replace(/\.\d+Z$/, 'Z');

const card = (items: unknown[], surfaceId = 'plan', label = 'Schedule these') =>
  '```a2ui\n' +
  [
    { version: 'v0.9', createSurface: { surfaceId, catalogId: 'basic' } },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId,
        components: [
          { id: 'root', component: 'Column', children: ['go'] },
          { id: 'go-t', component: 'Text', text: label },
          { id: 'go', component: 'Button', child: 'go-t', action: { event: { name: 'schedule_videos', context: { items } } } },
        ],
      },
    },
  ]
    .map((m) => JSON.stringify(m))
    .join('\n') +
  '\n```';

const agentMsg = (chatId: string, text: string, id = 'm1'): ChatMessage => ({
  id, chatId, role: 'agent', parts: [{ type: 'text', text }], createdAt: '2026-11-04T00:00:00Z',
});

/** Renders the chat from the store, as a screen does, so lines Tayang adds show up. */
function Chat({ chatId, onA2uiAction }: { chatId: string; onA2uiAction?: () => boolean }) {
  const messages = useChat((s) => s.messages[chatId]) ?? [];
  return <MessageList messages={messages} streaming={false} onA2uiAction={onA2uiAction} />;
}

const seed = (chatId: string, ...messages: ChatMessage[]) => useChat.setState({ messages: { [chatId]: messages } });
const press = (name = 'Schedule these') => userEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  useChat.getState().reset();
  useApp.setState({ route: { name: 'chat-new' }, settings: null });
  vi.mocked(listProjects).mockResolvedValue([proj({ scheduledAt: '2026-11-20T12:00:00Z' }), proj({ id: 'p2', title: 'Kopi' })]);
  // c1 is p1's project chat; c2 is a new chat without a video.
  vi.mocked(getChat).mockImplementation(async (id) => (id === 'c1' ? chatRow('c1', 'p1') : chatRow(id, null)));
  vi.mocked(scheduleVideos).mockResolvedValue([]);
  vi.mocked(addMessage).mockResolvedValue(null as unknown as ChatMessage);
});

describe('defaultSlot', () => {
  it("is the video's own time, else 19:00 today before 18:00, else 19:00 tomorrow (across a month end)", () => {
    expect(defaultSlot('2026-11-20T12:00:00Z', new Date(2026, 10, 4, 10))).toEqual(new Date('2026-11-20T12:00:00Z'));
    expect(defaultSlot(null, new Date(2026, 10, 4, 17, 59))).toEqual(new Date(2026, 10, 4, 19, 0));
    expect(defaultSlot(null, new Date(2026, 10, 4, 18, 0))).toEqual(new Date(2026, 10, 5, 19, 0));
    expect(defaultSlot('nonsense', new Date(2026, 10, 30, 23, 30))).toEqual(new Date(2026, 11, 1, 19, 0));
  });
});

describe('parseRfc3339', () => {
  it('is as strict as Rust: impossible dates, 24:00, a 60th second and big offsets fail', () => {
    for (const bad of [
      '2026-11-31T19:00:00+07:00',
      '2026-02-30T10:00+07:00',
      '2026-11-05T24:00:00+07:00',
      '2026-11-05T19:60:00+07:00',
      '2026-11-05T19:00:60+07:00',
      '2026-11-05T19:00:00+24:00',
      '2026-11-05T19:00:00',
      'tomorrow',
    ]) {
      expect(parseRfc3339(bad).time, bad).toBeNaN();
    }
    expect(parseRfc3339('2026-11-05T19:00+07:00')).toEqual({ at: '2026-11-05T19:00:00+07:00', time: Date.parse('2026-11-05T12:00:00Z') });
    expect(parseRfc3339('2028-02-29T10:00:00.5z').at).toBe('2028-02-29T10:00:00.5Z');
  });
});

describe('checkScheduleItems', () => {
  const now = new Date('2026-11-04T10:00:00Z');
  const projects = [proj({ scheduledAt: '2026-11-20T12:00:00Z' }), proj({ id: 'p2', title: 'Kopi' }), proj({ id: 'p3', title: 'Posted', postedAt: 'x' })];
  const allowed = new Set(['p1', 'p3']);
  it('takes allowed videos by id (noting their old time) and the rest as drafts', () => {
    expect(
      checkScheduleItems(
        [
          { projectId: 'p1', title: 'ignored', at: '2026-11-05T19:00:00+07:00', kind: 'promo' },
          { title: ' Kenapa rupiah melemah ', at: '2026-11-07T12:00+07:00' },
          { title: 'Data', at: '2026-11-08T12:00:00z', kind: 'data' },
        ],
        projects,
        allowed,
        now,
      ),
    ).toEqual({
      items: [
        { projectId: 'p1', title: 'Jalur Rempah', at: '2026-11-05T19:00:00+07:00', kind: 'explainer', previous: '2026-11-20T12:00:00Z' },
        { title: 'Kenapa rupiah melemah', at: '2026-11-07T12:00:00+07:00', kind: 'explainer' },
        { title: 'Data', at: '2026-11-08T12:00:00Z', kind: 'data' },
      ],
    });
  });

  const ok = '2026-11-05T19:00:00+07:00';
  it.each([
    ['no items', [], 'a schedule needs 1 to 20 videos'],
    ['not a list', 'soon', 'a schedule needs 1 to 20 videos'],
    ['more than 20', Array.from({ length: 21 }, (_, i) => ({ title: `x${i}`, at: ok })), 'a schedule needs 1 to 20 videos'],
    ['an entry that is not an object', ['x'], 'video 1 is not a valid entry'],
    ['an impossible date', [{ title: 'A', at: ok }, { title: 'B', at: '2026-11-31T19:00:00+07:00' }], 'video 2 has no valid date and time'],
    ['a time without an offset', [{ title: 'x', at: '2026-11-05T19:00:00' }], 'video 1 has no valid date and time'],
    ['a past time', [{ title: 'x', at: ok }, { title: 'y', at: '2026-11-03T19:00:00+07:00' }], 'video 2 is in the past'],
    ['more than a year away', [{ title: 'x', at: '2027-11-05T19:00:00+07:00' }], 'video 1 is more than a year away'],
    ['an unknown video', [{ projectId: 'zz', at: ok }], 'video 1 is not on this computer'],
    ['a video from outside this chat', [{ projectId: 'p2', at: ok }], 'video 1 is not from this chat. Mention it first'],
    ['a posted video', [{ projectId: 'p3', at: ok }], 'video 1 is already posted'],
    ['the same video twice', [{ projectId: 'p1', at: ok }, { projectId: 'p1', at: '2026-11-06T19:00:00+07:00' }], 'video 2 is in the schedule twice'],
    ['a draft named like an existing video', [{ title: ' kopi ', at: ok }], 'video 1 already exists. Mention it so the agent can use it'],
    ['the same draft twice', [{ title: 'New', at: ok }, { title: 'new', at: ok }], 'video 2 is in the schedule twice'],
    ['no title', [{ at: ok }], 'video 1 needs a title of 1 to 120 characters'],
    ['a long title', [{ title: 'x'.repeat(121), at: ok }], 'video 1 needs a title of 1 to 120 characters'],
  ])('refuses %s', (_name, items, reason) => {
    expect(checkScheduleItems(items, projects, allowed, now)).toEqual({ reason });
  });

  it("accepts the SKILL.md example as the app's own parser reads it", () => {
    const skill = readFileSync(join(__dirname, '../../../../packages/skills/agent-plugin/skills/tayang-studio/SKILL.md'), 'utf8');
    const section = skill.slice(skill.indexOf('## Scheduling videos'));
    const body = JSON.parse(/\$TAYANG_AI_URL\/schedule.*?-d '(\{.*?\})'/.exec(section.replace('"<id>"', '"p1"'))![1]!);
    const checked = checkScheduleItems(body.items, [proj()], new Set(['p1']), now);
    expect('items' in checked && checked.items.map((i) => i.projectId ?? i.title)).toEqual(['p1', 'Kenapa rupiah melemah']);
  });
});

describe('batchReason', () => {
  it("says Rust's codes as stored text, and anything else as a save that was undone", () => {
    expect(batchReason('schedule:badTime:3')).toBe('video 3 has no valid date and time');
    expect(batchReason('schedule:count')).toBe('a schedule needs 1 to 20 videos');
    expect(batchReason('schedule:twice:2')).toBe('video 2 is in the schedule twice');
    expect(batchReason('database is locked')).toBe('saving failed, so every change was undone');
  });
});

describe('a pressed schedule card', () => {
  it("asks first in Tayang's own dialog, built from the items; Cancel writes nothing and the card stays pressable", async () => {
    seed('c1', agentMsg('c1', card([{ projectId: 'p1', at: inDays(1) }, { title: 'Kenapa rupiah melemah', at: inDays(3) }], 'plan', 'Calm voice')));
    render(<Chat chatId="c1" />);
    await press('Calm voice');
    const dialog = await screen.findByRole('dialog', { name: 'Schedule these videos?' });
    const rows = within(within(dialog).getByRole('list', { name: 'Videos to schedule' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Jalur Rempah');
    expect(rows[0]).toHaveTextContent(/Moves from \w+ 20 Nov \d\d:\d\d/);
    expect(rows[1]).toHaveTextContent('Kenapa rupiah melemah');
    expect(rows[1]).toHaveTextContent('New draft');
    expect(within(dialog).getByRole('button', { name: 'Schedule 2 videos' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(scheduleVideos).not.toHaveBeenCalled();
    expect(screen.getByTestId('a2ui-surface')).not.toHaveAttribute('data-answered');
    await press('Calm voice');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('confirming writes the whole card at once, records the answer, refreshes, and tells the agent next time', async () => {
    const changed = vi.fn();
    const stop = onAutopilotChanged(changed);
    const version = useApp.getState().projectsVersion;
    const handler = vi.fn(() => true);
    const existing = inDays(1);
    const draft = inDays(3);
    seed('c1', agentMsg('c1', `Here is a plan.\n\n${card([{ projectId: 'p1', at: existing }, { title: 'Kenapa rupiah melemah', at: draft, kind: 'news' }])}`));
    render(<Chat chatId="c1" onA2uiAction={handler} />);
    await press();
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule 2 videos' }));
    await screen.findByText('Scheduled on the calendar:');
    // One video a line, under the note.
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringMatching(/ — Jalur Rempah$/),
      expect.stringMatching(/ — Kenapa rupiah melemah$/),
    ]);
    expect(scheduleVideos).toHaveBeenCalledTimes(1);
    const [items] = vi.mocked(scheduleVideos).mock.calls[0]!;
    expect(items[0]).toEqual({ projectId: 'p1', at: existing });
    expect(items[1]).toMatchObject({ at: draft, draft: { input: { title: 'Kenapa rupiah melemah', kind: 'news' } } });
    expect((items[1] as { draft: { brief: string } }).draft.brief).toContain('# Kenapa rupiah melemah');
    expect(handler).not.toHaveBeenCalled();
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(useApp.getState().projectsVersion).toBe(version + 1);
    expect(changed).toHaveBeenCalled();
    stop();
    const stored = vi.mocked(addMessage).mock.calls.find(([, role]) => role === 'system')!;
    expect(stored[2]).toContainEqual(expect.objectContaining({ type: 'a2ui-action' }));
    expect(screen.getByTestId('a2ui-surface')).toHaveAttribute('data-answered', 'true');
    // The agent hears about it in front of the user's next message, once.
    await useChat.getState().send('c1', [{ type: 'text', text: 'thanks' }], { agentId: 'claude' });
    const sent = JSON.stringify(vi.mocked(agentPrompt).mock.calls[0]![1]);
    expect(sent).toContain('The user confirmed your schedule card. Tayang put these videos on the calendar:');
    // Exact times with their offset, whatever language the user reads.
    expect(sent).toContain(`${existing} — Jalur Rempah`);
    useChat.setState((s) => ({ streaming: { ...s.streaming, c1: false } }));
    await useChat.getState().send('c1', [{ type: 'text', text: 'more' }], { agentId: 'claude' });
    expect(JSON.stringify(vi.mocked(agentPrompt).mock.calls[1]![1])).not.toContain('schedule card');
    await userEvent.click(screen.getByRole('button', { name: 'Open calendar' }));
    expect(useApp.getState().route).toEqual({ name: 'calendar' });
  });

  it("a failed write is undone by Rust: the line says so in the user's language, and the card can't be pressed again", async () => {
    vi.mocked(scheduleVideos).mockRejectedValue(new Error('schedule:badTime:2'));
    const version = useApp.getState().projectsVersion;
    seed('c1', agentMsg('c1', card([{ projectId: 'p1', at: inDays(1) }, { title: 'B', at: inDays(2) }])));
    render(<Chat chatId="c1" />);
    await press();
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule 2 videos' }));
    await screen.findByText("The schedule wasn't saved: video 2 has no valid date and time. Ask the agent for a new schedule card");
    expect(screen.getByTestId('a2ui-surface')).toHaveAttribute('data-answered', 'true');
    expect(screen.getByRole('button', { name: 'Schedule these' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Open calendar' })).toBeNull();
    expect(useApp.getState().projectsVersion).toBe(version);
    setUiLanguage('id');
    expect(await screen.findByText('Jadwal tidak tersimpan: video ke-2 tidak punya tanggal dan jam yang valid. Minta agen membuat kartu jadwal baru')).toBeInTheDocument();
  });

  it('a raw error from Rust is never shown as it is', async () => {
    vi.mocked(scheduleVideos).mockRejectedValue(new Error('database is locked'));
    seed('c1', agentMsg('c1', card([{ projectId: 'p1', at: inDays(1) }])));
    render(<Chat chatId="c1" />);
    await press();
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule 1 video' }));
    await screen.findByText(/^The schedule wasn't saved: saving failed, so every change was undone\./);
    expect(screen.queryByText(/database is locked/)).toBeNull();
  });

  it("says the card couldn't be checked, not that saving failed, when the videos can't be read", async () => {
    vi.mocked(listProjects).mockRejectedValueOnce(new Error('database is locked'));
    seed('c1', agentMsg('c1', card([{ projectId: 'p1', at: inDays(1) }])));
    render(<Chat chatId="c1" />);
    await press();
    await screen.findByText("Nothing was scheduled: Tayang couldn't read your videos to check the card. Press it again");
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('a2ui-surface')).not.toHaveAttribute('data-answered');
    setUiLanguage('id');
    expect(await screen.findByText('Belum ada yang dijadwalkan: Tayang tidak bisa membaca daftar videomu untuk memeriksa kartunya. Coba tekan lagi')).toBeInTheDocument();
  });

  it('an invalid card writes nothing, opens no dialog, says why and stays answerable', async () => {
    seed('c2', agentMsg('c2', card([{ title: 'A', at: inDays(1) }, { title: 'Old', at: inDays(-1) }])));
    render(<Chat chatId="c2" />);
    await press();
    await screen.findByText('Nothing was scheduled: video 2 is in the past');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(scheduleVideos).not.toHaveBeenCalled();
    expect(screen.getByTestId('a2ui-surface')).not.toHaveAttribute('data-answered');
  });

  it("refuses a video from another chat: only this chat's video and mentioned ones", async () => {
    seed('c1', agentMsg('c1', card([{ projectId: 'p2', at: inDays(1) }])));
    render(<Chat chatId="c1" />);
    await press();
    await screen.findByText('Nothing was scheduled: video 1 is not from this chat. Mention it first');
    expect(scheduleVideos).not.toHaveBeenCalled();
  });

  it('accepts a video mentioned in this chat', async () => {
    const mention: ChatMessage = { id: 'u1', chatId: 'c2', role: 'user', parts: [{ type: 'mention', projectId: 'p2', title: 'Kopi' }], createdAt: '' };
    seed('c2', mention, agentMsg('c2', card([{ projectId: 'p2', at: inDays(1) }])));
    render(<Chat chatId="c2" />);
    await press();
    expect(await screen.findByRole('button', { name: 'Schedule 1 video' })).toBeInTheDocument();
  });

  it('a second press while the first is being checked does nothing', async () => {
    let resolve!: (p: Project[]) => void;
    vi.mocked(listProjects).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    seed('c1', agentMsg('c1', card([{ projectId: 'p1', at: inDays(1) }])));
    render(<Chat chatId="c1" />);
    await press();
    expect(screen.getByRole('button', { name: 'Schedule these' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Schedule these' }));
    resolve([proj()]);
    await screen.findByRole('dialog');
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it('is ignored in internal chats (style studies, autopilot topics)', async () => {
    seed('study-s1', agentMsg('study-s1', card([{ projectId: 'p1', at: inDays(1) }])));
    render(<Chat chatId="study-s1" />);
    await press();
    await new Promise((r) => setTimeout(r, 20));
    expect(listProjects).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a surface id used again', () => {
  const answer = (surfaceId: string): ChatMessage => ({
    id: 'u9', chatId: 'c1', role: 'system', createdAt: '',
    parts: [{ type: 'text', text: 'done' }, { type: 'a2ui-action', summary: 's', action: { version: 'v0.9', action: { name: 'schedule_videos', surfaceId } } }],
  });

  it('a new card under an answered id is a new surface in the new message; the answered one never changes', async () => {
    const update = '```a2ui\n' + JSON.stringify({ version: 'v0.9', updateComponents: { surfaceId: 'plan', components: [{ id: 'go-t', component: 'Text', text: 'Revived' }] } }) + '\n```';
    seed(
      'c1',
      agentMsg('c1', `FIRST\n\n${card([{ projectId: 'p1', at: inDays(1) }], 'plan', 'Old plan')}`, 'a1'),
      answer('plan'),
      agentMsg('c1', update, 'a2'),
      agentMsg('c1', `SECOND\n\n${card([{ projectId: 'p1', at: inDays(2) }], 'plan', 'New plan')}`, 'a3'),
    );
    render(<Chat chatId="c1" />);
    const messages = screen.getAllByTestId('agent-message');
    expect(within(messages[0]!).getByRole('button', { name: 'Old plan' })).toBeDisabled();
    expect(within(messages[0]!).getByTestId('a2ui-surface')).toHaveAttribute('data-answered', 'true');
    expect(screen.queryByText('Revived')).toBeNull();
    const second = messages.at(-1)!;
    expect(second).toHaveTextContent('SECOND');
    expect(within(second).getByRole('button', { name: 'New plan' })).toBeEnabled();
    // The new card answers under the agent's own id.
    await userEvent.click(within(second).getByRole('button', { name: 'New plan' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule 1 video' }));
    await waitFor(() => expect(addMessage).toHaveBeenCalled());
    const record = vi.mocked(addMessage).mock.calls.at(-1)![2].find((p) => p.type === 'a2ui-action') as { action: { action: { surfaceId: string } } };
    expect(record.action.action.surfaceId).toBe('plan');
    await waitFor(() => expect(within(second).getByTestId('a2ui-surface')).toHaveAttribute('data-answered', 'true'));
  });
});

describe('Let the agent pick', () => {
  beforeEach(() => {
    vi.mocked(listChats).mockResolvedValue([{ id: 'c7', projectId: 'p1', agentId: 'codex', title: 'Jalur Rempah', createdAt: 'c', updatedAt: 'u' } as never]);
  });

  it("opens the video's chat and asks its agent, as the user, with the local time; the composer's files stay", async () => {
    const onOpenChange = vi.fn();
    useChat.getState().attach('c7', { type: 'file', path: '/w/attachments/brief.pdf', name: 'brief.pdf', mime: 'application/pdf', size: 3 } as never);
    render(<ScheduleDialog open onOpenChange={onOpenChange} project={proj()} onSaved={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Let the agent pick' }));
    await waitFor(() => expect(agentPrompt).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'c7' });
    const visible = useChat.getState().messages.c7!.find((m) => m.role === 'user')!;
    expect(visible.parts).toHaveLength(1);
    expect((visible.parts[0] as { text: string }).text).toMatch(
      /^Pick the best time to post this video in the next 7 days and show me a schedule card\. It's \w+ \d+ \w+ \d\d:\d\d \(.+, UTC[+-]\d\d:\d\d\)\.$/,
    );
    expect(useChat.getState().attachments.c7).toHaveLength(1);
    const [chatId, parts] = vi.mocked(agentPrompt).mock.calls[0]!;
    expect(chatId).toBe('c7');
    expect(JSON.stringify(parts)).toContain("This video's Tayang id is p1.");
    expect(JSON.stringify(parts)).not.toContain('brief.pdf');
  });

  it('asks in Indonesian when the interface is Indonesian', async () => {
    setUiLanguage('id');
    render(<ScheduleDialog open onOpenChange={() => {}} project={proj()} onSaved={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Biar agent yang pilih' }));
    await waitFor(() => expect(agentPrompt).toHaveBeenCalled());
    const user = useChat.getState().messages.c7!.find((m) => m.role === 'user')!.parts[0] as { text: string };
    expect(user.text).toMatch(/^Pilih waktu terbaik untuk memposting video ini dalam 7 hari ke depan/);
  });

  it('only says to wait, without storing it, when a turn is running in that chat', async () => {
    useChat.setState({ streaming: { c7: true }, messages: { c7: [agentMsg('c7', 'working')] } });
    render(<ScheduleDialog open onOpenChange={() => {}} project={proj()} onSaved={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Let the agent pick' }));
    await waitFor(() => expect(useChat.getState().messages.c7!.at(-1)!.parts[0]).toEqual({ type: 'text', text: BUSY_NOTE }));
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('is hidden on the Calendar until a video is picked', async () => {
    render(<ScheduleDialog open onOpenChange={() => {}} choices={[proj()]} onSaved={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Let the agent pick' })).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox'), 'p1');
    expect(screen.getByRole('button', { name: 'Let the agent pick' })).toBeInTheDocument();
  });
});
