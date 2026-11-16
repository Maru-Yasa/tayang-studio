import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

vi.mock('@/lib/ipc', () => ({
  mediaLatestRender: vi.fn(),
  mediaProbe: vi.fn(),
  mediaExtractFrame: vi.fn(),
  mediaThumbnails: vi.fn(),
  mediaRender: vi.fn(),
  assetUrl: (p: string) => `asset://${p}`,
}));

import * as ipc from '@/lib/ipc';
import { Preview, frameBox } from '@/screens/preview/Preview';
import { Scrubber, waveformPath } from '@/screens/preview/Scrubber';
import { MessageList } from '@/components/MessageList';
import { setUiLanguage } from '@/i18n';
import { useChat } from '@/state/chat';

const thumbs = Array.from({ length: 12 }, (_, i) => `/t/${i}.png`);

function setup(frame = 330, scenes?: { name: string; startSec: number; endSec: number }[]) {
  const onSeek = vi.fn();
  render(<Scrubber durationSec={34} fps={30} frame={frame} thumbnails={thumbs} onSeek={onSeek} scenes={scenes} />);
  return { onSeek, slider: screen.getByRole('slider') };
}

describe('Scrubber', () => {
  it('exposes slider semantics', () => {
    const { slider } = setup();
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '1019');
    expect(slider).toHaveAttribute('aria-valuenow', '330');
    expect(slider).toHaveAttribute('aria-valuetext', '0:11.00');
  });

  it('steps one frame with ArrowRight', async () => {
    const { slider, onSeek } = setup();
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onSeek).toHaveBeenCalledWith(331);
  });

  it('steps one second with Shift+ArrowRight', async () => {
    const { slider, onSeek } = setup();
    slider.focus();
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(onSeek).toHaveBeenCalledWith(360);
  });

  it('seeks by pointer drag', () => {
    const { slider, onSeek } = setup();
    slider.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, top: 0, height: 56, right: 1000, bottom: 56, x: 0, y: 0, toJSON() {} }) as DOMRect;
    slider.setPointerCapture = () => {};
    fireEvent.pointerDown(slider, { clientX: 500, pointerId: 1 });
    const v = onSeek.mock.calls.at(-1)![0] as number;
    expect(Math.abs(v - 510)).toBeLessThanOrEqual(1);
  });

  it('shows the scene in the tooltip when scenes are known', () => {
    setup(330, [{ name: 'Chart', startSec: 9, endSec: 17 }]);
    expect(screen.getByText('0:11.00 · Chart')).toBeInTheDocument();
  });

  it('shows only the timecode without scenes', () => {
    setup();
    expect(screen.getByText('0:11.00')).toBeInTheDocument();
  });

  it('keeps the time bubble on the playhead and inside the strip at both ends', () => {
    setup(0);
    let bubble = screen.getByTestId('scrubber-bubble');
    expect(bubble.style.left).toBe('0%');
    expect(bubble.style.transform).toBe('translateX(-0%)');
    expect(bubble.className).toMatch(/whitespace-nowrap/);
    cleanup();
    setup(1019);
    bubble = screen.getByTestId('scrubber-bubble');
    expect(bubble.style.left).toBe('100%');
    expect(bubble.style.transform).toBe('translateX(-100%)');
  });

  it('shows the hovered time while the pointer is over the strip', () => {
    const { slider, onSeek } = setup(330, [{ name: 'Chart', startSec: 0, endSec: 34 }]);
    slider.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, top: 0, height: 48, right: 1000, bottom: 48, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.pointerMove(slider, { clientX: 250, pointerId: 1 });
    expect(screen.getByTestId('scrubber-bubble')).toHaveTextContent('0:08.50 · Chart');
    expect(screen.getByTestId('scrubber-hover')).toBeInTheDocument();
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerLeave(slider, { pointerId: 1 });
    expect(screen.getByTestId('scrubber-bubble')).toHaveTextContent('0:11.00 · Chart');
    expect(screen.queryByTestId('scrubber-hover')).toBeNull();
  });
});

