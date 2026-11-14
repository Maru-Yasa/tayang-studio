import { describe, expect, it } from 'vitest';
import { agentErrorText } from '@/lib/agents';

describe('agentErrorText', () => {
  it('shows the agent message when there is one', () => {
    expect(agentErrorText('The agent reported an error: quota exceeded', 'claude')).toBe(
      'The agent reported an error: quota exceeded',
    );
    expect(agentErrorText('', 'claude')).toBe('The agent stopped unexpectedly');
    expect(agentErrorText(undefined, 'gemini')).toBe('The agent stopped unexpectedly');
  });

  it('says the account cannot use the model instead of the raw refusal', () => {
    const codex =
      'The agent reported an error: Internal error ({"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}})';
    expect(agentErrorText(codex, 'codex')).toBe(
      "Codex can't use the model gpt-5.5 with your account. Pick another model in the model menu, or check your plan",
    );
    expect(agentErrorText('The agent reported an error: model_not_found', 'opencode')).toBe(
      "opencode can't use the model it picked with your account. Pick another model in the model menu, or check your plan",
    );
    expect(agentErrorText('The agent reported an error: quota exceeded', 'codex')).toBe(
      'The agent reported an error: quota exceeded',
    );
  });

  it.each([
    'Authentication required',
    'Please sign in',
    'not logged in: run /login',
    'The agent could not start a session: oops (code -32000)',
  ])('maps "%s" to sign-in copy', (msg) => {
    expect(agentErrorText(msg, 'claude')).toBe(
      'Sign in to Claude first: open Settings › Agents and press Sign in to Claude',
    );
  });

  it("names the agent's own command", () => {
    expect(agentErrorText('auth required', 'gemini')).toBe(
      'Sign in to Gemini CLI: open a terminal and run `gemini` once, then try again',
    );
    // Antigravity CLI's own ACP error, code -32000.
    expect(agentErrorText('Authentication required', 'antigravity')).toBe(
      'Sign in to Antigravity CLI: open a terminal and run `agy acp --login` once, then try again',
    );
  });

  it('says Your API key was refused instead of asking to sign in', () => {
    expect(agentErrorText('Internal error: Authentication Fails, Your api key: ****test is invalid', 'custom')).toBe(
      'Your API key was refused. Check it in Settings › Agents › Your API. The provider said: Internal error: Authentication Fails, Your api key: ****test is invalid',
    );
  });
});
