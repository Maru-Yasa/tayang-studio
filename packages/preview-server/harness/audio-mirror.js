// The sound of a HyperFrames live preview, played by the harness itself.
//
// `<hyperframes-player>` moves the picture from the GSAP timeline, but who plays the composition's
// media depends on the HyperFrames runtime's internal state: without the runtime nothing does (no
// sound), with it the runtime and the player can both play (an echo). So the server hides each
// `<audio data-start>` from the player and the harness plays them here: the clips the renderer mixes
// into the video, timed by the same attributes.

/**
 * The sound is the clock (`createFilmClock`): while a clip sounds, the picture is drawn at the clip's
 * time, so they never drift and the sound is never seeked while it plays (every seek stalls a media
 * element for about 0.4 s: chasing the picture with seeks made the sound cut in and out). When the
 * clip is starting up or stalls, the picture waits for it.
 *
 * The other clips (music, effects) follow that clock:
 * - one about to begin is started LEAD earlier (WebKit takes about that long to sound), aimed where
 *   the film will be when it sounds;
 * - small drift is taken back by playing NUDGE faster or slower (pitch kept), never by a seek;
 * - only drift past SEEK (a stall) seeks, aimed LEAD ahead, at most once per SEEK_COOLDOWN_MS.
 * The rate takes three values and properties are set only when they change: setting playbackRate
 * restarts WebKit's time stretcher, so setting it every frame stalls the sound as badly as seeking.
 */
export const SEEK = 1;
export const SEEK_COOLDOWN_MS = 2000;
export const NUDGE = 0.05;
/** How long (seconds) a media element takes to sound after play() or a seek. */
export const LEAD = 0.4;
/** A clip starting this close (seconds) to where it should is started where it is, without a seek. */
export const START_SLACK = 0.15;
/** Drift past this (seconds) starts a nudge; back under BACK_IN_SYNC the clip plays at its own rate. */
export const IN_SYNC = 0.08;
export const BACK_IN_SYNC = 0.02;

/**
 * The rate for a clip with this `drift` (clip time minus film time, seconds) now playing at `current`:
 * its own rate, NUDGE faster (behind) or NUDGE slower (ahead), kept until the drift is taken back.
 */
export function nudgedRate(rate, drift, current = rate) {
  if (drift < -IN_SYNC) return rate * (1 + NUDGE);
  if (drift > IN_SYNC) return rate * (1 - NUDGE);
  if (Math.abs(drift) < BACK_IN_SYNC) return rate;
  // In between: keep going the way it was, so the rate doesn't flip back and forth.
  const nudges = [rate * (1 + NUDGE), rate * (1 - NUDGE), rate];
  return nudges.find((r) => Math.abs(r - current) < 1e-3) ?? rate;
}

/** Sets a media property only when it really changes: some sets restart the media pipeline. */
const setIfChanged = (el, key, value) => {
  if (typeof value === 'number' ? Math.abs(el[key] - value) > 1e-3 : el[key] !== value) el[key] = value;
};

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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

/** Plays `clips` ({ el, timing }) on the film clock: `sync(t, playing)` after every pause, seek and frame. */
export function createAudioMirror(clips) {
  let muted = false;
  /** When each clip was last seeked or started (ms): it gets a moment to settle before seeking again. */
  const settledAt = new Map();

  const begin = (el, timing, at, now) => {
    // Never a second seek on top of one still running (WebKit then stalls the element for good), and
    // none for a hair: the film waits for the clip that sets its clock anyway.
    if (!el.seeking && Math.abs(el.currentTime - at) > START_SLACK) el.currentTime = at;
    setIfChanged(el, 'playbackRate', timing.rate);
    setIfChanged(el, 'muted', muted);
    el.play()?.catch?.(() => {});
    settledAt.set(el, now);
  };
  const ended = (el, at) => el.ended || (el.duration > 0 && at >= el.duration - 0.05);

  return {
    clips,
    setMuted(m) {
      muted = m;
      for (const c of clips) c.el.muted = m;
    },
    /** The clip that sets the film's time at `t`: the longest one sounding there. */
    master(t) {
      let best = null;
      for (const c of clips) {
        const at = clipTime(c.timing, t);
        if (at === null || c.el.paused || ended(c.el, at)) continue;
        if (!best || c.timing.duration > best.timing.duration) best = c;
      }
      return best;
    },
    sync(t, playing, now = nowMs()) {
      for (const { el, timing } of clips) {
        if (!playing) {
          if (!el.paused) el.pause();
          const at = clipTime(timing, t);
          if (at !== null && Math.abs(el.currentTime - at) > 0.001) el.currentTime = at;
          setIfChanged(el, 'playbackRate', timing.rate);
          continue;
        }
        const at = clipTime(timing, t);
        if (el.paused) {
          if (at !== null) {
            // In its window: start right here (the film waits for the clip that sets its clock).
            if (!ended(el, at)) begin(el, timing, at, now);
          } else {
            // About to begin: start LEAD early, aimed where the film will be when it sounds.
            const ahead = clipTime(timing, t + LEAD);
            if (ahead !== null && !ended(el, ahead)) begin(el, timing, ahead, now);
          }
          continue;
        }
        if (at === null) {
          // Still starting up before its window: leave it. Past its window: stop.
          if (t >= timing.start) el.pause();
          continue;
        }
        setIfChanged(el, 'muted', muted);
        const drift = el.currentTime - at;
        if (Math.abs(drift) > SEEK && now - (settledAt.get(el) ?? -Infinity) >= SEEK_COOLDOWN_MS) {
          el.currentTime = clipTime(timing, t + LEAD) ?? at;
          setIfChanged(el, 'playbackRate', timing.rate);
          settledAt.set(el, now);
          continue;
        }
        setIfChanged(el, 'playbackRate', nudgedRate(timing.rate, drift, el.playbackRate));
      }
    },
    stop() {
      for (const c of clips) c.el.pause();
    },
  };
}