describe('Scrubber layers', () => {
  const layers = {
    voice: [{ startSec: 17, durationSec: 17, peaks: [0.2, 1, 0.5] }],
    captions: [
      { startSec: 10, endSec: 12, text: 'Tahun 1667' },
      { startSec: 12, endSec: 13.6, text: 'Belanda membuat' },
    ],
    voiceSource: 'hyperframes' as const,
  };
  const draw = (frame = 330, l: typeof layers | null = layers) => {
    const onSeek = vi.fn();
    render(<Scrubber durationSec={34} fps={30} frame={frame} thumbnails={thumbs} onSeek={onSeek} layers={l} />);
    return onSeek;
  };

  it('draws the voice where it sits on the film', () => {
    draw();
    const row = screen.getByRole('img', { name: 'Voice' });
    const svg = row.querySelector('svg')!;
    expect(svg.style.left).toBe('50%');
    expect(svg.style.width).toBe('50%');
    expect(svg.getAttribute('viewBox')).toBe('0 0 3 2');
  });

  it('says when the voice is the render sound', () => {
    draw(330, { ...layers, voiceSource: 'render' as never });
    expect(screen.getByRole('img', { name: "Voice: the render's sound" })).toBeInTheDocument();
  });

  it('shows each subtitle in its time, marks the one playing, and jumps to its start on click', () => {
    const onSeek = draw(330); // 11 s: inside the first subtitle
    const first = screen.getByRole('button', { name: 'Jump to this subtitle: Tahun 1667' });
    const second = screen.getByRole('button', { name: 'Jump to this subtitle: Belanda membuat' });
    expect(first.style.left).toBe(`${(10 / 34) * 100}%`);
    expect(first).toHaveAttribute('aria-current', 'true');
    expect(second).not.toHaveAttribute('aria-current');
    fireEvent.pointerDown(second, { clientX: 999, pointerId: 1 });
    fireEvent.click(second);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(360);
    expect(screen.getByTestId('scrubber-bubble')).toHaveTextContent('0:11.00 · Tahun 1667');
  });

  it('scrubs from the layer rows too', () => {
    const onSeek = draw();
    const slider = screen.getByRole('slider');
    slider.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, top: 0, height: 48, right: 1000, bottom: 48, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.pointerDown(screen.getByTestId('layer-voice'), { clientX: 250, pointerId: 1 });
    expect(onSeek).toHaveBeenCalledWith(255);
  });

  it('shows no rows without layers', () => {
    draw(330, null);
    expect(screen.queryByTestId('layer-voice')).toBeNull();
    expect(screen.queryByTestId('layer-captions')).toBeNull();
  });

  it('makes the waveform one closed mirrored shape', () => {
    expect(waveformPath([])).toBe('');
    expect(waveformPath([1, 0])).toBe('M0 1L0.5 0.000L1.5 0.960L2 1L1.5 1.040L0.5 2.000Z');
  });
});

