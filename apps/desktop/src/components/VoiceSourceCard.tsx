import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import type { Settings, VoiceCheck, VoiceErrorCode, VoiceKeySource, VoiceSource } from '@tayang/shared';
import elevenlabs from '@/assets/brand/elevenlabs.svg';
import fishaudio from '@/assets/brand/fishaudio.svg';
import tayang from '@/assets/brand/oyen-symbol-color.svg';
import voicestudio from '@/assets/brand/voicestudio.svg';
import { Button } from '@/components/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { updateSettings, voiceKeyClear, voiceKeySave, voiceStatus, voiceStudioCheck } from '@/lib/ipc';
import { cn } from '@/lib/utils';

const VOICESTUDIO_URL = 'https://voicestudio.sh';

/** The sources in the order they are offered, each with its brand mark. */
const SOURCES: { id: VoiceSource; name: string; logo: string }[] = [
  { id: 'tayang', name: 'Tayang', logo: tayang },
  { id: 'elevenlabs', name: 'ElevenLabs', logo: elevenlabs },
  { id: 'fishaudio', name: 'Fish Audio', logo: fishaudio },
  { id: 'voicestudio', name: 'VoiceStudio', logo: voicestudio },
];
const KEYS_URL: Record<VoiceKeySource, string> = {
  elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
  fishaudio: 'https://fish.audio/app/api-keys',
};
const isKeySource = (s: VoiceSource): s is VoiceKeySource => s === 'elevenlabs' || s === 'fishaudio';
const sourceOf = (id: VoiceSource) => SOURCES.find((s) => s.id === id) ?? SOURCES[0]!;

type ErrorKey = 'noKey' | 'badKey' | 'noBalance' | 'notRunning' | 'busy' | 'failed';
const ERROR_KEY: Record<VoiceErrorCode, ErrorKey> = {
  'no-key': 'noKey',
  'bad-key': 'badKey',
  'no-balance': 'noBalance',
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

/** ElevenLabs or Fish Audio: the API key, and what trying it said. */
function KeyPanel({ source, active, inUse, hasKey, onHasKey, onSaved }: {
  source: VoiceKeySource;
  active: boolean;
  /** The name of the source that speaks until this one's key is saved. */
  inUse: string;
  hasKey: boolean;
  onHasKey(has: boolean): void;
  onSaved(s: Settings): void;
}) {
  const { t } = useTranslation();
  const { name } = sourceOf(source);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<VoiceCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(t('settings.saveError', { message: e instanceof Error ? e.message : String(e) }));

  const save = async () => {
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      const [result, saved] = await voiceKeySave(source, key.trim() || null);
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
          <a href={KEYS_URL[source]} target="_blank" rel="noreferrer" className={cn('ml-1', linkClass)}>
            {t('voice.getKey')}
          </a>
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`${source}-key`}
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? t('voice.keySaved') : undefined}
            autoComplete="off"
            className="h-9 min-w-60 flex-1 bg-background font-mono text-[13px]"
          />
          <Button variant="light" className="h-9 px-3 text-[13px] font-semibold" disabled={busy || (!key.trim() && !hasKey)} onClick={() => void save()}>
            {busy ? t('voice.checking') : t('voice.keySave')}
          </Button>
          {hasKey && (
            <Button variant="ghost" className="h-9 px-2 text-[13px]" disabled={busy} onClick={() => void remove()}>
              {t('voice.keyRemove')}
            </Button>
          )}
        </div>
      </div>
      {connected && <Status ok>{connected}</Status>}
      {check?.ok && !connected && <Status ok={false}>{t('voice.errors.noBalance', { name })}</Status>}
      {check && !check.ok && <Status ok={false}>{t(`voice.errors.${ERROR_KEY[check.error ?? 'failed']}`, { name })}</Status>}
      {!check && !active && !hasKey && <span className="text-xs text-text-3">{t('voice.notYet', { name: inUse })}</span>}
      {error && <p role="alert" className="m-0 text-[13px] text-orange-light">{error}</p>}
    </>
  );
}

/**
 * Settings › Tools: where voice-overs come from. Tayang credits, the user's own ElevenLabs or Fish
 * Audio key, or VoiceStudio on this computer. Agents always call Tayang's /voice; this picks who speaks.
 */
export function VoiceSourceCard({ settings, onSaved }: { settings: Settings; onSaved(s: Settings): void }) {
  const { t } = useTranslation();
  const active: VoiceSource = settings.voiceSource ?? 'tayang';
  /** A source with a key that was picked to set up its key: its panel is open even while another source is in use. */
  const [setup, setSetup] = useState<VoiceKeySource | null>(null);
  const shown: VoiceSource = setup ?? active;
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
    setError(null);
    // A source with a key only becomes the one in use once its key is saved.
    if (isKeySource(source) && !hasKey[source]) {
      setSetup(source);
      return;
    }
    setSetup(null);
    if (source === active) return;
    try {
      onSaved(await updateSettings({ voiceSource: source }));
    } catch (e) {
      setError(t('settings.saveError', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const label = t('voice.source');
  // The button follows what was picked; a source still waiting for its key says so.
  const current = sourceOf(shown);
  const pending = shown !== active;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="mr-auto flex min-w-0 flex-col gap-1">
          <span className="text-sm">{label}</span>
          <span className="text-xs text-text-3">{t('voice.sourceHint')}</span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${label}: ${current.name}`}
              className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-hairline bg-background px-3 text-[13px] text-foreground hover:bg-raised"
            >
              <img src={current.logo} alt="" aria-hidden="true" className="size-4 shrink-0" />
              {current.name}
              {pending && <span className="text-[11px] text-orange-light">{t('voice.pending')}</span>}
              <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-text-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 border-hairline bg-card">
            {SOURCES.map((o) => (
              <DropdownMenuItem key={o.id} onSelect={() => void pick(o.id)} className="h-9 gap-2 text-[13px]">
                <img src={o.logo} alt="" aria-hidden="true" className="size-4 shrink-0" />
                <span className="font-medium">{o.name}</span>
                {o.id === active ? (
                  <Check data-testid="voice-check" size={14} strokeWidth={1.5} aria-hidden="true" className="ml-auto" />
                ) : (
                  isKeySource(o.id) && !hasKey[o.id] && <span className="ml-auto text-[11px] text-text-3">{t('voice.needsKey')}</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-3 border-t border-[#222] px-4 py-3">
        {shown === 'tayang' && <span className="text-[13px] text-text-2">{t('voice.tayangText')}</span>}

        {isKeySource(shown) && (
          <KeyPanel
            key={shown}
            source={shown}
            active={active === shown}
            inUse={sourceOf(active).name}
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
