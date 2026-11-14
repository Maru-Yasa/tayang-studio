import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentUpdate, Job, PermissionRequest, Project, Settings, Style as StyleT } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  apiUrlOverride: vi.fn().mockResolvedValue(null),
  listArchivedChats: vi.fn().mockResolvedValue([]),
  setThreadArchived: vi.fn().mockResolvedValue(undefined),
  purgeArchive: vi.fn().mockResolvedValue({ chats: 0, cards: 0 }),
  setJobsArchived: vi.fn().mockResolvedValue(undefined),
  listAutopilots: vi.fn().mockResolvedValue([]),
  listSlots: vi.fn().mockResolvedValue([]),
  saveAutopilot: vi.fn(),
  setAutopilotStatus: vi.fn(),
  deleteAutopilot: vi.fn().mockResolvedValue(undefined),
  updateSlot: vi.fn(),
  listProjects: vi.fn(),
  videoThumbnail: vi.fn().mockResolvedValue(null),
  showVideoInFolder: vi.fn().mockResolvedValue(undefined),
  deleteVideo: vi.fn().mockResolvedValue(undefined),
  updateProject: vi.fn(),
  setSchedule: vi.fn(),
  setPosted: vi.fn(),
  approveProject: vi.fn(),
  listChats: vi.fn(),
  createChat: vi.fn(),
  listStyles: vi.fn(),
  syncStyles: vi.fn(),
  saveStyle: vi.fn(),
  deleteStyle: vi.fn(),
  readStyleResult: vi.fn(),
  studyDir: vi.fn(),
  makeStylePreview: vi.fn(),
  makeStyleSheets: vi.fn(async () => []),
  keepStyleRefs: vi.fn(async () => []),
  copyStyleRefs: vi.fn(async () => 0),
  removeStudyDir: vi.fn().mockResolvedValue(undefined),
  assetUrl: vi.fn((p: string) => `asset://localhost/${p}`),
  listJobs: vi.fn(),
  upsertJob: vi.fn(),
  deleteJob: vi.fn().mockResolvedValue(undefined),
  agentStart: vi.fn(),
  agentSetAuto: vi.fn(),
  agentPrompt: vi.fn(),
  agentCancel: vi.fn(),
  agentStop: vi.fn().mockResolvedValue(undefined),
  agentRespondPermission: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  pickFolder: vi.fn(),
  detectAgents: vi.fn(),
  checkTools: vi.fn(),
  getSystemInfo: vi.fn(),
  listMessages: vi.fn(),
  addMessage: vi.fn(),
}));
const updateHandlers: ((e: { chatId: string; update: AgentUpdate }) => void)[] = [];
const permHandlers: ((r: PermissionRequest) => void)[] = [];
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}),
  onAgentUpdate: vi.fn(async (f: (e: { chatId: string; update: AgentUpdate }) => void) => {
    updateHandlers.push(f);
    return () => {};
  }),
  onPermission: vi.fn(async (f: (r: PermissionRequest) => void) => {
    permHandlers.push(f);
    return () => {};
  }),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  authStart: vi.fn().mockResolvedValue({
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://studio.tayang.app/api/auth/device',
    verificationUriComplete: 'https://studio.tayang.app/api/auth/device?code=ABCD-EFGH',
    expiresIn: 600,
  }),
  authCancel: vi.fn().mockResolvedValue(undefined),
  authStatus: vi.fn().mockResolvedValue({ state: 'signed-out', signedIn: false, offline: false, apiUrl: 'https://studio.tayang.app/api' }),
  authLogout: vi.fn(),
  onAuthChanged: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('@/lib/scheduler', () => ({ sendTestNotification: vi.fn() }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ enable: vi.fn(), disable: vi.fn() }));

import * as ipc from '@/lib/ipc';
import * as authIpc from '@/lib/auth';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Agents } from '@/screens/Agents';
import { Calendar } from '@/screens/Calendar';
import { sendTestNotification } from '@/lib/scheduler';
import * as autostart from '@tauri-apps/plugin-autostart';
import { Settings as SettingsScreen } from '@/screens/Settings';
import { Style, youtubeThumbnail } from '@/screens/Style';
import { Videos } from '@/screens/Videos';
import { useApp } from '@/state/app';
import { useStudy } from '@/state/study';
import { useChat } from '@/state/chat';
import { setUiLanguage } from '@/i18n';
import { localized } from '@/lib/stored';

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

const project = (id: string, title: string, status: Project['status'], scheduledAt: string | null = null, extra: Partial<Project> = {}): Project => ({
  id,
  title,
  slug: id,
  folder: `/w/Tayang/${id}`,
  kind: 'explainer',
  format: '9:16',
  language: 'id',
  status,
  styleId: null,
  scheduledAt,
  reviewState: 'none',
  postedAt: null,
  remindedAt: null, reviewRemindedAt: null,
  durationSec: 30,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
  ...extra,
});

const agents: AgentInfo[] = [
  { id: 'claude', name: 'Claude Code', installed: true, version: '1.0', acpCommand: [], recommended: true },
  { id: 'gemini', name: 'Gemini CLI', installed: false, version: null, acpCommand: [], recommended: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  useStudy.getState().dismiss();
  useApp.setState({ settings, needsYouCount: 0, route: { name: 'videos' } });
  vi.mocked(ipc.listProjects).mockResolvedValue([]);
  vi.mocked(ipc.listStyles).mockResolvedValue([]);
  vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [], offline: false });
  vi.mocked(ipc.listJobs).mockResolvedValue([]);
  vi.mocked(ipc.detectAgents).mockResolvedValue(agents);
  vi.mocked(ipc.checkTools).mockResolvedValue([]);
  vi.mocked(ipc.getSystemInfo).mockResolvedValue({ os: 'macos', osVersion: '15', packageManager: 'brew' });
  vi.mocked(ipc.updateSettings).mockImplementation(async (p) => ({ ...settings, ...p }));
});

describe('Videos', () => {
  it('Rendered tab shows only rendered projects and their count', async () => {
    vi.mocked(ipc.listProjects).mockResolvedValue([
      project('a', 'Draft one', 'draft'),
      project('b', 'Rendered one', 'rendered'),
      project('c', 'Building one', 'building'),
    ]);
    render(<Videos />);
    await screen.findAllByText('Draft one');
    const tab = screen.getByRole('tab', { name: /Rendered/ });
    expect(tab).toHaveTextContent('1');
    expect(screen.getByRole('tab', { name: /In progress/ })).toHaveTextContent('2');
    await userEvent.click(tab);
    expect(screen.getAllByText('Rendered one').length).toBeGreaterThan(0);
    expect(screen.queryByText('Draft one')).not.toBeInTheDocument();
    expect(screen.queryByText('Building one')).not.toBeInTheDocument();
  });

  it('shows each video in its folder, rendered or not', async () => {
    vi.mocked(ipc.listProjects).mockResolvedValue([project('a', 'Rendered one', 'rendered'), project('b', 'Draft one', 'draft')]);
    render(<Videos />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show Rendered one in its folder' }));
    expect(ipc.showVideoInFolder).toHaveBeenCalledWith('a');
    await userEvent.click(screen.getByRole('button', { name: 'Show Draft one in its folder' }));
    expect(ipc.showVideoInFolder).toHaveBeenCalledWith('b');
  });

  it('deletes a video after asking, and it leaves the list', async () => {
    vi.mocked(ipc.listProjects).mockResolvedValue([project('a', 'Old one', 'rendered'), project('b', 'Kept one', 'draft')]);
    render(<Videos />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Old one' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/moves its folder to the trash/)).toBeInTheDocument();
    // Cancelling deletes nothing.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(ipc.deleteVideo).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Old one' }));
    vi.mocked(ipc.listProjects).mockResolvedValue([project('b', 'Kept one', 'draft')]);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete video' }));
    expect(ipc.deleteVideo).toHaveBeenCalledWith('a');
    await waitFor(() => expect(screen.queryByText('Old one')).not.toBeInTheDocument());
    expect(screen.getAllByText('Kept one').length).toBeGreaterThan(0);
  });

  it('keeps the video and says why when deleting fails', async () => {
    vi.mocked(ipc.listProjects).mockResolvedValue([project('a', 'Busy one', 'building')]);
    vi.mocked(ipc.deleteVideo).mockRejectedValueOnce('This video is still being made. Wait for it to finish, then delete it');
    render(<Videos />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Busy one' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete video' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still being made');
    expect(screen.getAllByText('Busy one').length).toBeGreaterThan(0);
  });

  it('shows the empty state', async () => {
    render(<Videos />);
    expect(await screen.findByText('No videos yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
  });
});

describe('Style', () => {
  it('says truly what stays on this computer after a study: a short preview clip and a poster', () => {
    render(<Style />);
    expect(screen.getByText(/keeping only a short silent preview clip and a poster frame here/)).toBeInTheDocument();
  });

  it('rejects a link that is not a supported video site', async () => {
    render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://example.com/x');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    expect(await screen.findByText('Paste a TikTok, Reels or YouTube link')).toBeInTheDocument();
    expect(ipc.agentPrompt).not.toHaveBeenCalled();
  });

  it('studies a valid TikTok link through the agent', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/Tayang/.tayang/style-study/s1');
    render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://www.tiktok.com/@a/video/123');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(ipc.studyDir).toHaveBeenCalled();
    expect(vi.mocked(ipc.upsertJob).mock.calls[0]![0]).toMatchObject({ kind: 'study-style', status: 'working' });
    const [chatId, parts] = vi.mocked(ipc.agentPrompt).mock.calls[0]!;
    expect(chatId).toMatch(/^study-/);
    expect(JSON.stringify(parts)).toContain('/w/Tayang/.tayang/style-study/s1');
  });
  it('runs in auto mode: no Allow card, and shows the commands it ran without asking', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(vi.mocked(ipc.agentStart).mock.calls[0]).toEqual([expect.stringMatching(/^study-/), 'claude', true]);
    const chatId = vi.mocked(ipc.agentPrompt).mock.calls[0]![0];
    act(() =>
      updateHandlers.forEach((h) =>
        h({ chatId, update: { kind: 'tool', toolCallId: 'auto-1', title: 'Ran without asking: yt-dlp -x https://youtu.be/abc', status: 'done' } }),
      ),
    );
    expect(await screen.findByText('Ran without asking: yt-dlp -x https://youtu.be/abc')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('shows a card only for a request auto mode could not approve, never for the ones it ran', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const chatId = vi.mocked(ipc.agentPrompt).mock.calls[0]![0];
    // Rust answered this one itself: only the tool line reaches the UI.
    act(() =>
      updateHandlers.forEach((h) =>
        h({ chatId, update: { kind: 'tool', toolCallId: 'auto-1', title: 'Ran without asking: ls -la', status: 'done' } }),
      ),
    );
    expect(screen.queryByText('This request can\'t be allowed once')).not.toBeInTheDocument();
    // This one had no allow-once option, so Rust forwarded it as a normal request.
    act(() =>
      permHandlers.forEach((h) =>
        h({
          chatId,
          requestId: 'r1',
          title: 'Delete files',
          commands: ['rm -rf x'],
          options: [{ id: 'no', label: 'Reject', kind: 'reject-once' }],
        }),
      ),
    );
    expect(await screen.findByText("This request can't be allowed once")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('saves the style on done and marks the job failed when the result is unreadable', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    const good = JSON.stringify({ name: 'Zoom cut', notes: { camera: 'Punch-in' }, prompt: 'Cut on every beat' });
    vi.mocked(ipc.readStyleResult).mockResolvedValueOnce(good).mockResolvedValueOnce('not json');
    for (const [i, last] of [[0, 'done'], [1, 'failed']] as const) {
      vi.mocked(ipc.upsertJob).mockClear();
      const { unmount } = render(<Style />);
      await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
      await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
      await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(i + 1));
      const chatId = vi.mocked(ipc.agentPrompt).mock.calls[i]![0];
      updateHandlers.forEach((h) => h({ chatId, update: { kind: 'done', stopReason: 'end_turn' } }));
      await waitFor(() => expect(vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0].status).toBe(last));
      expect(ipc.agentStop).toHaveBeenCalledWith(chatId);
      if (last === 'done') expect(ipc.saveStyle).toHaveBeenCalledWith(expect.objectContaining({ name: 'Zoom cut', source: 'copied' }));
      else expect(vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0].note).toBeTruthy();
      unmount();
      useStudy.getState().dismiss();
    }
  });
});

const atlas: StyleT = {
  id: 'atlas-journey',
  name: 'Atlas journey',
  source: 'builtin',
  sourceUrl: null,
  notes: { camera: 'Map fly-through' },
  prompt: 'Fly over a map.',
  createdAt: '2026-11-04T00:00:00Z',
  engine: 'remotion',
  previewUrl: 'https://api.tayang.app/v1/styles/atlas-journey/preview',
  previewVideoUrl: 'https://api.tayang.app/v1/styles/atlas-journey/preview-video',
  template: { sha256: 'a', size: 1, version: 1 },
};
const plain: StyleT = { ...atlas, id: 'plain', name: 'Plain look', engine: 'hyperframes', previewUrl: null, previewVideoUrl: null, template: null };
const openCard = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }));
  return screen.findByRole('dialog');
};

