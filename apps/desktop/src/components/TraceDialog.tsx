import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChartNoAxesGantt, ChevronDown, ChevronRight, CircleAlert, RefreshCw, Sparkles, Wrench } from 'lucide-react';
import type { ChatTrace, TraceSpan } from '@tayang/shared';
import { Button } from '@/components/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getChatTrace } from '@/lib/ipc';
import { axisTicks, buildScale, contextOf, formatDuration, formatTokens, summarize, visibleRows, type TraceRow, type TraceScale } from '@/lib/trace';
import { cn } from '@/lib/utils';
import { useChat } from '@/state/chat';

const POLL_MS = 10_000;
/** Checked with the dataviz palette validator against the card colour. */
const LLM_BAR = 'bg-[#e8693f]';
const TOOL_BAR = 'bg-[#5f8ee8]';

const shortModel = (name: string) => name.replace(/^claude-/, '');

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] text-text-3">{label}</span>
      <span className="text-[15px] font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function Bar({ span, scale }: { span: TraceSpan; scale: TraceScale }) {
  const left = (scale.at(span.startMs) / scale.total) * 100;
  const width = ((scale.at(span.endMs) - scale.at(span.startMs)) / scale.total) * 100;
  return (
    <span
      data-testid="trace-bar"
      className={cn(
        'absolute top-1/2 -translate-y-1/2 rounded-sm',
        span.kind === 'turn' ? 'h-1.5 bg-hairline' : span.kind === 'llm' ? cn('h-3', LLM_BAR) : cn('h-3', TOOL_BAR),
      )}
      style={{ left: `${left}%`, width: `max(${width}%, 2px)` }}
    />
  );
}

