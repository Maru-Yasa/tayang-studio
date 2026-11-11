import { describe, expect, it } from 'vitest';
import type { Project, Settings, Style, SystemInfo } from '@tayang/shared';
import {
  FRAME_CHECK_PROMPT,
  BUILTIN_SKILLS,
  userSkillsText,
  FRAMES_CHECKED_TOKEN,
  hasFramesChecked,
  stripFramesToken,
  buildInstallPrompt,
  buildProjectBrief,
  buildStudyStylePrompt,
  buildTopicIdeasPrompt,
  installCommands,
  NODE_DOWNLOAD_URL,
  CHROME_DOWNLOAD_URL,
  manualInstallUrl,
  needsSudo,
  parseStyleResult,
  parseTopicIdeas,
  topicIdeaFromAction,
  splitTopicJson,
} from '../src/index';

const mac: SystemInfo = { os: 'macos', osVersion: '26', packageManager: 'brew' };
const win: SystemInfo = { os: 'windows', osVersion: '11', packageManager: 'winget' };
const apt: SystemInfo = { os: 'linux', osVersion: '24.04', packageManager: 'apt' };

describe('install', () => {
  it('ffmpeg on mac', () => {
    const p = buildInstallPrompt('ffmpeg', mac, 'claude');
    expect(p).toContain('brew install ffmpeg');
    expect(p).toContain('ffmpeg -version');
    expect(p).toContain('reply with only the version you see');
  });
  it('ffmpeg on windows and linux', () => {
    expect(buildInstallPrompt('ffmpeg', win, 'claude')).toContain('winget install --id Gyan.FFmpeg -e');
    // Linux: a static build in ~/.local/bin, no sudo.
    const cmds = installCommands('ffmpeg', apt, 'claude');
    expect(cmds.join('\n')).toContain('~/.local/bin');
    expect(cmds.some((c) => c.includes('sudo'))).toBe(false);
    const p = buildInstallPrompt('ffmpeg', apt, 'claude');
    expect(p).toContain('without sudo');
    expect(p).toContain('ffprobe');
  });
  it('a Mac without Homebrew installs standalone binaries into ~/.local/bin', () => {
    const bare: SystemInfo = { os: 'macos', osVersion: '15', packageManager: null };
    for (const tool of ['ffmpeg', 'ytdlp'] as const) {
      const cmds = installCommands(tool, bare, 'claude');
      expect(cmds.join('\n')).toContain('~/.local/bin');
      expect(cmds.some((c) => c.includes('brew') || c.includes('sudo'))).toBe(false);
      expect(buildInstallPrompt(tool, bare, 'claude')).toContain('This Mac has no Homebrew');
    }
    expect(installCommands('ytdlp', bare, 'claude')).toContain(
      'curl -L -o ~/.local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
    );
    expect(installCommands('elevenlabs-mcp', bare, 'claude')[0]).toBe('curl -LsSf https://astral.sh/uv/install.sh | sh');
  });
  it('linux sudo installs are handed to the user', () => {
    expect(needsSudo('chrome', apt)).toBe(true);
    expect(needsSudo('ffmpeg', apt)).toBe(false);
    expect(installCommands('ytdlp', apt, 'claude')).toEqual(['pipx install yt-dlp']);
    const p = buildInstallPrompt('chrome', apt, 'claude');
    expect(p).toContain('Do not run sudo yourself');
    expect(p).toContain('Ask the user to run this command in their own terminal');
    expect(p).toContain('sudo apt install -y chromium');
  });
  it('other tools', () => {
    expect(installCommands('ytdlp', mac, 'claude')).toEqual(['brew install yt-dlp']);
    expect(installCommands('node', mac, 'claude')).toEqual(['brew install node@22']);
    expect(installCommands('chrome', win, 'claude')).toEqual(['winget install --id Google.Chrome -e']);
    expect(installCommands('chrome', apt, 'claude')).toEqual(['sudo apt install -y chromium']);
    expect(NODE_DOWNLOAD_URL).toBe('https://nodejs.org/en/download');
  });
  it('the user installs Node, and Chrome on a Mac without Homebrew, from the download page', () => {
    const bare: SystemInfo = { os: 'macos', osVersion: '15', packageManager: null };
    expect(manualInstallUrl('node', mac)).toBe(NODE_DOWNLOAD_URL);
    expect(manualInstallUrl('chrome', bare)).toBe(CHROME_DOWNLOAD_URL);
    expect(CHROME_DOWNLOAD_URL).toBe('https://www.google.com/chrome/');
    expect(installCommands('chrome', bare, 'claude')).toEqual([]);
    expect(manualInstallUrl('chrome', mac)).toBeNull();
    expect(manualInstallUrl('chrome', apt)).toBeNull();
    expect(manualInstallUrl('ffmpeg', bare)).toBeNull();
  });
  it('elevenlabs', () => {
    expect(installCommands('elevenlabs-mcp', mac, 'claude')).toEqual([
      'brew install uv',
      'claude mcp add -s user elevenlabs -e ELEVENLABS_API_KEY=sk_•••• -- uvx elevenlabs-mcp',
    ]);
    const p = buildInstallPrompt('elevenlabs-mcp', mac, 'claude', { elevenLabsKey: 'sk_real' });
    expect(p).toContain('ELEVENLABS_API_KEY=sk_real');
    // User scope, so the server works in every project folder, not just the setup folder.
    expect(p).toContain('claude mcp add -s user elevenlabs');
    expect(p).not.toContain('version');
  });
  it('elevenlabs for every other agent goes into its own user-level config', () => {
    const prompt = (agent: Parameters<typeof buildInstallPrompt>[2]) =>
      buildInstallPrompt('elevenlabs-mcp', mac, agent, { elevenLabsKey: 'sk_real' });
    expect(prompt('codex')).toContain('codex mcp add elevenlabs --env ELEVENLABS_API_KEY=sk_real -- uvx elevenlabs-mcp');
    expect(installCommands('elevenlabs-mcp', mac, 'codex')[1]).toBe(
      'codex mcp add elevenlabs --env ELEVENLABS_API_KEY=sk_•••• -- uvx elevenlabs-mcp',
    );
    const oc = prompt('opencode');
    expect(oc).toContain('opencode mcp add --global --env ELEVENLABS_API_KEY=sk_real elevenlabs -- uvx elevenlabs-mcp');
    expect(oc).toContain('~/.config/opencode/opencode.json');
    expect(oc).toContain('"elevenlabs": {"type":"local","command":["uvx","elevenlabs-mcp"],"environment":{"ELEVENLABS_API_KEY":"sk_real"},"enabled":true}');
    const api = prompt('custom');
    expect(api).toContain('OPENCODE_CONFIG_DIR');
    expect(api).toContain('under `mcp`');
    expect(api).not.toContain('opencode mcp add');
    const standard = '"elevenlabs": {"command":"uvx","args":["elevenlabs-mcp"],"env":{"ELEVENLABS_API_KEY":"sk_real"}}';
    expect(prompt('gemini')).toContain('~/.gemini/settings.json');
    expect(prompt('gemini')).toContain(standard);
    expect(prompt('antigravity')).toContain('~/.gemini/antigravity/mcp_config.json');
    expect(prompt('antigravity')).toContain(standard);
    // The masked key never reaches the agent, the real one never reaches the screen.
    for (const a of ['claude', 'codex', 'opencode', 'gemini', 'antigravity', 'custom'] as const) {
      expect(prompt(a)).not.toContain('sk_••••');
      expect(installCommands('elevenlabs-mcp', mac, a).join(' ')).not.toContain('sk_real');
    }
  });
});

