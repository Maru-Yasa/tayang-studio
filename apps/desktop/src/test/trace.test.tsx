import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTrace, TraceSpan } from '@tayang/shared';

vi.mock('@/lib/ipc', async (original) => ({ ...(await original<typeof import('@/lib/ipc')>()), getChatTrace: vi.fn() }));

import * as ipc from '@/lib/ipc';
import { setUiLanguage } from '@/i18n';
import { TraceButton } from '@/components/TraceDialog';
import { axisTicks, buildScale, contextOf, formatDuration, formatTokens, summarize, visibleRows } from '@/lib/trace';

const span = (id: string, kind: TraceSpan['kind'], startMs: number, endMs: number, extra: Partial<TraceSpan> = {}): TraceSpan => ({
  id,
  parentId: kind === 'turn' ? null : 't1',
  kind,
  name: kind === 'llm' ? 'claude-opus-5-5' : kind === 'tool' ? 'Bash' : '',
  detail: null,
  startMs,
  endMs,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  failed: false,
  open: false,
  ...extra,
});

const SPANS = [
  span('t1', 'turn', 0, 10_000, { detail: 'Make a video', outputTokens: 500, inputTokens: 1, cacheReadTokens: 1000, cacheWriteTokens: 200 }),
  span('m1', 'llm', 0, 4000, { inputTokens: 1, cacheReadTokens: 1000, cacheWriteTokens: 200, outputTokens: 500 }),
  span('b1', 'tool', 4000, 10_000, { detail: 'Render it', failed: true }),
  span('t2', 'turn', 3_600_000, 3_602_000, { detail: 'Again' }),
  span('m2', 'llm', 3_600_000, 3_602_000, { parentId: 't2', outputTokens: 2000 }),
];

describe('trace helpers', () => {
  it('formats durations and tokens', () => {
    expect([0, 620, 1300, 45_000, 125_000, 3_720_000].map(formatDuration)).toEqual(['0ms', '620ms', '1.3s', '45s', '2m 05s', '1h 02m']);
    expect([940, 1234, 142_000, 999_600, 5_310_469].map(formatTokens)).toEqual(['940', '1.2K', '142K', '1.0M', '5.3M']);
  });

  it('cuts long pauses from the axis and marks them', () => {
    const scale = buildScale(SPANS);
    expect(scale.total).toBe(12_000);
    expect(scale.at(10_000)).toBe(10_000);
    expect(scale.at(3_600_000)).toBe(10_000);
    expect(scale.at(3_602_000)).toBe(12_000);
    expect(scale.breaks).toEqual([10_000]);
  });

  it('keeps short pauses on the axis', () => {
    const scale = buildScale([span('a', 'llm', 0, 1000), span('b', 'llm', 30_000, 31_000)]);
    expect(scale.total).toBe(31_000);
    expect(scale.breaks).toEqual([]);
  });

  it('has round ticks that stay inside the axis, and an empty trace does not break', () => {
    expect(axisTicks(12_000)).toEqual([0, 2000, 4000, 6000, 8000, 10_000]);
    expect(axisTicks(2_548_514).length).toBeLessThanOrEqual(7);
    expect(buildScale([]).total).toBe(0);
    expect(summarize([]).durationMs).toBe(0);
  });

  it('adds up calls without counting a turn twice, and finds the largest context', () => {
    const s = summarize(SPANS);
    expect([s.modelCalls, s.toolCalls, s.failedTools]).toEqual([2, 1, 1]);
    expect(s.outputTokens).toBe(2500);
    expect(s.peakContext).toBe(contextOf(SPANS[1]!));
    expect(s.peakContext).toBe(1201);
  });

  it('counts a subagent, whose tokens sit on its tool call', () => {
    expect(summarize([span('a', 'tool', 0, 1, { outputTokens: 7 })]).outputTokens).toBe(7);
  });

  it('lists turns with their calls, and hides the calls of a collapsed turn', () => {
    expect(visibleRows(SPANS, new Set()).map((r) => r.span.id)).toEqual(['t1', 'm1', 'b1', 't2', 'm2']);
    const rows = visibleRows(SPANS, new Set(['t1']));
    expect(rows.map((r) => r.span.id)).toEqual(['t1', 't2', 'm2']);
    expect(rows.map((r) => r.turn)).toEqual([1, 2, undefined]);
  });
});

describe('TraceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setUiLanguage('en');
  });
  const open = async (trace: ChatTrace) => {
    vi.mocked(ipc.getChatTrace).mockResolvedValue(trace);
    render(<TraceButton chatId="c1" />);
    await userEvent.click(screen.getByRole('button', { name: 'See what this chat did' }));
  };

  it('loads only when opened, then shows the totals, a row per call and a bar for each', async () => {
    vi.mocked(ipc.getChatTrace).mockResolvedValue({ spans: SPANS, supported: true, costUsd: 6.625 });
    render(<TraceButton chatId="c1" />);
    expect(ipc.getChatTrace).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'See what this chat did' }));
    await screen.findByRole('dialog');
    const rows = await screen.findAllByTestId('trace-row');
    expect(ipc.getChatTrace).toHaveBeenCalledWith('c1');
    expect(rows).toHaveLength(5);
    expect(screen.getAllByTestId('trace-bar')).toHaveLength(5);
    expect(screen.getByText('$6.63')).toBeInTheDocument();
    expect(screen.getByText('2 · 1')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Turn 1')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('opus-5-5')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('1.2K → 500')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Render it')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('6.0s')).toBeInTheDocument();
    expect(within(rows[2]!).getByLabelText('Failed')).toBeInTheDocument();
  });

  it('collapses a turn and shows a row\'s details on click', async () => {
    await open({ spans: SPANS, supported: true, costUsd: null });
    await screen.findAllByTestId('trace-row');
    expect(screen.queryByText('Reported cost')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Turn 1' }));
    expect(screen.getAllByTestId('trace-row')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Expand Turn 1' }));
    await userEvent.click(within(screen.getAllByTestId('trace-row')[1]!).getByRole('button', { name: /opus-5-5/ }));
    const detail = screen.getByTestId('trace-detail');
    expect(within(detail).getByText('Cache read 1.0K')).toBeInTheDocument();
    expect(within(detail).getByText('Took 4.0s')).toBeInTheDocument();
  });

  it('says so for another agent, for an empty trace and when loading fails', async () => {
    await open({ spans: [], supported: false, costUsd: null });
    expect(await screen.findByText('Traces are only available for chats with Claude Code.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    vi.mocked(ipc.getChatTrace).mockRejectedValue(new Error('x'));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the trace. Try again"));
  });
});
