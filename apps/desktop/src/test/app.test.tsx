import userEvent from '@testing-library/user-event';
import { ComingSoon } from '@/screens/ComingSoon';
import { act, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { Settings } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  systemLocale: vi.fn(),
  listProjects: vi.fn().mockResolvedValue([]),
  listAutopilots: vi.fn().mockResolvedValue([]),
  listSlots: vi.fn().mockResolvedValue([]),
  listStyles: vi.fn().mockResolvedValue([]),
  listNiches: vi.fn().mockResolvedValue([]),
  listVoices: vi.fn().mockResolvedValue([]),
  detectAgents: vi.fn().mockResolvedValue([]),
  listRecentChats: vi.fn().mockResolvedValue([]),
  listArchivedChats: vi.fn().mockResolvedValue([]),
  setThreadArchived: vi.fn().mockResolvedValue(undefined),
  purgeArchive: vi.fn().mockResolvedValue({ chats: 0, cards: 0 }),
  setJobsArchived: vi.fn().mockResolvedValue(undefined),
  syncStyles: vi.fn().mockResolvedValue({ styles: [], offline: false }),
}));
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}), onAgentUpdate: vi.fn(), onPermission: vi.fn() }));
const engine = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock('@/state/autopilot', () => ({ startAutopilot: vi.fn(() => engine.stop) }));
vi.mock('@/lib/buildJobs', () => ({ settleLateRenders: vi.fn(), recheckDoneBuildJobs: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/projectStatus', () => ({ backfillProjectStatus: vi.fn().mockResolvedValue(undefined) }));

import { getSettings, syncStyles, systemLocale, updateSettings } from '@/lib/ipc';
import App from '@/App';
import { startAutopilot } from '@/state/autopilot';
import { recheckDoneBuildJobs } from '@/lib/buildJobs';
import { backfillProjectStatus } from '@/lib/projectStatus';
import { useApp } from '@/state/app';

const base: Settings = {
  workingFolder: '/tmp/Tayang',
  defaultAgent: 'claude',
  frameCheck: true,
  language: 'id',
  format: '9:16',
  fps: 30,
  onboarded: false,
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

describe('App start', () => {
  beforeEach(() => useApp.setState({ route: { name: 'welcome' }, settings: null }));

  it('shows welcome when not onboarded', async () => {
    vi.mocked(getSettings).mockResolvedValue(base);
    render(<App />);
    expect(await screen.findByText('Get started')).toBeInTheDocument();
  });

  it('shows the plans screen full window, like onboarding (no sidebar)', async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...base, onboarded: true });
    const { container } = render(<App />);
    await screen.findByText('What are we making?', { selector: 'h1' });
    act(() => useApp.getState().navigate({ name: 'plans', from: 'settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Let Tayang do the posting' })).toBeInTheDocument();
    expect(container.querySelector('#app-sidebar')).toBeNull();
  });

  it('goes to a new chat when onboarded', async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...base, onboarded: true });
    render(<App />);
    expect(await screen.findByText('What are we making?', { selector: 'h1' })).toBeInTheDocument();
    expect(useApp.getState().route.name).toBe('chat-new');
  });

  it('once onboarded, starts the one-time check of old done build jobs with the saved flag', async () => {
    vi.mocked(recheckDoneBuildJobs).mockClear();
    vi.mocked(getSettings).mockResolvedValue({ ...base, onboarded: true, buildJobsChecked: false });
    render(<App />);
    await screen.findByText('What are we making?', { selector: 'h1' });
    expect(recheckDoneBuildJobs).toHaveBeenCalledWith(false);
  });

  it('once onboarded, starts the one-time project status backfill with the saved flag', async () => {
    vi.mocked(backfillProjectStatus).mockClear();
    vi.mocked(getSettings).mockResolvedValue({ ...base, onboarded: true, projectStatusChecked: false });
    render(<App />);
    await screen.findByText('What are we making?', { selector: 'h1' });
    expect(backfillProjectStatus).toHaveBeenCalledWith(false);
  });

  it('starts the autopilot engine once onboarded, and stops it on unmount', async () => {
    vi.mocked(startAutopilot).mockClear();
    vi.mocked(getSettings).mockResolvedValue(base);
    const first = render(<App />);
    await screen.findByText('Get started');
    expect(startAutopilot).not.toHaveBeenCalled();
    first.unmount();
    useApp.setState({ settings: null });
    vi.mocked(getSettings).mockResolvedValue({ ...base, onboarded: true });
    const { unmount } = render(<App />);
    await vi.waitFor(() => expect(startAutopilot).toHaveBeenCalledTimes(1));
    unmount();
    expect(engine.stop).toHaveBeenCalled();
  });

  it('opens the Autopilot screen and its wizard, not the coming soon page', async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...base, onboarded: true });
    render(<App />);
    await vi.waitFor(() => expect(useApp.getState().route).toEqual({ name: 'chat-new' }));
    act(() => useApp.getState().navigate({ name: 'autopilot' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Autopilot' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Autopilot is coming soon' })).toBeNull();
    act(() => useApp.getState().navigate({ name: 'autopilot-wizard' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'New autopilot' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Autopilot is coming soon' })).toBeNull();
  });

  it('the coming soon page, for when the flag is off, sends the user to the Calendar', async () => {
    render(<ComingSoon feature="autopilot" />);
    await userEvent.click(screen.getByRole('button', { name: 'Open the Calendar' }));
    expect(useApp.getState().route).toEqual({ name: 'calendar' });
  });
});

