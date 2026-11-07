import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Autopilot, AutopilotSlot, MessagePart, Project, VideoKind } from '@tayang/shared';
import { buildTopicIdeasPrompt, topicIdeaFromAction } from '@tayang/skills';
import { Button } from '@/components/Button';
import { ScheduleDialog } from '@/components/ScheduleDialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { PermissionCard } from '@/components/PermissionCard';
import { QuestionCard } from '@/components/QuestionCard';
import { locale } from '@/i18n';
import { calendarState, type CalendarState } from '@/lib/calendarState';
import { approveAndPost } from '@/lib/autopilotPost';
import { listAutopilots, listProjects, listSlots, listStyles, setPosted, setSchedule, updateSlot } from '@/lib/ipc';
import { localized } from '@/lib/stored';
import { notifyAutopilotChanged, onAutopilotChanged } from '@/lib/autopilotHooks';
import { openProjectChat } from '@/lib/openProject';
import { ideasFromReply, startTopic, type TopicIdea } from '@/lib/topics';
import { cn } from '@/lib/utils';
import { useApp } from '@/state/app';
import { AUTOPILOT_ENABLED } from '@/lib/features';
import { headPermission, headQuestion, useChat } from '@/state/chat';

const KINDS: VideoKind[] = ['explainer', 'promo', 'quote', 'news', 'tutorial', 'data', 'event'];
const NO_MESSAGES: never[] = [];
const DAY_MS = 86_400_000;

/**
 * A slot drawn as a ghost entry: one being made, a failed one (even with a kept project, so the failure
 * and its Try again stay visible), and a planned one that has no video, unless its autopilot is paused.
 */
const isGhost = (s: AutopilotSlot, paused: boolean) =>
  s.status === 'making' || s.status === 'failed' || (s.status === 'planned' && !s.projectId && !paused);

type Idea = TopicIdea;

const STATE_DOT: Record<CalendarState, string> = {
  making: 'bg-primary',
  'needs-review': 'bg-orange-light',
  ready: 'bg-foreground',
  posted: 'bg-text-3',
  draft: 'border border-text-3',
};

/** Mon..Sun in the active language; 2024-01-01 is a Monday. */
const weekdays = () =>
  Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(new Date(2024, 0, 1 + i)));

const monthName = (month: number) => new Intl.DateTimeFormat(locale(), { month: 'long' }).format(new Date(2024, month, 1));

const pad = (n: number) => String(n).padStart(2, '0');
export const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 42 days, Monday first, starting on the Monday on or before the 1st. */
export function monthCells(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i));
}

function weekStart(today: Date) {
  return dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7)));
}

/** The week's ideas run in a scratch agent chat (no chat row), like a new chat's folder. */
export const ideasChatId = (today: Date) => `ideas-${weekStart(today)}`;

function weekKey(today: Date) {
  return `tayang.ideas.${weekStart(today)}`;
}

function readCache(key: string): Idea[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Idea[]) : [];
  } catch {
    return [];
  }
}