/** A sounding clip whose time hasn't moved for this long (ms) has stalled: the picture waits. */
export const STALL_MS = 250;
/** The picture waits for a starting or stalled clip at most this long (ms), then runs on its own. */
export const MAX_HOLD_MS = 1000;
/** Between two readings of the clip's time the picture runs on, but never this far (s) ahead. */
const MAX_EXTRAPOLATE = 0.1;

/**
 * The film's time while it plays, taken from the sound: `tick(now)` once per frame gives the time to
 * draw. With a clip sounding it is that clip's time (waiting while the clip starts or stalls); with
 * none, the wall clock. Stops at `duration`.
 */
export function createFilmClock(mirror, duration) {
  let t = 0;
  let playing = false;
  let lastNow = 0;
  /** The master clip's last reading: its element, its time, and when that time last moved. */
  let reading = null;
  const clamp = (x) => Math.min(duration, Math.max(0, x));
  return {
    get time() {
      return t;
    },
    get playing() {
      return playing;
    },
    play(now) {
      if (t >= duration) t = 0;
      playing = true;
      lastNow = now;
      reading = null;
    },
    pause() {
      playing = false;
    },
    seek(time) {
      t = clamp(time);
      reading = null;
    },
    /** The time to draw now; false `playing` afterwards means the film reached its end. */
    tick(now) {
      if (!playing) return t;
      const m = mirror.master(t);
      if (m) {
        const ct = m.el.currentTime;
        if (!reading || reading.el !== m.el) {
          // A clip just took over: wait until its time moves, then follow it.
          reading = { el: m.el, ct, movedAt: null, waitingSince: now };
        } else if (ct !== reading.ct) {
          reading = { ...reading, ct, movedAt: now, waitingSince: null };
        }
        if (reading.movedAt !== null && now - reading.movedAt < STALL_MS) {
          const at = m.timing.start + (reading.ct - m.timing.mediaStart) / m.timing.rate;
          const since = Math.min(MAX_EXTRAPOLATE, ((now - reading.movedAt) / 1000) * m.timing.rate);
          // Never backwards by a hair: readings come in steps.
          const next = at + since;
          if (next > t || t - next > 0.2) t = next;
        } else {
          // Starting up or stalled: the picture holds, but not for long: a clip that stays stuck
          // must not freeze the film (the mirror seeks it back into place).
          if (reading.waitingSince === null) reading = { ...reading, waitingSince: now };
          if (now - reading.waitingSince > MAX_HOLD_MS) t += (now - lastNow) / 1000;
        }
      } else {
        reading = null;
        t += (now - lastNow) / 1000;
      }
      lastNow = now;
      t = clamp(t);
      if (t >= duration) playing = false;
      return t;
    },
  };
}

/** The attribute the live preview server renames `data-start` to on `<audio>` (src/hyperframes.mjs). */
export const HIDDEN_START = 'data-tayang-start';

/**
 * The composition's sound as new elements of this page, each from the same file as the original: its
 * `<audio>` (served with HIDDEN_START so the player leaves them alone). A `<video>` stays the player's.
 */
export function clipsOf(doc, makeAudio = (src) => new Audio(src)) {
  const out = [];
  for (const media of doc.querySelectorAll(`audio[${HIDDEN_START}]`)) {
    const timing = clipTiming((name) => media.getAttribute(name === 'data-start' ? HIDDEN_START : name));
    const src = media.currentSrc || (media.getAttribute('src') && new URL(media.getAttribute('src'), doc.baseURI).href);
    if (!timing || !src) continue;
    const el = makeAudio(src);
    el.preload = 'auto';
    el.volume = timing.volume;
    el.playbackRate = timing.rate;
    // The voice keeps its pitch while the mirror plays it a little faster or slower to stay in sync.
    el.preservesPitch = true;
    out.push({ el, timing });
  }
  return out;
}
