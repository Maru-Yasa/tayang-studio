import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, File as FileIcon, Palette } from 'lucide-react';
import { formatTimecode, type ChatMessage, type MessagePart } from '@tayang/shared';
import { Markdown } from '@/components/Markdown';
import { Oyen } from '@/components/Oyen';
import { STICK_EVENT } from '@/components/ScrollToBottom';
import { ImageStrip, isImagePart, type ImagePart } from '@/components/AgentImages';
import { ActivityGroup, isHiddenTool, WorkingLine, type ActivityItem, type LiveTurn } from '@/components/Activity';
import { localized } from '@/lib/stored';
import { ScheduleConfirm } from '@/components/ScheduleConfirm';
import { asAction } from '@/lib/agentActions';
import { confirmSchedule, isScheduleRecord, prepareSchedule, SCHEDULE_ACTION, type PlannedItem } from '@/lib/scheduleVideos';
import { useApp } from '@/state/app';
import { useRender } from '@/state/render';
import { messageKey, useChat, type SendOpts } from '@/state/chat';
import { splitTopicJson, stripFramesToken } from '@tayang/skills';
import { extractA2ui } from '@/a2ui/parse';
import { A2uiSurface, type A2uiAction } from '@/a2ui/render';
import { applyMessages, blockSurfaceId, emptySurfaces, type SurfaceSet } from '@/a2ui/surface';

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-sm border border-deep-orange bg-tint px-2 text-[13px] font-medium text-orange-light">
      {children}
    </span>
  );
}

/** A style the user mentioned: a palette and its name, set apart from the orange video chip. */
function StyleChip({ name }: { name: string }) {
  return (
    <span
      data-chip="style"
      className="inline-flex h-6 items-center gap-1 rounded-sm border border-hairline bg-card px-2 text-[13px] font-medium text-foreground"
    >
      <Palette size={12} strokeWidth={1.5} aria-hidden="true" className="text-text-2" />
      <span>@{name}</span>
    </span>
  );
}

export function FrameChip({ part }: { part: Extract<MessagePart, { type: 'frame' }> }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-2 rounded-sm border border-hairline bg-transparent px-2 py-1 text-xs text-text-2">
      <span className="font-medium text-foreground">{t('chat.frame', { time: formatTimecode(part.timeSec, 30) })}</span>
      {part.marks.length > 0 && <span className="text-text-3">{t('chat.marked', { count: part.marks.length })}</span>}
    </span>
  );
}

function SentFile({ part }: { part: Extract<MessagePart, { type: 'file' }> }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-text-2">
      <FileIcon size={14} strokeWidth={1.5} aria-hidden="true" />
      <span className="font-medium text-foreground">{part.name}</span>
    </span>
  );
}

interface Actions {
  /** A screen can take an A2UI action itself (return true) instead of sending it to the agent. */
  handle?: (a: A2uiAction) => boolean;
  /** Surfaces take no input while the agent replies: one gate with the composer and agent picker. */
  locked: boolean;
  sendOptions?: SendOptions;
  /** A pressed schedule card: Tayang checks it and asks the user in its own dialog. */
  schedule?: (a: A2uiAction) => void;
}

/** The screen's own send options for what the agent receives (its agent, build job, prompt prefix). */
export type SendOptions = (promptParts: MessagePart[]) => SendOpts;

const ActionsContext = createContext<Actions>({ locked: false });

/**
 * Between the agent's surface id and the key a later surface with the same id gets: a new card that
 * reuses an answered card's id is a new surface, so the answered one stays as it was.
 */
const KEY_SEP = '\u241F';
/** The agent's own surface id for a surface key. */
const agentSurfaceId = (key: string) => key.split(KEY_SEP)[0]!;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The block with every message's surface id changed from `from` to `to`. */
function rekey(block: unknown[], from: string, to: string): unknown[] {
  if (from === to) return block;
  return block.map((m) => {
    if (!isObj(m)) return m;
    const out: Record<string, unknown> = { ...m };
    for (const k of ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface']) {
      const body = m[k];
      if (isObj(body) && body.surfaceId === from) out[k] = { ...body, surfaceId: to };
    }
    return out;
  });
}

/**
 * A block split by the surface each line is about, in the order each first shows up, so every surface is
 * keyed on its own (an answered one stays answered even when another card comes first in the block).
 * Lines that name no surface form their own group.
 */