describe('Style built-in styles from the API', () => {
  it('syncs on open and shows the synced styles with preview images', async () => {
    let done: (r: { styles: StyleT[]; offline: boolean }) => void = () => {};
    vi.mocked(ipc.syncStyles).mockReturnValue(new Promise((res) => (done = res)));
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas, plain]);
    const { container } = render(<Style />);
    expect(await screen.findByText('Updating built-in styles')).toBeInTheDocument();
    await act(async () => done({ styles: [atlas, plain], offline: false }));
    expect(await screen.findByText('Starts from a working project')).toBeInTheDocument();
    expect(ipc.syncStyles).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Updating built-in styles')).not.toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', atlas.previewUrl);
    expect(screen.queryByText('Built-in styles are from your last sync')).not.toBeInTheDocument();
    expect(screen.getAllByText('Plain look').length).toBeGreaterThan(0);
  });

  it('falls back to the swatch when a preview image fails to load (offline)', async () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [atlas], offline: true });
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas]);
    const { container } = render(<Style />);
    await screen.findByText('Built-in styles are from your last sync');
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.length).toBe(1);
    imgs.forEach((img) => fireEvent.error(img));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('style-swatch')).toBeInTheDocument();
    const dialog = await openCard('Atlas journey');
    fireEvent.error(dialog.querySelector('video')!);
    fireEvent.error(dialog.querySelector('img')!);
    expect(screen.getByText('No preview for this style')).toBeInTheDocument();
  });

  it('shows the engine in the detail', async () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [atlas], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas]);
    render(<Style />);
    await openCard('Atlas journey');
    expect(await screen.findByText('Remotion')).toBeInTheDocument();
  });

  it('offline with cached styles says they are from the last sync', async () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [atlas], offline: true });
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas]);
    render(<Style />);
    expect(await screen.findByText('Built-in styles are from your last sync')).toBeInTheDocument();
  });

  it('offline with nothing cached asks to connect', async () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [], offline: true });
    render(<Style />);
    expect(await screen.findByText('Connect to the internet to load built-in styles')).toBeInTheDocument();
  });

  it('Use in a new chat carries the style', async () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [atlas], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas]);
    render(<Style />);
    await openCard('Atlas journey');
    await userEvent.click(await screen.findByRole('button', { name: 'Use in a new chat' }));
    expect(useApp.getState().route).toEqual({ name: 'chat-new', styleId: 'atlas-journey' });
  });

  it('Use in a new chat carries a copied style too, even without a template', async () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [plain], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([plain]);
    render(<Style />);
    await openCard(plain.name);
    await userEvent.click(await screen.findByRole('button', { name: 'Use in a new chat' }));
    expect(useApp.getState().route).toEqual({ name: 'chat-new', styleId: plain.id });
  });
});

describe('Copied style recipe in the popup', () => {
  const recipe: StyleT = {
    ...plain,
    id: 'copied-r',
    name: 'Storybook',
    source: 'copied',
    sourceUrl: 'https://youtu.be/abc',
    engine: 'remotion',
    build: 'three.js world inside Remotion',
    palette: ['#5BC8F5', '#F2C14E'],
    references: ['/d/style-refs/copied-r/sheet-01.jpg', '/d/style-refs/copied-r/sheet-02.jpg'],
  };

  it('shows the engine, the build recipe, the palette and the reference frames', async () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [recipe], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([recipe]);
    render(<Style />);
    const dialog = await openCard('Storybook');
    expect(within(dialog).getByText('three.js world inside Remotion')).toBeInTheDocument();
    expect(within(dialog).getByText('Remotion')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('#5BC8F5')).toBeInTheDocument();
    const refs = within(dialog).getAllByRole('img', { name: /Contact sheet/ });
    expect(refs).toHaveLength(2);
    expect(refs[0]).toHaveAttribute('src', 'asset://localhost//d/style-refs/copied-r/sheet-01.jpg');
  });

  it('Study again re-runs the study on the source link and keeps the same style', async () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [recipe], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([recipe]);
    const start = vi.spyOn(useStudy.getState(), 'start').mockResolvedValue();
    render(<Style />);
    const dialog = await openCard('Storybook');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Study again' }));
    expect(start).toHaveBeenCalledWith('https://youtu.be/abc', expect.any(String), undefined, 'copied-r');
    start.mockRestore();
  });
});

