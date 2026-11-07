import { i18n } from '@/i18n';

/**
 * Text Tayang writes into saved data (job notes and titles, system lines in a chat) so it can be
 * shown in whichever language the user reads later. The saved copy is always the English text of one
 * of these keys; `localized` matches it back to its key and says it again in the active language.
 * Text that matches no key (agent output, style names, links) passes through unchanged, and so do
 * rows saved before this existed: they are English, which is how the keys read.
 */
export const STORED_KEYS = [
  'agents.closedNote',
  'agents.studyTitle',
  'agents.cancelledStudy',
  'agents.cancelled',
  'agents.studyUnreadable',
  'agents.rendering',
  'agents.waitingAnswer',
  'agents.noVideo',
  'errors.agentStopped',
  'errors.signIn',
  'errors.opencodeFreeLimit',
  'chat.ranWithoutAsking',
  'chat.busyNote',
  'chat.switched',
  'chat.switchedProject',
  'chat.autoOffFailed',
  'chat.templateProblem',
  'chat.templateGone',
  'chat.styleUnknown',
  'chat.templateFilesMissing',
  'chat.settingTemplate',
  'chat.templateFailed',
  'chat.topicStarted',
  'autopilot.slot.stopped',
  'autopilot.slot.noTopic',
  'autopilot.slot.noRender',
  'autopilot.slot.timedOut',
  'autopilot.slot.busy',
  'autopilot.slot.styleMissing',
  'autopilot.slot.postFailed',
  'schedule.agent.done',
  'schedule.agent.failed',
  'schedule.agent.count',
  'schedule.agent.badTime',
  'schedule.agent.past',
  'schedule.agent.tooFar',
  'schedule.agent.unknown',
  'schedule.agent.twice',
  'schedule.agent.title',
  'schedule.agent.badItem',
  'schedule.agent.foreign',
  'schedule.agent.posted',
  'schedule.agent.exists',
  'schedule.agent.write',
  'schedule.agent.couldntCheck',
  'schedule.agent.failedAnswered',
] as const;
export type StoredKey = (typeof STORED_KEYS)[number];

type Params = Record<string, string | number>;

// The keys are checked by `STORED_KEYS`; the typed `t` can't take a union of keys with different params.
const say = (key: StoredKey, options: object): string => (i18n.t as unknown as (k: string, o: object) => string)(key, options);

/** The English text to save for `key`. */
export function stored(key: StoredKey, params?: Params): string {
  return say(key, { ...params, lng: 'en' });
}

const NESTED = new Set(['problem', 'reason']);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let compiled: { key: StoredKey; re: RegExp }[] | null = null;
function patterns() {
  compiled ??= STORED_KEYS.map((key) => {
    const template = i18n.getResource('en', 'translation', key) as string;
    const source = template
      .split(/(\{\{\w+\}\})/)
      .map((part) => {
        const m = /^\{\{(\w+)\}\}$/.exec(part);
        return m ? `(?<${m[1]}>[\\s\\S]+?)` : escapeRe(part);
      })
      .join('');
    return { key, re: new RegExp(`^${source}$`) };
  });
  return compiled;
}

/** Saved text said in the active language when it is one of ours; anything else as it is. */
export function localized(text: string): string {
  if (i18n.language === 'en') return text;
  for (const { key, re } of patterns()) {
    const m = re.exec(text);
    if (!m) continue;
    // Only these parameters can themselves be saved text (a template problem is one of ours); the rest
    // are names, commands and agent messages, which are never rewritten.
    const params = Object.fromEntries(
      Object.entries(m.groups ?? {}).map(([k, v]) => [k, NESTED.has(k) ? localized(v) : v]),
    );
    return say(key, params);
  }
  return text;
}
