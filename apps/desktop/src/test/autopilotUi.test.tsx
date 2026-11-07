import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Autopilot, AutopilotSlot, Settings, Style } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  listAutopilots: vi.fn(),
  listSlots: vi.fn(),
  saveAutopilot: vi.fn(),
  setAutopilotStatus: vi.fn(),
  deleteAutopilot: vi.fn(),
  updateSlot: vi.fn(),
  listProjects: vi.fn(),
  listStyles: vi.fn(),
  detectAgents: vi.fn(),
  setSchedule: vi.fn(),
  setPosted: vi.fn(),
  approveProject: vi.fn(),
  assetUrl: (p: string) => p,
}));
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}),
  onAgentUpdate: vi.fn(async () => () => {}),
  onPermission: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import * as ipc from '@/lib/ipc';
import { Calendar } from '@/screens/Calendar';
import { notifyAutopilotChanged, setStopNowHandler } from '@/lib/autopilotHooks';
import { setUiLanguage } from '@/i18n';
import { useApp } from '@/state/app';

const settings: Settings = {
  workingFolder: '/w/Tayang',
  defaultAgent: 'claude',
  frameCheck: true,
  language: 'id',
  format: '9:16',
  fps: 30,
  onboarded: true,
  apiUrl: 'https://studio.tayang.app/api',
  installId: '',
  shareInstallStats: true,
  autoMode: false,
  lastPingAt: null,
  uiLanguage: null,
  backgroundMode: false,
  openAtLogin: false,
  buildJobsChecked: true,
  projectStatusChecked: true,
  agentModels: {},
};

const style = (id: string, name: string): Style => ({ id, name, source: 'builtin', sourceUrl: null, notes: {}, prompt: '', createdAt: 'x' });

const today = new Date(2026, 10, 4, 10, 0);
const autopilot = (extra: Partial<Autopilot> = {}): Autopilot => ({
  id: 'a1',
  name: 'Kopi',
  niche: 'Coffee tips',
  language: 'id',
  styleId: 's2',
  agentId: 'gemini',
  frequency: { kind: 'daily', times: ['19:00', '12:00'] },
  lengthSec: 45,
  review: false,
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

beforeEach(() => {
  vi.clearAllMocks();
  setStopNowHandler(null);
  useApp.setState({ settings });
  vi.mocked(ipc.listAutopilots).mockResolvedValue([]);
  vi.mocked(ipc.listSlots).mockResolvedValue([]);
  vi.mocked(ipc.listProjects).mockResolvedValue([]);
  vi.mocked(ipc.listStyles).mockResolvedValue([style('s1', 'Atlas'), style('s2', 'Bold')]);
});

describe('Planned slots on the calendar', () => {
  it('draws planned, making and failed slots as ghost entries on their day', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    vi.mocked(ipc.listSlots).mockResolvedValue([
      slot('p', new Date(2026, 10, 5, 12, 0)),
      slot('m', new Date(2026, 10, 4, 12, 0), { status: 'making' }),
      slot('f', new Date(2026, 10, 6, 12, 0), { status: 'failed', error: 'No video file was rendered' }),
      slot('d', new Date(2026, 10, 7, 12, 0), { status: 'done', projectId: 'x' }),
      slot('k', new Date(2026, 10, 8, 12, 0), { status: 'skipped' }),
    ]);
    render(<Calendar today={today} />);
    await screen.findAllByTestId('cal-ghost');
    const cell = (d: string) => document.querySelector(`[data-date="${d}"]`) as HTMLElement;
    expect(within(cell('2026-11-05')).getByText('Planned · Kopi')).toBeInTheDocument();
    expect(within(cell('2026-11-05')).getByText('12:00')).toBeInTheDocument();
    expect(within(cell('2026-11-04')).getByText('Making · Kopi')).toBeInTheDocument();
    expect(within(cell('2026-11-06')).getByText('Failed · Kopi')).toBeInTheDocument();
    expect(within(cell('2026-11-06')).getByText('No video file was rendered')).toBeInTheDocument();
    expect(screen.getAllByTestId('cal-ghost')).toHaveLength(3);
  });

  it('a failed slot in the future has Try again, which sets it back to planned', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    const failed = slot('f', new Date(2026, 10, 6, 12, 0), { status: 'failed', error: 'x' });
    vi.mocked(ipc.listSlots).mockResolvedValue([failed]);
    vi.mocked(ipc.updateSlot).mockImplementation(async () => {
      const next = { ...failed, status: 'planned' as const, error: null, projectId: null };
      vi.mocked(ipc.listSlots).mockResolvedValue([next]);
      return next;
    });
    render(<Calendar today={today} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again: Kopi' }));
    expect(ipc.updateSlot).toHaveBeenCalledWith('f', { status: 'planned', error: null, projectId: null });
    expect(await screen.findByText('Planned · Kopi')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again: Kopi' })).toBeNull();
  });

  it('a failed slot that is already past has no Try again; a ghost in Indonesian reads Direncanakan', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    vi.mocked(ipc.listSlots).mockResolvedValue([slot('f', new Date(2026, 10, 3, 12, 0), { status: 'failed' }), slot('p', new Date(2026, 10, 5, 12, 0))]);
    setUiLanguage('id');
    render(<Calendar today={today} />);
    expect(await screen.findByText('Direncanakan · Kopi')).toBeInTheDocument();
    expect(screen.getByText('Gagal · Kopi')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Coba lagi/ })).toBeNull();
  });

  it('a slot whose autopilot is gone, or that already has a video, draws nothing', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    vi.mocked(ipc.listSlots).mockResolvedValue([
      slot('orphan', new Date(2026, 10, 5, 12, 0), { autopilotId: 'gone' }),
      slot('has', new Date(2026, 10, 5, 13, 0), { projectId: 'p' }),
    ]);
    render(<Calendar today={today} />);
    await waitFor(() => expect(ipc.listSlots).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('cal-ghost')).toBeNull();
  });
});

