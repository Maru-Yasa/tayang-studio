import type { AgentId, MessagePart, Settings } from '@tayang/shared';
import { buildAutopilotChatPrompt } from '@tayang/skills';
import { i18n } from '@/i18n';
import { socialAccounts } from '@/lib/cloud';
import { copyChatAttachments, createChat, listNiches, listStyles, listVoices } from '@/lib/ipc';
import { useApp } from '@/state/app';
import { useChat } from '@/state/chat';

/**
 * Opens a new chat where the agent sets up an autopilot with the user. A list that can't load is left
 * empty. `notes` is what the user already asked for in another chat (an agent's POST /autopilot-chat).
 */
export async function startAutopilotChat(
  settings: Settings,
  notes = '',
  opts?: { sourceChatId?: string; files?: MessagePart[] },
): Promise<void> {
  const agent: AgentId = settings.defaultAgent;
  const [niches, voices, styles, accounts] = await Promise.all([
    listNiches().catch(() => []),
    listVoices().catch(() => []),
    listStyles().catch(() => []),
    socialAccounts().catch(() => []),
  ]);
  const chat = await createChat(null, agent, i18n.t('autopilot.chat.title'));
  useChat.getState().rememberChat(chat);
  let copiedFiles: MessagePart[] = [];
  if (opts?.sourceChatId && opts.files?.length) {
    copiedFiles = await copyChatAttachments(opts.sourceChatId, { toChatId: chat.id, files: opts.files }).catch(() => []);
    useChat.getState().clearAttachments(opts.sourceChatId);
  }
  const asked = notes.trim();
  const first = asked ? `${i18n.t('autopilot.chat.firstMessage')}: ${asked}` : i18n.t('autopilot.chat.firstMessage');
  const promptText = buildAutopilotChatPrompt({
    niches,
    voices,
    styles,
    accounts: accounts.filter((a) => a.status === 'connected'),
    language: settings.language,
  });
  void useChat.getState().send(chat.id, [...copiedFiles, { type: 'text', text: first }], {
    agentId: agent,
    promptParts: [...copiedFiles, { type: 'text', text: promptText }, ...(asked ? [{ type: 'text' as const, text: first }] : [])],
  });
  useApp.setState({ focusChatId: chat.id });
  useApp.getState().navigate({ name: 'chat', chatId: chat.id });
}
