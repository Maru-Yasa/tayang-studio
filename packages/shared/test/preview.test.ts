import { describe, expect, it } from 'vitest';
import { PREVIEW_PROTOCOL, previewCommand, previewEventOf } from '../src/index';

const ev = (o: object) => ({ tayangPreview: PREVIEW_PROTOCOL, ...o });

describe('previewEventOf', () => {
  it('reads a ready event and rounds its frames', () => {
    expect(previewEventOf(ev({ type: 'ready', fps: 30, durationInFrames: 150.4, width: 1920, height: 1080, frame: 44.6 }))).toEqual({
      type: 'ready',
      fps: 30,
      durationInFrames: 150,
      width: 1920,
      height: 1080,
      frame: 45,
    });
  });
  it('rejects a ready event without a usable length or fps', () => {
    expect(previewEventOf(ev({ type: 'ready', fps: 0, durationInFrames: 10, width: 1, height: 1, frame: 0 }))).toBeNull();
    expect(previewEventOf(ev({ type: 'ready', fps: 30, durationInFrames: 0, width: 1, height: 1, frame: 0 }))).toBeNull();
    expect(previewEventOf(ev({ type: 'ready', fps: 30, width: 1, height: 1, frame: 0 }))).toBeNull();
  });
  it('reads frame, pause, play, ended, reloading and error', () => {
    expect(previewEventOf(ev({ type: 'frame', frame: 3 }))).toEqual({ type: 'frame', frame: 3 });
    expect(previewEventOf(ev({ type: 'pause', frame: -2 }))).toEqual({ type: 'pause', frame: 0 });
    expect(previewEventOf(ev({ type: 'play' }))).toEqual({ type: 'play' });
    expect(previewEventOf(ev({ type: 'ended' }))).toEqual({ type: 'ended' });
    expect(previewEventOf(ev({ type: 'reloading' }))).toEqual({ type: 'reloading' });
    expect(previewEventOf(ev({ type: 'error', message: 'boom' }))).toEqual({ type: 'error', message: 'boom' });
    expect(previewEventOf(ev({ type: 'error' }))).toEqual({ type: 'error', message: 'Live preview failed' });
  });
  it('ignores other versions, unknown types and anything that is not an object', () => {
    expect(previewEventOf({ tayangPreview: PREVIEW_PROTOCOL + 1, type: 'play' })).toBeNull();
    expect(previewEventOf(ev({ type: 'navigate' }))).toBeNull();
    expect(previewEventOf(ev({ type: 'frame', frame: 'x' }))).toBeNull();
    expect(previewEventOf('play')).toBeNull();
    expect(previewEventOf(null)).toBeNull();
  });
});

describe('previewCommand', () => {
  it('stamps the protocol version', () => {
    expect(previewCommand({ type: 'seek', frame: 12 })).toEqual({ tayangPreview: PREVIEW_PROTOCOL, type: 'seek', frame: 12 });
  });
});
