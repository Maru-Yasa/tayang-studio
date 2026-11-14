import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { AgentUpdate, Chat, PermissionRequest, Project, Settings, Style } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  listProjects: vi.fn(),
  projectFiles: vi.fn(async () => []),
  findProjectFiles: vi.fn(async () => []),
  readProjectFile: vi.fn(),
  createProject: vi.fn(),
  makeStyleSheets: vi.fn(async () => []),
  keepStyleRefs: vi.fn(async () => []),
  copyStyleRefs: vi.fn(async () => 0),
  updateProject: vi.fn(),
  setProjectStatus: vi.fn(),
  listChats: vi.fn(),
  getChat: vi.fn(),
  createChat: vi.fn(),
  listMessages: vi.fn(),
  addMessage: vi.fn(),
  agentStart: vi.fn(),
  agentSetAuto: vi.fn().mockResolvedValue(undefined),
  agentPrompt: vi.fn(),
  agentCancel: vi.fn(),
  agentStop: vi.fn().mockResolvedValue(undefined),
  agentRespondPermission: vi.fn(),
  getSettings: vi.fn(),
  listStyles: vi.fn(),
  syncStyles: vi.fn().mockResolvedValue({ styles: [], offline: false }),
  mediaLatestRender: vi.fn().mockResolvedValue(null),
  latestRenderInfo: vi.fn().mockResolvedValue(null),
  mediaProbe: vi.fn().mockResolvedValue(null),
  mediaThumbnails: vi.fn().mockResolvedValue([]),
  mediaExtractFrame: vi.fn(),
  mediaRender: vi.fn(),
  upsertJob: vi.fn().mockResolvedValue(undefined),
  listJobs: vi.fn().mockResolvedValue([]),
  attachFile: vi.fn(),
  detectAgents: vi.fn(),
  updateChatAgent: vi.fn(),
  installStyleTemplate: vi.fn(),
  renderCommand: vi.fn().mockResolvedValue(null),
  writeBrief: vi.fn().mockResolvedValue(undefined),
  assetUrl: (p: string) => p,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

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

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import * as ipc from '@/lib/ipc';
import { ChatRoute } from '@/screens/ChatRoute';
import { ChatProject } from '@/screens/ChatProject';
import { setUiLanguage } from '@/i18n';
import { useApp } from '@/state/app';
import { buildRecap, useChat } from '@/state/chat';
import { useUsage } from '@/state/usage';
import { StatusBar } from '@/components/StatusBar';
import { renderTiming } from '@/lib/renderCheck';
import { useRender } from '@/state/render';

/** What the agent got, without the session facts line a new session starts with. */
const noFacts = <T,>(parts: T[]): T[] =>
  parts.filter((p) => !String((p as { text?: unknown }).text ?? '').includes('local time zone is'));


const settings: Settings = {
  workingFolder: '/tmp/Tayang',
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

const mk = (id: string, title: string): Project => ({
  id,
  title,
  slug: id,
  folder: `/tmp/Tayang/${id}`,
  kind: 'explainer',
  format: '9:16',
  language: 'id',
  status: 'building',
  styleId: null,
  scheduledAt: null, reviewState: 'none', postedAt: null, remindedAt: null, reviewRemindedAt: null,
  durationSec: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
});

const projects = [mk('p1', 'Kenapa rupiah melemah?'), mk('p2', 'Sejarah singkat QRIS')];
const chat = (id: string, projectId: string | null): Chat => ({
  id,
  projectId,
  agentId: 'claude',
  title: 'chat',
  createdAt: '2026-11-01T00:00:00Z',
});

const emit = (chatId: string, update: AgentUpdate) =>
  act(async () => {
    handlers.update.forEach((cb) => cb({ chatId, update }));
  });

beforeEach(() => {
  renderTiming.stableMs = 0;
  vi.clearAllMocks();
  handlers.update.length = 0;
  handlers.perm.length = 0;
  useChat.getState().reset();
  useApp.setState({ settings, route: { name: 'chat-new' } });
  vi.mocked(ipc.renderCommand).mockResolvedValue(null);
  vi.mocked(ipc.listProjects).mockResolvedValue(projects);
  vi.mocked(ipc.listStyles).mockResolvedValue([]);
  // Same filter as Rust: a project id lists that project's chats, none lists chats without one.
  const allChats = [chat('c1', 'p1'), chat('c0', null)];
  vi.mocked(ipc.listChats).mockImplementation(async (projectId) =>
    allChats.filter((c) => c.projectId === (projectId ?? null)),
  );
  vi.mocked(ipc.getChat).mockImplementation(async (id) => allChats.find((c) => c.id === id) ?? null);
  vi.mocked(ipc.listMessages).mockResolvedValue([]);
  vi.mocked(ipc.createChat).mockResolvedValue(chat('c-new', null));
  vi.mocked(ipc.addMessage).mockImplementation(async (chatId, role, parts) => ({
    id: `m-${Math.random()}`,
    chatId,
    role,
    parts,
    createdAt: '',
  }));
  vi.mocked(ipc.agentStart).mockResolvedValue(false);
  vi.mocked(ipc.agentPrompt).mockResolvedValue();
  vi.mocked(ipc.agentRespondPermission).mockResolvedValue();
});

describe('ChatNew', () => {
  it('centres with my-auto, not justify-center, so an overflowing conversation keeps its top reachable', () => {
    const { container } = render(<ChatRoute />);
    const scroller = container.querySelector('.no-scrollbar')!;
    expect(scroller.className).not.toContain('justify-center');
    expect(scroller.firstElementChild!.className).toContain('my-auto');
  });

  it('shows project titles after typing @ and inserts a chip on Enter', async () => {
    const user = userEvent.setup();
    render(<ChatRoute />);
    expect(await screen.findByText('No video attached')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Bikin versi 15 detik dari @');
    const list = await screen.findByRole('listbox');
    expect(within(list).getByText('Kenapa rupiah melemah?')).toBeInTheDocument();
    expect(within(list).getByText('Sejarah singkat QRIS')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('1 video attached')).toBeInTheDocument();
    expect(screen.getByText('@Kenapa rupiah melemah?')).toBeInTheDocument();
  });

  it('sends without a mention part and without any project info', async () => {
    const user = userEvent.setup();
    render(<ChatRoute />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'halo');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(ipc.createChat).toHaveBeenCalledWith(null, 'claude', expect.any(String));
    const [chatId, parts] = vi.mocked(ipc.agentPrompt).mock.calls[0]!;
    expect(chatId).toBe('c-new');
    expect(parts.some((p) => p.type === 'mention')).toBe(false);
    expect(JSON.stringify(parts)).not.toContain('/tmp/Tayang');
  });

  it('sends the project folder and brief when a video is mentioned', async () => {
    const user = userEvent.setup();
    render(<ChatRoute />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'remix @');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const parts = vi.mocked(ipc.agentPrompt).mock.calls[0]![1];
    expect(parts.some((p) => p.type === 'mention')).toBe(true);
    expect(JSON.stringify(parts)).toContain('/tmp/Tayang/p1');
    // The agent can schedule a mentioned video by its id.
    expect(JSON.stringify(parts)).toMatch(/Its Tayang id is p1\./);
  });
});

describe('ChatNew topic ideas', () => {
  it('turns the agent ideas into cards and creates a project on pick', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.createProject).mockResolvedValue(mk('p9', 'Ide satu'));
    vi.mocked(ipc.createChat).mockResolvedValueOnce(chat('c-new', null)).mockResolvedValueOnce(chat('c9', 'p9'));
    render(<ChatRoute />);
    await user.click(await screen.findByRole('button', { name: /From a topic/ }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    await emit('c-new', {
      kind: 'text',
      text: '```json\n[{"title":"Ide satu","kind":"explainer","lengthSec":30}]\n```',
    });
    await emit('c-new', { kind: 'done', stopReason: 'end_turn' });
    await user.click(await screen.findByRole('button', { name: /Ide satu/ }));
    await waitFor(() => expect(ipc.createProject).toHaveBeenCalled());
    expect(ipc.createProject).toHaveBeenCalledWith(
      { title: 'Ide satu', kind: 'explainer', format: '9:16', language: 'id' },
      expect.stringContaining('Ide satu'),
    );
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'c9' }));
    expect(useApp.getState().projectsVersion).toBeGreaterThan(0);
  });
});

