import { create } from 'zustand';
import type { PaidPlanId, Settings } from '@tayang/shared';

export type Route =
  | { name: 'welcome' }
  | { name: 'connect' }
  | { name: 'requirements' }
  /** Onboarding's last, optional step: sign in to a Tayang account. */
  | { name: 'onboarding-account' }
  | { name: 'chat-new'; styleId?: string }
  | {
      name: 'chat';
      chatId: string;
      /** Prefilled in the composer, never sent. */
      draft?: string;
      /** A chat without a project that New chat started from a template on the Style screen. */
      styleId?: string;
    }
  | { name: 'videos' }
  /** Social accounts and the videos posted to them. */
  | { name: 'social' }
  | { name: 'style'; /** Focus the link box when the screen opens. */ focusLink?: boolean }
  | { name: 'autopilot'; /** One autopilot's detail view. */ id?: string }
  | {
      name: 'autopilot-wizard';
      /** Editing this autopilot; none for a new one. */
      id?: string;
      /** What the agent suggested in a chat: the wizard opens on its Summary, for the user to check and start. */
      draft?: Record<string, unknown>;
    }
  | { name: 'agents' }
  | { name: 'calendar' }
  | { name: 'settings'; /** The tab to open on (Settings' own id). */ tab?: string }
  /** Full window, like onboarding. `from` is where Back returns to; `plan` is picked first. */
  | { name: 'plans'; from?: 'settings' | 'autopilot'; plan?: PaidPlanId };

/** Asked before every navigation while set; returning false keeps the current screen (it asks the user itself). */
export type LeaveGuard = (next: Route) => boolean;

interface AppState {
  route: Route;
  navigate(r: Route): void;
  leaveGuard: LeaveGuard | null;
  setLeaveGuard(guard: LeaveGuard | null): void;
  settings: Settings | null;
  setSettings(s: Settings): void;
  needsYouCount: number;
  /** The chat New chat started last in this app session: Chat goes back to it while it runs. */
  newChatId: string | null;
  /** The chat New chat just handed its first message to: its composer takes the focus over. */
  focusChatId: string | null;
  /** Bumped when a project is created so the sidebar's Recent list refreshes. */
  projectsVersion: number;
  bumpProjects(): void;
  /** Set when a reminder was due but the system denied notifications; the Calendar explains it. */
  notificationsBlocked: boolean;
  setNotificationsBlocked(blocked: boolean): void;
}

export const useApp = create<AppState>((set, get) => ({
  route: { name: 'welcome' },
  navigate: (route) => {
    const guard = get().leaveGuard;
    if (guard && !guard(route)) return;
    set({ route });
  },
  leaveGuard: null,
  setLeaveGuard: (leaveGuard) => set({ leaveGuard }),
  settings: null,
  setSettings: (settings) => set({ settings }),
  needsYouCount: 0,
  newChatId: null,
  focusChatId: null,
  projectsVersion: 0,
  bumpProjects: () => set((s) => ({ projectsVersion: s.projectsVersion + 1 })),
  notificationsBlocked: false,
  setNotificationsBlocked: (notificationsBlocked) => set({ notificationsBlocked }),
}));
