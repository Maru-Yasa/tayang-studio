import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Pause, Play, SquarePlus } from 'lucide-react';
import { hasFramesChecked } from '@tayang/skills';
import { formatTimecode, frameAt, secAt } from '@tayang/shared';
import type { MediaInfo } from '@tayang/shared';
import { Button } from '@/components/Button';
import { Oyen } from '@/components/Oyen';
import { cn } from '@/lib/utils';
import {
  assetUrl,
  mediaExtractFrame,
  mediaLatestRender,
  mediaProbe,
  mediaRender,
  mediaThumbnails,
} from '@/lib/ipc';
import { NOTHING_TO_RENDER } from '@/lib/renderErrors';
import { useElapsed } from '@/components/Activity';
import { useChat } from '@/state/chat';
import { useRender } from '@/state/render';
import { advanceProject } from '@/lib/projectStatus';
import { Scrubber, type Scene } from './Scrubber';

const THUMBS = 12;
const NO_MESSAGES: never[] = [];

/** "● Rendering video… 1m 20s": the agent's or Tayang's render of this project is running. */
function RenderBanner({ since }: { since: number }) {
  const { t } = useTranslation();
  const time = useElapsed(since);
  return (
    <div role="status" className="flex w-full flex-col gap-0.5 rounded-md border border-border bg-card px-3 py-2 text-left">
      <span className="inline-flex items-center gap-2 text-[13px] text-foreground">
        <span aria-hidden="true" className="tayang-pulse inline-block size-1.5 shrink-0 rounded-full bg-primary" />
        {t('preview.renderingFor', { time: time ?? '' })}
      </span>
      <span className="pl-3.5 text-xs text-text-3">{t('preview.renderingHint')}</span>
    </div>
  );
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-b-2 border-hairline px-1 font-mono text-[10px] leading-none text-text-2">
    {children}
  </kbd>
);

/** The largest box of `aspect` (width / height) that fits a stage of this size; null before it has one. */
export function frameBox(stageWidth: number, stageHeight: number, aspect: number) {
  if (stageWidth <= 0 || stageHeight <= 0 || !(aspect > 0)) return null;
  const width = Math.min(stageWidth, stageHeight * aspect);
  return { width, height: width / aspect };
}

