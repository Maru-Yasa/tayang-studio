/** What a render returns when the project has nothing to render yet (Rust's `media::NOTHING_TO_RENDER`). */
export const NOTHING_TO_RENDER = 'nothing to render yet';

/** Causes, checked in order; the first that matches names the failure. */
const KINDS: [string, RegExp][] = [
  ['no-composition', /No composition found|No index\.html file found/],
  ['no-browser', /No browser found for rendering frames/],
  ['no-mp4', /^render finished but no mp4 was found/],
  ['initial-timeout', /exceeded rendering the component initially/],
  ['delay-render-timeout', /delayRender\(\)/],
  ['webgl', /WebGL|Shader Error/],
  ['browser-crashed', /browser crashed/],
  ['browser-launch', /Failed to launch the browser|connect to the browser|chrome-headless-shell/],
  ['bad-manifest', /^tayang\.json /],
  ['ffmpeg-missing', /FFmpeg not found|FFprobe not found/],
  ['version-mismatch', /Version mismatch/],
  ['install-failed', /^template install failed/],
  ['no-output', /^[\w ]+ failed:\s*$/],
  ['template-other', /^template render failed/],
  ['hyperframes-other', /^hyperframes render failed/],
];

/**
 * A short name for why a render failed. Every render error is reported from the same place, so without it
 * error tracking lumps unrelated failures into one issue; this name is the issue's fingerprint.
 */
export function renderErrorKind(message: string): string {
  return KINDS.find(([, re]) => re.test(message))?.[0] ?? 'other';
}