function bySurface(block: unknown[]): unknown[][] {
  const groups = new Map<string | null, unknown[]>();
  for (const line of block) {
    const sid = blockSurfaceId([line]);
    groups.set(sid, [...(groups.get(sid) ?? []), line]);
  }
  return [...groups.values()];
}

/** What the chat's A2UI surfaces look like after every agent block, in order. */
interface A2uiState {
  chatId: string;
  set: SurfaceSet;
  /** The message that first showed each surface; later blocks update it in place. */
  owner: Record<string, string>;
  version: Record<string, number>;
  /** Answered by the user: from then on no block can change or re-enable it. */
  answered: Record<string, boolean>;
  /** For each `<message id>:<part index>`, the surface key of each of its blocks (null: none, or ignored). */
  keys: Record<string, (string | null)[]>;
}

function deriveA2ui(messages: ChatMessage[]): A2uiState {
  const st: A2uiState = { chatId: messages[0]?.chatId ?? '', set: emptySurfaces(), owner: {}, version: {}, answered: {}, keys: {} };
  /** The agent's surface id → the key of its latest surface. */
  const current: Record<string, string> = {};
  let fresh = 0;
  for (const m of messages) {
    if (m.role === 'agent') {
      m.parts.forEach((p, i) => {
        if (p.type !== 'text') return;
        const keys: (string | null)[] = [];
        for (const block of extractA2ui(p.text).blocks.flatMap(bySurface)) {
          const sid = blockSurfaceId(block);
          if (!sid) {
            st.set = applyMessages(st.set, block);
            keys.push(null);
            continue;
          }
          let key = current[sid] ?? sid;
          if (st.answered[key]) {
            // An answered card never changes again; a new card under its id is a new surface, here.
            if (!block.some((x) => isObj(x) && isObj(x.createSurface))) {
              keys.push(null);
              continue;
            }
            key = `${sid}${KEY_SEP}${++fresh}`;
          }
          current[sid] = key;
          st.set = applyMessages(st.set, rekey(block, sid, key));
          st.owner[key] ??= m.id;
          st.version[key] = (st.version[key] ?? 0) + 1;
          st.answered[key] = false;
          keys.push(key);
        }
        st.keys[`${m.id}:${i}`] = keys;
      });
    } else {
      // A user's answer, or the system line that records a schedule card Tayang took.
      for (const p of m.parts) {
        if (p.type !== 'a2ui-action') continue;
        const sid = (p.action as { action?: { surfaceId?: unknown } }).action?.surfaceId;
        if (typeof sid === 'string') st.answered[current[sid] ?? sid] = true;
      }
    }
  }
  return st;
}

/** Whether an agent text part only updated surfaces drawn by earlier messages. */
function isUpdateOnly(text: string, keys: (string | null)[] | undefined, messageId: string, a2ui: A2uiState): boolean {
  const { text: prose, blocks, pending } = extractA2ui(text);
  if (prose || pending || !blocks.length) return false;
  return (keys ?? []).every((k) => !k || a2ui.owner[k] !== messageId);
}

function sendAction(chatId: string, a: A2uiAction, sendOptions?: SendOptions) {
  const { summary, ...rest } = a;
  const action: MessagePart = { type: 'a2ui-action', summary, action: { version: 'v0.9', action: rest } };
  // The agent gets the summary and the action JSON from the one a2ui-action part.
  const opts = { promptParts: [action], ...sendOptions?.([action]) };
  void useChat.getState().send(chatId, [{ type: 'text', text: summary }, action], opts);
}

