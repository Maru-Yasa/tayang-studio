import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { PREVIEW_PROTOCOL } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  assetUrl: (p: string) => p,
  latestRenderInfo: vi.fn().mockResolvedValue({ path: "/p/renders/a.mp4", name: "a.mp4", size: 1, modifiedAt: "2026-11-16T13:30:00.000Z" }),
  mediaLatestRender: vi.fn(),
  mediaProbe: vi.fn(),
  mediaThumbnails: vi.fn().mockResolvedValue([]),
  mediaExtractFrame: vi.fn().mockResolvedValue('/p/.tayang/frames/frame-0.png'),
  mediaRender: vi.fn(),
  previewStatus: vi.fn(),
  previewStart: vi.fn(),
  previewStop: vi.fn().mockResolvedValue(undefined),
  previewStill: vi.fn().mockResolvedValue('/p/.tayang/frames/frame-1000.png'),
  previewLayers: vi.fn(),
}));

import * as ipc from '@/lib/ipc';
import { Preview } from '@/screens/preview/Preview';
import { useChat } from '@/state/chat';

const URL_ = 'http://127.0.0.1:4100/tok/';
const ORIGIN = 'http://127.0.0.1:4100';
const m = vi.mocked(ipc);

function harness(data: object) {
  const iframe = screen.getByTestId('live-preview') as HTMLIFrameElement;
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { origin: ORIGIN, source: iframe.contentWindow, data: { tayangPreview: PREVIEW_PROTOCOL, ...data } }),
    );
  });
  return iframe;
}

/** The live iframe, once the panel listens to it (its effects have run). */
async function liveFrame() {
  const iframe = (await screen.findByTestId('live-preview')) as HTMLIFrameElement;
  await act(async () => {});
  return iframe;
}

const ready = (frame = 0) => harness({ type: 'ready', fps: 30, durationInFrames: 300, width: 1080, height: 1920, frame });

beforeEach(() => {
  vi.clearAllMocks();
  m.previewStart.mockResolvedValue({ url: URL_, engine: 'hyperframes' });
  m.previewStop.mockResolvedValue(undefined);
  m.mediaThumbnails.mockResolvedValue([]);
  m.previewLayers.mockResolvedValue({ voice: [], captions: [], voiceSource: null });
});