describe('Style popup', () => {
  const mocks = () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [atlas, plain], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas, plain]);
  };
  let reduced = false;
  beforeEach(() => {
    reduced = false;
    window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
  });

  it('the grid is thumbnails only: no video, no details aside', async () => {
    mocks();
    const { container } = render(<Style />);
    await screen.findByRole('button', { name: /^Plain look/ });
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Style details' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use in a new chat' })).toBeNull();
  });

  it('clicking a card opens a dialog with the muted looping video, poster and details', async () => {
    mocks();
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    const video = dialog.querySelector('video')!;
    expect(video).toHaveAttribute('src', atlas.previewVideoUrl);
    expect(video).toHaveAttribute('poster', atlas.previewUrl);
    expect(video).toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('loop');
    expect(video).toHaveAttribute('playsinline');
    expect(video.muted).toBe(true);
    expect(within(dialog).getByRole('heading', { name: 'Atlas journey' })).toBeInTheDocument();
    expect(within(dialog).getByText('Map fly-through')).toBeInTheDocument();
    expect(within(dialog).getByText('Fly over a map.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Use in a new chat' })).toBeInTheDocument();
  });

  it('keeps the clip under React StrictMode (dev double-runs effects)', async () => {
    mocks();
    render(
      <StrictMode>
        <Style />
      </StrictMode>,
    );
    const dialog = await openCard('Atlas journey');
    expect(dialog.querySelector('video')).toHaveAttribute('src', atlas.previewVideoUrl);
  });

  it('Enter opens the dialog from a focused card', async () => {
    mocks();
    render(<Style />);
    (await screen.findByRole('button', { name: /^Plain look/ })).focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('Escape closes the dialog, the video is gone and unloaded, and focus returns to the card', async () => {
    mocks();
    const { container } = render(<Style />);
    const dialog = await openCard('Atlas journey');
    const video = dialog.querySelector('video')!;
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(container.ownerDocument.querySelector('video')).toBeNull();
    expect(video).not.toHaveAttribute('src');
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Atlas journey/ })).toHaveFocus());
  });

  it('the close button closes it too', async () => {
    mocks();
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a style without a video shows its image, or the swatch frames', async () => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [{ ...atlas, previewVideoUrl: null }, plain], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([{ ...atlas, previewVideoUrl: null }, plain]);
    render(<Style />);
    let dialog = await openCard('Atlas journey');
    expect(dialog.querySelector('video')).toBeNull();
    expect(dialog.querySelector('img')).toHaveAttribute('src', atlas.previewUrl);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await openCard('Plain look');
    expect(dialog.querySelector('video')).toBeNull();
    expect(within(dialog).getByText('No preview for this style')).toBeInTheDocument();
  });

  it('falls back to the image when the video fails to load', async () => {
    mocks();
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    fireEvent.error(dialog.querySelector('video')!);
    expect(dialog.querySelector('video')).toBeNull();
    expect(dialog.querySelector('img')).toHaveAttribute('src', atlas.previewUrl);
  });

  it('reduced motion: no autoplay, the poster with a play button that starts it', async () => {
    reduced = true;
    mocks();
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    const video = dialog.querySelector('video')!;
    expect(video).not.toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('poster', atlas.previewUrl);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Play preview' }));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('has a pause button while playing', async () => {
    mocks();
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    const video = dialog.querySelector('video')!;
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    fireEvent.playing(video);
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Pause preview' }));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    fireEvent.pause(video);
    expect(await within(dialog).findByRole('button', { name: 'Play preview' })).toBeInTheDocument();
  });

  it('shows the poster as a layer until the video has data, and the icon says Play until it is playing', async () => {
    mocks();
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    const video = dialog.querySelector('video')!;
    expect(within(dialog).getByTestId('preview-poster')).toBeInTheDocument();
    expect(within(dialog).getByTestId('preview-poster').querySelector('img')).toHaveAttribute('src', atlas.previewUrl);
    // WebKit fires play before any data: still the poster and a Play icon.
    fireEvent.play(video);
    expect(within(dialog).getByTestId('preview-poster')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Play preview' })).toBeInTheDocument();
    fireEvent.loadedData(video);
    expect(within(dialog).queryByTestId('preview-poster')).toBeNull();
    fireEvent.playing(video);
    expect(await within(dialog).findByRole('button', { name: 'Pause preview' })).toBeInTheDocument();
  });

  /** Opens a card with fake timers on, so the preview's timers are the fake ones. */
  const openWithFakeTimers = async (name: string) => {
    const card = await screen.findByRole('button', { name: new RegExp(`^${name}`) });
    vi.useFakeTimers();
    fireEvent.click(card);
    return screen.getByRole('dialog');
  };

  it('falls back to the image when the clip has no data after 5 seconds', async () => {
    mocks();
    render(<Style />);
    try {
      const dialog = await openWithFakeTimers('Atlas journey');
      act(() => void vi.advanceTimersByTime(4900));
      expect(dialog.querySelector('video')).not.toBeNull();
      act(() => void vi.advanceTimersByTime(200));
      expect(dialog.querySelector('video')).toBeNull();
      expect(dialog.querySelector('img')).toHaveAttribute('src', atlas.previewUrl);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reduced motion: no timer fallback until Play is pressed, then 5 s from the press', async () => {
    reduced = true;
    mocks();
    render(<Style />);
    try {
      const dialog = await openWithFakeTimers('Atlas journey');
      act(() => void vi.advanceTimersByTime(20_000));
      expect(dialog.querySelector('video')).not.toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Play preview' }));
      act(() => void vi.advanceTimersByTime(4900));
      expect(dialog.querySelector('video')).not.toBeNull();
      act(() => void vi.advanceTimersByTime(200));
      expect(dialog.querySelector('video')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pressing Pause cancels the autoplay fallback timer', async () => {
    mocks();
    render(<Style />);
    try {
      const dialog = await openWithFakeTimers('Atlas journey');
      const video = dialog.querySelector('video')!;
      Object.defineProperty(video, 'paused', { value: false, configurable: true });
      fireEvent.playing(video);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Pause preview' }));
      act(() => void vi.advanceTimersByTime(20_000));
      expect(dialog.querySelector('video')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fall back after the clip has loaded', async () => {
    mocks();
    render(<Style />);
    try {
      const dialog = await openWithFakeTimers('Atlas journey');
      fireEvent.loadedData(dialog.querySelector('video')!);
      act(() => void vi.advanceTimersByTime(10_000));
      expect(dialog.querySelector('video')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a built-in offers Clone to edit, not Edit', async () => {
    mocks();
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    expect(within(dialog).getByRole('button', { name: 'Clone to edit' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Edit prompt' })).toBeNull();
  });

  it('Clone to edit saves a copy of yours with the template and previews, and opens it in edit mode', async () => {
    mocks();
    // Like the database: the saved style shows up in the next list.
    vi.mocked(ipc.saveStyle).mockImplementation(async (st) => {
      vi.mocked(ipc.listStyles).mockResolvedValue([atlas, plain, st]);
    });
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clone to edit' }));
    await waitFor(() => expect(ipc.saveStyle).toHaveBeenCalledTimes(1));
    expect(ipc.saveStyle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^mine-/),
        name: 'Atlas journey (copy)',
        source: 'mine',
        sourceUrl: null,
        notes: atlas.notes,
        prompt: atlas.prompt,
        engine: 'remotion',
        template: atlas.template,
        previewUrl: atlas.previewUrl,
        previewVideoUrl: atlas.previewVideoUrl,
        basedOn: 'atlas-journey',
      }),
    );
    const now = screen.getByRole('dialog');
    expect(await within(now).findByRole('textbox', { name: 'Style name' })).toHaveValue('Atlas journey (copy)');
    expect(within(now).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Atlas journey \(copy\)/, hidden: true })).toBeInTheDocument();
  });

  it('edit mode has Name, one textarea per aspect in order, then the prompt; saving keeps notes and drops empty aspects', async () => {
    const mine: StyleT = { ...atlas, id: 'mine-1', name: 'Mine', source: 'mine', basedOn: 'atlas-journey', notes: { camera: 'Slow', pacing: 'Fast' } };
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([mine]);
    vi.mocked(ipc.saveStyle).mockResolvedValue(undefined);
    render(<Style />);
    const dialog = await openCard('Mine');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    const names = within(dialog).getAllByRole('textbox').map((t) => t.getAttribute('aria-label') ?? dialog.querySelector(`label[for="${t.id}"]`)?.textContent);
    expect(names).toEqual(['Style name', 'Camera', 'Pacing', 'Type', 'Color', 'Captions', 'Transitions', 'Prompt your agent gets']);
    const camera = within(dialog).getByRole('textbox', { name: 'Camera' });
    await userEvent.clear(camera);
    await userEvent.type(camera, 'Orbit');
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Pacing' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Color' }), 'Teal');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.saveStyle).toHaveBeenCalled());
    const saved = vi.mocked(ipc.saveStyle).mock.calls[0]![0];
    expect(saved).toMatchObject({ id: 'mine-1', source: 'mine', basedOn: 'atlas-journey', template: atlas.template });
    expect(saved.notes).toEqual({ camera: 'Orbit', color: 'Teal' });
  });

  it('Save needs a name and a prompt', async () => {
    const mine: StyleT = { ...atlas, id: 'mine-1', name: 'Mine', source: 'mine' };
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([mine]);
    render(<Style />);
    const dialog = await openCard('Mine');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Prompt your agent gets' }));
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('a copied-from-video style has Edit directly, and unsaved aspect edits block closing; Cancel restores', async () => {
    const copied: StyleT = { id: 'c1', name: 'Zoom cut', source: 'copied', sourceUrl: null, notes: { camera: 'Punch in' }, prompt: 'Zoom.', createdAt: '2026-11-04T00:00:00Z' };
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([copied]);
    render(<Style />);
    const dialog = await openCard('Zoom cut');
    expect(within(dialog).queryByRole('button', { name: 'Clone to edit' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    const camera = within(dialog).getByRole('textbox', { name: 'Camera' });
    await userEvent.type(camera, ' more');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('You have unsaved changes. Save or cancel first')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByText('Punch in')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    expect(within(dialog).getByRole('textbox', { name: 'Camera' })).toHaveValue('Punch in');
  });

  it('Delete on a copied style deletes it and closes the dialog', async () => {
    const copied: StyleT = { id: 'c1', name: 'Zoom cut', source: 'copied', sourceUrl: 'https://youtu.be/x', notes: {}, prompt: 'Zoom.', createdAt: '2026-11-04T00:00:00Z' };
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [atlas], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas, copied]);
    vi.mocked(ipc.deleteStyle).mockResolvedValue(undefined);
    render(<Style />);
    const dialog = await openCard('Zoom cut');
    expect(within(dialog).getByText('Copied from a video · youtu.be')).toBeInTheDocument();
    expect(dialog.querySelector('video')).toBeNull();
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(ipc.deleteStyle).toHaveBeenCalledWith('c1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Delete of a style an autopilot uses is refused and says which autopilot, in the user language', async () => {
    const copied: StyleT = { id: 'c1', name: 'Zoom cut', source: 'copied', sourceUrl: null, notes: {}, prompt: 'Zoom.', createdAt: '2026-11-04T00:00:00Z' };
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [atlas], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas, copied]);
    vi.mocked(ipc.deleteStyle).mockRejectedValue(new Error('style-in-use:Kopi pagi'));
    setUiLanguage('id');
    render(<Style />);
    const dialog = await openCard('Zoom cut');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hapus' }));
    expect(await within(dialog).findByText('Gaya ini dipakai autopilot Kopi pagi. Ganti gaya autopilot itu dulu.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Delete moves focus to the neighbouring card', async () => {
    const copied: StyleT = { id: 'c1', name: 'Zoom cut', source: 'copied', sourceUrl: null, notes: {}, prompt: 'Zoom.', createdAt: '2026-11-04T00:00:00Z' };
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [atlas], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas, copied]);
    vi.mocked(ipc.deleteStyle).mockResolvedValue(undefined);
    render(<Style />);
    const dialog = await openCard('Zoom cut');
    vi.mocked(ipc.listStyles).mockResolvedValue([atlas]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Atlas journey/ })).toHaveFocus());
  });

  it('Escape and a click outside keep the dialog open while the prompt has unsaved edits, with a hint', async () => {
    const copied: StyleT = { id: 'c1', name: 'Zoom cut', source: 'copied', sourceUrl: null, notes: {}, prompt: 'Zoom.', createdAt: '2026-11-04T00:00:00Z' };
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([copied]);
    render(<Style />);
    const dialog = await openCard('Zoom cut');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    // Nothing changed yet: closing is fine elsewhere, but typing makes it dirty.
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Prompt your agent gets' }), ' More');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('You have unsaved changes. Save or cancel first')).toBeInTheDocument();
    await userEvent.click(document.querySelector('[data-slot="dialog-overlay"]')!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('You have unsaved changes. Save or cancel first')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opening Edit without changing anything still closes with Escape', async () => {
    const copied: StyleT = { id: 'c1', name: 'Zoom cut', source: 'copied', sourceUrl: null, notes: {}, prompt: 'Zoom.', createdAt: '2026-11-04T00:00:00Z' };
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue([copied]);
    render(<Style />);
    const dialog = await openCard('Zoom cut');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('turns the open and close animation off under reduced motion', async () => {
    mocks();
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    expect(dialog.className).toContain('motion-reduce:animate-none');
    expect(document.querySelector('[data-slot="dialog-overlay"]')!.className).toContain('motion-reduce:animate-none');
  });

  it('built-in styles have no Delete', async () => {
    mocks();
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('Style popup after review', () => {
  const mine: StyleT = { ...atlas, id: 'mine-1', name: 'Mine', source: 'mine', basedOn: 'atlas-journey', notes: { camera: 'Slow' } };
  /** Every list call returns fresh objects, like IPC does. */
  const freshLists = (get: () => StyleT[]) => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [], offline: false });
    vi.mocked(ipc.listStyles).mockImplementation(async () => structuredClone(get()));
  };
  const reload = () => act(() => useStudy.setState((s) => ({ savedVersion: s.savedVersion + 1 })));

  it('a reload with fresh objects does not reset a form with unsaved edits', async () => {
    freshLists(() => [mine]);
    render(<Style />);
    const dialog = await openCard('Mine');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Pacing' }), 'Quick cuts');
    await new Promise((r) => setTimeout(r, 50));
    const before = vi.mocked(ipc.listStyles).mock.calls.length;
    reload();
    await waitFor(() => expect(vi.mocked(ipc.listStyles).mock.calls.length).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 50));
    expect(within(dialog).getByRole('textbox', { name: 'Pacing' })).toHaveValue('Quick cuts');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('after Save the popup leaves edit mode even when the reload returns fresh objects', async () => {
    freshLists(() => [mine]);
    vi.mocked(ipc.saveStyle).mockResolvedValue(undefined);
    render(<Style />);
    const dialog = await openCard('Mine');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Camera' }), ' more');
    const before = vi.mocked(ipc.listStyles).mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(ipc.listStyles).mock.calls.length).toBeGreaterThan(before));
    expect(await within(dialog).findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('a clone opens in edit mode once; reopening it later shows the read-only view', async () => {
    let list: StyleT[] = [atlas];
    freshLists(() => list);
    vi.mocked(ipc.saveStyle).mockImplementation(async (st) => {
      list = [atlas, st];
    });
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clone to edit' }));
    expect(await screen.findByRole('textbox', { name: 'Style name' })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const again = await openCard('Atlas journey \\(copy\\)');
    expect(within(again).queryByRole('textbox', { name: 'Style name' })).toBeNull();
    expect(within(again).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('Clone to edit ignores a second click while the first is saving', async () => {
    freshLists(() => [atlas]);
    let done: () => void = () => {};
    vi.mocked(ipc.saveStyle).mockClear();
    vi.mocked(ipc.saveStyle).mockReturnValue(new Promise<void>((res) => (done = res)));
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    const btn = within(dialog).getByRole('button', { name: 'Clone to edit' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(ipc.saveStyle).toHaveBeenCalledTimes(1);
    expect(btn).toBeDisabled();
    await act(async () => done());
    vi.mocked(ipc.saveStyle).mockReset();
    vi.mocked(ipc.saveStyle).mockResolvedValue(undefined);
  });

  it('switching the clip while the popup is open loads the new src', async () => {
    let list: StyleT[] = [atlas];
    freshLists(() => list);
    render(<Style />);
    const dialog = await openCard('Atlas journey');
    list = [{ ...atlas, previewVideoUrl: 'https://api.tayang.app/v1/styles/atlas-journey/preview-video?v=2' }];
    reload();
    await waitFor(() => expect(dialog.querySelector('video')).toHaveAttribute('src', 'https://api.tayang.app/v1/styles/atlas-journey/preview-video?v=2'));
  });
});

describe('youtubeThumbnail', () => {
  const thumb = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  it('reads the 11-character id from every YouTube link shape', () => {
    const id = 'dQw4w9WgXcQ';
    for (const u of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&t=30s`,
      `https://m.youtube.com/watch?feature=share&v=${id}`,
      `https://youtu.be/${id}`,
      `https://youtu.be/${id}?si=abc`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
    ])
      expect(youtubeThumbnail(u), u).toBe(thumb(id));
  });
  it('gives nothing for bad ids, other sites and junk', () => {
    for (const u of [
      'https://youtu.be/short',
      'https://youtu.be/dQw4w9WgXcQextra',
      'https://www.youtube.com/watch?v=../../x',
      'https://www.youtube.com/watch?v=dQw4w9WgXc!',
      'https://www.youtube.com/watch',
      'https://www.tiktok.com/@a/video/123',
      'https://www.instagram.com/reel/abc/',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://notyoutube.com/shorts/dQw4w9WgXcQ',
      'not a url',
      '',
    ])
      expect(youtubeThumbnail(u), u).toBeNull();
  });
});

describe('Copied style previews and the empty fallback', () => {
  const copied = (over: Partial<StyleT>): StyleT => ({
    id: 'c1',
    name: 'Chibi Map Explainer',
    source: 'copied',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    notes: {},
    prompt: 'Chibi.',
    createdAt: '2026-11-04T00:00:00Z',
    ...over,
  });
  const show = (styles: StyleT[]) => {
    vi.mocked(ipc.syncStyles).mockResolvedValue({ styles: [], offline: false });
    vi.mocked(ipc.listStyles).mockResolvedValue(styles);
  };

  it('uses the YouTube thumbnail as the poster in the card and the popup, with no video', async () => {
    show([copied({})]);
    const { container } = render(<Style />);
    await screen.findByRole('button', { name: /^Chibi Map Explainer/ });
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    const dialog = await openCard('Chibi Map Explainer');
    expect(dialog.querySelector('img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(dialog.querySelector('video')).toBeNull();
  });

  it('prefers the style\'s own preview image over the thumbnail', async () => {
    show([copied({ previewUrl: 'asset://localhost/p.jpg' })]);
    const { container } = render(<Style />);
    await screen.findByRole('button', { name: /^Chibi Map Explainer/ });
    expect(container.querySelector('img')).toHaveAttribute('src', 'asset://localhost/p.jpg');
  });

  it('shows no image for TikTok sources or a bad YouTube id, just the fallback panel', async () => {
    show([copied({ sourceUrl: 'https://www.tiktok.com/@a/video/123' }), copied({ id: 'c2', name: 'Bad id', sourceUrl: 'https://youtu.be/short' })]);
    const { container } = render(<Style />);
    await screen.findByRole('button', { name: /^Bad id/ });
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByTestId('style-swatch')).toHaveLength(2);
    expect(screen.queryByText('No preview for this style')).toBeNull(); // icon only in the grid
    const dialog = await openCard('Bad id');
    expect(within(dialog).getByText('No preview for this style')).toBeInTheDocument();
    expect(dialog.querySelector('svg.lucide-film')).not.toBeNull();
    expect(within(dialog).queryByLabelText('Sampled frames')).toBeNull();
  });
});

describe('Study preview', () => {
  const good = JSON.stringify({ name: 'Zoom cut', notes: { camera: 'Punch-in' }, prompt: 'Cut on every beat' });
  const runStudy = async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    vi.mocked(ipc.readStyleResult).mockResolvedValue(good);
    vi.mocked(ipc.saveStyle).mockClear();
    vi.mocked(ipc.upsertJob).mockClear();
    vi.mocked(ipc.agentPrompt).mockClear();
    const view = render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const chatId = vi.mocked(ipc.agentPrompt).mock.calls[0]![0];
    updateHandlers.forEach((h) => h({ chatId, update: { kind: 'done', stopReason: 'end_turn' } }));
    await waitFor(() => expect(vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0].status).toBe('done'));
    return { view, chatId };
  };

  it('makes contact sheets of the source before the preview and saves them with the recipe', async () => {
    vi.mocked(ipc.makeStylePreview).mockResolvedValue(null);
    vi.mocked(ipc.makeStyleSheets).mockResolvedValue(['/data/style-refs/x/sheet-01.jpg', '/data/style-refs/x/sheet-02.jpg']);
    vi.mocked(ipc.keepStyleRefs).mockClear();
    vi.mocked(ipc.readStyleResult).mockResolvedValue(
      JSON.stringify({ name: 'Storybook', notes: { camera: 'Dolly' }, prompt: 'p', engine: 'remotion', build: 'three.js', palette: ['#112233'] }),
    );
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    vi.mocked(ipc.saveStyle).mockClear();
    vi.mocked(ipc.agentPrompt).mockClear();
    vi.mocked(ipc.upsertJob).mockClear();
    const view = render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const chatId = vi.mocked(ipc.agentPrompt).mock.calls[0]![0];
    updateHandlers.forEach((h) => h({ chatId, update: { kind: 'done', stopReason: 'end_turn' } }));
    await waitFor(() => expect(vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0].status).toBe('done'));
    const studyId = useStudy.getState().studyId!;
    expect(ipc.makeStyleSheets).toHaveBeenCalledWith(studyId, `copied-${studyId}`);
    expect(vi.mocked(ipc.makeStyleSheets).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ipc.makeStylePreview).mock.invocationCallOrder.at(-1)!);
    expect(ipc.keepStyleRefs).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.saveStyle).mock.calls.at(-1)![0]).toMatchObject({
      engine: 'remotion',
      build: 'three.js',
      palette: ['#112233'],
      references: ['/data/style-refs/x/sheet-01.jpg', '/data/style-refs/x/sheet-02.jpg'],
    });
    view.unmount();
    useStudy.getState().dismiss();
    vi.mocked(ipc.makeStyleSheets).mockResolvedValue([]);
  });

  it('a study run again saves over the same style id and keeps its creation date', async () => {
    vi.mocked(ipc.makeStylePreview).mockResolvedValue(null);
    vi.mocked(ipc.readStyleResult).mockResolvedValue(good);
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    vi.mocked(ipc.listStyles).mockResolvedValue([{ ...plain, id: 'copied-old', source: 'copied', createdAt: '2026-11-01T00:00:00Z' }]);
    vi.mocked(ipc.saveStyle).mockClear();
    vi.mocked(ipc.agentPrompt).mockClear();
    vi.mocked(ipc.upsertJob).mockClear();
    await useStudy.getState().start('https://youtu.be/abc', 'claude', undefined, 'copied-old');
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const chatId = vi.mocked(ipc.agentPrompt).mock.calls[0]![0];
    updateHandlers.forEach((h) => h({ chatId, update: { kind: 'done', stopReason: 'end_turn' } }));
    await waitFor(() => expect(ipc.saveStyle).toHaveBeenCalled());
    expect(vi.mocked(ipc.saveStyle).mock.calls[0]![0]).toMatchObject({ id: 'copied-old', createdAt: '2026-11-01T00:00:00Z' });
    await waitFor(() => expect(vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0].status).toBe('done'));
    useStudy.getState().dismiss();
  });

  it('makes the preview after saving and re-saves the style with the asset URLs', async () => {
    vi.mocked(ipc.makeStylePreview).mockResolvedValue({ previewPath: '/data/style-media/x/preview.mp4', posterPath: '/data/style-media/x/poster.jpg' });
    const { view } = await runStudy();
    const studyId = useStudy.getState().studyId!;
    expect(ipc.makeStylePreview).toHaveBeenCalledWith(studyId, `copied-${studyId}`);
    expect(ipc.saveStyle).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.saveStyle).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ipc.makeStylePreview).mock.invocationCallOrder[0]!);
    expect(vi.mocked(ipc.saveStyle).mock.calls[1]![0]).toMatchObject({
      id: `copied-${studyId}`,
      previewUrl: 'asset://localhost//data/style-media/x/poster.jpg',
      previewVideoUrl: 'asset://localhost//data/style-media/x/preview.mp4',
    });
    view.unmount();
    useStudy.getState().dismiss();
  });

  it('keeps only the poster when the clip was too big', async () => {
    vi.mocked(ipc.makeStylePreview).mockResolvedValue({ previewPath: null, posterPath: '/d/poster.jpg' });
    const { view } = await runStudy();
    expect(vi.mocked(ipc.saveStyle).mock.calls[1]![0]).toMatchObject({ previewUrl: 'asset://localhost//d/poster.jpg' });
    expect(vi.mocked(ipc.saveStyle).mock.calls[1]![0].previewVideoUrl).toBeFalsy();
    view.unmount();
    useStudy.getState().dismiss();
  });

  it('removes the study folder after the preview step when the study succeeds', async () => {
    vi.mocked(ipc.removeStudyDir).mockClear();
    vi.mocked(ipc.makeStylePreview).mockResolvedValue(null);
    const { view } = await runStudy();
    const studyId = useStudy.getState().studyId!;
    await waitFor(() => expect(ipc.removeStudyDir).toHaveBeenCalledWith(studyId));
    expect(vi.mocked(ipc.makeStylePreview).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ipc.removeStudyDir).mock.invocationCallOrder[0]!);
    view.unmount();
    useStudy.getState().dismiss();
  });

  it('removes the study folder after the agent has stopped when the result is unreadable, the save fails, or it is cancelled', async () => {
    const cases: [string, () => Promise<void>][] = [
      ['unreadable', async () => void vi.mocked(ipc.readStyleResult).mockResolvedValue('not json')],
      ['save fails', async () => void vi.mocked(ipc.saveStyle).mockRejectedValueOnce(new Error('disk full'))],
    ];
    for (const [why, arrange] of cases) {
      vi.mocked(ipc.removeStudyDir).mockClear();
      vi.mocked(ipc.agentStop).mockClear();
      vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
      vi.mocked(ipc.readStyleResult).mockResolvedValue(good);
      vi.mocked(ipc.agentPrompt).mockClear();
      await arrange();
      const view = render(<Style />);
      await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
      await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
      await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
      const chatId = vi.mocked(ipc.agentPrompt).mock.calls[0]![0];
      updateHandlers.forEach((h) => h({ chatId, update: { kind: 'done', stopReason: 'end_turn' } }));
      await waitFor(() => expect(useStudy.getState().phase).toBe('failed'));
      const studyId = useStudy.getState().studyId!;
      await waitFor(() => expect(ipc.removeStudyDir).toHaveBeenCalledWith(studyId), { timeout: 2000 });
      expect(vi.mocked(ipc.agentStop).mock.invocationCallOrder[0], why).toBeLessThan(vi.mocked(ipc.removeStudyDir).mock.invocationCallOrder[0]!);
      view.unmount();
      useStudy.getState().dismiss();
    }
    // Cancel
    vi.mocked(ipc.removeStudyDir).mockClear();
    vi.mocked(ipc.agentPrompt).mockClear();
    vi.mocked(ipc.agentCancel).mockResolvedValue();
    const view = render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const studyId = useStudy.getState().studyId!;
    await waitFor(() => expect(ipc.removeStudyDir).toHaveBeenCalledWith(studyId));
    view.unmount();
    useStudy.getState().dismiss();
  });

  it('while the preview is made: no Cancel, late errors and cancels ignored, no second study, and a stale finish cannot touch a newer study', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    vi.mocked(ipc.readStyleResult).mockResolvedValue(good);
    vi.mocked(ipc.agentPrompt).mockClear();
    vi.mocked(ipc.agentCancel).mockClear();
    let release: (v: null) => void = () => {};
    vi.mocked(ipc.makeStylePreview).mockReturnValueOnce(new Promise((res) => (release = res)));
    const view = render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const chatId = vi.mocked(ipc.agentPrompt).mock.calls[0]![0];
    updateHandlers.forEach((h) => h({ chatId, update: { kind: 'done', stopReason: 'end_turn' } }));
    await waitFor(() => expect(useStudy.getState().phase).toBe('finishing'));
    expect(screen.getByText('Making a preview')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await act(async () => useStudy.getState().cancel());
    expect(ipc.agentCancel).not.toHaveBeenCalled();
    act(() => updateHandlers.forEach((h) => h({ chatId, update: { kind: 'error', message: 'late' } })));
    expect(useStudy.getState().phase).toBe('finishing');
    await act(async () => useStudy.getState().start('https://youtu.be/zzz', 'claude'));
    expect(useStudy.getState().url).toBe('https://youtu.be/abc');
    expect(screen.getByRole('button', { name: 'Study video' })).toBeDisabled();

    // The study is dismissed and a new one starts before the old preview returns.
    act(() => useStudy.getState().dismiss());
    vi.mocked(ipc.upsertJob).mockClear();
    await act(async () => useStudy.getState().start('https://youtu.be/new', 'claude'));
    const newId = useStudy.getState().studyId;
    await act(async () => release(null));
    await new Promise((r) => setTimeout(r, 50));
    expect(useStudy.getState().studyId).toBe(newId);
    expect(useStudy.getState().phase).toBe('running');
    expect(vi.mocked(ipc.upsertJob).mock.calls.every(([j]) => j.status === 'working')).toBe(true);
    view.unmount();
    useStudy.getState().dismiss();
  });

  it('Cancel while the agent is still starting stops it once it is up, never prompts it, and keeps the job failed', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    vi.mocked(ipc.agentPrompt).mockClear();
    vi.mocked(ipc.agentStop).mockClear();
    vi.mocked(ipc.removeStudyDir).mockClear();
    vi.mocked(ipc.upsertJob).mockClear();
    vi.mocked(ipc.agentCancel).mockResolvedValue();
    let up: (v: boolean) => void = () => {};
    vi.mocked(ipc.agentStart).mockReturnValueOnce(new Promise((res) => (up = res)));
    const view = render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(useStudy.getState().phase).toBe('failed'));
    const stopsBefore = vi.mocked(ipc.agentStop).mock.calls.length;
    await act(async () => up(false));
    await waitFor(() => expect(vi.mocked(ipc.agentStop).mock.calls.length).toBeGreaterThan(stopsBefore));
    expect(ipc.agentPrompt).not.toHaveBeenCalled();
    expect(ipc.removeStudyDir).toHaveBeenCalledTimes(2); // after the cancel, and again once the agent was stopped
    const jobs = vi.mocked(ipc.upsertJob).mock.calls.map(([j]) => j.status);
    expect(jobs.at(-1)).toBe('failed');
    view.unmount();
    useStudy.getState().dismiss();
  });

  it('a study that fails right before a new one starts still gets its job written as failed', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    vi.mocked(ipc.agentPrompt).mockClear();
    vi.mocked(ipc.upsertJob).mockClear();
    vi.mocked(ipc.agentCancel).mockResolvedValue();
    let stopped: () => void = () => {};
    vi.mocked(ipc.agentStop).mockReturnValueOnce(new Promise((res) => (stopped = () => res(undefined))));
    const view = render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const oldId = useStudy.getState().studyId!;
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(useStudy.getState().phase).toBe('failed'));
    // The old agent is still being stopped; the user starts another study.
    await act(async () => useStudy.getState().start('https://youtu.be/new', 'claude'));
    const newId = useStudy.getState().studyId!;
    await act(async () => stopped());
    await waitFor(() =>
      expect(vi.mocked(ipc.upsertJob).mock.calls.some(([j]) => j.id === `study-${oldId}` && j.status === 'failed')).toBe(true),
    );
    expect(useStudy.getState().studyId).toBe(newId);
    expect(useStudy.getState().phase).toBe('running');
    view.unmount();
    useStudy.getState().dismiss();
  });

  it('a failing or empty preview never fails the study', async () => {
    for (const result of [() => Promise.reject(new Error('ffmpeg missing')), () => Promise.resolve(null)]) {
      vi.mocked(ipc.makeStylePreview).mockImplementation(result);
      const { view } = await runStudy();
      expect(useStudy.getState().phase).toBe('done');
      expect(ipc.saveStyle).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ipc.saveStyle).mock.calls[0]![0]).toMatchObject({ name: 'Zoom cut', source: 'copied' });
      view.unmount();
      useStudy.getState().dismiss();
    }
  });
});