function agentText(parts: MessagePart[]) {
  return parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

export function Calendar({ today: todayProp }: { today?: Date } = {}) {
  const { t } = useTranslation();
  // The clock moves on while the Calendar stays open (the window can sit in the tray for days).
  const [clock, setClock] = useState(() => new Date());
  const today = todayProp ?? clock;
  useEffect(() => {
    if (todayProp) return;
    const id = setInterval(() => setClock(new Date()), 60_000);
    return () => clearInterval(id);
  }, [todayProp]);
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => onAutopilotChanged(() => setReloadTick((n) => n + 1)), []);
  const settings = useApp((s) => s.settings);
  const blocked = useApp((s) => s.notificationsBlocked);
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [projects, setProjects] = useState<Project[]>([]);
  const cacheKey = weekKey(today);
  const [ideas, setIdeas] = useState<Idea[]>(() => readCache(cacheKey));
  const [chatId, setChatId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [making, setMaking] = useState(false);
  const makingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const [scheduleFor, setScheduleFor] = useState<Project | null>(null);
  const [picking, setPicking] = useState(false);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [autopilots, setAutopilots] = useState<Autopilot[]>([]);
  const [slots, setSlots] = useState<AutopilotSlot[]>([]);
  const [slotError, setSlotError] = useState<string | null>(null);

  const messages = useChat((s) => (chatId ? s.messages[chatId] : undefined)) ?? NO_MESSAGES;
  const streaming = useChat((s) => (chatId ? !!s.streaming[chatId] : false));
  const permission = useChat((s) => headPermission(s, chatId));
  const question = useChat((s) => headQuestion(s, chatId));

  useEffect(() => {
    let alive = true;
    listProjects()
      .then((p) => alive && setProjects(p))
      .catch(() => {});
    useChat.getState().listen();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    listAutopilots()
      .then((l) => {
        setAutopilots(l);
        // A later load that works takes back an earlier load error (not an action's error).
        setSlotError((e) => (e === t('autopilot.cantLoad') ? null : e));
      })
      .catch(() => setSlotError(t('autopilot.cantLoad')));
  }, [reloadTick]);

  // Slots for the visible grid.
  const gridFrom = new Date(cursor.y, cursor.m, 1 - ((new Date(cursor.y, cursor.m, 1).getDay() + 6) % 7));
  const gridKey = dateKey(gridFrom);
  useEffect(() => {
    let alive = true;
    listSlots(gridFrom.toISOString(), new Date(gridFrom.getTime() + 43 * DAY_MS).toISOString())
      .then((l) => alive && setSlots(l))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [gridKey, reloadTick]);

  // When the agent's turn ends, turn its JSON into idea cards and cache them for the week.
  useEffect(() => {
    if (!chatId || streaming || !pending.current) return;
    const last = messages[messages.length - 1];
    // The ideas agent has nothing left to do once its turn ends.
    if (last?.role === 'system' || last?.role === 'agent') void useChat.getState().stop(chatId);
    if (last?.role === 'system') {
      pending.current = false;
      setAsking(false);
      setError(t('calendar.noIdeas'));
      return;
    }
    if (last?.role !== 'agent') return;
    pending.current = false;
    setAsking(false);
    const found = ideasFromReply(agentText(last.parts));
    if (!found.length) {
      setError(t('calendar.noIdeas'));
      return;
    }
    setIdeas(found);
    try {
      localStorage.setItem(cacheKey, JSON.stringify(found));
    } catch {
      /* cache is optional */
    }
  }, [chatId, streaming, messages, cacheKey]);

  // The agent asked Tayang to start the picked idea (POST /video): once its turn is over, start it.
  const pendingPick = useChat((s) => (chatId ? (s.actions[chatId] ?? []) : []).some((a) => a.name === 'pick_topic'));
  useEffect(() => {
    if (!pendingPick || !chatId || streaming) return;
    const a = useChat.getState().takeAction(chatId, 'pick_topic');
    const idea = a && topicIdeaFromAction(a.context);
    if (idea) void makeIdea(idea);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPick, streaming, chatId]);

  const makeIdea = async (idea: Idea) => {
    if (!settings || makingRef.current) return;
    makingRef.current = true;
    setMaking(true);
    try {
      await startTopic(idea, { settings, agent: settings.defaultAgent });
    } catch {
      setError(t('calendar.cantStart'));
      makingRef.current = false;
      setMaking(false);
    }
  };

  const getIdeas = async () => {
    if (!settings || asking) return;
    setAsking(true);
    setError(null);
    try {
      const styles = await listStyles().catch(() => []);
      const id = ideasChatId(today);
      setChatId(id);
      pending.current = true;
      const err = await useChat.getState().send(id, [{ type: 'text', text: t('calendar.suggest') }], {
        promptParts: [{ type: 'text', text: buildTopicIdeasPrompt(KINDS, settings.language, styles.map((s) => ({ id: s.id, name: s.name }))) }],
      });
      if (err) throw new Error(err);
    } catch (e) {
      pending.current = false;
      setAsking(false);
      setError(t('calendar.noIdeasWhy', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const cells = monthCells(cursor.y, cursor.m);
  const todayKey = dateKey(today);
  const events = useMemo(() => {
    const map: Record<string, ({ p: Project; slot?: undefined; at: Date } | { slot: AutopilotSlot; p?: undefined; at: Date })[]> = {};
    for (const p of projects) {
      if (!p.scheduledAt) continue;
      const at = new Date(p.scheduledAt);
      if (Number.isNaN(at.getTime())) continue;
      (map[dateKey(at)] ??= []).push({ p, at });
    }
    for (const slot of slots) {
      const at = new Date(slot.dueAt);
      const owner = autopilots.find((a) => a.id === slot.autopilotId);
      if (!owner || !isGhost(slot, owner.status === 'paused') || Number.isNaN(at.getTime())) continue;
      (map[dateKey(at)] ??= []).push({ slot, at });
    }
    for (const list of Object.values(map)) list.sort((a, b) => a.at.getTime() - b.at.getTime());
    return map;
  }, [projects, slots, autopilots]);

  const tryAgain = async (slot: AutopilotSlot) => {
    setSlotError(null);
    try {
      const next = await updateSlot(slot.id, { status: 'planned', error: null, projectId: null });
      setSlots((l) => l.map((x) => (x.id === next.id ? next : x)));
      notifyAutopilotChanged();
    } catch {
      setSlotError(t('autopilot.cantUpdate'));
    }
  };

  const replace = (p: Project) => setProjects((list) => list.map((x) => (x.id === p.id ? p : x)));
  const update = async (job: Promise<Project>) => {
    setGridError(null);
    try {
      replace(await job);
    } catch {
      setGridError(t('calendar.cantUpdate'));
    }
  };

  /** Dropping an entry on another day keeps its time of day. */
  const moveTo = (id: string, day: Date) => {
    const p = projects.find((x) => x.id === id);
    const from = p?.scheduledAt ? new Date(p.scheduledAt) : null;
    if (!p || !from || Number.isNaN(from.getTime()) || dateKey(from) === dateKey(day)) return;
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), from.getHours(), from.getMinutes());
    void update(setSchedule(id, next.toISOString()));
  };

  const go = (delta: number) =>
    setCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  return (
    <div className="flex h-full flex-wrap content-start gap-6 overflow-y-auto p-8">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-4">
        <div data-tauri-drag-region className="flex flex-wrap items-center gap-2">
          <h1 className="m-0 mr-auto text-[28px] font-semibold tracking-[-0.01em]">
            {monthName(cursor.m)} {cursor.y}
          </h1>
          <Button variant="secondary" className="h-9 px-3 text-[13px]" onClick={() => setPicking(true)}>
            {t('calendar.scheduleVideo')}
          </Button>
          <Button variant="secondary" aria-label={t('calendar.previous')} className="size-9 px-0 text-text-2" onClick={() => go(-1)}>
            <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          </Button>
          <Button variant="secondary" className="h-9 px-3 text-[13px]" onClick={() => setCursor({ y: today.getFullYear(), m: today.getMonth() })}>
            {t('calendar.today')}
          </Button>
          <Button variant="secondary" aria-label={t('calendar.next')} className="size-9 px-0 text-text-2" onClick={() => go(1)}>
            <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />
          </Button>
        </div>
        {AUTOPILOT_ENABLED && (
        <button
          type="button"
          onClick={() => useApp.getState().navigate({ name: 'autopilot' })}
          className="cursor-pointer self-start border-0 bg-transparent p-0 text-xs text-orange-light underline"
        >
          {t('calendar.manageAutopilots')}
        </button>
        )}
        {slotError && (
          <p role="alert" className="m-0 text-xs text-orange-light">
            {slotError}
          </p>
        )}
        {blocked && (
          <p role="status" className="m-0 rounded-xl border border-border bg-card px-4 py-3 text-xs text-text-2">
            {t('reminders.blocked')}
          </p>
        )}
        {gridError && (
          <p role="alert" className="m-0 text-xs text-orange-light">
            {gridError}
          </p>
        )}
        <div className="flex flex-wrap gap-4 text-xs text-text-2">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            {t('calendar.ready')}
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-1.5 rounded-full border border-text-3" />
            {t('calendar.planned')}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-[#101010]">
          <div className="grid grid-cols-7 border-b border-border">
            {weekdays().map((d) => (
              <span key={d} className="p-2 text-xs text-text-3">
                {d}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((d) => {
              const key = dateKey(d);
              const inMonth = d.getMonth() === cursor.m;
              return (
                <div
                  key={key}
                  data-testid="cal-cell"
                  data-date={key}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = dragId.current;
                    const carried = e.dataTransfer?.getData('text/plain');
                    dragId.current = null;
                    // Only the entry being dragged right now may move; a stray drop is ignored.
                    if (id && (!carried || carried === id)) moveTo(id, d);
                  }}
                  className={cn(
                    'flex min-h-[92px] min-w-0 flex-col gap-1 border-r border-b border-[#1F1F1F] p-1',
                    !inMonth && 'bg-[#0B0B0B]',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex h-6 min-w-6 items-center justify-center self-start rounded-sm font-mono text-xs tabular-nums',
                      key === todayKey ? 'bg-foreground text-ink' : inMonth ? 'text-text-2' : 'text-[#4A4A4A]',
                    )}
                  >
                    {d.getDate()}
                  </span>
                  {(events[key] ?? []).map(({ p, slot, at }) => {
                    if (slot) {
                      const name = autopilots.find((a) => a.id === slot.autopilotId)?.name ?? '';
                      const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
                      const label = t(`calendar.ghost.${slot.status === 'making' ? 'making' : slot.status === 'failed' ? 'failed' : 'planned'}`, { name });
                      return (
                        <div
                          key={slot.id}
                          data-testid="cal-ghost"
                          role="note"
                          aria-label={t('calendar.ghost.aria', { label, time })}
                          className="flex min-w-0 flex-col gap-0.5 rounded-sm border border-dashed border-[#333] px-2 py-1 text-left text-text-2"
                        >
                          <span className="flex items-center gap-1 font-mono text-[10px] text-text-3">
                            <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', slot.status === 'making' ? 'bg-primary' : 'border border-text-3')} />
                            {time}
                          </span>
                          <span className="truncate text-[11px] font-medium">{label}</span>
                          {slot.status === 'failed' && (
                            <>
                              {slot.projectId && projects.find((x) => x.id === slot.projectId) && (
                                <span className="truncate text-[10px] text-text-3">{projects.find((x) => x.id === slot.projectId)?.title}</span>
                              )}
                              {slot.error && <span className="truncate text-[10px] text-orange-light">{localized(slot.error)}</span>}
                              {at.getTime() > today.getTime() && (
                                <button
                                  type="button"
                                  aria-label={t('calendar.ghost.tryAgainAria', { name })}
                                  className="cursor-pointer self-start border-0 bg-transparent p-0 text-[10px] text-orange-light underline"
                                  onClick={() => void tryAgain(slot)}
                                >
                                  {t('calendar.ghost.tryAgain')}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      );
                    }
                    if (!p) return null;
                    const state = calendarState(p, today);
                    const stateLabel = t(`calendar.states.${state}`);
                    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
                    return (
                      <Popover key={p.id} open={openEntry === p.id} onOpenChange={(o) => setOpenEntry(o ? p.id : null)}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            draggable
                            data-testid="cal-entry"
                            aria-label={t('calendar.entryAria', { title: p.title, state: stateLabel, time })}
                            onDragEnd={() => {
                              dragId.current = null;
                            }}
                            onDragStart={(e) => {
                              dragId.current = p.id;
                              e.dataTransfer?.setData('text/plain', p.id);
                            }}
                            className={cn(
                              'flex min-w-0 flex-col gap-0.5 rounded-sm px-2 py-1 text-left text-foreground',
                              state === 'draft' ? 'border border-dashed border-[#333]' : 'bg-raised',
                            )}
                          >
                            <span className="flex items-center gap-1 font-mono text-[10px] text-text-3">
                              <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', STATE_DOT[state])} />
                              {time}
                            </span>
                            <span className="truncate text-[11px] font-medium">{p.title}</span>
                            <span className="truncate text-[10px] text-text-3">{stateLabel}</span>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="flex w-56 flex-col gap-1 p-2">
                          <Button
                            variant="ghost"
                            className="h-8 justify-start px-2 text-[13px]"
                            onClick={() => {
                              setOpenEntry(null);
                              void openProjectChat(p).catch(() => setGridError(t('calendar.cantUpdate')));
                            }}
                          >
                            {t('calendar.openVideo')}
                          </Button>
                          <Button
                            variant="ghost"
                            className="h-8 justify-start px-2 text-[13px]"
                            onClick={() => {
                              setOpenEntry(null);
                              setScheduleFor(p);
                            }}
                          >
                            {t('calendar.schedule')}
                          </Button>
                          {p.reviewState === 'pending' && (
                            <Button
                              variant="ghost"
                              className="h-8 justify-start px-2 text-[13px]"
                              onClick={() => {
                                setOpenEntry(null);
                                void update(approveAndPost(p.id));
                              }}
                            >
                              {t('calendar.approve')}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            className="h-8 justify-start px-2 text-[13px]"
                            onClick={() => {
                              setOpenEntry(null);
                              void update(setPosted(p.id, !p.postedAt));
                            }}
                          >
                            {p.postedAt ? t('calendar.notPosted') : t('calendar.markPosted')}
                          </Button>
                        </PopoverContent>
                      </Popover>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <aside className="flex max-w-[300px] flex-[1_1_260px] flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('calendar.ideasTitle')}</span>
            <span className="text-xs text-text-3">{t('calendar.ideasHint')}</span>
          </div>
          {ideas.map((i) => (
            <div key={i.title} className="flex items-center gap-2 rounded-md bg-[#222] p-2">
              <div className="mr-auto flex min-w-0 flex-col gap-1">
                <span className="text-[13px] leading-[1.3] font-medium">{i.title}</span>
                <span className="text-xs text-text-3">
                  {t(`kinds.${i.kind}`)} · {t('chat.seconds', { n: i.lengthSec })}
                </span>
              </div>
              <Button variant="secondary" className="h-7 shrink-0 rounded-sm px-2 text-xs" disabled={making} onClick={() => void makeIdea(i)}>
                {t('calendar.makeIt')}
              </Button>
            </div>
          ))}
          {question && chatId && (
            <QuestionCard
              question={question}
              agentId={settings?.defaultAgent ?? 'claude'}
              onRespond={(r, summary) => void useChat.getState().respondQuestion(chatId, r, summary)}
            />
          )}
          {permission && chatId && (
            <PermissionCard
              request={permission}
              agentId={settings?.defaultAgent ?? 'claude'}
              allowLabel={t('permission.allow')}
              onRespond={(o) => void useChat.getState().respondPermission(chatId, o)}
            />
          )}
          {error && (
            <p role="alert" className="m-0 text-xs text-orange-light">
              {error}
            </p>
          )}
          <Button variant="secondary" className="h-9 self-start px-3 text-[13px]" disabled={asking} onClick={() => void getIdeas()}>
            {asking ? t('calendar.asking') : ideas.length ? t('calendar.getNew') : t('calendar.get')}
          </Button>
        </div>

      </aside>
      <ScheduleDialog
        open={scheduleFor !== null || picking}
        onOpenChange={(o) => {
          if (!o) {
            setScheduleFor(null);
            setPicking(false);
          }
        }}
        project={scheduleFor}
        choices={projects.filter((p) => !p.scheduledAt && !p.postedAt)}
        onSaved={replace}
      />
    </div>
  );
}