describe('ChatNew template style', () => {
  const template: Style = {
    id: 'builtin-atlas',
    name: 'Atlas journey',
    source: 'builtin',
    sourceUrl: null,
    notes: {},
    prompt: 'p',
    createdAt: '',
    engine: 'remotion',
    template: { sha256: 'a', size: 1, version: 1 },
  };

  const pick = async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.listStyles).mockResolvedValue([template]);
    vi.mocked(ipc.createProject).mockResolvedValue({ ...mk('p9', 'Ide satu'), styleId: template.id });
    vi.mocked(ipc.createChat).mockResolvedValueOnce(chat('c-new', null)).mockResolvedValueOnce(chat('c9', 'p9'));
    useApp.setState({ route: { name: 'chat-new', styleId: template.id } });
    render(<ChatRoute />);
    await user.click(await screen.findByRole('button', { name: /From a topic/ }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    await emit('c-new', {
      kind: 'text',
      text: '```json\n[{"title":"Ide satu","kind":"explainer","lengthSec":30}]\n```',
    });
    await emit('c-new', { kind: 'done', stopReason: 'end_turn' });
    await user.click(await screen.findByRole('button', { name: /Ide satu/ }));
  };

  it('installs the template after creating the project and says so in the chat', async () => {
    vi.mocked(ipc.installStyleTemplate).mockResolvedValue({ installed: true });
    await pick();
    await waitFor(() => expect(ipc.installStyleTemplate).toHaveBeenCalledWith('p9'));
    expect(vi.mocked(ipc.createProject).mock.calls[0]![0]).toMatchObject({ styleId: 'builtin-atlas' });
    expect(vi.mocked(ipc.createProject).mock.calls[0]![1]).toContain('This project starts from the Atlas journey template.');
    expect(ipc.addMessage).toHaveBeenCalledWith('c9', 'system', [
      { type: 'text', text: 'Setting up the Atlas journey template…' },
    ]);
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'c9' }));
  });

  it('puts the setup lines into the live chat, not only the database', async () => {
    vi.mocked(ipc.installStyleTemplate).mockRejectedValue('offline');
    await pick();
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'c9' }));
    const texts = (useChat.getState().messages.c9 ?? []).filter((m) => m.role === 'system').map((m) => m.parts[0]);
    expect(texts).toEqual([
      { type: 'text', text: 'Setting up the Atlas journey template…' },
      { type: 'text', text: "Couldn't set up the Atlas journey template: offline. Continuing without it." },
    ]);
  });

  it('shows the setup inline and blocks every pick while it runs', async () => {
    let finish: (v: { installed: boolean }) => void = () => {};
    vi.mocked(ipc.installStyleTemplate).mockReturnValue(new Promise((r) => (finish = r)));
    await pick();
    expect(await screen.findByRole('status')).toHaveTextContent('Setting up the Atlas journey template…');
    expect(screen.getByRole('button', { name: /Ide satu/ })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    await act(async () => finish({ installed: true }));
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'c9' }));
    expect(ipc.createProject).toHaveBeenCalledTimes(1);
  });

  it('says why when the topic could not be started', async () => {
    vi.mocked(ipc.installStyleTemplate).mockResolvedValue({ installed: true });
    const user = userEvent.setup();
    vi.mocked(ipc.listStyles).mockResolvedValue([]);
    vi.mocked(ipc.createProject).mockRejectedValue(new Error('disk full'));
    render(<ChatRoute />);
    await user.click(await screen.findByRole('button', { name: /From a topic/ }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    await emit('c-new', { kind: 'text', text: '```json\n[{"title":"Ide satu","kind":"explainer","lengthSec":30}]\n```' });
    await emit('c-new', { kind: 'done', stopReason: 'end_turn' });
    await user.click(await screen.findByRole('button', { name: /Ide satu/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn\'t start "Ide satu": disk full');
    expect(screen.getByRole('button', { name: /Ide satu/ })).toBeEnabled();
  });

  it('shows the error as a system line and carries on without the template', async () => {
    vi.mocked(ipc.installStyleTemplate).mockRejectedValue('Couldn\'t download the template');
    await pick();
    await waitFor(() =>
      expect(ipc.addMessage).toHaveBeenCalledWith('c9', 'system', [
        {
          type: 'text',
          text: "Couldn't set up the Atlas journey template: Couldn't download the template. Continuing without it.",
        },
      ]),
    );
    // the brief no longer promises a template
    expect(ipc.writeBrief).toHaveBeenCalledWith('p9', expect.not.stringContaining('starts from the Atlas journey template'));
    expect(ipc.writeBrief).toHaveBeenCalledWith('p9', expect.stringContaining('# Ide satu'));
    await waitFor(() => expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'c9' }));
    expect(ipc.agentPrompt).toHaveBeenCalledTimes(2);
  });
});

