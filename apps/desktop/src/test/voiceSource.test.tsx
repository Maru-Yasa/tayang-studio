import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  updateSettings: vi.fn(),
  voiceStatus: vi.fn(),
  voiceFishSave: vi.fn(),
  voiceFishClear: vi.fn(),
  voiceStudioCheck: vi.fn(),
}));

import * as ipc from '@/lib/ipc';
import { VoiceSourceCard } from '@/components/VoiceSourceCard';

const base = { voiceSource: 'tayang', fishVoiceId: null } as Settings;
const withSource = (voiceSource: Settings['voiceSource'], fishVoiceId: string | null = null) => ({ ...base, voiceSource, fishVoiceId }) as Settings;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.voiceStatus).mockResolvedValue({ hasFishKey: false });
  vi.mocked(ipc.updateSettings).mockImplementation(async (patch) => ({ ...base, ...patch }) as Settings);
});

describe('VoiceSourceCard', () => {
  it('starts on Tayang credits', () => {
    render(<VoiceSourceCard settings={base} onSaved={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Tayang' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Voiceovers are made with your Tayang credits, about 7 credits a minute.')).toBeTruthy();
  });

  it('Fish Audio becomes the source only once a key is checked and saved', async () => {
    vi.mocked(ipc.voiceFishSave).mockResolvedValue([{ ok: true, error: null, hasCredit: true }, withSource('fishaudio', 'voice-9')]);
    const onSaved = vi.fn();
    render(<VoiceSourceCard settings={base} onSaved={onSaved} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('tab', { name: 'Fish Audio' }));
    // Opening the panel changes nothing yet: there is no key.
    expect(ipc.updateSettings).not.toHaveBeenCalled();
    expect(screen.getByText('Not on yet. Save an API key first')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check and use' })).toHaveProperty('disabled', true);

    await user.type(screen.getByLabelText(/Fish Audio API key/), ' fk-123 ');
    await user.type(screen.getByLabelText('Voice ID (optional)'), 'voice-9');
    await user.click(screen.getByRole('button', { name: 'Check and use' }));

    expect(ipc.voiceFishSave).toHaveBeenCalledWith('fk-123', 'voice-9');
    expect(await screen.findByText('Connected. Voiceovers use your Fish Audio API balance')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith(withSource('fishaudio', 'voice-9'));
    // The key is not kept on screen once saved.
    expect(screen.getByLabelText(/Fish Audio API key/)).toHaveProperty('value', '');
  });

  it('says when the free model speaks, and why a key was refused', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.voiceFishSave).mockResolvedValueOnce([{ ok: true, error: null, hasCredit: false }, withSource('fishaudio')]);
    const { unmount } = render(<VoiceSourceCard settings={base} onSaved={() => {}} />);
    await user.click(screen.getByRole('tab', { name: 'Fish Audio' }));
    await user.type(screen.getByLabelText(/Fish Audio API key/), 'fk-free');
    await user.click(screen.getByRole('button', { name: 'Check and use' }));
    expect(await screen.findByText("Connected. Your API balance is empty, so voiceovers use Fish Audio's free model")).toBeTruthy();
    unmount();

    vi.mocked(ipc.voiceFishSave).mockResolvedValueOnce([{ ok: false, error: 'bad-key', hasCredit: null }, base]);
    const onSaved = vi.fn();
    render(<VoiceSourceCard settings={base} onSaved={onSaved} />);
    await user.click(screen.getByRole('tab', { name: 'Fish Audio' }));
    await user.type(screen.getByLabelText(/Fish Audio API key/), 'nope');
    await user.click(screen.getByRole('button', { name: 'Check and use' }));
    expect(await screen.findByText('Fish Audio refused this key. Check it, then try once more')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    // A refused key stays in the field to be fixed.
    expect(screen.getByLabelText(/Fish Audio API key/)).toHaveProperty('value', 'nope');
  });

  it('a saved key switches to Fish Audio in one click, and can be removed', async () => {
    vi.mocked(ipc.voiceStatus).mockResolvedValue({ hasFishKey: true });
    vi.mocked(ipc.voiceFishClear).mockResolvedValue(base);
    const onSaved = vi.fn();
    const { rerender } = render(<VoiceSourceCard settings={base} onSaved={onSaved} />);
    const user = userEvent.setup();
    await waitFor(() => expect(ipc.voiceStatus).toHaveBeenCalled());

    await user.click(screen.getByRole('tab', { name: 'Fish Audio' }));
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ voiceSource: 'fishaudio' }));
    rerender(<VoiceSourceCard settings={withSource('fishaudio')} onSaved={onSaved} />);
    expect(screen.getByText('On. Voiceovers are made with Fish Audio')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith(base));
    expect(ipc.voiceFishClear).toHaveBeenCalled();
  });

  it('VoiceStudio is picked right away and says whether the app is open', async () => {
    vi.mocked(ipc.voiceStudioCheck).mockResolvedValueOnce({ ok: false, error: 'not-running', hasCredit: null });
    const onSaved = vi.fn();
    render(<VoiceSourceCard settings={base} onSaved={onSaved} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('tab', { name: 'VoiceStudio' }));
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ voiceSource: 'voicestudio' }));
    expect(await screen.findByText("VoiceStudio isn't open. Open the app, then check again")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Get VoiceStudio' }).getAttribute('href')).toBe('https://voicestudio.sh');

    vi.mocked(ipc.voiceStudioCheck).mockResolvedValueOnce({ ok: true, error: null, hasCredit: null });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('VoiceStudio is open. Voiceovers are made on this computer')).toBeTruthy();
  });
});