describe('Style study cancel', () => {
  it('cancels a running study and marks its job failed "Cancelled"', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    vi.mocked(ipc.agentCancel).mockResolvedValue();
    render(<Style />);
    await userEvent.type(screen.getByLabelText('Video link'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Study video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const chatId = vi.mocked(ipc.agentPrompt).mock.calls[0]![0];
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ipc.agentCancel).toHaveBeenCalledWith(chatId);
    await waitFor(() => expect(vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0]).toMatchObject({ status: 'failed', note: 'Cancelled' }));
    expect(ipc.agentStop).toHaveBeenCalledWith(chatId);
  });
});

describe('Agents working indicator', () => {
  const job = (id: string, status: Job['status']): Job => ({
    id,
    kind: 'build',
    title: `Job ${id}`,
    projectId: null,
    chatId: 'c1',
    agentId: 'claude',
    status,
    progress: null,
    note: null,
    sourceUrl: null,
    updatedAt: new Date().toISOString(),
  });

  it('shows an animated bar and "working ·" only on working cards', async () => {
    vi.mocked(ipc.listJobs).mockResolvedValue([job('w', 'working'), job('q', 'queued'), job('d', 'done')]);
    render(<Agents />);
    const working = await screen.findByRole('region', { name: 'Working' });
    expect(within(working).getByRole('progressbar', { name: 'Working' })).toBeInTheDocument();
    expect(within(working).getByText(/^working · /)).toBeInTheDocument();
    for (const name of ['Queued', 'Done']) {
      const col = screen.getByRole('region', { name });
      expect(within(col).queryByRole('progressbar')).not.toBeInTheDocument();
      expect(within(col).queryByText(/working ·/)).not.toBeInTheDocument();
    }
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });
});