describe('ChatNew template chip and fallbacks', () => {
  const template: Style = {
    id: 'builtin-atlas',
    name: 'Atlas journey',
    source: 'builtin',
    sourceUrl: null,
    notes: {},
    prompt: 'p',
    createdAt: '',
    engine: 'remotion',
    template: { sha256: 'a', size: 1, version: 1 },
  };
  const topic = async (user: ReturnType<typeof userEvent.setup>) => {
    vi.mocked(ipc.createProject).mockResolvedValue({ ...mk('p9', 'Ide satu'), styleId: template.id });
    vi.mocked(ipc.createChat).mockResolvedValueOnce(chat('c-new', null)).mockResolvedValueOnce(chat('c9', 'p9'));
    await user.click(await screen.findByRole('button', { name: /From a topic/ }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    await emit('c-new', { kind: 'text', text: '```json\n[{"title":"Ide satu","kind":"explainer","lengthSec":30}]\n```' });
    await emit('c-new', { kind: 'done', stopReason: 'end_turn' });
    await user.click(await screen.findByRole('button', { name: /Ide satu/ }));
  };

  it('shows a style chip for a style without a template, and the topic starts with that style', async () => {
    const user = userEvent.setup();
    const copied = { ...template, id: 'copied-9', name: 'Storybook', source: 'copied' as const, template: null };
    vi.mocked(ipc.listStyles).mockResolvedValue([copied]);
    useApp.setState({ route: { name: 'chat-new', styleId: copied.id } });
    render(<ChatRoute />);
    expect(await screen.findByText('Using the Storybook style')).toBeInTheDocument();
    await topic(user);
    await waitFor(() => expect(ipc.createProject).toHaveBeenCalled());
    expect(vi.mocked(ipc.createProject).mock.calls[0]![0]).toHaveProperty('styleId', 'copied-9');
  });

  it('shows a chip for the pending template and clears it with the x', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.listStyles).mockResolvedValue([template]);
    useApp.setState({ route: { name: 'chat-new', styleId: template.id } });
    render(<ChatRoute />);
    const chip = await screen.findByText('Starting from the Atlas journey template');
    expect(chip.closest('[title]')).toHaveAttribute('title', 'Pick a topic to start from this template');
    await user.click(screen.getByRole('button', { name: 'Remove the Atlas journey template' }));
    expect(screen.queryByText('Starting from the Atlas journey template')).not.toBeInTheDocument();
    await topic(user);
    await waitFor(() => expect(ipc.createProject).toHaveBeenCalled());
    expect(vi.mocked(ipc.createProject).mock.calls[0]![0]).not.toHaveProperty('styleId');
    expect(ipc.installStyleTemplate).not.toHaveBeenCalled();
  });

  it('treats installed: false as a failure and rewrites the brief', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.listStyles).mockResolvedValue([template]);
    vi.mocked(ipc.installStyleTemplate).mockResolvedValue({ installed: false });
    useApp.setState({ route: { name: 'chat-new', styleId: template.id } });
    render(<ChatRoute />);
    await topic(user);
    await waitFor(() => expect(ipc.writeBrief).toHaveBeenCalledWith('p9', expect.not.stringContaining('This project starts from')));
    expect(ipc.addMessage).toHaveBeenCalledWith('c9', 'system', [
      expect.objectContaining({ text: expect.stringMatching(/^Couldn't set up the Atlas journey template: .+\. Continuing without it\.$/) }),
    ]);
  });

  it('says so when the styles could not be read', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.listStyles).mockRejectedValue(new Error('db locked'));
    useApp.setState({ route: { name: 'chat-new', styleId: template.id } });
    render(<ChatRoute />);
    await topic(user);
    await waitFor(() =>
      expect(ipc.addMessage).toHaveBeenCalledWith('c9', 'system', [
        { type: 'text', text: "Couldn't set up the template: db locked. Continuing without it." },
      ]),
    );
    expect(ipc.installStyleTemplate).not.toHaveBeenCalled();
  });
});

