import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { disable as disableAutostart, enable as enableAutostart } from '@tauri-apps/plugin-autostart';
import { DEFAULT_SETTINGS, type AgentInfo, type Settings as SettingsT, type SystemInfo, type ToolId } from '@tayang/shared';
import { AccountSection } from '@/components/Account';
import { ArchiveSection } from '@/components/ArchiveSection';
import { GiftCode } from '@/components/GiftCode';
import { UsageTab } from '@/components/UsageTab';
import { ClaudeAccountControl } from '@/components/ClaudeAccountControl';
import { AgentLogo } from '@/components/AgentLogo';
import { ApiSetupDialog } from '@/components/ApiSetupDialog';
import { Button } from '@/components/Button';
import { ToolRow, TOOL_ORDER } from '@/components/ToolRow';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AGENT_INSTALL_URL, AGENT_NAMES } from '@/lib/agents';
import { apiClear, apiUrlOverride, detectAgents, getSettings, getSystemInfo, pickFolder, updateSettings } from '@/lib/ipc';

/** What Rust says when background mode can't make its tray (and turned it back off). */
const TRAY_UNAVAILABLE = 'tray-unavailable';
import { LANGUAGES, LANGUAGE_NAMES, uiLanguage } from '@/i18n';
import { chooseLanguage } from '@/lib/language';
import { sendTestNotification } from '@/lib/scheduler';
import { useApp } from '@/state/app';
import { cn } from '@/lib/utils';
import { useInstall } from '@/state/install';
import { useUpdater } from '@/state/updater';

const SECTIONS = ['general', 'agents', 'video', 'render', 'tools', 'usage', 'account', 'archive'] as const;
export type SettingsTab = (typeof SECTIONS)[number];

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-border bg-card">{children}</div>;
}

/** The app's version and a manual update check; what to do with a found update is in the sidebar. */
function UpdatesRow({ dev = import.meta.env.DEV }: { dev?: boolean }) {
  const { t } = useTranslation();
  const { phase, version, error, check } = useUpdater();
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    getVersion()
      .then((v) => !gone && setCurrent(v))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  const status = dev
    ? t('updates.devBuild')
    : phase === 'checking'
      ? t('updates.checking')
      : phase === 'none'
        ? t('updates.upToDate')
        : phase === 'available' || phase === 'downloading' || phase === 'ready'
          ? t('updates.available', { version: version ?? '' })
          : phase === 'error' && error
            ? t('updates.failed', { message: error })
            : undefined;
  return (
    <Row label={t('updates.label')} hint={current ? t('updates.version', { version: current }) : undefined} note={status}>
      <Button variant="secondary" disabled={dev || phase === 'checking'} onClick={() => void check()}>
        {t('updates.check')}
      </Button>
    </Row>
  );
}

/** Settings › Account points to Social media, where the accounts and auto-posts live. */
function SocialLink() {
  const { t } = useTranslation();
  const navigate = useApp((s) => s.navigate);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="mr-auto flex flex-col gap-1">
        <span className="text-sm font-medium">{t('social.settingsTitle')}</span>
        <span className="text-xs text-text-3">{t('social.settingsHint')}</span>
      </div>
      <Button variant="secondary" onClick={() => navigate({ name: 'social' })}>
        {t('social.open')}
      </Button>
    </div>
  );
}

