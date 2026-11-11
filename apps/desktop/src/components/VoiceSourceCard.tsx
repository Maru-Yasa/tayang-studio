import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, RefreshCw } from 'lucide-react';
import type { Settings, VoiceCheck, VoiceErrorCode, VoiceKeySource, VoiceSource } from '@tayang/shared';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { updateSettings, voiceKeyClear, voiceKeySave, voiceStatus, voiceStudioCheck } from '@/lib/ipc';
import { cn } from '@/lib/utils';

const VOICESTUDIO_URL = 'https://voicestudio.sh';

/** The sources that speak with the user's own API key. */
const KEY_SOURCES: Record<VoiceKeySource, { name: string; keysUrl: string; voiceKey: 'elevenVoiceId' | 'fishVoiceId' }> = {
  elevenlabs: { name: 'ElevenLabs', keysUrl: 'https://elevenlabs.io/app/settings/api-keys', voiceKey: 'elevenVoiceId' },
  fishaudio: { name: 'Fish Audio', keysUrl: 'https://fish.audio/app/api-keys', voiceKey: 'fishVoiceId' },
};
const isKeySource = (s: VoiceSource): s is VoiceKeySource => s === 'elevenlabs' || s === 'fishaudio';

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

const linkClass = 'text-xs text-primary hover:text-accent-hover';

/** ElevenLabs or Fish Audio: the API key, an optional voice id, and what trying the key said. */
function KeyPanel({ source, settings, active, hasKey, onHasKey, onSaved }: {
  source: VoiceKeySource;
  settings: Settings;
  active: boolean;
  hasKey: boolean;
  onHasKey(has: boolean): void;
  onSaved(s: Settings): void;
}) {
  const { t } = useTranslation();
  const { name, keysUrl, voiceKey } = KEY_SOURCES[source];
  const [key, setKey] = useState('');
  const [voiceId, setVoiceId] = useState(settings[voiceKey] ?? '');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<VoiceCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(t('settings.saveError', { message: e instanceof Error ? e.message : String(e) }));

  const save = async () => {
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      const [result, saved] = await voiceKeySave(source, key.trim() || null, voiceId.trim() || null);
      setCheck(result);
      if (result.ok) {
        onHasKey(true);
        setKey('');
        onSaved(saved);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await voiceKeyClear(source));
      onHasKey(false);
      setCheck(null);
      setVoiceId('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // No credit: Fish Audio still speaks (its free model), ElevenLabs doesn't.
  const connected = check?.ok
    ? check.hasCredit === false
      ? source === 'fishaudio' ? t('voice.fishFree') : null
      : t('voice.connected', { name })
    : null;

  return (
    <>
      <span className="text-[13px] text-text-2">{t('voice.keyText', { name })}</span>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${source}-key`} className="text-[13px] text-[#D9D9D9]">
          {t('voice.keyLabel', { name })}{' '}
          <a href={keysUrl} target="_blank" rel="noreferrer" className={cn('ml-1', linkClass)}>
            {t('voice.getKey')}
          </a>
        </label>
        <Input
          id={`${source}-key`}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={hasKey ? t('voice.keySaved') : undefined}
          autoComplete="off"
          className="h-9 bg-background font-mono text-[13px]"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${source}-voice`} className="text-[13px] text-[#D9D9D9]">{t('voice.voiceId')}</label>
        <Input
          id={`${source}-voice`}
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="h-9 bg-background font-mono text-[13px]"
        />
        <span className="text-xs text-text-3">{t('voice.voiceIdHint', { name })}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="light" className="h-9 px-3 text-[13px] font-semibold" disabled={busy || (!key.trim() && !hasKey)} onClick={() => void save()}>
          {busy ? t('voice.checking') : t('voice.keySave')}
        </Button>
        {hasKey && (
          <Button variant="ghost" className="h-9 px-2 text-[13px]" disabled={busy} onClick={() => void remove()}>
            {t('voice.keyRemove')}
          </Button>
        )}
      </div>
      {connected && <Status ok>{connected}</Status>}
      {check?.ok && !connected && <Status ok={false}>{t('voice.errors.noBalance', { name })}</Status>}
      {check && !check.ok && <Status ok={false}>{t(`voice.errors.${ERROR_KEY[check.error ?? 'failed']}`, { name })}</Status>}
      {!check && active && <Status ok>{t('voice.active', { name })}</Status>}
      {!check && !active && !hasKey && <span className="text-xs text-text-3">{t('voice.notYet')}</span>}
      {error && <p role="alert" className="m-0 text-[13px] text-orange-light">{error}</p>}
    </>
  );
}

/**
 * Settings › Video: where voice-overs come from. Tayang credits, the user's own ElevenLabs or Fish
 * Audio key, or VoiceStudio on this computer. Agents always call Tayang's /voice; this picks who speaks.
 */
export function VoiceSourceCard({ settings, onSaved }: { settings: Settings; onSaved(s: Settings): void }) {
  const { t } = useTranslation();
  const active: VoiceSource = settings.voiceSource ?? 'tayang';
  /** The source whose panel is open: a source with a key can be open before a key makes it the active one. */
  const [shown, setShown] = useState<VoiceSource>(active);
  const [hasKey, setHasKey] = useState<Record<VoiceKeySource, boolean>>({ elevenlabs: false, fishaudio: false });
  const [studio, setStudio] = useState<VoiceCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    voiceStatus().then((s) => setHasKey({ elevenlabs: s.hasElevenKey, fishaudio: s.hasFishKey }), () => {});
  }, []);

  const checkStudio = () => {
    setStudio(null);
    voiceStudioCheck().then(setStudio, () => setStudio({ ok: false, error: 'failed', hasCredit: null }));
  };
  useEffect(() => {
    if (shown === 'voicestudio') checkStudio();
  }, [shown]);

  const pick = async (source: VoiceSource) => {
    setShown(source);
    setError(null);
    // A source with a key only becomes the source once its key is saved.
    if (source === active || (isKeySource(source) && !hasKey[source])) return;
    try {
      onSaved(await updateSettings({ voiceSource: source }));
    } catch (e) {
      setError(t('settings.saveError', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const label = t('voice.source');

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="mr-auto flex min-w-0 flex-col gap-1">
          <span className="text-sm">{label}</span>
          <span className="text-xs text-text-3">{t('voice.sourceHint')}</span>
        </div>
        <Tabs value={shown} onValueChange={(v) => void pick(v as VoiceSource)}>
          <TabsList aria-label={label} className="h-9 bg-background">
            <TabsTrigger value="tayang" className="px-3 text-[13px]">Tayang</TabsTrigger>
            <TabsTrigger value="elevenlabs" className="px-3 text-[13px]">ElevenLabs</TabsTrigger>
            <TabsTrigger value="fishaudio" className="px-3 text-[13px]">Fish Audio</TabsTrigger>
            <TabsTrigger value="voicestudio" className="px-3 text-[13px]">VoiceStudio</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex flex-col gap-3 border-t border-[#222] px-4 py-3">
        {shown === 'tayang' && <span className="text-[13px] text-text-2">{t('voice.tayangText')}</span>}

        {isKeySource(shown) && (
          <KeyPanel
            key={shown}
            source={shown}
            settings={settings}
            active={active === shown}
            hasKey={hasKey[shown]}
            onHasKey={(has) => setHasKey((k) => ({ ...k, [shown]: has }))}
            onSaved={onSaved}
          />
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