describe('ChatProject', () => {
  it('renders the step bar and the preview slot', async () => {
    render(<ChatProject chatId="c1" />);
    expect(await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Progress' })).toBeInTheDocument();
    expect(await screen.findByText('Nothing rendered yet')).toBeInTheDocument();
  });

  it('merges a text update sequence into one agent message', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'faster');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(ipc.agentStart).toHaveBeenCalledWith('c1', 'claude');
    await emit('c1', { kind: 'text', text: 'Okay, ' });
    await emit('c1', { kind: 'text', text: 'making it faster.' });
    expect(await screen.findByText('Okay, making it faster.')).toBeInTheDocument();
    expect(screen.getAllByTestId('agent-message')).toHaveLength(1);
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    expect(screen.getAllByTestId('agent-message')).toHaveLength(1);
  });

  it('merges thought chunks into one part, keeps tool kind and path, and persists them', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    await emit('c1', { kind: 'thought', text: 'Let me ' });
    await emit('c1', { kind: 'thought', text: 'think' });
    await emit('c1', { kind: 'tool', toolCallId: 't1', title: 'Read a.ts', status: 'done', toolKind: 'read', path: '/w/a.ts' });
    await emit('c1', { kind: 'text', text: 'Done' });
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    const parts = useChat.getState().messages.c1!.at(-1)!.parts;
    expect(parts).toEqual([
      { type: 'thought', text: 'Let me think' },
      { type: 'tool', toolCallId: 't1', title: 'Read a.ts', status: 'done', toolKind: 'read', path: '/w/a.ts' },
      { type: 'text', text: 'Done' },
    ]);
    expect(ipc.addMessage).toHaveBeenCalledWith('c1', 'agent', parts);
  });

  it('settles tools the agent never finished: done after a normal end, failed after a cancel or error', async () => {
    const run = async (end: AgentUpdate) => {
      useChat.getState().reset();
      const user = userEvent.setup();
      const view = render(<ChatProject chatId="c1" />);
      await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'go');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
      await emit('c1', { kind: 'tool', toolCallId: 't1', title: 'Run x', status: 'running', toolKind: 'execute' });
      await emit('c1', end);
      const msg = useChat.getState().messages.c1!.find((m) => m.role === 'agent')!;
      view.unmount();
      vi.clearAllMocks();
      return msg.parts.find((p) => p.type === 'tool') as { status: string };
    };
    expect((await run({ kind: 'done', stopReason: 'end_turn' })).status).toBe('done');
    expect((await run({ kind: 'done', stopReason: 'cancelled' })).status).toBe('failed');
    expect((await run({ kind: 'error', message: 'boom' })).status).toBe('failed');
  });

  it('starts with auto mode when Settings has it on, and the Auto toggle switches the running session', async () => {
    const user = userEvent.setup();
    useApp.setState({ settings: { ...settings, autoMode: true } });
    render(<ChatProject chatId="c1" />);
    const toggle = await screen.findByRole('button', { name: 'Auto' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalledWith('c1', 'claude', true));
    // Disabled while the turn streams.
    expect(screen.getByRole('button', { name: 'Auto' })).toBeDisabled();
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await user.click(screen.getByRole('button', { name: 'Auto' }));
    expect(ipc.agentSetAuto).toHaveBeenCalledWith('c1', false);
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('Auto is off by default and a chat that has not started just remembers the toggle', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    const toggle = await screen.findByRole('button', { name: 'Auto' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(ipc.agentSetAuto).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalledWith('c1', 'claude', true));
  });

  it('prefills the composer with a route draft without sending it', async () => {
    render(<ChatProject chatId="c1" draft="Tayang was closed while you were working on this." />);
    const box = await screen.findByRole('textbox', { name: 'Message' });
    expect(box).toHaveValue('Tayang was closed while you were working on this.');
    expect(ipc.agentPrompt).not.toHaveBeenCalled();
  });

  it('a new-chat Auto choice does not leak into other chats, and moves to the chat it creates', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ChatRoute />);
    await user.click(await screen.findByRole('button', { name: 'Auto' }));
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'halo');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalledWith('c-new', 'claude', true));
    unmount();
    // Another chat starts from Settings, not from the New chat toggle.
    useChat.getState().reset();
    render(<ChatProject chatId="c1" />);
    expect(await screen.findByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('an unsent New chat toggle is dropped when the screen closes', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ChatRoute />);
    await user.click(await screen.findByRole('button', { name: 'Auto' }));
    expect(useChat.getState().pendingAuto).toBe(true);
    unmount();
    expect(useChat.getState().pendingAuto).toBeNull();
    render(<ChatProject chatId="c1" />);
    expect(await screen.findByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('the Auto toggle waits for the running session and follows its answer', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalled());
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    let finish!: () => void;
    vi.mocked(ipc.agentSetAuto).mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    await user.click(screen.getByRole('button', { name: 'Auto' }));
    // Pending: disabled, and the store has not moved yet.
    expect(screen.getByRole('button', { name: 'Auto' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Auto' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('when leaving auto mode fails, the session is dropped, the error is shown and the next send starts with Auto off', async () => {
    const user = userEvent.setup();
    useApp.setState({ settings: { ...settings, autoMode: true } });
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalledWith('c1', 'claude', true));
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    vi.mocked(ipc.agentSetAuto).mockRejectedValueOnce(new Error('cannot leave auto'));
    await user.click(screen.getByRole('button', { name: 'Auto' }));
    expect(await screen.findByText(/Couldn't turn off Auto mode.*cannot leave auto/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
    expect(useChat.getState().started['c1']).toBe(false);
    vi.mocked(ipc.agentStart).mockClear();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'again');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalledWith('c1', 'claude'));
  });

  it('the agent picker waits while an Auto change is pending', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalled());
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    let finish!: () => void;
    vi.mocked(ipc.agentSetAuto).mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    await user.click(screen.getByRole('button', { name: 'Auto' }));
    expect(screen.getByRole('button', { name: /Claude Code/ })).toBeDisabled();
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole('button', { name: /Claude Code/ })).toBeEnabled());
  });

  it('the Auto toggle follows Settings changes while it is open', async () => {
    render(<ChatProject chatId="c1" />);
    expect(await screen.findByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
    act(() => useApp.setState({ settings: { ...settings, autoMode: true } }));
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the composer toolbar is icon-only, 32px buttons with labels and tooltips; the agent also shows its name', async () => {
    const user = userEvent.setup();
    render(<ChatRoute />);
    const agent = await screen.findByRole('button', { name: 'Agent: Claude Code' });
    const auto = screen.getByRole('button', { name: 'Auto' });
    const mention = screen.getByRole('button', { name: '@ Mention a video' });
    const attach = screen.getByRole('button', { name: 'Attach files' });
    for (const b of [agent, auto, mention, attach]) expect(b).toHaveClass('size-8');
    for (const b of [auto, mention, attach]) expect(b.textContent).toBe('');
    expect(agent.textContent).toBe('Claude Code');
    expect(auto).toHaveAttribute('aria-pressed', 'false');
    await user.click(auto);
    expect(auto).toHaveAttribute('aria-pressed', 'true');
    expect(auto).toHaveClass('bg-tint');
  });

  it.each([
    ['Agent: Claude Code', 'Agent: Claude Code', false],
    ['Auto', 'Auto mode: off', false],
    ['Auto', 'Auto mode: on', true],
    ['@ Mention a video', '@ Mention a video', false],
  ] as const)('hovering %s shows the tooltip %s', async (name, tip, autoMode) => {
    const user = userEvent.setup();
    useApp.setState({ settings: { ...settings, autoMode } });
    render(<ChatRoute />);
    await user.hover(await screen.findByRole('button', { name }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(tip);
  });

  it('the toolbar labels speak Indonesian', async () => {
    setUiLanguage('id');
    render(<ChatRoute />);
    expect(await screen.findByRole('button', { name: 'Agen: Claude Code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Otomatis' })).toBeInTheDocument();
  });

  it("talks to the chat's own agent, not the default one", async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.getChat).mockResolvedValue({ ...chat('c1', 'p1'), agentId: 'gemini' });
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    expect(screen.getByRole('button', { name: 'Agent: Gemini CLI' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalledWith('c1', 'gemini'));
  });

  it('prefixes the Tayang skills on the first prompt of a non-Claude session only', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.getChat).mockResolvedValue({ ...chat('c1', 'p1'), agentId: 'gemini' });
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(1));
    const first = JSON.stringify(vi.mocked(ipc.agentPrompt).mock.calls[0]![1]);
    expect(first).toContain('AskUserQuestion');
    expect(first).toContain('one');
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'two');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(vi.mocked(ipc.agentPrompt).mock.calls[1]![1])).not.toContain('AskUserQuestion');
  });

  it('does not prefix the skills for Claude, which loads the plugin', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(vi.mocked(ipc.agentPrompt).mock.calls[0]![1])).not.toContain('AskUserQuestion');
  });

  it('sends the skills to Claude as text when the app has no plugin to give it', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.agentStart).mockResolvedValueOnce(true);
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(vi.mocked(ipc.agentPrompt).mock.calls[0]![1])).toContain('AskUserQuestion');
  });

  it('tells an agent that reads Indonesian to answer in Indonesian, once per session', async () => {
    const user = userEvent.setup();
    useApp.setState({ settings: { ...settings, uiLanguage: 'id' } });
    setUiLanguage('id');
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Pesan' }), 'satu');
    await user.click(screen.getByRole('button', { name: 'Kirim' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(1));
    const sent = JSON.stringify(vi.mocked(ipc.agentPrompt).mock.calls[0]![1]);
    expect(sent).toContain('The user reads Indonesian. Reply in Indonesian unless they write in another language.');
    // a later message in the same session does not repeat it
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await user.type(screen.getByRole('textbox', { name: 'Pesan' }), 'dua');
    await user.click(screen.getByRole('button', { name: 'Kirim' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(vi.mocked(ipc.agentPrompt).mock.calls[1]![1])).not.toContain('The user reads Indonesian');
  });

  it('keeps the hint out of the saved message, and sends it again for a new session', async () => {
    const user = userEvent.setup();
    useApp.setState({ settings: { ...settings, uiLanguage: 'id' } });
    setUiLanguage('id');
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Pesan' }), 'satu');
    await user.click(screen.getByRole('button', { name: 'Kirim' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.addMessage).mock.calls.every((c) => !JSON.stringify(c[2]).includes('The user reads'))).toBe(true);
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await useChat.getState().stop('c1');
    await user.type(screen.getByRole('textbox', { name: 'Pesan' }), 'dua');
    await user.click(screen.getByRole('button', { name: 'Kirim' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(vi.mocked(ipc.agentPrompt).mock.calls[1]![1])).toContain('The user reads Indonesian');
  });

  it('does not add the hint for English', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'one');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(vi.mocked(ipc.agentPrompt).mock.calls[0]![1])).not.toContain('The user reads');
  });

  it('saves the sign-in line in English and shows it in the language the user reads now', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.agentStart).mockRejectedValue(new Error('The agent needs you to sign in first (Authentication required)'));
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Sign in to Claude first: open Settings › Agents and press Sign in to Claude');
    const saved = vi.mocked(ipc.addMessage).mock.calls.map((c) => JSON.stringify(c[2]));
    expect(saved.some((s) => s.includes('Sign in to Claude first: open Settings › Agents and press Sign in to Claude'))).toBe(true);
    await act(async () => setUiLanguage('id'));
    expect(
      await screen.findByText('Masuk ke Claude dulu: buka Pengaturan › Agen lalu tekan Masuk ke Claude'),
    ).toBeInTheDocument();
  });

  it('shows an error message and re-enables the composer', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(box, 'faster');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(box).toBeDisabled());
    await emit('c1', { kind: 'error', message: 'The agent reported an error: boom' });
    expect(await screen.findByText('The agent reported an error: boom')).toBeInTheDocument();
    expect(box).toBeEnabled();
  });

  it('tells the user how to sign in when the agent needs auth', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.agentStart).mockRejectedValue(new Error('The agent needs you to sign in first (Authentication required)'));
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(
      await screen.findByText('Sign in to Claude first: open Settings › Agents and press Sign in to Claude'),
    ).toBeInTheDocument();
  });

  it('renders a permission card and Allow sends the allow option id', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await screen.findByRole('textbox', { name: 'Message' });
    await act(async () => {
      handlers.perm.forEach((cb) =>
        cb({
          chatId: 'c1',
          requestId: 'r1',
          title: 'Install a font',
          commands: ['brew install font'],
          options: [
            { id: 'opt-allow', label: 'Allow', kind: 'allow-once' },
            { id: 'opt-no', label: 'Reject', kind: 'reject-once' },
          ],
        }),
      );
    });
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(ipc.agentRespondPermission).toHaveBeenCalledWith('r1', 'opt-allow');
  });

  it('queues parallel permission requests and answers both', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await screen.findByRole('textbox', { name: 'Message' });
    const req = (requestId: string, cmd: string): PermissionRequest => ({
      chatId: 'c1',
      requestId,
      title: cmd,
      commands: [cmd],
      options: [{ id: `allow-${requestId}`, label: 'Allow', kind: 'allow-once' }],
    });
    await act(async () => {
      handlers.perm.forEach((cb) => cb(req('r1', 'echo one')));
      handlers.perm.forEach((cb) => cb(req('r2', 'echo two')));
    });
    expect(screen.getAllByRole('button', { name: 'Allow' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(ipc.agentRespondPermission).toHaveBeenLastCalledWith('r1', 'allow-r1');
    expect(await screen.findByText('echo two', { selector: 'pre' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(ipc.agentRespondPermission).toHaveBeenLastCalledWith('r2', 'allow-r2');
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('answers still-queued requests with null when the turn ends', async () => {
    render(<ChatProject chatId="c1" />);
    await screen.findByRole('textbox', { name: 'Message' });
    const base = { chatId: 'c1', title: 't', commands: ['x'], options: [{ id: 'a', label: 'Allow', kind: 'allow-once' as const }] };
    await act(async () => {
      handlers.perm.forEach((cb) => cb({ ...base, requestId: 'q1' }));
      handlers.perm.forEach((cb) => cb({ ...base, requestId: 'q2' }));
    });
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    expect(ipc.agentRespondPermission).toHaveBeenCalledWith('q1', null);
    expect(ipc.agentRespondPermission).toHaveBeenCalledWith('q2', null);
    expect(useChat.getState().permissions['c1']).toEqual([]);
  });

  it.each([true, false])('frame check setting %s: skip line only when off', async (frameCheck) => {
    useApp.setState({ settings: { ...settings, frameCheck } });
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'faster');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const parts = noFacts(vi.mocked(ipc.agentPrompt).mock.calls[0]![1]);
    expect(parts[0]).toEqual(
      frameCheck ? { type: 'text', text: 'faster' } : { type: 'text', text: 'Skip the frame check this time.' },
    );
    // The visible message never shows the instruction.
    expect(screen.queryByText('Skip the frame check this time.')).not.toBeInTheDocument();
  });

  it('shows Stop while the agent works and cancels the turn', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.agentCancel).mockResolvedValue();
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'faster');
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(ipc.agentCancel).toHaveBeenCalledWith('c1');
    await emit('c1', { kind: 'done', stopReason: 'cancelled' });
    expect(await screen.findByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('attach and detach feed the next send, then clear', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'fix this');
    act(() => {
      useChat.getState().attach('c1', { type: 'frame', projectId: 'p1', frame: 330, timeSec: 11, imagePath: '/x.png', marks: [] });
    });
    expect(await screen.findByText('Frame 0:11.00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const parts = vi.mocked(ipc.agentPrompt).mock.calls[0]![1];
    expect(parts.some((p) => p.type === 'frame')).toBe(true);
    expect(useChat.getState().attachments['c1'] ?? []).toHaveLength(0);
  });
});

describe('chat persistence scope', () => {
  it.each(['setup', 'study-abc', 'autopilot-a1', 'ideas-2026-11-02'])('never stores %s updates', async (id) => {
    useChat.getState().listen();
    await emit(id, { kind: 'tool', toolCallId: 't1', title: 'claude mcp add -s user elevenlabs -e ELEVENLABS_API_KEY=sk_real', status: 'done' });
    await emit(id, { kind: 'text', text: 'done' });
    await emit(id, { kind: 'done', stopReason: 'end_turn' });
    await emit(id, { kind: 'error', message: 'x' });
    expect(ipc.addMessage).not.toHaveBeenCalled();
    expect(useChat.getState().messages[id]).toBeUndefined();
  });

  it('keeps an ideas chat in memory but never stores it', async () => {
    useChat.getState().listen();
    await act(async () => {
      await useChat.getState().send('ideas-2026-11-02', [{ type: 'text', text: 'ideas' }]);
    });
    await emit('ideas-2026-11-02', { kind: 'text', text: 'here' });
    await emit('ideas-2026-11-02', { kind: 'done', stopReason: 'end_turn' });
    expect(useChat.getState().messages['ideas-2026-11-02']).toHaveLength(2);
    expect(ipc.addMessage).not.toHaveBeenCalled();
  });

  it('ignores updates for chats it never loaded or started', async () => {
    useChat.getState().listen();
    await emit('someone-else', { kind: 'text', text: 'hi' });
    expect(useChat.getState().messages['someone-else']).toBeUndefined();
  });
});

describe('ChatProject render and jobs', () => {
  it('Render video renders, then records rendered with the probed duration', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.mediaRender).mockResolvedValue('/tmp/Tayang/p1/renders/a.mp4');
    vi.mocked(ipc.mediaProbe).mockResolvedValue({ durationSec: 12.5, fps: 30, frames: 375, width: 1080, height: 1920 });
    vi.mocked(ipc.updateProject).mockImplementation(async (id, patch) => ({ ...projects[0]!, id, ...patch }));
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    await user.click(screen.getByRole('button', { name: 'Render video' }));
    await waitFor(() => expect(ipc.updateProject).toHaveBeenCalledWith('p1', { durationSec: 12.5 }));
    // Through the forward-only status move, never straight onto the row.
    expect(ipc.setProjectStatus).toHaveBeenCalledWith('p1', 'rendered');
    expect(ipc.mediaRender).toHaveBeenCalledWith('p1');
    // the preview reloads after the render
    await waitFor(() => expect(vi.mocked(ipc.mediaLatestRender).mock.calls.length).toBeGreaterThan(1));
  });

  it('the step bar shows Render while a render of this project runs, and moves on when the project does', async () => {
    const user = userEvent.setup();
    const step = (name: string) => screen.getByText(name, { selector: '[data-step-name]' }).closest('li');
    vi.mocked(ipc.listProjects).mockResolvedValue([{ ...projects[0]!, status: 'draft' }, projects[1]!]);
    vi.mocked(ipc.setProjectStatus).mockImplementation(async (id, status) => ({ ...projects[0]!, id, status }));
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    expect(step('Script')).toHaveAttribute('aria-current', 'step');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    // The first edit finishes: the project is building, and the header follows.
    vi.mocked(ipc.listProjects).mockResolvedValue(projects);
    await emit('c1', { kind: 'tool', toolCallId: 't1', title: 'Edit scenes.ts', status: 'done', toolKind: 'edit' });
    expect(ipc.setProjectStatus).toHaveBeenCalledWith('p1', 'building');
    await waitFor(() => expect(step('Build')).toHaveAttribute('aria-current', 'step'));
    act(() => useRender.getState().start('p1', { source: 'agent', chatId: 'c1', toolCallId: 't2' }));
    expect(step('Render')).toHaveAttribute('aria-current', 'step');
    expect(within(step('Render')!).getByText('Rendering now')).toBeInTheDocument();
    // Another project's render is not this one's.
    act(() => useRender.getState().end('p1'));
    act(() => useRender.getState().start('p2', { source: 'agent' }));
    expect(step('Build')).toHaveAttribute('aria-current', 'step');
  });

  it('shows the exact command a tayang.json project will run', async () => {
    vi.mocked(ipc.renderCommand).mockResolvedValueOnce({
      install: null,
      render: ['npx', 'remotion', 'render', 'src/index.ts', 'Geo', 'renders/p1-1.mp4'],
    });
    render(<ChatProject chatId="c1" />);
    expect(await screen.findByText('npx remotion render src/index.ts Geo renders/p1-1.mp4')).toBeInTheDocument();
    expect(screen.getByText('Render command')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy the command' })).toBeInTheDocument();
  });

  it('shows the install step and quotes arguments with spaces, then refetches after a render', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.renderCommand)
      .mockResolvedValueOnce({ install: ['npm', 'install'], render: ['npx', 'remotion', 'render', 'My Comp', 'renders/a.mp4'] })
      .mockResolvedValue({ install: null, render: ['npx', 'remotion', 'render', 'My Comp', 'renders/a.mp4'] });
    vi.mocked(ipc.mediaRender).mockResolvedValue('/x/a.mp4');
    vi.mocked(ipc.updateProject).mockImplementation(async (id, patch) => ({ ...projects[0]!, id, ...patch }));
    render(<ChatProject chatId="c1" />);
    expect(await screen.findByText('npm install && npx remotion render "My Comp" renders/a.mp4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Render video' }));
    expect(await screen.findByText('npx remotion render "My Comp" renders/a.mp4')).toBeInTheDocument();
  });

  it('names the command line as the render command, in Indonesian too', async () => {
    setUiLanguage('id');
    vi.mocked(ipc.renderCommand).mockResolvedValueOnce({ install: null, render: ['npx', 'remotion', 'render', 'Geo'] });
    render(<ChatProject chatId="c1" />);
    expect(await screen.findByText('npx remotion render Geo')).toBeInTheDocument();
    expect(screen.getByText('Perintah render')).toBeInTheDocument();
    expect(screen.queryByText(/Menjalankan/)).not.toBeInTheDocument();
  });

  it('shows no command line without a tayang.json', async () => {
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    expect(screen.queryByText('Render command')).not.toBeInTheDocument();
  });

  it('shows an inline error when the render fails', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.mediaRender).mockRejectedValue(new Error('hyperframes render failed: no composition'));
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    await user.click(screen.getByRole('button', { name: 'Render video' }));
    expect(await screen.findByText(/Couldn't render: hyperframes render failed: no composition/)).toBeInTheDocument();
    expect(ipc.updateProject).not.toHaveBeenCalled();
  });

  it('says there is nothing to render yet without calling it a failure or asking the agent', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.mediaRender).mockRejectedValue('nothing to render yet');
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    await user.click(screen.getByRole('button', { name: 'Render video' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing to render yet. Ask your agent to make the video first');
    expect(screen.queryByText(/Couldn't render/)).not.toBeInTheDocument();
    expect(ipc.agentPrompt).not.toHaveBeenCalled();
  });

  it('tells the agent when the render fails, with the error, so it can fix the project', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.mediaRender).mockRejectedValue(new Error('hyperframes render failed: No composition found. No index.html file found.'));
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    await user.click(screen.getByRole('button', { name: 'Render video' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    const [chatId, parts] = vi.mocked(ipc.agentPrompt).mock.calls[0]!;
    expect(chatId).toBe('c1');
    const sent = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    expect(sent).toContain('No index.html file found.');
    expect(sent).toContain('fix');
    // The chat shows the short request, not the whole error.
    expect(await screen.findByText('Rendering failed. Find out why, fix it, and tell me when it can render.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Sent to your agent to fix');
  });

  it('tracks a turn as a build job: working, needs you, done, failed', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Kenapa rupiah melemah?', { selector: 'span' });
    const statuses = () => vi.mocked(ipc.upsertJob).mock.calls.map(([j]) => j.status);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(statuses()).toEqual(['working']));
    expect(vi.mocked(ipc.upsertJob).mock.calls[0]![0]).toMatchObject({
      id: 'build-c1',
      kind: 'build',
      projectId: 'p1',
      chatId: 'c1',
      title: 'Kenapa rupiah melemah?',
    });
    await act(async () =>
      handlers.perm.forEach((cb) =>
        cb({ chatId: 'c1', requestId: 'r1', title: 't', commands: ['x'], options: [{ id: 'a', label: 'Allow', kind: 'allow-once' }] }),
      ),
    );
    expect(statuses().at(-1)).toBe('needs-you');
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(statuses().at(-1)).toBe('working');
    // Done only with a finished video made during the turn.
    const made = { path: '/w/p1/renders/v-1.mp4', name: 'v-1.mp4', size: 9, modifiedAt: new Date().toISOString() };
    vi.mocked(ipc.latestRenderInfo).mockResolvedValueOnce(made).mockResolvedValueOnce(made);
    vi.mocked(ipc.mediaProbe).mockResolvedValueOnce({ durationSec: 12.5, fps: 30, frames: 375, width: 1080, height: 1920 });
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(statuses().at(-1)).toBe('done'));
    expect(vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0].note).toBe('v-1.mp4');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'again');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await emit('c1', { kind: 'error', message: 'The agent reported an error: boom' });
    expect(vi.mocked(ipc.upsertJob).mock.calls.at(-1)![0]).toMatchObject({
      status: 'failed',
      note: 'The agent reported an error: boom',
    });
  });
});

