import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseArgs, startServer } from '../src/server.mjs';
import { confined, ignoredChange } from '../src/files.mjs';
import { hyperframesPage, previewConfig, remotionEntry } from '../src/project.mjs';
import { NEEDS_PACKAGES, remotionPackages } from '../src/remotion.mjs';
import { hideAudioFromPlayer, npxPath } from '../src/hyperframes.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tayang-preview-test-')));
const write = (dir, rel, body = '') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

function request(port, { method = 'GET', pathname, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('parseArgs needs a project and a known engine', () => {
  assert.deepEqual(parseArgs(['--project', '/p', '--engine', 'remotion']), { project: '/p', engine: 'remotion' });
  assert.throws(() => parseArgs(['--engine', 'remotion']), /--project/);
  assert.throws(() => parseArgs(['--project', '/p', '--engine', 'flash']), /--engine/);
});

test('confined serves files inside the root only', () => {
  const root = tmp();
  const outside = tmp();
  write(root, 'a/b.txt', 'x');
  write(outside, 'secret.txt', 's');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  assert.equal(confined(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.equal(confined(root, 'a%2Fb.txt'), path.join(root, 'a', 'b.txt'));
  assert.equal(confined(root, '../' + path.basename(outside) + '/secret.txt'), null);
  assert.equal(confined(root, '%2e%2e/x'), null);
  assert.equal(confined(root, 'link.txt'), null);
  assert.equal(confined(root, 'a'), null);
  assert.equal(confined(root, 'missing.txt'), null);
  assert.equal(confined(root, 'bad%zz'), null);
});

test('renders, dependencies, hidden folders and videos never reload the preview', () => {
  for (const p of ['renders/x.mp4', 'node_modules/a/b.js', '.git/HEAD', 'src/.cache/x', 'out/a.png', 'clip.mov', 'render.log']) {
    assert.equal(ignoredChange(p), true, p);
  }
  for (const p of ['index.html', 'src/Root.tsx', 'compositions/intro.html', 'public/logo.png']) {
    assert.equal(ignoredChange(p), false, p);
  }
});

test('tayang.json preview block', () => {
  const dir = tmp();
  assert.deepEqual(previewConfig(dir), {});
  write(dir, 'tayang.json', JSON.stringify({ render: ['npm'], preview: { entry: 'src/main.ts', composition: ' Main ' } }));
  assert.deepEqual(previewConfig(dir), { entry: 'src/main.ts', composition: 'Main' });
  write(dir, 'tayang.json', '{ not json');
  assert.deepEqual(previewConfig(dir), {});
});

test('remotionEntry: tayang.json, then remotion.config, then src/index', () => {
  const dir = tmp();
  assert.equal(remotionEntry(dir), null);
  write(dir, 'src/index.tsx');
  assert.equal(remotionEntry(dir), path.join(dir, 'src', 'index.tsx'));
  write(dir, 'src/index.ts');
  assert.equal(remotionEntry(dir), path.join(dir, 'src', 'index.ts'));
  write(dir, 'video/entry.ts');
  write(dir, 'remotion.config.ts', "Config.setEntryPoint('./video/entry.ts');");
  assert.equal(remotionEntry(dir), path.join(dir, 'video', 'entry.ts'));
  write(dir, 'other.ts');
  write(dir, 'tayang.json', JSON.stringify({ preview: { entry: 'other.ts' } }));
  assert.equal(remotionEntry(dir), path.join(dir, 'other.ts'));
  // An entry outside the project is not used.
  write(dir, 'tayang.json', JSON.stringify({ preview: { entry: '../../etc/hosts' } }));
  assert.equal(remotionEntry(dir), path.join(dir, 'video', 'entry.ts'));
});

test('hyperframesPage reads data-fps, else 30', () => {
  const dir = tmp();
  assert.equal(hyperframesPage(dir), null);
  write(dir, 'index.html', '<div data-composition-id="main"></div>');
  assert.deepEqual(hyperframesPage(dir), { page: 'index.html', fps: 30 });
  write(dir, 'index.html', '<div data-composition-id="main" data-fps="60"></div>');
  assert.equal(hyperframesPage(dir).fps, 60);
  write(dir, 'index.html', '<div data-fps="30000/1001"></div>');
  assert.ok(Math.abs(hyperframesPage(dir).fps - 29.97) < 0.01);
  write(dir, 'index.html', '<div data-fps="999"></div>');
  assert.equal(hyperframesPage(dir).fps, 30);
});

test('a Remotion project without its packages asks for them', () => {
  assert.throws(() => remotionPackages(tmp()), new RegExp(NEEDS_PACKAGES));
});

test('only <audio> data-start is hidden from the player; video and the rest stay', () => {
  assert.equal(
    hideAudioFromPlayer('<AUDIO class=x data-start = "1" data-duration="2"><video data-start="3"></video><div data-start="4">'),
    '<AUDIO class=x data-tayang-start = "1" data-duration="2"><video data-start="3"></video><div data-start="4">',
  );
  assert.equal(hideAudioFromPlayer('<audio data-start-x="1" data-started="2">'), '<audio data-start-x="1" data-started="2">');
});

test('npx is found next to node', () => {
  assert.equal(npxPath('/usr/local/bin/node', 'darwin'), '/usr/local/bin/npx');
  assert.equal(npxPath('C:\\node\\node.exe', 'win32').endsWith('npx.cmd'), true);
});

function fakeEngine(folder, calls) {
  return () => ({
    engine: 'hyperframes',
    error: null,
    ready: true,
    start: async () => {},
    changed: async () => calls.push('changed'),
    harnessHtml: () => '<html>harness</html>',
    assetRoot: () => folder,
    still: async (frame, out) => {
      calls.push(['still', frame]);
      fs.writeFileSync(out, 'png');
      return out;
    },
    close: async () => calls.push('close'),
  });
}

test('the server needs the token, a loopback Host and the control header for stills', async () => {
  const folder = tmp();
  write(folder, 'index.html', 'page');
  write(folder, 'compositions/a.html', '<audio id="vo" data-start="0" src="v.mp3"></audio>comp');
  const calls = [];
  const s = await startServer({ project: folder, engine: 'hyperframes' }, { makeEngine: fakeEngine(folder, calls) });
  const host = { Host: `127.0.0.1:${s.port}` };
  try {
    assert.equal((await request(s.port, { pathname: '/nope/', headers: host })).status, 404);
    assert.equal((await request(s.port, { pathname: `/${s.token}/`, headers: { Host: 'evil.example' } })).status, 403);
    const page = await request(s.port, { pathname: `/${s.token}/`, headers: host });
    assert.equal(page.status, 200);
    assert.equal(page.body, '<html>harness</html>');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(
      (await request(s.port, { pathname: `/${s.token}/p/compositions/a.html`, headers: host })).body,
      '<audio id="vo" data-tayang-start="0" src="v.mp3"></audio>comp',
      "a page's sound is hidden from the player",
    );
    assert.equal((await request(s.port, { pathname: `/${s.token}/p/../../etc/passwd`, headers: host })).status, 404);
    assert.equal((await request(s.port, { pathname: `/${s.token}/compositions/a.html`, headers: host })).status, 404);
    const bridge = await request(s.port, { pathname: `/${s.token}/__tayang/bridge.js`, headers: host });
    assert.match(bridge.body, /export function startBridge/);
    assert.match(bridge.headers['content-type'], /javascript/);

    const out = path.join(tmp(), 'f.png');
    const still = `/${s.token}/still?frame=12&out=${encodeURIComponent(out)}`;
    assert.equal((await request(s.port, { method: 'POST', pathname: still, headers: host })).status, 403);
    assert.equal((await request(s.port, { method: 'POST', pathname: still, headers: { ...host, 'x-tayang-control': s.token } })).status, 403);
    const ok = await request(s.port, { method: 'POST', pathname: still, headers: { ...host, 'x-tayang-control': s.control } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { path: out });
    assert.deepEqual(calls.at(-1), ['still', 12]);
    const bad = `/${s.token}/still?frame=-1&out=${encodeURIComponent(out)}`;
    assert.equal((await request(s.port, { method: 'POST', pathname: bad, headers: { ...host, 'x-tayang-control': s.control } })).status, 400);
    const relative = `/${s.token}/still?frame=1&out=f.png`;
    assert.equal((await request(s.port, { method: 'POST', pathname: relative, headers: { ...host, 'x-tayang-control': s.control } })).status, 400);
  } finally {
    await s.close();
  }
  assert.ok(calls.includes('close'));
});

test('a project the engine cannot open serves a page that reports why', async () => {
  const folder = tmp();
  const s = await startServer(
    { project: folder, engine: 'remotion' },
    {
      makeEngine: () => {
        throw new Error(NEEDS_PACKAGES);
      },
    },
  );
  try {
    const page = await request(s.port, { pathname: `/${s.token}/`, headers: { Host: `127.0.0.1:${s.port}` } });
    assert.equal(page.status, 200);
    assert.match(page.body, /type: 'error'/);
    assert.match(page.body, /packages installed/);
  } finally {
    await s.close();
  }
});