describe('topics', () => {
  it('parses a json block', () => {
    const t = 'Here:\n```json\n[{"title":"A","kind":"promo","lengthSec":30},{"title":"B","kind":"quote","lengthSec":15},{"title":"C","kind":"news","lengthSec":45}]\n```';
    expect(parseTopicIdeas(t)).toHaveLength(3);
    expect(parseTopicIdeas('nothing')).toEqual([]);
    expect(parseTopicIdeas('```json\n{bad\n```')).toEqual([]);
  });
  it('prompt asks for 3 ideas through the agent\'s question tool, then POST /video, with the motion-only rules', () => {
    const p = buildTopicIdeasPrompt(['promo'], 'id');
    expect(p).toContain('exactly 3');
    expect(p).toContain('AskUserQuestion');
    expect(p).toContain('$TAYANG_AI_URL/video');
    expect(p).toContain('lengthSec');
    expect(p).toContain('styleId');
    expect(p).toMatch(/one short, friendly sentence in Indonesian/);
    expect(p).toMatch(/Never suggest anything that needs filming/);
    expect(p).toMatch(/Never write JSON or markup for the choice/);
    expect(p).not.toContain('a2ui');
    expect(p).not.toContain('```json');
  });
  it('prompt lists the given styles, or the three defaults', () => {
    const p = buildTopicIdeasPrompt(['promo'], 'en', [{ id: 'x-style', name: 'X style' }]);
    expect(p).toContain('x-style');
    expect(p).toContain('X style');
    expect(p).toContain('English');
    const d = buildTopicIdeasPrompt(['promo'], 'en');
    expect(d).toContain('atlas-journey');
    expect(d).toContain('Cartoon 3D what-if');
    expect(buildTopicIdeasPrompt(['promo'], 'en', [])).toContain('cartoon-3d-world');
  });
  it('topicIdeaFromAction reads a pick_topic context', () => {
    expect(topicIdeaFromAction({ title: 'T', kind: 'explainer', lengthSec: 30, styleId: 'atlas-journey' })).toEqual({
      title: 'T', kind: 'explainer', lengthSec: 30, styleId: 'atlas-journey',
    });
    expect(topicIdeaFromAction({ title: 'T', kind: 'nope' })).toMatchObject({ kind: 'explainer', lengthSec: 30 });
    expect(topicIdeaFromAction({ kind: 'promo' })).toBeNull();
    // What the user asked for rides along, trimmed and capped; empty notes are left out.
    expect(topicIdeaFromAction({ title: 'T', notes: '  no voice-over  ' })!.notes).toBe('no voice-over');
    expect(topicIdeaFromAction({ title: 'T', notes: '' })).not.toHaveProperty('notes');
    expect(topicIdeaFromAction({ title: 'T', notes: 'x'.repeat(2000) })!.notes).toHaveLength(600);
    // An agent can't ask for a 1-second or a 3-hour video.
    expect(topicIdeaFromAction({ title: 'T', lengthSec: 1 })!.lengthSec).toBe(5);
    expect(topicIdeaFromAction({ title: 'T', lengthSec: 10800 })!.lengthSec).toBe(600);
    expect(topicIdeaFromAction({ title: 'T', lengthSec: '45' })!.lengthSec).toBe(45);
    expect(parseTopicIdeas('```json\n[{"title":"A","kind":"promo","lengthSec":9999}]\n```')[0]!.lengthSec).toBe(600);
  });
  it('splitTopicJson hides a json block that parses as topic ideas', () => {
    const j = '```json\n[{"title":"A","kind":"promo","lengthSec":30}]\n```';
    expect(splitTopicJson(`Halo\n${j}`)).toEqual({ text: 'Halo', ideas: [{ title: 'A', kind: 'promo', lengthSec: 30 }] });
    const other = 'x\n```json\n{"a":1}\n```';
    expect(splitTopicJson(other)).toEqual({ text: other, ideas: [] });
  });
});