export function Preview({
  projectId,
  chatId,
  scenes,
  reloadKey = 0,
  onRender,
  rendering: renderingProp = false,
}: {
  projectId: string;
  chatId: string;
  scenes?: Scene[];
  /** Bump to reload the latest render, its probe and thumbnails. */
  reloadKey?: number;
  /** Renders through the screen (which also records the project's status). */
  onRender?(): void;
  rendering?: boolean;
}) {
  const { t } = useTranslation();
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // The stage's content size, measured: the frame box is sized from it in px on every platform.
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setStage((s) => (s && s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    });
    observer.current.observe(el);
  }, []);

  const messages = useChat((s) => s.messages[chatId]) ?? NO_MESSAGES;
  const lastAgent = [...messages].reverse().find((m) => m.role === 'agent');
  const checked = !!lastAgent?.parts.some((p) => p.type === 'text' && hasFramesChecked(p.text));

  const load = useCallback(async () => {
    const [path, probe] = await Promise.all([mediaLatestRender(projectId), mediaProbe(projectId)]);
    setVideoPath(path);
    setInfo(probe);
    setFrame(0);
    setPlaying(false);
    setThumbs(path && probe ? (await mediaThumbnails(projectId, THUMBS)).map(assetUrl) : []);
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    load().catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [load, reloadKey]);

  // A render of this project (the agent's or Tayang's) is running: say so, and show the new video once it ends.
  const run = useRender((s) => s.runs[projectId]);
  const wasRendering = useRef(!!run);
  useEffect(() => {
    if (wasRendering.current && !run) load().catch((e) => setError(String(e?.message ?? e)));
    wasRendering.current = !!run;
  }, [run, load]);

  const render = async () => {
    if (onRender) return onRender();
    setRendering(true);
    setError(null);
    useRender.getState().start(projectId, { source: 'tayang' });
    try {
      await mediaRender(projectId);
      void advanceProject(projectId, 'rendered');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message === NOTHING_TO_RENDER ? t('chat.nothingToRender') : message);
    } finally {
      setRendering(false);
      // Ending the run reloads the preview.
      useRender.getState().end(projectId);
    }
  };

  const busy = rendering || renderingProp || !!run;
  if (!videoPath || !info) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#101010] px-5 text-center">
        {run && <RenderBanner since={run.startedAt} />}
        <Oyen mood={busy ? 'sleepy' : 'default'} size={56} />
        <span className="text-[13px] text-text-2">{busy ? t('preview.rendering') : t('preview.nothing')}</span>
        {!busy && <Button variant="secondary" onClick={() => void render()}>{t('preview.renderPreview')}</Button>}
        {error && (
          <p role="alert" className="text-xs text-[#FFB08F]">
            {error}
          </p>
        )}
      </div>
    );
  }

  const { fps, durationSec } = info;
  const total = Math.max(1, Math.round(durationSec * fps));
  const clamp = (f: number) => Math.min(total - 1, Math.max(0, f));
  const seek = (f: number) => {
    const next = clamp(f);
    setFrame(next);
    if (videoRef.current) videoRef.current.currentTime = secAt(next, fps);
  };
  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play()?.catch(() => {});
    else v.pause();
  };

  const sendFrame = async () => {
    setSending(true);
    setError(null);
    try {
      const timeSec = secAt(frame, fps);
      const imagePath = await mediaExtractFrame(projectId, timeSec);
      useChat.getState().attach(chatId, { type: 'frame', projectId, frame, timeSec, imagePath, marks: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // ← → anywhere in the panel step a frame (Shift: a second); the strip handles its own keys first.
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]')) return;
    const step = e.shiftKey ? Math.round(fps) : 1;
    if (e.key === 'ArrowRight') seek(frame + step);
    else if (e.key === 'ArrowLeft') seek(frame - step);
    else return;
    e.preventDefault();
  };

  // The frame box takes the video's own shape, as large as the stage allows.
  const aspect = info.width > 0 && info.height > 0 ? info.width / info.height : 9 / 16;
  const box = stage ? frameBox(stage.width, stage.height, aspect) : null;
  const current = formatTimecode(secAt(frame, fps), fps);
  const length = formatTimecode(durationSec, fps);

  return (
    <div
      data-testid="preview-panel"
      onKeyDown={onPanelKeyDown}
      className="@container flex h-full flex-col overflow-y-auto bg-[#101010]"
    >
      {run && (
        <div className="shrink-0 px-4 pt-4">
          <RenderBanner since={run.startedAt} />
        </div>
      )}
      <div
        ref={stageRef}
        data-testid="preview-stage"
        className="flex min-h-40 flex-1 items-center justify-center px-4 pt-4"
      >
        <div
          data-testid="preview-frame"
          className={cn(
            'relative max-h-full max-w-full overflow-hidden rounded-xl border border-border bg-black',
            !box && 'h-full',
          )}
          // Measured: exactly the video's rect. Until then, CSS keeps the shape.
          style={box ? { width: box.width, height: box.height } : { aspectRatio: String(aspect) }}
        >
          <video
            ref={videoRef}
            src={assetUrl(videoPath)}
            className="h-full w-full object-contain"
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setFrame(clamp(frameAt(e.currentTarget.currentTime, fps)))}
          />
          {checked && (
            <span
              data-testid="frames-checked"
              className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-ink/75 py-0.5 pl-0.5 pr-2 text-[11px] leading-4 whitespace-nowrap text-text-2 backdrop-blur-sm"
            >
              <Oyen mood="happy" size={18} />
              {t('preview.framesChecked')}
            </span>
          )}
        </div>
      </div>

      <div data-testid="preview-controls" className="flex shrink-0 flex-col gap-3 px-4 pb-4 pt-3">
        <div data-testid="transport" className="flex flex-nowrap items-center gap-1 whitespace-nowrap">
          <Button
            variant="secondary"
            size="icon"
            aria-label={playing ? t('preview.pause') : t('preview.play')}
            onClick={toggle}
            className="size-8 shrink-0 px-0"
          >
            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('preview.previousFrame')}
            title={t('preview.previousFrameTip')}
            onClick={() => seek(frame - 1)}
            className="size-8 shrink-0 px-0"
          >
            <ChevronLeft size={16} strokeWidth={1.5} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('preview.nextFrame')}
            title={t('preview.nextFrameTip')}
            onClick={() => seek(frame + 1)}
            className="size-8 shrink-0 px-0"
          >
            <ChevronRight size={16} strokeWidth={1.5} />
          </Button>
          <span
            data-testid="timecode"
            title={`${current} / ${length} · ${t('preview.frame', { n: frame })}`}
            className="ml-1 min-w-0 truncate font-mono text-xs whitespace-nowrap tabular-nums text-foreground"
          >
            {current}
            <span className="text-text-3"> / {length}</span>
          </span>
          <span
            title={t('preview.frame', { n: frame })}
            className="ml-auto hidden h-5 shrink-0 items-center rounded-sm bg-raised px-1.5 font-mono text-[11px] tabular-nums text-text-3 @min-[320px]:inline-flex"
          >
            #{frame}
          </span>
        </div>

        <Scrubber durationSec={durationSec} fps={fps} frame={frame} thumbnails={thumbs} onSeek={seek} scenes={scenes} />

        <div className="flex">
          <Button
            variant="secondary"
            aria-label={t('preview.sendFrame')}
            disabled={sending}
            onClick={() => void sendFrame()}
            className="h-8 w-full min-w-0 gap-1.5 whitespace-nowrap px-2 text-[13px]"
          >
            <SquarePlus size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="hidden @min-[380px]:inline">{t('preview.sendFrame')}</span>
            <span className="@min-[380px]:hidden">{t('preview.sendFrameShort')}</span>
          </Button>
        </div>
        {error && (
          <p role="alert" className="m-0 text-xs text-orange-light">
            {error}
          </p>
        )}

        <p data-testid="key-hints" className="m-0 hidden items-center gap-1 text-[11px] leading-4 text-text-3 @min-[296px]:flex">
          <Kbd>←</Kbd> <Kbd>→</Kbd> <span>{t('preview.keysFrame')}</span> <span aria-hidden="true">·</span>{' '}
          <span className="inline-flex items-center gap-0.5">
            <Kbd>Shift</Kbd>+<Kbd>←</Kbd> <Kbd>→</Kbd>
          </span>{' '}
          <span>{t('preview.keysSecond')}</span>
        </p>
      </div>
    </div>
  );
}
