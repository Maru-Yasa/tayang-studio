import type { Autopilot, AutopilotFrequency } from '@tayang/shared';
import { i18n, locale } from '@/i18n';

/** Video lengths an autopilot offers, in seconds. */
export const LENGTHS = [45, 60, 90];
/** At most this many videos a day. */
export const MAX_TIMES = 6;
/** The day choices, as `Date.getDay()` numbers. */
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKENDS = [0, 6];
/** Monday first; the number is `Date.getDay()` (0 is Sunday), what the model stores. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** The short weekday name in the active language (2024-01-07 is a Sunday). */
export const dayName = (day: number) => new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(new Date(2024, 0, 7 + day));

const pad = (n: number) => String(n).padStart(2, '0');

export const isTime = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
/** 1 to 6 different HH:MM times, as the Rust validation wants. */
export const validTimes = (times: string[]) =>
  times.length >= 1 && times.length <= MAX_TIMES && times.every(isTime) && new Set(times).size === times.length;

/** The first free whole hour after the last time (12:00 for none), for "Add a time". */
export function nextFreeTime(times: string[]): string {
  const used = new Set(times);
  const last = times.length ? Number(times[times.length - 1]!.slice(0, 2)) : 11;
  for (let i = 1; i <= 24; i++) {
    const v = `${pad((last + i) % 24)}:00`;
    if (!used.has(v)) return v;
  }
  return '00:00';
}

/** "2 a day · 12:00, 19:00" or "3 a week · Mon, Wed, Fri · 09:00". */
export function frequencyLabel(a: Pick<Autopilot, 'frequency'>): string {
  const f = a.frequency;
  if (f.kind === 'daily') return i18n.t('autopilot.daily', { count: f.times.length, times: [...f.times].sort().join(', ') });
  if (f.kind === 'days') {
    const same = (set: number[]) => set.length === f.days.length && set.every((d) => f.days.includes(d));
    const days = same(WEEKDAYS)
      ? i18n.t('autopilot.form.modeWeekdays')
      : same(WEEKENDS)
        ? i18n.t('autopilot.form.modeWeekends')
        : WEEK.filter((d) => f.days.includes(d)).map(dayName).join(', ');
    return i18n.t('autopilot.onDays', { count: f.times.length, days, times: [...f.times].sort().join(', ') });
  }
  const days = WEEK.filter((d) => f.days.includes(d)).map(dayName).join(', ');
  return i18n.t('autopilot.weekly', { count: f.days.length, days, time: f.time });
}

/** "Thu 5 Nov 12:00" in the active language, 24-hour clock. */
export function slotTime(d: Date): string {
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale(), o).format(d);
  return `${part({ weekday: 'short' })} ${d.getDate()} ${part({ month: 'short' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type DayMode = 'everyday' | 'weekdays' | 'weekends' | 'custom';

/** The day choice that fits a set of weekdays. */
export function dayModeOf(days: number[]): DayMode {
  const same = (set: number[]) => set.length === days.length && set.every((d) => days.includes(d));
  return same(WEEK) ? 'everyday' : same(WEEKDAYS) ? 'weekdays' : same(WEEKENDS) ? 'weekends' : 'custom';
}

/** What the agent's POST /autopilot may set, read safely: anything malformed is left for the user to pick. */
export interface AutopilotDraft {
  name?: string;
  nicheId?: string;
  niche?: string;
  language?: 'id' | 'en';
  styleId?: string;
  voiceId?: string;
  lengthSec?: number;
  mode?: Exclude<DayMode, 'custom'>;
  times?: string[];
  review?: boolean;
  socialAccountIds?: string[];
}

export function parseAutopilotDraft(c: Record<string, unknown>): AutopilotDraft {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const times = strings(c.times);
  const accounts = strings(c.socialAccountIds);
  return {
    name: str(c.name),
    nicheId: str(c.nicheId),
    niche: str(c.niche),
    styleId: str(c.styleId),
    voiceId: str(c.voiceId),
    ...(c.language === 'id' || c.language === 'en' ? { language: c.language } : {}),
    ...(LENGTHS.includes(c.lengthSec as number) ? { lengthSec: c.lengthSec as number } : {}),
    ...(c.days === 'everyday' || c.days === 'weekdays' || c.days === 'weekends' ? { mode: c.days } : {}),
    ...(validTimes(times) ? { times } : {}),
    ...(typeof c.review === 'boolean' ? { review: c.review } : {}),
    ...(accounts.length ? { socialAccountIds: [...new Set(accounts)] } : {}),
  };
}

const parseTime = (t: string): [number, number] => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return [h, m];
};

/**
 * The moments `autopilot` is due to make a video, in the computer's local time, from the calendar
 * day of `from` for `days` days (day 0 is today). A moment that is not after `from` is left out.
 * Weekly days follow `Date.getDay()`: 0 is Sunday. Each moment is built from local calendar parts,
 * so a daylight-saving change never shifts it off its clock time. Oldest first, no duplicates.
 */
export function planSlots(autopilot: Pick<Autopilot, 'frequency'>, from: Date, days: number): Date[] {
  const f: AutopilotFrequency = autopilot.frequency;
  const out: Date[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const times = f.kind === 'daily' ? f.times : !f.days.includes(day.getDay()) ? [] : f.kind === 'days' ? f.times : [f.time];
    for (const t of times) {
      const [h, m] = parseTime(t);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      if (at.getTime() > from.getTime()) out.push(at);
    }
  }
  const seen = new Set<number>();
  return out
    .sort((a, b) => a.getTime() - b.getTime())
    .filter((d) => !seen.has(d.getTime()) && !!seen.add(d.getTime()));
}