describe('ChatProject preview refresh', () => {
  it('reloads the preview when a turn ends with done, not on error', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await screen.findByText('Nothing rendered yet');
    const loads = () => vi.mocked(ipc.mediaLatestRender).mock.calls.length;
    const before = loads();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(loads()).toBe(before);
    await emit('c1', { kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(loads()).toBe(before + 1));

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'again');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await emit('c1', { kind: 'error', message: 'x' });
    expect(loads()).toBe(before + 1);
  });
});

describe('chat failure handling', () => {
  const permission: PermissionRequest = {
    chatId: 'c1',
    requestId: 'r1',
    title: 'Install a font',
    commands: ['brew install font'],
    options: [{ id: 'opt-allow', label: 'Allow', kind: 'allow-once' }],
  };
  const sendFirst = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), text);
    await user.click(screen.getByRole('button', { name: 'Send' }));
  };

  it('restarts the agent session after an error', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await sendFirst(user, 'one');
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(1));
    await emit('c1', { kind: 'error', message: 'crash' });
    const box = screen.getByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, 'two');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(2));
    expect(ipc.agentStart).toHaveBeenCalledTimes(2);
  });

  it.each(['done', 'error'] as const)('clears an open permission card on %s', async (kind) => {
    render(<ChatProject chatId="c1" />);
    await screen.findByRole('textbox', { name: 'Message' });
    await act(async () => {
      handlers.perm.forEach((cb) => cb(permission));
    });
    expect(await screen.findByRole('button', { name: 'Allow' })).toBeInTheDocument();
    await emit('c1', kind === 'done' ? { kind: 'done', stopReason: 'end_turn' } : { kind: 'error', message: 'x' });
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('shows an inline error and keeps the draft and mention when the first send fails', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.createChat).mockRejectedValue(new Error('disk full'));
    render(<ChatRoute />);
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(box, 'remix @');
    await user.keyboard('{Enter}');
    await user.type(box, 'faster');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText("Couldn't start the chat: disk full")).toBeInTheDocument();
    expect(box).toHaveValue('remix faster');
    expect(screen.getByText('1 video attached')).toBeInTheDocument();
    expect(ipc.agentPrompt).not.toHaveBeenCalled();
  });

  it('does not send on Enter when the @ menu has no matches', async () => {
    const user = userEvent.setup();
    render(<ChatRoute />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), '@zzzz');
    await user.keyboard('{Enter}');
    expect(ipc.createChat).not.toHaveBeenCalled();
    expect(ipc.agentPrompt).not.toHaveBeenCalled();
  });
});


