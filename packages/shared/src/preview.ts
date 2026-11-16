/**
 * The live preview's contract between Tayang's Preview panel and the harness page the preview server
 * serves in an iframe. The same messages for every engine (HyperFrames, Remotion): the panel never
 * knows which one is behind the iframe. `packages/preview-server/harness/bridge.js` speaks the other
 * side and carries the same version.
 */
export const PREVIEW_PROTOCOL = 1;

export type PreviewEngine = 'hyperframes' | 'remotion';

/** Panel → harness. */
export type PreviewCommand =
  | { type: 'seek'; frame: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'setMuted'; muted: boolean };

/** Harness → panel. `ready` comes again after every reload, with the frame it kept. */
export type PreviewEvent =
  | { type: 'ready'; fps: number; durationInFrames: number; width: number; height: number; frame: number }
  | { type: 'frame'; frame: number }
  | { type: 'play' }
  | { type: 'pause'; frame: number }
  | { type: 'ended' }
  | { type: 'reloading' }
  | { type: 'error'; message: string };

export type PreviewEnvelope<T> = { tayangPreview: typeof PREVIEW_PROTOCOL } & T;

const EVENT_TYPES = new Set(['ready', 'frame', 'play', 'pause', 'ended', 'reloading', 'error']);
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/** The event in a message from the harness, or null for anything else (other protocols, other versions, bad fields). */
export function previewEventOf(data: unknown): PreviewEvent | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.tayangPreview !== PREVIEW_PROTOCOL || typeof d.type !== 'string' || !EVENT_TYPES.has(d.type)) return null;
  switch (d.type) {
    case 'ready':
      if (![d.fps, d.durationInFrames, d.width, d.height, d.frame].every(num)) return null;
      if ((d.fps as number) <= 0 || (d.durationInFrames as number) < 1) return null;
      return {
        type: 'ready',
        fps: d.fps as number,
        durationInFrames: Math.round(d.durationInFrames as number),
        width: d.width as number,
        height: d.height as number,
        frame: Math.max(0, Math.round(d.frame as number)),
      };
    case 'frame':
      return num(d.frame) ? { type: 'frame', frame: Math.max(0, Math.round(d.frame as number)) } : null;
    case 'pause':
      return num(d.frame) ? { type: 'pause', frame: Math.max(0, Math.round(d.frame as number)) } : null;
    case 'error':
      return { type: 'error', message: typeof d.message === 'string' ? d.message.slice(0, 2000) : 'Live preview failed' };
    default:
      return { type: d.type } as PreviewEvent;
  }
}

export function previewCommand(cmd: PreviewCommand): PreviewEnvelope<PreviewCommand> {
  return { tayangPreview: PREVIEW_PROTOCOL, ...cmd };
}
