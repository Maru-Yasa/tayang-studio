// The sound of a HyperFrames live preview, played by the harness itself.
//
// `<hyperframes-player>` moves the picture from the GSAP timeline, but who plays the composition's
// media depends on the HyperFrames runtime's internal state: without the runtime nothing does (no
// sound), with it the runtime and the player can both play (an echo). So the harness mutes the
// player and plays each `<audio data-start>` / `<video data-start>` of the composition here, on the
// player's clock: the clips the renderer mixes into the video, timed by the same attributes.

/** Further apart than this (seconds) a playing clip is moved back onto the player's clock. */
export const DRIFT = 0.15;

const num = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A media element's place in the film, from its attributes: `get(name)` reads one.
 * `null` when it has no `data-start` (the renderer doesn't play it either) or it is muted.
 */
export function clipTiming(get) {
  const start = num(get('data-start'));
  if (start === null || start < 0 || get('muted') !== null) return null;
  const end = num(get('data-end'));
  const length = num(get('data-duration'));
  const duration = length !== null && length > 0 ? length : end !== null && end > start ? end - start : Infinity;
  const mediaStart = Math.max(0, num(get('data-playback-start')) ?? num(get('data-media-start')) ?? 0);
  const rate = Math.min(10, Math.max(0.1, num(get('data-playback-rate')) ?? 1));
  const volume = Math.min(1, Math.max(0, num(get('data-volume')) ?? 1));
  return { start, duration, mediaStart, rate, volume };
}

/** Where in its file a clip should be at film time `t` (seconds), or null when it is silent then. */
export function clipTime(clip, t) {
  if (t < clip.start || t >= clip.start + clip.duration) return null;
  return clip.mediaStart + (t - clip.start) * clip.rate;
}

/**
 * Plays `clips` ({ el, timing }) on the film clock: `sync(t, playing)` after every play, pause, seek
 * and frame.
 */
export function createAudioMirror(clips) {
  let muted = false;
  return {
    clips,
    setMuted(m) {
      muted = m;
      for (const c of clips) c.el.muted = m;
    },
    sync(t, playing) {
      for (const { el, timing } of clips) {
        const at = clipTime(timing, t);
        if (at === null) {
          if (!el.paused) el.pause();
          continue;
        }
        if (!playing) {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - at) > 0.001) el.currentTime = at;
          continue;
        }
        if (Math.abs(el.currentTime - at) > DRIFT) el.currentTime = at;
        el.muted = muted;
        if (el.paused) el.play()?.catch?.(() => {});
      }
    },
    stop() {
      for (const c of clips) c.el.pause();
    },
  };
}

/** The composition's clips as new elements of this page, each from the same file as the original. */
export function clipsOf(doc, makeAudio = (src) => new Audio(src)) {
  const out = [];
  for (const media of doc.querySelectorAll('audio[data-start], video[data-start]')) {
    const timing = clipTiming((name) => media.getAttribute(name));
    const src = media.currentSrc || (media.getAttribute('src') && new URL(media.getAttribute('src'), doc.baseURI).href);
    if (!timing || !src) continue;
    const el = makeAudio(src);
    el.preload = 'auto';
    el.volume = timing.volume;
    el.playbackRate = timing.rate;
    out.push({ el, timing });
  }
  return out;
}
