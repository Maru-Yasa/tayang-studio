// HyperFrames: the project is static HTML; the vendored <hyperframes-player> plays it, and stills come
// from `hyperframes snapshot` at the same pinned version Tayang renders with.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hyperframesPage } from './project.mjs';

export const HYPERFRAMES = 'hyperframes@0.9.10';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'harness', 'hyperframes.html');

/** npx next to the Node running this server: the user's own, found the way their terminal finds it. */
export function npxPath(nodePath = process.execPath, platform = process.platform) {
  const dir = path.dirname(nodePath);
  return platform === 'win32' ? path.join(dir, 'npx.cmd') : path.join(dir, 'npx');
}

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim().split('\n').slice(-6).join('\n') || `exited with ${code}`));
    });
  });
}

export function hyperframesEngine(folder, { workDir }) {
  const page = hyperframesPage(folder);
  if (!page) throw new Error('Found no index.html for HyperFrames');
  return {
    engine: 'hyperframes',
    error: null,
    ready: true,
    start: async () => {},
    changed: async () => {},
    harnessHtml() {
      // fps is re-read on every load: the agent may change it.
      const { page: p, fps } = hyperframesPage(folder) ?? page;
      return fs
        .readFileSync(TEMPLATE, 'utf8')
        .replace('__COMPOSITION__', encodeURI(p))
        .replace('__FPS__', String(fps));
    },
    assetRoot: () => folder,
    async still(frame, output) {
      const { fps } = hyperframesPage(folder) ?? page;
      const dir = fs.mkdtempSync(path.join(workDir, 'still-'));
      try {
        const at = (frame / fps).toFixed(4);
        await run(npxPath(), ['-y', HYPERFRAMES, 'snapshot', '.', '--at', at, '--no-end', '--output', dir], folder, 180_000);
        const png = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.png'));
        if (!png) throw new Error('hyperframes snapshot wrote no picture');
        fs.copyFileSync(path.join(dir, png), output);
        return output;
      } finally {
        fs.rm(dir, { recursive: true, force: true }, () => {});
      }
    },
    async close() {},
  };
}

/** What a composition page's `<audio data-start>` becomes in the live preview. */
export const HIDDEN_START = 'data-tayang-start';

/**
 * A composition page as the live preview serves it: each `<audio data-start>` renamed to
 * `<audio data-tayang-start>`, so `<hyperframes-player>` leaves the sound alone and only the harness
 * plays it (harness/audio-mirror.js). The player makes its own copy of every `audio[data-start]` and
 * seeks it each time the picture is drawn; with the same file in both, that kept stalling the sound.
 * The file on disk, which the renderer reads, is unchanged. `<video>` stays the player's: it shows.
 */
export function hideAudioFromPlayer(html) {
  return html.replace(/<audio\b[^>]*>/gi, (tag) => tag.replace(/(\s)data-start(\s*=)/gi, `$1${HIDDEN_START}$2`));
}
