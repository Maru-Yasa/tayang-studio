import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { AgentUpdate, PermissionRequest, Settings, ToolStatus } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  getSystemInfo: vi.fn(),
  checkTools: vi.fn(),
  agentStart: vi.fn(),
  agentPrompt: vi.fn(),
  agentCancel: vi.fn(),
  agentStop: vi.fn().mockResolvedValue(undefined),
  agentRespondPermission: vi.fn(),
  updateSettings: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
import { openUrl } from '@tauri-apps/plugin-opener';

type UpdateCb = (e: { chatId: string; update: AgentUpdate }) => void;
type PermCb = (r: PermissionRequest) => void;
const handlers: { update: UpdateCb[]; perm: PermCb[] } = { update: [], perm: [] };
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}),
  onAgentUpdate: vi.fn(async (cb: UpdateCb) => {
    handlers.update.push(cb);
    return () => {};
  }),
  onPermission: vi.fn(async (cb: PermCb) => {
    handlers.perm.push(cb);
    return () => {};
  }),
}));

import * as ipc from '@/lib/ipc';
import { Requirements } from '@/screens/onboarding/Requirements';
import { useApp } from '@/state/app';
import { useInstall } from '@/state/install';

const settings: Settings = {
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

const tool = (id: ToolStatus['id'], name: string, required: boolean, ok: boolean): ToolStatus => ({
  id,
  name,
  required,
  found: ok,
  version: ok ? '1.0' : null,
  ok,
  detail: '',
});

const missingFfmpeg = [
  tool('node', 'Node.js', true, true),
  tool('ffmpeg', 'FFmpeg', true, false),
  tool('chrome', 'Chrome', true, true),
  tool('elevenlabs-mcp', 'ElevenLabs MCP', false, false),
  tool('ytdlp', 'yt-dlp', false, false),
];

const request: PermissionRequest = {
  chatId: 'setup',
  requestId: 'r1',
  title: 'Run brew install ffmpeg',
  commands: ['brew install ffmpeg', 'ffmpeg -version'],
  options: [
    { id: 'always', label: 'Always', kind: 'allow-always' },
    { id: 'once', label: 'Once', kind: 'allow-once' },
    { id: 'no', label: 'No', kind: 'reject-once' },
  ],
};

const emitUpdate = (update: AgentUpdate) =>
  act(async () => handlers.update.forEach((h) => h({ chatId: 'setup', update })));

describe('Requirements', () => {
  beforeEach(() => {
    handlers.update = [];
    handlers.perm = [];
    vi.clearAllMocks();
    useInstall.getState().reset();
    useApp.setState({ settings, route: { name: 'requirements' } });
    vi.mocked(ipc.getSystemInfo).mockResolvedValue({ os: 'macos', osVersion: '26', packageManager: 'brew' });
    vi.mocked(ipc.checkTools).mockResolvedValue(missingFfmpeg);
    vi.mocked(ipc.agentStart).mockResolvedValue(false);
    vi.mocked(ipc.agentPrompt).mockResolvedValue();
    vi.mocked(ipc.agentRespondPermission).mockResolvedValue();
    vi.mocked(ipc.updateSettings).mockResolvedValue({ ...settings, onboarded: true });
  });

  it('blocks start while ffmpeg is missing', async () => {
    render(<Requirements />);
    expect(await screen.findByText(/shows you every command your agent asks to run, and nothing it asks about runs until you allow/)).toBeInTheDocument();
    expect(await screen.findByText('Install FFmpeg to continue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start my first video/ })).toBeDisabled();
  });

  it('installs through the agent, asks permission, and unlocks start after done', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await screen.findByText('Install FFmpeg to continue');

    await user.click(screen.getByRole('button', { name: 'Install FFmpeg' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(ipc.agentStart).toHaveBeenCalledWith('setup', 'claude');
    const parts = vi.mocked(ipc.agentPrompt).mock.calls[0]![1];
    expect(JSON.stringify(parts)).toContain('brew install ffmpeg');

    await act(async () => handlers.perm.forEach((h) => h(request)));
    expect(screen.getAllByText(/brew install ffmpeg/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Allow and install' })).toBeInTheDocument();
    expect(screen.queryByText('Always')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Allow and install' }));
    expect(ipc.agentRespondPermission).toHaveBeenCalledWith('r1', 'once');

    vi.mocked(ipc.checkTools).mockResolvedValue(
      missingFfmpeg.map((t) => (t.id === 'ffmpeg' ? tool('ffmpeg', 'FFmpeg', true, true) : t)),
    );
    await emitUpdate({ kind: 'done', stopReason: 'end_turn' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Start my first video/ })).toBeEnabled(),
    );
  });

  it('Node is installed by the user from nodejs.org, not by the agent', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.checkTools).mockResolvedValue(
      missingFfmpeg.map((t) => (t.id === 'node' ? tool('node', 'Node.js', true, false) : t)),
    );
    render(<Requirements />);
    expect(await screen.findByText('Install Node.js 22 or newer, then press Check again')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Install Node.js' }));
    expect(openUrl).toHaveBeenCalledWith('https://nodejs.org/en/download');
    expect(ipc.agentStart).not.toHaveBeenCalled();
  });

  it('an old Node says which version it found and asks for an update', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.checkTools).mockResolvedValue(
      missingFfmpeg.map((t) => (t.id === 'node' ? { ...tool('node', 'Node.js', true, false), found: true, version: '20.6.1' } : t)),
    );
    render(<Requirements />);
    expect(await screen.findByText('Found Node.js 20.6.1 · Tayang needs 22 or newer. Update it, then press Check again')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update Node.js' }));
    expect(openUrl).toHaveBeenCalledWith('https://nodejs.org/en/download');
  });

  it('Chrome on a Mac without Homebrew is installed by the user from google.com/chrome', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.getSystemInfo).mockResolvedValue({ os: 'macos', osVersion: '26', packageManager: null });
    vi.mocked(ipc.checkTools).mockResolvedValue(
      missingFfmpeg.map((t) => (t.id === 'chrome' ? tool('chrome', 'Chrome', true, false) : t)),
    );
    render(<Requirements />);
    expect(await screen.findByText('Install Google Chrome, then press Check again')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Install Google Chrome' }));
    expect(openUrl).toHaveBeenCalledWith('https://www.google.com/chrome/');
    expect(ipc.agentStart).not.toHaveBeenCalled();
    expect(screen.queryByText(/apt install/)).toBeNull();
  });

  it('shows what the agent said when the tool is still missing', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    await emitUpdate({ kind: 'text', text: 'Please run `sudo apt install -y chromium` ' });
    await emitUpdate({ kind: 'text', text: 'in a terminal.' });
    await emitUpdate({ kind: 'done', stopReason: 'end_turn' });
    expect(await screen.findByText('Please run `sudo apt install -y chromium` in a terminal.')).toBeInTheDocument();
  });

  it('cancel answers null and returns the row to Install', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    await act(async () => handlers.perm.forEach((h) => h(request)));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ipc.agentRespondPermission).toHaveBeenCalledWith('r1', null);
    expect(await screen.findByRole('button', { name: 'Install FFmpeg' })).toBeInTheDocument();
  });

  it('clears the permission card on error and offers Try again', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    await act(async () => handlers.perm.forEach((h) => h(request)));
    await emitUpdate({ kind: 'error', message: 'agent crashed' });
    expect(screen.queryByRole('button', { name: 'Allow and install' })).not.toBeInTheDocument();
    expect(screen.getByText(/agent crashed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a turn that ends without the tool shows a short error, with the agent reply folded away', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    await emitUpdate({ kind: 'text', text: 'Let me check the metadata in the uv cache. 0.12.2' });
    await emitUpdate({ kind: 'done', stopReason: 'end_turn' });
    const alert = await screen.findByText('Tayang still can’t find it on this computer. Try again.');
    expect(alert).toHaveTextContent('Tayang still can’t find it on this computer. Try again.');
    expect(alert).not.toHaveTextContent('uv cache');
    const details = screen.getByText('What Claude Code said').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('Let me check the metadata in the uv cache. 0.12.2');
  });

  it('tells subscribers that their Tayang plan already includes ElevenLabs voice', async () => {
    render(<Requirements />);
    expect(
      await screen.findByText('Already on Tayang Creator or above? ElevenLabs voice is included, so you can skip this.'),
    ).toBeInTheDocument();
  });

  it('disables other installs while one runs', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    expect(screen.getByRole('button', { name: 'Install yt-dlp' })).toBeDisabled();
  });
});

