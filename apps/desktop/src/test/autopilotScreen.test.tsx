import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Autopilot as AutopilotT, AutopilotSlot, Project, Settings, Style } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  listAutopilots: vi.fn(),
  listSlots: vi.fn(),
  listStyles: vi.fn(),
  listProjects: vi.fn(),
  setAutopilotStatus: vi.fn(),
  deleteAutopilot: vi.fn(),
  updateSlot: vi.fn(),
  listChats: vi.fn(),
  createChat: vi.fn(),
  assetUrl: (p: string) => p,
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import * as ipc from '@/lib/ipc';
import { setUiLanguage } from '@/i18n';
import { notifyAutopilotChanged, setStopNowHandler } from '@/lib/autopilotHooks';
import { Autopilot } from '@/screens/Autopilot';
import { useApp } from '@/state/app';

const settings = { defaultAgent: 'claude', language: 'id', onboarded: true } as Settings;
const now = new Date(2026, 10, 4, 10, 0);

const style: Style = { id: 's2', name: 'Bold', source: 'builtin', sourceUrl: null, notes: {}, prompt: '', createdAt: 'x', previewUrl: '/p/bold.png' };
const pilot = (extra: Partial<AutopilotT> = {}): AutopilotT => ({
  id: 'a1',
  name: 'Kopi',
  niche: 'Coffee tips for busy mornings',
  language: 'id',
  styleId: 's2',
  agentId: 'gemini',
  frequency: { kind: 'daily', times: ['19:00', '12:00'] },
  lengthSec: 45,
  review: true,
  posting: 'manual',
  nicheId: null,
  voiceId: null,
  socialAccountIds: [],
  status: 'active',
  createdAt: 'c',
  updatedAt: 'u',
  ...extra,
});
const slot = (id: string, at: Date, extra: Partial<AutopilotSlot> = {}): AutopilotSlot => ({
  id,
  autopilotId: 'a1',
  dueAt: at.toISOString(),
  status: 'planned',
  projectId: null,
  error: null,
  ...extra,
});
const project = (id: string, title: string, extra: Partial<Project> = {}): Project => ({
  id,
  title,
  slug: id,
  folder: `/w/${id}`,
  kind: 'explainer',
  format: '9:16',
  language: 'id',
  status: 'rendered',
  styleId: 's2',
  scheduledAt: null,
  reviewState: 'none',
  postedAt: null,
  remindedAt: null,
  reviewRemindedAt: null,
  durationSec: 30,
  createdAt: 'c',
  updatedAt: 'u',
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  setStopNowHandler(null);
  useApp.setState({ settings, route: { name: 'autopilot' }, leaveGuard: null });
  vi.mocked(ipc.listAutopilots).mockResolvedValue([]);
  vi.mocked(ipc.listSlots).mockResolvedValue([]);
  vi.mocked(ipc.listStyles).mockResolvedValue([style]);
  vi.mocked(ipc.listProjects).mockResolvedValue([]);
  vi.mocked(ipc.setAutopilotStatus).mockResolvedValue(pilot());
  vi.mocked(ipc.deleteAutopilot).mockResolvedValue(undefined);
});

