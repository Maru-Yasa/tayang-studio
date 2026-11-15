# Live preview without rendering: design

Status: built on `feat/live-preview`, 2026-11-15. Sections marked **(as built)** changed from the draft.

Lines marked **(my call)** were decided by Claude while designing and are open to change. Everything else was decided by the owner.

## Why

A render in Tayang currently takes 50 minutes to 2 hours. The Preview panel only plays the latest MP4 in `renders/`, so the user finds out something is wrong only after that wait. The user needs to see the video and mark the frames that need a revision before anything is rendered. Rendering becomes the last step instead of the way to look at the work.

## Goals

- The Preview panel plays the project straight from its code, with no render, for both engines Tayang uses: HyperFrames and Remotion.
- One shared abstraction: the panel, scrubber, frame stepping and "send frame" do not know which engine is behind them. A third engine would be one more harness, not a change to the panel.
- The user can pause on any frame, step frame by frame, and send that frame to the chat for a revision, before any render exists.
- When the agent changes a file, the preview reloads and stays on the same frame.

## Non-goals

- No new UI for now (owner). The panel, scrubber, buttons and "send frame" stay as they are; only the picture's source changes, plus one small label (Live / Render). **(my call: the label and a way back to the MP4)**
- Not making renders faster. Encoder and worker settings (`--gpu`, `--workers`) are a separate piece of work.
- No partial re-render.
- No embedding of the engines' own studios (`remotion studio`, `hyperframes preview`).

## Anti-goals

- The live picture looks different from what the render will produce, so the user approves something the render then changes. A paused frame and a sent frame must match the render.
- Project code running in the preview can reach Tayang's IPC (files, commands, billing).
- The preview breaks for a project that worked before: if live preview cannot start, the panel still plays the MP4 as it does today.

## Constraints (found in the code)

- `apps/desktop/src/screens/preview/Preview.tsx` plays a `<video>` of `mediaLatestRender`; length, fps and size come from `mediaProbe` (ffprobe on that MP4). Without an MP4 it shows "nothing yet" and a Render button.
- "Send frame" (`mediaExtractFrame`, `commands.rs:2079`) cuts the frame out of the MP4 with ffmpeg.
- The engine is recorded on the style (`styles.engine`, `'remotion' | 'hyperframes'`); template projects describe themselves in `tayang.json` (`render`, `install`, `engine`, `readme`).
- HyperFrames projects are static HTML (`index.html` with a GSAP timeline). Remotion projects are React/TSX and must be bundled before `@remotion/player` can play them; the entry file and composition id are not stored anywhere today (the agent types them into `npx remotion render <entry> <composition>`).
- Tayang already finds the user's Node the way their terminal does (`system.rs` `Exec::which`); `npx` / Node is a requirement for both engines anyway.
- The Tauri CSP has no `frame-src`, so an iframe cannot load today.
- Other agent sessions may change project files at any time (the agent edits while the user watches).

## Approaches

**A. A Tayang preview server per project, one protocol for both engines (chosen by the owner).** A small Node script that ships with Tayang serves a harness page on `127.0.0.1:<random port>`. HyperFrames: the project folder is served and played with `<hyperframes-player>`. Remotion: the user's composition is bundled in watch mode with the project's own `remotion` from its `node_modules` (so the preview uses the same version as the render) and played with `<Player>`. The panel loads the harness in an iframe and talks to it through `postMessage` with the same messages for both engines; on the React side one adapter behaves like `<video>`, so `Preview.tsx` barely changes. Trade-off: one more Node process to start and stop; the first Remotion bundle takes a few seconds.

**B. The same harnesses, but HyperFrames served by Rust (Tauri custom protocol) and only Remotion through Node.** No extra process for HyperFrames, but two hosting mechanisms and two reload paths: a thinner abstraction than the owner asked for.

**C. Iframe the engines' own studios.** Quickest to build, but the studio UI comes with it (against "no new UI") and Tayang's scrubber cannot drive it. Dropped.

Also dropped: low-resolution draft renders in place of a preview. Still minutes of waiting; does not answer the problem.

