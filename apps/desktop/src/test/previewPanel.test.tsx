import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { Chat, Project } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  getChat: vi.fn(),
  listProjects: vi.fn(),
  listMessages: vi.fn().mockResolvedValue([]),
  renderCommand: vi.fn().mockResolvedValue(null),
  latestRenderInfo: vi.fn().mockResolvedValue({ path: "/p/renders/a.mp4", name: "a.mp4", size: 1, modifiedAt: "2026-11-16T13:30:00.000Z" }),
  mediaLatestRender: vi.fn().mockResolvedValue(null),
  mediaProbe: vi.fn().mockResolvedValue(null),
  mediaThumbnails: vi.fn().mockResolvedValue([]),
  mediaRender: vi.fn(),
  assetUrl: (p: string) => p,
  projectFiles: vi.fn(async () => []),
  findProjectFiles: vi.fn(async () => []),
  readProjectFile: vi.fn(),
}));
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}), onAgentUpdate: vi.fn(async () => () => {}), onPermission: vi.fn(async () => () => {}) }));

import * as ipc from '@/lib/ipc';
import { ChatProject } from '@/screens/ChatProject';
import { CHAT_MIN, PREVIEW, SIDEBAR, layoutKey, useLayout } from '@/state/layout';

const project: Project = {
  id: 'p1',
  title: 'Kenapa rupiah melemah?',
  slug: 'p1',
  folder: '/tmp/p1',
  kind: 'explainer',
  format: '9:16',
  language: 'id',
  status: 'draft',
  styleId: null,
  scheduledAt: null, reviewState: 'none', postedAt: null, remindedAt: null, reviewRemindedAt: null,
  durationSec: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};
const chat = { id: 'c1', projectId: 'p1', agentId: 'claude', title: 't', createdAt: '', updatedAt: '' } as unknown as Chat;

async function renderChat() {
  const view = render(<ChatProject chatId="c1" />);
  const handle = await screen.findByRole('separator', { name: 'Resize preview' });
  return { view, handle, panel: document.getElementById('chat-preview')! };
}

function drag(handle: HTMLElement, from: number, to: number) {
  handle.setPointerCapture = () => {};
  fireEvent.pointerDown(handle, { clientX: from, pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: to, pointerId: 1, buttons: 1 });
  fireEvent.pointerUp(handle, { clientX: to, pointerId: 1 });
}

describe('project chat preview panel', () => {
  beforeEach(() => {
    localStorage.clear();
    // These are about the preview: the file sidebar (its own tests) is closed.
    localStorage.setItem(layoutKey(), JSON.stringify({ filesOpen: false }));
    window.innerWidth = 1600;
    useLayout.getState().hydrate();
    vi.mocked(ipc.getChat).mockResolvedValue(chat);
    vi.mocked(ipc.listProjects).mockResolvedValue([project]);
  });

  it('opens at 380 px with a handle on its left edge', async () => {
    const { handle, panel } = await renderChat();
    expect(panel.style.width).toBe(`${PREVIEW.default}px`);
    expect(handle).toHaveAttribute('aria-controls', 'chat-preview');
    expect(handle).toHaveAttribute('aria-valuemin', String(PREVIEW.min));
    expect(handle).toHaveAttribute('aria-valuemax', String(PREVIEW.max));
    expect(handle.className).toMatch(/left-0/);
  });

  it('grows when dragged left, up to its max, and saves the width', async () => {
    const { handle, panel } = await renderChat();
    drag(handle, 1000, 900);
    expect(panel.style.width).toBe('480px');
    drag(handle, 900, 100);
    expect(panel.style.width).toBe(`${PREVIEW.max}px`);
    expect(JSON.parse(localStorage.getItem(layoutKey())!)).toMatchObject({ preview: PREVIEW.max });
    drag(handle, 100, 1500);
    expect(panel.style.width).toBe(`${PREVIEW.min}px`);
  });

  it('keyboard: arrows by 16 px, Home and End to min and max; double-click resets', async () => {
    const { handle, panel } = await renderChat();
    handle.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(panel.style.width).toBe(`${PREVIEW.default + 16}px`);
    await userEvent.keyboard('{Home}');
    expect(panel.style.width).toBe(`${PREVIEW.min}px`);
    await userEvent.keyboard('{End}');
    expect(panel.style.width).toBe(`${PREVIEW.max}px`);
    fireEvent.doubleClick(handle);
    expect(panel.style.width).toBe(`${PREVIEW.default}px`);
  });

  it('caps at 55% of the window and leaves the chat its 420 px', async () => {
    window.innerWidth = 1200;
    useLayout.getState().hydrate();
    const { handle, panel } = await renderChat();
    const max = 1200 - SIDEBAR.default - CHAT_MIN;
    expect(handle).toHaveAttribute('aria-valuemax', String(max));
    drag(handle, 800, 0);
    expect(panel.style.width).toBe(`${max}px`);
    expect(screen.getByRole('region', { name: 'Conversation' }).className).toMatch(/min-w-0/);
  });

  it('shrinks to make room for the chat in a narrow window', async () => {
    window.innerWidth = 1000;
    useLayout.getState().hydrate();
    const { panel } = await renderChat();
    expect(panel.style.width).toBe(`${1000 - SIDEBAR.default - CHAT_MIN}px`);
  });

  it('has its width from the first paint', () => {
    render(<ChatProject chatId="c1" />);
    expect(screen.getByRole('region', { name: 'Preview' }).style.width).toBe(`${PREVIEW.default}px`);
  });

  it('shows the file sidebar next to the preview, and its button hides it and remembers', async () => {
    localStorage.setItem(layoutKey(), JSON.stringify({}));
    useLayout.getState().hydrate();
    await renderChat();
    expect(screen.getByRole('complementary', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize files' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide files' }));
    expect(screen.queryByRole('complementary', { name: 'Files' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(layoutKey())!)).toMatchObject({ filesOpen: false });
    expect(screen.getByRole('button', { name: 'Show files' })).toHaveAttribute('aria-pressed', 'false');
  });
});