/** An agent text part: prose, the surfaces it owns, and a placeholder for a block still streaming. */
function AgentText({ text, messageId, part, a2ui }: { text: string; messageId: string; part: number; a2ui: A2uiState }) {
  const { text: rawProse, blocks, pending: a2uiPending, invalid } = useMemo(() => extractA2ui(stripFramesToken(text)), [text]);
  const { t } = useTranslation();
  const { handle, locked, sendOptions, schedule } = useContext(ActionsContext);
  // Older agents answer topics with a ```json block. Where a screen shows topic cards (it provides the
  // handler), hide that block, also while it is still streaming; other chats keep it as written.
  const { prose, pending: jsonPending } = useMemo(() => {
    if (!handle) return { prose: rawProse, pending: false };
    const done = splitTopicJson(rawProse).text;
    const open = done.lastIndexOf('```json');
    if (open >= 0 && !done.includes('```', open + 7) && /^\s*\n\s*\[\s*(\{|$)/.test(done.slice(open + 7))) {
      return { prose: done.slice(0, open).trim(), pending: true };
    }
    return { prose: done, pending: false };
  }, [rawProse, handle]);
  const pending = a2uiPending || jsonPending;
  const ids: string[] = [];
  for (const key of a2ui.keys[`${messageId}:${part}`] ?? []) {
    if (key && a2ui.owner[key] === messageId && !ids.includes(key) && a2ui.set.surfaces[key]) ids.push(key);
  }
  return (
    <>
      {prose && <Markdown text={prose} />}
      {ids.map((sid) => (
        <A2uiSurface
          key={`${sid}:${a2ui.version[sid]}`}
          surface={a2ui.set.surfaces[sid]!}
          disabled={a2ui.answered[sid]}
          locked={locked}
          onAction={(pressed) => {
            // The agent and the stored answer know the surface by the agent's own id.
            const a = { ...pressed, surfaceId: agentSurfaceId(pressed.surfaceId) };
            // A schedule card is Tayang's to confirm, in every chat; the agent gets no turn for it.
            if (a.name === SCHEDULE_ACTION) {
              schedule?.(a);
              return;
            }
            if (!handle?.(a)) sendAction(a2ui.chatId, a, sendOptions);
          }}
        />
      ))}
      {blocks.length > 0 && a2ui.set.notes.length > 0 && (
        <p className="m-0 text-[12px] text-text-3">{a2ui.set.notes[0]}</p>
      )}
      {invalid > 0 && <p className="m-0 text-[12px] text-text-3">{t('chat.brokenBlock')}</p>}
      {pending && <p className="m-0 text-[13px] text-text-3">{t('chat.loadingOptions')}</p>}
    </>
  );
}

function Parts({
  parts,
  live,
  messageId,
  a2ui,
  turn,
}: {
  parts: MessagePart[];
  /** This message is the one the agent is still writing. */
  live: boolean;
  messageId: string;
  a2ui: A2uiState;
  /** The running turn, for the live line. */
  turn?: LiveTurn;
}) {
  // Tool calls and thoughts that run together become one activity line, where they happened; images
  // the agent made become a strip of thumbnails after them.
  const out: React.ReactNode[] = [];
  let run: ActivityItem[] = [];
  const images = parts.filter(isImagePart);
  let strip: ImagePart[] = [];
  const flushStrip = () => {
    if (strip.length) out.push(<ImageStrip key={`i${out.length}`} parts={strip} all={images} />);
    strip = [];
  };
  /** Whether the tail is an activity line already showing a running step: it carries the live time itself. */
  let tailRunning = false;
  const flush = (tail: boolean) => {
    if (run.length) {
      const liveTail = live && tail;
      tailRunning = liveTail && run.some((p) => p.type === 'tool' && (p.status === 'running' || p.status === 'pending'));
      out.push(<ActivityGroup key={`g${out.length}`} items={run} live={liveTail} turn={liveTail ? turn : undefined} />);
    }
    run = [];
  };
  parts.forEach((p, i) => {
    if (p.type === 'tool' || p.type === 'thought') {
      if (p.type === 'thought' || !isHiddenTool(p)) {
        flushStrip();
        run.push(p);
      }
      return;
    }
    flush(false);
    if (p.type === 'file' && p.mime.startsWith('image/')) {
      strip.push(p);
      return;
    }
    flushStrip();
    if (p.type === 'text') out.push(<AgentText key={i} text={p.text} messageId={messageId} part={i} a2ui={a2ui} />);
    else if (p.type === 'mention') out.push(<Chip key={i}>@{p.title}</Chip>);
    else if (p.type === 'style-mention') out.push(<StyleChip key={i} name={p.name} />);
    else if (p.type === 'frame') out.push(<FrameChip key={i} part={p} />);
    else if (p.type === 'file') out.push(<SentFile key={i} part={p} />);
  });
  flush(true);
  flushStrip();
  if (live && !tailRunning) out.push(<WorkingLine key="working" turn={turn} />);
  return <>{out}</>;
}

export function MessageList({
  messages,
  streaming,
  children,
  onA2uiAction,
  sendOptions,
  busy = false,
  scrollRef,
}: {
  /** The scroll container the list lives in: it follows new messages only while the user is near the bottom. */
  scrollRef?: React.RefObject<HTMLElement | null>;
  messages: ChatMessage[];
  streaming: boolean;
  /** The screen is busy with an earlier action (setting up a topic): surfaces wait, like while streaming. */
  busy?: boolean;
  /** Return true when the screen handled the action itself. */
  onA2uiAction?: (a: A2uiAction) => boolean;
  /** How an answered surface is sent: the same options as the screen's composer. */
  sendOptions?: SendOptions;
  /** Extra blocks under the conversation (permission card, idea cards). */
  children?: React.ReactNode;
}) {
  const { t, i18n: inst } = useTranslation();
  const end = useRef<HTMLDivElement>(null);
  // Follow the conversation only while the reader is at the bottom (or just sent something), so jumping
  // to an earlier turn while the agent streams stays put.
  const stick = useRef(true);
  const prev = useRef({ count: messages.length, last: messages[messages.length - 1]?.id });
  const log = useRef<HTMLDivElement>(null);
  /** The chat whose messages were last shown: opening or switching to another starts at its end. */
  const shownChat = useRef<string | null>(null);
  useEffect(() => {
    const box = scrollRef?.current;
    if (!box) return;
    // Any move up away from the end stops following, even one wheel notch that stays within 80px:
    // otherwise the next streamed chunk pulls the reader straight back down. Following only ever
    // scrolls down, and content growing or shrinking leaves the reader at the end, so a move up
    // with the end out of reach is the reader's own.
    let lastTop = box.scrollTop;
    const onScroll = () => {
      const top = box.scrollTop;
      const gap = box.scrollHeight - top - box.clientHeight;
      stick.current = gap <= 80 && !(top < lastTop - 1 && gap > 2);
      lastTop = top;
    };
    // The scroll-to-bottom pill asks to follow the conversation again.
    const onStick = () => {
      stick.current = true;
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    box.addEventListener(STICK_EVENT, onStick);
    // Images, cards and code blocks keep growing the list after the first scroll; stay at the end
    // through that while following, so opening a chat doesn't land mid-conversation.
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (stick.current) end.current?.scrollIntoView?.({ block: 'end' });
          });
    if (log.current) ro?.observe(log.current);
    return () => {
      box.removeEventListener('scroll', onScroll);
      box.removeEventListener(STICK_EVENT, onStick);
      ro?.disconnect();
    };
  }, [scrollRef]);
  useEffect(() => {
    const last = messages[messages.length - 1];
    const sent = last?.role === 'user' && (messages.length !== prev.current.count || last.id !== prev.current.last);
    prev.current = { count: messages.length, last: last?.id };
    if (sent) stick.current = true;
    // A chat just opened (or its history just loaded): start at the latest message.
    if (last && last.chatId !== shownChat.current) {
      shownChat.current = last.chatId;
      stick.current = true;
    }
    if (stick.current) end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, streaming]);

  const a2ui = useMemo(() => deriveA2ui(messages), // the version note is in the language of the moment
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, inst.language]);
  const chatId = messages[0]?.chatId ?? '';
  // A pressed schedule card: checked first (`checking`), then shown in Tayang's dialog, then written (`saving`).
  const [confirm, setConfirm] = useState<{ action: A2uiAction; items: PlannedItem[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const schedule = useCallback(
    (a: A2uiAction) => {
      if (checking || saving) return;
      setChecking(true);
      void prepareSchedule(chatId, a)
        .then((items) => items && setConfirm({ action: a, items }))
        .finally(() => setChecking(false));
    },
    [chatId, checking, saving],
  );
  // The agent asked Tayang to schedule videos (POST /schedule): once its turn is over, check and confirm here.
  const pendingSchedule = useChat((s) => (chatId ? (s.actions[chatId] ?? []) : []).some((a) => a.name === 'schedule_videos'));
  useEffect(() => {
    if (!pendingSchedule || streaming || checking || saving || confirm) return;
    const a = useChat.getState().takeAction(chatId, 'schedule_videos');
    if (a) schedule(asAction(a));
  }, [pendingSchedule, streaming, checking, saving, confirm, chatId, schedule]);

  const confirmNow = async () => {
    if (!confirm || saving) return;
    setSaving(true);
    try {
      await confirmSchedule(chatId, confirm.action, confirm.items);
    } finally {
      setSaving(false);
      setConfirm(null);
    }
  };
  const actions = useMemo(
    () => ({ handle: onA2uiAction, locked: streaming || busy || checking || saving || confirm !== null, sendOptions, schedule }),
    [onA2uiAction, streaming, busy, checking, saving, confirm, sendOptions, schedule],
  );
  const last = messages[messages.length - 1];
  const startedAt = useChat((s) => (chatId ? s.turnStartedAt[chatId] : undefined));
  const render = useRender((s) => (chatId ? Object.values(s.runs).find((r) => r.chatId === chatId) : undefined));
  const turn = useMemo<LiveTurn>(() => ({ startedAt, render }), [startedAt, render]);
  return (
    <ActionsContext.Provider value={actions}>
    <div ref={log} className="flex flex-col gap-6" role="log" aria-label={t('chat.conversation')}>
      {messages.map((m, i) => {
        if (m.role === 'user') {
          return (
            <div key={messageKey(m)} data-turn={i} className="flex justify-end">
              <div className="flex max-w-[80%] flex-wrap items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[14px] leading-[1.6]">
                {m.parts.map((p, j) =>
                  p.type === 'text' ? (
                    <span key={j} className="whitespace-pre-wrap">
                      {p.text}
                    </span>
                  ) : p.type === 'mention' ? (
                    <Chip key={j}>@{p.title}</Chip>
                  ) : p.type === 'style-mention' ? (
                    <StyleChip key={j} name={p.name} />
                  ) : p.type === 'frame' ? (
                    <FrameChip key={j} part={p} />
                  ) : p.type === 'file' ? (
                    <SentFile key={j} part={p} />
                  ) : null,
                )}
              </div>
            </div>
          );
        }
        if (m.role === 'system') {
          return (
            <div key={messageKey(m)} className="flex items-start gap-3">
              <Oyen mood="surprised" size={28} />
              <SystemNote text={localized(m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))} />
              {m.parts.some(isScheduleRecord) && (
                <button
                  type="button"
                  onClick={() => useApp.getState().navigate({ name: 'calendar' })}
                  className="mt-1 inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm text-[13px] font-medium text-orange-light hover:underline"
                >
                  <CalendarDays size={14} strokeWidth={1.5} aria-hidden="true" />
                  {t('schedule.agent.openCalendar')}
                </button>
              )}
            </div>
          );
        }
        const working = streaming && i === messages.length - 1;
        // An agent message that only updated an earlier surface has nothing of its own to show.
        if (
          !working &&
          m.parts.every(
            (p) =>
              (p.type === 'text' && isUpdateOnly(p.text, a2ui.keys[`${m.id}:${m.parts.indexOf(p)}`], m.id, a2ui)) ||
              (p.type === 'tool' && isHiddenTool(p)),
          )
        ) {
          return null;
        }
        return (
          <div key={messageKey(m)} data-testid="agent-message" className="flex items-start gap-3">
            <Oyen mood={working ? 'sleepy' : 'default'} size={28} />
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <Parts parts={m.parts} live={working} messageId={m.id} a2ui={a2ui} turn={working ? turn : undefined} />
            </div>
          </div>
        );
      })}
      {streaming && (!last || last.role !== 'agent') && (
        <div className="flex items-start gap-3">
          <Oyen mood="sleepy" size={28} />
          <div className="pt-1">
            <WorkingLine turn={turn} silent />
          </div>
        </div>
      )}
      {children}
      <ScheduleConfirm
        items={confirm?.items ?? null}
        busy={saving}
        onConfirm={() => void confirmNow()}
        onCancel={() => setConfirm(null)}
      />
      <div ref={end} />
    </div>
    </ActionsContext.Provider>
  );
}


/** Lines a long system note shows before "Show all". */
const NOTE_LINES = 5;

/**
 * A note from Tayang: its first line, and any further lines (one scheduled video each) as a list,
 * the first few until the user asks for all of them.
 */
function SystemNote({ text }: { text: string }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const [head, ...lines] = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const shown = all ? lines : lines.slice(0, NOTE_LINES);
  return (
    <div className="flex min-w-0 flex-col gap-1 pt-1">
      <p className="m-0 text-[14px] text-text-2">{head}</p>
      {lines.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px] text-text-3">
          {shown.map((l, i) => (
            <li key={i} className="tabular-nums">
              {l}
            </li>
          ))}
        </ul>
      )}
      {lines.length > NOTE_LINES && (
        <button type="button" onClick={() => setAll(!all)} className="cursor-pointer self-start text-[13px] text-text-2 hover:text-foreground">
          {all ? t('chat.showLess') : t('chat.showAll', { count: lines.length })}
        </button>
      )}
    </div>
  );
}
