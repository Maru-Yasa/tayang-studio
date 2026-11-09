import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  agentModels: vi.fn(),
  setAgentModel: vi.fn(),
  detectAgents: vi.fn().mockResolvedValue([]),
  attachFile: vi.fn(),
  assetUrl: (p: string) => p,
}));
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}), onAgentUpdate: vi.fn(async () => () => {}), onPermission: vi.fn(async () => () => {}) }));

import * as ipc from '@/lib/ipc';
import { ModelPicker } from '@/components/Composer';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useApp } from '@/state/app';
import { useChat } from '@/state/chat';
import { useModels } from '@/state/models';

const settings = (agentModels: Settings['agentModels'] = {}): Settings => ({ ...DEFAULT_SETTINGS, workingFolder: '/w', agentModels });
const OPTIONS = [
  { value: 'saarouters/SaaSolVip', name: 'SaaSolVip' },
  { value: 'opencode/big-pickle', name: 'Big Pickle' },
  { value: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free' },
];
const picker = (chatId: string | null = null) =>
  render(
    <TooltipProvider>
      <ModelPicker agent="opencode" chatId={chatId} />
    </TooltipProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useModels.setState({ byChat: {}, byAgent: {}, loading: {}, failed: {} });
  useApp.setState({ settings: settings() });
});

describe('ModelPicker', () => {
  it('asks the agent for its models the first time, and picking one saves it for the agent', async () => {
    vi.mocked(ipc.agentModels).mockResolvedValue({ current: 'saarouters/SaaSolVip', options: OPTIONS });
    vi.mocked(ipc.setAgentModel).mockResolvedValue(settings({ opencode: 'opencode/big-pickle' }));
    picker();
    const button = screen.getByRole('button', { name: 'Model: Default model' });
    await userEvent.click(button);
    expect(ipc.agentModels).toHaveBeenCalledWith('opencode');
    await userEvent.click(await screen.findByRole('option', { name: 'Big Pickle' }));
    expect(ipc.setAgentModel).toHaveBeenCalledWith('opencode', 'opencode/big-pickle', null);
    expect(await screen.findByRole('button', { name: 'Model: Big Pickle' })).toBeInTheDocument();
    // Kept for next time: the list isn't asked for again.
    expect(JSON.parse(localStorage.getItem('tayang.agentModels')!).opencode.options).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Model: Big Pickle' }));
    expect(ipc.agentModels).toHaveBeenCalledTimes(1);
  });

  it("never keeps Your API's models between launches: they follow the saved provider", async () => {
    localStorage.setItem(
      'tayang.agentModels',
      JSON.stringify({ custom: { current: null, options: [{ value: 'opencode/big-pickle', name: 'Big Pickle' }] }, opencode: { current: null, options: OPTIONS } }),
    );
    vi.resetModules();
    const { useModels: fresh } = await import('@/state/models');
    expect(fresh.getState().byAgent.custom).toBeUndefined();
    expect(fresh.getState().byAgent.opencode?.options).toHaveLength(3);
    vi.mocked(ipc.agentModels).mockResolvedValue({ current: 'tayang/m', options: [{ value: 'tayang/m', name: 'Your API/m' }] });
    await fresh.getState().load('custom');
    expect(fresh.getState().byAgent.custom?.options).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('tayang.agentModels')!).custom).toBeUndefined();
  });

  it('shows a loading state while the agent is asked for its models', async () => {
    let answer: (v: { current: string | null; options: typeof OPTIONS }) => void = () => {};
    vi.mocked(ipc.agentModels).mockReturnValue(new Promise((r) => (answer = r)));
    picker();
    await userEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Asking opencode for its models…');
    expect(screen.queryByRole('option', { name: 'Big Pickle' })).not.toBeInTheDocument();
    await act(async () => answer({ current: null, options: OPTIONS }));
    expect(await screen.findByRole('option', { name: 'Big Pickle' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('filters by name, so the free ones are easy to find', async () => {
    useModels.setState({ byAgent: { opencode: { current: null, options: OPTIONS } } });
    picker();
    await userEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    await userEvent.type(screen.getByPlaceholderText('Find a model'), 'free');
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Big Pickle' })).not.toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Nemotron 3 Ultra Free' })).toBeInTheDocument();
  });

  it('shows what the running session uses and switches that chat', async () => {
    useChat.setState({ rows: { c1: { id: 'c1', projectId: null, agentId: 'opencode', title: 't', createdAt: '' } } } as never);
    act(() => useModels.getState().report('c1', { kind: 'models', current: 'opencode/nemotron-3-ultra-free', options: OPTIONS }));
    vi.mocked(ipc.setAgentModel).mockResolvedValue(settings({ opencode: 'saarouters/SaaSolVip' }));
    picker('c1');
    await userEvent.click(screen.getByRole('button', { name: 'Model: Nemotron 3 Ultra Free' }));
    await userEvent.click(screen.getByRole('option', { name: 'SaaSolVip' }));
    expect(ipc.setAgentModel).toHaveBeenCalledWith('opencode', 'saarouters/SaaSolVip', 'c1');
    // The session's report also became the agent's list.
    expect(useModels.getState().byAgent.opencode?.options).toHaveLength(3);
  });

  it('can go back to the agent default', async () => {
    useApp.setState({ settings: settings({ opencode: 'opencode/big-pickle' }) });
    useModels.setState({ byAgent: { opencode: { current: null, options: OPTIONS } } });
    vi.mocked(ipc.setAgentModel).mockResolvedValue(settings());
    picker();
    await userEvent.click(screen.getByRole('button', { name: 'Model: Big Pickle' }));
    await userEvent.click(screen.getByRole('option', { name: 'Default model' }));
    expect(ipc.setAgentModel).toHaveBeenCalledWith('opencode', null, null);
  });

  it('says so when the agent offers no models or cannot be asked', async () => {
    vi.mocked(ipc.agentModels).mockRejectedValue(new Error("Can't find opencode on this computer"));
    picker();
    await userEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't list the models: Can't find opencode on this computer");
    expect(screen.getByText("This agent doesn't offer a choice of model")).toBeInTheDocument();
  });
});
