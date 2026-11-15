import { previewCommand, previewEventOf, type PreviewCommand } from '@tayang/shared';

/** What the Preview panel reads from the live preview, the same for every engine. */
export interface LiveState {
  status: 'loading' | 'ready' | 'error';
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  frame: number;
  playing: boolean;
  error: string | null;
}

export const LIVE_LOADING: LiveState = {
  status: 'loading',
  fps: 30,
  durationInFrames: 1,
  width: 0,
  height: 0,
  frame: 0,
  playing: false,
  error: null,
};

/**
 * Talks to the harness in the preview iframe (packages/preview-server/harness/bridge.js). Accepts
 * messages only from that iframe's window and the server's origin; sends commands only there.
 */
export function createLiveSource(opts: {
  /** The iframe's window, once it exists. */
  target: () => Window | null | undefined;
  /** The preview server's origin (`http://127.0.0.1:<port>`). */
  origin: string;
  onChange(state: LiveState): void;
}) {
  let state = LIVE_LOADING;
  const set = (patch: Partial<LiveState>) => {
    state = { ...state, ...patch };
    opts.onChange(state);
  };
  const send = (cmd: PreviewCommand) => {
    const win = opts.target();
    if (win) win.postMessage(previewCommand(cmd), opts.origin);
  };

  function onMessage(e: MessageEvent) {
    if (e.origin !== opts.origin || !e.source || e.source !== opts.target()) return;
    const ev = previewEventOf(e.data);
    if (!ev) return;
    switch (ev.type) {
      case 'ready':
        set({ status: 'ready', error: null, fps: ev.fps, durationInFrames: ev.durationInFrames, width: ev.width, height: ev.height, frame: ev.frame, playing: false });
        break;
      case 'frame':
        set({ frame: ev.frame });
        break;
      case 'play':
        set({ playing: true });
        break;
      case 'pause':
        set({ playing: false, frame: ev.frame });
        break;
      case 'ended':
        set({ playing: false });
        break;
      case 'reloading':
        // Keep showing the frame and length it had: the reload comes back on the same frame.
        set({ playing: false });
        break;
      case 'error':
        set({ status: 'error', error: ev.message, playing: false });
        break;
    }
  }

  return {
    onMessage,
    get state() {
      return state;
    },
    seek(frame: number) {
      if (state.status !== 'ready') return;
      const f = Math.min(state.durationInFrames - 1, Math.max(0, Math.round(frame)));
      set({ frame: f });
      send({ type: 'seek', frame: f });
    },
    play() {
      if (state.status === 'ready') send({ type: 'play' });
    },
    pause() {
      if (state.status === 'ready') send({ type: 'pause' });
    },
    toggle() {
      if (state.playing) this.pause();
      else this.play();
    },
  };
}

export type LiveSource = ReturnType<typeof createLiveSource>;
