import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  copyChatAttachments: vi.fn(async () => []),
  createChat: vi.fn(),
  listNiches: vi.fn().mockResolvedValue([]),
  listStyles: vi.fn().mockResolvedValue([]),
  listVoices: vi.fn().mockResolvedValue([]),
  listMessages: vi.fn().mockResolvedValue([]),
  addMessage: vi.fn().mockImplementation(async (chatId, role, parts) => ({
    id: `m-${Math.random()}`,
    chatId,
    role,
    parts,
    createdAt: '',
  })),
  agentStart: vi.fn().mockResolvedValue(false),
  agentPrompt: vi.fn().mockResolvedValue(undefined),
  renderCommand: vi.fn().mockResolvedValue(null),
  detectAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/cloud', () => ({
  socialAccounts: vi.fn().mockResolvedValue([]),
}));

import * as ipc from '@/lib/ipc';
import { startAutopilotChat } from '@/lib/autopilotChat';
import { useApp } from '@/state/app';
import { useChat } from '@/state/chat';

const settings: Settings = {
  workingFolder: '/w/Tayang',
  defaultAgent: 'claude',
  frameCheck: true,
  language: 'id',
  format: '9:16',
  fps: 30,
  onboarded: true,
  apiUrl: 'https://studio.tayang.app/api',
  installId: '',
  shareInstallStats: true,
  autoMode: false,
  lastPingAt: null,
  uiLanguage: null,
  backgroundMode: false,
  openAtLogin: false,
  buildJobsChecked: true,
  projectStatusChecked: true,
  agentModels: {},
};

describe('startAutopilotChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChat.getState().reset();
    useApp.setState({ settings, route: { name: 'chat', chatId: 'chat-src' }, focusChatId: null });
    vi.mocked(ipc.createChat).mockResolvedValue({
      id: 'chat-auto',
      projectId: null,
      agentId: 'claude',
      title: 'New autopilot',
      createdAt: '2026-11-25T00:00:00Z',
    });
  });

  it('copies source chat attachments into the new autopilot chat, clears source unsent files, and sends copied files', async () => {
    const srcLogo = {
      type: 'file' as const,
      path: '/w/Tayang/.tayang/chats/chat-src/attachments/logo.png',
      name: 'logo.png',
      mime: 'image/png',
      size: 120,
    };
    const copiedLogo = {
      type: 'file' as const,
      path: '/w/Tayang/.tayang/chats/chat-auto/attachments/logo.png',
      name: 'logo.png',
      mime: 'image/png',
      size: 120,
    };
    useChat.getState().attach('chat-src', srcLogo);
    vi.mocked(ipc.copyChatAttachments).mockResolvedValue([copiedLogo]);

    await startAutopilotChat(settings, 'Harian jam 7 pagi pakai logo ini', {
      sourceChatId: 'chat-src',
      files: [srcLogo],
    });

    expect(ipc.copyChatAttachments).toHaveBeenCalledWith('chat-src', {
      toChatId: 'chat-auto',
      files: [srcLogo],
    });
    expect(useChat.getState().attachments['chat-src']).toEqual([]);
    expect(useApp.getState().route).toEqual({ name: 'chat', chatId: 'chat-auto' });

    await vi.waitFor(() => expect(ipc.agentPrompt).toHaveBeenCalledTimes(1));
    const visibleParts = useChat.getState().messages['chat-auto']![0]!.parts;
    expect(visibleParts).toContainEqual(copiedLogo);
    const promptParts = vi.mocked(ipc.agentPrompt).mock.calls[0]![1];
    expect(promptParts).toContainEqual(copiedLogo);
    expect(JSON.stringify(promptParts)).toContain('Harian jam 7 pagi pakai logo ini');
  });
});
