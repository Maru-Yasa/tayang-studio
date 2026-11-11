import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '@tayang/shared';

vi.mock('@/lib/ipc', () => ({
  listJobs: vi.fn().mockResolvedValue([]),
  listProjects: vi.fn().mockResolvedValue([]),
  listRecentChats: vi.fn().mockResolvedValue([]),
  listArchivedChats: vi.fn().mockResolvedValue([]),
  setThreadArchived: vi.fn().mockResolvedValue(undefined),
  purgeArchive: vi.fn().mockResolvedValue({ chats: 0, cards: 0 }),
  setJobsArchived: vi.fn().mockResolvedValue(undefined),
  updateSettings: vi.fn(),
  detectAgents: vi.fn().mockResolvedValue([]),
  getSystemInfo: vi.fn().mockResolvedValue({ os: 'macos', osVersion: '15', packageManager: 'brew' }),
  checkTools: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/events', () => ({
  onQuestion: vi.fn(async () => () => {}),
  onAgentAction: vi.fn(async () => () => {}), onAgentUpdate: vi.fn(async () => () => {}), onPermission: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { en } from '@/i18n/en';
import { id } from '@/i18n/id';
import { detectUiLanguage, i18n, locale, setUiLanguage } from '@/i18n';
import { updateSettings } from '@/lib/ipc';
import { CLOSED_NOTE } from '@/lib/agents';
import { localized, stored } from '@/lib/stored';
import { ago, formatResetIn } from '@/lib/time';
import { summarize, ActivityGroup, type ActivityItem } from '@/components/Activity';
import { ToolRow } from '@/components/ToolRow';
import { toolDetail, toolName } from '@/lib/tools';
import { Sidebar } from '@/components/Sidebar';
import { Settings as SettingsScreen } from '@/screens/Settings';
import { Welcome } from '@/screens/onboarding/Welcome';
import { useApp } from '@/state/app';

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === 'string') out[prefix + k] = v;
    else Object.assign(out, flatten(v, `${prefix}${k}.`));
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
/** Indonesian has no singular form: `_one` keys are optional there. */
const withoutOne = (keys: string[]) => keys.filter((k) => !k.endsWith('_one')).sort();

describe('translations', () => {
  const E = flatten(en as unknown as Tree);
  const I = flatten(id as unknown as Tree);

  it('have the same keys in English and Indonesian', () => {
    expect(withoutOne(Object.keys(I))).toEqual(withoutOne(Object.keys(E)));
    // an Indonesian `_one` would never be used, and must still belong to a real English key
    for (const k of Object.keys(I).filter((k) => k.endsWith('_one'))) expect(E).toHaveProperty(k);
  });

  it('have no empty strings', () => {
    for (const [k, v] of Object.entries(E)) expect([k, v.trim().length > 0]).toEqual([k, true]);
    for (const [k, v] of Object.entries(I)) expect([k, v.trim().length > 0]).toEqual([k, true]);
  });

  it('use the same {{placeholders}} in both languages', () => {
    for (const k of Object.keys(I)) {
      if (k.endsWith('_one')) continue;
      expect([k, placeholders(I[k]!)]).toEqual([k, placeholders(E[k]!)]);
    }
  });

  it('keep the saved-note texts in step with the keys Rust and the app write', () => {
    expect(en.agents.closedNote).toBe(CLOSED_NOTE);
  });

  it('pick the interface language from the system language', () => {
    expect(detectUiLanguage('id-ID')).toBe('id');
    expect(detectUiLanguage('id')).toBe('id');
    expect(detectUiLanguage('en-US')).toBe('en');
    expect(detectUiLanguage('ms-MY')).toBe('en');
    expect(detectUiLanguage(undefined)).toBe('en');
  });
});

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
  uiLanguage: 'en',
  backgroundMode: false,
  openAtLogin: false,
  buildJobsChecked: true,
  projectStatusChecked: true,
  agentModels: {},
};

describe('Indonesian interface', () => {
  beforeEach(() => {
    vi.mocked(updateSettings).mockImplementation(async (p) => ({ ...settings, ...p }));
    useApp.setState({ settings, route: { name: 'settings' }, needsYouCount: 0 });
  });

  it('shows the sidebar in Indonesian', () => {
    setUiLanguage('id');
    render(<Sidebar active="chat" />);
    const nav = screen.getByRole('navigation', { name: 'Utama' });
    for (const label of ['Chat', 'Video', 'Gaya', 'Agen', 'Kalender', 'Pengaturan']) {
      expect(within(nav).getByRole('link', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Chat baru' })).toBeInTheDocument();
    expect(screen.getByText('Terbaru')).toBeInTheDocument();
  });

  it('switches the language in Settings at once, and saves it', async () => {
    render(<SettingsScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    const group = screen.getByRole('tablist', { name: 'Language' });
    await userEvent.click(within(group).getByRole('tab', { name: 'Bahasa Indonesia' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Pengaturan' })).toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'id' });
    expect(useApp.getState().settings?.uiLanguage).toBe('id');
    expect(document.documentElement.lang).toBe('id');
    // The section names follow too.
    expect(screen.getByRole('tab', { name: 'Default video' })).toBeInTheDocument();
    // and back, with no restart
    await userEvent.click(within(screen.getByRole('tablist', { name: 'Bahasa' })).getByRole('tab', { name: 'English' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });

  it('keeps the new language when saving fails', async () => {
    vi.mocked(updateSettings).mockRejectedValue(new Error('disk full'));
    render(<SettingsScreen />);
    await userEvent.click(within(screen.getByRole('tablist', { name: 'Language' })).getByRole('tab', { name: 'Bahasa Indonesia' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Pengaturan' })).toBeInTheDocument();
  });

  it('has an EN / ID toggle on the welcome screen', async () => {
    useApp.setState({ route: { name: 'welcome' } });
    render(<Welcome />);
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'ID' }));
    expect(await screen.findByRole('button', { name: 'Mulai' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Video motion graphic,tanpa pusing nulis prompt.');
    expect(screen.getByRole('button', { name: 'ID' })).toHaveAttribute('aria-pressed', 'true');
    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'id' });
    expect(document.documentElement.lang).toBe('id');
  });

  it('writes activity summaries in Indonesian', () => {
    const tool = (n: string, kind: string, status = 'done') =>
      ({ type: 'tool', toolCallId: n, title: `${kind} ${n}`, toolKind: kind, status }) as ActivityItem;
    const items = [tool('1', 'execute'), tool('2', 'execute'), tool('3', 'edit', 'failed')];
    expect(summarize(items).segments).toEqual(['Ran 2 commands', 'edited 1 file']);
    setUiLanguage('id');
    expect(summarize(items).segments).toEqual(['Menjalankan 2 perintah', 'mengubah 1 file']);
    render(<ActivityGroup items={items} live={false} />);
    expect(screen.getByRole('button', { name: 'Menjalankan 2 perintah · mengubah 1 file · 1 gagal' })).toBeInTheDocument();
  });

  it('writes relative times in Indonesian', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    expect(ago('2026-11-04T10:00:00Z', now)).toBe('2h ago');
    setUiLanguage('id');
    expect(locale()).toBe('id-ID');
    expect(ago('2026-11-04T11:59:40Z', now)).toBe('sekarang');
    expect(ago('2026-11-04T11:55:00Z', now)).toBe('5 mnt lalu');
    expect(ago('2026-11-04T10:00:00Z', now)).toBe('2 jam lalu');
    expect(ago('2026-11-03T08:00:00Z', now)).toBe('kemarin');
    expect(ago('2026-10-30T12:00:00Z', now)).toBe('30 Okt');
    expect(formatResetIn('2026-11-04T13:41:00Z', now)).toBe('1 j 41 mnt');
    expect(formatResetIn('2026-11-08T02:00:00Z', now)).toBe('3 hr 14 j');
  });
});

describe('saved text', () => {
  it('is saved in English and said in the active language', () => {
    const note = stored('chat.switched', { name: 'Gemini CLI' });
    expect(note).toBe("Switched to Gemini CLI. It starts fresh and doesn't see the earlier messages.");
    expect(localized(note)).toBe(note);
    setUiLanguage('id');
    expect(localized(note)).toBe('Beralih ke Gemini CLI. Agen ini mulai dari nol dan tidak melihat pesan sebelumnya.');
    expect(localized(CLOSED_NOTE)).toBe(id.agents.closedNote);
    expect(localized(stored('chat.ranWithoutAsking', { what: 'npm test' }))).toBe('Dijalankan tanpa minta izin: npm test');
  });

  it('translates a saved text inside another, and leaves anything else alone', () => {
    setUiLanguage('id');
    const nested = stored('chat.templateProblem', { problem: stored('chat.templateGone') });
    expect(localized(nested)).toBe('Template belum bisa disiapkan: gaya itu sudah tidak ada di koleksimu. Lanjut tanpa template.');
    expect(localized('Kenapa rupiah melemah?')).toBe('Kenapa rupiah melemah?');
    expect(localized('Couldn’t reach the agent (code 7)')).toBe('Couldn’t reach the agent (code 7)');
  });

  it('only rewrites parameters that can be saved text', () => {
    setUiLanguage('id');
    expect(localized(stored('chat.settingTemplate', { name: 'Cancelled' }))).toBe('Menyiapkan template Cancelled…');
    expect(localized(stored('chat.ranWithoutAsking', { what: 'Cancelled' }))).toBe('Dijalankan tanpa minta izin: Cancelled');
  });

  it('keeps English as it is when the interface is English', () => {
    expect(i18n.language).toBe('en');
    expect(localized(CLOSED_NOTE)).toBe(CLOSED_NOTE);
  });
});

it('re-renders without a restart', async () => {
  render(<Sidebar active="chat" />);
  expect(screen.getByText('Recent')).toBeInTheDocument();
  await act(async () => setUiLanguage('id'));
  expect(screen.getByText('Terbaru')).toBeInTheDocument();
});

describe('tool names and details', () => {
  it('are said by tool id, and unknown ones pass through', () => {
    const tool = { id: 'chrome', name: 'Chrome browser', detail: 'Draws each frame of your video' } as const;
    expect(toolName(tool)).toBe('Google Chrome');
    setUiLanguage('id');
    expect(toolName(tool)).toBe('Google Chrome');
    expect(toolDetail({ id: 'chrome', detail: 'Draws each frame of your video' })).toBe('Menggambar setiap frame sebelum di-encode');
    const unknown = { id: 'newtool', name: 'New tool', detail: 'Does a thing' } as unknown as typeof tool;
    expect(toolName(unknown)).toBe('New tool');
    expect(toolDetail(unknown)).toBe('Does a thing');
  });

  it('shows the translated row without the Rust detail', () => {
    setUiLanguage('id');
    render(
      <ToolRow
        tool={{ id: 'chrome', name: 'Google Chrome', required: true, found: false, version: null, ok: false, detail: 'Draws each frame of your video' }}
        sys={{ os: 'linux', osVersion: '1', packageManager: 'apt' }}
        agentName="Claude Code"
        busy={false}
        onInstall={() => {}}
      />,
    );
    expect(screen.getByText('Menggambar setiap frame sebelum di-encode')).toBeInTheDocument();
    expect(screen.queryByText('Draws each frame of your video')).toBeNull();
  });
});
