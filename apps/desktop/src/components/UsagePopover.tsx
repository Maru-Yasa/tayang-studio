import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, RefreshCw } from 'lucide-react';
import type { AgentUsage, UsageWindow } from '@tayang/shared';
import { AgentLogo } from '@/components/AgentLogo';
import { UsageMeter, pct, spendRow, spendTitle, usageMessage, usageLine } from '@/components/UsageBar';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AGENT_NAMES } from '@/lib/agents';
import { formatResetIn } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useApp } from '@/state/app';
import { useUsage } from '@/state/usage';

type View = 'detailed' | 'compact';
const KEY = 'tayang.usageView';

function readView(): View {
  try {
    return localStorage.getItem(KEY) === 'compact' ? 'compact' : 'detailed';
  } catch {
    return 'detailed';
  }
}

function Row({ label, w, text }: { label: string; w: UsageWindow; text?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-text-2">{label}</span>
      <UsageMeter percent={w.usedPercent} label={t('usage.rowAria', { label })} />
      <span className="w-9 shrink-0 text-right font-mono text-xs">{text ?? pct(w.usedPercent)}</span>
    </div>
  );
}

export function AgentBlock({ u, view }: { u: AgentUsage; view: View }) {
  const { t } = useTranslation();
  const name = AGENT_NAMES[u.agentId];
  const ok = u.status === 'ok';
  const reset = formatResetIn(u.session?.resetsAt ?? null);
  if (view === 'compact') {
    return (
      <div className="flex items-center gap-2" data-testid="usage-row">
        <AgentLogo id={u.agentId} size={16} />
        <span className="w-20 shrink-0 truncate text-[13px]">{name}</span>
        <span className="truncate font-mono text-xs text-text-2">
          {!ok || u.spend ? usageLine(u) : [u.session, u.weekly, u.modelWeekly?.window].filter(Boolean).map((w) => pct(w!.usedPercent)).join(' · ')}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="usage-row">
      <div className="flex items-center gap-2">
        <AgentLogo id={u.agentId} size={18} />
        <span className="text-[13px] font-medium">{name}</span>
        {ok && reset && (
          <span className="ml-auto text-xs text-text-2">
            {/* Under a minute left: "Resets in now" reads wrong. */}
            {reset === t('common.now') ? t('usage.resetsNow') : t('usage.resetsIn', { time: reset })}
          </span>
        )}
      </div>
      {ok && u.spend ? (
        <>
          {[
            { label: t('usage.today'), s: u.spend.today },
            { label: t('usage.lastWeek'), s: u.spend.week },
          ].map(({ label, s }) => (
            <div key={label} className="flex items-center gap-2" title={spendTitle(s)}>
              <span className="w-14 shrink-0 text-xs text-text-2">{label}</span>
              <span className="truncate font-mono text-xs">{spendRow(s)}</span>
            </div>
          ))}
          <span className="text-[11px] text-text-3">{t('usage.noLimits')}</span>
        </>
      ) : ok ? (
        <>
          {u.session && <Row label={t('usage.five')} w={u.session} />}
          {u.weekly && <Row label={t('usage.week')} w={u.weekly} />}
          {u.modelWeekly && <Row label={u.modelWeekly.label} w={u.modelWeekly.window} />}
        </>
      ) : (
        <span className="text-xs text-text-2">{usageMessage(u)}</span>
      )}
    </div>
  );
}

export function UsagePopover({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>(readView);
  const usage = useUsage((s) => s.usage);
  const loading = useUsage((s) => s.loading);
  const refresh = useUsage((s) => s.refresh);
  const navigate = useApp((s) => s.navigate);

  const pick = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* the choice just won't persist */
    }
  };
  const go = (route: Parameters<typeof navigate>[0]) => {
    setOpen(false);
    navigate(route);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 gap-0 bg-card p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-[14px] font-semibold">{t('usage.title')}</span>
          <span className="text-xs text-text-3">{t('usage.allAgents')}</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7"
            aria-label={t('usage.refresh')}
            onClick={() => void refresh(true)}
          >
            <RefreshCw size={16} strokeWidth={1.5} className={cn(loading && 'animate-spin')} />
          </Button>
        </div>
        <div role="group" aria-label={t('usage.viewAria')} className="m-3 flex rounded-md bg-raised p-0.5">
          {(['detailed', 'compact'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => pick(v)}
              className={cn(
                'h-7 flex-1 rounded-sm text-xs capitalize',
                view === v ? 'bg-card text-foreground' : 'text-text-2 hover:text-foreground',
              )}
            >
              {v === 'detailed' ? t('usage.detailed') : t('usage.compact')}
            </button>
          ))}
        </div>
        <div className={cn('flex flex-col px-4 pb-3', view === 'compact' ? 'gap-2' : 'gap-4')}>
          {usage.length === 0 && <span className="text-xs text-text-2">{t('usage.noAgents')}</span>}
          {usage.map((u) => (
            <AgentBlock key={u.agentId} u={u} view={view} />
          ))}
        </div>
        <div className="flex flex-col border-t border-border p-1">
          {[
            { label: t('usage.details'), route: { name: 'agents' } as const },
            { label: t('usage.manage'), route: { name: 'settings' } as const },
          ].map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => go(r.route)}
              className="flex h-8 items-center justify-between rounded-md px-3 text-[13px] text-text-2 hover:bg-raised hover:text-foreground"
            >
              {r.label}
              <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
