import type { Niche, SocialAccount, Style, VideoKind, VideoLanguage, Voice } from '@tayang/shared';
import { clampTopicLength, FACTS_RULE, MOTION_RULES, VIDEO_KINDS } from './style';
import { FOREGROUND_RULE, POST_RULE, RENDERS_RULE } from './frameCheck';

// Everything here goes to the agent, never to the user, so it stays in English (i18n-ignore).

const LANGUAGE: Record<VideoLanguage, string> = { id: 'Indonesian', en: 'English' };

export interface AutopilotTopicInput {
  niche: string;
  style: Pick<Style, 'name'> & Partial<Pick<Style, 'prompt'>>;
  language: VideoLanguage;
  lengthSec: number;
  /** The autopilot's earlier video titles, newest first; the new topic must not repeat them. */
  previousTitles: string[];
}

export interface AutopilotTopic {
  title: string;
  kind: VideoKind;
  lengthSec: number;
}

/** Asks the autopilot's internal chat for the next video: exactly one motion-design topic as a json block. */
export function buildAutopilotTopicPrompt({ niche, style, language, lengthSec, previousTitles }: AutopilotTopicInput): string {
  const lang = LANGUAGE[language];
  const styleLine = style.prompt?.trim() ? `${style.name}: ${style.prompt.trim()}` : style.name;
  return [
    `Suggest exactly ONE topic for a short motion video in this niche: "${niche}". Write the title in ${lang}.`,
    `The video will be about ${lengthSec} seconds long and made in this style: ${styleLine}`,
    '',
    'Rules:',
    ...MOTION_RULES,
    '- The topic must fit the niche and suit the style.',
    FACTS_RULE,
    previousTitles.length
      ? '- It must not repeat, or be a close variation of, any of these earlier titles:'
      : '- There are no earlier titles yet.',
    ...previousTitles.map((t) => `  - ${t}`),
    '',
    'How to reply:',
    '- Do not use any tools, create files or run commands. Just answer.',
    `- Reply with only one fenced \`\`\`json block and nothing else, like this (kind is one of: ${VIDEO_KINDS.join(', ')}):`,
    '```json',
    `{"title": "<the title>", "kind": "<kind>", "lengthSec": ${lengthSec}}`,
    '```',
  ].join('\n');
}

/** Sent once when the topic reply could not be read (or repeated an earlier title). */
export const AUTOPILOT_TOPIC_RETRY =
  'I could not use that. Reply again with only one fenced ```json block, {"title": "...", "kind": "...", "lengthSec": ...}, ' +
  'with a new title that is not one of the earlier titles. Nothing else.';

const jsonBlock = (text: string): string | null => /```json\s*([\s\S]*?)```/.exec(text)?.[1] ?? null;

/** The topic in an autopilot reply (a ```json block, or bare json), or null when it has no title. */
export function parseAutopilotTopic(text: string): AutopilotTopic | null {
  const raw = jsonBlock(text) ?? text.trim();
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(data)) data = data[0];
  if (!data || typeof data !== 'object') return null;
  const item = data as { title?: unknown; kind?: unknown; lengthSec?: unknown };
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (!title) return null;
  const kind = VIDEO_KINDS.includes(item.kind as VideoKind) ? (item.kind as VideoKind) : 'explainer';
  const len = Number(item.lengthSec);
  return { title, kind, lengthSec: Number.isFinite(len) && len > 0 ? clampTopicLength(len) : 30 };
}

/** The autopilot's one message to the project chat: make the whole video on its own, ending with a rendered file. */
export function buildAutopilotBuildPrompt(
  title: string,
  lengthSec: number,
  opts: { language?: VideoLanguage; frameCheck?: boolean; voiceId?: string | null } = {},
): string {
  const lang = opts.language ? ` in ${LANGUAGE[opts.language]}` : '';
  const steps = [
    `Write the script for "${title}", about ${lengthSec} seconds${lang}.`,
    'Build the video in this project, following AGENTS.md and its style.',
    "Render it to an MP4 with the render command in tayang.json (or the project's own render setup).",
    ...(opts.frameCheck === false ? [] : ['Check frames of the render, fix anything that looks wrong and render again.']),
    'Finish by saying the path of the rendered file.',
  ];
  return [
    'This video is made by an autopilot: work through every step on your own, without asking questions or waiting for a reply.',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    ...(opts.voiceId ? [`For the voice-over use Tayang's /voice with "voice":"${opts.voiceId}" in every call.`] : []),
    FOREGROUND_RULE,
    RENDERS_RULE,
    POST_RULE,
  ].join('\n');
}

export interface AutopilotChatInput {
  niches: Pick<Niche, 'id' | 'title'>[];
  voices: Pick<Voice, 'id' | 'name' | 'description'>[];
  styles: Pick<Style, 'id' | 'name'>[];
  accounts: Pick<SocialAccount, 'id' | 'platform' | 'username'>[];
  /** The language to talk to the user in. */
  language: VideoLanguage;
}

/** Starts a chat that helps the user set up one autopilot; the wizard's Summary is where it is started. */
export function buildAutopilotChatPrompt({ niches, voices, styles, accounts, language }: AutopilotChatInput): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `  - ${i}`) : ['  (none available)']);
  return [
    `Help the user set up one Tayang autopilot, which makes short videos on a schedule. Talk to them in ${LANGUAGE[language]}.`,
    'Ask with your question tool, a few things at a time, only for what they have not said yet. Do not create files or run other commands.',
    '',
    'What you need:',
    '- name: a short name for the autopilot.',
    '- nicheId from this list, or niche: their own description when none fits:',
    ...list(niches.map((n) => `${n.id}: ${n.title}`)),
    '- styleId from this list:',
    ...list(styles.map((s) => `${s.id}: ${s.name}`)),
    '- voiceId from this list, or null for the default voice:',
    ...list(voices.map((v) => `${v.id}: ${v.description || v.name}`)),
    '- language: "id" or "en", the language of the videos.',
    '- lengthSec: 45, 60 or 90.',
    '- days: "everyday", "weekdays" or "weekends".',
    '- times: when videos are due each of those days, "HH:MM" local time, 1 to 6 different times: one per video a day.',
    '- review: true to approve each video before it is posted, false for fully automatic.',
    '- socialAccountIds from this list, none to post by hand:',
    ...list(accounts.map((a) => `${a.id}: ${a.platform}${a.username ? ` @${a.username}` : ''}`)),
    '',
    'When you have everything, send it. Tayang shows the user the result to check and start; you cannot start it yourself:',
    `curl -s -X POST "$TAYANG_AI_URL/autopilot" -H "Authorization: Bearer $TAYANG_AI_TOKEN" -d '{"name":"...","nicheId":"...","styleId":"...","voiceId":"...","language":"id","lengthSec":60,"days":"everyday","times":["09:00"],"review":true,"socialAccountIds":[]}'`,
    'Then end your turn.',
  ].join('\n');
}

/** Sent once when the build turn ended without a rendered file. */
export const AUTOPILOT_RENDER_NOW = `Render it now: no rendered video file was found in this project. Use the render command in tayang.json (or the project's own render setup), then finish by saying the path of the rendered file. ${FOREGROUND_RULE} ${RENDERS_RULE}`;
