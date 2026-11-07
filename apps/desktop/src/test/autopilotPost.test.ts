import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Autopilot, AutopilotSlot, Project } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  approveProject: vi.fn(),
  listAutopilots: vi.fn(),
  listSlots: vi.fn(),
  readProjectFile: vi.fn(),
  updateSlot: vi.fn(),
}));
vi.mock('@/lib/cloud', () => ({ socialPost: vi.fn() }));

import { approveAndPost, postAutopilotVideo } from '@/lib/autopilotPost';
import { socialPost } from '@/lib/cloud';
import * as ipc from '@/lib/ipc';
import { dueReminders } from '@/lib/reminders';
import { localized } from '@/lib/stored';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const FUTURE = '2026-11-06T12:00:00.000Z';
const pilot = { id: 'a1', posting: 'automatic', socialAccountIds: ['sa_1', 'sa_2'] } as Autopilot;
const video = { id: 'p1', title: 'Why coffee is bitter' };
const slot = { id: 's1', autopilotId: 'a1', dueAt: FUTURE, projectId: 'p1', status: 'done', error: null } as AutopilotSlot;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(ipc.readProjectFile).mockRejectedValue(new Error('no file'));
  vi.mocked(socialPost).mockResolvedValue({ postId: 'x', status: 'scheduled', postsCharged: 2 } as never);
  vi.mocked(ipc.approveProject).mockResolvedValue({ ...video, socialPostId: null } as Project);
  vi.mocked(ipc.listSlots).mockResolvedValue([slot]);
  vi.mocked(ipc.listAutopilots).mockResolvedValue([pilot]);
  vi.mocked(ipc.updateSlot).mockResolvedValue(slot);
});

describe('postAutopilotVideo', () => {
  it("schedules for the slot's time, with the agent's post.json and a request id from the video", async () => {
    vi.mocked(ipc.readProjectFile).mockResolvedValue({ text: JSON.stringify({ title: 'Bitter?', description: 'The reason', hashtags: ['kopi'] }) } as never);
    expect(await postAutopilotVideo(video, pilot, FUTURE, NOW)).toBeNull();
    expect(socialPost).toHaveBeenCalledWith({
      projectId: 'p1',
      title: 'Bitter?',
      caption: 'The reason\n\n#kopi',
      accountIds: ['sa_1', 'sa_2'],
      scheduledAt: FUTURE,
      clientRequestId: 'ap-p1',
    });
  });

  it('posts now when the time has passed, and falls back to the title without a post.json', async () => {
    await postAutopilotVideo(video, pilot, '2026-11-06T09:00:00.000Z', NOW);
    expect(socialPost).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: null, caption: video.title, title: video.title }));
  });

  it('does nothing for an autopilot that posts by hand', async () => {
    expect(await postAutopilotVideo(video, { ...pilot, posting: 'manual', socialAccountIds: [] }, FUTURE, NOW)).toBeNull();
    expect(socialPost).not.toHaveBeenCalled();
  });

  it('answers with a stored error when the post fails, instead of throwing', async () => {
    vi.mocked(socialPost).mockRejectedValue(new Error('plan_required'));
    const error = await postAutopilotVideo(video, pilot, FUTURE, NOW);
    expect(localized(error!)).toMatch(/couldn't be posted/);
  });
});

describe('approveAndPost', () => {
  it("approves, then posts an autopilot's video", async () => {
    await approveAndPost('p1', NOW);
    expect(ipc.approveProject).toHaveBeenCalledWith('p1');
    expect(socialPost).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', scheduledAt: FUTURE }));
    expect(ipc.updateSlot).toHaveBeenCalledWith('s1', { error: null });
  });

  it('only approves a video from no autopilot, or one already posted', async () => {
    vi.mocked(ipc.listSlots).mockResolvedValue([]);
    await approveAndPost('p1', NOW);
    vi.mocked(ipc.approveProject).mockResolvedValue({ ...video, socialPostId: 'old' } as Project);
    await approveAndPost('p1', NOW);
    expect(socialPost).not.toHaveBeenCalled();
  });

  it('stays approved and keeps the error on the slot when the post fails', async () => {
    vi.mocked(socialPost).mockRejectedValue(new Error('provider'));
    const p = await approveAndPost('p1', NOW);
    expect(p.id).toBe('p1');
    expect(localized(vi.mocked(ipc.updateSlot).mock.calls[0]![1].error!)).toMatch(/couldn't be posted/);
  });
});

describe('reminders', () => {
  it('never says "time to post" for a video already handed to auto-posting', () => {
    const base = { id: 'p', scheduledAt: '2026-11-06T09:59:00.000Z', postedAt: null, remindedAt: null, reviewState: 'approved' };
    expect(dueReminders([{ ...base, socialPostId: 'x' } as Project], NOW)).toEqual([]);
    expect(dueReminders([{ ...base, socialPostId: null } as Project], NOW)).toHaveLength(1);
  });
});
