import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Pause, Play, SquarePlus, ZoomIn, ZoomOut } from 'lucide-react';
import { hasFramesChecked } from '@tayang/skills';
import { formatTimecode, frameAt, secAt } from '@tayang/shared';
import type { MediaInfo } from '@tayang/shared';
import { Button } from '@/components/Button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Oyen } from '@/components/Oyen';
import { cn } from '@/lib/utils';
import {
  assetUrl,
  latestRenderInfo,
  mediaExtractFrame,
  mediaLatestRender,
  mediaProbe,
  mediaRender,
  mediaThumbnails,
  previewLayers,
  previewStart,
  previewStatus,
  previewStill,
  previewStop,
  type PreviewStatus,
  type TimelineLayers,
} from '@/lib/ipc';
import { LIVE_LOADING, createLiveSource, type LiveSource, type LiveState } from '@/lib/liveSource';
import { NOTHING_TO_RENDER } from '@/lib/renderErrors';
import { useElapsed } from '@/components/Activity';
import { useChat } from '@/state/chat';
import { useRender } from '@/state/render';
import { advanceProject } from '@/lib/projectStatus';
import { Scrubber, ZOOM_MAX, ZOOM_MIN, clampZoom, type Scene } from './Scrubber';

const THUMBS = 12;
/** How often the panel looks again whether the code can be played live, or changed after the render. */
const STATUS_POLL_MS = 4000;
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

/** When a render was made, short: the time today, else the day. */
function renderTime(modifiedAt: string, lang: string): string {
  const d = new Date(modifiedAt);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(lang, { day: 'numeric', month: 'short' });
}

/**
 * Live from the code or the latest render, both always in view above the video: which one plays and
 * what the other is. Says when the code changed after the render.
 */
