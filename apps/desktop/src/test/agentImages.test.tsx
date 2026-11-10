import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { AgentUpdate, ChatMessage, FileInfo, MessagePart } from '@tayang/shared';

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
  recentImages: vi.fn().mockResolvedValue([]),
  assetUrl: (p: string) => `asset://${p}`,
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
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn().mockResolvedValue(undefined) }));

import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { addMessage, agentPrompt, recentImages } from '@/lib/ipc';
import { MessageList } from '@/components/MessageList';
import { setUiLanguage } from '@/i18n';
import { buildRecap, useChat } from '@/state/chat';

const emit = (update: AgentUpdate, chatId = 'c1') => act(async () => updates.forEach((cb) => cb({ chatId, update })));
const img = (name: string, at = '2026-11-04T10:00:01.000Z'): FileInfo => ({ path: `/w/p1/art/${name}`, name, size: 10, modifiedAt: at });
const agentParts = (chatId = 'c1') => useChat.getState().messages[chatId]!.filter((m) => m.role === 'agent').at(-1)!.parts;
const files = (chatId = 'c1') => agentParts(chatId).filter((p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file');
const toolDone = (id: string) => emit({ kind: 'tool', toolCallId: id, title: 'Run node draw.js', status: 'done', toolKind: 'execute' });

describe('images the agent makes during a turn', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    updates.length = 0;
    useChat.getState().reset();
    useChat.getState().listen();
    await useChat.getState().send('c1', [{ type: 'text', text: 'draw 4 illustrations' }], { agentId: 'claude', job: { projectId: 'p1', title: 'V' } });
    await emit({ kind: 'text', text: 'Sekarang saya gambar 4 ilustrasi…' });
  });
  const agentMessages = () => useChat.getState().messages.c1!.filter((m) => m.role === 'agent');
  const savedAgentParts = () => vi.mocked(addMessage).mock.calls.filter(([, role]) => role === 'agent').map(([, , parts]) => parts);
  afterEach(() => vi.useRealTimers());

  it('are added to the agent message 500 ms after a step finishes, oldest first, then kept up to date', async () => {
    vi.mocked(recentImages).mockResolvedValue([img('b.png', '2026-11-04T10:00:02.000Z'), img('a.png')]);
    await toolDone('t1');
    expect(recentImages).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    const since = useChat.getState().turnStartedAt.c1!;
    expect(recentImages).toHaveBeenCalledWith('c1', expect.any(String), 50);
    // A second early, for file systems with coarse times.
    expect(Math.abs(Date.parse(vi.mocked(recentImages).mock.calls[0]![1]) - (since - 1000))).toBeLessThan(50);
    expect(files().map((f) => f.name)).toEqual(['a.png', 'b.png']);
    expect(files()[0]).toEqual({ type: 'file', path: '/w/p1/art/a.png', name: 'a.png', mime: 'image/png', size: 10, modifiedAt: '2026-11-04T10:00:01.000Z' });

    // The same files again: nothing new. a.png rewritten: updated where it is. c.jpg new: at the end.
    vi.mocked(recentImages).mockResolvedValue([img('c.JPG', '2026-11-04T10:00:05.000Z'), img('a.png', '2026-11-04T10:00:04.000Z'), img('b.png', '2026-11-04T10:00:02.000Z')]);
    await toolDone('t2');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(files().map((f) => [f.name, f.modifiedAt])).toEqual([
      ['a.png', '2026-11-04T10:00:04.000Z'],
      ['b.png', '2026-11-04T10:00:02.000Z'],
      ['c.JPG', '2026-11-04T10:00:05.000Z'],
    ]);
    expect(files()[2]!.mime).toBe('image/jpeg');
  });

  it('settles quick steps into one lookup, and never runs two at once', async () => {
    let release!: () => void;
    vi.mocked(recentImages).mockImplementationOnce(() => new Promise((r) => (release = () => r([img('a.png')]))));
    await toolDone('t1');
    await toolDone('t2');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(recentImages).toHaveBeenCalledTimes(1);
    await toolDone('t3');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    // The second waits for the first.
    expect(recentImages).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(recentImages).toHaveBeenCalledTimes(2));
  });

  it('looks once more when the turn ends, and stores the message with the images', async () => {
    vi.mocked(recentImages).mockResolvedValue([img('final.webp')]);
    await emit({ kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(addMessage).toHaveBeenCalledWith('c1', 'agent', expect.anything()));
    const stored = vi.mocked(addMessage).mock.calls.find(([, role]) => role === 'agent')![2];
    expect(stored).toContainEqual(expect.objectContaining({ type: 'file', name: 'final.webp', mime: 'image/webp' }));
  });

  it('adds nothing in a chat without a project folder (Rust finds none there)', async () => {
    vi.mocked(recentImages).mockResolvedValue([]);
    await toolDone('t1');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(files()).toEqual([]);
  });

  it('never looks in a chat that is not a video\'s chat', async () => {
    await useChat.getState().send('c2', [{ type: 'text', text: 'hi' }], { agentId: 'claude' });
    await emit({ kind: 'text', text: 'Hello' }, 'c2');
    await emit({ kind: 'tool', toolCallId: 'x', title: 'Run ls', status: 'done', toolKind: 'execute' }, 'c2');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await emit({ kind: 'done', stopReason: 'end_turn' }, 'c2');
    await waitFor(() => expect(addMessage).toHaveBeenCalledWith('c2', 'agent', expect.anything()));
    expect(recentImages).not.toHaveBeenCalled();
  });

  it('a send right after the turn ends never takes that turn\'s images or its save', async () => {
    let release!: (found: FileInfo[]) => void;
    vi.mocked(recentImages).mockImplementationOnce(() => new Promise((r) => (release = r)));
    await emit({ kind: 'done', stopReason: 'end_turn' });
    const firstSince = Date.parse(vi.mocked(recentImages).mock.calls[0]![1]);
    const [first] = agentMessages();
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await useChat.getState().send('c1', [{ type: 'text', text: 'one more' }], { agentId: 'claude' });
    // The finished turn's message is saved before the new message, so a reload keeps the order.
    const roles = vi.mocked(addMessage).mock.calls.map(([, role]) => role);
    expect(roles.slice(-2)).toEqual(['agent', 'user']);
    await emit({ kind: 'text', text: 'Okay' });
    await act(async () => release([img('old.png')]));
    expect(agentMessages()).toHaveLength(2);
    expect(files()).toEqual([]);
    expect(JSON.stringify(savedAgentParts())).not.toContain('old.png');
    expect(agentMessages()[0]!.id).toBe(first!.id);
    // The new turn looks from its own start.
    vi.mocked(recentImages).mockResolvedValue([]);
    await toolDone('t9');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(Date.parse(vi.mocked(recentImages).mock.calls.at(-1)![1])).toBeGreaterThan(firstSince);
  });

  it('images from a last lookup that ends after the message was saved still show on it', async () => {
    let n = 0;
    vi.mocked(addMessage).mockImplementation(async (chatId, role, parts) => ({ id: `saved-${++n}`, chatId, role, parts, createdAt: '' }));
    try {
      let release!: (found: FileInfo[]) => void;
      vi.mocked(recentImages).mockImplementationOnce(() => new Promise((r) => (release = r)));
      await emit({ kind: 'done', stopReason: 'end_turn' });
      await useChat.getState().send('c1', [{ type: 'text', text: 'one more' }], { agentId: 'claude' });
      await waitFor(() => expect(agentMessages()[0]!.id).toMatch(/^saved-/));
      await act(async () => release([img('late.png')]));
      const first = agentMessages()[0]!;
      expect(first.parts.some((p) => p.type === 'file' && p.name === 'late.png')).toBe(true);
    } finally {
      vi.mocked(addMessage).mockResolvedValue(null as never);
    }
  });

  it('a slow last lookup still lands on its own turn\'s message when nobody sends', async () => {
    let release!: (found: FileInfo[]) => void;
    vi.mocked(recentImages).mockImplementationOnce(() => new Promise((r) => (release = r)));
    await emit({ kind: 'done', stopReason: 'end_turn' });
    expect(savedAgentParts()).toEqual([]);
    await act(async () => release([img('late.png')]));
    await waitFor(() => expect(savedAgentParts()).toHaveLength(1));
    expect(JSON.stringify(savedAgentParts()[0])).toContain('late.png');
  });

  it('saves the message within 5 s when the last lookup hangs, and later lookups still run', async () => {
    vi.mocked(recentImages).mockImplementationOnce(() => new Promise(() => {}));
    await emit({ kind: 'done', stopReason: 'end_turn' });
    await act(async () => vi.advanceTimersByTimeAsync(4900));
    expect(savedAgentParts()).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(savedAgentParts()).toHaveLength(1);
    vi.mocked(recentImages).mockResolvedValue([img('next.png')]);
    await useChat.getState().send('c1', [{ type: 'text', text: 'again' }], { agentId: 'claude' });
    await emit({ kind: 'text', text: 'Sure' });
    await toolDone('t2');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await waitFor(() => expect(files().map((f) => f.name)).toEqual(['next.png']));
  });

  it('adds the images to the agent message when the turn fails, after the error line', async () => {
    vi.mocked(recentImages).mockResolvedValue([img('a.png')]);
    await emit({ kind: 'error', message: 'boom' });
    await waitFor(() => expect(files().map((f) => f.name)).toEqual(['a.png']));
    expect(useChat.getState().messages.c1!.at(-1)!.role).toBe('system');
  });

  it('ignores a step that finishes after the turn ended', async () => {
    vi.mocked(recentImages).mockResolvedValue([]);
    await emit({ kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(savedAgentParts()).toHaveLength(1));
    vi.mocked(recentImages).mockClear();
    await toolDone('late');
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(recentImages).not.toHaveBeenCalled();
  });

  it('never goes to the agent: not in a recap, not in the next prompt', async () => {
    vi.mocked(recentImages).mockResolvedValue([img('a.png')]);
    await emit({ kind: 'done', stopReason: 'end_turn' });
    await waitFor(() => expect(files()).toHaveLength(1));
    expect(buildRecap(useChat.getState().messages.c1!)).not.toContain('a.png');
    vi.mocked(agentPrompt).mockClear();
    await useChat.getState().send('c1', [{ type: 'text', text: 'nice' }], { agentId: 'claude' });
    expect(JSON.stringify(vi.mocked(agentPrompt).mock.calls[0]![1])).not.toContain('a.png');
  });
});

