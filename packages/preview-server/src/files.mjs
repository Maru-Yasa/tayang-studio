// Serving files from one folder only, and watching a project for changes.
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
};

export const contentType = (file) => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * The real path of `rel` inside `root`, or null when it is missing, not a file, or leaves `root`
 * (`..`, an absolute path, or a symlink pointing outside).
 */
export function confined(root, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const target = path.resolve(realRoot, '.' + path.sep + decoded);
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  try {
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Sends a file, with byte ranges (media seeking needs them) and no caching (the agent edits files). */
export function sendFile(req, res, file) {
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': contentType(file), 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && size > 0) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/** Folders whose changes never reload the preview: renders, dependencies, tool output, hidden folders. */
const IGNORED = new Set(['renders', 'node_modules', 'out', 'build', 'dist', 'snapshots']);

export function ignoredChange(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return true;
  if (parts.some((p) => p.startsWith('.'))) return true;
  if (IGNORED.has(parts[0])) return true;
  return /\.(mp4|mov|webm|log)$/i.test(rel);
}

/** Calls `onChange` once after a burst of changes (an agent writes several files) settles. */
export function watchProject(folder, onChange, { settleMs = 300 } = {}) {
  let timer = null;
  const watcher = fs.watch(folder, { recursive: true }, (_event, name) => {
    if (!name || ignoredChange(String(name))) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, settleMs);
  });
  watcher.on('error', () => {});
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
