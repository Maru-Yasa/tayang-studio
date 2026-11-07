import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { RecentChat } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  listRecentChats: vi.fn(),
  listArchivedChats: vi.fn().mockResolvedValue([]),
  setThreadArchived: vi.fn().mockResolvedValue(undefined),
  purgeArchive: vi.fn().mockResolvedValue({ chats: 0, cards: 0 }),
  setJobsArchived: vi.fn().mockResolvedValue(undefined),
}));

import { listRecentChats } from '@/lib/ipc';
import { Sidebar } from '@/components/Sidebar';
import { useApp } from '@/state/app';

const mk = (id: string, title: string, projectTitle: string | null): RecentChat => ({
  id,
  projectId: projectTitle ? `p-${id}` : null,
  agentId: 'claude',
  title,
  createdAt: '2026-11-01T00:00:00Z',
  projectTitle,
  activeAt: '2026-11-01T00:00:00Z',
});

describe('Sidebar', () => {
  beforeEach(() => {
    vi.mocked(listRecentChats).mockResolvedValue([
      mk('a', 'chat a', 'Kenapa rupiah melemah?'),
      mk('b', 'Ide konten minggu ini', null),
      mk('c', 'chat c', 'Promo Kopi Senja'),
    ]);
  });

  it('marks the active item, shows New chat and recent chats', async () => {
    render(<Sidebar active="videos" />);
    expect(screen.getByRole('link', { name: /^Videos/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /^Chat/ })).not.toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('New chat')).toBeInTheDocument();
    expect(await screen.findByText('Kenapa rupiah melemah?')).toBeInTheDocument();
    expect(screen.getByText('Ide konten minggu ini')).toBeInTheDocument();
    expect(screen.getByText('Promo Kopi Senja')).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('shows the needs-you count on Agents only when above zero', () => {
    useApp.setState({ needsYouCount: 2 });
    const { unmount } = render(<Sidebar active="chat" />);
    expect(screen.getByRole('link', { name: /^Agents/ })).toHaveTextContent('2');
    unmount();
    useApp.setState({ needsYouCount: 0 });
    render(<Sidebar active="chat" />);
    expect(screen.getByRole('link', { name: /^Agents/ })).not.toHaveTextContent(/\d/);
  });

  it('has Autopilot between Style and Agents, and it opens the Autopilot screen', async () => {
    useApp.setState({ route: { name: 'videos' }, leaveGuard: null });
    render(<Sidebar active="autopilot" />);
    const names = screen.getAllByRole('link').map((l) => l.textContent);
    expect(names.indexOf('Autopilot')).toBe(names.indexOf('Style') + 1);
    expect(names.indexOf('Agents')).toBe(names.indexOf('Autopilot') + 1);
    expect(screen.getByRole('link', { name: 'Autopilot' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(screen.getByRole('link', { name: 'Autopilot' }));
    expect(useApp.getState().route).toEqual({ name: 'autopilot' });
  });
});

describe('leave guard', () => {
  it('a guard that says no keeps the route; removing it lets navigation through', () => {
    useApp.setState({ route: { name: 'autopilot-wizard' }, leaveGuard: null });
    const guard = vi.fn(() => false);
    useApp.getState().setLeaveGuard(guard);
    useApp.getState().navigate({ name: 'videos' });
    expect(guard).toHaveBeenCalledWith({ name: 'videos' });
    expect(useApp.getState().route).toEqual({ name: 'autopilot-wizard' });
    useApp.getState().setLeaveGuard(null);
    useApp.getState().navigate({ name: 'videos' });
    expect(useApp.getState().route).toEqual({ name: 'videos' });
  });
});
