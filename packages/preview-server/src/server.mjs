#!/usr/bin/env node
// Tayang's live preview server: one per open project, started by the desktop app with the user's Node.
//
//   node server.mjs --project <folder> --engine hyperframes|remotion [--work <tmp folder>]
//
// Listens on 127.0.0.1 (random port) and prints one line on stdout when it listens:
//   {"ready":true,"port":…,"token":"…","control":"…"}
// Every URL starts with /<token>/ (the page token: other local pages can't guess it):
//   /<token>/            the harness page (the Preview panel's iframe)
//   /<token>/events      server-sent events: `reload` after a change is ready, `fail` with an error
//   /<token>/__tayang/…  the bridge, the HyperFrames sound and the vendored HyperFrames player
//   /<token>/p/…         HyperFrames: the project's files; Remotion: the bundle's files at /<token>/…
//   POST /<token>/still?frame=N&out=<png path>  with header x-tayang-control: <control>
//                        captures frame N exactly as a render would and writes it to `out`
// Logs go to stderr. It exits when its stdin closes (the app quit or stopped it).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { confined, sendFile, watchProject } from './files.mjs';
import { remotionEngine } from './remotion.mjs';
import { hyperframesEngine } from './hyperframes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '..', 'harness', 'bridge.js');
const AUDIO = path.join(HERE, '..', 'harness', 'audio-mirror.js');
const PLAYER = path.join(HERE, '..', 'vendor', 'hyperframes-player.global.js');

const log = (...a) => console.error('[preview]', ...a);

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(project|engine|work)$/.exec(argv[i]);
    if (m && argv[i + 1] !== undefined) out[m[1]] = argv[++i];
  }
  if (!out.project) throw new Error('--project is required');
  if (out.engine !== 'hyperframes' && out.engine !== 'remotion') throw new Error('--engine must be hyperframes or remotion');
  return out;
}

const WAITING = (message) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#000}</style></head><body>
<script>
const post = (m) => parent.postMessage(Object.assign({ tayangPreview: 1 }, m), '*');
${message ? `post({ type: 'error', message: ${JSON.stringify(message)} });` : ''}
const events = new EventSource('events');
events.addEventListener('reload', () => location.reload());
events.addEventListener('fail', (e) => post({ type: 'error', message: e.data }));
</script></body></html>`;

export async function startServer({ project, engine: engineName, work }, { makeEngine } = {}) {
  const folder = fs.realpathSync(project);
  const workDir = work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tayang-preview-'));
  fs.mkdirSync(workDir, { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const control = crypto.randomBytes(16).toString('hex');
  const make = makeEngine ?? ((name, f, opts) => (name === 'remotion' ? remotionEngine(f, opts) : hyperframesEngine(f, opts)));

  let engine = null;
  let setupError = null;
  try {
    engine = make(engineName, folder, { workDir, log });
  } catch (err) {
    setupError = String(err?.message ?? err);
  }

  const clients = new Set();
  const broadcast = (event, data = '1') => {
    const payload = `event: ${event}\ndata: ${String(data).replace(/\n/g, '\ndata: ')}\n\n`;
    for (const res of clients) res.write(payload);
  };
  let port = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const prefix = `/${token}/`;
      if (!url.pathname.startsWith(prefix) && url.pathname !== `/${token}`) {
        res.writeHead(404).end();
        return;
      }
      const rest = url.pathname.slice(prefix.length);
      const html = (body) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
      };

      if (req.method === 'POST' && rest === 'still') {
        if (req.headers['x-tayang-control'] !== control) {
          res.writeHead(403).end();
          return;
        }
        const frame = Number(url.searchParams.get('frame'));
        const out = url.searchParams.get('out');
        res.setHeader('Content-Type', 'application/json');
        if (!engine || !Number.isInteger(frame) || frame < 0 || !out || !path.isAbsolute(out) || !out.toLowerCase().endsWith('.png')) {
          res.writeHead(400).end(JSON.stringify({ error: setupError ?? 'Bad still request' }));
          return;
        }
        try {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          await engine.still(frame, out);
          res.end(JSON.stringify({ path: out }));
        } catch (err) {
          res.writeHead(500).end(JSON.stringify({ error: String(err?.message ?? err) }));
        }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      if (rest === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': ok\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (rest === '' || rest === 'index.html') {
        if (!engine) return html(WAITING(setupError));
        const page = engine.harnessHtml();
        return html(page ?? WAITING(engine.error));
      }
      if (rest === '__tayang/bridge.js') return sendFile(req, res, BRIDGE);
      if (rest === '__tayang/audio-mirror.js') return sendFile(req, res, AUDIO);
      if (rest === '__tayang/player.js') return sendFile(req, res, PLAYER);
      if (!engine) {
        res.writeHead(404).end();
        return;
      }
      const root = engine.engine === 'hyperframes' ? (rest.startsWith('p/') ? folder : null) : engine.assetRoot();
      const rel = engine.engine === 'hyperframes' ? rest.slice(2) : rest;
      const file = root && confined(root, rel);
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      sendFile(req, res, file);
    } catch (err) {
      log('request failed', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  let stopWatching = () => {};
  if (engine) {
    const afterBuild = () => {
      if (engine.error) broadcast('fail', engine.error);
      else broadcast('reload');
    };
    Promise.resolve(engine.start()).then(() => engine.engine === 'remotion' && afterBuild());
    stopWatching = watchProject(folder, () => Promise.resolve(engine.changed()).then(afterBuild));
  }

  const close = async () => {
    stopWatching();
    for (const res of clients) res.end();
    server.close();
    await engine?.close();
    if (!work) fs.rmSync(workDir, { recursive: true, force: true });
  };
  return { port, token, control, close, folder };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let running;
  try {
    running = await startServer(parseArgs(process.argv.slice(2)));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ready: false, error: String(err?.message ?? err) }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ready: true, port: running.port, token: running.token, control: running.control }) + '\n');
  const quit = () => running.close().finally(() => process.exit(0));
  process.stdin.on('end', quit);
  process.stdin.on('close', quit);
  process.stdin.resume();
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
}