describe('the image strip', () => {
  const user: ChatMessage = { id: 'u', chatId: 'c1', role: 'user', parts: [{ type: 'text', text: 'go' }], createdAt: '' };
  const part = (i: number): MessagePart => ({ type: 'file', path: `/w/p1/art/s${i}.png`, name: `s${i}.png`, mime: 'image/png', size: 5, modifiedAt: `2026-11-04T10:00:0${i % 10}.000Z` });
  const agent = (n: number): ChatMessage => ({
    id: 'a', chatId: 'c1', role: 'agent', createdAt: '',
    parts: [{ type: 'text', text: 'Here they are' }, ...Array.from({ length: n }, (_, i) => part(i + 1))],
  });
  beforeEach(() => useChat.getState().reset());

  it('shows 96 px lazy thumbnails after the text, 8 at most, then +N more', async () => {
    render(<MessageList messages={[user, agent(10)]} streaming={false} />);
    const strip = screen.getByRole('group', { name: 'Images the agent made' });
    const thumbs = within(strip).getAllByRole('img');
    expect(thumbs).toHaveLength(8);
    expect(thumbs[0]).toHaveAttribute('src', `asset:///w/p1/art/s1.png?v=${encodeURIComponent('2026-11-04T10:00:01.000Z')}`);
    expect(thumbs[0]).toHaveAttribute('alt', 's1.png');
    expect(thumbs[0]).toHaveAttribute('loading', 'lazy');
    expect(thumbs[0]).toHaveAttribute('decoding', 'async');
    expect(thumbs[0]!.className).toContain('h-24');
    // Order: the words first, then the strip.
    const text = screen.getByText('Here they are');
    expect(text.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(within(strip).getByRole('button', { name: '+2 more' }));
    expect(within(strip).getAllByRole('img')).toHaveLength(10);
  });

  it('opens a lightbox that steps through the message and closes back to the thumbnail', async () => {
    render(<MessageList messages={[user, agent(3)]} streaming={false} />);
    const first = screen.getByRole('button', { name: 'Open image s1.png' });
    await userEvent.click(first);
    const dialog = await screen.findByRole('dialog', { name: 's1.png' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next image' }));
    expect(screen.getByRole('dialog', { name: 's2.png' })).toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 's3.png' })).toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 's1.png' })).toBeInTheDocument();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 's3.png' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(screen.getByRole('dialog', { name: 's2.png' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open in folder' }));
    expect(revealItemInDir).toHaveBeenCalledWith('/w/p1/art/s2.png');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(first).toHaveFocus();
  });

  it('tries once more, then shows a muted tile, never a broken image, when the file is gone', () => {
    render(<MessageList messages={[user, agent(2)]} streaming={false} />);
    const strip = screen.getByRole('group', { name: 'Images the agent made' });
    // A file still being written can fail once: it is read again before giving up.
    fireEvent.error(within(strip).getAllByRole('img')[0]!);
    expect(within(strip).getAllByRole('img')[0]!.getAttribute('src')).toMatch(/[?&]r=1$/);
    expect(within(strip).queryByText('Image no longer available')).toBeNull();
    fireEvent.error(within(strip).getAllByRole('img')[0]!);
    expect(within(strip).getByText('Image no longer available')).toBeInTheDocument();
    expect(within(strip).getAllByRole('img')).toHaveLength(1);
  });

  it('returns focus to the thumbnail after a mouse click opened the lightbox', async () => {
    render(<MessageList messages={[user, agent(2)]} streaming={false} />);
    const second = screen.getByRole('button', { name: 'Open image s2.png' });
    // WebKit does not focus a button on a mouse click.
    fireEvent.click(second);
    expect(second).not.toHaveFocus();
    await screen.findByRole('dialog', { name: 's2.png' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(second).toHaveFocus();
  });

  it('steps from a missing image straight to the next one', async () => {
    render(<MessageList messages={[user, agent(2)]} streaming={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open image s1.png' }));
    const dialog = await screen.findByRole('dialog', { name: 's1.png' });
    fireEvent.error(within(dialog).getByRole('img'));
    fireEvent.error(within(dialog).getByRole('img'));
    expect(within(dialog).getByText('Image no longer available')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next image' }));
    const next = screen.getByRole('dialog', { name: 's2.png' });
    expect(within(next).queryByText('Image no longer available')).toBeNull();
    expect(within(next).getByRole('img')).toHaveAttribute('alt', 's2.png');
  });

  it('reads in Indonesian', async () => {
    setUiLanguage('id');
    render(<MessageList messages={[user, agent(9)]} streaming={false} />);
    expect(screen.getByRole('group', { name: 'Gambar buatan agen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+1 lagi' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Buka gambar s1.png' }));
    expect(await screen.findByRole('button', { name: 'Gambar berikutnya' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buka di folder' })).toBeInTheDocument();
  });
});