describe('Autopilot screen list', () => {
  it('has a header and, with no autopilots, Oyen and one button to create the first', async () => {
    render(<Autopilot now={now} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Autopilot' })).toBeInTheDocument();
    expect(screen.getByText(/You stay in charge: pause any time/)).toBeInTheDocument();
    expect(await screen.findByText(/An autopilot picks a topic in your niche/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Oyen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New autopilot' })).toBeNull();
    expect(screen.getByText(/Automatic posting to TikTok, Reels and Shorts comes with Tayang plans/)).toBeInTheDocument();
    // See plans opens the plans screen, and Back there returns here.
    await userEvent.click(screen.getByRole('button', { name: 'See plans' }));
    expect(useApp.getState().route).toEqual({ name: 'plans', from: 'autopilot' });
    useApp.setState({ route: { name: 'autopilot' } });
    await userEvent.click(screen.getByRole('button', { name: 'Create your first autopilot' }));
    expect(useApp.getState().route).toEqual({ name: 'autopilot-wizard' });
  });

  it('shows each autopilot: thumbnail, name, niche, how often, status, next video and counts', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot()]);
    vi.mocked(ipc.listSlots).mockResolvedValue([
      slot('d', new Date(2026, 10, 3, 12, 0), { status: 'done', projectId: 'p1' }),
      slot('d2', new Date(2026, 10, 2, 12, 0), { status: 'done', projectId: 'p2' }),
      slot('f', new Date(2026, 10, 3, 19, 0), { status: 'failed' }),
      slot('n', new Date(2026, 10, 4, 12, 0)),
    ]);
    render(<Autopilot now={now} />);
    const card = await screen.findByTestId('autopilot-card');
    expect(within(card).getByText('Kopi')).toBeInTheDocument();
    expect(within(card).getByText('Coffee tips for busy mornings')).toHaveClass('line-clamp-2');
    expect(within(card).getByText('2 a day · 12:00, 19:00')).toBeInTheDocument();
    expect(within(card).getByText('Active')).toBeInTheDocument();
    expect(within(card).getByText('Next video in 2 hours')).toHaveAttribute('title', 'Wed 4 Nov 12:00');
    expect(within(card).getByText('2 made · 1 failed')).toBeInTheDocument();
    expect(card.querySelector('img')).toHaveAttribute('src', '/p/bold.png');
    expect(screen.getByRole('button', { name: 'New autopilot' })).toBeInTheDocument();
    // One or two columns, never more.
    expect(card.parentElement).toHaveClass('grid-cols-1');
    expect(card.parentElement?.getAttribute('style') ?? '').not.toContain('auto-fill');
  });

  it('pauses, resumes and edits through the right calls', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot()]);
    render(<Autopilot now={now} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pause Kopi' }));
    expect(ipc.setAutopilotStatus).toHaveBeenCalledWith('a1', 'paused');
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot({ status: 'paused' })]);
    await act(async () => notifyAutopilotChanged());
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText(/^Next video/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Resume Kopi' }));
    expect(ipc.setAutopilotStatus).toHaveBeenLastCalledWith('a1', 'active');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Kopi' }));
    expect(useApp.getState().route).toEqual({ name: 'autopilot-wizard', id: 'a1' });
  });

  it('asks before deleting, and stops a video being made first', async () => {
    const order: string[] = [];
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot()]);
    vi.mocked(ipc.listSlots).mockResolvedValue([slot('m', new Date(2026, 10, 4, 12, 0), { status: 'making' })]);
    setStopNowHandler(async () => void order.push('stop'));
    vi.mocked(ipc.deleteAutopilot).mockImplementation(async () => void order.push('delete'));
    render(<Autopilot now={now} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Kopi' }));
    expect(await screen.findByText('Delete Kopi?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ipc.deleteAutopilot).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Kopi' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete autopilot' }));
    await waitFor(() => expect(order).toEqual(['stop', 'delete']));
  });

  it('shows Making a video now with Stop now while a handler is registered', async () => {
    const making = slot('m', new Date(2026, 10, 4, 12, 0), { status: 'making' });
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot()]);
    vi.mocked(ipc.listSlots).mockResolvedValue([making]);
    render(<Autopilot now={now} />);
    expect(await screen.findByText('Making a video now')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop now' })).toBeNull();
    const stop = vi.fn();
    act(() => void setStopNowHandler(stop));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop now' }));
    expect(stop).toHaveBeenCalledWith(making);
  });

  it('shows an error line when an action fails, and when loading fails until a later load works', async () => {
    vi.mocked(ipc.listAutopilots).mockRejectedValueOnce(new Error('x'));
    render(<Autopilot now={now} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your autopilots");
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot()]);
    await act(async () => notifyAutopilotChanged());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    vi.mocked(ipc.setAutopilotStatus).mockRejectedValue(new Error('x'));
    await userEvent.click(await screen.findByRole('button', { name: 'Pause Kopi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't update the autopilot");
  });

  it('opens the detail when the card is clicked; the button is named by its content', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot()]);
    render(<Autopilot now={now} />);
    const open = await screen.findByRole('button', { name: /^Kopi.*Active.*Coffee tips.*Next video in 2 hours/ });
    await userEvent.click(open);
    expect(useApp.getState().route).toEqual({ name: 'autopilot', id: 'a1' });
  });

  it('speaks Indonesian', async () => {
    setUiLanguage('id');
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot()]);
    render(<Autopilot now={now} />);
    expect(await screen.findByText('2 sehari · 12:00, 19:00')).toBeInTheDocument();
    expect(screen.getByText('Aktif')).toBeInTheDocument();
    expect(screen.getByText('0 dibuat · 0 gagal')).toBeInTheDocument();
    expect(screen.getByText(/^Video berikutnya/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Autopilot baru' })).toBeInTheDocument();
  });
});

