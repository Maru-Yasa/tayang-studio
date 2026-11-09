import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, Check, ChevronRight, ChevronsUpDown, Globe, KeyRound } from 'lucide-react';
import commandcodeLogo from '@/assets/brand/commandcode.svg';
import deepseekLogo from '@/assets/brand/deepseek.svg';
import ninerouterLogo from '@/assets/brand/9router.svg';
import type { ApiCheck, ApiProviderId, Settings } from '@tayang/shared';
import { Button } from '@/components/Button';
import { Oyen } from '@/components/Oyen';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  ENGINE_PROGRESS_EVENT,
  apiCheck,
  apiReachable,
  apiSave,
  apiStatus,
  apiTry,
  engineInstall,
  type EngineProgress,
} from '@/lib/ipc';
import { track } from '@/lib/analytics';
import { useModels } from '@/state/models';

/** The providers offered by name; `other` takes any OpenAI-compatible address. */
const API_PRESETS: { id: ApiProviderId; name?: string; logo?: string; baseUrl: string; keyUrl?: string; model?: string }[] = [
  { id: 'deepseek', name: 'DeepSeek', logo: deepseekLogo, baseUrl: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys', model: 'deepseek-chat' },
  { id: '9router', name: '9router', logo: ninerouterLogo, baseUrl: 'http://localhost:20128/v1', keyUrl: 'http://localhost:20128/dashboard' },
  { id: 'commandcode', name: 'CommandCode', logo: commandcodeLogo, baseUrl: 'https://api.commandcode.ai/provider/v1', keyUrl: 'https://commandcode.ai/provider' },
  { id: 'other', baseUrl: '' },
];

const OTHER = { id: 'other' as const, baseUrl: '' } satisfies (typeof API_PRESETS)[number];
const preset = (id: ApiProviderId): (typeof API_PRESETS)[number] => API_PRESETS.find((p) => p.id === id) ?? OTHER;
/** The provider's logo; Other gets a globe. */
function ProviderLogo({ id, size = 22 }: { id: ApiProviderId; size?: number }) {
  const logo = API_PRESETS.find((p) => p.id === id)?.logo;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md bg-raised text-text-2"
      style={{ width: size + 14, height: size + 14 }}
    >
      {logo ? <img src={logo} alt="" aria-hidden="true" width={size} height={size} style={{ width: size, height: size }} /> : <Globe size={size - 4} strokeWidth={1.5} aria-hidden="true" />}
    </span>
  );
}