describe('style', () => {
  it('parseStyleResult', () => {
    const ok = JSON.stringify({ name: 'X', notes: { camera: 'c' }, prompt: 'p' });
    expect(parseStyleResult(ok, 'https://x')).toMatchObject({ source: 'copied', sourceUrl: 'https://x', name: 'X' });
    expect(parseStyleResult(JSON.stringify({ name: 'X', notes: {} }), 'u')).toBeNull();
    expect(parseStyleResult('nope', 'u')).toBeNull();
  });
  it('study prompt', () => {
    const p = buildStudyStylePrompt('https://v', '/out');
    expect(p).toContain('yt-dlp');
    expect(p).toContain('`"/out/style.json"`');
  });
  it('study prompt downloads to a source.* file and leaves it for Tayang', () => {
    const p = buildStudyStylePrompt('https://v', '/Users/a b/x');
    expect(p).toContain('-o "/Users/a b/x/source.%(ext)s"');
    expect(p).toContain('-f "bv*[height<=1080]+ba/b[height<=1080]/b"');
    expect(p).toContain('Leave source.* in place; Tayang makes its own contact sheets and a short preview from it, then deletes it.');
    expect(p).not.toContain('Delete the downloaded video');
    expect(p).toContain('Copy the look, never the footage');
    expect(buildStudyStylePrompt('https://v', 'C:\\Users\\a b\\x')).toContain('-o "C:\\Users\\a b\\x\\source.%(ext)s"');
  });
  it('study prompt quotes folders with spaces', () => {
    const p = buildStudyStylePrompt('https://v', '/Users/a b/Tayang/.tayang/style-study/x');
    expect(p).toContain('into the folder `"/Users/a b/Tayang/.tayang/style-study/x"`');
    expect(p).toContain('Write `"/Users/a b/Tayang/.tayang/style-study/x/style.json"`');
    const w = buildStudyStylePrompt('https://v', 'C:\\Users\\a b\\x');
    expect(w).toContain('`"C:\\Users\\a b\\x\\style.json"`');
  });
});