describe('Autopilot detail', () => {
  const setup = () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot(), pilot({ id: 'a2', name: 'Other' })]);
    vi.mocked(ipc.listProjects).mockResolvedValue([
      project('p1', 'Kopi tubruk', { reviewState: 'pending' }),
      project('p2', 'Cold brew', { scheduledAt: '2026-11-03T12:00:00Z' }),
      project('px', 'Not mine'),
    ]);
    vi.mocked(ipc.listSlots).mockResolvedValue([
      slot('old', new Date(2026, 10, 2, 12, 0), { status: 'done', projectId: 'p2' }),
      slot('d', new Date(2026, 10, 3, 12, 0), { status: 'done', projectId: 'p1' }),
      slot('sk', new Date(2026, 10, 4, 8, 0), { status: 'skipped' }),
      slot('m', new Date(2026, 10, 4, 12, 0), { status: 'making' }),
      slot('f', new Date(2026, 10, 4, 19, 0), { status: 'failed', error: 'No video file was rendered' }),
      slot('p', new Date(2026, 10, 5, 12, 0)),
      slot('far', new Date(2026, 10, 20, 12, 0)),
      slot('other', new Date(2026, 10, 5, 12, 0), { autopilotId: 'a2', projectId: 'px', status: 'done' }),
    ]);
  };

  it('has a back link, the card, the next 7 days of slots with states, and the videos it made', async () => {
    setup();
    render(<Autopilot id="a1" now={now} />);
    const rows = await screen.findAllByTestId('upcoming-slot');
    expect(rows.map((r) => r.textContent)).toEqual([
      'Wed 4 Nov 08:00Skipped',
      'Wed 4 Nov 12:00Making',
      'Wed 4 Nov 19:00FailedNo video file was renderedTry again',
      'Thu 5 Nov 12:00Planned',
    ]);
    expect(screen.getByText('Kopi')).toBeInTheDocument();
    expect(screen.queryByText('Other')).toBeNull();
    const made = screen.getAllByTestId('made-video');
    expect(made.map((m) => within(m).getByText(/Kopi tubruk|Cold brew/).textContent)).toEqual(['Kopi tubruk', 'Cold brew']);
    expect(within(made[0]!).getByText('Needs review')).toBeInTheDocument();
    expect(within(made[1]!).getByText('Ready')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'All autopilots' }));
    expect(useApp.getState().route).toEqual({ name: 'autopilot' });
  });

  it('Try again sets a failed slot back to planned; Open video opens its chat', async () => {
    setup();
    vi.mocked(ipc.updateSlot).mockResolvedValue(slot('f', new Date(2026, 10, 4, 19, 0)));
    vi.mocked(ipc.listChats).mockResolvedValue([{ id: 'chat-p1' } as never]);
    render(<Autopilot id="a1" now={now} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again: Wed 4 Nov 19:00' }));
    expect(ipc.updateSlot).toHaveBeenCalledWith('f', { status: 'planned', error: null, projectId: null });
    await userEvent.click(screen.getByRole('button', { name: 'Open video: Kopi tubruk' }));
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'chat-p1' }));
  });

  it('follows changes from the engine', async () => {
    setup();
    render(<Autopilot id="a1" now={now} />);
    expect(await screen.findByText('Making')).toBeInTheDocument();
    vi.mocked(ipc.listSlots).mockResolvedValue([slot('m', new Date(2026, 10, 4, 12, 0), { status: 'done', projectId: 'p1' })]);
    await act(async () => notifyAutopilotChanged());
    await waitFor(() => expect(screen.queryByText('Making')).toBeNull());
    expect(screen.getAllByTestId('upcoming-slot')[0]).toHaveTextContent('Done');
    expect(within(screen.getByTestId('made-video')).getByText('Kopi tubruk')).toBeInTheDocument();
  });

  it('says so when the autopilot is gone, and deleting from the detail goes back to the list', async () => {
    render(<Autopilot id="nope" now={now} />);
    expect(await screen.findByText('This autopilot no longer exists')).toBeInTheDocument();
    setup();
    render(<Autopilot id="a1" now={now} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Kopi' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete autopilot' }));
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'autopilot' }));
  });

  it('shows nothing planned and no videos yet for a new autopilot', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot({ status: 'paused' })]);
    render(<Autopilot id="a1" now={now} />);
    expect(await screen.findByText('Nothing planned for the next 7 days')).toBeInTheDocument();
    expect(screen.getByText('No videos yet')).toBeInTheDocument();
  });
});
