// What the preview needs to know about a project folder, read from its files.
import fs from 'node:fs';
import path from 'node:path';

/** The `preview` block of tayang.json: { engine?, entry?, composition? } (all optional). */
export function previewConfig(folder) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(folder, 'tayang.json'), 'utf8'));
    const p = json && typeof json.preview === 'object' && json.preview ? json.preview : {};
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return { entry: str(p.entry), composition: str(p.composition) };
  } catch {
    return {};
  }
}

/** Remotion's entry point: tayang.json, then remotion.config's setEntryPoint(), then src/index.{ts,tsx,js,jsx}. */
export function remotionEntry(folder) {
  const inside = (rel) => {
    const abs = path.resolve(folder, rel);
    return abs.startsWith(path.resolve(folder) + path.sep) && fs.existsSync(abs) ? abs : null;
  };
  const fromJson = previewConfig(folder).entry;
  if (fromJson) {
    const abs = inside(fromJson);
    if (abs) return abs;
  }
  for (const name of ['remotion.config.ts', 'remotion.config.js', 'remotion.config.mjs']) {
    let src;
    try {
      src = fs.readFileSync(path.join(folder, name), 'utf8');
    } catch {
      continue;
    }
    const m = src.match(/setEntryPoint\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    const abs = m && inside(m[1]);
    if (abs) return abs;
  }
  for (const ext of ['ts', 'tsx', 'js', 'jsx']) {
    const abs = inside(`src/index.${ext}`);
    if (abs) return abs;
  }
  return null;
}

/** The HyperFrames page and its frame rate: the root element's data-fps, else 30 (HyperFrames' default). */
export function hyperframesPage(folder) {
  const page = 'index.html';
  let html = '';
  try {
    html = fs.readFileSync(path.join(folder, page), 'utf8');
  } catch {
    return null;
  }
  const m = html.match(/\bdata-fps\s*=\s*["']?(\d+(?:\.\d+)?(?:\/\d+)?)/);
  let fps = 30;
  if (m) {
    const [a, b] = m[1].split('/').map(Number);
    const v = b ? a / b : a;
    if (v > 0 && v <= 240) fps = v;
  }
  return { page, fps };
}