describe('Composer attachments', () => {
  const doc = { type: 'file', path: '/tmp/Tayang/p1/attachments/brief.pdf', name: 'brief.pdf', mime: 'application/pdf', size: 2048 } as const;
  const img = { type: 'file', path: '/tmp/Tayang/p1/attachments/shot.png', name: 'shot.png', mime: 'image/png', size: 10 } as const;

  it('opens the picker, copies the files and shows removable chips', async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValue(['/Users/me/brief.pdf', '/Users/me/shot.png']);
    vi.mocked(ipc.attachFile).mockResolvedValueOnce(doc).mockResolvedValueOnce(img);
    render(<ChatProject chatId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Attach files' }));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
    expect(await screen.findByText('brief.pdf')).toBeInTheDocument();
    expect(ipc.attachFile).toHaveBeenCalledWith('c1', '/Users/me/brief.pdf');
    expect(ipc.attachFile).toHaveBeenCalledWith('c1', '/Users/me/shot.png');
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', img.path);
    await user.click(screen.getAllByRole('button', { name: 'Remove file' })[0]!);
    expect(screen.queryByText('brief.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('shot.png')).toBeInTheDocument();
  });

  it('shows the error when a file cannot be attached', async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValue('/Users/me/big.mov');
    vi.mocked(ipc.attachFile).mockRejectedValue('That file is larger than 50 MB');
    render(<ChatProject chatId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Attach files' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is larger than 50 MB');
  });

  it('sends file parts to the agent with the message', async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValue(['/Users/me/brief.pdf']);
    vi.mocked(ipc.attachFile).mockResolvedValue(doc);
    render(<ChatProject chatId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Attach files' }));
    await screen.findByText('brief.pdf');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'use this');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    expect(noFacts(vi.mocked(ipc.agentPrompt).mock.calls[0]![1])).toEqual([doc, { type: 'text', text: 'use this' }]);
    expect(screen.queryByRole('button', { name: 'Remove file' })).not.toBeInTheDocument();
  });

  it('can send attachments without any text', async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValue(['/Users/me/brief.pdf']);
    vi.mocked(ipc.attachFile).mockResolvedValue(doc);
    render(<ChatProject chatId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Attach files' }));
    await screen.findByText('brief.pdf');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
  });

  it('creates the chat first when attaching in a new chat', async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValue(['/Users/me/brief.pdf']);
    vi.mocked(ipc.attachFile).mockResolvedValue(doc);
    render(<ChatRoute />);
    await user.click(await screen.findByRole('button', { name: 'Attach files' }));
    expect(await screen.findByText('brief.pdf')).toBeInTheDocument();
    expect(ipc.attachFile).toHaveBeenCalledWith('c-new', '/Users/me/brief.pdf');
  });

  it('is flat: no inner box around the textarea', async () => {
    render(<ChatProject chatId="c1" />);
    const box = await screen.findByRole('textbox', { name: 'Message' });
    expect(box.className).toContain('bg-transparent');
    expect(box.className).toContain('border-0');
    expect(box.className).toContain('focus-visible:ring-0');
    expect(box.className).toContain('focus-visible:border-transparent');
  });
});

