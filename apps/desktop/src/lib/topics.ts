import type { Chat, MessagePart, NewProject, Project, Settings, Style, VideoKind } from '@tayang/shared';
import {
  buildProjectBrief,
  SKIP_FRAME_CHECK,
  splitTopicJson,
  stripFramesToken,
  topicIdeaFromAction,
  type ProjectBriefExtra,
} from '@tayang/skills';
import { extractA2ui } from '@/a2ui/parse';
import {
  copyChatAttachments,
  copyStyleRefs,
  createChat,
  createProject,
  installStyleTemplate,
  listProjects,
  listStyles,
  syncStyles,
  writeBrief,
} from '@/lib/ipc';
import { mentionContext } from '@/lib/mentions';
import { advanceProject } from '@/lib/projectStatus';
import { i18n } from '@/i18n';
import { stored } from '@/lib/stored';
import { useApp } from '@/state/app';
import { appendSystem, buildRecap, useChat, type MentionRef } from '@/state/chat';
import { track } from '@/lib/analytics';

export type FilePart = Extract<MessagePart, { type: 'file' }>;
type MentionPart = Extract<MessagePart, { type: 'mention' }>;

export interface TopicIdea {
  title: string;
  kind: VideoKind;
  lengthSec: number;
  styleId?: string;
  /** What the user asked for that the title doesn't say (no voice-over, a fact to include, or a composed brief/script). */
  notes?: string;
  /** The user already wrote a prompt/brief/script or attached assets, so execute it rather than writing a new script. */
  hasScript?: boolean;
}

/** Active file attachments from user messages plus unsent composer attachments, deduplicated by path in order. */
export function collectChatFiles(chatId: string): FilePart[] {
  const state = useChat.getState();
  const seen = new Set<string>();
  const out: FilePart[] = [];
  const push = (p: MessagePart) => {
    if (p.type !== 'file' || seen.has(p.path)) return;
    seen.add(p.path);
    out.push(p);
  };
  for (const m of state.messages[chatId] ?? []) {
    if (m.role !== 'user') continue;
    for (const p of m.parts) push(p);
  }
  for (const p of state.attachments[chatId] ?? []) push(p);
  return out;
}

function collectChatMentions(chatId: string, unsent?: MentionRef | null): MentionPart[] {
  const state = useChat.getState();
  const seen = new Set<string>();
  const out: MentionPart[] = [];
  const push = (p: MentionPart) => {
    if (seen.has(p.projectId)) return;
    seen.add(p.projectId);
    out.push(p);
  };
  for (const m of state.messages[chatId] ?? []) {
    if (m.role !== 'user') continue;
    for (const p of m.parts) {
      if (p.type === 'mention') push(p);
    }
  }
  if (unsent) push({ type: 'mention', ...unsent });
  return out;
}

const SUGGEST_TOPICS_ASKS = new Set([
  'Suggest video topics for my channel',
  'Usulkan topik video untuk channelku',
]);

function collectUserTexts(chatId: string): { startedFromTopics: boolean; texts: string[] } {
  const state = useChat.getState();
  let startedFromTopics = false;
  const texts: string[] = [];
  for (const m of state.messages[chatId] ?? []) {
    if (m.role !== 'user') continue;
    const raw = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const clean = extractA2ui(stripFramesToken(raw)).text.trim();
    if (!clean) continue;
    if (SUGGEST_TOPICS_ASKS.has(clean)) {
      startedFromTopics = true;
      continue;
    }
    texts.push(clean);
  }
  const unsentDraft = (state.drafts[chatId]?.text ?? '').trim();
  if (unsentDraft) texts.push(unsentDraft);
  return { startedFromTopics, texts };
}