const STYLE: Style = {
  id: 'copied-1',
  name: 'Bold explainer',
  source: 'copied',
  sourceUrl: null,
  notes: {},
  prompt: 'Navy background, white heavy sans.',
  createdAt: '2026-11-04T00:00:00Z',
};

describe('brief', () => {
  it('adds the template paragraph for template styles', () => {
    const project = { title: 'Promo', kind: 'promo', format: '9:16', language: 'id' } as Project;
    const t: Style = {
      ...STYLE,
      name: 'Atlas journey',
      source: 'builtin',
      engine: 'remotion',
      template: { sha256: 'a', size: 1, version: 1 },
    };
    const b = buildProjectBrief(project, t, { fps: 30, frameCheck: false });
    expect(b).toContain(
      'This project starts from the Atlas journey template. Read STYLE.md first, then run the install command in tayang.json once. Render with the command in tayang.json.',
    );
    expect(b).not.toContain('npx -y hyperframes');
    expect(b).not.toContain('Use HyperFrames');
    expect(b).toContain('Follow STYLE.md for the toolchain; install and render with the commands in tayang.json.');
    expect(buildProjectBrief(project, STYLE, { fps: 30, frameCheck: false })).not.toContain('template');
  });
  it('contains style prompt and Frames checked', () => {
    const project = { title: 'Promo', kind: 'promo', format: '9:16', language: 'id' } as Project;
    const settings = { fps: 30, frameCheck: true } as Settings;
    const b = buildProjectBrief(project, STYLE, settings);
    expect(b).toContain(STYLE.prompt);
    expect(b).toContain('[tayang:frames-checked]');
    expect(b).toContain(FRAME_CHECK_PROMPT);
    expect(b).toContain('npx hyperframes');
    expect(b).toContain(
      'When a version is ready, render it with `npx -y hyperframes@0.9.10 render --output renders/promo-<n>.mp4` so Tayang can show it.',
    );
    expect(FRAME_CHECK_PROMPT).toContain(FRAMES_CHECKED_TOKEN);
  });
  it('lists the style notes after the prompt, in order, skipping empty ones', () => {
    const project = { title: 'Promo', kind: 'promo', format: '9:16', language: 'id' } as Project;
    const styled: Style = {
      ...STYLE,
      notes: { transitions: 'Whip pans', camera: 'Slow push', color: '  ', pacing: 'Fast cuts' },
    };
    const b = buildProjectBrief(project, styled, { fps: 30, frameCheck: false });
    expect(b).toContain(
      'Style: Bold explainer\nNavy background, white heavy sans.\nCamera: Slow push\nPacing: Fast cuts\nTransitions: Whip pans',
    );
    expect(b).not.toContain('Color:');
    expect(buildProjectBrief(project, STYLE, { fps: 30, frameCheck: false })).toContain(
      'Style: Bold explainer\nNavy background, white heavy sans.\n',
    );
  });
  it('leaves out the frame check when it is off', () => {
    const project = { title: 'Promo', kind: 'promo', format: '9:16', language: 'id' } as Project;
    const b = buildProjectBrief(project, null, { fps: 30, frameCheck: false });
    expect(b).not.toContain(FRAME_CHECK_PROMPT);
    expect(b).not.toContain('Quality loop');
    expect(b).toContain('npx hyperframes');
  });
});