const info = (id: string, name: string, installed: boolean, version: string | null) => ({
  id,
  name,
  installed,
  version,
  acpCommand: [],
  recommended: false,
});

describe('Agent picker', () => {
  beforeEach(() => {
    vi.mocked(ipc.detectAgents).mockResolvedValue([
      info('claude', 'Claude Code', true, '2.1.0'),
      info('opencode', 'opencode', true, '0.9.1'),
      info('codex', 'Codex', false, null),
      info('gemini', 'Gemini CLI', true, '0.4.0'),
      info('custom', 'Your API', false, null),
    ] as never);
    vi.mocked(ipc.updateChatAgent).mockImplementation(async (id, agentId) => ({
      ...chat(id, id === 'c1' ? 'p1' : null),
      agentId,
    }));
  });

  it('a chat without a project: the switch line does not mention project files', async () => {
    const user = userEvent.setup();
    render(<ChatRoute />);
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalled());
    await emit('c-new', { kind: 'done', stopReason: 'end_turn' });
    await user.click(await screen.findByRole('button', { name: /Claude Code/ }));
    await user.click(await screen.findByRole('menuitem', { name: /opencode/ }));
    expect(
      await screen.findByText("Switched to opencode. It starts fresh and doesn't see the earlier messages."),
    ).toBeInTheDocument();
  });

  it('lists the agents without version numbers, a check on the current one, and disables the rest', async () => {
    const user = userEvent.setup();
    render(<ChatProject chatId="c1" />);
    await user.click(await screen.findByRole('button', { name: /Claude Code/ }));
    const current = await screen.findByRole('menuitem', { name: /Claude Code/ });
    expect(current).not.toHaveTextContent('2.1.0');
    expect(within(current).getByTestId('agent-check')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /opencode/ })).not.toHaveAttribute('data-disabled');
    const codex = screen.getByRole('menuitem', { name: /Codex/ });
    expect(codex).toHaveAttribute('data-disabled');
    expect(codex).toHaveTextContent('Not installed');
    // Your API is listed too; before its key is saved it says so instead of "Not installed".
    const api = screen.getByRole('menuitem', { name: /Your API/ });
    expect(api).toHaveAttribute('data-disabled');
    expect(api).toHaveTextContent('Not set up');
    await user.click(screen.getByRole('menuitem', { name: 'Set up agents' }));
    expect(useApp.getState().route).toEqual({ name: 'settings' });
  });

  it('new chat: the pick decides the agent the chat is created and started with', async () => {
    const user = userEvent.setup();
    render(<ChatRoute />);
    await user.click(await screen.findByRole('button', { name: /Claude Code/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Gemini CLI/ }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalledWith('c-new', 'gemini'));
    expect(ipc.createChat).toHaveBeenCalledWith(null, 'gemini', 'hello');
  });

  it('existing chat: switching stops the session, saves, adds the system line, then starts the new agent with a recap once', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.listMessages).mockResolvedValue([
      { id: 'm1', chatId: 'c1', role: 'user', parts: [{ type: 'text', text: 'Make it punchy' }], createdAt: '' },
      { id: 'm2', chatId: 'c1', role: 'agent', parts: [{ type: 'text', text: 'Done, shortened.' }], createdAt: '' },
    ]);
    render(<ChatProject chatId="c1" />);
    await user.click(await screen.findByRole('button', { name: /Claude Code/ }));
    await user.click(await screen.findByRole('menuitem', { name: /opencode/ }));
    await waitFor(() => expect(ipc.updateChatAgent).toHaveBeenCalledWith('c1', 'opencode'));
    expect(ipc.agentStop).toHaveBeenCalledWith('c1');
    expect(
      await screen.findByText(
        "Switched to opencode. It starts fresh: it sees this project's files but not the earlier messages.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /opencode/ })).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Next');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentStart).toHaveBeenCalledWith('c1', 'opencode'));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(1));
    const first = vi.mocked(ipc.agentPrompt).mock.calls[0]![1];
    const flat = first.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    expect(flat).toContain('You: Make it punchy');
    expect(flat).toContain('Agent: Done, shortened.');
    expect(flat).toContain('Next');
    // A non-Claude agent's new session gets the skills first, then the recap, then the message.
    expect(flat).toContain('AskUserQuestion');
    expect(flat.indexOf('AskUserQuestion')).toBeLessThan(flat.indexOf('You: Make it punchy'));
    expect(flat.indexOf('Agent: Done, shortened.')).toBeLessThan(flat.lastIndexOf('Next'));
    await emit('c1', { kind: 'done', stopReason: 'end_turn' } as never);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Again');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(2));
    const second = vi.mocked(ipc.agentPrompt).mock.calls[1]![1];
    expect(JSON.stringify(second)).not.toContain('Make it punchy');
  });

  it('cannot switch while a turn is running', async () => {
    const user = userEvent.setup();
    useChat.setState({ streaming: { c1: true } });
    render(<ChatProject chatId="c1" />);
    const trigger = await screen.findByRole('button', { name: /Claude Code/ });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('the status bar shows the open chat agent only', async () => {
    vi.mocked(ipc.getChat).mockResolvedValue({ ...chat('c1', 'p1'), agentId: 'gemini' });
    const ok = (agentId: 'claude' | 'gemini', usedPercent: number) =>
      ({ agentId, status: 'ok', session: { usedPercent, resetsAt: null }, weekly: null, modelWeekly: null, updatedAt: '', message: null }) as const;
    useUsage.setState({ usage: [ok('claude', 11), ok('gemini', 22)], loaded: true, start: () => {} });
    render(
      <>
        <StatusBar />
        <ChatProject chatId="c1" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('status-agent')).toHaveTextContent('22% used'));
    expect(screen.getByRole('button', { name: 'Gemini CLI usage' })).toBeInTheDocument();
    expect(screen.queryByText(/11% used/)).toBeNull();
  });
});

