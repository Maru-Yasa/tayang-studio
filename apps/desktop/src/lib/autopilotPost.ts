import type { Autopilot, AutopilotSlot, Project } from '@tayang/shared';
import { socialPost } from '@/lib/cloud';
import { approveProject, listAutopilots, listSlots, updateSlot } from '@/lib/ipc';
import { captionOf, readPostDraft } from '@/lib/postDraft';
import { stored } from '@/lib/stored';

const EPOCH = '1970-01-01T00:00:00Z';
const FOREVER = '9999-12-31T23:59:59Z';

/**
 * Hands a finished video to auto-posting: at the slot's time, or now when that has passed. The post's
 * request id comes from the video, so posting one video again can never make a second post.
 * Resolves to the stored error to keep on the slot, or null. The video stays either way.
 */
export async function postAutopilotVideo(project: Pick<Project, 'id' | 'title'>, autopilot: Autopilot, dueAt: string, now = new Date()): Promise<string | null> {
  if (autopilot.posting !== 'automatic' || !autopilot.socialAccountIds.length) return null;
  try {
    const draft = await readPostDraft(project.id);
    await socialPost({
      projectId: project.id,
      title: draft?.title || project.title,
      caption: (draft && captionOf(draft)) || project.title,
      accountIds: autopilot.socialAccountIds,
      scheduledAt: Date.parse(dueAt) > now.getTime() ? new Date(dueAt).toISOString() : null,
      clientRequestId: `ap-${project.id}`,
    });
    return null;
  } catch (e) {
    console.error('Tayang: autopilot post failed', e);
    return stored('autopilot.slot.postFailed');
  }
}

/** Approve, then post the video when it came from an autopilot that posts. A failed post is kept on its slot. */
export async function approveAndPost(projectId: string, now = new Date()): Promise<Project> {
  const project = await approveProject(projectId);
  if (project.socialPostId) return project;
  const slots: AutopilotSlot[] = await listSlots(EPOCH, FOREVER).catch(() => []);
  const slot = slots.find((s) => s.projectId === projectId);
  if (!slot) return project;
  const autopilot = (await listAutopilots().catch(() => [])).find((a) => a.id === slot.autopilotId);
  if (!autopilot) return project;
  const error = await postAutopilotVideo(project, autopilot, slot.dueAt, now);
  await updateSlot(slot.id, { error }).catch(() => {});
  return project;
}