describe('Preview layout', () => {
  beforeEach(() => {
    vi.mocked(ipc.mediaLatestRender).mockResolvedValue('/p/out.mp4');
    vi.mocked(ipc.mediaProbe).mockResolvedValue({ durationSec: 34, fps: 30, frames: 1020, width: 1080, height: 1920 });
    vi.mocked(ipc.mediaThumbnails).mockResolvedValue(thumbs);
    useChat.getState().reset();
  });

  it('is a container column: the video flexes, the controls sit under it', async () => {
    render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    const root = screen.getByTestId('preview-panel');
    expect(root.className).toMatch(/@container/);
    expect(root.className).toMatch(/flex-col/);
    const stage = screen.getByTestId('preview-stage');
    expect(stage.className).toMatch(/flex-1/);
    expect(stage).toContainElement(screen.getByTestId('preview-frame'));
    expect(screen.getByTestId('preview-controls').className).toMatch(/shrink-0/);
    expect(screen.getByTestId('preview-frame').querySelector('video')!.className).toMatch(/object-contain/);
  });

  it('puts the transport on one line: timecode in mono, the frame as a chip', async () => {
    const { container } = render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    const video = container.querySelector('video')!;
    video.currentTime = 11;
    fireEvent.timeUpdate(video);
    const row = screen.getByTestId('transport');
    expect(row.className).toMatch(/flex-nowrap/);
    expect(row.className).toMatch(/whitespace-nowrap/);
    const time = within(row).getByTestId('timecode');
    expect(time).toHaveTextContent('0:11.00 / 0:34.00');
    expect(time.className).toMatch(/tabular-nums/);
    expect(time.className).toMatch(/font-mono/);
    // the frame number is in the timecode's tooltip, and a chip from 320 px up
    expect(time).toHaveAttribute('title', '0:11.00 / 0:34.00 · Frame 330');
    expect(time.className).toMatch(/min-w-0/); // a long timecode truncates instead of overflowing
    const chip = within(row).getByText('#330');
    expect(chip.className).toMatch(/hidden/);
    expect(chip.className).toMatch(/@min-\[320px\]:inline-flex/);
  });

  it('has one Send frame action and no marking, with a short label when narrow', async () => {
    render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    const send = screen.getByRole('button', { name: 'Send frame to chat' });
    expect(screen.queryByRole('button', { name: 'Mark a spot' })).toBeNull();
    expect(send.className).toMatch(/h-8/);
    expect(send.className).toMatch(/whitespace-nowrap/);
    expect(within(send).getByText('Send frame')).toHaveClass('@min-[380px]:hidden');
    expect(within(send).getByText('Send frame to chat')).toHaveClass('hidden');
  });

  it('shows the key hints as one compact line that hides when narrow, and keeps them in the buttons', async () => {
    render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    const hints = screen.getByTestId('key-hints');
    expect(hints.className).toMatch(/hidden/);
    expect(hints.className).toMatch(/@min-\[296px\]:flex/);
    expect(hints.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(3);
    expect(hints).toHaveTextContent('← → frame · Shift+← → 1 s');
    expect(screen.getByRole('button', { name: 'Previous frame' })).toHaveAttribute('title', expect.stringContaining('Shift+←'));
    expect(screen.getByRole('button', { name: 'Next frame' })).toHaveAttribute('title', expect.stringContaining('Shift+→'));
  });

  it('steps frames with the arrows anywhere in the panel', async () => {
    render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    const next = screen.getByRole('button', { name: 'Next frame' });
    next.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('timecode')).toHaveAttribute('title', expect.stringMatching(/· Frame 1$/));
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(screen.getByTestId('timecode')).toHaveAttribute('title', expect.stringMatching(/· Frame 31$/));
  });

  it('sizes the frame box from the measured stage, keeping the video shape, so marks land on the picture', async () => {
    // Each observed element keeps its own callback: the stage and the strip are both measured.
    const callbacks = new Map<Element, ResizeObserverCallback>();
    const observed: Element[] = [];
    class MeasuringRO {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        observed.push(el);
        callbacks.set(el, this.cb);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MeasuringRO);
    const measure = (width: number, height: number) =>
      act(() =>
        callbacks.get(screen.getByTestId('preview-stage'))!([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver),
      );
    try {
      render(<Preview projectId="p1" chatId="c1" />);
      await screen.findByRole('slider');
      expect(observed).toContain(screen.getByTestId('preview-stage'));
      const box = screen.getByTestId('preview-frame');
      // tall stage: the width limits (9:16 video)
      measure(300, 800);
      expect(box.style.width).toBe('300px');
      expect(box.style.height).toBe(`${(300 * 16) / 9}px`);
      // wide stage: the height limits
      measure(600, 480);
      expect(box.style.width).toBe(`${(480 * 9) / 16}px`);
      expect(box.style.height).toBe('480px');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('frameBox fits the shape inside the stage', () => {
    expect(frameBox(300, 800, 9 / 16)).toEqual({ width: 300, height: (300 * 16) / 9 });
    expect(frameBox(600, 480, 9 / 16)).toEqual({ width: 270, height: 480 });
    expect(frameBox(500, 500, 16 / 9)).toEqual({ width: 500, height: 281.25 });
    expect(frameBox(0, 500, 9 / 16)).toBeNull();
  });

  it('puts the frames-checked chip on the video, top left, not in the hint row', async () => {
    useChat.setState({
      messages: { c1: [{ id: 'm1', chatId: 'c1', role: 'agent', parts: [{ type: 'text', text: 'Frames checked, all good' }], createdAt: '' }] },
    });
    render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    const chip = screen.getByTestId('frames-checked');
    expect(screen.getByTestId('preview-frame')).toContainElement(chip);
    expect(chip.className).toMatch(/absolute/);
    expect(chip.className).toMatch(/left-2/);
    expect(chip.className).toMatch(/top-2/);
    expect(chip.className).toMatch(/pointer-events-none/);
    expect(chip).toHaveTextContent('Frames checked');
    expect(within(chip).getByRole('img', { name: 'Oyen' })).toBeInTheDocument();
    expect(screen.getByTestId('key-hints')).not.toContainElement(chip);
  });
});

describe('Preview', () => {
  beforeEach(() => {
    vi.mocked(ipc.mediaLatestRender).mockResolvedValue('/p/out.mp4');
    vi.mocked(ipc.mediaProbe).mockResolvedValue({ durationSec: 34, fps: 30, frames: 1020, width: 1080, height: 1920 });
    vi.mocked(ipc.mediaThumbnails).mockResolvedValue(thumbs);
    vi.mocked(ipc.mediaExtractFrame).mockResolvedValue('/p/frame.png');
    useChat.getState().reset();
  });

  it('sends the current frame to the chat', async () => {
    const { container } = render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    const video = container.querySelector('video')!;
    video.currentTime = 11;
    fireEvent.timeUpdate(video);
    expect(await screen.findByText('#330')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send frame to chat' }));
    await waitFor(() => expect(ipc.mediaExtractFrame).toHaveBeenCalledWith('p1', 11));
    await waitFor(() => expect(useChat.getState().attachments['c1']?.[0]).toMatchObject({ type: 'frame', frame: 330, timeSec: 11 }));
  });

  it('sends the frame to the chat, without marks', async () => {
    render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    fireEvent.click(screen.getByTestId('preview-frame'));
    await userEvent.click(screen.getByRole('button', { name: 'Send frame to chat' }));
    await waitFor(() => expect(useChat.getState().attachments['c1']?.[0]).toMatchObject({ type: 'frame', marks: [] }));
    expect(screen.queryByTestId('mark-1')).toBeNull();
  });

  it('shows the empty state and renders on demand', async () => {
    vi.mocked(ipc.mediaLatestRender).mockResolvedValueOnce(null);
    vi.mocked(ipc.mediaProbe).mockResolvedValueOnce(null);
    vi.mocked(ipc.mediaRender).mockResolvedValue('/p/out.mp4');
    render(<Preview projectId="p1" chatId="c1" />);
    expect(await screen.findByText('Nothing rendered yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Render preview' }));
    await waitFor(() => expect(ipc.mediaRender).toHaveBeenCalledWith('p1'));
    expect(await screen.findByRole('slider')).toBeInTheDocument();
  });

  it('shows an inline error when rendering fails', async () => {
    vi.mocked(ipc.mediaLatestRender).mockResolvedValueOnce(null);
    vi.mocked(ipc.mediaProbe).mockResolvedValueOnce(null);
    vi.mocked(ipc.mediaRender).mockRejectedValue(new Error('ffmpeg missing'));
    render(<Preview projectId="p1" chatId="c1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Render preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ffmpeg missing');
  });

  it('shows the badge for the language-neutral token, with the token hidden in the chat', async () => {
    useChat.setState({
      messages: { c1: [{ id: 'm1', chatId: 'c1', role: 'agent', parts: [{ type: 'text', text: '[tayang:frames-checked]\nDua teks sudah diperbaiki.' }], createdAt: '' }] },
    });
    setUiLanguage('id');
    render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    expect(screen.getByText('Frame sudah dicek')).toBeInTheDocument();
    cleanup();
    render(<MessageList messages={useChat.getState().messages.c1!} streaming={false} />);
    expect(screen.getByText('Dua teks sudah diperbaiki.')).toBeInTheDocument();
    expect(screen.queryByText(/tayang:frames-checked/)).toBeNull();
  });

  it('shows Frames checked when the last agent message says so', async () => {
    useChat.setState({
      messages: { c1: [{ id: 'm1', chatId: 'c1', role: 'agent', parts: [{ type: 'text', text: 'Frames checked, all good' }], createdAt: '' }] },
    });
    render(<Preview projectId="p1" chatId="c1" />);
    await screen.findByRole('slider');
    expect(screen.getByText('Frames checked')).toBeInTheDocument();
  });
});
