import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  ENGINE_PROGRESS_EVENT: 'engine://progress',
  apiStatus: vi.fn(),
  apiCheck: vi.fn(),
  apiTry: vi.fn(),
  apiReachable: vi.fn(),
  apiSave: vi.fn(),
  engineInstall: vi.fn(),
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
const load = vi.fn().mockResolvedValue(undefined);
vi.mock('@/state/models', () => ({ useModels: { getState: () => ({ load }) } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import * as ipc from '@/lib/ipc';
import { ApiSetupDialog } from '@/components/ApiSetupDialog';

const saved = { defaultAgent: 'custom' } as Settings;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.apiStatus).mockResolvedValue({ provider: null, hasKey: false, engineInstalled: false });
  vi.mocked(ipc.apiReachable).mockResolvedValue(false);
  vi.mocked(ipc.engineInstall).mockResolvedValue(undefined);
  vi.mocked(ipc.apiSave).mockResolvedValue(saved);
  vi.mocked(ipc.apiTry).mockImplementation(async (_b, _k, model) => ({ ok: true, models: [model], failure: null, detail: null }));
});

describe('ApiSetupDialog', () => {
  it('checks a DeepSeek key, picks the recommended model, downloads the engine and saves', async () => {
    vi.mocked(ipc.apiCheck).mockResolvedValue({ ok: true, models: ['deepseek-chat', 'deepseek-reasoner'], failure: null, detail: null });
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    render(<ApiSetupDialog open onOpenChange={onOpenChange} onSaved={onSaved} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /DeepSeek/ }));
    await user.type(screen.getByLabelText(/API key/), 'sk-123');
    await user.click(screen.getByRole('button', { name: 'Check key' }));
    expect(ipc.apiCheck).toHaveBeenCalledWith('https://api.deepseek.com', 'sk-123');
    expect(await screen.findByText('Connected. 2 models available')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toBe('deepseek-chat (recommended)');

    await user.click(screen.getByRole('button', { name: 'Save and connect' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(ipc.apiTry).toHaveBeenCalledWith('https://api.deepseek.com', 'sk-123', 'deepseek-chat');
    expect(ipc.engineInstall).toHaveBeenCalled();
    expect(ipc.apiSave).toHaveBeenCalledWith({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] }, 'sk-123');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(load).toHaveBeenCalledWith('custom', true);
  });

  it('says in plain words why a key failed', async () => {
    vi.mocked(ipc.apiCheck).mockResolvedValue({ ok: false, models: [], failure: 'noBalance', detail: 'Insufficient Balance' });
    render(<ApiSetupDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /DeepSeek/ }));
    await user.type(screen.getByLabelText(/API key/), 'sk-1');
    await user.click(screen.getByRole('button', { name: 'Check key' }));
    expect(await screen.findByText(/no balance left/)).toBeTruthy();
    expect(screen.getByText('Insufficient Balance')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save and connect' })).toBeNull();
  });

  it('tells a 9router user to start it when nothing answers', async () => {
    vi.mocked(ipc.apiCheck).mockResolvedValue({ ok: false, models: [], failure: 'unreachable', detail: null });
    render(<ApiSetupDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /9router/ }));
    expect((screen.getByLabelText(/^Address/) as HTMLInputElement).value).toBe('http://localhost:20128/v1');
    await user.click(screen.getByRole('button', { name: 'Check key' }));
    expect(await screen.findByText(/9router isn’t running/)).toBeTruthy();
  });

  it('keeps the saved key when the field is left empty', async () => {
    vi.mocked(ipc.apiStatus).mockResolvedValue({
      provider: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' },
      hasKey: true,
      engineInstalled: true,
    });
    vi.mocked(ipc.apiCheck).mockResolvedValue({ ok: true, models: ['deepseek-chat', 'deepseek-reasoner'], failure: null, detail: null });
    render(<ApiSetupDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    const user = userEvent.setup();
    await waitFor(() => expect(ipc.apiStatus).toHaveBeenCalled());
    expect(await screen.findByText('Last used · deepseek-reasoner')).toBeTruthy();
    expect(screen.getAllByText(/^Last used/)).toHaveLength(1);
    await user.click(await screen.findByRole('button', { name: /DeepSeek/ }));
    expect(await screen.findByText(/A key is saved/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check key' }));
    expect(ipc.apiCheck).toHaveBeenCalledWith('https://api.deepseek.com', null);
    await screen.findByText('Connected. 2 models available');
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toBe('deepseek-reasoner');
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.type(screen.getByPlaceholderText('Search models…'), 'chat');
    expect(screen.queryByRole('option', { name: 'deepseek-reasoner' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'deepseek-chat (recommended)' }));
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: 'deepseek-reasoner' }));
    await user.click(screen.getByRole('button', { name: 'Save and connect' }));
    await waitFor(() => expect(ipc.apiSave).toHaveBeenCalledWith({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner', models: ['deepseek-chat', 'deepseek-reasoner'] }, null));
  });

  it('does not save when the real call fails, even if the model list loaded', async () => {
    vi.mocked(ipc.apiCheck).mockResolvedValue({ ok: true, models: ['gpt-5.5'], failure: null, detail: null });
    vi.mocked(ipc.apiTry).mockResolvedValue({ ok: false, models: [], failure: 'unauthorized', detail: "Invalid 'Authorization' header or token." });
    render(<ApiSetupDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /CommandCode/ }));
    await user.type(screen.getByLabelText(/API key/), 'bad');
    await user.click(screen.getByRole('button', { name: 'Check key' }));
    await user.click(await screen.findByRole('button', { name: 'Save and connect' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', "The key was refused. Copy it again from your provider. · Invalid 'Authorization' header or token.");
    expect(ipc.engineInstall).not.toHaveBeenCalled();
    expect(ipc.apiSave).not.toHaveBeenCalled();
  });
});
