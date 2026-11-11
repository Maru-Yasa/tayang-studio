import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, VoiceSource } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  updateSettings: vi.fn(),
  voiceStatus: vi.fn(),
  voiceKeySave: vi.fn(),
  voiceKeyClear: vi.fn(),
  voiceStudioCheck: vi.fn(),
}));

const navigate = vi.fn();
const plan = vi.hoisted(() => ({ signedIn: true, status: { active: true, plan: 'creator' } as { active: boolean; plan: string } | null }));
vi.mock('@/state/app', () => ({ useApp: (pick: (s: unknown) => unknown) => pick({ navigate }) }));
vi.mock('@/state/auth', () => ({ useAuth: (pick: (s: unknown) => unknown) => pick({ status: { signedIn: plan.signedIn } }) }));
vi.mock('@/state/billing', () => ({
  useBilling: Object.assign(() => ({ status: plan.status, loadedAt: 1, failed: false }), { getState: () => ({ refresh: vi.fn() }) }),
}));

import * as ipc from '@/lib/ipc';
import { VoiceSourceCard } from '@/components/VoiceSourceCard';

const base = { voiceSource: 'tayang' } as Settings;
const withSource = (voiceSource: VoiceSource) => ({ ...base, voiceSource }) as Settings;

/** Opens the source menu and picks one. */
const pick = async (user: UserEvent, name: string) => {
  await user.click(screen.getByRole('button', { name: /^Voice source/ }));
  await user.click(await screen.findByRole('menuitem', { name: new RegExp(`^${name}`) }));
};

beforeEach(() => {
  vi.clearAllMocks();
  plan.signedIn = true;
  plan.status = { active: true, plan: 'creator' };
  vi.mocked(ipc.voiceStatus).mockResolvedValue({ hasElevenKey: false, hasFishKey: false });
  vi.mocked(ipc.updateSettings).mockImplementation(async (patch) => ({ ...base, ...patch }) as Settings);
});

