import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import type { AgentId, AgentInfo } from '@tayang/shared';
import defaultOyen from '@/assets/brand/oyen-expr-default.svg';
import { AgentLogo } from '@/components/AgentLogo';
import { ApiSetupDialog } from '@/components/ApiSetupDialog';
import { ClaudeAccountControl } from '@/components/ClaudeAccountControl';
import { Button } from '@/components/Button';
import { Oyen } from '@/components/Oyen';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { AGENT_INSTALL_URL } from '@/lib/agents';
import { detectAgents, updateSettings } from '@/lib/ipc';
import { useApp } from '@/state/app';
import { useClaudeAccount } from '@/state/claudeAccount';
import { track } from '@/lib/analytics';

const ROWS: { id: AgentId; name?: string }[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'opencode', name: 'opencode' },
  { id: 'gemini', name: 'Gemini CLI' },
  { id: 'codex', name: 'Codex' },
  { id: 'antigravity', name: 'Antigravity CLI' },
  { id: 'custom' },
];

export function Connect() {
  const { navigate, settings, setSettings } = useApp();
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [apiOpen, setApiOpen] = useState(false);
  const claudeSignedIn = useClaudeAccount((s) => !!s.account?.signedIn);

  useEffect(() => {
    let live = true;
    detectAgents()
      .then((a) => live && setAgents(a))
      .catch(() => live && setAgents([]));
    return () => {
      live = false;
    };
  }, []);

  const connect = async (id: AgentId) => {
    setError(null);
    try {
      setSettings(await updateSettings({ defaultAgent: id }));
    } catch {
      setError(t('onboarding.connect.saveError'));
    }
  };

  const info = (id: AgentId) => agents?.find((a) => a.id === id);
  // Claude also needs Tayang's own sign-in (its own config folder, see claude_account.rs).
  const ready = (id: AgentId) => !!info(id)?.installed && (id !== 'claude' || claudeSignedIn);
  const connectedId = ROWS.find((r) => ready(r.id) && settings?.defaultAgent === r.id)?.id;

  return (
    <div className="flex min-h-full flex-col items-center bg-background px-6 pt-10 pb-12 text-foreground">
      <div className="flex w-full max-w-[720px] flex-col gap-8">
        <OnboardingHeader step={2} bars />
        <div data-tauri-drag-region className="mt-4 flex flex-col gap-2">
          <h1 className="text-4xl font-semibold tracking-[-0.02em]">{t('onboarding.connect.title')}</h1>
          <p className="text-base leading-[1.6] text-text-2">
            {t('onboarding.connect.intro')}
          </p>
        </div>

        <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          {ROWS.map((r) => {
            const a = info(r.id);
            const name = r.name ?? t('agents.yourApi');
            const installed = !!a?.installed;
            const connected = ready(r.id) && settings?.defaultAgent === r.id;
            const needsSignIn = installed && r.id === 'claude' && !claudeSignedIn;
            const status = r.id === 'custom'
              ? installed && a?.version
                ? t('onboarding.connect.yourApiReady', { model: a.version })
                : t('onboarding.connect.yourApiHint')
              : installed
                ? t(connected ? 'onboarding.connect.foundReady' : 'onboarding.connect.found')
                : t('onboarding.connect.notInstalled');
            return (
              <li key={r.id} className="flex items-center gap-4 border-b border-border p-4 last:border-b-0">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-raised text-text-2">
                  <AgentLogo id={r.id} size={22} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-medium">{name}</span>
                    {a?.recommended && <span className="text-xs text-orange-light">{t('onboarding.connect.recommended')}</span>}
                  </div>
                  <span className="text-[13px] text-text-3">{status}</span>
                </div>
                {connected && (
                  <span className="inline-flex h-9 items-center gap-2 text-sm text-[#D9D9D9]">
                    <Oyen mood="happy" size={24} />
                    {t('onboarding.connect.connected')}
                  </span>
                )}
                {needsSignIn && <ClaudeAccountControl onSignedIn={() => void connect('claude')} />}
                {r.id === 'custom' && (
                  <Button variant="secondary" className="h-9" onClick={() => setApiOpen(true)}>
                    {installed ? t('settings.apiChange') : t('onboarding.connect.setUp')}
                  </Button>
                )}
                {r.id !== 'custom' && installed && !connected && !needsSignIn && (
                  <Button variant="secondary" className="h-9" onClick={() => connect(r.id)} aria-label={t('onboarding.connect.connectAria', { name })}>
                    {t('onboarding.connect.connect')}
                  </Button>
                )}
                {r.id !== 'custom' && !installed && (
                  <a
                    href={AGENT_INSTALL_URL[r.id]}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 items-center px-1 text-sm font-medium text-primary hover:text-accent-hover"
                  >
                    {t('onboarding.connect.howToInstall')}
                  </a>
                )}
              </li>
            );
          })}
        </ul>

        <ApiSetupDialog
          open={apiOpen}
          onOpenChange={setApiOpen}
          onSaved={(next) => {
            setSettings(next);
            detectAgents().then(setAgents).catch(() => {});
          }}
        />

        {error && <p role="alert" className="m-0 text-[13px] text-orange-light">{error}</p>}

        <div className="flex items-center gap-4 px-1">
          <img src={defaultOyen} alt="" aria-hidden="true" className="size-10 shrink-0" />
          <span className="text-sm leading-[1.6] text-text-2">
            {t('onboarding.connect.newToAgents')}{' '}
            <a href="https://docs.claude.com/en/docs/claude-code" target="_blank" rel="noreferrer" className="text-primary hover:text-accent-hover">
              {t('onboarding.connect.showMe')}
            </a>
          </span>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <Button variant="ghost" className="h-12 px-0 text-[15px]" onClick={() => navigate({ name: 'welcome' })}>
            {t('common.back')}
          </Button>
          <Button className="h-12 gap-2 px-5 text-[15px]" disabled={!connectedId} onClick={() => {
            if (connectedId) track('agent connected', { agent: connectedId, during: 'onboarding' });
            navigate({ name: 'requirements' });
          }}>
            {t('common.continue')}
            <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
