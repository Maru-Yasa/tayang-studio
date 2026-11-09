import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, ChevronRight, KeyRound } from 'lucide-react';
import type { ApiCheck, ApiProviderId, Settings } from '@tayang/shared';
import { Button } from '@/components/Button';
import { Oyen } from '@/components/Oyen';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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

/** The providers offered by name; `other` takes any OpenAI-compatible address. */
export const API_PRESETS: { id: ApiProviderId; name?: string; baseUrl: string; keyUrl?: string; model?: string }[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys', model: 'deepseek-chat' },
  { id: '9router', name: '9router', baseUrl: 'http://localhost:20128/v1', keyUrl: 'http://localhost:20128/dashboard' },
  { id: 'commandcode', name: 'CommandCode', baseUrl: 'https://api.commandcode.ai/provider/v1', keyUrl: 'https://commandcode.ai/provider' },
  { id: 'other', baseUrl: '' },
];

const OTHER = { id: 'other' as const, baseUrl: '' } satisfies (typeof API_PRESETS)[number];
const preset = (id: ApiProviderId): (typeof API_PRESETS)[number] => API_PRESETS.find((p) => p.id === id) ?? OTHER;
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
        const settings = await apiSave({ provider, baseUrl, model }, keyArg);
        track('agent connected', { agent: 'custom', provider });
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
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[14px] font-medium">{providerName(o.id)}</span>
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
              {t('apiSetup.back')} · {providerName(provider)}
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
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">{t('apiSetup.model')}</span>
                <select
                  value={model}
                  disabled={busy}
                  onChange={(e) => setModel(e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
                >
                  {check.models.map((m) => (
                    <option key={m} value={m}>
                      {m === p.model ? t('apiSetup.recommended', { model: m }) : m}
                    </option>
                  ))}
                </select>
              </label>
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