describe('frames-checked marker', () => {
  it('is found as the token or as the old English phrase, in any language around it', () => {
    expect(hasFramesChecked('Semua frame beres. [tayang:frames-checked]')).toBe(true);
    expect(hasFramesChecked('Frames checked, all good')).toBe(true);
    expect(hasFramesChecked('Semua frame sudah dicek')).toBe(false);
  });
  it('is stripped from what the reader sees', () => {
    expect(stripFramesToken(`${FRAMES_CHECKED_TOKEN}\nDua teks diperbaiki.`)).toBe('Dua teks diperbaiki.');
    expect(stripFramesToken('Frames checked, all good')).toBe('Frames checked, all good');
    expect(stripFramesToken('Selesai.\n\n[tayang:frames-checked]')).toBe('Selesai.');
  });
  it('leaves no empty code span when the agent wraps the token in backticks', () => {
    expect(stripFramesToken('Selesai `[tayang:frames-checked]` ya')).toBe('Selesai ya');
    expect(stripFramesToken('Selesai.\n\n`[tayang:frames-checked]`')).toBe('Selesai.');
    expect(stripFramesToken('Ok ``[tayang:frames-checked]``')).toBe('Ok');
  });
  it('hides a partial token at the very end of streaming text', () => {
    expect(stripFramesToken('Selesai. [tayang:fra')).toBe('Selesai.');
    expect(stripFramesToken('Selesai.\n`[tayang:frames-chec')).toBe('Selesai.');
    expect(stripFramesToken('Selesai. [')).toBe('Selesai.');
    expect(stripFramesToken('Selesai [tayang:other] kok')).toBe('Selesai [tayang:other] kok');
    expect(stripFramesToken('Array [1] x')).toBe('Array [1] x');
  });
});

describe('user skills', () => {
  const skill = (id: string, enabled: boolean) => ({ id, description: `Use for ${id}.\n  More.`, enabled, path: `/data/user-skills/skills/${id}/SKILL.md` });

  it('lists only the skills that are on, with where to read them', () => {
    const text = userSkillsText([skill('hooks', true), skill('off', false)]);
    expect(text).toContain('- hooks: Use for hooks. More. (/data/user-skills/skills/hooks/SKILL.md)');
    expect(text).not.toContain('off');
  });

  it('says nothing when none are on', () => {
    expect(userSkillsText([skill('off', false)])).toBe('');
  });

  it('shows the built-in skill with its description and no frontmatter', () => {
    const [builtin] = BUILTIN_SKILLS;
    expect(builtin.id).toBe('tayang-studio');
    expect(builtin.description).toMatch(/^Use whenever you are running inside Tayang Studio/);
    expect(builtin.body.startsWith('# Tayang Studio')).toBe(true);
  });
});