## Design

### Parts

1. **Preview server** (`packages/preview-server`, plain Node ESM, no build step **(my call)**), bundled as a Tauri resource like `agent-plugin`. Started by Rust with the user's Node, one per open project, bound to `127.0.0.1` on a random port, printing one JSON ready line (`{port, token, engine}`) on stdout. Every request needs the token (query or cookie) so other local pages cannot read project files. **(my call)**
2. **Engine harnesses**, one page each, inside the server:
   - `hyperframes`: serves the project folder read-only and a harness page that loads `hyperframes-player.global.js` from the project's or npx's pinned `hyperframes@0.9.10` (the same version `media.rs` renders with) and points it at the project's `index.html` (or `tayang.json`'s composition).
   - `remotion`: generates an entry that imports the project's root, bundles it with the project's `@remotion/bundler` in watch mode, and mounts `@remotion/player`'s `<Player>` with the chosen composition's `component`, `durationInFrames`, `fps`, `width`, `height` and `inputProps`.
3. **Protocol** (`packages/shared`, typed), the only contract between panel and harness:
   - panel → harness: `seek {frame}`, `play`, `pause`, `setMuted {muted}`, `setRate {rate}`.
   - harness → panel: `ready {fps, durationInFrames, width, height}`, `frame {frame}` (while playing, throttled), `paused {frame}`, `ended`, `reloading`, `reloaded`, `error {message}`.
   - Every message carries a protocol version; the panel accepts messages only from the harness iframe's origin.
4. **`useLiveSource` adapter** in the desktop app: wraps the iframe and the protocol and exposes what `Preview.tsx` uses from `<video>` today (current frame, play/pause, seek, playing, ended, duration, fps, size). `Preview.tsx` picks the live source or the MP4 source; the rest of the panel is unchanged.
5. **Rust lifecycle** (`preview.rs`, new): `preview_start(project_id)` → `{url}` (starts or reuses the server for that project), `preview_stop(project_id)`; servers are stopped when the project closes, after a few minutes without a panel, and on app exit. The process tree is killed on stop (Remotion's bundler spawns children).
6. **Live frame capture for "send frame"**: when the live source is active, `mediaExtractFrame` gains a live path that runs the engine's still command at that frame (`npx remotion still <entry> <composition> --frame=N`, HyperFrames' snapshot command) into the same place the MP4 path writes, so the chat attachment is unchanged. Takes a few seconds but matches the render exactly. **(my call: not a screenshot of the iframe, which could differ from the render)**

### Engine and composition detection

In order, first match wins **(my call)**:
1. `tayang.json` gains an optional `preview` block: `{ "engine": "remotion" | "hyperframes", "entry": "src/index.ts", "composition": "Main" }`.
2. The project's style engine.
3. The files: `remotion` in `package.json` dependencies → Remotion; an `index.html` using HyperFrames (`data-composition` / the HyperFrames runtime) → HyperFrames.

Remotion entry and composition without `tayang.json`: the entry from `remotion.config.*` (`setEntryPoint`) or the default `src/index.{ts,tsx,js,jsx}`; the composition is the first one registered. **(as built)** The agent is not asked to write a `preview` block: `render_plan` requires `render` in any `tayang.json`, so a file with only `preview` would break rendering. Instead the Remotion prompt (`packages/skills/src/project.ts`) asks for a local `@remotion/cli`, the entry at `src/index.ts`, and the rendered composition registered first. Rust also reads `hyperframes.json` as a HyperFrames marker; the style's engine is not consulted (the files are enough once the agent has built anything).

### Behaviour