describe('VoiceSourceCard', () => {
  it('shows the source in use on the button, and marks it in the menu', async () => {
    render(<VoiceSourceCard settings={base} onSaved={() => {}} />);
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: 'Voice source: Tayang' })).toBeTruthy();
    expect(screen.getByText('Voiceovers are made with your Tayang credits, about 7 credits a minute.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Voice source: Tayang' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Tayang', 'ElevenLabsNeeds an API key', 'Fish AudioNeeds an API key', 'VoiceStudio']);
    // Only the one in use carries the check.
    expect(within(items[0]!).getByTestId('voice-check')).toBeTruthy();
    expect(screen.getAllByTestId('voice-check')).toHaveLength(1);
  });

  it('without a plan that has voiceovers, Tayang offers the plans', async () => {
    plan.status = { active: false, plan: 'free' };
    const { unmount } = render(<VoiceSourceCard settings={base} onSaved={() => {}} />);
    const user = userEvent.setup();
    expect(screen.getByText("Tayang's voice comes with the Creator plan and above. Without a plan, your videos use a free voice from this computer.")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'See plans' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'plans', plan: 'creator' });
    unmount();

    // Signed out is the same offer; a subscriber never sees it.
    plan.signedIn = false;
    plan.status = null;
    render(<VoiceSourceCard settings={base} onSaved={() => {}} />);
    expect(screen.getByRole('button', { name: 'See plans' })).toBeTruthy();
  });

  it('Fish Audio is in use only once a key is checked and saved', async () => {
    vi.mocked(ipc.voiceKeySave).mockResolvedValue([{ ok: true, error: null, hasCredit: true }, withSource('fishaudio')]);
    const onSaved = vi.fn();
    const { rerender } = render(<VoiceSourceCard settings={base} onSaved={onSaved} />);
    const user = userEvent.setup();

    await pick(user, 'Fish Audio');
    // The button follows the pick, and says it isn't in use until the key is saved.
    expect(ipc.updateSettings).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Voice source: Fish Audio' });
    expect(within(button).getByText('Not on yet')).toBeTruthy();
    expect(screen.getByText('Not on yet. Voiceovers still use Tayang until the API key is saved')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check and use' })).toHaveProperty('disabled', true);
    // No voice to pick: the default voice speaks.
    expect(screen.queryByLabelText(/Voice ID/)).toBeNull();

    await user.type(screen.getByLabelText(/Fish Audio API key/), ' fk-123 ');
    await user.click(screen.getByRole('button', { name: 'Check and use' }));

    expect(ipc.voiceKeySave).toHaveBeenCalledWith('fishaudio', 'fk-123');
    expect(await screen.findByText('Connected. Voiceovers use your Fish Audio account')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith(withSource('fishaudio'));
    // The key is not kept on screen once saved.
    expect(screen.getByLabelText(/Fish Audio API key/)).toHaveProperty('value', '');
    rerender(<VoiceSourceCard settings={withSource('fishaudio')} onSaved={onSaved} />);
    expect(within(screen.getByRole('button', { name: 'Voice source: Fish Audio' })).queryByText('Not on yet')).toBeNull();
  });

  it('says when the free model speaks, and why a key was refused', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.voiceKeySave).mockResolvedValueOnce([{ ok: true, error: null, hasCredit: false }, withSource('fishaudio')]);
    const { unmount } = render(<VoiceSourceCard settings={base} onSaved={() => {}} />);
    await pick(user, 'Fish Audio');
    await user.type(screen.getByLabelText(/Fish Audio API key/), 'fk-free');
    await user.click(screen.getByRole('button', { name: 'Check and use' }));
    expect(await screen.findByText("Connected. Your API balance is empty, so voiceovers use Fish Audio's free model")).toBeTruthy();
    unmount();

    vi.mocked(ipc.voiceKeySave).mockResolvedValueOnce([{ ok: false, error: 'bad-key', hasCredit: null }, base]);
    const onSaved = vi.fn();
    render(<VoiceSourceCard settings={base} onSaved={onSaved} />);
    await pick(user, 'Fish Audio');
    await user.type(screen.getByLabelText(/Fish Audio API key/), 'nope');
    await user.click(screen.getByRole('button', { name: 'Check and use' }));
    expect(await screen.findByText('Fish Audio refused this key. Check it, then try once more')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    // A refused key stays in the field to be fixed.
    expect(screen.getByLabelText(/Fish Audio API key/)).toHaveProperty('value', 'nope');
  });

  it('a saved key switches to Fish Audio in one pick, and can be removed', async () => {
    vi.mocked(ipc.voiceStatus).mockResolvedValue({ hasElevenKey: false, hasFishKey: true });
    vi.mocked(ipc.voiceKeyClear).mockResolvedValue(base);
    const onSaved = vi.fn();
    const { rerender } = render(<VoiceSourceCard settings={base} onSaved={onSaved} />);
    const user = userEvent.setup();
    await waitFor(() => expect(ipc.voiceStatus).toHaveBeenCalled());

    await pick(user, 'Fish Audio');
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ voiceSource: 'fishaudio' }));
    rerender(<VoiceSourceCard settings={withSource('fishaudio')} onSaved={onSaved} />);
    expect(screen.getByRole('button', { name: 'Voice source: Fish Audio' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove key' }));
    await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith(base));
    expect(ipc.voiceKeyClear).toHaveBeenCalledWith('fishaudio');
  });

  it('ElevenLabs takes its own key, and says when the quota is used up', async () => {
    const eleven = withSource('elevenlabs');
    vi.mocked(ipc.voiceKeySave).mockResolvedValueOnce([{ ok: true, error: null, hasCredit: true }, eleven]);
    const onSaved = vi.fn();
    const { unmount } = render(<VoiceSourceCard settings={base} onSaved={onSaved} />);
    const user = userEvent.setup();

    await pick(user, 'ElevenLabs');
    expect(ipc.updateSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Get a key' }).getAttribute('href')).toBe('https://elevenlabs.io/app/settings/api-keys');
    await user.type(screen.getByLabelText(/ElevenLabs API key/), 'sk_abc');
    await user.click(screen.getByRole('button', { name: 'Check and use' }));
    expect(ipc.voiceKeySave).toHaveBeenCalledWith('elevenlabs', 'sk_abc');
    expect(await screen.findByText('Connected. Voiceovers use your ElevenLabs account')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith(eleven);
    unmount();

    // The key is good but there are no characters left: no free model to fall back to.
    vi.mocked(ipc.voiceKeySave).mockResolvedValueOnce([{ ok: true, error: null, hasCredit: false }, eleven]);
    render(<VoiceSourceCard settings={base} onSaved={() => {}} />);
    await pick(user, 'ElevenLabs');
    await user.type(screen.getByLabelText(/ElevenLabs API key/), 'sk_abc');
    await user.click(screen.getByRole('button', { name: 'Check and use' }));
    expect(await screen.findByText('The key works, but your ElevenLabs quota is used up')).toBeTruthy();
  });

  it('VoiceStudio is in use right away and says whether the app is open', async () => {
    vi.mocked(ipc.voiceStudioCheck).mockResolvedValueOnce({ ok: false, error: 'not-running', hasCredit: null });
    const onSaved = vi.fn();
    const { rerender } = render(<VoiceSourceCard settings={base} onSaved={onSaved} />);
    const user = userEvent.setup();

    await pick(user, 'VoiceStudio');
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ voiceSource: 'voicestudio' }));
    rerender(<VoiceSourceCard settings={withSource('voicestudio')} onSaved={onSaved} />);
    expect(await screen.findByText("VoiceStudio isn't open. Open the app, then check again")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Get VoiceStudio' }).getAttribute('href')).toBe('https://voicestudio.sh');

    vi.mocked(ipc.voiceStudioCheck).mockResolvedValueOnce({ ok: true, error: null, hasCredit: null });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('VoiceStudio is open. Voiceovers are made on this computer')).toBeTruthy();
  });
});
