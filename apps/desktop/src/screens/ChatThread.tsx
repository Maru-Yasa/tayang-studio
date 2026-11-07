import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentId, ChatMessage, MessagePart, Project } from '@tayang/shared';
import { topicIdeaFromAction } from '@tayang/skills';
import { Composer, type MentionRef } from '@/components/Composer';
import { MessageList } from '@/components/MessageList';
import { PermissionCard } from '@/components/PermissionCard';
import { QuestionCard } from '@/components/QuestionCard';
import { ScrollToBottom } from '@/components/ScrollToBottom';
import { stylesFor, TemplateChip, templateOf, useChipTemplate, useStyles } from '@/components/TemplateChip';
import { TraceButton } from '@/components/TraceDialog';
import { TurnRail } from '@/components/TurnRail';
import { listProjects } from '@/lib/ipc';
import { lastMentionedStyle, mentionContext, mentionedIn, styleContext } from '@/lib/mentions';
import { ideasFromReply, startTopic, type TopicIdea } from '@/lib/topics';
import { extractA2ui } from '@/a2ui/parse';
import { useApp } from '@/state/app';
import { appendSystem, headPermission, headQuestion, useChat } from '@/state/chat';
import { stored } from '@/lib/stored';
import type { A2uiAction } from '@/a2ui/render';
import { useUsage } from '@/state/usage';

const NO_MESSAGES: never[] = [];
/** Chats whose topic pick is still setting up, across remounts: a second pick waits for the first. */
const picking = new Set<string>();

/** Cards for the ideas in the agent's last reply, once it is finished. A2UI replies draw their own; a ```json one needs these. */
function topicCards(messages: ChatMessage[], streaming: boolean): TopicIdea[] {
  const last = messages.at(-1);
  if (streaming || last?.role !== 'agent') return [];
  const text = last.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return extractA2ui(text).blocks.length ? [] : ideasFromReply(text);
}

/**
 * A chat without a project: what New chat becomes after its first send, and what Recent opens. The
 * conversation, the composer and topic cards, without the project's header and preview.
 */
