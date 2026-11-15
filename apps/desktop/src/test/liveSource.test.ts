import { PREVIEW_PROTOCOL } from '@tayang/shared';
import { createLiveSource, type LiveState } from '@/lib/liveSource';

const ORIGIN = 'http://127.0.0.1:4100';

function setup() {
  const sent: unknown[] = [];
  const frameWin = { postMessage: (m: unknown, origin: string) => sent.push([m, origin]) } as unknown as Window;
  const states: LiveState[] = [];
  const src = createLiveSource({ target: () => frameWin, origin: ORIGIN, onChange: (s) => states.push(s) });
  const msg = (data: object, { origin = ORIGIN, source = frameWin as unknown } = {}) =>
    src.onMessage({ origin, source, data: { tayangPreview: PREVIEW_PROTOCOL, ...data } } as MessageEvent);
  const ready = (frame = 0) => msg({ type: 'ready', fps: 30, durationInFrames: 150, width: 1920, height: 1080, frame });
  return { src, sent, states, msg, ready, frameWin };
}

describe('live source', () => {
  it('starts loading and becomes ready with the harness length, fps, size and frame', () => {
    const h = setup();
    expect(h.src.state.status).toBe('loading');
    h.ready(12);
    expect(h.src.state).toMatchObject({ status: 'ready', fps: 30, durationInFrames: 150, width: 1920, height: 1080, frame: 12 });
  });

  it('sends nothing before ready', () => {
    const h = setup();
    h.src.seek(4);
    h.src.play();
    expect(h.sent).toEqual([]);
  });

  it('seeks within the film and sends the clamped frame to the iframe origin only', () => {
    const h = setup();
    h.ready();
    h.src.seek(999);
    h.src.seek(-5);
    h.src.seek(7.6);
    expect(h.sent).toEqual([
      [{ tayangPreview: PREVIEW_PROTOCOL, type: 'seek', frame: 149 }, ORIGIN],
      [{ tayangPreview: PREVIEW_PROTOCOL, type: 'seek', frame: 0 }, ORIGIN],
      [{ tayangPreview: PREVIEW_PROTOCOL, type: 'seek', frame: 8 }, ORIGIN],
    ]);
    expect(h.src.state.frame).toBe(8);
  });

  it('follows play, frame, pause and ended from the harness; toggle plays or pauses', () => {
    const h = setup();
    h.ready();
    h.src.toggle();
    expect(h.sent.at(-1)).toEqual([{ tayangPreview: PREVIEW_PROTOCOL, type: 'play' }, ORIGIN]);
    h.msg({ type: 'play' });
    h.msg({ type: 'frame', frame: 20 });
    expect(h.src.state).toMatchObject({ playing: true, frame: 20 });
    h.src.toggle();
    expect(h.sent.at(-1)).toEqual([{ tayangPreview: PREVIEW_PROTOCOL, type: 'pause' }, ORIGIN]);
    h.msg({ type: 'pause', frame: 22 });
    expect(h.src.state).toMatchObject({ playing: false, frame: 22 });
    h.msg({ type: 'play' });
    h.msg({ type: 'ended' });
    expect(h.src.state.playing).toBe(false);
  });

  it('keeps the frame through a reload and takes the frame the new page reports', () => {
    const h = setup();
    h.ready();
    h.src.seek(40);
    h.msg({ type: 'reloading' });
    expect(h.src.state).toMatchObject({ status: 'ready', frame: 40 });
    h.ready(40);
    expect(h.src.state.frame).toBe(40);
  });

  it('shows the harness error, and a later ready clears it', () => {
    const h = setup();
    h.msg({ type: 'error', message: "Live preview needs the project's packages installed" });
    expect(h.src.state).toMatchObject({ status: 'error', error: "Live preview needs the project's packages installed" });
    h.ready();
    expect(h.src.state).toMatchObject({ status: 'ready', error: null });
  });

  it('ignores messages from another origin, another window, or another protocol', () => {
    const h = setup();
    h.msg({ type: 'ready', fps: 30, durationInFrames: 150, width: 1, height: 1, frame: 0 }, { origin: 'http://127.0.0.1:9999' });
    h.msg({ type: 'ready', fps: 30, durationInFrames: 150, width: 1, height: 1, frame: 0 }, { source: {} });
    h.src.onMessage({ origin: ORIGIN, source: h.frameWin, data: { type: 'ready' } } as MessageEvent);
    expect(h.src.state.status).toBe('loading');
    expect(h.states).toEqual([]);
  });
});
