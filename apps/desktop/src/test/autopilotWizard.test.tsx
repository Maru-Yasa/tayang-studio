import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, Autopilot, Settings, Style } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  listStyles: vi.fn(),
  detectAgents: vi.fn(),
  listAutopilots: vi.fn(),
  saveAutopilot: vi.fn(),
  listNiches: vi.fn(),
  listVoices: vi.fn(),
  assetUrl: (p: string) => p,
}));

vi.mock('@/lib/cloud', async (original) => ({ ...(await original<typeof import('@/lib/cloud')>()), socialAccounts: vi.fn() }));

import * as cloud from '@/lib/cloud';
import * as ipc from '@/lib/ipc';
import { setUiLanguage } from '@/i18n';
import { onAutopilotChanged } from '@/lib/autopilotHooks';
import { AutopilotWizard } from '@/screens/AutopilotWizard';
import { useApp } from '@/state/app';

const settings = { defaultAgent: 'claude', language: 'id', onboarded: true } as Settings;
const style = (id: string, name: string, previewUrl?: string): Style => ({
  id,
  name,
  source: 'builtin',
  sourceUrl: null,
  notes: {},
  prompt: '',
  createdAt: 'x',
  ...(previewUrl ? { previewUrl } : {}),
});
const agents: AgentInfo[] = [
  { id: 'claude', name: 'Claude Code', installed: true, version: '1', acpCommand: [], recommended: true },
  { id: 'codex', name: 'Codex', installed: false, version: null, acpCommand: [], recommended: false },
  { id: 'gemini', name: 'Gemini CLI', installed: true, version: '1', acpCommand: [], recommended: false },
];
const existing: Autopilot = {
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
};
/** Wed 4 Nov 2026, 10:00. */
const now = new Date(2026, 10, 4, 10, 0);

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ settings, route: { name: 'autopilot-wizard' }, leaveGuard: null });
  vi.mocked(ipc.listStyles).mockResolvedValue([style('s1', 'Atlas', '/p/atlas.png'), style('s2', 'Bold')]);
  vi.mocked(ipc.detectAgents).mockResolvedValue(agents);
  vi.mocked(ipc.listAutopilots).mockResolvedValue([existing]);
  vi.mocked(ipc.listNiches).mockResolvedValue([]);
  vi.mocked(ipc.listVoices).mockResolvedValue([]);
  vi.mocked(cloud.socialAccounts).mockResolvedValue([]);
  vi.mocked(ipc.saveAutopilot).mockImplementation(async (input) => ({ ...existing, ...input, id: input.id ?? 'new1' }));
});

const next = () => screen.getByRole('button', { name: 'Next' });
const heading = () => screen.getByRole('heading', { level: 2 });

const writeOwn = () => userEvent.click(screen.getByRole('tab', { name: 'Write my own' }));

/** Fills the niche and style steps, passes the voice step and lands on the schedule step. */
async function toSchedule() {
  await userEvent.type(screen.getByLabelText('Name'), 'Kopi');
  await writeOwn();
  await userEvent.click(screen.getByRole('button', { name: 'Home coffee brewing tips' }));
  await userEvent.click(next());
  await userEvent.click(await screen.findByRole('radio', { name: /Atlas/ }));
  await userEvent.click(next());
  await userEvent.click(next());
}