describe('buildRecap', () => {
  const msg = (role: 'user' | 'agent' | 'system', text: string, i = 0) => ({
    id: `x${i}`,
    chatId: 'c',
    role,
    parts: [{ type: 'text' as const, text }],
    createdAt: '',
  });

  it('keeps the last 6 text messages, oldest first, with You/Agent prefixes', () => {
    const list = Array.from({ length: 8 }, (_, i) => msg(i % 2 ? 'agent' : 'user', `line ${i}`, i));
    list.splice(3, 0, msg('system', 'Switched', 99));
    const recap = buildRecap(list);
    expect(recap).not.toContain('line 1');
    expect(recap).not.toContain('Switched');
    expect(recap.indexOf('You: line 2')).toBeLessThan(recap.indexOf('Agent: line 7'));
  });

  it('strips the frames-checked token', () => {
    const recap = buildRecap([msg('agent', 'Done `[tayang:frames-checked]`\nTwo fixes.', 1)]);
    expect(recap).not.toContain('tayang:frames');
    expect(recap).toBe('Agent: Done\nTwo fixes.');
  });

  it('leaves out A2UI blocks and keeps the prose around them', () => {
    const block = '```a2ui\n{"version":"v0.9","createSurface":{"surfaceId":"s","catalogId":"x"}}\n```';
    const recap = buildRecap([msg('agent', `Pick one:\n${block}\nThen tell me.`, 1), msg('agent', block, 2)]);
    expect(recap).toBe('Agent: Pick one:\n\nThen tell me.');
    expect(recap).not.toContain('createSurface');
  });

  it('leaves out thoughts and tools', () => {
    const m = {
      id: 'a',
      chatId: 'c',
      role: 'agent' as const,
      parts: [
        { type: 'thought' as const, text: 'secret musing' },
        { type: 'tool' as const, toolCallId: 't', title: 'Run ls', status: 'done' as const },
        { type: 'text' as const, text: 'Hello' },
      ],
      createdAt: '',
    };
    expect(buildRecap([m])).toBe('Agent: Hello');
  });

  it('stays within 1,500 characters and skips messages without text', () => {
    const big = 'x'.repeat(900);
    const list = [msg('user', big, 1), msg('agent', big, 2), msg('user', big, 3)];
    list.push({ id: 'f', chatId: 'c', role: 'user', parts: [] as never, createdAt: '' });
    expect(buildRecap(list).length).toBeLessThanOrEqual(1500);
    expect(buildRecap([])).toBe('');
  });
});