describe('PermissionCard options', () => {
  it('offers only Cancel when there is no allow-once option', async () => {
    const { PermissionCard } = await import('@/components/PermissionCard');
    const onRespond = vi.fn();
    render(
      <PermissionCard
        request={{ ...request, options: [{ id: 'always', label: 'Always', kind: 'allow-always' }] }}
        onRespond={onRespond}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Allow and install' })).not.toBeInTheDocument();
    expect(screen.getByText("This request can't be allowed once")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onRespond).toHaveBeenCalledWith(null);
  });
});

describe('Requirements multi-request', () => {
  beforeEach(() => {
    handlers.update = [];
    handlers.perm = [];
    vi.clearAllMocks();
    useInstall.getState().reset();
    useApp.setState({ settings, route: { name: 'requirements' } });
    vi.mocked(ipc.getSystemInfo).mockResolvedValue({ os: 'macos', osVersion: '26', packageManager: 'brew' });
    vi.mocked(ipc.checkTools).mockResolvedValue(missingFfmpeg);
    vi.mocked(ipc.agentStart).mockResolvedValue(false);
    vi.mocked(ipc.agentPrompt).mockResolvedValue();
    vi.mocked(ipc.agentCancel).mockResolvedValue();
    vi.mocked(ipc.agentRespondPermission).mockResolvedValue();
  });

  it('shows and answers two sequential requests in one install', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    await act(async () => handlers.perm.forEach((h) => h(request)));
    await user.click(screen.getByRole('button', { name: 'Allow and install' }));
    expect(ipc.agentRespondPermission).toHaveBeenLastCalledWith('r1', 'once');

    await act(async () => handlers.perm.forEach((h) => h({ ...request, requestId: 'r2', commands: ['ffmpeg -version'] })));
    await user.click(screen.getByRole('button', { name: 'Allow and install' }));
    expect(ipc.agentRespondPermission).toHaveBeenLastCalledWith('r2', 'once');
  });

  it('queues two parallel requests and answers both in order', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    await act(async () => {
      handlers.perm.forEach((h) => h(request));
      handlers.perm.forEach((h) => h({ ...request, requestId: 'r2', commands: ['ffmpeg -version'] }));
    });
    expect(screen.getAllByRole('button', { name: 'Allow and install' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Allow and install' }));
    expect(ipc.agentRespondPermission).toHaveBeenLastCalledWith('r1', 'once');
    expect(await screen.findByText('ffmpeg -version')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow and install' }));
    expect(ipc.agentRespondPermission).toHaveBeenLastCalledWith('r2', 'once');
    expect(ipc.agentRespondPermission).toHaveBeenCalledTimes(2);
  });

  it('answers queued requests with null when the turn ends', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    await act(async () => {
      handlers.perm.forEach((h) => h(request));
      handlers.perm.forEach((h) => h({ ...request, requestId: 'r2' }));
    });
    await emitUpdate({ kind: 'error', message: 'gone' });
    expect(ipc.agentRespondPermission).toHaveBeenCalledWith('r1', null);
    expect(ipc.agentRespondPermission).toHaveBeenCalledWith('r2', null);
    expect(useInstall.getState().request).toBeNull();
    expect(useInstall.getState().queue).toEqual([]);
  });

  it('cancel while running calls agentCancel', async () => {
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    await act(async () => handlers.perm.forEach((h) => h(request)));
    await user.click(screen.getByRole('button', { name: 'Allow and install' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ipc.agentCancel).toHaveBeenCalledWith('setup');
  });
});

describe('Requirements cancel then late events', () => {
  it('keeps installs disabled while closing and ignores the late done', async () => {
    handlers.update = [];
    handlers.perm = [];
    vi.clearAllMocks();
    useInstall.getState().reset();
    useApp.setState({ settings, route: { name: 'requirements' } });
    vi.mocked(ipc.getSystemInfo).mockResolvedValue({ os: 'macos', osVersion: '26', packageManager: 'brew' });
    vi.mocked(ipc.checkTools).mockResolvedValue(missingFfmpeg);
    vi.mocked(ipc.agentStart).mockResolvedValue(false);
    vi.mocked(ipc.agentPrompt).mockResolvedValue();
    vi.mocked(ipc.agentCancel).mockResolvedValue();
    vi.mocked(ipc.agentRespondPermission).mockResolvedValue();
    const user = userEvent.setup();
    render(<Requirements />);
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    await act(async () => handlers.perm.forEach((h) => h(request)));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ipc.agentCancel).toHaveBeenCalledWith('setup');

    const ffmpeg = await screen.findByRole('button', { name: 'Install FFmpeg' });
    expect(ffmpeg).toBeDisabled();

    // stray permission while closing is answered null
    await act(async () => handlers.perm.forEach((h) => h({ ...request, requestId: 'late' })));
    expect(ipc.agentRespondPermission).toHaveBeenLastCalledWith('late', null);
    expect(screen.queryByRole('button', { name: 'Allow and install' })).not.toBeInTheDocument();

    await emitUpdate({ kind: 'done', stopReason: 'cancelled' });
    expect(useInstall.getState().closing).toBe(false);
    expect(screen.getByRole('button', { name: 'Install FFmpeg' })).toBeEnabled();

    // next install is unaffected
    vi.mocked(ipc.checkTools).mockClear();
    await user.click(screen.getByRole('button', { name: 'Install FFmpeg' }));
    expect(useInstall.getState().active).toBe('ffmpeg');
    expect(ipc.checkTools).not.toHaveBeenCalled();
  });
});