function RowIcon({ row }: { row: TraceRow }) {
  if (row.span.kind === 'llm') return <Sparkles size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-[#e8693f]" />;
  if (row.span.kind === 'tool') return <Wrench size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-[#5f8ee8]" />;
  return null;
}

function Detail({ span, scale, streaming }: { span: TraceSpan | undefined; scale: TraceScale; streaming: boolean }) {
  const { t } = useTranslation();
  if (!span) return <p className="m-0 text-xs text-text-3">{t('trace.hint')}</p>;
  const tokens = span.kind !== 'tool' || span.outputTokens > 0;
  return (
    <div data-testid="trace-detail" className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-2">
        <span className="font-medium text-foreground">{span.kind === 'turn' ? t('trace.turnKind') : span.kind === 'llm' ? shortModel(span.name) : span.name}</span>
        <span className="tabular-nums">{t('trace.startedAt', { when: formatDuration(scale.at(span.startMs)) })}</span>
        <span className="tabular-nums">{t('trace.tookFor', { when: formatDuration(span.endMs - span.startMs) })}</span>
        {tokens && (
          <>
            <span className="tabular-nums">{t('trace.inputTokens', { count: formatTokens(span.inputTokens) })}</span>
            <span className="tabular-nums">{t('trace.cacheWrite', { count: formatTokens(span.cacheWriteTokens) })}</span>
            <span className="tabular-nums">{t('trace.cacheRead', { count: formatTokens(span.cacheReadTokens) })}</span>
            <span className="tabular-nums">{t('trace.output', { count: formatTokens(span.outputTokens) })}</span>
          </>
        )}
        {span.failed && (
          <span className="inline-flex items-center gap-1 text-error">
            <CircleAlert size={12} strokeWidth={1.5} aria-hidden="true" />
            {t('trace.failed')}
          </span>
        )}
        {span.open && <span className="text-text-3">{streaming ? t('trace.running') : t('trace.noResult')}</span>}
      </div>
      {span.detail && <p className="m-0 line-clamp-2 break-words text-xs text-text-3">{span.detail}</p>}
    </div>
  );
}

function Timeline({ trace, streaming }: { trace: ChatTrace; streaming: boolean }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const scale = useMemo(() => buildScale(trace.spans), [trace.spans]);
  const ticks = useMemo(() => axisTicks(scale.total), [scale.total]);
  const rows = useMemo(() => visibleRows(trace.spans, collapsed), [trace.spans, collapsed]);
  const shown = trace.spans.find((s) => s.id === (hovered ?? selected));
  const pct = (ms: number) => `${(ms / scale.total) * 100}%`;
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <>
      <div className="flex shrink-0 items-center gap-4 text-[11px] text-text-2">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('h-2.5 w-4 rounded-sm', LLM_BAR)} />
          {t('trace.legendModel')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('h-2.5 w-4 rounded-sm', TOOL_BAR)} />
          {t('trace.legendTool')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-1.5 w-4 rounded-sm bg-hairline" />
          {t('trace.legendTurn')}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
        <div className="min-w-[760px]">
          <div className="sticky top-0 z-10 grid h-8 grid-cols-[300px_112px_minmax(0,1fr)] items-center border-b border-border bg-card text-[11px] text-text-3">
            <span className="px-3">{t('trace.columnCall')}</span>
            <span className="text-right">{t('trace.columnTokens')}</span>
            <div className="relative mx-3 h-full">
              {ticks.map((tick) => (
                <span key={tick} className="absolute top-1/2 -translate-y-1/2 tabular-nums" style={{ left: pct(tick) }}>
                  {formatDuration(tick)}
                </span>
              ))}
            </div>
          </div>

          <ul role="list" className="m-0 list-none p-0">
            {rows.map((row) => {
              const { span } = row;
              const isTurn = span.kind === 'turn';
              const label = isTurn ? t('trace.turn', { n: row.turn ?? 0 }) : span.kind === 'llm' ? shortModel(span.name) : span.name;
              return (
                <li
                  key={span.id}
                  data-testid="trace-row"
                  onMouseEnter={() => setHovered(span.id)}
                  onMouseLeave={() => setHovered(null)}
                  className={cn('grid h-7 grid-cols-[300px_112px_minmax(0,1fr)] items-center text-xs', selected === span.id ? 'bg-raised' : 'hover:bg-raised/60')}
                >
                  <div className="flex min-w-0 items-center" style={{ paddingLeft: row.depth ? 28 : 6 }}>
                    {isTurn && (
                      <button
                        type="button"
                        aria-expanded={!collapsed.has(span.id)}
                        aria-label={t(collapsed.has(span.id) ? 'trace.expand' : 'trace.collapse', { name: label })}
                        onClick={() => toggle(span.id)}
                        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent p-0 text-text-3 hover:text-foreground"
                      >
                        {collapsed.has(span.id) ? <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" /> : <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-pressed={selected === span.id}
                      onFocus={() => setHovered(span.id)}
                      onBlur={() => setHovered(null)}
                      onClick={() => setSelected((s) => (s === span.id ? null : span.id))}
                      className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 pr-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <RowIcon row={row} />
                      <span className={cn('shrink-0', isTurn ? 'font-medium text-foreground' : 'text-text-2')}>{label}</span>
                      {span.detail && <span className="min-w-0 truncate text-text-3">{span.detail}</span>}
                      {span.failed && <CircleAlert size={12} strokeWidth={1.5} aria-label={t('trace.failed')} className="ml-auto shrink-0 text-error" />}
                    </button>
                  </div>
                  <span className="truncate text-right tabular-nums text-text-2">
                    {span.kind === 'tool' && !span.outputTokens ? formatDuration(span.endMs - span.startMs) : `${formatTokens(contextOf(span))} → ${formatTokens(span.outputTokens)}`}
                  </span>
                  <div className="relative mx-3 h-full">
                    {ticks.map((tick) => (
                      <span key={tick} aria-hidden="true" className="absolute inset-y-0 w-px bg-border" style={{ left: pct(tick) }} />
                    ))}
                    {scale.breaks.map((b) => (
                      <span key={b} aria-hidden="true" className="absolute inset-y-0 border-l border-dashed border-text-3" style={{ left: pct(b) }} />
                    ))}
                    <Bar span={span} scale={scale} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="min-h-14 shrink-0">
        <Detail span={shown} scale={scale} streaming={streaming} />
      </div>
    </>
  );
}

/** A chat's trace: every turn, model call and tool call on a time axis, with their tokens. */
export function TraceDialog({ chatId, open, onOpenChange }: { chatId: string; open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useTranslation();
  const streaming = useChat((s) => !!s.streaming[chatId]);
  const [trace, setTrace] = useState<ChatTrace | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTrace(await getChatTrace(chatId));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  useEffect(() => {
    if (!open || !streaming) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [open, streaming, load]);

  const sum = useMemo(() => summarize(trace?.spans ?? []), [trace]);
  const hasSpans = !!trace?.spans.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[92vw] max-w-[1280px] flex-col gap-3 sm:max-w-[1280px]">
        <DialogHeader className="shrink-0 pr-8">
          <div className="flex items-center gap-3">
            <DialogTitle>{t('trace.title')}</DialogTitle>
            <Button variant="ghost" className="h-7 gap-1.5 px-2 text-xs" disabled={loading} onClick={() => void load()}>
              <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" className={cn(loading && 'motion-safe:animate-spin')} />
              {t('trace.refresh')}
            </Button>
          </div>
          <DialogDescription>{t('trace.subtitle')}</DialogDescription>
        </DialogHeader>

        {failed && (
          <p role="alert" className="m-0 text-xs text-error">
            {t('trace.cantLoad')}
          </p>
        )}

        {hasSpans && (
          <>
            <div className="flex shrink-0 flex-wrap gap-x-8 gap-y-2">
              <Stat label={t('trace.statTime')} value={formatDuration(sum.durationMs)} />
              {trace.costUsd != null && <Stat label={t('trace.statCost')} value={`$${trace.costUsd.toFixed(2)}`} />}
              <Stat label={t('trace.statCalls')} value={`${sum.modelCalls} · ${sum.toolCalls}`} />
              <Stat label={t('trace.statPeak')} value={formatTokens(sum.peakContext)} />
              <Stat label={t('trace.statOutput')} value={formatTokens(sum.outputTokens)} />
              <Stat label={t('trace.statCacheWrite')} value={formatTokens(sum.cacheWriteTokens)} />
              <Stat label={t('trace.statCacheRead')} value={formatTokens(sum.cacheReadTokens)} />
            </div>
            <Timeline trace={trace} streaming={streaming} />
          </>
        )}

        {trace && !hasSpans && !failed && (
          <div className="flex flex-1 items-center justify-center text-center text-sm text-text-2">{t(trace.supported ? 'trace.empty' : 'trace.otherAgent')}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The header button that opens a chat's trace. */
export function TraceButton({ chatId, className }: { chatId: string; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" className={cn('size-9 shrink-0 px-0', className)} aria-label={t('trace.open')} title={t('trace.open')} onClick={() => setOpen(true)}>
        <ChartNoAxesGantt size={16} strokeWidth={1.5} aria-hidden="true" />
      </Button>
      {open && <TraceDialog chatId={chatId} open={open} onOpenChange={setOpen} />}
    </>
  );
}
