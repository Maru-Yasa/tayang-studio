import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentQuestion, AgentUpdate, PermissionRequest } from '@tayang/shared';

export function onAgentUpdate(
  cb: (e: { chatId: string; update: AgentUpdate }) => void,
): Promise<UnlistenFn> {
  return listen<{ chatId: string; update: AgentUpdate }>('agent://update', (e) => cb(e.payload));
}

export function onPermission(cb: (req: PermissionRequest) => void): Promise<UnlistenFn> {
  return listen<PermissionRequest>('agent://permission', (e) => cb(e.payload));
}

/** An agent asks the user something (ACP elicitation). */
export function onQuestion(cb: (q: AgentQuestion) => void): Promise<UnlistenFn> {
  return listen<AgentQuestion>('agent://question', (e) => cb(e.payload));
}

/** What an agent asked Tayang to do through its local endpoint: start a video, or schedule videos. */
export interface AgentAction {
  chatId: string;
  name: 'pick_topic' | 'schedule_videos' | 'create_autopilot';
  context: Record<string, unknown>;
}

export function onAgentAction(cb: (a: AgentAction) => void): Promise<UnlistenFn> {
  return listen<AgentAction>('agent://action', (e) => cb(e.payload));
}