export function ChatThread({ chatId, draft, styleId: routeStyleId }: { chatId: string; draft?: string; styleId?: string }) {
  const { t } = useTranslation();
  const settings = useApp((s) => s.settings);
  const row = useChat((s) => s.rows[chatId]);
  const messages = useChat((s) => s.messages[chatId]) ?? NO_MESSAGES;
  const streaming = useChat((s) => !!s.streaming[chatId]);
  const permission = useChat((s) => headPermission(s, chatId));
  const question = useChat((s) => headQuestion(s, chatId));
  const agent = row?.agentId ?? settings?.defaultAgent ?? 'claude';
  // The template New chat was started from; kept until a topic starts a project, or the user removes it.
  const [styleId, setStyleId] = useState<string | null>(routeStyleId ?? null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [mention, setMention] = useState<MentionRef | null>(null);
  /** A picked topic is being set up (project, chat, template). */
  const [busy, setBusy] = useState(false);
  const [setupLine, setSetupLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Straight from New chat: the composer the user was typing in keeps the focus.
  const [focus] = useState(() => useApp.getState().focusChatId === chatId);
  useEffect(() => {
    if (focus) useApp.setState({ focusChatId: null });
  }, [focus]);
  const styles = useStyles();
  // A template style waiting in the composer is the chat's template; the template chip steps aside for it.
  const chipTemplate = useChipTemplate(chatId, styles);

  const seen = useMemo(() => mentionedIn(messages), [messages]);
  const ideas = useMemo(() => topicCards(messages, streaming), [messages, streaming]);

  useEffect(() => {
    useChat.getState().listen();
    void useChat.getState().load(chatId);
    let alive = true;
    listProjects()
      .then((p) => alive && setProjects(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chatId]);

  useEffect(() => {
    useUsage.getState().setChatAgent(agent);
    return () => useUsage.getState().setChatAgent(null);
  }, [agent]);

  const switchAgent = async (next: AgentId) => {
    if (next === agent || streaming) return;
    try {
      await useChat.getState().switchAgent(chatId, next);
      if (row) useChat.getState().rememberChat({ ...row, agentId: next });
    } catch {
      /* the chat keeps its agent */
    }
  };

  const onSend = async (parts: MessagePart[]): Promise<boolean> => {
    setError(null);
    const sentMention = mention;
    setMention(null);
    const known = await stylesFor(parts, styles);
    const ctx = [...(await mentionContext(parts, seen, projects, settings)), ...styleContext(parts, known)];
    // A style with a starter template, once sent, is what a topic picked here starts from.
    const sentStyle = parts.find((p) => p.type === 'style-mention');
    const sentTemplate = templateOf(sentStyle?.type === 'style-mention' ? sentStyle : null, known);
    if (sentTemplate) setStyleId(sentTemplate);
    const failure = await useChat
      .getState()
      .send(chatId, parts, { agentId: agent, ...(ctx.length ? { promptParts: [...ctx, ...parts] } : {}) });
    // The chat already shows why in a system line.
    if (failure) setMention(sentMention);
    return !failure;
  };

  /** Starts the picked topic; then records the pick here, so the cards (and an A2UI card's surface) read as answered. */
  const pickIdea = async (idea: TopicIdea, card?: A2uiAction) => {
    if (!settings || busy || streaming || picking.has(chatId)) return;
    picking.add(chatId);
    setBusy(true);
    setSetupLine(t('chat.settingUp'));
    setError(null);
    try {
      // The idea's own style wins when it is a synced one; else the template chip's style, else the
      // style the user last mentioned here (a copied style has no template, so no chip).
      const chatStyle = chipTemplate ?? styleId ?? lastMentionedStyle(useChat.getState().messages[chatId]);
      await startTopic(idea, { settings, agent, styleId: chatStyle, onStatus: setSetupLine });
      setStyleId(null);
      const { summary, ...action } = card ?? { summary: '' };
      await appendSystem(
        chatId,
        stored('chat.topicStarted', { title: idea.title }),
        card ? [{ type: 'a2ui-action', summary, action: { version: 'v0.9', action } }] : [],
      );
    } catch (e) {
      setBusy(false);
      setSetupLine(null);
      setError(t('chat.couldntStartTopic', { title: idea.title, message: e instanceof Error ? e.message : String(e) }));
    } finally {
      picking.delete(chatId);
    }
  };

  // The agent asked Tayang to start a video (POST /video): once its turn is over, start it here.
  const pendingPick = useChat((s) => (s.actions[chatId] ?? []).some((a) => a.name === 'pick_topic'));
  useEffect(() => {
    if (!pendingPick || streaming || busy) return;
    const a = useChat.getState().takeAction(chatId, 'pick_topic');
    const idea = a && topicIdeaFromAction(a.context);
    if (idea) void pickIdea(idea);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPick, streaming, busy, chatId]);

  // The agent set up an autopilot (POST /autopilot): once its turn is over, the user checks it in the wizard.
  const pendingAutopilot = useChat((s) => (s.actions[chatId] ?? []).some((a) => a.name === 'create_autopilot'));
  useEffect(() => {
    if (!pendingAutopilot || streaming) return;
    const a = useChat.getState().takeAction(chatId, 'create_autopilot');
    if (a) useApp.getState().navigate({ name: 'autopilot-wizard', draft: a.context });
  }, [pendingAutopilot, streaming, chatId]);

  const onA2uiAction = (a: A2uiAction) => {
    if (a.name !== 'pick_topic') return false;
    const idea = topicIdeaFromAction(a.context);
    if (!idea) return false;
    void pickIdea(idea, a);
    return true;
  };

  const attached = new Set([...seen, ...(mention ? [mention.projectId] : [])]).size;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header data-tauri-drag-region className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-6">
        <span className="truncate text-[15px] font-medium">{row?.title || t('chat.title')}</span>
        <span className="shrink-0 text-xs text-text-3">
          {attached === 0 ? t('chat.noVideo') : t('chat.videosAttached', { count: attached })}
        </span>
        <TraceButton chatId={chatId} className="ml-auto" />
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center px-6">
        <div className="relative flex min-h-0 w-full flex-1 justify-center">
          <div ref={scrollRef} className="no-scrollbar flex min-h-0 w-full max-w-[720px] flex-1 flex-col gap-6 overflow-y-auto py-6">
            <div className="my-auto">
              <MessageList
                messages={messages}
                streaming={streaming}
                busy={busy}
                scrollRef={scrollRef}
                onA2uiAction={onA2uiAction}
                sendOptions={() => ({ agentId: agent })}
              >
                {question && (
                  <QuestionCard
                    question={question}
                    agentId={agent}
                    onRespond={(r, summary) => void useChat.getState().respondQuestion(chatId, r, summary)}
                  />
                )}
                {permission && (
                  <PermissionCard
                    request={permission}
                    agentId={agent}
                    allowLabel={t('permission.allow')}
                    onRespond={(o) => void useChat.getState().respondPermission(chatId, o)}
                  />
                )}
                {ideas.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {ideas.map((idea) => (
                      <button
                        key={idea.title}
                        type="button"
                        disabled={busy || streaming}
                        onClick={() => void pickIdea(idea)}
                        className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left text-foreground transition-colors hover:bg-raised disabled:cursor-default disabled:opacity-60"
                      >
                        <span className="text-[14px] font-medium">{idea.title}</span>
                        <span className="font-mono text-xs text-text-3">
                          {t(`kinds.${idea.kind}`)} · {t('chat.seconds', { n: idea.lengthSec })}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {busy && setupLine && (
                  <p role="status" className="m-0 text-[13px] text-text-3">
                    {setupLine}
                  </p>
                )}
              </MessageList>
            </div>
          </div>
          <TurnRail messages={messages} scrollRef={scrollRef} className="-right-6" />
          <ScrollToBottom scrollRef={scrollRef} />
        </div>

        <div className="w-full max-w-[720px] pb-6 pt-4">
          <TemplateChip styleId={chipTemplate ? null : styleId} onRemove={() => setStyleId(null)} styles={styles} />
          <Composer
            chatId={chatId}
            draftKey={chatId}
            autoFocus={focus}
            styles={styles}
            initialText={draft}
            onSend={onSend}
            disabled={streaming || busy}
            onStop={() => void useChat.getState().cancel(chatId)}
            projects={projects}
            mention={mention}
            onMention={setMention}
            agentId={agent}
            onAgentChange={(a) => void switchAgent(a)}
          />
          {error && (
            <p role="alert" className="m-0 mt-2 text-xs text-orange-light">
              {error}
            </p>
          )}
          <p className="m-0 mt-2 text-xs text-text-3">{t('chat.newChatNote')}</p>
        </div>
      </div>
    </div>
  );
}