describe('Failed job recovery', () => {
  const failed = (over: Partial<Job>): Job => ({
    id: 'study-s1',
    kind: 'study-style',
    title: 'Study a video for a new style',
    projectId: null,
    chatId: 'study-s1',
    agentId: 'claude',
    status: 'failed',
    progress: null,
    note: 'Tayang was closed while this was running',
    sourceUrl: 'https://youtu.be/abc',
    updatedAt: '2026-11-04T00:00:00Z',
    ...over,
  });

  it('Try again restarts the study with the job link and agent, then deletes the old job and opens Style', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    vi.mocked(ipc.listJobs).mockResolvedValue([failed({ agentId: 'gemini' })]);
    useApp.setState({ route: { name: 'agents' } });
    render(<Agents />);
    const col = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(col).queryByRole('button', { name: 'Fix it' })).not.toBeInTheDocument();
    expect(within(col).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    await userEvent.click(within(col).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(ipc.deleteJob).toHaveBeenCalledWith('study-s1'));
    expect(vi.mocked(ipc.agentStart).mock.calls[0]).toEqual([expect.stringMatching(/^study-/), 'gemini', true]);
    expect(JSON.stringify(vi.mocked(ipc.agentPrompt).mock.calls[0]![1])).toContain('https://youtu.be/abc');
    // The new job is written before the old one goes away.
    const writeOrder = vi.mocked(ipc.upsertJob).mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(vi.mocked(ipc.deleteJob).mock.invocationCallOrder[0]!);
    expect(useApp.getState().route).toEqual({ name: 'style' });
  });

  it('Try again opens Style straight away, before the agent has started', async () => {
    vi.mocked(ipc.studyDir).mockReturnValue(new Promise(() => {}));
    vi.mocked(ipc.listJobs).mockResolvedValue([failed({})]);
    useApp.setState({ route: { name: 'agents' } });
    render(<Agents />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(useApp.getState().route).toEqual({ name: 'style' });
    expect(useStudy.getState().phase).toBe('running');
  });

  it('the board shows the new working card and drops the old failed one after Try again', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    const fresh: Job = failed({ id: 'study-new', status: 'working', note: null });
    vi.mocked(ipc.listJobs).mockResolvedValueOnce([failed({})]).mockResolvedValue([fresh]);
    useApp.setState({ route: { name: 'agents' } });
    render(<Agents />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    const working = await screen.findByRole('region', { name: 'Working' });
    expect(await within(working).findByRole('progressbar', { name: 'Working' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument());
  });

  it('keeps the old job when the new one could not be written', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    vi.mocked(ipc.upsertJob).mockRejectedValue(new Error('disk full'));
    vi.mocked(ipc.listJobs).mockResolvedValue([failed({})]);
    render(<Agents />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(ipc.deleteJob).not.toHaveBeenCalled();
    vi.mocked(ipc.upsertJob).mockResolvedValue(undefined);
  });

  it('deletes the old job once the new failed job is written, so there is one failed card', async () => {
    vi.mocked(ipc.studyDir).mockRejectedValue(new Error('no folder'));
    vi.mocked(ipc.listJobs).mockResolvedValue([failed({})]);
    render(<Agents />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(ipc.deleteJob).toHaveBeenCalledWith('study-s1'));
    const last = vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0];
    expect(last.status).toBe('failed');
    expect(vi.mocked(ipc.upsertJob).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(ipc.deleteJob).mock.invocationCallOrder[0]!,
    );
  });

  it('Try again is disabled while another study is running', async () => {
    vi.mocked(ipc.listJobs).mockResolvedValue([failed({})]);
    useStudy.setState({ phase: 'running' });
    render(<Agents />);
    const btn = await screen.findByRole('button', { name: 'Try again' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Another study is running');
    useStudy.getState().dismiss();
  });

  it('a failed study without a saved link opens Style with the link input focused', async () => {
    vi.mocked(ipc.listJobs).mockResolvedValue([failed({ sourceUrl: null })]);
    useApp.setState({ route: { name: 'agents' } });
    render(<Agents />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(useApp.getState().route).toEqual({ name: 'style', focusLink: true });
    expect(ipc.agentStart).not.toHaveBeenCalled();
    cleanup();
    render(<Style />);
    expect(screen.getByLabelText('Video link')).toHaveValue('');
    expect(screen.getByLabelText('Video link')).toHaveFocus();
  });

  it('Dismiss deletes the job and removes the card', async () => {
    vi.mocked(ipc.listJobs).mockResolvedValueOnce([failed({})]).mockResolvedValue([]);
    render(<Agents />);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(ipc.deleteJob).toHaveBeenCalledWith('study-s1');
    await waitFor(() => expect(screen.queryByText('Study a video for a new style')).not.toBeInTheDocument());
  });

  it('Dismiss is Abaikan in Indonesian, not Tutup', async () => {
    setUiLanguage('id');
    vi.mocked(ipc.listJobs).mockResolvedValueOnce([failed({})]).mockResolvedValue([]);
    render(<Agents />);
    await userEvent.click(await screen.findByRole('button', { name: 'Abaikan' }));
    expect(ipc.deleteJob).toHaveBeenCalledWith('study-s1');
    expect(screen.queryByRole('button', { name: 'Tutup' })).not.toBeInTheDocument();
  });

  it('Fix it on a chat job opens the chat with the closed-app draft, only for the closed note', async () => {
    const chatJob = failed({ id: 'build-c1', kind: 'build', title: 'Build', chatId: 'c1', sourceUrl: null });
    vi.mocked(ipc.listJobs).mockResolvedValue([chatJob]);
    const { unmount } = render(<Agents />);
    await userEvent.click(await screen.findByRole('button', { name: 'Fix it' }));
    expect(useApp.getState().route).toEqual({
      name: 'chat',
      chatId: 'c1',
      draft: "Tayang was closed while you were working on this. Check what's already done and continue.",
    });
    unmount();
    vi.mocked(ipc.listJobs).mockResolvedValue([{ ...chatJob, note: 'Render crashed' }]);
    render(<Agents />);
    await userEvent.click(await screen.findByRole('button', { name: 'Fix it' }));
    expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'c1' });
  });
});

describe('Agents', () => {
  it('puts a failed job in Needs you with Fix it', async () => {
    const failed: Job = {
      id: 'j1',
      kind: 'render',
      title: 'Render failed',
      projectId: 'p1',
      chatId: 'c1',
      agentId: 'claude',
      status: 'failed',
      progress: null,
      note: 'A font is missing',
      sourceUrl: null,
      updatedAt: '2026-11-04T00:00:00Z',
    };
    vi.mocked(ipc.listJobs).mockResolvedValue([failed]);
    render(<Agents />);
    const col = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(col).getByText('Render failed')).toBeInTheDocument();
    expect(within(col).getByRole('button', { name: 'Fix it' })).toBeInTheDocument();
    await waitFor(() => expect(useApp.getState().needsYouCount).toBe(1));
  });
});

describe('Calendar', () => {
  it('asks for ideas in a scratch chat, shows its permission card and stops the agent after', async () => {
    useChat.getState().reset();
    vi.mocked(ipc.agentStart).mockResolvedValue(false);
    vi.mocked(ipc.agentPrompt).mockResolvedValue();
    vi.mocked(ipc.agentRespondPermission).mockResolvedValue();
    render(<Calendar today={new Date(2026, 10, 4)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Get ideas' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(ipc.createChat).not.toHaveBeenCalled();
    expect(ipc.agentStart).toHaveBeenCalledWith('ideas-2026-11-02', 'claude');
    await act(async () =>
      permHandlers.forEach((h) =>
        h({
          chatId: 'ideas-2026-11-02',
          requestId: 'r1',
          title: 'Read trends',
          commands: ['curl trends'],
          options: [{ id: 'once', label: 'Allow', kind: 'allow-once' }],
        }),
      ),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(ipc.agentRespondPermission).toHaveBeenCalledWith('r1', 'once');
    await act(async () => {
      updateHandlers.forEach((h) =>
        h({
          chatId: 'ideas-2026-11-02',
          update: { kind: 'text', text: '```json\n[{"title":"Ide","kind":"promo","lengthSec":20}]\n```' },
        }),
      );
      updateHandlers.forEach((h) => h({ chatId: 'ideas-2026-11-02', update: { kind: 'done', stopReason: 'end_turn' } }));
    });
    expect(await screen.findByText('Ide')).toBeInTheDocument();
    await waitFor(() => expect(ipc.agentStop).toHaveBeenCalledWith('ideas-2026-11-02'));
    expect(ipc.addMessage).not.toHaveBeenCalled();
  });

  it('renders 42 cells starting on Monday Oct 26 for November 2026', () => {
    render(<Calendar today={new Date(2026, 10, 4)} />);
    const cells = screen.getAllByTestId('cal-cell');
    expect(cells).toHaveLength(42);
    expect(cells[0]).toHaveAttribute('data-date', '2026-10-26');
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
  });
});

describe('Calendar scheduling', () => {
  it('explains missing reminders only when notifications were denied, in both languages', async () => {
    const { unmount } = render(<Calendar today={today} />);
    await screen.findByRole('button', { name: 'Schedule a video' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    useApp.setState({ notificationsBlocked: true });
    expect(await screen.findByText(/Reminders can't show because notifications are off/)).toBeInTheDocument();
    unmount();
    setUiLanguage('id');
    render(<Calendar today={today} />);
    expect(await screen.findByText(/Pengingat tidak bisa muncul karena notifikasi/)).toBeInTheDocument();
    useApp.setState({ notificationsBlocked: false });
  });

  const at = (h: number, m = 0) => new Date(2026, 10, 12, h, m).toISOString();
  const today = new Date(2026, 10, 4);
  // The dialog's default slot and past check read the clock: 4 Nov 2026, 10:00 here.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 4, 10, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('shows each entry with its time and a state chip, in Indonesian too', async () => {
    vi.mocked(ipc.listProjects).mockResolvedValue([
      project('a', 'Alpha', 'rendered', at(9, 30)),
      project('b', 'Beta', 'rendered', at(10), { reviewState: 'pending' }),
      project('c', 'Gamma', 'building', at(11)),
      project('d', 'Delta', 'rendered', at(12), { postedAt: '2026-11-12T05:00:00Z' }),
      project('e', 'Epsilon', 'draft', at(13)),
    ]);
    render(<Calendar today={today} />);
    const cell = (await screen.findByText('Alpha')).closest('[data-testid="cal-cell"]') as HTMLElement;
    expect(cell).toHaveAttribute('data-date', '2026-11-12');
    expect(within(cell).getByRole('button', { name: 'Alpha, Ready, 09:30' })).toBeInTheDocument();
    expect(within(cell).getByRole('button', { name: 'Beta, Needs review, 10:00' })).toBeInTheDocument();
    expect(within(cell).getByRole('button', { name: 'Gamma, Making, 11:00' })).toBeInTheDocument();
    expect(within(cell).getByRole('button', { name: 'Delta, Posted, 12:00' })).toBeInTheDocument();
    expect(within(cell).getByRole('button', { name: 'Epsilon, Draft, 13:00' })).toBeInTheDocument();
    cleanup();
    setUiLanguage('id');
    try {
      render(<Calendar today={today} />);
      expect(await screen.findByRole('button', { name: 'Beta, Perlu ditinjau, 10:00' })).toBeInTheDocument();
    } finally {
      setUiLanguage('en');
    }
  });

  it('the popover calls the right IPC for approve and mark as posted', async () => {
    const p = project('a', 'Alpha', 'rendered', at(9), { reviewState: 'pending' });
    vi.mocked(ipc.listProjects).mockResolvedValue([p]);
    vi.mocked(ipc.approveProject).mockResolvedValue({ ...p, reviewState: 'approved' });
    vi.mocked(ipc.setPosted).mockResolvedValue({ ...p, reviewState: 'approved', postedAt: '2026-11-12T02:00:00Z' });
    render(<Calendar today={today} />);
    await userEvent.click(await screen.findByRole('button', { name: /^Alpha,/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(ipc.approveProject).toHaveBeenCalledWith('a');
    await userEvent.click(await screen.findByRole('button', { name: 'Alpha, Ready, 09:00' }));
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark as posted' }));
    expect(ipc.setPosted).toHaveBeenCalledWith('a', true);
    await userEvent.click(await screen.findByRole('button', { name: 'Alpha, Posted, 09:00' }));
    expect(screen.getByRole('button', { name: 'Not posted' })).toBeInTheDocument();
  });

  it('Remove from calendar takes the video off the calendar in one click', async () => {
    const p = project('a', 'Alpha', 'draft', at(9));
    vi.mocked(ipc.listProjects).mockResolvedValue([p]);
    vi.mocked(ipc.setSchedule).mockResolvedValue({ ...p, scheduledAt: null });
    render(<Calendar today={today} />);
    await userEvent.click(await screen.findByRole('button', { name: /^Alpha,/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove from calendar' }));
    expect(ipc.setSchedule).toHaveBeenCalledWith('a', null);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Alpha,/ })).not.toBeInTheDocument());
  });

  it('Open video opens the project chat', async () => {
    const p = project('a', 'Alpha', 'rendered', at(9));
    vi.mocked(ipc.listProjects).mockResolvedValue([p]);
    vi.mocked(ipc.listChats).mockResolvedValue([{ id: 'c1', projectId: 'a', agentId: 'claude', title: 'Alpha', createdAt: '' }]);
    render(<Calendar today={today} />);
    await userEvent.click(await screen.findByRole('button', { name: /^Alpha,/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open video' }));
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'c1' }));
  });

  it('Schedule… from the popover sets a local time and Clear removes it', async () => {
    const p = project('a', 'Alpha', 'rendered', at(9));
    vi.mocked(ipc.listProjects).mockResolvedValue([p]);
    vi.mocked(ipc.setSchedule).mockImplementation(async (_id, when) => ({ ...p, scheduledAt: when }));
    render(<Calendar today={today} />);
    await userEvent.click(await screen.findByRole('button', { name: /^Alpha,/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-11-12');
    expect(within(dialog).getByLabelText('Time')).toHaveValue('09:00');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-11-20' } });
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '18:45' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.setSchedule).toHaveBeenCalledWith('a', new Date(2026, 10, 20, 18, 45).toISOString()));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole('button', { name: 'Alpha, Ready, 18:45' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule…' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Clear schedule' }));
    await waitFor(() => expect(ipc.setSchedule).toHaveBeenLastCalledWith('a', null));
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('the Calendar entry schedules an unscheduled video after choosing it', async () => {
    const p = project('u', 'Unplanned', 'rendered');
    vi.mocked(ipc.listProjects).mockResolvedValue([p, project('s', 'Planned', 'rendered', at(9))]);
    vi.mocked(ipc.setSchedule).mockImplementation(async (_id, when) => ({ ...p, scheduledAt: when }));
    render(<Calendar today={today} />);
    await screen.findByText('Planned');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule a video' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(within(dialog).queryByRole('option', { name: 'Planned' })).not.toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText('Video'), 'u');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-11-06' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.setSchedule).toHaveBeenCalledWith('u', new Date(2026, 10, 6, 19, 0).toISOString()));
  });

  it("the Calendar entry starts at today 19:00 and won't save a time that has passed", async () => {
    vi.mocked(ipc.listProjects).mockResolvedValue([project('u', 'Unplanned', 'rendered')]);
    render(<Calendar today={today} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule a video' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-11-04');
    expect(within(dialog).getByLabelText('Time')).toHaveValue('19:00');
    await userEvent.selectOptions(within(dialog).getByLabelText('Video'), 'u');
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '08:00' } });
    expect(within(dialog).getByText('That time has already passed. Pick a later one')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '10:30' } });
    expect(within(dialog).queryByText(/already passed/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('dragging an entry to another day keeps its time', async () => {
    const p = project('a', 'Alpha', 'rendered', at(9, 30));
    vi.mocked(ipc.listProjects).mockResolvedValue([p]);
    vi.mocked(ipc.setSchedule).mockImplementation(async (_id, when) => ({ ...p, scheduledAt: when }));
    render(<Calendar today={today} />);
    const entry = await screen.findByRole('button', { name: /^Alpha,/ });
    const target = screen.getAllByTestId('cal-cell').find((c) => c.getAttribute('data-date') === '2026-11-17')!;
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' };
    fireEvent.dragStart(entry, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(ipc.setSchedule).toHaveBeenCalledWith('a', new Date(2026, 10, 17, 9, 30).toISOString()));
    await waitFor(() => expect(within(target).getByText('Alpha')).toBeInTheDocument());
    // Dropping on the same day does nothing.
    vi.mocked(ipc.setSchedule).mockClear();
    const entry2 = within(target).getByRole('button', { name: /^Alpha,/ });
    fireEvent.dragStart(entry2, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(ipc.setSchedule).not.toHaveBeenCalled();
  });

  it('keeps the typed date when a video is picked', async () => {
    vi.mocked(ipc.listProjects).mockResolvedValue([project('u', 'Unplanned', 'rendered')]);
    render(<Calendar today={today} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule a video' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-11-20' } });
    await userEvent.selectOptions(within(dialog).getByLabelText('Video'), 'u');
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-11-20');
  });

  it('ignores a drop when no entry is being dragged, and after dragend', async () => {
    const p = project('a', 'Alpha', 'rendered', at(9, 30));
    vi.mocked(ipc.listProjects).mockResolvedValue([p]);
    vi.mocked(ipc.setSchedule).mockImplementation(async (_id, when) => ({ ...p, scheduledAt: when }));
    render(<Calendar today={today} />);
    const entry = await screen.findByRole('button', { name: /^Alpha,/ });
    const target = screen.getAllByTestId('cal-cell').find((c) => c.getAttribute('data-date') === '2026-11-17')!;
    const stray = { getData: () => 'a' };
    fireEvent.drop(target, { dataTransfer: stray });
    expect(ipc.setSchedule).not.toHaveBeenCalled();
    const dataTransfer = { setData: () => {}, getData: () => '' };
    fireEvent.dragStart(entry, { dataTransfer });
    fireEvent.dragEnd(entry, { dataTransfer });
    fireEvent.drop(target, { dataTransfer: stray });
    expect(ipc.setSchedule).not.toHaveBeenCalled();
    // A drop carrying a different id than the current drag is ignored too.
    fireEvent.dragStart(entry, { dataTransfer });
    fireEvent.drop(target, { dataTransfer: { getData: () => 'other' } });
    expect(ipc.setSchedule).not.toHaveBeenCalled();
  });

  it('shows a failed update under the month header', async () => {
    const p = project('a', 'Alpha', 'rendered', at(9));
    vi.mocked(ipc.listProjects).mockResolvedValue([p]);
    vi.mocked(ipc.setPosted).mockRejectedValue(new Error('x'));
    render(<Calendar today={today} />);
    await userEvent.click(await screen.findByRole('button', { name: /^Alpha,/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as posted' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't update the video");
    expect(alert.closest('aside')).toBeNull();
  });

  it('no longer claims Tayang reminds you', async () => {
    render(<Calendar today={today} />);
    expect(screen.queryByText(/reminds you/i)).not.toBeInTheDocument();
  });
});

describe('Videos schedule action', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 4, 10, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('the Scheduled tab lists scheduled, unposted videos', async () => {
    vi.mocked(ipc.listProjects).mockResolvedValue([
      project('a', 'Alpha', 'rendered', '2026-11-12T02:00:00Z'),
      project('b', 'Beta', 'rendered', '2026-11-12T02:00:00Z', { postedAt: '2026-11-12T03:00:00Z' }),
      project('c', 'Gamma', 'rendered'),
    ]);
    render(<Videos />);
    await userEvent.click(await screen.findByRole('tab', { name: /Scheduled/ }));
    expect(screen.getByRole('button', { name: 'Schedule Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule Beta' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule Gamma' })).not.toBeInTheDocument();
  });

  it('opens the dialog for that card and saves', async () => {
    const p = project('a', 'Alpha', 'rendered');
    vi.mocked(ipc.listProjects).mockResolvedValue([p]);
    vi.mocked(ipc.setSchedule).mockImplementation(async (_id, when) => ({ ...p, scheduledAt: when }));
    render(<Videos />);
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule Alpha' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Clear schedule' })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-12-01' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.setSchedule).toHaveBeenCalledWith('a', new Date(2026, 11, 1, 19, 0).toISOString()));
  });

  it('starts at tomorrow 19:00 from 18:00 on, and at the video\'s own time when it has one', async () => {
    vi.setSystemTime(new Date(2026, 10, 4, 18, 0));
    const p = project('a', 'Alpha', 'rendered');
    vi.mocked(ipc.listProjects).mockResolvedValue([p, project('b', 'Beta', 'rendered', new Date(2026, 10, 9, 7, 15).toISOString())]);
    render(<Videos />);
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule Alpha' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-11-05');
    expect(within(dialog).getByLabelText('Time')).toHaveValue('19:00');
    expect(within(dialog).queryByText(/already passed/)).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole('tab', { name: /Scheduled/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule Beta' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-11-09');
    expect(within(dialog).getByLabelText('Time')).toHaveValue('07:15');
  });

  it('blocks saving a past date, in Indonesian too', async () => {
    setUiLanguage('id');
    vi.mocked(ipc.listProjects).mockResolvedValue([project('a', 'Alpha', 'rendered')]);
    render(<Videos />);
    await userEvent.click(await screen.findByRole('button', { name: 'Jadwalkan Alpha' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Tanggal'), { target: { value: '2026-11-03' } });
    expect(within(dialog).getByText('Waktu itu sudah lewat. Pilih waktu yang lebih nanti')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Simpan' })).toBeDisabled();
    expect(ipc.setSchedule).not.toHaveBeenCalled();
  });
});

/** Settings shows one tab at a time: open the one a test is about. */
const openSettingsTab = (tab: string) => useApp.setState({ route: { name: 'settings', tab } });

describe('Settings', () => {
  it('shows one tab at a time and remembers the last one', async () => {
    localStorage.clear();
    useApp.setState({ route: { name: 'settings' } });
    const { unmount } = render(<SettingsScreen />);
    expect(await screen.findByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('switch', { name: 'Keep Tayang running in the background' })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(await screen.findByRole('switch', { name: 'Keep Tayang running in the background' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'General' })).toBeNull();
    unmount();
    render(<SettingsScreen />);
    expect(await screen.findByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
    localStorage.clear();
  });

  it("How to install opens the agent's own install guide, not onboarding", async () => {
    vi.mocked(ipc.detectAgents).mockResolvedValue([
      { id: 'antigravity', name: 'Antigravity CLI', installed: false, version: null, acpCommand: ['agy', 'acp'], recommended: false },
    ] as never);
    openSettingsTab('agents');
    render(<SettingsScreen />);
    const link = await screen.findByRole('link', { name: 'How to install' });
    expect(link).toHaveAttribute('href', 'https://antigravity.google/docs/getting-started?tab=cli');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('keeps the API address under Advanced, closed while it is the default', async () => {
    openSettingsTab('account');
    render(<SettingsScreen />);
    const advanced = (await screen.findByText('Advanced')).closest('details')!;
    expect(advanced).not.toHaveAttribute('open');
    expect(within(advanced).getByLabelText('API address')).toBeInTheDocument();
  });

  it('background mode saves through updateSettings; open at login is disabled until it is on', async () => {
    openSettingsTab('agents');
    render(<SettingsScreen />);
    expect(await screen.findByRole('switch', { name: 'Open at login' })).toBeDisabled();
    const bg = screen.getByRole('switch', { name: 'Keep Tayang running in the background' });
    expect(bg).not.toBeChecked();
    await userEvent.click(bg);
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ backgroundMode: true }));
  });

  it('says so, in the user language, when there is no system tray for background mode, and shows it off', async () => {
    vi.mocked(ipc.updateSettings).mockRejectedValueOnce(new Error('tray-unavailable'));
    vi.mocked(ipc.getSettings).mockResolvedValue({ ...settings, backgroundMode: false });
    openSettingsTab('agents');
    render(<SettingsScreen />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Keep Tayang running in the background' }));
    expect(await screen.findByText("Background mode needs a system tray, which isn't available here")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
    expect(screen.getByRole('switch', { name: 'Keep Tayang running in the background' })).not.toBeChecked();
    expect(ipc.getSettings).toHaveBeenCalled();
  });

  it('the test notification button sends one and explains what to check; a denial or error is said too', async () => {
    vi.mocked(sendTestNotification).mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('no toast'));
    openSettingsTab('agents');
    render(<SettingsScreen />);
    const btn = await screen.findByRole('button', { name: 'Send a test notification' });
    await userEvent.click(btn);
    expect(await screen.findByText(/Test notification sent\. If you don't see it/)).toBeInTheDocument();
    await userEvent.click(btn);
    expect(await screen.findByText(/Reminders can't show/)).toBeInTheDocument();
    await userEvent.click(btn);
    expect(await screen.findByText("Couldn't send it: no toast")).toBeInTheDocument();
  });

  it('the test notification button is in Indonesian too', async () => {
    setUiLanguage('id');
    openSettingsTab('agents');
    render(<SettingsScreen />);
    expect(await screen.findByRole('button', { name: 'Kirim notifikasi percobaan' })).toBeInTheDocument();
  });

  it('open at login enables the OS login item, then saves', async () => {
    useApp.setState({ settings: { ...settings, backgroundMode: true } });
    openSettingsTab('agents');
    render(<SettingsScreen />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Open at login' }));
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ openAtLogin: true }));
    expect(autostart.enable).toHaveBeenCalledTimes(1);
  });

  it('shows an error and keeps the setting when the OS login item fails', async () => {
    vi.mocked(autostart.enable).mockRejectedValueOnce(new Error('denied by the system'));
    useApp.setState({ settings: { ...settings, backgroundMode: true } });
    openSettingsTab('agents');
    render(<SettingsScreen />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Open at login' }));
    expect(await screen.findByText(/Couldn't change that: denied by the system/)).toBeInTheDocument();
    expect(ipc.updateSettings).not.toHaveBeenCalled();
  });

  it('turning the background off also turns off open at login', async () => {
    useApp.setState({ settings: { ...settings, backgroundMode: true, openAtLogin: true } });
    openSettingsTab('agents');
    render(<SettingsScreen />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Keep Tayang running in the background' }));
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ backgroundMode: false, openAtLogin: false }));
    expect(autostart.disable).toHaveBeenCalledTimes(1);
  });

  it('toggles frameCheck through updateSettings', async () => {
    openSettingsTab('agents');
    render(<SettingsScreen />);
    const sw = await screen.findByRole('switch', { name: 'Check every frame before showing me' });
    await userEvent.click(sw);
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ frameCheck: false }));
  });

  it('toggles auto mode through updateSettings and explains it', async () => {
    openSettingsTab('agents');
    render(<SettingsScreen />);
    const sw = await screen.findByRole('switch', { name: 'Auto mode for chats' });
    expect(screen.getByText('Autopilots always use Auto mode.')).toBeInTheDocument();
    expect(sw).not.toBeChecked();
    expect(
      screen.getByText(
        "Your agent runs commands without asking. Claude Code reviews risky steps itself; other agents' requests are approved one at a time.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(sw);
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ autoMode: true }));
  });

  it('toggles shareInstallStats through updateSettings and explains what is sent', async () => {
    openSettingsTab('account');
    render(<SettingsScreen />);
    const sw = await screen.findByRole('switch', { name: 'Share anonymous usage stats' });
    expect(sw).toBeChecked();
    // Says that feature usage goes too, and what never does.
    expect(screen.getByText(/which features you use .* Never your chats, prompts, files or videos\./)).toBeInTheDocument();
    await userEvent.click(sw);
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ shareInstallStats: false }));
  });

  it('says when TAYANG_API_URL overrides the API address, shows that address and locks the field', async () => {
    vi.mocked(ipc.apiUrlOverride).mockResolvedValueOnce('http://localhost:8787/api');
    openSettingsTab('account');
    render(<SettingsScreen />);
    expect(await screen.findByText(/started with TAYANG_API_URL, so it uses http:\/\/localhost:8787\/api/)).toBeInTheDocument();
    const field = screen.getByLabelText('API address');
    expect(field).toHaveValue('http://localhost:8787/api');
    expect(field).toBeDisabled();
  });

  it('edits the API address and explains what it is for', async () => {
    openSettingsTab('account');
    render(<SettingsScreen />);
    const input = await screen.findByLabelText('API address');
    expect(input).toHaveValue('https://studio.tayang.app/api');
    expect(screen.getByText('Used for built-in styles, signing in and install stats')).toBeInTheDocument();
    expect(screen.getByText('Leave it empty to use https://studio.tayang.app/api')).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'https://studio.tayang.app/api');
    await userEvent.clear(input);
    await userEvent.type(input, 'http://localhost:8787/api');
    await userEvent.tab();
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ apiUrl: 'http://localhost:8787/api' }));
  });

  it('rejects an API address that is not http(s)', async () => {
    openSettingsTab('account');
    render(<SettingsScreen />);
    const input = await screen.findByLabelText('API address');
    await userEvent.clear(input);
    await userEvent.type(input, 'ftp://nope');
    await userEvent.tab();
    expect(await screen.findByText('Enter an address that starts with http:// or https://')).toBeInTheDocument();
    expect(ipc.updateSettings).not.toHaveBeenCalled();
  });

  it('clearing the API address resets it to the default', async () => {
    useApp.setState({ settings: { ...settings, apiUrl: 'http://localhost:8787/api' } });
    openSettingsTab('account');
    render(<SettingsScreen />);
    const input = await screen.findByLabelText('API address');
    await userEvent.clear(input);
    await userEvent.tab();
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ apiUrl: 'https://studio.tayang.app/api' }));
  });

  it('signs in with Google through the API, not tayang.app', async () => {
    openSettingsTab('account');
    render(<SettingsScreen />);
    expect(screen.queryByRole('button', { name: /tayang\.app/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    expect(authIpc.authStart).toHaveBeenCalled();
    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalledWith('https://tayang.app');
  });

  it('says existing projects stay put when the working folder changes', async () => {
    openSettingsTab('render');
    render(<SettingsScreen />);
    expect(await screen.findByText('Existing projects stay where they are')).toBeInTheDocument();
  });
});

describe('Style study job notes in another language', () => {
  it('saves the failed study note in English while the screen is in Indonesian', async () => {
    vi.mocked(ipc.studyDir).mockResolvedValue('/w/s');
    setUiLanguage('id');
    render(<Style />);
    await userEvent.type(screen.getByLabelText('Link video'), 'https://youtu.be/abc');
    await userEvent.click(screen.getByRole('button', { name: 'Pelajari video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const chatId = vi.mocked(ipc.agentPrompt).mock.calls[0]![0];
    act(() => updateHandlers.forEach((h) => h({ chatId, update: { kind: 'error', message: 'Authentication required' } })));
    const sayIt = 'Masuk ke Claude dulu: buka Pengaturan › Agen lalu tekan Masuk ke Claude';
    expect(await screen.findByText(sayIt)).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0]).toMatchObject({
        status: 'failed',
        title: 'Study a video for a new style',
        note: 'Sign in to Claude first: open Settings › Agents and press Sign in to Claude',
      }),
    );
    // and the cancelled note, too
    expect(localized('Sign in to Claude first: open Settings › Agents and press Sign in to Claude')).toBe(sayIt);
  });
});
