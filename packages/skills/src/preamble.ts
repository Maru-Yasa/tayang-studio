import type { UiLanguage } from '@tayang/shared';
import tayangStudio from '../agent-plugin/skills/tayang-studio/SKILL.md?raw';

const stripFrontmatter = (text: string): string => text.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();

/** One line telling the agent which language the user reads; empty for English, the default. */
export function languageHint(language?: UiLanguage | null): string {
  return language === 'id'
    ? 'The user reads Indonesian. Reply in Indonesian unless they write in another language. Keep code, commands and file names as they are.'
    : '';
}

/** What the agent can't know by itself: the user's clock, and which video a project chat is about. */
export interface SessionFacts {
  /** IANA name, such as `Asia/Jakarta`. */
  timeZone: string;
  /** UTC offset as RFC 3339 writes it, such as `+07:00`. */
  offset: string;
  /** The user's local date and time when the chat started, such as `Wednesday 2026-11-04 17:55`. */
  localNow: string;
  /** The Tayang id of the video a project chat is about. */
  projectId?: string;
}

/** The time zone line, and the project id line for a project chat. Empty without facts. */
export function sessionFacts(facts?: SessionFacts | null): string {
  if (!facts) return '';
  return [
    `The user's local time zone is ${facts.timeZone} (UTC${facts.offset}). It was ${facts.localNow} when this chat started.`,
    facts.projectId ? `This video's Tayang id is ${facts.projectId}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The Tayang skills as plain text, for agents that cannot load the Claude Code
 * plugin. Put it in front of the first prompt of a session.
 */
export function buildSessionPreamble(language?: UiLanguage | null, facts?: SessionFacts | null): string {
  return [
    'You are running inside Tayang Studio. Follow these instructions for the whole session.',
    stripFrontmatter(tayangStudio),
    languageHint(language),
    sessionFacts(facts),
    '---',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A skill the user added on the Skills screen. */
export interface UserSkill {
  id: string;
  description: string;
  enabled: boolean;
  /** Its SKILL.md on disk. */
  path: string;
  /** The GitHub link it was added from, when it came from one. */
  source?: string | null;
}

/**
 * The user's own skills that are on, for agents that can't load them as a plugin: each one's name,
 * when to use it and where its SKILL.md is. Empty when none are on.
 */
export function userSkillsText(skills: readonly UserSkill[]): string {
  const on = skills.filter((s) => s.enabled);
  if (!on.length) return '';
  return [
    'The user added these skills of their own. When a task matches one, read its SKILL.md first and follow it:',
    ...on.map((s) => `- ${s.id}: ${s.description.replace(/\s+/g, ' ').trim()} (${s.path})`),
  ].join('\n');
}

/** The skills Tayang ships, always on: shown read-only on the Skills screen. */
export const BUILTIN_SKILLS: readonly { id: string; description: string; body: string }[] = [
  {
    id: 'tayang-studio',
    description: /^---\n[\s\S]*?^description:\s*(.*)$/m.exec(tayangStudio)?.[1]?.trim() ?? '',
    body: stripFrontmatter(tayangStudio),
  },
];
