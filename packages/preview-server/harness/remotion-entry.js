// Bundled by the project's own @remotion/bundler as the last entry, after the project's entry point
// (which calls registerRoot) and Remotion's render entry, so `remotion_still` / the renderer can use
// the same bundle. It only runs on the page the preview server serves (window.__TAYANG_PREVIEW),
// never when Remotion's renderer opens the bundle.
// Imports resolve to the project's node_modules first (the server sets resolve.modules), so React,
// remotion and @remotion/player are the project's own versions.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Internals } from 'remotion';
import { Player } from '@remotion/player';
import { reportError, startBridge } from './bridge.js';

const h = React.createElement;

async function compositions(Root) {
  // Mount the project's root the way Remotion's render entry does in "evaluation" mode, off screen,
  // so its <Composition>s register; then read them.
  const holder = document.createElement('div');
  holder.style.display = 'none';
  document.body.appendChild(holder);
  createRoot(holder).render(
    h(
      Internals.CompositionManagerProvider,
      { initialCanvasContent: null, onlyRenderComposition: null, currentCompositionMetadata: null, initialCompositions: [] },
      h(Root),
    ),
  );
  for (let i = 0; i < 400; i++) {
    const found = Internals.compositionsRef.current?.getCompositions() ?? [];
    if (found.length) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('The Remotion project registers no <Composition>');
}

function start(Root) {
  const ref = React.createRef();
  let muted = false;
  startBridge({
    async init() {
      const all = await compositions(Root);
      const wanted = window.__TAYANG_COMPOSITION;
      const comp = (wanted && all.find((c) => c.id === wanted)) || all[0];
      if (wanted && comp.id !== wanted) {
        throw new Error(`No composition "${wanted}". This project has: ${all.map((c) => c.id).join(', ')}`);
      }
      const cfg = await Internals.resolveVideoConfig({
        calculateMetadata: comp.calculateMetadata,
        compositionDurationInFrames: comp.durationInFrames ?? null,
        compositionFps: comp.fps ?? null,
        compositionHeight: comp.height ?? null,
        compositionWidth: comp.width ?? null,
        signal: new AbortController().signal,
        inputProps: comp.defaultProps ?? {},
        defaultProps: comp.defaultProps ?? {},
        compositionId: comp.id,
      });
      const root = document.getElementById('tayang-root');
      createRoot(root).render(
        h(Player, {
          ref,
          component: comp.component,
          inputProps: cfg.props,
          durationInFrames: cfg.durationInFrames,
          fps: cfg.fps,
          compositionWidth: cfg.width,
          compositionHeight: cfg.height,
          style: { width: '100%', height: '100%' },
          clickToPlay: false,
          doubleClickToFullscreen: false,
          spaceKeyToPlayOrPause: false,
          acknowledgeRemotionLicense: true,
        }),
      );
      for (let i = 0; i < 400 && !ref.current; i++) await new Promise((r) => setTimeout(r, 10));
      if (!ref.current) throw new Error('The Remotion player did not start');
      return { fps: cfg.fps, durationInFrames: cfg.durationInFrames, width: cfg.width, height: cfg.height };
    },
    seek: (f) => ref.current.seekTo(f),
    play: () => ref.current.play(),
    pause: () => ref.current.pause(),
    setMuted: (m) => {
      muted = m;
      if (muted) ref.current.mute();
      else ref.current.unmute();
    },
    frame: () => ref.current?.getCurrentFrame() ?? 0,
    playing: () => !!ref.current?.isPlaying(),
  });
}

if (window.__TAYANG_PREVIEW) {
  Internals.waitForRoot((Root) => {
    try {
      start(Root);
    } catch (err) {
      reportError(err?.message ?? err);
    }
  });
}
