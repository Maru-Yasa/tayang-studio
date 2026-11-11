import { create } from 'zustand';
import type { AgentId, AgentUpdate, PermissionRequest, SystemInfo, ToolId, ToolStatus } from '@tayang/shared';
import { buildInstallPrompt, languageHint } from '@tayang/skills';
import { uiLanguage } from '@/i18n';
import { agentCancel, agentPrompt, agentRespondPermission, agentStart, checkTools } from '@/lib/ipc';
import { i18n } from '@/i18n';
import { agentErrorText } from '@/lib/agents';
import { onAgentUpdate, onPermission } from '@/lib/events';

/** Every install runs in one shared agent chat. */
export const SETUP_CHAT = 'setup';

export type InstallStatus = 'missing' | 'confirm' | 'running' | 'done' | 'failed';

export interface LogLine {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface ToolInstall {
  status: InstallStatus;
  log: LogLine[];
  error?: string;
  /** What the agent said this turn; shown when the tool is still missing (e.g. a command for the user to run). */
  reply?: string;
}

export interface StartOpts {
  sys: SystemInfo;
  agent: AgentId;
}

interface InstallState {
  /** Latest `check_tools` result. */
  statuses: ToolStatus[];
  tools: Partial<Record<ToolId, ToolInstall>>;
  /** The tool the setup chat is working on, if any. */
  active: ToolId | null;
  /** Open permission request of the setup chat: the card shows this one. */
  request: PermissionRequest | null;
  /** Requests that arrived while `request` was open, oldest first. */
  queue: PermissionRequest[];
  /** A cancelled turn is still winding down; installs stay disabled until its done/error arrives. */
  closing: boolean;
  agent: AgentId | null;

  refresh(agent: AgentId): Promise<ToolStatus[]>;
  start(tool: ToolId, opts: StartOpts): Promise<void>;
  respond(optionId: string | null): Promise<void>;
  /** Back to the plain "Install" button. */
  dismiss(tool: ToolId): void;
  /** Stop an install that has not been approved yet and free the setup chat. */
  cancel(tool: ToolId): Promise<void>;
  listen(): void;
  reset(): void;
}

let unlisten: Promise<() => void>[] = [];

export const useInstall = create<InstallState>((set, get) => {
  const patch = (tool: ToolId, p: Partial<ToolInstall>) =>
    set((s) => ({ tools: { ...s.tools, [tool]: { status: 'missing', log: [], ...s.tools[tool], ...p } } }));

  /** Answers every open request with null (cancelled) and empties the queue. */
  const dropRequests = () => {
    const { request, queue } = get();
    set({ request: null, queue: [] });
    for (const r of [...(request ? [request] : []), ...queue]) {
      void agentRespondPermission(r.requestId, null).catch(() => {});
    }
  };

  const fail = (tool: ToolId, error: string) => {
    patch(tool, { status: 'failed', error });
    dropRequests();
    set({ active: null });
  };

  const closeTurn = async () => {
    dropRequests();
    set({ active: null, closing: true });
    try {
      await agentCancel(SETUP_CHAT);
    } catch {
      set({ closing: false });
    }
  };

  const onUpdate = async (update: AgentUpdate) => {
    if (get().closing) {
      if (update.kind === 'done' || update.kind === 'error') set({ closing: false });
      return;
    }
    const tool = get().active;
    if (!tool) return;
    const cur = get().tools[tool];
    if (update.kind === 'text') {
      patch(tool, { reply: (cur?.reply ?? '') + update.text });
    } else if (update.kind === 'tool') {
      const log = [...(cur?.log ?? [])];
      const line: LogLine = { id: update.toolCallId, title: update.title, status: update.status };
      const i = log.findIndex((l) => l.id === line.id);
      if (i >= 0) log[i] = line;
      else log.push(line);
      const promote = cur?.status === 'confirm' && !get().request && update.status !== 'pending';
      patch(tool, { log, ...(promote ? { status: 'running' as const } : {}) });
    } else if (update.kind === 'error') {
      fail(tool, agentErrorText(update.message, get().agent ?? 'claude'));
    } else if (update.kind === 'done') {
      // The turn is over: nothing still queued can run.
      dropRequests();
      const agent = get().agent;
      try {
        const statuses = agent ? await get().refresh(agent) : get().statuses;
        if (statuses.find((t) => t.id === tool)?.ok) {
          patch(tool, { status: 'done', error: undefined });
          set({ active: null });
        } else {
          // The agent's own reply can be a long monologue; the row shows it folded away, under this line.
          fail(tool, i18n.t('errors.cantFindTool'));
        }
      } catch (e) {
        fail(tool, e instanceof Error ? e.message : String(e));
      }
    }
  };

  return {
    statuses: [],
    tools: {},
    active: null,
    request: null,
    queue: [],
    closing: false,
    agent: null,

    async refresh(agent) {
      const statuses = await checkTools();
      set({ statuses, agent });
      return statuses;
    },

    async start(tool, opts) {
      if (get().active || get().closing) return;
      set({ active: tool, request: null, queue: [], agent: opts.agent });
      patch(tool, { status: 'confirm', log: [], error: undefined, reply: undefined });
      try {
        await agentStart(SETUP_CHAT, opts.agent);
        // The agent's failure text reaches the user, so it follows their language too.
        const text = [buildInstallPrompt(tool, opts.sys, opts.agent), languageHint(uiLanguage())].filter(Boolean).join('\n\n');
        await agentPrompt(SETUP_CHAT, [{ type: 'text', text }]);
      } catch (e) {
        if (get().active === tool) fail(tool, agentErrorText(e instanceof Error ? e.message : String(e), opts.agent));
      }
    },

    async respond(optionId) {
      const { request, queue, active } = get();
      if (!request) return;
      const [next = null, ...rest] = queue;
      set({ request: next, queue: rest });
      if (optionId === null) {
        if (active) patch(active, { status: 'missing', log: [] });
        await agentRespondPermission(request.requestId, null);
        await closeTurn();
        return;
      }
      if (active) patch(active, { status: next ? 'confirm' : 'running' });
      await agentRespondPermission(request.requestId, optionId);
    },

    dismiss: (tool) => patch(tool, { status: 'missing', log: [], error: undefined }),

    async cancel(tool) {
      const wasActive = get().active === tool;
      patch(tool, { status: 'missing', log: [], error: undefined });
      if (!wasActive) return;
      await closeTurn();
    },

    listen() {
      if (unlisten.length) return;
      unlisten = [
        onAgentUpdate(({ chatId, update }) => {
          if (chatId === SETUP_CHAT) void onUpdate(update);
        }),
        onPermission((req) => {
          if (req.chatId !== SETUP_CHAT) return;
          if (get().closing) {
            void agentRespondPermission(req.requestId, null).catch(() => {});
            return;
          }
          const tool = get().active;
          if (!tool) return;
          // Every request of the turn gets its own card, one at a time, oldest first.
          patch(tool, { status: 'confirm' });
          if (get().request) set((s) => ({ queue: [...s.queue, req] }));
          else set({ request: req });
        }),
      ];
    },

    reset() {
      unlisten.forEach((p) => void p.then((fn) => fn()));
      unlisten = [];
      set({ statuses: [], tools: {}, active: null, request: null, queue: [], closing: false, agent: null });
    },
  };
});