/** Picks one of the provider's models from a searchable list; the recommended one comes first. */
function ModelCombobox({
  models,
  value,
  recommended,
  disabled,
  onChange,
}: {
  models: string[];
  value: string;
  recommended?: string;
  disabled?: boolean;
  onChange(model: string): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ordered = recommended && models.includes(recommended) ? [recommended, ...models.filter((m) => m !== recommended)] : models;
  const label = (m: string) => (m === recommended ? t('apiSetup.recommended', { model: m }) : m);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-labelledby="api-model-label"
          disabled={disabled}
          className="flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
        >
          <span className="truncate">{value ? label(value) : t('apiSetup.modelPick')}</span>
          <ChevronsUpDown size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-text-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder={t('apiSetup.modelSearch')} />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>{t('apiSetup.modelNone')}</CommandEmpty>
            {ordered.map((m) => (
              <CommandItem
                key={m}
                value={m}
                onSelect={() => {
                  onChange(m);
                  setOpen(false);
                }}
              >
                <span className="flex-1 truncate">{label(m)}</span>
                <Check size={14} strokeWidth={2} aria-hidden="true" className={cn(m === value ? 'opacity-100' : 'opacity-0')} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(0);

/**
 * Sets up Your API in three steps: pick the provider, paste the key (checked by listing its models) and
 * pick a model, then save. The first save downloads the engine. The user never sees opencode or a config.
 */
export function ApiSetupDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved(settings: Settings): void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'provider' | 'key'>('provider');
  const [provider, setProvider] = useState<ApiProviderId>('deepseek');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  /** A key is saved for the provider being edited, so the field may stay empty. */
  const [savedKey, setSavedKey] = useState(false);
  const [savedProvider, setSavedProvider] = useState<{ provider: ApiProviderId; baseUrl: string; model: string } | null>(null);
  const [routerRunning, setRouterRunning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ApiCheck | null>(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<EngineProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setStep('provider');
    setKey('');
    setCheck(null);
    setError(null);
    setProgress(null);
    apiStatus()
      .then((s) => {
        if (!live.current) return;
        setSavedKey(s.hasKey && !!s.provider);
        setSavedProvider(s.provider);
        if (s.provider) {
          setProvider(s.provider.provider);
          setBaseUrl(s.provider.baseUrl);
          setModel(s.provider.model);
        }
      })
      .catch(() => {});
    apiReachable(preset('9router').baseUrl)
      .then((up) => live.current && setRouterRunning(up))
      .catch(() => {});
  }, [open]);

  const sameAsSaved = savedProvider?.provider === provider && savedProvider.baseUrl === baseUrl.trim().replace(/\/+$/, '');
  const canUseSavedKey = savedKey && sameAsSaved && !key.trim();

  const pick = (id: ApiProviderId) => {
    setProvider(id);
    const p = preset(id);
    setBaseUrl(savedProvider?.provider === id ? savedProvider.baseUrl : p.baseUrl);
    setCheck(null);
    setError(null);
    setStep('key');
  };

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    setCheck(null);
    try {
      const result = await apiCheck(baseUrl, canUseSavedKey ? null : key);
      if (!live.current) return;
      setCheck(result);
      if (result.ok) {
        const want = [model, preset(provider).model].find((m) => m && result.models.includes(m));
        setModel(want ?? result.models[0] ?? '');
      }
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      if (live.current) setChecking(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const keyArg = canUseSavedKey ? null : key.trim();
    // Listing models doesn't always need a key: one real call proves the key, the balance and the model.
    try {
      const tried = await apiTry(baseUrl, keyArg, model);
      if (!tried.ok) {
        if (live.current) {
          setError([failureText(tried), tried.detail].filter(Boolean).join(' · '));
          setBusy(false);
        }
        return;
      }
    } catch (e) {
      if (live.current) {
        setError(String(e));
        setBusy(false);
      }
      return;
    }
    const off = await listen<EngineProgress>(ENGINE_PROGRESS_EVENT, (e) => live.current && setProgress(e.payload));
    try {
      try {
        await engineInstall();
      } catch (e) {
        if (live.current) setError(t('apiSetup.downloadFailed', { error: String(e) }));
        return;
      }
      try {
        const settings = await apiSave({ provider, baseUrl, model, models: check?.models ?? [model] }, keyArg);
        track('agent connected', { agent: 'custom', provider });
        // The chat's model menu keeps each agent's last list: read the new provider's models now.
        void useModels.getState().load('custom', true);
        onSaved(settings);
        onOpenChange(false);
      } catch (e) {
        if (live.current) setError(t('apiSetup.saveFailed', { error: String(e) }));
      }
    } finally {
      off();
      if (live.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  };

  const failureText = (c: ApiCheck) => {
    const f = c.failure ?? 'other';
    return f === 'unreachable' && provider === '9router' ? t('apiSetup.failures.unreachable9router') : t(`apiSetup.failures.${f}`);
  };

  const p = preset(provider);
  const providerName = (id: ApiProviderId) => preset(id).name ?? t('apiSetup.providers.other.name');
  const keyReady = canUseSavedKey || !!key.trim() || provider === '9router' || provider === 'other';

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('apiSetup.title')}</DialogTitle>
          <DialogDescription>{t('apiSetup.description')}</DialogDescription>
        </DialogHeader>

        {step === 'provider' ? (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">{t('apiSetup.providerStep')}</span>
            <ul className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-border p-0">
              {API_PRESETS.map((o) => (
                <li key={o.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => pick(o.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
                  >
                    <ProviderLogo id={o.id} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-medium">{providerName(o.id)}</span>
                        {savedProvider?.provider === o.id && (
                          <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-orange-light">
                            {t('apiSetup.lastUsed', { model: savedProvider.model })}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-text-3">
                        {o.id === '9router' && routerRunning ? t('apiSetup.providers.9routerRunning') : t(`apiSetup.providers.${o.id}.hint`)}
                      </span>
                    </span>
                    <ChevronRight size={16} className="text-text-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <span className="text-xs text-text-3">{t('apiSetup.engineNote')}</span>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (check?.ok) void save();
              else void runCheck();
            }}
          >
            <button
              type="button"
              disabled={busy}
              onClick={() => setStep('provider')}
              className="inline-flex w-fit items-center gap-1 text-[13px] text-text-2 hover:text-foreground"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              {t('apiSetup.back')} ·
              <ProviderLogo id={provider} size={14} />
              {providerName(provider)}
            </button>

            {(provider === 'other' || provider === '9router') && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">{t('apiSetup.address')}</span>
                <Input
                  value={baseUrl}
                  disabled={busy}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    setCheck(null);
                  }}
                  // i18n-ignore: a URL scheme, the same in every language
                  placeholder="https://"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="text-xs text-text-3">{t('apiSetup.addressHint')}</span>
              </label>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between text-[13px] font-medium">
                {t('apiSetup.key')}
                {p.keyUrl && (
                  <a href={p.keyUrl} target="_blank" rel="noreferrer" className="text-xs font-normal text-primary hover:text-accent-hover">
                    {t('apiSetup.getKey')}
                  </a>
                )}
              </span>
              <Input
                type="password"
                value={key}
                disabled={busy}
                onChange={(e) => {
                  setKey(e.target.value);
                  setCheck(null);
                }}
                // i18n-ignore: the shape of a key, the same in every language
                placeholder={canUseSavedKey ? '••••••••' : 'sk-…'}
                spellCheck={false}
                autoComplete="off"
              />
              {savedKey && sameAsSaved && <span className="text-xs text-text-3">{t('apiSetup.keySaved')}</span>}
            </label>

            {check?.ok && (
              <div className="flex flex-col gap-1.5">
                <span id="api-model-label" className="text-[13px] font-medium">
                  {t('apiSetup.model')}
                </span>
                <ModelCombobox models={check.models} value={model} recommended={p.model} disabled={busy} onChange={setModel} />
              </div>
            )}

            {check && (
              <div role="status" className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
                <Oyen mood={check.ok ? 'happy' : 'surprised'} size={28} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px]">{check.ok ? t('apiSetup.connected', { count: check.models.length }) : failureText(check)}</span>
                  {!check.ok && check.detail && <span className="break-words text-xs text-text-3">{check.detail}</span>}
                </div>
              </div>
            )}

            {progress && (
              <div role="status" className="flex items-center gap-3">
                <Oyen mood="sleepy" size={24} />
                <span className="text-[13px] text-text-2">
                  {progress.total
                    ? t('apiSetup.downloading', { done: mb(progress.done), total: mb(progress.total) })
                    : t('apiSetup.downloadingNoTotal', { done: mb(progress.done) })}
                </span>
              </div>
            )}

            {error && (
              <p role="alert" className="m-0 text-[13px] text-orange-light">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              {check?.ok ? (
                <Button type="submit" disabled={busy || !model} className="gap-2">
                  <KeyRound size={16} aria-hidden="true" />
                  {t('apiSetup.save')}
                </Button>
              ) : (
                <Button type="submit" disabled={checking || !keyReady || !baseUrl.trim()}>
                  {checking ? t('apiSetup.checking') : t('apiSetup.check')}
                </Button>
              )}
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