describe('Autopilot fix round', () => {
  it('shows a failed slot that kept its project, with the project title, and Try again clears the project', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    vi.mocked(ipc.listProjects).mockResolvedValue([
      { id: 'pr', title: 'Kopi susu', slug: 'k', folder: '/w/k', kind: 'explainer', format: '9:16', language: 'id', status: 'draft', styleId: null, scheduledAt: null, reviewState: 'none', postedAt: null, remindedAt: null, reviewRemindedAt: null, durationSec: null, createdAt: 'c', updatedAt: 'u' },
    ]);
    vi.mocked(ipc.listSlots).mockResolvedValue([slot('f', new Date(2026, 10, 6, 12, 0), { status: 'failed', projectId: 'pr', error: 'x' })]);
    vi.mocked(ipc.updateSlot).mockResolvedValue(slot('f', new Date(2026, 10, 6, 12, 0)));
    render(<Calendar today={today} />);
    expect(await screen.findByText('Failed · Kopi')).toBeInTheDocument();
    expect(await screen.findByText('Kopi susu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again: Kopi' }));
    expect(ipc.updateSlot).toHaveBeenCalledWith('f', { status: 'planned', error: null, projectId: null });
  });

  it('draws no planned ghosts for a paused autopilot', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot({ status: 'paused' })]);
    vi.mocked(ipc.listSlots).mockResolvedValue([slot('p', new Date(2026, 10, 5, 12, 0))]);
    render(<Calendar today={today} />);
    await waitFor(() => expect(ipc.listSlots).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('cal-ghost')).toBeNull();
  });

  it('reloads autopilots and slots when something announces a change', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    const making = slot('s', new Date(2026, 10, 4, 12, 0), { status: 'making' });
    vi.mocked(ipc.listSlots).mockResolvedValue([making]);
    render(<Calendar today={today} />);
    expect(await screen.findByText('Making · Kopi')).toBeInTheDocument();
    vi.mocked(ipc.listSlots).mockResolvedValue([{ ...making, status: 'done', projectId: 'x' }]);
    await act(async () => notifyAutopilotChanged());
    await waitFor(() => expect(screen.queryByText('Making · Kopi')).toBeNull());
  });

  it('fetches slots once per reload, not again when the autopilots arrive', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    vi.mocked(ipc.listSlots).mockResolvedValue([slot('p', new Date(2026, 10, 5, 12, 0))]);
    render(<Calendar today={today} />);
    await screen.findByText('Planned · Kopi');
    await act(async () => {});
    expect(ipc.listSlots).toHaveBeenCalledTimes(1);
    await act(async () => notifyAutopilotChanged());
    await act(async () => {});
    expect(ipc.listSlots).toHaveBeenCalledTimes(2);
  });

  it('clears the load error once a later load succeeds', async () => {
    vi.mocked(ipc.listAutopilots).mockRejectedValueOnce(new Error('busy'));
    render(<Calendar today={today} />);
    expect(await screen.findByText("Couldn't load your autopilots. Try again")).toBeInTheDocument();
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    await act(async () => notifyAutopilotChanged());
    await waitFor(() => expect(screen.queryByText("Couldn't load your autopilots. Try again")).toBeNull());
  });

  it('shows an error when the autopilots cannot be loaded', async () => {
    vi.mocked(ipc.listAutopilots).mockRejectedValue(new Error('no table'));
    render(<Calendar today={today} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your autopilots");
  });

  it('the clock moves on: a failed slot loses Try again once its time has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(new Date(2026, 10, 4, 10, 0));
      vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
      vi.mocked(ipc.listSlots).mockResolvedValue([slot('f', new Date(2026, 10, 4, 10, 0, 30), { status: 'failed' })]);
      render(<Calendar />);
      await act(async () => {});
      expect(screen.getByRole('button', { name: 'Try again: Kopi' })).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(61_000);
      });
      expect(screen.queryByRole('button', { name: 'Try again: Kopi' })).toBeNull();
      expect(screen.getByText('Failed · Kopi')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Calendar after the Autopilot screen', () => {
  it('has no autopilot panel or dialog, and links to the Autopilot screen', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    useApp.setState({ route: { name: 'calendar' }, leaveGuard: null });
    render(<Calendar today={today} />);
    await waitFor(() => expect(ipc.listAutopilots).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'New autopilot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause Kopi' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Manage autopilots' }));
    expect(useApp.getState().route).toEqual({ name: 'autopilot' });
  });

  it('a Try again that fails says so', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([autopilot()]);
    vi.mocked(ipc.listSlots).mockResolvedValue([slot('f', new Date(2026, 10, 6, 12, 0), { status: 'failed' })]);
    vi.mocked(ipc.updateSlot).mockRejectedValue(new Error('x'));
    render(<Calendar today={today} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again: Kopi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't update the autopilot");
  });
});
