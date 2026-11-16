// Remotion: bundles the project with its own @remotion/bundler (the version that renders it) plus the
// harness entry, and captures stills with its own @remotion/renderer from that same bundle.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { previewConfig, remotionEntry } from './project.mjs';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness', 'remotion-entry.js');

export const NEEDS_PACKAGES = "Live preview needs the project's packages installed";

/** The project's Remotion packages, resolved the way its own `npx remotion` resolves them. */
export function remotionPackages(folder) {
  let cli;
  try {
    cli = createRequire(path.join(folder, 'package.json')).resolve('@remotion/cli/package.json');
  } catch {
    throw new Error(NEEDS_PACKAGES);
  }
  const req = createRequire(cli);
  const resolve = (name) => {
    try {
      return req.resolve(name);
    } catch {
      throw new Error(NEEDS_PACKAGES);
    }
  };
  return {
    bundler: resolve('@remotion/bundler'),
    renderer: resolve('@remotion/renderer'),
    playerDir: path.dirname(resolve('@remotion/player/package.json')),
  };
}

const load = async (file) => {
  const mod = await import(pathToFileURL(file).href);
  return mod.default && !mod.bundle && !mod.renderStill ? mod.default : mod;
};

export function remotionEngine(folder, { workDir, log = () => {} }) {
  const entry = remotionEntry(folder);
  if (!entry) throw new Error('Found no Remotion entry point (src/index.ts). Set "preview": {"entry": …} in tayang.json');
  const packages = remotionPackages(folder);
  const { composition } = previewConfig(folder);
  let built = null; // the bundle folder being served
  let building = null;
  let again = false;
  let generation = 0;
  let browser = null;
  let lastError = null;

  async function bundleOnce() {
    const { bundle } = await load(packages.bundler);
    const outDir = path.join(workDir, `bundle-${++generation}`);
    const started = Date.now();
    await bundle({
      entryPoint: entry,
      outDir,
      publicDir: path.join(folder, 'public'),
      webpackOverride: (c) => ({
        ...c,
        entry: [...(Array.isArray(c.entry) ? c.entry : [c.entry]), HARNESS],
        resolve: {
          ...c.resolve,
          alias: { ...(c.resolve?.alias ?? {}), '@remotion/player': packages.playerDir },
          // The project's node_modules first: one React and one remotion, the project's.
          modules: [path.join(folder, 'node_modules'), 'node_modules'],
        },
      }),
    });
    log(`bundled in ${Date.now() - started} ms`);
    const old = built;
    built = outDir;
    if (old) fs.rm(old, { recursive: true, force: true }, () => {});
  }

  /** Bundles now, or once more after the running bundle when files changed meanwhile. */
  function rebuild() {
    if (building) {
      again = true;
      return building;
    }
    building = (async () => {
      do {
        again = false;
        try {
          await bundleOnce();
          lastError = null;
        } catch (err) {
          lastError = String(err?.message ?? err).split('\n').slice(0, 12).join('\n');
        }
      } while (again);
      building = null;
    })();
    return building;
  }

  function injected(html) {
    const flags = `<script>window.__TAYANG_PREVIEW=true;window.remotion_puppeteerTimeout=30000;window.__TAYANG_COMPOSITION=${JSON.stringify(composition ?? null)};</script>`;
    const root = '<style>html,body{margin:0;background:#000;overflow:hidden}#video-container{display:none}</style><div id="tayang-root" style="position:fixed;inset:0"></div>';
    return html.replace(/<body([^>]*)>/i, (m) => `${m}${flags}${root}`);
  }

  return {
    engine: 'remotion',
    get error() {
      return lastError;
    },
    get ready() {
      return !!built;
    },
    start: () => rebuild(),
    changed: () => rebuild(),
    /** The harness page (the bundle's index.html, flagged for the preview), or null while the first bundle runs. */
    harnessHtml() {
      if (!built) return null;
      return injected(fs.readFileSync(path.join(built, 'index.html'), 'utf8'));
    },
    /** Folder the page's own files (bundle.js, public/) come from. */
    assetRoot: () => built,
    async still(frame, output) {
      if (building) await building;
      if (!built) throw new Error(lastError ?? 'The preview is not ready yet');
      const R = await load(packages.renderer);
      browser ??= await R.openBrowser('chrome', { logLevel: 'error' });
      const serveUrl = built;
      const id = composition ?? (await R.getCompositions(serveUrl, { puppeteerInstance: browser, logLevel: 'error' }))[0]?.id;
      if (!id) throw new Error('The Remotion project registers no <Composition>');
      const comp = await R.selectComposition({ serveUrl, id, puppeteerInstance: browser, logLevel: 'error' });
      await R.renderStill({ composition: comp, serveUrl, output, frame, puppeteerInstance: browser, logLevel: 'error', overwrite: true });
      return output;
    },
    async close() {
      await browser?.close?.({ silent: true }).catch?.(() => {});
    },
  };
}