describe('Autopilot wizard', () => {
  it('is a full screen with the steps, and Next is blocked until the step is valid, with the reason', async () => {
    render(<AutopilotWizard now={now} />);
    expect(screen.getByRole('heading', { level: 1, name: 'New autopilot' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    const steps = screen.getByRole('list', { name: 'Autopilot steps' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1Niche', '2Style', '3Voice', '4Schedule', '5Agent & publishing', '6Summary']);
    // New: the steps are not jump buttons.
    expect(within(steps).queryByRole('button')).toBeNull();
    expect(heading()).toHaveTextContent('What are the videos about?');
    expect(next()).toBeDisabled();
    expect(screen.getByText('Pick a niche')).toBeInTheDocument();
    await writeOwn();
    expect(screen.getByText('Say what the videos are about')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Home coffee brewing tips' }));
    expect(screen.getByLabelText('Your niche')).toHaveValue('Home coffee brewing tips');
    expect(screen.getByText('Give it a name')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), 'Kopi');
    expect(next()).toBeEnabled();
    await userEvent.click(next());
    expect(heading()).toHaveTextContent('Pick a style');
    expect(heading()).toHaveFocus();
    expect(next()).toBeDisabled();
    expect(screen.getByText('Pick a style', { selector: 'span' })).toBeInTheDocument();
  });

  it('picks one style from the grid with thumbnails, and links to Style', async () => {
    render(<AutopilotWizard now={now} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Kopi');
    await writeOwn();
    await userEvent.type(screen.getByLabelText('Your niche'), 'Coffee');
    await userEvent.click(next());
    const group = await screen.findByRole('radiogroup', { name: 'Style' });
    expect(group.querySelector('img')).toHaveAttribute('src', '/p/atlas.png');
    await userEvent.click(within(group).getByRole('radio', { name: /Atlas/ }));
    await userEvent.click(within(group).getByRole('radio', { name: /Bold/ }));
    expect(within(group).getByRole('radio', { name: /Bold/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: /Atlas/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Clone or edit styles in Style' })).toBeInTheDocument();
  });

  it('schedule: N videos a day with a live preview, day choices, length; bad input blocks Next', async () => {
    render(<AutopilotWizard now={now} />);
    await toSchedule();
    expect(heading()).toHaveTextContent('How often, and how long?');
    expect(screen.getByTestId('first-videos')).toHaveTextContent('First videos: Wed 4 Nov 12:00, Thu 5 Nov 12:00, Fri 6 Nov 12:00');
    const perDay = within(screen.getByRole('radiogroup', { name: 'Videos each day' }));
    await userEvent.click(perDay.getByRole('radio', { name: '2' }));
    fireEvent.change(screen.getByLabelText('Time 2'), { target: { value: '19:00' } });
    expect(screen.getByTestId('first-videos')).toHaveTextContent('First videos: Wed 4 Nov 12:00, Wed 4 Nov 19:00, Thu 5 Nov 12:00');
    fireEvent.change(screen.getByLabelText('Time 2'), { target: { value: '12:00' } });
    expect(next()).toBeDisabled();
    expect(screen.getByText('Use 1 to 6 different times')).toBeInTheDocument();
    expect(perDay.getAllByRole('radio').map((r) => r.textContent)).toEqual(['1', '2', '3', '4', '5', '6']);
    await userEvent.click(perDay.getByRole('radio', { name: '1' }));
    expect(screen.queryByLabelText('Time 2')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Weekends' }));
    expect(screen.getByTestId('first-videos')).toHaveTextContent('First videos: Sat 7 Nov 12:00, Sun 8 Nov 12:00, Sat 14 Nov 12:00');
    await userEvent.click(screen.getByRole('button', { name: 'Weekdays' }));
    expect(screen.getByTestId('first-videos')).toHaveTextContent('First videos: Wed 4 Nov 12:00, Thu 5 Nov 12:00, Fri 6 Nov 12:00');
    await userEvent.click(screen.getByRole('button', { name: 'Certain days' }));
    // Monday to Friday start picked.
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) await userEvent.click(screen.getByRole('button', { name: d }));
    expect(next()).toBeDisabled();
    expect(screen.getByText('Pick at least one day')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thu' }));
    fireEvent.change(screen.getByLabelText('Time 1'), { target: { value: '19:00' } });
    expect(screen.getByTestId('first-videos')).toHaveTextContent('First videos: Thu 5 Nov 19:00, Thu 12 Nov 19:00');
    expect(within(screen.getByRole('radiogroup', { name: 'Length' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['45s', '60s', '90s']);
    await userEvent.click(screen.getByRole('radio', { name: '60s' }));
    expect(screen.getByRole('radio', { name: '60s' })).toHaveAttribute('aria-checked', 'true');
    expect(next()).toBeEnabled();
  });

  it('agent & publishing: only installed agents, the default first; both publishing choices explained; accounts to post to', async () => {
    render(<AutopilotWizard now={now} />);
    await toSchedule();
    await userEvent.click(next());
    const group = screen.getByRole('radiogroup', { name: 'Agent' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Claude Code', 'Gemini CLI']);
    expect(within(group).getByRole('radio', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');
    const publishing = within(screen.getByRole('radiogroup', { name: 'Publishing' }));
    expect(publishing.getByRole('radio', { name: /^Review first/ })).toHaveAttribute('aria-checked', 'true');
    expect(publishing.getByRole('radio', { name: /^Fully automatic/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('No accounts connected yet.')).toBeInTheDocument();
    expect(screen.getByText(/With no account picked, Tayang reminds you/)).toBeInTheDocument();
    // The user decides here, so they learn here that it never stops to ask.
    expect(screen.getByTestId('autopilot-auto-mode')).toHaveTextContent(
      "Autopilot runs your agent in Auto mode so it can work without you: it won't stop to ask before running commands.",
    );
  });

  it('summary shows everything, Edit links jump back, and Start creates it and opens its detail', async () => {
    const changed = vi.fn();
    const off = onAutopilotChanged(changed);
    render(<AutopilotWizard now={now} />);
    await toSchedule();
    await userEvent.click(next());
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Agent' })).getByRole('radio', { name: 'Gemini CLI' }));
    await userEvent.click(next());
    expect(heading()).toHaveTextContent('Check and start');
    expect(screen.getByTestId('summary-niche')).toHaveTextContent('Kopi');
    expect(screen.getByTestId('summary-style')).toHaveTextContent('Atlas');
    expect(screen.getByTestId('summary-schedule')).toHaveTextContent('1 a day · 12:00');
    expect(screen.getByTestId('summary-agent')).toHaveTextContent('Gemini CLI');
    expect(screen.getByTestId('summary-agent')).toHaveTextContent('Review first');
    expect(screen.getByTestId('summary-voice')).toHaveTextContent('Default voice');
    expect(screen.getByTestId('summary-agent')).toHaveTextContent('Post by hand');
    expect(screen.getByTestId('summary-agent')).toHaveTextContent('Auto modeAlways on: the agent runs commands without asking');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Style' }));
    expect(heading()).toHaveTextContent('Pick a style');
    await userEvent.click(screen.getByRole('radio', { name: /Bold/ }));
    for (let i = 0; i < 4; i++) await userEvent.click(next());
    await userEvent.click(screen.getByRole('button', { name: 'Start autopilot' }));
    await waitFor(() => expect(ipc.saveAutopilot).toHaveBeenCalledTimes(1));
    expect(ipc.saveAutopilot).toHaveBeenCalledWith({
      id: undefined,
      name: 'Kopi',
      niche: 'Home coffee brewing tips',
      nicheId: null,
      language: 'id',
      styleId: 's2',
      voiceId: null,
      agentId: 'gemini',
      frequency: { kind: 'daily', times: ['12:00'] },
      lengthSec: 60,
      review: true,
      posting: 'manual',
      socialAccountIds: [],
    });
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'autopilot', id: 'new1' }));
    expect(changed).toHaveBeenCalled();
    expect(useApp.getState().leaveGuard).toBeNull();
    off();
  });

  it('saves chosen days with sorted days and two times, language and fully automatic', async () => {
    render(<AutopilotWizard now={now} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Mingguan');
    await writeOwn();
    await userEvent.type(screen.getByLabelText('Your niche'), 'Finance');
    await userEvent.click(screen.getByRole('combobox', { name: 'Video language' }));
    await userEvent.click(await screen.findByRole('option', { name: /English/ }));
    expect(screen.getByRole('combobox', { name: 'Video language' })).toHaveTextContent('🇬🇧 English');
    await userEvent.click(next());
    await userEvent.click(await screen.findByRole('radio', { name: /Atlas/ }));
    await userEvent.click(next());
    await userEvent.click(next());
    await userEvent.click(screen.getByRole('button', { name: 'Certain days' }));
    for (const d of ['Tue', 'Wed', 'Thu']) await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'Sun' }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Videos each day' })).getByRole('radio', { name: '2' }));
    fireEvent.change(screen.getByLabelText('Time 1'), { target: { value: '18:00' } });
    fireEvent.change(screen.getByLabelText('Time 2'), { target: { value: '08:15' } });
    await userEvent.click(next());
    await userEvent.click(screen.getByRole('radio', { name: /^Fully automatic/ }));
    await userEvent.click(next());
    await userEvent.click(screen.getByRole('button', { name: 'Start autopilot' }));
    await waitFor(() => expect(ipc.saveAutopilot).toHaveBeenCalled());
    expect(ipc.saveAutopilot).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'en', frequency: { kind: 'days', days: [0, 1, 5], times: ['08:15', '18:00'] }, review: false, agentId: 'claude' }),
    );
  });

  it('keeps the summary with an error when saving fails', async () => {
    vi.mocked(ipc.saveAutopilot).mockRejectedValue(new Error('no'));
    render(<AutopilotWizard id="a1" now={now} />);
    await screen.findByRole('heading', { level: 1, name: 'Edit Kopi' });
    await userEvent.click(screen.getByRole('button', { name: /Summary/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText("Couldn't save the autopilot. Try again")).toBeInTheDocument();
    expect(useApp.getState().route).toEqual({ name: 'autopilot-wizard' });
  });

  it('edit: prefilled, any step can be picked, and Save changes keeps the id', async () => {
    render(<AutopilotWizard id="a1" now={now} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Edit Kopi' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Kopi');
    const steps = screen.getByRole('list', { name: 'Autopilot steps' });
    await userEvent.click(within(steps).getByRole('button', { name: /Schedule/ }));
    expect(heading()).toHaveTextContent('How often, and how long?');
    expect(screen.getByLabelText('Time 1')).toHaveValue('19:00');
    expect(screen.getByRole('radio', { name: '45s' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(steps).getByRole('button', { name: /Style/ }));
    expect(await screen.findByRole('radio', { name: /Bold/ })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(steps).getByRole('button', { name: /Agent/ }));
    expect(screen.getByRole('radio', { name: 'Gemini CLI' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /^Fully automatic/ })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(steps).getByRole('button', { name: /Niche/ }));
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Kopi baru');
    await userEvent.click(within(steps).getByRole('button', { name: /Summary/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(ipc.saveAutopilot).toHaveBeenCalled());
    expect(ipc.saveAutopilot).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a1', name: 'Kopi baru', styleId: 's2', agentId: 'gemini', lengthSec: 45, review: false, frequency: { kind: 'daily', times: ['12:00', '19:00'] } }),
    );
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'autopilot', id: 'a1' }));
  });

  it('refuses an agent that is no longer installed', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([{ ...existing, agentId: 'codex' }]);
    render(<AutopilotWizard id="a1" now={now} />);
    await screen.findByRole('heading', { level: 1, name: 'Edit Kopi' });
    await userEvent.click(screen.getByRole('button', { name: /Summary/ }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByText('Pick an agent')).toBeInTheDocument();
  });

  it('asks before leaving with unsaved input, from the sidebar, Cancel and Esc', async () => {
    render(<AutopilotWizard now={now} />);
    // Nothing typed yet: leaving just goes.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useApp.getState().route).toEqual({ name: 'autopilot' });
    useApp.setState({ route: { name: 'autopilot-wizard' } });
    await userEvent.type(screen.getByLabelText('Name'), 'K');
    useApp.getState().navigate({ name: 'videos' });
    expect(await screen.findByRole('dialog')).toHaveTextContent('Discard this autopilot?');
    expect(useApp.getState().route).toEqual({ name: 'autopilot-wizard' });
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Name')).toHaveValue('K');
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(useApp.getState().route).toEqual({ name: 'autopilot' });
    expect(useApp.getState().leaveGuard).toBeNull();
  });

  it('more videos a day pick free hours, so the times stay valid', async () => {
    render(<AutopilotWizard now={now} />);
    await toSchedule();
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Videos each day' })).getByRole('radio', { name: '3' }));
    expect(screen.getByLabelText('Time 2')).toHaveValue('13:00');
    expect(screen.getByLabelText('Time 3')).toHaveValue('14:00');
    expect(next()).toBeEnabled();
  });

  it('radio groups: arrow keys move the choice and the focus; only the checked option is a Tab stop', async () => {
    render(<AutopilotWizard now={now} />);
    await toSchedule();
    const sixty = screen.getByRole('radio', { name: '60s' });
    expect(sixty).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: '90s' })).toHaveAttribute('tabindex', '-1');
    sixty.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '90s' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '90s' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: '45s' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(next());
    const claude = screen.getByRole('radio', { name: 'Claude Code' });
    claude.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Gemini CLI' })).toHaveAttribute('aria-checked', 'true');
  });

  it('editing asks to discard your changes, not the autopilot', async () => {
    render(<AutopilotWizard id="a1" now={now} />);
    await userEvent.type(await screen.findByLabelText('Name'), ' baru');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Discard your changes?');
  });

  const NICHE = { id: 'science', title: 'Science explained', prompt: 'Surprising science, simply.' };
  const VOICE = { id: 'Rachel', name: 'Rachel', description: 'Calm narrator', previewUrl: 'https://x/rachel.mp3' };
  const ACCOUNT = { id: 'sa_1', platform: 'tiktok', username: 'oyen', profilePhotoUrl: null, status: 'connected' as const };

  it('offers catalog niches and voices; picking keeps the prompt and id, and accounts turn on automatic posting', async () => {
    vi.mocked(ipc.listNiches).mockResolvedValue([NICHE]);
    vi.mocked(ipc.listVoices).mockResolvedValue([VOICE]);
    vi.mocked(cloud.socialAccounts).mockResolvedValue([ACCOUNT, { ...ACCOUNT, id: 'sa_2', username: 'gone', status: 'disconnected' }]);
    render(<AutopilotWizard now={now} />);
    // The cards come first; the box for your own niche is on the other tab.
    expect(screen.getByRole('tab', { name: 'Choose a niche' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Your niche')).toBeNull();
    await userEvent.click(await screen.findByRole('radio', { name: /Science explained/ }));
    expect(screen.getByLabelText('Name')).toHaveValue('Science explained');
    await userEvent.click(next());
    await userEvent.click(await screen.findByRole('radio', { name: /Atlas/ }));
    await userEvent.click(next());
    await userEvent.click(screen.getByRole('radio', { name: /Rachel/ }));
    expect(screen.getByLabelText('Hear Rachel')).toHaveAttribute('src', VOICE.previewUrl);
    await userEvent.click(next());
    await userEvent.click(next());
    expect(screen.queryByLabelText(/@gone/)).toBeNull();
    await userEvent.click(screen.getByLabelText(/@oyen/));
    await userEvent.click(next());
    expect(screen.getByTestId('summary-niche')).toHaveTextContent('Science explained');
    await userEvent.click(screen.getByRole('button', { name: 'Start autopilot' }));
    await waitFor(() => expect(ipc.saveAutopilot).toHaveBeenCalled());
    expect(ipc.saveAutopilot).toHaveBeenCalledWith(
      expect.objectContaining({ nicheId: 'science', niche: NICHE.prompt, voiceId: 'Rachel', posting: 'automatic', socialAccountIds: ['sa_1'] }),
    );
  });

  it('says when the catalog is offline, retries, and still lets the user write a niche', async () => {
    vi.mocked(ipc.listNiches).mockRejectedValueOnce(new Error('offline'));
    render(<AutopilotWizard now={now} />);
    expect(await screen.findByText(/Couldn't load the niches/)).toBeInTheDocument();
    vi.mocked(ipc.listNiches).mockResolvedValueOnce([NICHE]);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('radio', { name: /Science explained/ })).toBeInTheDocument();
    vi.mocked(ipc.listNiches).mockRejectedValueOnce(new Error('offline'));
    cleanup();
    render(<AutopilotWizard now={now} />);
    await screen.findByText(/Couldn't load the niches/);
    await userEvent.click(screen.getByRole('button', { name: 'Write my own' }));
    await userEvent.type(screen.getByLabelText('Your niche'), 'Coffee');
    expect(screen.getByLabelText('Your niche')).toHaveValue('Coffee');
  });

  it('each niche tab keeps its own answer: a card prompt never lands in the box, and typed text comes back', async () => {
    vi.mocked(ipc.listNiches).mockResolvedValue([NICHE]);
    render(<AutopilotWizard now={now} />);
    await writeOwn();
    await userEvent.type(screen.getByLabelText('Your niche'), 'Coffee');
    await userEvent.click(screen.getByRole('tab', { name: 'Choose a niche' }));
    await userEvent.click(await screen.findByRole('radio', { name: /Science explained/ }));
    await writeOwn();
    expect(screen.getByLabelText('Your niche')).toHaveValue('Coffee');
    await userEvent.click(screen.getByRole('tab', { name: 'Choose a niche' }));
    expect(screen.getByRole('radio', { name: /Science explained/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Pick a niche')).toBeInTheDocument();
  });

  it('edit: a catalog niche opens on its card; one the catalog dropped opens as text', async () => {
    vi.mocked(ipc.listNiches).mockResolvedValue([NICHE]);
    vi.mocked(ipc.listAutopilots).mockResolvedValue([{ ...existing, nicheId: 'science', niche: NICHE.prompt }]);
    const first = render(<AutopilotWizard id="a1" now={now} />);
    expect(await screen.findByRole('radio', { name: /Science explained/ })).toHaveAttribute('aria-checked', 'true');
    first.unmount();
    vi.mocked(ipc.listAutopilots).mockResolvedValue([{ ...existing, nicheId: 'removed', niche: 'Old prompt' }]);
    render(<AutopilotWizard id="a1" now={now} />);
    expect(await screen.findByLabelText('Your niche')).toHaveValue('Old prompt');
    await userEvent.click(within(screen.getByRole('list', { name: 'Autopilot steps' })).getByRole('button', { name: /Summary/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(ipc.saveAutopilot).toHaveBeenCalledWith(expect.objectContaining({ nicheId: null, niche: 'Old prompt' })));
  });

  it('opens an agent suggestion on the Summary, unsaved; made-up ids are dropped and block or fall back', async () => {
    vi.mocked(ipc.listNiches).mockResolvedValue([NICHE]);
    vi.mocked(ipc.listVoices).mockResolvedValue([VOICE]);
    vi.mocked(cloud.socialAccounts).mockResolvedValue([ACCOUNT]);
    render(
      <AutopilotWizard
        now={now}
        draft={{ name: 'Sains', nicheId: 'made-up', styleId: 's1', voiceId: 'NotAVoice', language: 'en', lengthSec: 90, days: 'weekends', times: ['10:00', '20:00'], review: false, socialAccountIds: ['sa_1', 'sa_9'] }}
      />,
    );
    expect(heading()).toHaveTextContent('Check and start');
    expect(ipc.saveAutopilot).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('summary-agent')).toHaveTextContent('TikTok · @oyen'));
    expect(screen.getByTestId('summary-agent')).not.toHaveTextContent('sa_9');
    expect(screen.getByTestId('summary-voice')).toHaveTextContent('Default voice');
    expect(screen.getByTestId('summary-schedule')).toHaveTextContent('2 a day · Weekends · 10:00, 20:00');
    expect(screen.getByTestId('summary-schedule')).toHaveTextContent('90s');
    // The niche it named doesn't exist: nothing starts until the user gives one.
    expect(await screen.findByText('Say what the videos are about')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start autopilot' })).toBeDisabled();
  });

  it('opens a good agent suggestion ready to start, and asks before leaving it', async () => {
    vi.mocked(ipc.listNiches).mockResolvedValue([NICHE]);
    render(<AutopilotWizard now={now} draft={{ name: 'Sains', nicheId: 'science', styleId: 's1' }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start autopilot' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Start autopilot' }));
    await waitFor(() => expect(ipc.saveAutopilot).toHaveBeenCalledWith(expect.objectContaining({ nicheId: 'science', niche: NICHE.prompt, posting: 'manual' })));
  });

  it('edits an older weekly autopilot as chosen days, keeping its length and time', async () => {
    vi.mocked(ipc.listAutopilots).mockResolvedValue([{ ...existing, lengthSec: 30, frequency: { kind: 'weekly', days: [1, 3], time: '08:00' } }]);
    render(<AutopilotWizard id="a1" now={now} />);
    await screen.findByRole('heading', { level: 1, name: 'Edit Kopi' });
    await userEvent.click(within(screen.getByRole('list', { name: 'Autopilot steps' })).getByRole('button', { name: /Schedule/ }));
    expect(screen.getByRole('button', { name: 'Certain days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('radio', { name: '30s' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(screen.getByRole('list', { name: 'Autopilot steps' })).getByRole('button', { name: /Summary/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(ipc.saveAutopilot).toHaveBeenCalledWith(expect.objectContaining({ lengthSec: 30, frequency: { kind: 'days', days: [1, 3], times: ['08:00'] } })),
    );
  });

  it('speaks Indonesian', async () => {
    setUiLanguage('id');
    render(<AutopilotWizard now={now} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Autopilot baru' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Videonya tentang apa?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lanjut' })).toBeDisabled();
    expect(screen.getByText('Pilih niche dulu')).toBeInTheDocument();
  });
});
