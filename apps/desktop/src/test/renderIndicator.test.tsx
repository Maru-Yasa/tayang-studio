import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { Project } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  assetUrl: (p: string) => p,
  latestRenderInfo: vi.fn().mockResolvedValue({ path: "/p/renders/a.mp4", name: "a.mp4", size: 1, modifiedAt: "2026-11-16T13:30:00.000Z" }),
  mediaLatestRender: vi.fn().mockResolvedValue(null),
  mediaProbe: vi.fn().mockResolvedValue(null),
  mediaThumbnails: vi.fn().mockResolvedValue([]),
  mediaExtractFrame: vi.fn(),
  mediaRender: vi.fn(),
  setProjectStatus: vi.fn().mockResolvedValue({ id: 'p1', status: 'rendered' }),
  listProjects: vi.fn(),
  listChats: vi.fn().mockResolvedValue([]),
  createChat: vi.fn(),
}));
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}), onAgentUpdate: vi.fn(async () => () => {}), onPermission: vi.fn(async () => () => {}) }));

import { listProjects, mediaLatestRender, mediaRender, setProjectStatus } from '@/lib/ipc';
import { Preview } from '@/screens/preview/Preview';
import { Videos } from '@/screens/Videos';
import { setUiLanguage } from '@/i18n';
import { useRender } from '@/state/render';

const proj = (id: string, title: string): Project => ({
  id, title, slug: id, folder: `/w/${id}`, kind: 'explainer', format: '9:16', language: 'id', status: 'building',
  styleId: null, scheduledAt: null, reviewState: 'none', postedAt: null, remindedAt: null, reviewRemindedAt: null,
  durationSec: null, createdAt: 'c', updatedAt: new Date().toISOString(),
});

beforeEach(() => {
  vi.clearAllMocks();
  useRender.setState({ runs: {} });
});

describe('Preview while a render runs', () => {
  it('shows the banner with the time, then loads the new render when it ends', async () => {
    render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByText('Nothing rendered yet');
    expect(screen.queryByRole('status')).toBeNull();
    const loads = () => vi.mocked(mediaLatestRender).mock.calls.length;
    const before = loads();
    act(() => useRender.getState().start('p1', { source: 'agent', chatId: 'c1', toolCallId: 't1', startedAt: Date.now() - 80_000 }));
    expect(screen.getByRole('status')).toHaveTextContent('Rendering video… 1m 20s');
    expect(screen.getByRole('status')).toHaveTextContent("The preview updates when it's done");
    // Renders of other projects are not this one's.
    act(() => useRender.getState().start('p2', { source: 'agent' }));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    act(() => useRender.getState().end('p1'));
    await waitFor(() => expect(loads()).toBe(before + 1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reads in Indonesian', async () => {
    setUiLanguage('id');
    useRender.getState().start('p1', { source: 'tayang', startedAt: Date.now() - 80_000 });
    render(<Preview projectId="p1" chatId="c1" />);
    expect(await screen.findByRole('status')).toHaveTextContent('Sedang merender video… 1 mnt 20 dtk');
    expect(screen.getByRole('status')).toHaveTextContent('Pratinjau diperbarui setelah selesai');
  });

  it("Tayang's own Render button counts as a render while it runs", async () => {
    let done!: () => void;
    vi.mocked(mediaRender).mockReturnValue(new Promise((r) => (done = () => r('/w/p1/renders/a.mp4'))));
    render(<Preview projectId="p1" chatId="c1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Render preview' }));
    expect(useRender.getState().runs.p1).toMatchObject({ source: 'tayang' });
    expect(screen.getByRole('status')).toHaveTextContent('Rendering video…');
    await act(async () => done());
    expect(useRender.getState().runs.p1).toBeUndefined();
    expect(setProjectStatus).toHaveBeenCalledWith('p1', 'rendered');
  });
});

describe('Videos while a render runs', () => {
  it('shows the rendering video as rendering on its card', async () => {
    vi.mocked(listProjects).mockResolvedValue([proj('p1', 'Jalur Rempah'), proj('p2', 'Kopi')]);
    useRender.getState().start('p1', { source: 'agent' });
    render(<Videos />);
    await screen.findAllByText('Kopi');
    expect(screen.getAllByText('Rendering…')).toHaveLength(1);
    act(() => useRender.getState().end('p1'));
    expect(screen.queryByText('Rendering…')).toBeNull();
  });
});
