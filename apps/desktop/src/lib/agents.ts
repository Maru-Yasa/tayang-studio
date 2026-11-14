import type { AgentId } from '@tayang/shared';
import { i18n } from '@/i18n';
import { trackError } from '@/lib/analytics';

export const AGENT_NAMES: Record<AgentId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  gemini: 'Gemini CLI',
  codex: 'Codex',
  antigravity: 'Antigravity CLI',
  /** Your API (the user's own provider key): the only name that is a phrase, so it follows the language. */
  get custom() {
    return i18n.t('agents.yourApi');
  },
};

/** Where each agent's own install guide is; Your API is set up inside Tayang. */
export const AGENT_INSTALL_URL: Record<Exclude<AgentId, 'custom'>, string> = {
  claude: 'https://docs.claude.com/en/docs/claude-code',
  opencode: 'https://opencode.ai',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  codex: 'https://github.com/openai/codex',
  antigravity: 'https://antigravity.google/docs/getting-started?tab=cli',
};

/** What to type in a terminal to sign in to each agent. */
const SIGN_IN_COMMAND: Record<AgentId, string> = {
  claude: 'claude',
  opencode: 'opencode auth login',
  gemini: 'gemini',
  codex: 'codex',
  antigravity: 'agy acp --login',
  custom: '',
};

/** The account can't use the model, e.g. Codex signed in with ChatGPT: "The 'gpt-5.5' model is not
 * supported when using Codex with a ChatGPT account". Rust already tried the other models it offers
 * (`run_turn` in acp.rs), so this is what's left to say. Keep in step with `is_unsupported_model`. */
const UNSUPPORTED_MODEL = /model_not_found|model\b.*\b(not supported|does not exist|not available|do(?: not|n't) have access)/i;

/** Whether an agent error says the account can't use the model. */
export function isUnsupportedModel(message: string | null | undefined): boolean {
  return UNSUPPORTED_MODEL.test(message ?? '');
}

/** Counts agent errors worth fixing in Tayang, grouped by cause so they don't hide among others. */
export function trackAgentError(message: string | null | undefined, agent: AgentId): void {
  if (!isUnsupportedModel(message)) return;
  trackError(new Error(message ?? ''), 'agent_turn', {
    agent,
    $exception_fingerprint: 'agent:model-unavailable',
    $issue_name: 'Agent: the account cannot use the model',
  });
}

/** JSON-RPC -32000 is ACP's "authentication required". */
const AUTH = /\bauth|sign[ -]?in|log[ -]?in|-32000/i;

/** What the user sees when the agent fails: its own message, or how to sign in.
 * `lng: 'en'` gives the English text that gets saved with a chat or job (see `lib/stored.ts`). */
export function agentErrorText(message: string | null | undefined, agent: AgentId, lng?: 'en'): string {
  const msg = (message ?? '').trim();
  if (isUnsupportedModel(msg)) {
    const model = /The '([^']+)' model/.exec(msg)?.[1] ?? /model [`"']([^`"']+)[`"']/.exec(msg)?.[1];
    const opts = lng ? { lng } : {};
    return i18n.t('errors.modelUnavailable', { agent: AGENT_NAMES[agent], model: model ?? i18n.t('errors.thisModel', opts), ...opts });
  }
  if (AUTH.test(msg)) {
    const opts = lng ? { lng } : {};
    // Your API has no sign-in: its key was refused.
    if (agent === 'custom') return i18n.t('errors.apiKeyRefused', { ...opts, detail: msg });
    // Claude signs in from Tayang (Settings › Agents), not a terminal.
    if (agent === 'claude') return i18n.t('errors.signInClaude', opts);
    const cmd = SIGN_IN_COMMAND[agent];
    return i18n.t('errors.signIn', { agent: AGENT_NAMES[agent], command: `\`${cmd}\``, ...opts });
  }
  return msg || i18n.t('errors.agentStopped', lng ? { lng } : {});
}

/** The note Rust writes on a job whose agent died with the app (`fail_stale_jobs`). */
export const CLOSED_NOTE = 'Tayang was closed while this was running';
/** The draft prefilled (never sent) when a chat job failed because Tayang was closed is `agents.closedDraft`. */