function Row({ label, hint, note, children }: { label: string; hint?: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-[#222] px-4 py-3 last:border-b-0">
      <div className="mr-auto flex min-w-0 flex-col gap-1">
        <span className="text-sm">{label}</span>
        {hint && <span className="text-xs text-text-3">{hint}</span>}
        {note && <span className="text-xs text-text-3">{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange(v: T): void;
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as T)}>
      <TabsList aria-label={label} className="h-9 bg-background">
        {options.map((o) => (
          <TabsTrigger key={o.value} value={o.value} disabled={o.disabled} className="px-3 text-[13px]">
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}


const TAB_KEY = 'tayang.settingsTab';
const isTab = (v: unknown): v is SettingsTab => typeof v === 'string' && (SECTIONS as readonly string[]).includes(v);

/** The tab Settings opens on: the one asked for, else the one last used, else General. */
function startTab(asked: string | undefined): SettingsTab {
  if (isTab(asked)) return asked;
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (isTab(saved)) return saved;
  } catch {
    /* storage off: General */
  }
  return 'general';
}

export function Settings() {
  const { t } = useTranslation();
  // TAYANG_API_URL (a dev setup) wins over the address saved here: say so instead of showing a value that isn't used.
  const [apiOverride, setApiOverride] = useState<string | null>(null);
  useEffect(() => {
    Promise.resolve()
      .then(() => apiUrlOverride())
      .then((v) => setApiOverride(v ?? null))
      .catch(() => setApiOverride(null));
  }, []);
  const settings = useApp((s) => s.settings);
  const askedTab = useApp((s) => (s.route.name === 'settings' ? s.route.tab : undefined));
  const [tab, setTab] = useState<SettingsTab>(() => startTab(askedTab));
  useEffect(() => {
    if (isTab(askedTab)) setTab(askedTab);
  }, [askedTab]);
  const pickTab = (id: SettingsTab) => {
    setTab(id);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      /* the choice just won't be remembered */
    }
  };
  const setSettings = useApp((s) => s.setSettings);
  const navigate = useApp((s) => s.navigate);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [apiOpen, setApiOpen] = useState(false);
  const reloadAgents = () => void detectAgents().then(setAgents, () => {});
  const removeApi = async () => {
    setError(null);
    try {
      setSettings(await apiClear());
      reloadAgents();
    } catch (e) {
      setError(t('settings.saveError', { message: e instanceof Error ? e.message : String(e) }));
    }
  };
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statuses = useInstall((s) => s.statuses);
  const active = useInstall((s) => s.active);
  const closing = useInstall((s) => s.closing);
  const refresh = useInstall((s) => s.refresh);
  const start = useInstall((s) => s.start);
  const askKey = useInstall((s) => s.askKey);
  const agentId = settings?.defaultAgent ?? 'claude';
  const agentName = AGENT_NAMES[agentId];

  const check = useCallback(() => {
    refresh(agentId).catch(() => {});
  }, [refresh, agentId]);

  useEffect(() => {
    useInstall.getState().listen();
    detectAgents()
      .then(setAgents)
      .catch(() => {});
    getSystemInfo()
      .then(setSys)
      .catch(() => {});
  }, []);
  useEffect(check, [check]);

  const [apiError, setApiError] = useState<string | null>(null);
  const save = async (patch: Partial<SettingsT>) => {
    setError(null);
    try {
      setSettings(await updateSettings(patch));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === TRAY_UNAVAILABLE) {
        // Rust turned background mode back off: show the saved settings and say why.
        setError(t('settings.trayUnavailable'));
        void getSettings().then(setSettings, () => {});
        return;
      }
      setError(t('settings.saveError', { message }));
    }
  };

  // Background mode keeps the app alive in the tray; "Open at login" only makes sense with it, so turning
  // the background off also turns the login item off. A failed OS change leaves the setting as it was.
  const changeBackground = async (on: boolean) => {
    if (!on && settings?.openAtLogin) {
      try {
        await disableAutostart();
      } catch (e) {
        setError(t('settings.backgroundError', { message: e instanceof Error ? e.message : String(e) }));
        return;
      }
      await save({ backgroundMode: false, openAtLogin: false });
      return;
    }
    await save({ backgroundMode: on });
  };
  const changeOpenAtLogin = async (on: boolean) => {
    try {
      await (on ? enableAutostart() : disableAutostart());
    } catch (e) {
      setError(t('settings.backgroundError', { message: e instanceof Error ? e.message : String(e) }));
      return;
    }
    await save({ openAtLogin: on });
  };

  const [testLine, setTestLine] = useState<string | null>(null);
  const testNotification = async () => {
    setTestLine(null);
    try {
      setTestLine((await sendTestNotification()) ? t('settings.testSent') : t('reminders.blocked'));
    } catch (e) {
      setTestLine(t('settings.testFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const changeFolder = async () => {
    try {
      const path = await pickFolder();
      if (path) await save({ workingFolder: path });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!settings) return null;

  const install = (tool: ToolId, key?: string) => {
    if (sys) void start(tool, { sys, agent: agentId, elevenLabsKey: key });
  };
  const tools = [...statuses].sort((a, b) => TOOL_ORDER.indexOf(a.id) - TOOL_ORDER.indexOf(b.id));

  return (
    <div className="flex h-full flex-wrap content-start gap-8 overflow-y-auto p-8">
      <h1 data-tauri-drag-region className="m-0 flex-[1_1_100%] text-[28px] font-semibold tracking-[-0.01em]">
        {t('settings.title')}
      </h1>

      <div role="tablist" aria-orientation="vertical" aria-label={t('settings.sectionsAria')} className="flex flex-[0_0_180px] flex-col gap-1">
        {SECTIONS.map((id) => (
          <button
            key={id}
            id={`settings-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={id}
            onClick={() => pickTab(id)}
            className={cn(
              'flex h-9 cursor-pointer items-center rounded-md px-3 text-left text-sm font-medium hover:bg-raised hover:text-foreground',
              tab === id ? 'bg-raised text-foreground' : 'text-text-2',
            )}
          >
            {t(`settings.sections.${id}`)}
          </button>
        ))}
      </div>

      <div className="flex max-w-[720px] min-w-0 flex-[999_1_460px] flex-col gap-8">
        {error && (
          <p role="alert" className="m-0 text-[13px] text-orange-light">
            {error}
          </p>
        )}

        {tab === 'general' && (
          <section id="general" role="tabpanel" aria-labelledby="settings-tab-general" className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-medium">{t('settings.sections.general')}</h2>
            <Card>
              <Row label={t('settings.language')} hint={t('settings.languageHint')}>
                <Segmented
                  label={t('settings.language')}
                  value={uiLanguage()}
                  options={LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_NAMES[l] }))}
                  onChange={(l) => void chooseLanguage(l)}
                />
              </Row>
              <UpdatesRow />
            </Card>
          </section>
        )}

        {tab === 'agents' && (
          <section id="agents" role="tabpanel" aria-labelledby="settings-tab-agents" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="m-0 text-base font-medium">{t('settings.sections.agents')}</h2>
              <span className="text-[13px] text-text-2">{t('settings.agentsIntro')}</span>
            </div>
            <span id="default-agent-label" className="text-[13px] font-medium">
              {t('settings.defaultAgent')}
            </span>
            <Card>
              <RadioGroup
                aria-labelledby="default-agent-label"
                value={settings.defaultAgent}
                onValueChange={(v) => void save({ defaultAgent: v as SettingsT['defaultAgent'] })}
                className="gap-0"
              >
                {agents.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                    <RadioGroupItem value={a.id} id={`agent-${a.id}`} disabled={!a.installed} aria-label={t('settings.useByDefault', { name: AGENT_NAMES[a.id] })} />
                    <AgentLogo id={a.id} size={20} />
                    <div className="mr-auto flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-medium">{AGENT_NAMES[a.id]}</span>
                      <span className="text-xs text-text-3">
                        {a.id === 'custom'
                          ? a.installed && a.version
                            ? t('onboarding.connect.yourApiReady', { model: a.version })
                            : t('onboarding.connect.yourApiHint')
                          : a.installed
                            ? a.version
                              ? t('settings.connectedVersion', { version: a.version })
                              : t('settings.connected')
                            : t('settings.notInstalled')}
                      </span>
                    </div>
                    {a.id === 'custom' ? (
                      <div className="flex items-center gap-1">
                        {a.installed && (
                          <Button variant="ghost" className="h-8 px-2 text-[13px] text-text-2" onClick={() => void removeApi()}>
                            {t('settings.apiRemove')}
                          </Button>
                        )}
                        <Button variant="ghost" className="h-8 px-2 text-[13px] text-primary hover:text-accent-hover" onClick={() => setApiOpen(true)}>
                          {a.installed ? t('settings.apiChange') : t('onboarding.connect.setUp')}
                        </Button>
                      </div>
                    ) : a.id === 'claude' && a.installed ? (
                      <ClaudeAccountControl showSignOut />
                    ) : a.installed ? (
                      <Button variant="ghost" className="h-8 px-2 text-[13px] text-primary hover:text-accent-hover" onClick={() => navigate({ name: 'connect' })}>
                        {t('settings.reconnect')}
                      </Button>
                    ) : (
                      // The agent's own install guide, in the browser: the onboarding screens have none.
                      <a
                        href={AGENT_INSTALL_URL[a.id]}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 items-center px-2 text-[13px] font-medium text-primary hover:text-accent-hover"
                      >
                        {t('settings.howToInstall')}
                      </a>
                    )}
                  </div>
                ))}
              </RadioGroup>
            </Card>
            <ApiSetupDialog
              open={apiOpen}
              onOpenChange={setApiOpen}
              onSaved={(next) => {
                setSettings(next);
                reloadAgents();
              }}
            />
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <div className="mr-auto flex flex-col gap-1">
                <label htmlFor="frame-check" className="text-sm font-medium">
                  {t('settings.frameCheck')}
                </label>
                <span className="text-xs text-text-3">{t('settings.frameCheckHint')}</span>
              </div>
              <Switch
                id="frame-check"
                checked={settings.frameCheck}
                aria-label={t('settings.frameCheck')}
                onCheckedChange={(v) => void save({ frameCheck: v })}
              />
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <div className="mr-auto flex flex-col gap-1">
                <label htmlFor="auto-mode" className="text-sm font-medium">
                  {t('settings.autoMode')}
                </label>
                <span className="text-xs text-text-3">{t('settings.autoModeHint')}</span>
                <span className="text-xs text-text-3">{t('settings.autoModeAutopilots')}</span>
              </div>
              <Switch
                id="auto-mode"
                checked={settings.autoMode}
                aria-label={t('settings.autoMode')}
                onCheckedChange={(v) => void save({ autoMode: v })}
              />
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <div className="mr-auto flex flex-col gap-1">
                <label htmlFor="background-mode" className="text-sm font-medium">
                  {t('settings.background')}
                </label>
                <span className="text-xs text-text-3">{t('settings.backgroundHint')}</span>
              </div>
              <Switch
                id="background-mode"
                checked={settings.backgroundMode}
                aria-label={t('settings.background')}
                onCheckedChange={(v) => void changeBackground(v)}
              />
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <div className="mr-auto flex flex-col gap-1">
                <label htmlFor="open-at-login" className="text-sm font-medium">
                  {t('settings.openAtLogin')}
                </label>
                <span className="text-xs text-text-3">{t('settings.openAtLoginHint')}</span>
              </div>
              <Switch
                id="open-at-login"
                checked={settings.backgroundMode && settings.openAtLogin}
                disabled={!settings.backgroundMode}
                aria-label={t('settings.openAtLogin')}
                onCheckedChange={(v) => void changeOpenAtLogin(v)}
              />
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <div className="mr-auto flex flex-col gap-1">
                <span className="text-sm font-medium">{t('settings.testNotification')}</span>
                {testLine && (
                  <span role="status" className="text-xs text-text-3">
                    {testLine}
                  </span>
                )}
              </div>
              <Button variant="secondary" className="h-8 px-3 text-[13px]" onClick={() => void testNotification()}>
                {t('settings.testNotification')}
              </Button>
            </div>
          </section>
        )}

        {tab === 'video' && (
          <section id="video" role="tabpanel" aria-labelledby="settings-tab-video" className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-medium">{t('settings.sections.video')}</h2>
            <Card>
              <Row label={t('settings.videoLanguage')}>
                <Segmented
                  label={t('settings.videoLanguage')}
                  value={settings.language}
                  options={[
                    { value: 'id', label: LANGUAGE_NAMES.id },
                    { value: 'en', label: LANGUAGE_NAMES.en },
                  ]}
                  onChange={(language) => void save({ language })}
                />
              </Row>
              <Row label={t('settings.format')}>
                <Segmented
                  label={t('settings.format')}
                  value={settings.format}
                  options={[
                    { value: '9:16', label: '9:16' },
                    { value: '1:1', label: '1:1' },
                    { value: '16:9', label: '16:9' },
                  ]}
                  onChange={(format) => void save({ format })}
                />
              </Row>
              <Row label={t('settings.frameRate')}>
                <Segmented
                  label={t('settings.frameRate')}
                  value={String(settings.fps)}
                  options={['24', '30', '60'].map((v) => ({ value: v, label: t('settings.fps', { n: v }) }))}
                  onChange={(v) => void save({ fps: Number(v) })}
                />
              </Row>
              <Row label={t('settings.voiceover')}>
                <span className="text-xs text-text-3">{t('settings.withPlan')}</span>
                <span className="text-sm text-[#D9D9D9]">{t('settings.off')}</span>
              </Row>
            </Card>
          </section>
        )}

        {tab === 'render' && (
          <section id="render" role="tabpanel" aria-labelledby="settings-tab-render" className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-medium">{t('settings.sections.render')}</h2>
            <Card>
              <Row
                label={t('settings.workingFolder')}
                hint={t('settings.workingFolderHint')}
                note={t('settings.workingFolderNote')}
              >
                <span className="max-w-[220px] truncate font-mono text-xs text-[#D9D9D9]" title={settings.workingFolder}>
                  {settings.workingFolder}
                </span>
                <Button variant="secondary" className="h-7 rounded-sm px-2 text-xs" onClick={() => void changeFolder()}>
                  {t('settings.change')}
                </Button>
              </Row>
              <Row label={t('settings.whereToRender')} hint={t('settings.whereToRenderHint')}>
                <Segmented
                  label={t('settings.whereToRender')}
                  value="local"
                  options={[
                    { value: 'local', label: t('settings.thisComputer') },
                    { value: 'cloud', label: t('settings.cloud'), disabled: true },
                  ]}
                  onChange={() => {}}
                />
              </Row>
            </Card>
          </section>
        )}

        {tab === 'tools' && (
          <section id="tools" role="tabpanel" aria-labelledby="settings-tab-tools" className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="mr-auto flex flex-col gap-1">
                <h2 className="m-0 text-base font-medium">{t('settings.sections.tools')}</h2>
                <span className="text-[13px] text-text-2">{t('settings.toolsIntro', { agent: agentName })}</span>
              </div>
              <Button
                variant="secondary"
                className="h-7 gap-1 rounded-sm bg-transparent px-2 text-xs text-[#D9D9D9]"
                disabled={!!active || closing}
                onClick={check}
              >
                <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />
                {t('settings.checkAgain')}
              </Button>
            </div>
            <ul className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-border bg-card p-0">
              {tools.map((t) => (
                <ToolRow
                  key={t.id}
                  tool={t}
                  sys={sys}
                  agentName={agentName}
                  busy={!!active || closing || !sys}
                  onInstall={(key) => install(t.id, key)}
                  onAskKey={() => askKey(t.id)}
                />
              ))}
            </ul>
          </section>
        )}

        {tab === 'archive' && (
          <section id="archive" role="tabpanel" aria-labelledby="settings-tab-archive" className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-medium">{t('settings.sections.archive')}</h2>
            <ArchiveSection />
          </section>
        )}

        {tab === 'usage' && (
          <section id="usage" role="tabpanel" aria-labelledby="settings-tab-usage" className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-medium">{t('settings.sections.usage')}</h2>
            <UsageTab onAccount={() => pickTab('account')} />
          </section>
        )}

        {tab === 'account' && (
          <section id="account" role="tabpanel" aria-labelledby="settings-tab-account" className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-medium">{t('settings.sections.account')}</h2>
            <AccountSection />
            <GiftCode />
            <SocialLink />
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <div className="mr-auto flex flex-col gap-1">
                <label htmlFor="share-install-stats" className="text-sm font-medium">
                  {t('settings.shareStats')}
                </label>
                <span className="text-xs text-text-3">{t('settings.shareStatsHint')}</span>
              </div>
              <Switch
                id="share-install-stats"
                checked={settings.shareInstallStats}
                aria-label={t('settings.shareStats')}
                onCheckedChange={(v) => void save({ shareInstallStats: v })}
              />
            </div>
            {/* For developers only: closed unless the address was changed. */}
            <details open={settings.apiUrl !== DEFAULT_SETTINGS.apiUrl || !!apiOverride} className="group">
              <summary className="cursor-pointer px-1 py-1 text-[13px] text-text-2 hover:text-foreground">{t('settings.advanced')}</summary>
            <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <div className="mr-auto flex flex-col gap-1">
                <label htmlFor="api-url" className="text-sm font-medium">
                  {t('settings.apiAddress')}
                </label>
                <span className="text-xs text-text-3">{t('settings.apiHint')}</span>
                <span className="text-xs text-text-3">{t('settings.apiDefault', { url: DEFAULT_SETTINGS.apiUrl })}</span>
                {apiOverride && (
                  <span role="note" className="text-xs text-orange-light">
                    {t('settings.apiOverridden', { url: apiOverride })}
                  </span>
                )}
              </div>
              <Input
                id="api-url"
                key={apiOverride ?? settings.apiUrl}
                defaultValue={apiOverride ?? settings.apiUrl}
                disabled={!!apiOverride}
                placeholder={DEFAULT_SETTINGS.apiUrl}
                spellCheck={false}
                className="h-8 w-[260px] bg-background font-mono text-xs"
                aria-invalid={apiError ? true : undefined}
                onBlur={(e) => {
                  const v = e.target.value.trim() || DEFAULT_SETTINGS.apiUrl;
                  if (!isHttpUrl(v)) {
                    setApiError(t('settings.apiInvalid'));
                    return;
                  }
                  setApiError(null);
                  if (v !== settings.apiUrl) void save({ apiUrl: v });
                  else e.target.value = v;
                }}
              />
              {apiError && (
                <span role="alert" className="basis-full text-xs text-orange-light">
                  {apiError}
                </span>
              )}
            </div>
            </details>
          </section>
        )}
      </div>
    </div>
  );
}
