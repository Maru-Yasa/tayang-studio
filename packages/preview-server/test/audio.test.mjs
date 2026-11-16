import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACK_IN_SYNC, IN_SYNC, LEAD, NUDGE, SEEK, SEEK_COOLDOWN_MS, STALL_MS, clipTime, clipTiming, clipsOf, createAudioMirror, createFilmClock, nudgedRate } from '../harness/audio-mirror.js';

const attrs = (o) => (name) => (name in o ? String(o[name]) : null);

test('a clip is timed by the attributes the renderer reads', () => {
  assert.deepEqual(clipTiming(attrs({ 'data-start': 2, 'data-duration': 3, 'data-media-start': 1, 'data-volume': 0.5 })), {
    start: 2, duration: 3, mediaStart: 1, rate: 1, volume: 0.5,
  });
  // data-playback-start wins over data-media-start; data-end gives the length; volume and rate stay in range.
  assert.deepEqual(clipTiming(attrs({ 'data-start': 1, 'data-end': 4, 'data-playback-start': 7, 'data-media-start': 1, 'data-volume': 3, 'data-playback-rate': 50 })), {
    start: 1, duration: 3, mediaStart: 7, rate: 10, volume: 1,
  });
  assert.equal(clipTiming(attrs({ 'data-start': 0 })).duration, Infinity);
  assert.equal(clipTiming(attrs({})), null, 'no data-start: not in the film');
  assert.equal(clipTiming(attrs({ 'data-start': 0, muted: '' })), null, 'a muted video adds no sound');
  assert.equal(clipTiming(attrs({ 'data-start': -1 })), null);
});

test('a clip sounds only inside its window, at the matching place in its file', () => {
  const clip = { start: 2, duration: 3, mediaStart: 1, rate: 2, volume: 1 };
  assert.equal(clipTime(clip, 1.9), null);
  assert.equal(clipTime(clip, 2), 1);
  assert.equal(clipTime(clip, 3.5), 4);
  assert.equal(clipTime(clip, 5), null);
});

/** A media element: sounds (`playing`) after `startup` ms once play() is called. */
function fakeAudio(src, { startup = 0, duration = NaN } = {}) {
  const listeners = new Map();
  return {
    src, paused: true, muted: false, currentTime: 0, playbackRate: 1, plays: 0, duration,
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
    play() {
      this.paused = false;
      this.plays++;
      setTimeout(() => (listeners.get('playing') ?? []).forEach((f) => f()), startup);
      return Promise.resolve();
    },
    pause() { this.paused = true; },
  };
}

const vo = (o) => fakeAudio('vo.mp3', o);
const whole = { start: 0, duration: 60, mediaStart: 0, rate: 1, volume: 1 };

test('a clip that begins while the film plays is started early, aimed where the film will be', async () => {
  const sfx = fakeAudio('sfx.mp3');
  const m = createAudioMirror([{ el: sfx, timing: { start: 5, duration: 2, mediaStart: 1, rate: 1, volume: 1 } }]);
  m.sync(4, true, 0); // more than `lead` before: silent
  assert.equal(sfx.paused, true);
  m.sync(5 - LEAD + 0.1, true, 16);
  assert.equal(sfx.paused, false);
  assert.ok(Math.abs(sfx.currentTime - (1 + 0.1)) < 1e-9, 'where the film will be when it sounds');
  m.sync(4.8, true, 32); // still before its window while it starts up: left alone
  assert.equal(sfx.paused, false);
  m.sync(7.1, true, 48); // past its window
  assert.equal(sfx.paused, true);
});

test('a clip in its window starts right there when the film plays', () => {
  const a = vo();
  const m = createAudioMirror([{ el: a, timing: { ...whole, mediaStart: 2 } }]);
  m.sync(4, true, 0);
  assert.equal(a.paused, false);
  assert.equal(a.currentTime, 6);
});

test('a file that ended inside its window is not started again every frame', () => {
  const a = vo({ duration: 3 });
  const m = createAudioMirror([{ el: a, timing: whole }]);
  m.sync(5, true, 0);
  assert.equal(a.plays, 0);
});

test('pausing and seeking while paused put every clip in place, silent', () => {
  const a = vo();
  const m = createAudioMirror([{ el: a, timing: whole }]);
  m.sync(3, true, 0);
  m.sync(7, false, 16);
  assert.equal(a.paused, true);
  assert.equal(a.currentTime, 7);
  m.setMuted(true);
  assert.equal(a.muted, true);
});

test('small drift is taken back by the playback rate, never by a seek: no gaps in the sound', () => {
  const a = vo();
  const m = createAudioMirror([{ el: a, timing: whole }]);
  m.sync(1, true, 0);
  let seeks = 0;
  // The sound runs 0.2 s behind the film for a while.
  for (let i = 1; i <= 60; i++) {
    const film = 1 + i * 0.016;
    a.currentTime = film - 0.2;
    const before = a.currentTime;
    m.sync(film, true, i * 16);
    if (a.currentTime !== before) seeks++;
  }
  assert.equal(seeks, 0);
  assert.equal(a.playbackRate, 1 + NUDGE, 'behind: a little faster');
  a.currentTime = 2.1;
  m.sync(2, true, 2000);
  assert.equal(a.playbackRate, 1 - NUDGE, 'ahead: a little slower');
  a.currentTime = 2.01;
  m.sync(2, true, 2016);
  assert.equal(a.playbackRate, 1, 'in sync: its own rate');
});