- **Which source plays:** live when the project has code the preview can play and either there is no MP4 or the code changed after the newest MP4; the MP4 otherwise. The label shows which one plays and switches to the other. **(my call)**
- **Clock:** playback runs at normal speed and skips frames it cannot draw in time (both players' default); a paused or stepped frame is always drawn exactly. **(my call: the owner did not pick; this keeps playback watchable on heavy scenes)**
- **Reload:** the HyperFrames harness watches the project folder (ignoring `renders/`, `node_modules/`, `.git/`, hidden folders) and reloads the composition; Remotion's bundler watch does the same. After a reload the harness seeks back to the frame it was on and sends `reloaded`.
- **Length, fps, size** come from `ready`, not from ffprobe, when live.
- **Dependencies missing:** opening the preview never installs anything (installs always ask, and the agent normally installs while it builds). A Remotion project without `node_modules` shows the MP4 if there is one and the line "Live preview needs the project's packages installed"; HyperFrames needs none. **(my call)**
- **"Code changed after the newest MP4":** the newest modification time of the project's files (with the same ignore list as reload) is later than the newest MP4's. **(my call)**
- **Projects that are neither engine** (a template with its own toolchain in `tayang.json`): no live preview; the panel behaves as today. **(my call)**
- **Failure:** any start or harness error shows the existing MP4 (if any) and the error text in the panel's existing error line. Live preview never blocks rendering.

### Security

- The iframe origin (`http://127.0.0.1:<port>`) differs from Tauri's, so project code cannot call Tauri IPC. The iframe uses `sandbox="allow-scripts allow-same-origin"` (needed by both players to load their own assets) and no `allow-top-navigation` / `allow-popups`.
- CSP: add `frame-src http://127.0.0.1:*` only; nothing else is widened.
- The server serves only files inside the project folder (and the harness's own assets) and refuses paths that leave it.

## Testing

- Protocol and `useLiveSource`: unit tests with a fake iframe window (as VideoHub tests its live source), covering seek while loading, reload keeping the frame, and messages from a foreign origin being ignored.
- Server: tests for token, path confinement, ready line, and engine detection on fixture folders.
- One fixture project per engine, and a check that a still captured live equals the same frame from a render (pixel compare with a small tolerance).
- `Preview.tsx`: existing tests keep passing with the MP4 source; new ones for choosing the source and the label.

## How it was built **(as built)**

- `packages/shared/src/preview.ts`: protocol v1 (`previewEventOf`, `previewCommand`).
- `packages/preview-server`: `src/server.mjs` (HTTP, token in the path, Host check, `x-tayang-control` for stills, SSE `reload`/`fail`, exits when stdin closes), `src/remotion.mjs`, `src/hyperframes.mjs`, `src/files.mjs`, `src/project.mjs`; `harness/bridge.js` (shared by both engines), `harness/remotion-entry.js`, `harness/hyperframes.html`; `vendor/hyperframes-player.global.js` (0.9.10, Apache-2.0, see `vendor/NOTICE.md`).
- Remotion: the project's `@remotion/cli` brings `@remotion/bundler` and `@remotion/player` at its own version, so nothing is installed. The harness entry is appended after Remotion's render entry in the same bundle; it reads compositions through `Internals.CompositionManagerProvider` / `compositionsRef` / `resolveVideoConfig` (the same internals Remotion's render entry uses) and mounts `<Player>`. Stills use the project's `@remotion/renderer` (`renderStill`) on that same bundle with one browser kept open. A change rebuilds the bundle (webpack cache) and reloads the page on the same frame.
- HyperFrames: `<hyperframes-player>` plays the project's `index.html` directly; stills run `npx -y hyperframes@0.9.10 snapshot . --at <t> --no-end`.
- Rust `preview.rs`: `detect_engine`, `code_newer_than`, `PreviewServers` (start/reuse/stop/stop_all/still); commands `preview_status`, `preview_start`, `preview_stop`, `preview_still`. Resources ship `preview-server/{src,harness,vendor}`.
- Desktop: `lib/liveSource.ts` and `Preview.tsx`; the panel re-checks `preview_status` every 4 s while it is not live.

Verified on fixtures (headless Chrome, outside the app): both engines report `ready`, seek, play/pause, keep the frame across a file change, and produce exact stills. Not yet verified inside the Tauri webview (iframe from `tauri://` to `http://127.0.0.1`, sound autoplay in WKWebView/WebView2).

## Left to the builder

- Frame-message throttling, idle timeout length, and the exact file-watch ignore list.