describe('Preview: live from the code', () => {
  it('plays live when there is no render yet, and speaks the protocol to the iframe', async () => {
    m.mediaLatestRender.mockResolvedValue(null);
    m.mediaProbe.mockResolvedValue(null);
    m.previewStatus.mockResolvedValue({ engine: 'hyperframes', codeNewer: true });
    render(<Preview projectId="p1" chatId="c1" />);

    const iframe = await liveFrame();
    expect(iframe.getAttribute('src')).toBe(URL_);
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(m.previewStart).toHaveBeenCalledWith('p1');
    expect(screen.getByText('Starting live preview…')).toBeInTheDocument();
    // Both sources in view: live plays, there is no render yet.
    expect(screen.getByRole('tab', { name: 'Live (code)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Render · none yet' })).toBeDisabled();
    expect(screen.queryByTestId('code-newer')).toBeNull();

    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    const attach = vi.spyOn(useChat.getState(), 'attach').mockImplementation(() => {});
    ready(30);
    expect(screen.queryByText('Starting live preview…')).not.toBeInTheDocument();
    expect(screen.getByTestId('timecode')).toHaveTextContent('/');

    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(post).toHaveBeenLastCalledWith({ tayangPreview: PREVIEW_PROTOCOL, type: 'seek', frame: 31 }, ORIGIN);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(post).toHaveBeenLastCalledWith({ tayangPreview: PREVIEW_PROTOCOL, type: 'play' }, ORIGIN);
    harness({ type: 'play' });
    harness({ type: 'frame', frame: 40 });
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    harness({ type: 'pause', frame: 41 });

    fireEvent.click(screen.getByRole('button', { name: 'Send frame to chat' }));
    await waitFor(() => expect(m.previewStill).toHaveBeenCalledWith('p1', 41, 30));
    expect(m.mediaExtractFrame).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith('c1', {
        type: 'frame',
        projectId: 'p1',
        frame: 41,
        timeSec: 41 / 30,
        imagePath: '/p/.tayang/frames/frame-1000.png',
        marks: [],
      }),
    );
  });

  it('shows the harness error under the controls', async () => {
    m.mediaLatestRender.mockResolvedValue(null);
    m.mediaProbe.mockResolvedValue(null);
    m.previewStatus.mockResolvedValue({ engine: 'remotion', codeNewer: true });
    render(<Preview projectId="p1" chatId="c1" />);
    await liveFrame();
    harness({ type: 'error', message: "Live preview needs the project's packages installed" });
    expect(screen.getByRole('alert')).toHaveTextContent("Live preview needs the project's packages installed");
  });

  it('shows the render when the code did not change after it, and switches to live and back', async () => {
    m.mediaLatestRender.mockResolvedValue('/p/renders/a.mp4');
    m.mediaProbe.mockResolvedValue({ durationSec: 10, fps: 30, frames: 300, width: 1080, height: 1920 });
    m.previewStatus.mockResolvedValue({ engine: 'hyperframes', codeNewer: false });
    const { container } = render(<Preview projectId="p1" chatId="c1" />);

    const renderTab = await screen.findByRole('tab', { name: /^Render · \d/ });
    await waitFor(() => expect(renderTab).toHaveAttribute('aria-selected', 'true'));
    expect(container.querySelector('video')).not.toBeNull();
    expect(m.previewStart).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('tab', { name: 'Live (code)' }));
    expect(await screen.findByTestId('live-preview')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Live (code)' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('tab', { name: /^Render · / }));
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    expect(m.previewStop).toHaveBeenCalledWith('p1');
  });

  it('plays live when the code changed after the render, and says so', async () => {
    m.mediaLatestRender.mockResolvedValue('/p/renders/a.mp4');
    m.mediaProbe.mockResolvedValue({ durationSec: 10, fps: 30, frames: 300, width: 1080, height: 1920 });
    m.previewStatus.mockResolvedValue({ engine: 'remotion', codeNewer: true });
    render(<Preview projectId="p1" chatId="c1" />);
    expect(await screen.findByTestId('live-preview')).toBeInTheDocument();
    expect(screen.getByTestId('code-newer')).toHaveTextContent('The code changed after the last render');
    expect(screen.getByRole('tab', { name: /^Render · / })).toBeEnabled();
  });

  it('shows no switch for a project that cannot play live', async () => {
    m.mediaLatestRender.mockResolvedValue('/p/renders/a.mp4');
    m.mediaProbe.mockResolvedValue({ durationSec: 10, fps: 30, frames: 300, width: 1080, height: 1920 });
    m.previewStatus.mockResolvedValue({ engine: null, codeNewer: false });
    const { container } = render(<Preview projectId="p1" chatId="c1" />);
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    expect(screen.queryByTestId('preview-source')).toBeNull();
  });

  it('keeps the old empty state for a project that cannot play live, and stops the server on unmount', async () => {
    m.mediaLatestRender.mockResolvedValue(null);
    m.mediaProbe.mockResolvedValue(null);
    m.previewStatus.mockResolvedValue({ engine: null, codeNewer: false });
    const { unmount } = render(<Preview projectId="p1" chatId="c1" />);
    expect(await screen.findByText('Nothing rendered yet')).toBeInTheDocument();
    unmount();

    m.previewStatus.mockResolvedValue({ engine: 'hyperframes', codeNewer: true });
    const second = render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByTestId('live-preview');
    second.unmount();
    expect(m.previewStop).toHaveBeenCalledWith('p1');
  });

  it('shows the voice and subtitle layers under the strip of the live preview', async () => {
    m.mediaLatestRender.mockResolvedValue(null);
    m.mediaProbe.mockResolvedValue(null);
    m.previewStatus.mockResolvedValue({ engine: 'hyperframes', codeNewer: true });
    m.previewLayers.mockResolvedValue({
      voice: [{ startSec: 0, durationSec: 10, peaks: [0.5, 1] }],
      captions: [{ startSec: 1, endSec: 2, text: 'Halo' }],
      voiceSource: 'layers',
    });
    render(<Preview projectId="p1" chatId="c1" />);
    const iframe = await liveFrame();
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    ready();
    expect(await screen.findByTestId('layer-voice')).toBeInTheDocument();
    expect(m.previewLayers).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Jump to this subtitle: Halo' }));
    expect(post).toHaveBeenLastCalledWith({ tayangPreview: PREVIEW_PROTOCOL, type: 'seek', frame: 30 }, ORIGIN);
  });

  it('zooms the timeline in and out from the controls', async () => {
    m.mediaLatestRender.mockResolvedValue(null);
    m.mediaProbe.mockResolvedValue(null);
    m.previewStatus.mockResolvedValue({ engine: 'hyperframes', codeNewer: true });
    render(<Preview projectId="p1" chatId="c1" />);
    await liveFrame();
    ready();
    const content = () => screen.getByTestId('scrubber-viewport').firstElementChild as HTMLElement;
    const zoomOut = screen.getByRole('button', { name: 'Zoom out of the timeline' });
    expect(zoomOut).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in on the timeline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in on the timeline' }));
    expect(content().style.width).toBe('400%');
    expect(screen.getByRole('button', { name: 'Show the whole video' })).toHaveTextContent('4×');
    fireEvent.click(zoomOut);
    expect(content().style.width).toBe('200%');
    fireEvent.click(screen.getByRole('button', { name: 'Show the whole video' }));
    expect(content().style.width).toBe('');
  });

  it('shows the new render when a render ends, even after the user picked live', async () => {
    m.mediaLatestRender.mockResolvedValue('/p/renders/a.mp4');
    m.mediaProbe.mockResolvedValue({ durationSec: 10, fps: 30, frames: 300, width: 1080, height: 1920 });
    m.previewStatus.mockResolvedValue({ engine: 'hyperframes', codeNewer: false });
    const { container, rerender } = render(<Preview projectId="p1" chatId="c1" />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Live (code)' }));
    expect(await screen.findByTestId('live-preview')).toBeInTheDocument();

    m.mediaLatestRender.mockResolvedValue('/p/renders/b.mp4');
    rerender(<Preview projectId="p1" chatId="c1" reloadKey={1} />);
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    expect(container.querySelector('video')!.getAttribute('src')).toBe('/p/renders/b.mp4');
    expect(screen.getByRole('tab', { name: /^Render · / })).toHaveAttribute('aria-selected', 'true');
  });
});