function SourcePicker({
  mode,
  canLive,
  renderedAt,
  codeNewer,
  onPick,
}: {
  mode: 'live' | 'render';
  canLive: boolean;
  renderedAt: string | null;
  codeNewer: boolean;
  onPick(mode: 'live' | 'render'): void;
}) {
  const { t, i18n } = useTranslation();
  const hasRender = renderedAt !== null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-4 pt-4">
      <Tabs value={mode} onValueChange={(v) => onPick(v as 'live' | 'render')}>
        <TabsList data-testid="preview-source" aria-label={t('preview.source')} className="h-8 w-full bg-background">
          <TabsTrigger
            value="live"
            disabled={!canLive}
            title={canLive ? t('preview.liveTip') : t('preview.cantLive')}
            className="min-w-0 flex-1 gap-1.5 px-2 text-xs"
          >
            <span aria-hidden="true" className={cn('inline-block size-1.5 shrink-0 rounded-full', mode === 'live' ? 'bg-primary' : 'bg-text-3')} />
            <span className="truncate">{t('preview.liveFromCode')}</span>
          </TabsTrigger>
          <TabsTrigger
            value="render"
            disabled={!hasRender}
            title={hasRender ? t('preview.renderTip') : undefined}
            className="min-w-0 flex-1 px-2 text-xs"
          >
            <span className="truncate">
              {!hasRender
                ? t('preview.noRenderYet')
                : renderTime(renderedAt, i18n.language)
                  ? t('preview.renderAt', { time: renderTime(renderedAt, i18n.language) })
                  : t('preview.renderPlain')}
            </span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {hasRender && codeNewer && (
        <span data-testid="code-newer" className="text-[11px] leading-4 text-orange-light">
          {t('preview.codeNewer')}
        </span>
      )}
    </div>
  );
}

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
  const [renderedAt, setRenderedAt] = useState<string | null>(null);
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [renderFrame, setFrame] = useState(0);
  const [renderPlaying, setPlaying] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Live preview: the project played from its code, no render. `prefer` is the user's pick between the
  // live preview and the render when both exist; without one, live wins when the code is newer.
  const [liveStatus, setLiveStatus] = useState<PreviewStatus | null>(null);
  const [prefer, setPrefer] = useState<'live' | 'render' | null>(null);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>(LIVE_LOADING);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sourceRef = useRef<LiveSource | null>(null);
  // Voice and subtitles under the strip; kept as the same object while they don't change.
  const [layers, setLayers] = useState<TimelineLayers | null>(null);
  const layersKey = useRef('');
  // How far the timeline is zoomed in; each project opens with the whole video in view.
  const [zoom, setZoom] = useState(ZOOM_MIN);
  useEffect(() => setZoom(ZOOM_MIN), [projectId]);

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

  const checkLive = useCallback(async () => {
    try {
      const next = await previewStatus(projectId);
      setLiveStatus((s) => (s && s.engine === next?.engine && s.codeNewer === next?.codeNewer ? s : (next ?? null)));
    } catch {
      setLiveStatus(null);
    }
  }, [projectId]);

  const loadLayers = useCallback(async () => {
    try {
      const next = await previewLayers(projectId);
      const key = JSON.stringify(next ?? null);
      if (key === layersKey.current) return;
      layersKey.current = key;
      setLayers(next ?? null);
    } catch {
      // No layers is fine: the strip shows alone.
    }
  }, [projectId]);

  const load = useCallback(async () => {
    void checkLive();
    void loadLayers();
    const [path, probe, file] = await Promise.all([
      mediaLatestRender(projectId),
      mediaProbe(projectId),
      latestRenderInfo(projectId).catch(() => null),
    ]);
    setVideoPath(path);
    setRenderedAt(path ? (file?.modifiedAt ?? '') : null);
    setInfo(probe);
    setFrame(0);
    setPlaying(false);
    setThumbs(path && probe ? (await mediaThumbnails(projectId, THUMBS)).map(assetUrl) : []);
  }, [projectId, checkLive, loadLayers]);

  useEffect(() => {
    let alive = true;
    load().catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [load, reloadKey]);

  // A new render shows itself, even when the user had picked the live preview: they rendered to see it.
  const firstReload = useRef(true);
  useEffect(() => {
    if (firstReload.current) {
      firstReload.current = false;
      return;
    }
    setPrefer(null);
  }, [reloadKey]);

  // A render of this project (the agent's or Tayang's) is running: say so, and show the new video once it ends.
  const run = useRender((s) => s.runs[projectId]);
  const wasRendering = useRef(!!run);
  useEffect(() => {
    if (wasRendering.current && !run) {
      setPrefer(null);
      load().catch((e) => setError(String(e?.message ?? e)));
    }
    wasRendering.current = !!run;
  }, [run, load]);

  const hasRender = !!videoPath && !!info;
  const canLive = !!liveStatus?.engine;
  const mode: 'live' | 'render' | 'none' =
    prefer === 'render' && hasRender
      ? 'render'
      : prefer === 'live' && canLive
        ? 'live'
        : canLive && (!hasRender || liveStatus!.codeNewer)
          ? 'live'
          : hasRender
            ? 'render'
            : 'none';
  const isLive = mode === 'live';

  // The agent may start writing code (or change it) while the panel is open on a render or on nothing.
  useEffect(() => {
    if (isLive) return;
    const id = setInterval(() => void checkLive(), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [isLive, checkLive]);

  // The agent rewrites the voice, the subtitles or the composition while the panel is open.
  useEffect(() => {
    const id = setInterval(() => void loadLayers(), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [loadLayers]);

  // Start the project's preview server while the live preview shows; stop it when it goes away.
  useEffect(() => {
    if (!isLive) return;
    let alive = true;
    setLive(LIVE_LOADING);
    previewStart(projectId)
      .then((r) => alive && setLiveUrl(r.url))
      .catch((e) => alive && setLive({ ...LIVE_LOADING, status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
      setLiveUrl(null);
      void previewStop(projectId).catch(() => {});
    };
  }, [isLive, projectId]);

  useEffect(() => {
    if (!liveUrl) return;
    const source = createLiveSource({
      target: () => iframeRef.current?.contentWindow,
      origin: new URL(liveUrl).origin,
      onChange: setLive,
    });
    sourceRef.current = source;
    window.addEventListener('message', source.onMessage);
    return () => {
      window.removeEventListener('message', source.onMessage);
      sourceRef.current = null;
    };
  }, [liveUrl]);

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
  if (mode === 'none' || (!isLive && (!videoPath || !info))) {
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

  const fps = isLive ? live.fps : info!.fps;
  const total = isLive ? Math.max(1, live.durationInFrames) : Math.max(1, Math.round(info!.durationSec * info!.fps));
  const durationSec = isLive ? total / fps : info!.durationSec;
  const frame = isLive ? live.frame : renderFrame;
  const playing = isLive ? live.playing : renderPlaying;
  const clamp = (f: number) => Math.min(total - 1, Math.max(0, f));
  const seek = (f: number) => {
    if (isLive) return sourceRef.current?.seek(f);
    const next = clamp(f);
    setFrame(next);
    if (videoRef.current) videoRef.current.currentTime = secAt(next, fps);
  };
  const toggle = () => {
    if (isLive) return sourceRef.current?.toggle();
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
      const imagePath = isLive ? await previewStill(projectId, frame, fps) : await mediaExtractFrame(projectId, timeSec);
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
  const [w, h] = isLive ? [live.width, live.height] : [info!.width, info!.height];
  const aspect = w > 0 && h > 0 ? w / h : 9 / 16;
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
      {canLive && (
        <SourcePicker
          mode={isLive ? 'live' : 'render'}
          canLive={canLive}
          renderedAt={hasRender ? renderedAt : null}
          codeNewer={!!liveStatus?.codeNewer}
          onPick={setPrefer}
        />
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
          {isLive ? (
            <>
              {liveUrl && (
                <iframe
                  ref={iframeRef}
                  data-testid="live-preview"
                  title={t('preview.liveTitle')}
                  src={liveUrl}
                  // Project code runs here: its own origin (127.0.0.1), no top navigation, no popups.
                  // i18n-ignore: iframe tokens, not copy
                  sandbox="allow-scripts allow-same-origin"
                  // i18n-ignore: iframe tokens, not copy
                  allow="autoplay"
                  className="h-full w-full border-0"
                />
              )}
              {live.status === 'loading' && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-text-3">
                  {t('preview.liveLoading')}
                </span>
              )}
            </>
          ) : (
            <video
              ref={videoRef}
              src={assetUrl(videoPath!)}
              className="h-full w-full object-contain"
              playsInline
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(e) => setFrame(clamp(frameAt(e.currentTarget.currentTime, fps)))}
            />
          )}
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
          <div data-testid="zoom" className="ml-auto flex shrink-0 items-center" title={t('preview.zoomTip')}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('preview.zoomOut')}
              disabled={zoom <= ZOOM_MIN}
              onClick={() => setZoom((z) => clampZoom(z / 2))}
              className="size-7 shrink-0 px-0"
            >
              <ZoomOut size={14} strokeWidth={1.5} />
            </Button>
            <button
              type="button"
              aria-label={t('preview.zoomReset')}
              title={t('preview.zoomReset')}
              disabled={zoom <= ZOOM_MIN}
              onClick={() => setZoom(ZOOM_MIN)}
              className="hidden w-8 cursor-pointer text-center font-mono text-[11px] tabular-nums text-text-3 enabled:hover:text-foreground disabled:cursor-default @min-[460px]:block"
            >
              {`${zoom < 10 ? Math.round(zoom * 10) / 10 : Math.round(zoom)}×`}
            </button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('preview.zoomIn')}
              disabled={zoom >= ZOOM_MAX}
              onClick={() => setZoom((z) => clampZoom(z * 2))}
              className="size-7 shrink-0 px-0"
            >
              <ZoomIn size={14} strokeWidth={1.5} />
            </Button>
          </div>
          <span
            title={t('preview.frame', { n: frame })}
            className="hidden h-5 shrink-0 items-center rounded-sm bg-raised px-1.5 font-mono text-[11px] tabular-nums text-text-3 @min-[320px]:inline-flex"
          >
            #{frame}
          </span>
        </div>

        <Scrubber durationSec={durationSec} fps={fps} frame={frame} thumbnails={thumbs} onSeek={seek} scenes={scenes} layers={layers} zoom={zoom} onZoom={setZoom} />

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
        {(error || (isLive && live.error)) && (
          <p role="alert" className="m-0 text-xs text-orange-light">
            {error ?? live.error}
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
