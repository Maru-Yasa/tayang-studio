import type { Project } from '@tayang/shared';

/** A video that still needs its review is flagged this long before it is due. */
export const REVIEW_LEAD_MS = 2 * 3_600_000;
/** Reminders missed while Tayang was closed still show once on launch, for this long after the due time. */
export const MISSED_WINDOW_MS = 24 * 3_600_000;

export interface Reminder {
  project: Project;
  /** `review`: still waiting for approval, due soon. `post`: time to post it. */
  kind: 'review' | 'post';
  /** A review reminder after the due time: the video is overdue and still waiting. */
  late: boolean;
  /** The project field to stamp once the reminder was shown, so it fires only once. */
  stamp: 'reviewRemindedAt' | 'remindedAt';
}

/**
 * Which reminders are due at `now`, earliest due time first. A video waiting for approval only gets the
 * review reminder (from two hours before it is due, and on through the due time); every other scheduled
 * video not already handed to auto-posting gets "time to post" at its due time. Posted videos, unscheduled ones, ones already reminded and
 * ones more than 24 hours overdue (the Calendar just shows those as overdue) are left out.
 */
export function dueReminders(projects: Project[], now: Date): Reminder[] {
  const t = now.getTime();
  const found: { due: number; reminder: Reminder }[] = [];
  for (const project of projects) {
    if (!project.scheduledAt || project.postedAt) continue;
    const due = Date.parse(project.scheduledAt);
    if (Number.isNaN(due) || t > due + MISSED_WINDOW_MS) continue;
    if (project.reviewState === 'pending') {
      if (t >= due - REVIEW_LEAD_MS && !project.reviewRemindedAt) {
        found.push({ due, reminder: { project, kind: 'review', late: t >= due, stamp: 'reviewRemindedAt' } });
      }
    } else if (t >= due && !project.remindedAt && !project.socialPostId) {
      found.push({ due, reminder: { project, kind: 'post', late: false, stamp: 'remindedAt' } });
    }
  }
  return found.sort((a, b) => a.due - b.due).map((f) => f.reminder);
}