describe('App interface language', () => {
  beforeEach(() => useApp.setState({ route: { name: 'welcome' }, settings: null }));

  it('first run: asks the system (through Rust) for its language, not the webview', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    vi.mocked(systemLocale).mockResolvedValue('id-ID');
    vi.mocked(getSettings).mockResolvedValue(base);
    vi.mocked(updateSettings).mockClear().mockImplementation(async (p) => ({ ...base, ...p }));
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Mulai' })).toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'id' });
    vi.mocked(systemLocale).mockReset();
    vi.restoreAllMocks();
  });

  it('first run: keeps the language in the store when saving it fails', async () => {
    vi.mocked(systemLocale).mockResolvedValue('id_ID');
    vi.mocked(getSettings).mockResolvedValue(base);
    vi.mocked(updateSettings).mockClear().mockRejectedValue(new Error('disk full'));
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Mulai' })).toBeInTheDocument();
    expect(useApp.getState().settings?.uiLanguage).toBe('id');
    vi.mocked(systemLocale).mockReset();
  });

  it('first run: falls back to the webview language when Rust cannot say', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('id-ID');
    vi.mocked(systemLocale).mockRejectedValue(new Error('no locale'));
    vi.mocked(getSettings).mockResolvedValue(base);
    vi.mocked(updateSettings).mockClear().mockImplementation(async (p) => ({ ...base, ...p }));
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Mulai' })).toBeInTheDocument();
    vi.mocked(systemLocale).mockReset();
    vi.restoreAllMocks();
  });

  it('first run: follows an Indonesian system language, saves it, and sets <html lang>', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('id-ID');
    vi.mocked(getSettings).mockResolvedValue(base);
    vi.mocked(updateSettings).mockClear().mockImplementation(async (p) => ({ ...base, ...p }));
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Mulai' })).toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'id' });
    expect(document.documentElement.lang).toBe('id');
    vi.restoreAllMocks();
  });

  it('a saved language wins over the system language and is not saved again', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('id-ID');
    vi.mocked(getSettings).mockResolvedValue({ ...base, uiLanguage: 'en' });
    vi.mocked(updateSettings).mockClear();
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Get started' })).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('App built-in styles', () => {
  it('syncs the styles in the background at startup, and a failed sync changes nothing', async () => {
    useApp.setState({ route: { name: 'welcome' }, settings: null });
    vi.mocked(syncStyles).mockClear().mockRejectedValueOnce(new Error('offline'));
    vi.mocked(getSettings).mockResolvedValue({ ...base, onboarded: true });
    render(<App />);
    expect(await screen.findByText('What are we making?', { selector: 'h1' })).toBeInTheDocument();
    expect(syncStyles).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('App settings failure', () => {
  it('shows an error with Try again instead of a blank window', async () => {
    useApp.setState({ route: { name: 'welcome' }, settings: null });
    vi.mocked(getSettings).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(base);
    render(<App />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    retry.click();
    expect(await screen.findByText('Get started')).toBeInTheDocument();
  });
});
