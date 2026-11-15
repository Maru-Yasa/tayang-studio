// The harness side of the live preview protocol (packages/shared/src/preview.ts, same version).
// An engine adapter only says how to load, seek, play and read its player; this file talks to
// Tayang's Preview panel, keeps the frame across reloads and follows the server's reload events.
//
// adapter = {
//   init(): Promise<{ fps, durationInFrames, width, height }>,
//   seek(frame), play(), pause(), setMuted(muted),
//   frame(): number, playing(): boolean,
// }
export const PROTOCOL = 1;

const post = (msg) => window.parent.postMessage({ tayangPreview: PROTOCOL, ...msg }, '*');

export function reportError(message) {
  post({ type: 'error', message: String(message).slice(0, 2000) });
}

/** Follows the server's events: a rebuild reloads the page on the frame it was on. */
export function followServer(currentFrame) {
  const events = new EventSource('events');
  events.addEventListener('reload', () => {
    post({ type: 'reloading' });
    const frame = currentFrame();
    location.hash = 'f=' + (Number.isFinite(frame) ? frame : 0);
    location.reload();
  });
  events.addEventListener('fail', (e) => reportError(e.data));
  return events;
}

export function startBridge(adapter) {
  let info = null;
  let lastFrame = -1;
  let wasPlaying = false;
  const startFrame = Math.max(0, Math.round(+new URLSearchParams(location.hash.slice(1)).get('f') || 0));
  const clamp = (f) => Math.min(info.durationInFrames - 1, Math.max(0, Math.round(+f || 0)));

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !info) return;
    const d = e.data;
    if (!d || d.tayangPreview !== PROTOCOL) return;
    try {
      if (d.type === 'seek') adapter.seek(clamp(d.frame));
      else if (d.type === 'play') {
        if (adapter.frame() >= info.durationInFrames - 1) adapter.seek(0);
        adapter.play();
      } else if (d.type === 'pause') adapter.pause();
      else if (d.type === 'setMuted') adapter.setMuted(!!d.muted);
    } catch (err) {
      reportError(err?.message ?? err);
    }
  });

  followServer(() => (info ? adapter.frame() : startFrame));

  const tick = () => {
    requestAnimationFrame(tick);
    const frame = adapter.frame();
    const playing = adapter.playing();
    if (playing && !wasPlaying) post({ type: 'play' });
    if (frame !== lastFrame && playing) post({ type: 'frame', frame });
    if (!playing && wasPlaying) {
      post({ type: 'pause', frame });
      if (frame >= info.durationInFrames - 1) post({ type: 'ended' });
    }
    lastFrame = frame;
    wasPlaying = playing;
  };

  Promise.resolve()
    .then(() => adapter.init())
    .then((i) => {
      info = i;
      const frame = clamp(startFrame);
      adapter.seek(frame);
      lastFrame = frame;
      post({ type: 'ready', ...i, frame });
      requestAnimationFrame(tick);
    })
    .catch((err) => reportError(err?.message ?? err));
}
