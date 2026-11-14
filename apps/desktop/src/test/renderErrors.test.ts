import { describe, expect, it } from 'vitest';
import { NOTHING_TO_RENDER, renderErrorKind } from '@/lib/renderErrors';

describe('renderErrorKind', () => {
  it('names the cause, so each cause is its own issue', () => {
    const cases: [string, string][] = [
      ['hyperframes render failed: ✗  No composition found in ~/x\n   No index.html file found.', 'no-composition'],
      ['template render failed: TypeError: No browser found for rendering frames!', 'no-browser'],
      ['render finished but no mp4 was found. The render printed:\nok', 'no-mp4'],
      ['template render failed: Timeout (30000ms) exceeded rendering the component initially.', 'initial-timeout'],
      ['template render failed: Tried to get delayRender() handles for timeout', 'delay-render-timeout'],
      ['template render failed: THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false', 'webgl'],
      ['template render failed: Could not create a WebGL context', 'webgl'],
      ['template render failed: The browser crashed while rendering frame 2770', 'browser-crashed'],
      ['template render failed: Error: Failed to launch the browser process!', 'browser-launch'],
      ['tayang.json is not valid: invalid type', 'bad-manifest'],
      ['hyperframes render failed: ✗  FFmpeg not found', 'ffmpeg-missing'],
      ['template render failed: Version mismatch:', 'version-mismatch'],
      ['template install failed: npm error', 'install-failed'],
      ['template render failed: ', 'no-output'],
      ['template render failed: something else', 'template-other'],
      ['hyperframes render failed: something else', 'hyperframes-other'],
      ['boom', 'other'],
    ];
    for (const [message, kind] of cases) expect(renderErrorKind(message), message).toBe(kind);
  });

  it('knows the message for a project with nothing to render', () => {
    expect(NOTHING_TO_RENDER).toBe('nothing to render yet');
  });
});
