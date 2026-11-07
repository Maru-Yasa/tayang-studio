import type { TraceSpan } from '@tayang/shared';

/** A pause longer than this between turns is cut from the axis, so a chat picked up days later still fits. */
export const IDLE_GAP_MS = 60_000;

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].map((s) => s * 1000);

export interface TraceScale {
  /** Active time on the axis, in ms. */
  total: number;
  /** A moment's place on the axis, in ms from the start. */
  at(ms: number): number;
  /** Where idle pauses were cut, in axis ms. */
  breaks: number[];
}

/** The time axis of a trace: real time, without the long pauses between turns. */
export function buildScale(spans: TraceSpan[]): TraceScale {
  if (!spans.length) return { total: 0, at: () => 0, breaks: [] };
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const start = sorted[0]!.startMs;
  const cuts: { from: number; removed: number }[] = [];
  let reach = sorted[0]!.endMs;
  let removed = 0;
  for (const s of sorted) {
    if (s.startMs - reach > IDLE_GAP_MS) {
      removed += s.startMs - reach;
      cuts.push({ from: s.startMs, removed });
    }
    reach = Math.max(reach, s.endMs);
  }
  const at = (ms: number) => {
    let cut = 0;
    for (const c of cuts) if (ms >= c.from) cut = c.removed;
    return ms - start - cut;
  };
  return { total: Math.max(reach - start - removed, 1), at, breaks: cuts.map((c) => c.from - start - c.removed) };
}

/** Tick marks at a round step, about `count` of them. */
export function axisTicks(total: number, count = 7): number[] {
  const step = STEPS.find((s) => total / s <= count) ?? STEPS[STEPS.length - 1]!;
  const ticks: number[] = [];
  for (let t = 0; t < total; t += step) ticks.push(t);
  return ticks;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const whole = Math.round(s);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${pad(whole % 60)}s`;
  return `${Math.floor(whole / 3600)}h ${pad(Math.floor(whole / 60) % 60)}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const trim = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));
  return n < 999_500 ? `${trim(n / 1000)}K` : `${trim(n / 1_000_000)}M`;
}

/** The context a model call was sent: new input plus what came from and went into the cache. */
export const contextOf = (s: TraceSpan) => s.inputTokens + s.cacheWriteTokens + s.cacheReadTokens;

export interface TraceSummary {
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  failedTools: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  /** The most context one model call carried. */
  peakContext: number;
}

export function summarize(spans: TraceSpan[]): TraceSummary {
  const llm = spans.filter((s) => s.kind === 'llm');
  const tools = spans.filter((s) => s.kind === 'tool');
  // A tool's tokens are its subagent's; a turn's only repeat its calls.
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens') => [...llm, ...tools].reduce((n, s) => n + s[key], 0);
  return {
    durationMs: spans.length ? buildScale(spans).total : 0,
    modelCalls: llm.length,
    toolCalls: tools.length,
    failedTools: tools.filter((s) => s.failed).length,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    peakContext: llm.reduce((n, s) => Math.max(n, contextOf(s)), 0),
  };
}

export interface TraceRow {
  span: TraceSpan;
  depth: number;
  /** Which turn this is, from 1, on a turn row. */
  turn?: number;
}

/** The rows on screen: each turn, then its calls in order unless the turn is collapsed. */
export function visibleRows(spans: TraceSpan[], collapsed: ReadonlySet<string>): TraceRow[] {
  const rows: TraceRow[] = [];
  let turn = 0;
  for (const span of spans) {
    if (span.kind !== 'turn') continue;
    turn += 1;
    rows.push({ span, depth: 0, turn });
    if (collapsed.has(span.id)) continue;
    for (const child of spans) if (child.parentId === span.id) rows.push({ span: child, depth: 1 });
  }
  return rows;
}
