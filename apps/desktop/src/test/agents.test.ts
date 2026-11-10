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
