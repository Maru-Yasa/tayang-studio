import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, RefreshCw } from 'lucide-react';
import type { Settings, VoiceCheck, VoiceErrorCode, VoiceSource } from '@tayang/shared';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { updateSettings, voiceFishClear, voiceFishSave, voiceStatus, voiceStudioCheck } from '@/lib/ipc';
import { cn } from '@/lib/utils';

const FISH_KEYS_URL = 'https://fish.audio/app/api-keys';
const VOICESTUDIO_URL = 'https://voicestudio.sh';

type ErrorKey = 'noKey' | 'badKey' | 'noBalance' | 'badVoice' | 'notRunning' | 'busy' | 'failed';
const ERROR_KEY: Record<VoiceErrorCode, ErrorKey> = {
  'no-key': 'noKey',
  'bad-key': 'badKey',
  'no-balance': 'noBalance',
  'bad-voice': 'badVoice',
  'not-running': 'notRunning',
  'too-long': 'failed',
  busy: 'busy',
  failed: 'failed',
};

function Status({ ok, children }: { ok: boolean; children: string }) {
  return (
    <p role="status" className={cn('m-0 flex items-center gap-2 text-[13px]', ok ? 'text-[#D9D9D9]' : 'text-orange-light')}>
      {ok && <Check size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-foreground" />}
      {children}
    </p>
  );
}

/**
 * Settings › Video: where voice-overs come from. Tayang credits, the user's own Fish Audio key, or
 * VoiceStudio on this computer. Agents always call Tayang's /voice; this picks who speaks.
 */
export function VoiceSourceCard({ settings, onSaved }: { settings: Settings; onSaved(s: Settings): void }) {
  const { t } = useTranslation();
  const active: VoiceSource = settings.voiceSource ?? 'tayang';
  /** The source whose panel is open: Fish Audio can be open before a key makes it the active one. */
  const [shown, setShown] = useState<VoiceSource>(active);
  const [hasFishKey, setHasFishKey] = useState(false);
  const [key, setKey] = useState('');
  const [voiceId, setVoiceId] = useState(settings.fishVoiceId ?? '');
  const [busy, setBusy] = useState(false);
  const [fish, setFish] = useState<VoiceCheck | null>(null);
  const [studio, setStudio] = useState<VoiceCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    voiceStatus().then((s) => setHasFishKey(s.hasFishKey), () => {});
  }, []);

  const checkStudio = () => {
    setStudio(null);
    voiceStudioCheck().then(setStudio, () => setStudio({ ok: false, error: 'failed', hasCredit: null }));
  };
  useEffect(() => {
    if (shown === 'voicestudio') checkStudio();
  }, [shown]);

  const fail = (e: unknown) => setError(t('settings.saveError', { message: e instanceof Error ? e.message : String(e) }));

  const pick = async (source: VoiceSource) => {
    setShown(source);
    setError(null);
    // Fish Audio only becomes the source once a key is saved.
    if (source === active || (source === 'fishaudio' && !hasFishKey)) return;
    try {
      onSaved(await updateSettings({ voiceSource: source }));
    } catch (e) {
      fail(e);
    }
  };

  const saveFish = async () => {
    setBusy(true);
    setError(null);
    setFish(null);
    try {
      const [check, saved] = await voiceFishSave(key.trim() || null, voiceId.trim() || null);
      setFish(check);
      if (check.ok) {
        setHasFishKey(true);
        setKey('');
        onSaved(saved);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const removeFish = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await voiceFishClear());
      setHasFishKey(false);
      setFish(null);
      setVoiceId('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const label = t('voice.source');
  const linkClass = 'text-xs text-primary hover:text-accent-hover';

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="mr-auto flex min-w-0 flex-col gap-1">
          <span className="text-sm">{label}</span>
          <span className="text-xs text-text-3">{t('voice.sourceHint')}</span>
        </div>
        <Tabs value={shown} onValueChange={(v) => void pick(v as VoiceSource)}>
          <TabsList aria-label={label} className="h-9 bg-background">
            <TabsTrigger value="tayang" className="px-3 text-[13px]">Tayang</TabsTrigger>
            <TabsTrigger value="fishaudio" className="px-3 text-[13px]">Fish Audio</TabsTrigger>
            <TabsTrigger value="voicestudio" className="px-3 text-[13px]">VoiceStudio</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex flex-col gap-3 border-t border-[#222] px-4 py-3">
        {shown === 'tayang' && <span className="text-[13px] text-text-2">{t('voice.tayangText')}</span>}

        {shown === 'fishaudio' && (
          <>
            <span className="text-[13px] text-text-2">{t('voice.fishText')}</span>
            <div className="flex flex-col gap-2">
              <label htmlFor="fish-key" className="text-[13px] text-[#D9D9D9]">
                {t('voice.fishKey')}{' '}
                <a href={FISH_KEYS_URL} target="_blank" rel="noreferrer" className={cn('ml-1', linkClass)}>
                  {t('tools.getKey')}
                </a>
              </label>
              <Input
                id="fish-key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={hasFishKey ? t('voice.fishKeySaved') : undefined}
                autoComplete="off"
                className="h-9 bg-background font-mono text-[13px]"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="fish-voice" className="text-[13px] text-[#D9D9D9]">{t('voice.fishVoice')}</label>
              <Input
                id="fish-voice"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="h-9 bg-background font-mono text-[13px]"
              />
              <span className="text-xs text-text-3">{t('voice.fishVoiceHint')}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="light" className="h-9 px-3 text-[13px] font-semibold" disabled={busy || (!key.trim() && !hasFishKey)} onClick={() => void saveFish()}>
                {busy ? t('voice.checking') : t('voice.fishSave')}
              </Button>
              {hasFishKey && (
                <Button variant="ghost" className="h-9 px-2 text-[13px]" disabled={busy} onClick={() => void removeFish()}>
                  {t('voice.fishRemove')}
                </Button>
              )}
            </div>
            {fish?.ok && <Status ok>{fish.hasCredit === false ? t('voice.fishFree') : t('voice.fishConnected')}</Status>}
            {fish && !fish.ok && <Status ok={false}>{t(`voice.errors.${ERROR_KEY[fish.error ?? 'failed']}`)}</Status>}
            {!fish && active === 'fishaudio' && <Status ok>{t('voice.fishActive')}</Status>}
            {!fish && active !== 'fishaudio' && !hasFishKey && <span className="text-xs text-text-3">{t('voice.fishNotYet')}</span>}
          </>
        )}

        {shown === 'voicestudio' && (
          <>
            <span className="text-[13px] text-text-2">{t('voice.studioText')}</span>
            <div className="flex flex-wrap items-center gap-3">
              {studio === null && <span className="text-[13px] text-text-2">{t('voice.checking')}</span>}
              {studio?.ok && <Status ok>{t('voice.studioOpen')}</Status>}
              {studio && !studio.ok && <Status ok={false}>{t('voice.studioClosed')}</Status>}
              <Button variant="secondary" className="ml-auto h-7 gap-1 rounded-sm bg-transparent px-2 text-xs text-[#D9D9D9]" disabled={studio === null} onClick={checkStudio}>
                <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />
                {t('settings.checkAgain')}
              </Button>
            </div>
            <span className="text-xs text-text-3">
              {t('voice.studioNote')}{' '}
              <a href={VOICESTUDIO_URL} target="_blank" rel="noreferrer" className={linkClass}>
                {t('voice.studioGet')}
              </a>
            </span>
          </>
        )}

        {error && <p role="alert" className="m-0 text-[13px] text-orange-light">{error}</p>}
      </div>
    </div>
  );
}
