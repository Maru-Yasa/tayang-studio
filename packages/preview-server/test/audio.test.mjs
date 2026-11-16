import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRIFT, clipTime, clipTiming, clipsOf, createAudioMirror } from '../harness/audio-mirror.js';

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

function fakeAudio(src) {
  return {
    src, paused: true, muted: false, currentTime: 0, plays: 0,
    play() { this.paused = false; this.plays++; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
}

test('the mirror plays each clip once, on the film clock, and follows seeks and pauses', () => {
  const vo = fakeAudio('vo.mp3');
  const sfx = fakeAudio('sfx.mp3');
  const m = createAudioMirror([
    { el: vo, timing: { start: 0, duration: 10, mediaStart: 0, rate: 1, volume: 1 } },
    { el: sfx, timing: { start: 5, duration: 1, mediaStart: 0, rate: 1, volume: 1 } },
  ]);
  m.sync(3, false); // a seek while paused: in place, silent
  assert.equal(vo.currentTime, 3);
  assert.equal(vo.paused, true);

  m.sync(3, true);
  m.sync(3.05, true); // playing on: a small drift is left alone, play is not called again
  assert.equal(vo.plays, 1);
  assert.equal(vo.currentTime, 3);
  assert.equal(sfx.paused, true, 'before its window');

  m.sync(3 + DRIFT + 0.2, true); // drifted too far: moved back onto the clock
  assert.equal(vo.currentTime, 3 + DRIFT + 0.2);

  m.sync(5.5, true);
  assert.equal(sfx.paused, false);
  assert.equal(sfx.currentTime, 0.5);
  m.sync(6.2, true); // past its window
  assert.equal(sfx.paused, true);

  m.setMuted(true);
  assert.equal(vo.muted, true);
  m.sync(7, false);
  assert.equal(vo.paused, true);
});

test('the clips come from the composition, as new elements of the harness page', () => {
  const media = (tag, a) => ({ tagName: tag, currentSrc: '', getAttribute: attrs(a) });
  const doc = {
    baseURI: 'http://127.0.0.1:1/t/p/index.html',
    querySelectorAll: (sel) => {
      assert.equal(sel, 'audio[data-start], video[data-start]');
      return [
        media('AUDIO', { src: 'audio/voice.mp3', 'data-start': 0, 'data-volume': 0.8 }),
        media('VIDEO', { src: 'clip.mp4', 'data-start': 1, muted: '' }),
        media('AUDIO', { 'data-start': 2 }),
      ];
    },
  };
  const clips = clipsOf(doc, fakeAudio);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].el.src, 'http://127.0.0.1:1/t/p/audio/voice.mp3');
  assert.equal(clips[0].el.volume, 0.8);
});