test('a big drift seeks once, aimed lead ahead, then waits before seeking again', () => {
  const a = vo();
  const m = createAudioMirror([{ el: a, timing: whole }]);
  m.sync(0, true, 0);
  a.currentTime = 10 - SEEK - 0.5;
  m.sync(10, true, SEEK_COOLDOWN_MS); // a stall: far behind
  assert.equal(a.currentTime, 10 + LEAD);
  a.currentTime = 11 - SEEK - 0.5;
  m.sync(11, true, SEEK_COOLDOWN_MS + 100); // again too soon: nudged, not seeked
  assert.equal(a.currentTime, 11 - SEEK - 0.5);
  m.sync(11, true, 2 * SEEK_COOLDOWN_MS + 100);
  assert.equal(a.currentTime, 11 + LEAD);
});

test('the rate takes three values, with room between them so it does not flip every frame', () => {
  assert.equal(nudgedRate(1, -IN_SYNC - 0.01), 1 + NUDGE);
  assert.equal(nudgedRate(2, IN_SYNC + 3), 2 * (1 - NUDGE));
  assert.equal(nudgedRate(1, BACK_IN_SYNC / 2, 1 + NUDGE), 1, 'back in sync');
  // Between the thresholds: keeps what it is doing.
  const between = (IN_SYNC + BACK_IN_SYNC) / 2;
  assert.equal(nudgedRate(1, -between, 1 + NUDGE), 1 + NUDGE);
  assert.equal(nudgedRate(1, -between, 1), 1);
  assert.equal(nudgedRate(1, between, 1 - NUDGE), 1 - NUDGE);
});

test('a playing clip in sync gets no property sets at all, frame after frame', () => {
  let counting = false;
  const sets = [];
  const vo = new Proxy(fakeAudio('vo.mp3'), {
    set(o, k, v) {
      if (counting) sets.push(k);
      o[k] = v;
      return true;
    },
  });
  const m = createAudioMirror([{ el: vo, timing: { start: 0, duration: 60, mediaStart: 0, rate: 1, volume: 1 } }]);
  m.sync(1, true, 0);
  for (let i = 1; i <= 120; i++) {
    const film = 1 + i / 60;
    vo.currentTime = film - 0.01; // the media element moves on by itself, a little behind
    counting = true;
    m.sync(film, true, i * 16);
    counting = false;
  }
  assert.deepEqual(sets, []);
});

test('the master is the longest clip sounding at the time', () => {
  const voice = vo();
  const sfx = fakeAudio('sfx.mp3');
  const m = createAudioMirror([{ el: sfx, timing: { ...whole, duration: 1, start: 2 } }, { el: voice, timing: whole }]);
  assert.equal(m.master(2.5), null, 'nothing sounds yet');
  m.sync(2.5, true, 0);
  assert.equal(m.master(2.5).el, voice);
  voice.pause();
  assert.equal(m.master(2.5).el, sfx);
});

test('the film follows the sound: it waits while the clip starts, then runs on its time', () => {
  const voice = vo();
  const m = createAudioMirror([{ el: voice, timing: { ...whole, start: 1, mediaStart: 0.5 } }]);
  const clock = createFilmClock(m, 60);
  clock.seek(2);
  clock.play(0);
  m.sync(clock.tick(0), true, 0); // starts the clip at 1.5 s into its file
  assert.equal(voice.currentTime, 1.5);
  // The clip hasn't moved yet (starting up): the picture holds.
  assert.equal(clock.tick(16), 2);
  assert.equal(clock.tick(300), 2);
  // It sounds: the film is the clip's time, and runs on between readings.
  voice.currentTime = 1.6;
  assert.ok(Math.abs(clock.tick(316) - 2.1) < 1e-9);
  assert.ok(Math.abs(clock.tick(332) - (2.1 + 0.016)) < 1e-9);
  // A stall: no new reading for a while, the picture stops where it was.
  const held = clock.tick(316 + STALL_MS + 50);
  assert.equal(clock.tick(316 + STALL_MS + 100), held);
});

test('without a clip sounding the film runs on the wall clock, and stops at its end', () => {
  const m = createAudioMirror([]);
  const clock = createFilmClock(m, 2);
  clock.play(1000);
  assert.ok(Math.abs(clock.tick(1500) - 0.5) < 1e-9);
  clock.tick(4000);
  assert.equal(clock.time, 2);
  assert.equal(clock.playing, false);
  clock.play(5000);
  assert.equal(clock.time, 0, 'playing at the end starts over');
});

test('the clips are the <audio> of the composition, as the server hides them from the player', () => {
  const media = (a) => ({ currentSrc: '', getAttribute: attrs(a) });
  const doc = {
    baseURI: 'http://127.0.0.1:1/t/p/index.html',
    querySelectorAll: (sel) => {
      assert.equal(sel, 'audio[data-tayang-start]');
      return [
        media({ src: 'audio/voice.mp3', 'data-tayang-start': 1.5, 'data-volume': 0.8 }),
        media({ 'data-tayang-start': 2 }),
      ];
    },
  };
  const clips = clipsOf(doc, fakeAudio);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].el.src, 'http://127.0.0.1:1/t/p/audio/voice.mp3');
  assert.equal(clips[0].el.volume, 0.8);
  assert.equal(clips[0].timing.start, 1.5);
});
