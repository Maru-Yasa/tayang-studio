import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatTimecode } from '@tayang/shared';
import { cn } from '@/lib/utils';
import type { TimelineLayers, VoiceTrack } from '@/lib/ipc';

export interface Scene {
  name: string;
  startSec: number;
  endSec: number;
  /** Unbuilt scenes are drawn hatched. Defaults to built. */
  built?: boolean;
}

export interface ScrubberProps {
  durationSec: number;
  fps: number;
  frame: number;
  thumbnails: string[];
  onSeek(frame: number): void;
  scenes?: Scene[];
  /** Voice and subtitle rows under the strip, on the same time axis. */
  layers?: TimelineLayers | null;
}

const HATCH = 'repeating-linear-gradient(135deg, #1A1A1A 0 6px, #202020 6px 12px)';

/** The waveform as one closed shape, mirrored around the middle, in a `peaks.length` × 2 box. */
export function waveformPath(peaks: number[]): string {
  if (peaks.length === 0) return '';
  const y = (p: number) => Math.min(1, Math.max(0.04, p));
  const top = peaks.map((p, i) => `L${i + 0.5} ${(1 - y(p)).toFixed(3)}`).join('');
  const bottom = peaks.map((p, i) => `L${i + 0.5} ${(1 + y(p)).toFixed(3)}`).reverse().join('');
  return `M0 1${top}L${peaks.length} 1${bottom}Z`;
}

/** Where a span of time sits on the strip, in % of its width; null when it doesn't show. */
function spanPct(startSec: number, endSec: number, durationSec: number) {
  const left = (startSec / durationSec) * 100;
  const width = Math.min(100 - left, ((endSec - startSec) / durationSec) * 100);
  return left < 100 && width > 0 ? { left: `${left}%`, width: `${width}%` } : null;
}

