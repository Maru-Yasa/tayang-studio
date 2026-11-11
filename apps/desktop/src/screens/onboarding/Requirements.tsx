import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { requiredMissing, type SystemInfo, type ToolId, type ToolStatus } from '@tayang/shared';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/Button';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { AGENT_NAMES } from '@/lib/agents';
import { locale } from '@/i18n';
import { toolName } from '@/lib/tools';
import { getSystemInfo } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useApp } from '@/state/app';
import { useInstall } from '@/state/install';
import { ToolRow, TOOL_ORDER } from '@/components/ToolRow';

const PM: Record<string, string> = { brew: 'Homebrew', winget: 'winget', apt: 'apt', dnf: 'dnf', pacman: 'pacman' };
const OS: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };

export function Requirements() {
  const { navigate, settings } = useApp();
  const { t } = useTranslation();
  const statuses = useInstall((s) => s.statuses);
  const active = useInstall((s) => s.active);
  const closing = useInstall((s) => s.closing);
  const refresh = useInstall((s) => s.refresh);
  const start = useInstall((s) => s.start);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const agentId = settings?.defaultAgent ?? 'claude';
  const agentName = AGENT_NAMES[agentId];

  const check = useCallback(async () => {
    setCheckError(null);
    try {
      await refresh(agentId);
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [refresh, agentId]);

  useEffect(() => {
    useInstall.getState().listen();
    getSystemInfo().then(setSys).catch(() => {});
    void check();
  }, [check]);

  const sorted = [...statuses].sort((a, b) => TOOL_ORDER.indexOf(a.id) - TOOL_ORDER.indexOf(b.id));
  const required = sorted.filter((t) => t.required);
  const recommended = sorted.filter((t) => !t.required);
  const missing = requiredMissing(statuses);
  const blocked = !loaded || missing.length > 0;

  const install = (tool: ToolId) => {
    if (!sys) return;
    void start(tool, { sys, agent: agentId });
  };

  // The tools are ready: last comes the optional Tayang sign-in, which finishes onboarding.
  const begin = () => navigate({ name: 'onboarding-account' });

  const group = (title: string, note: string, tools: ToolStatus[]) => (
    <section className="flex flex-col gap-3" key={title}>
      <span className="text-sm font-medium">
        {title} <span className="font-normal text-text-3">· {note}</span>
      </span>
      <ul className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-border bg-card p-0">
        {tools.map((t) => (
          <ToolRow
            key={t.id}
            tool={t}
            sys={sys}
            agentName={agentName}
            busy={!!active || closing || !sys}
            onInstall={() => install(t.id)}
          />
        ))}
      </ul>
    </section>
  );

  return (
    <div className="flex min-h-full flex-col items-center bg-background px-6 pt-10 pb-12 text-foreground">
      <div className="flex w-full max-w-[720px] flex-col gap-8">
        <OnboardingHeader step={3} bars />
        <div data-tauri-drag-region className="mt-4 flex flex-col gap-2">
          <h1 className="text-4xl font-semibold tracking-[-0.02em]">{t('onboarding.requirements.title')}</h1>
          <p className="text-base leading-[1.6] text-text-2">
            {t('onboarding.requirements.intro')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <span className="text-[13px] text-text-3">{t('onboarding.requirements.installsThrough')}</span>
          <span className="inline-flex h-7 items-center gap-2 rounded-sm bg-raised px-2 text-[13px] font-medium">
            <AgentLogo id={agentId} size={16} />
            {agentName}
          </span>
          {sys && (
            <span className="ml-auto text-[13px] text-text-3">
              {t('onboarding.requirements.detected')}{' '}
              <span className="text-[#D9D9D9]">
                {OS[sys.os]} {sys.osVersion}
                {sys.packageManager ? ` · ${PM[sys.packageManager]}` : ''}
              </span>
            </span>
          )}
          <Button
            variant="secondary"
            className="h-7 gap-1 rounded-sm bg-transparent px-2 text-xs text-[#D9D9D9]"
            disabled={!!active || closing}
            onClick={() => void check()}
          >
            <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />
            {t('onboarding.requirements.checkAgain')}
          </Button>
        </div>

        {checkError && <p role="alert" className="m-0 text-[13px] text-orange-light">{checkError}</p>}

        {group(t('onboarding.requirements.required'), missing.length ? t('onboarding.requirements.missingCount', { count: missing.length }) : t('onboarding.requirements.allReady'), required)}
        {group(t('onboarding.requirements.recommended'), t('onboarding.requirements.addLater'), recommended)}

        <div className="mt-2 flex items-center gap-4">
          <Button variant="ghost" className="mr-auto h-12 px-0 text-[15px]" onClick={() => navigate({ name: 'connect' })}>
            {t('common.back')}
          </Button>
          {blocked && missing.length > 0 && (
            <span className="text-[13px] text-text-3">{t('onboarding.requirements.installToContinue', { names: new Intl.ListFormat(locale(), { type: 'conjunction' }).format(missing.map(toolName)) })}</span>
          )}
          <Button
            variant={blocked ? 'secondary' : 'primary'}
            className={cn('h-12 gap-2 px-5 text-[15px]', blocked && 'border-border bg-transparent text-text-3')}
            disabled={blocked}
            onClick={() => void begin()}
          >
            {t('onboarding.requirements.start')}
            {!blocked && <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
