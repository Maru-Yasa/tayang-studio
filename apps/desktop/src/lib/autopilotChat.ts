import type { AgentId, Settings } from '@tayang/shared';
import { buildAutopilotChatPrompt } from '@tayang/skills';
import { i18n } from '@/i18n';
import { socialAccounts } from '@/lib/cloud';
import { createChat, listNiches, listStyles, listVoices } from '@/lib/ipc';
import { useApp } from '@/state/app';
import { useChat } from '@/state/chat';

/** Opens a new chat where the agent sets up an autopilot with the user. A list that can't load is left empty. */
export async function startAutopilotChat(settings: Settings): Promise<void> {
  const agent: AgentId = settings.defaultAgent;
  const [niches, voices, styles, accounts] = await Promise.all([
    listNiches().catch(() => []),
    listVoices().catch(() => []),
    listStyles().catch(() => []),
    socialAccounts().catch(() => []),
  ]);
  const chat = await createChat(null, agent, i18n.t('autopilot.chat.title'));
  useChat.getState().rememberChat(chat);
  void useChat.getState().send(chat.id, [{ type: 'text', text: i18n.t('autopilot.chat.firstMessage') }], {
    agentId: agent,
    promptParts: [
      {
        type: 'text',
        text: buildAutopilotChatPrompt({
          niches,
          voices,
          styles,
          accounts: accounts.filter((a) => a.status === 'connected'),
          language: settings.language,
        }),
      },
    ],
  });
  useApp.setState({ focusChatId: chat.id });
  useApp.getState().navigate({ name: 'chat', chatId: chat.id });
}
