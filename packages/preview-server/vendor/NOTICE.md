# Vendored files

- `hyperframes-player.global.js`: the `<hyperframes-player>` web component from the
  [`hyperframes`](https://github.com/heygen-com/hyperframes) npm package, version **0.9.10**
  (`dist/hyperframes-player.global.js`), unchanged. Licensed under the Apache License 2.0
  (https://www.apache.org/licenses/LICENSE-2.0). Keep the version equal to the one Tayang renders with
  (`hyperframes@0.9.10` in `apps/desktop/src-tauri/src/media.rs`).
- `hyperframe.runtime.iife.js`: the HyperFrames runtime from the same package and version
  (`dist/hyperframe.runtime.iife.js`, also published as `@hyperframes/core`), unchanged, Apache License 2.0.
  The preview server loads it into every composition page, as `hyperframes preview` does: it plays the
  composition's audio and video. Without it the picture moves but there is no sound.
