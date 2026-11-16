import { create } from 'zustand';
import type { AgentId, AgentUpdate, ModelChoice } from '@tayang/shared';
import { onAgentUpdate } from '@/lib/events';
import { agentModels, type AgentModels } from '@/lib/ipc';
import { useChat } from '@/state/chat';

const CACHE_KEY = 'tayang.agentModels';

/** Your API's models follow the provider saved in Settings, so they are read fresh, never kept. */
const UNCACHED: AgentId[] = ['custom'];
const withoutUncached = (byAgent: Partial<Record<AgentId, AgentModels>>) =>
  Object.fromEntries(Object.entries(byAgent).filter(([agent]) => !UNCACHED.includes(agent as AgentId))) as Partial<
    Record<AgentId, AgentModels>
  >;

/** Your API's models are `tayang/<model>` (its one provider). Another agent reporting them is the
 *  old Your API session of a chat that switched agents, never that agent's own list. */
const API_PREFIX = 'tayang/';
const hasApiModels = (m: AgentModels) => m.options.some((o) => o.value.startsWith(API_PREFIX));
const belongsTo = (agent: AgentId, m: AgentModels) => agent === 'custom' || !hasApiModels(m);

function loadCache(): Partial<Record<AgentId, AgentModels>> {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    // Lists kept before Your API's models could leak into them are dropped and asked for again.
    return Object.fromEntries(
      Object.entries(withoutUncached(raw as Partial<Record<AgentId, AgentModels>>)).filter(
        ([agent, m]) => Array.isArray(m?.options) && belongsTo(agent as AgentId, m),
      ),
    ) as Partial<Record<AgentId, AgentModels>>;
  } catch {
    return {};
  }
}

function saveCache(byAgent: Partial<Record<AgentId, AgentModels>>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(withoutUncached(byAgent)));
  } catch {
    /* storage off: the list is read again next time */
  }
}

/** What a chat's session reported, and the agent the chat had then. */
export type ChatModels = AgentModels & { agent?: AgentId };

interface ModelsState {
  /** What each running chat's session reports. */
  byChat: Record<string, ChatModels>;
  /** The last list each agent reported, kept between launches so the picker has it before a session. */
  byAgent: Partial<Record<AgentId, AgentModels>>;
  /** An agent being asked for its models right now. */
  loading: Partial<Record<AgentId, boolean>>;
  /** An agent that couldn't be asked, with why. */
  failed: Partial<Record<AgentId, string>>;
  /** Starts following the `models` updates of every session. Safe to call again. */
  listen(): void;
  report(chatId: string, update: Extract<AgentUpdate, { kind: 'models' }>): void;
  /** Asks the agent for its models when none are known yet (or when `force`). */
  load(agent: AgentId, force?: boolean): Promise<void>;
}

let listening = false;

export const useModels = create<ModelsState>((set, get) => ({
  byChat: {},
  byAgent: loadCache(),
  loading: {},
  failed: {},
  listen: () => {
    if (listening) return;
    listening = true;
    Promise.resolve()
      .then(() =>
        onAgentUpdate(({ chatId, update }) => {
          if (update.kind === 'models') get().report(chatId, update);
        }),
      )
      .catch(() => {
        listening = false;
      });
  },
  report: (chatId, { current, options }) => {
    const info = { current, options };
    const agent = useChat.getState().rows[chatId]?.agentId;
    set((s) => {
      const byAgent = agent && options.length && belongsTo(agent, info) ? { ...s.byAgent, [agent]: info } : s.byAgent;
      if (byAgent !== s.byAgent) saveCache(byAgent);
      return { byChat: { ...s.byChat, [chatId]: { ...info, agent } }, byAgent };
    });
  },
  load: async (agent, force = false) => {
    if (get().loading[agent] || (!force && get().byAgent[agent]?.options.length)) return;
    set((s) => ({ loading: { ...s.loading, [agent]: true }, failed: { ...s.failed, [agent]: undefined } }));
    try {
      const info = await agentModels(agent);
      set((s) => {
        const byAgent = info?.options.length && belongsTo(agent, info) ? { ...s.byAgent, [agent]: info } : s.byAgent;
        if (byAgent !== s.byAgent) saveCache(byAgent);
        return { byAgent };
      });
    } catch (e) {
      set((s) => ({ failed: { ...s.failed, [agent]: e instanceof Error ? e.message : String(e) } }));
    } finally {
      set((s) => ({ loading: { ...s.loading, [agent]: false } }));
    }
  },
}));

const NO_OPTIONS: ModelChoice[] = [];

/** What the chat's session reported, when it is this agent's (not an earlier agent's of the chat). */
export function chatModels(s: Pick<ModelsState, 'byChat'>, agent: AgentId, chatId: string | null): ChatModels | undefined {
  const m = chatId ? s.byChat[chatId] : undefined;
  return m && (m.agent ?? agent) === agent && belongsTo(agent, m) ? m : undefined;
}

/** The options to pick from for an agent: the chat's live session first, else the last list seen. */
export function modelOptions(s: Pick<ModelsState, 'byChat' | 'byAgent'>, agent: AgentId, chatId: string | null): ModelChoice[] {
  return chatModels(s, agent, chatId)?.options ?? s.byAgent[agent]?.options ?? NO_OPTIONS;
}