/** The three ideas of a reply: A2UI "Make this" buttons first, then the older ```json block. */
export function ideasFromReply(text: string): TopicIdea[] {
  const out: TopicIdea[] = [];
  for (const block of extractA2ui(text).blocks) {
    for (const m of block) {
      const comps = (m as { updateComponents?: { components?: unknown } }).updateComponents?.components;
      if (!Array.isArray(comps)) continue;
      for (const c of comps as { component?: string; action?: { event?: { name?: string; context?: Record<string, unknown> } } }[]) {
        const ev = c?.component === 'Button' ? c.action?.event : undefined;
        if (ev?.name !== 'pick_topic' || !ev.context) continue;
        const idea = topicIdeaFromAction(ev.context);
        if (idea) out.push(idea);
      }
    }
  }
  const found = out.length ? out : splitTopicJson(text).ideas;
  const seen = new Set<string>();
  return found
    .filter((i) => {
      const k = i.title.trim().toLowerCase();
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .slice(0, 3);
}

export interface TopicProjectOpts {
  settings: Settings;
  agent: Settings['defaultAgent'];
  styleId?: string | null;
  /** What setup is doing right now, for a busy line on the calling screen. */
  onStatus?: (text: string) => void;
  /** The non-project chat this video came from, so attachments, @mentions, and composed prompts carry over. */
  sourceChatId?: string;
  /** True when triggered by picking an idea card rather than POST /video from a composed prompt. */
  fromCard?: boolean;
  /** Known projects, used to resolve @video mentionContext when carrying mentions into the project chat. */
  projects?: Project[];
  /** Unsent @video mention sitting in the source composer. */
  unsentMention?: MentionRef | null;
  /** Files to copy from `sourceChatId` into the new project folder. */
  sourceFiles?: FilePart[];
  /** Carried-over brief notes to embed in the project's AGENTS.md. */
  briefExtra?: ProjectBriefExtra;
}

/** What `createProject` takes for a new video, and the not-yet-saved project its brief is written from. */
function projectDraft(title: string, kind: VideoKind, settings: Pick<Settings, 'format' | 'language'>, style: Style | null) {
  const input: NewProject = {
    title,
    kind,
    format: settings.format,
    language: settings.language,
    ...(style ? { styleId: style.id } : {}),
  };
  const draft: Project = {
    id: '',
    slug: '',
    folder: '',
    status: 'draft',
    styleId: style?.id ?? null,
    scheduledAt: null, reviewState: 'none', postedAt: null, remindedAt: null, reviewRemindedAt: null,
    durationSec: null,
    createdAt: '',
    updatedAt: '',
    ...input,
  };
  return { input, draft };
}

/**
 * What a draft video with the plain brief is made from, and no chat or agent turn (a schedule the agent
 * proposed names topics that aren't made yet). Its chat is created when the user opens it.
 */
export function draftProject(
  title: string,
  kind: VideoKind,
  settings: Pick<Settings, 'format' | 'language' | 'fps' | 'frameCheck'>,
): { input: NewProject; brief: string } {
  const { input, draft } = projectDraft(title, kind, settings, null);
  return { input, brief: buildProjectBrief(draft, null, settings) };
}

/**
 * Creates the project and its chat for a picked idea and sets up the style's template when it has one.
 * It neither opens the chat nor sends anything: `startTopic` does that for the screens, the autopilot
 * sends its own prompt. The video language and format come from `opts.settings`.
 *
 * The style is the idea's own `styleId` when it names a synced style, else `opts.styleId` (a template the
 * user picked on the Style screen, or the autopilot's style). A template that can't be set up is reported
 * in the chat as a system line and the brief is rewritten without it.
 */
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** A style by its id, or (agents sometimes write the name instead) by its name or a slug of it. */
function findStyle(styles: Style[], ref: string): Style | undefined {
  return styles.find((s) => s.id === ref) ?? styles.find((s) => slug(s.name) === slug(ref));
}

export async function createTopicProject(
  idea: TopicIdea,
  opts: TopicProjectOpts,
): Promise<{ project: Project; chat: Chat; copiedFiles: FilePart[] }> {
  const { settings, agent } = opts;
  const fallbackId = opts.styleId ?? null;
  let style: Style | null = null;
  let styleProblem: string | null = null;
  let unknownStyle: string | null = null;
  if (idea.styleId || fallbackId) {
    try {
      let styles = await listStyles();
      // A built-in style the agent named may not be synced yet: sync once, then look again.
      if (idea.styleId && !styles.some((s) => s.id === idea.styleId)) {
        const synced = await syncStyles().catch(() => null);
        if (synced) styles = await listStyles();
      }
      style =
        (idea.styleId ? findStyle(styles, idea.styleId) : undefined) ??
        (fallbackId ? styles.find((s) => s.id === fallbackId) : undefined) ??
        null;
      // A style the user picked that is gone, or one the agent named that nobody has, is said in the chat.
      if (!style && fallbackId) styleProblem = stored('chat.templateGone');
      else if (!style && idea.styleId) unknownStyle = idea.styleId;
    } catch (e) {
      styleProblem = e instanceof Error ? e.message : String(e);
    }
  }
  const { input, draft } = projectDraft(idea.title, idea.kind, settings, style);
  const project = await createProject(input, buildProjectBrief(draft, style, settings, opts.briefExtra));
  useApp.getState().bumpProjects();
  const chat = await createChat(project.id, agent, idea.title);
  let copiedFiles: FilePart[] = [];
  if (opts.sourceChatId && opts.sourceFiles?.length) {
    copiedFiles = await copyChatAttachments(opts.sourceChatId, { projectId: project.id, files: opts.sourceFiles });
  }
  const relAttachments = copiedFiles.map((f) => `attachments/${f.path.split(/[\\/]/).pop() || f.name}`);
  const fullExtra: ProjectBriefExtra | undefined =
    opts.briefExtra?.notes || relAttachments.length
      ? {
          ...(opts.briefExtra?.notes ? { notes: opts.briefExtra.notes } : {}),
          ...(relAttachments.length ? { attachments: relAttachments } : {}),
        }
      : undefined;
  const say = (text: string) => appendSystem(chat.id, text);
  // The look's reference frames go into the project (style-refs/), where the brief points the agent.
  if (style?.references?.length) await copyStyleRefs(style.id, project.id).catch(() => 0);
  if (styleProblem) await say(stored('chat.templateProblem', { problem: styleProblem }));
  if (unknownStyle) await say(stored('chat.styleUnknown', { id: unknownStyle }));
  let templateFailed = false;
  if (style?.template) {
    opts.onStatus?.(i18n.t('chat.settingTemplate', { name: style.name }));
    await say(stored('chat.settingTemplate', { name: style.name }));
    let reason: string | null = null;
    try {
      const r = await installStyleTemplate(project.id);
      if (!r.installed) reason = stored('chat.templateFilesMissing');
      // The style is in place: the project is being built.
      else await advanceProject(project.id, 'building');
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (reason !== null) {
      templateFailed = true;
      // The brief promised a template: take that promise back.
      await writeBrief(project.id, buildProjectBrief(draft, { ...style, template: null }, settings, fullExtra)).catch(() => {});
      await say(stored('chat.templateFailed', { name: style.name, reason }));
    }
  }
  if (!templateFailed && relAttachments.length > 0) {
    await writeBrief(project.id, buildProjectBrief(draft, style, settings, fullExtra)).catch(() => {});
  }
  return { project, chat, copiedFiles };
}

/** Creates the project and its chat for a picked idea, opens the chat and carries over any prompt, attachments, and @mentions. */
export async function startTopic(idea: TopicIdea, opts: TopicProjectOpts): Promise<void> {
  const { settings, agent, sourceChatId } = opts;
  if (sourceChatId) await useChat.getState().flushAttaches(sourceChatId);

  const sourceFiles = opts.sourceFiles ?? (sourceChatId ? collectChatFiles(sourceChatId) : []);
  const sourceMentions = sourceChatId ? collectChatMentions(sourceChatId, opts.unsentMention) : [];
  const { startedFromTopics, texts: userTexts } = sourceChatId
    ? collectUserTexts(sourceChatId)
    : { startedFromTopics: false, texts: [] };
  const userPromptText = userTexts.join('\n\n').trim();
  const ideaNotes = idea.notes?.trim() ?? '';

  const hasCustomTopicText = startedFromTopics
    ? userTexts.some((t) => t.toLowerCase() !== idea.title.trim().toLowerCase() && !/^[1-3]$/.test(t))
    : userTexts.length > 0;
  const keepComposedPrompt =
    !opts.fromCard &&
    (idea.hasScript === true || sourceFiles.length > 0 || sourceMentions.length > 0 || hasCustomTopicText);

  const briefNotes = keepComposedPrompt
    ? userPromptText && ideaNotes && !userPromptText.includes(ideaNotes)
      ? `${userPromptText}\n\n${ideaNotes}`
      : userPromptText || ideaNotes || undefined
    : opts.briefExtra?.notes;

  const { project, chat, copiedFiles } = await createTopicProject(idea, {
    ...opts,
    sourceFiles,
    ...(briefNotes ? { briefExtra: { ...opts.briefExtra, notes: briefNotes } } : {}),
  });

  if (sourceChatId) {
    useChat.getState().clearAttachments(sourceChatId);
    if (opts.unsentMention) {
      const curDraft = useChat.getState().drafts[sourceChatId];
      if (curDraft) useChat.getState().setDraft(sourceChatId, { ...curDraft, mention: null });
    }
  }
  if (chat.projectId) useChat.getState().rememberChat(chat);

  track('video started', { kind: idea.kind, length_sec: idea.lengthSec, has_style: !!project.styleId, agent, has_notes: !!idea.notes });
  useApp.getState().navigate({ name: 'chat', chatId: chat.id });

  const mentionProjects = sourceMentions.length
    ? opts.projects?.length
      ? opts.projects
      : await listProjects().catch(() => [] as Project[])
    : [];
  const mentionCtx = sourceMentions.length
    ? await mentionContext(sourceMentions, [], mentionProjects, settings)
    : [];

  let textBody: string;
  if (keepComposedPrompt) {
    if (userPromptText && ideaNotes && !userPromptText.includes(ideaNotes)) {
      textBody = [userPromptText, i18n.t('chat.topicNotes', { notes: ideaNotes })].join('\n\n');
    } else if (userPromptText) {
      textBody = userPromptText;
    } else if (ideaNotes) {
      textBody = [i18n.t('chat.startFromCarried', { title: idea.title }), i18n.t('chat.topicNotes', { notes: ideaNotes })].join('\n\n');
    } else {
      textBody = i18n.t('chat.startFromCarried', { title: idea.title });
    }
  } else {
    textBody = [
      i18n.t('chat.writeScript', { title: idea.title, seconds: idea.lengthSec }),
      ...(idea.notes ? [i18n.t('chat.topicNotes', { notes: idea.notes })] : []),
    ].join('\n\n');
  }

  const ask: MessagePart[] = [...copiedFiles, ...sourceMentions, { type: 'text', text: textBody }];
  const lead: MessagePart[] = [];
  if (settings.frameCheck === false) lead.push({ type: 'text', text: SKIP_FRAME_CHECK });
  if (mentionCtx.length) lead.push(...mentionCtx);
  if (keepComposedPrompt && sourceChatId) {
    const userMsgCount = (useChat.getState().messages[sourceChatId] ?? []).filter((m) => m.role === 'user').length;
    if (userMsgCount > 1) {
      const recap = buildRecap(useChat.getState().messages[sourceChatId] ?? []);
      // i18n-ignore: this goes to the agent, not the user
      if (recap) lead.push({ type: 'text', text: `Earlier conversation before creating this video project:\n${recap}` });
    }
  }

  void useChat.getState().send(chat.id, ask, {
    agentId: agent,
    job: { projectId: project.id, title: project.title },
    ...(lead.length ? { promptParts: [...lead, ...ask] } : {}),
  });
}