function Waveform({ track, durationSec }: { track: VoiceTrack; durationSec: number }) {
  const at = spanPct(track.startSec, track.startSec + track.durationSec, durationSec);
  if (!at) return null;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${Math.max(1, track.peaks.length)} 2`}
      // i18n-ignore: SVG token, not copy
      preserveAspectRatio="none"
      className="absolute inset-y-0 h-full text-text-3"
      style={at}
    >
      <path d={waveformPath(track.peaks)} fill="currentColor" />
    </svg>
  );
}

export function Scrubber({ durationSec, fps, frame, thumbnails, onSeek, scenes, layers }: ScrubberProps) {
  const { t } = useTranslation();
  const total = Math.max(1, Math.round(durationSec * fps));
  const last = total - 1;
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  /** The frame under the pointer while it hovers the strip without pressing. */
  const [hover, setHover] = useState<number | null>(null);

  const clamp = (f: number) => Math.min(last, Math.max(0, f));
  const pctOf = (f: number) => (last > 0 ? (f / last) * 100 : 0);
  const sceneAt = (sec: number) => scenes?.find((s) => sec < s.endSec) ?? scenes?.at(-1);
  const scene = sceneAt(frame / fps);
  const time = formatTimecode(frame / fps, fps);

  // The bubble follows the hover, otherwise the playhead.
  const shown = hover ?? frame;
  const shownScene = sceneAt(shown / fps);
  const shownTime = formatTimecode(shown / fps, fps);
  const pct = pctOf(frame);
  const bubblePct = pctOf(shown);
  const voice = layers?.voice ?? [];
  const captions = layers?.captions ?? [];
  const captionAt = (sec: number) => captions.find((c) => sec >= c.startSec && sec < c.endSec);
  const nowCaption = captionAt(frame / fps);
  const shownCaption = captionAt(shown / fps);
  const voiceLabel = layers?.voiceSource === 'render' ? t('preview.voiceFromRender') : t('preview.voiceLayer');

  const frameFromX = (clientX: number): number | null => {
    const r = ref.current!.getBoundingClientRect();
    if (r.width <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return clamp(Math.round(ratio * last));
  };
  const seekFromX = (clientX: number) => {
    const f = frameFromX(clientX);
    if (f !== null) onSeek(f);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? fps : 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = frame + step;
    else if (e.key === 'ArrowLeft') next = frame - step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    onSeek(clamp(next));
  };

  return (
    <div className="relative pt-7">
      {/* Sits on the playhead (or the hover) and slides along it, so it never leaves the strip. */}
      <div
        data-testid="scrubber-bubble"
        className="pointer-events-none absolute top-0 whitespace-nowrap rounded-md border border-hairline bg-raised px-1.5 py-0.5 font-mono text-[11px] leading-4 tabular-nums text-foreground"
        style={{ left: `${bubblePct}%`, transform: `translateX(-${bubblePct}%)` }}
      >
        {shownScene ? `${shownTime} · ${shownScene.name}` : shownTime}
        {shownCaption && <span className="inline-block max-w-40 truncate align-bottom text-text-3"> · {shownCaption.text}</span>}
      </div>
      {/* The strip and its layers share one time axis: press or drag anywhere on them to scrub. */}
      <div
        data-testid="scrubber-tracks"
        onPointerDown={(e) => {
          dragging.current = true;
          setHover(null);
          e.currentTarget.setPointerCapture?.(e.pointerId);
          seekFromX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) seekFromX(e.clientX);
          else if (e.pointerType !== 'touch') setHover(frameFromX(e.clientX));
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        className="relative flex cursor-pointer touch-none flex-col gap-1"
      >
        <div
          ref={ref}
          role="slider"
          tabIndex={0}
          aria-label={t('preview.framesAria')}
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={frame}
          aria-valuetext={time}
          onKeyDown={onKeyDown}
          className="relative flex h-12 shrink-0 gap-0.5 overflow-hidden rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {thumbnails.map((src, i) => {
            const sec = ((i + 0.5) / thumbnails.length) * durationSec;
            const built = sceneAt(sec)?.built !== false;
            return (
              <div
                key={src + i}
                className="min-w-0 flex-1 bg-cover bg-center"
                style={built ? { backgroundImage: `url("${src}")` } : { backgroundImage: HATCH }}
              />
            );
          })}
        </div>
        {voice.length > 0 && (
          <div
            data-testid="layer-voice"
            role="img"
            aria-label={voiceLabel}
            title={voiceLabel}
            className="relative h-6 shrink-0 overflow-hidden rounded-md bg-raised"
          >
            {voice.map((v, i) => (
              <Waveform key={`${v.startSec}-${i}`} track={v} durationSec={durationSec} />
            ))}
          </div>
        )}
        {captions.length > 0 && (
          <div
            data-testid="layer-captions"
            role="group"
            aria-label={t('preview.captionsLayer')}
            className="relative h-5 shrink-0 overflow-hidden rounded-md bg-raised"
          >
            {captions.map((c, i) => {
              const at = spanPct(c.startSec, c.endSec, durationSec);
              if (!at) return null;
              return (
                <button
                  key={`${c.startSec}-${i}`}
                  type="button"
                  title={`${formatTimecode(c.startSec, fps)} · ${c.text}`}
                  aria-label={`${t('preview.captionJump')}: ${c.text}`}
                  aria-current={c === nowCaption || undefined}
                  // A subtitle jumps to its start instead of scrubbing to the pointer.
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onSeek(clamp(Math.round(c.startSec * fps)))}
                  className={cn(
                    'absolute inset-y-0.5 cursor-pointer overflow-hidden rounded-sm border-l px-0.5 text-left text-[10px] leading-4 whitespace-nowrap',
                    c === nowCaption ? 'border-foreground bg-foreground/15 text-foreground' : 'border-hairline text-text-3 hover:text-text-2',
                  )}
                  style={at}
                >
                  {c.text}
                </button>
              );
            })}
          </div>
        )}
        {hover !== null && (
          <div
            aria-hidden="true"
            data-testid="scrubber-hover"
            className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-foreground/40"
            style={{ left: `${bubblePct}%` }}
          />
        )}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground"
          style={{ left: `${pct}%` }}
        >
          <div className="absolute -left-1.5 -top-1 flex h-4 w-3.5 items-center justify-center gap-0.5 rounded-sm bg-foreground">
            <span className="h-2 w-px bg-text-3" />
            <span className="h-2 w-px bg-text-3" />
          </div>
        </div>
      </div>
      {scenes && scenes.length > 0 && (
        <div className="mt-2 flex gap-0.5">
          {scenes.map((s) => (
            <span
              key={s.name + s.startSec}
              className={cn('min-w-0 truncate text-[11px]', s === scene ? 'text-foreground' : 'text-text-3')}
              style={{ flex: `${s.endSec - s.startSec} 1 0` }}
            >
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
