import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSessionPreamble, languageHint, sessionFacts } from '../src/preamble';
import { AUTOPILOT_RENDER_NOW, buildAutopilotBuildPrompt } from '../src/autopilot';
import { FOREGROUND_RULE, LAYERS_RULE, RENDERS_RULE, SHEET_STEP, frameCheckPrompt } from '../src/frameCheck';
import { buildProjectBrief } from '../src/project';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-plugin');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('no frontmatter');
  return Object.fromEntries(
    m[1]!.split('\n').map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}

describe('agent plugin', () => {
  it('has a valid manifest', () => {
    expect(JSON.parse(read('.claude-plugin/plugin.json'))).toEqual({
      name: 'tayang-studio',
      description: 'Skills for agents running inside Tayang Studio',
      version: '0.1.0',
    });
  });

  it.each(['tayang-studio'])('%s SKILL.md has valid frontmatter', (name) => {
    const fm = frontmatter(read(`skills/${name}/SKILL.md`));
    expect(fm.name).toBe(name);
    expect(fm.description!.length).toBeGreaterThan(20);
  });

  it('tayang-studio description names the env flag', () => {
    const fm = frontmatter(read('skills/tayang-studio/SKILL.md'));
    expect(fm.description).toContain('TAYANG_STUDIO=1');
    expect(read('skills/tayang-studio/SKILL.md')).toContain('[tayang:frames-checked]');
    // Settings can turn the check off: the skill must give way to the brief or the message.
    expect(read('skills/tayang-studio/SKILL.md')).toContain(
      'unless the project brief or the message says to skip the frame check',
    );
  });

  it('asks for choices with the agent\'s own question tool, never A2UI or JSON', () => {
    const t = read('skills/tayang-studio/SKILL.md');
    expect(t).toContain('## Choices');
    expect(t).toContain('AskUserQuestion');
    expect(t).toContain('Never write JSON or markup for a choice.');
    expect(t).not.toMatch(/a2ui/i);
    expect(t).toContain('$TAYANG_AI_URL/video');
  });

  it('preamble contains the skill without frontmatter, and no A2UI', () => {
    const p = buildSessionPreamble();
    expect(p).toContain('# Tayang Studio');
    expect(p).not.toMatch(/a2ui|createSurface/i);
    expect(p.startsWith('---')).toBe(false);
  });

  it('adds the Indonesian hint only for the id language', () => {
    expect(buildSessionPreamble('id')).toContain('The user reads Indonesian. Reply in Indonesian unless they write in another language.');
    expect(buildSessionPreamble('en')).not.toContain('The user reads Indonesian');
    expect(buildSessionPreamble()).not.toContain('The user reads');
    expect(languageHint('id')).toContain('Keep code, commands and file names as they are.');
    expect(languageHint('en')).toBe('');
  });

  it('teaches scheduling through POST /schedule, also in the text preamble', () => {
    const t = read('skills/tayang-studio/SKILL.md');
    expect(t).toContain('## Scheduling videos');
    expect(t).toContain('Never say a video is scheduled until the user has confirmed it');
    // The example request is valid: its JSON parses and every time has an offset.
    const call = /\$TAYANG_AI_URL\/schedule.*?-d '(\{.*?\})'/.exec(t.slice(t.indexOf('## Scheduling videos')))![1]!;
    const body = JSON.parse(call);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) expect(item.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(buildSessionPreamble()).toContain('## Scheduling videos');
  });

  it("states the user's time zone and the project id", () => {
    const facts = { timeZone: 'Asia/Jakarta', offset: '+07:00', localNow: 'Wednesday 2026-11-04 17:55' };
    expect(sessionFacts(facts)).toBe(
      "The user's local time zone is Asia/Jakarta (UTC+07:00). It was Wednesday 2026-11-04 17:55 when this chat started.",
    );
    expect(sessionFacts({ ...facts, projectId: 'p1' })).toContain("\nThis video's Tayang id is p1.");
    expect(sessionFacts(null)).toBe('');
    expect(buildSessionPreamble('en', { ...facts, projectId: 'p1' })).toContain("This video's Tayang id is p1.");
    expect(buildSessionPreamble('en')).not.toContain('time zone is');
  });

  it('tells every agent to run long work in the foreground, wherever it gets its instructions', () => {
    expect(FOREGROUND_RULE).toContain('Never start a long job in the background and end your turn');
    expect(FOREGROUND_RULE).toContain('`2>&1 | tail -n 30`');
    expect(read('skills/tayang-studio/SKILL.md')).toContain(FOREGROUND_RULE);
    expect(buildSessionPreamble()).toContain(FOREGROUND_RULE);
    expect(buildAutopilotBuildPrompt('Jalur Rempah', 30)).toContain(FOREGROUND_RULE);
    expect(AUTOPILOT_RENDER_NOW).toContain(FOREGROUND_RULE);
    const p = { id: 'p', title: 'T', slug: 't', folder: '/w/t', kind: 'explainer', format: '9:16', language: 'id', status: 'draft',
      styleId: null, scheduledAt: null, reviewState: 'none', postedAt: null, remindedAt: null, reviewRemindedAt: null,
      durationSec: null, createdAt: '', updatedAt: '' } as const;
    expect(buildProjectBrief(p, null, { fps: 30, frameCheck: false })).toContain(FOREGROUND_RULE);
  });

  it('has the agent start a new video asked for in a plain chat through /video, not build it there', () => {
    const skill = read('skills/tayang-studio/SKILL.md');
    expect(skill).toContain('your folder has no `AGENTS.md`');
    expect(skill).toContain('never build it here');
    expect(buildSessionPreamble()).toContain('never build it here');
  });

  it('sends an autopilot request to Tayang\'s setup chat instead of scheduling videos', () => {
    const skill = read('skills/tayang-studio/SKILL.md');
    expect(skill).toContain('$TAYANG_AI_URL/autopilot-chat');
    expect(skill).toContain('never plan or schedule the videos yourself');
  });

  it('has the agent look at one contact sheet of the stills, not each still, wherever it gets its instructions', () => {
    expect(SHEET_STEP).toContain('tile=4x3');
    expect(SHEET_STEP).toContain('stills/scene-%02d.png');
    expect(read('skills/tayang-studio/SKILL.md')).toContain(`2. ${SHEET_STEP}`);
    expect(frameCheckPrompt()).toContain(`2. ${SHEET_STEP}`);
    expect(frameCheckPrompt({ engine: 'remotion' })).toContain('stills/scene-01.png');
  });

  it('tells every agent to write the voice and subtitle layers, wherever it gets its instructions', () => {
    expect(LAYERS_RULE).toContain('.tayang/layers.json');
    expect(LAYERS_RULE).toContain('"captions": [{"start": <seconds>, "end": <seconds>, "text":');
    expect(read('skills/tayang-studio/SKILL.md')).toContain(LAYERS_RULE);
    expect(buildSessionPreamble()).toContain(LAYERS_RULE);
    expect(buildAutopilotBuildPrompt('Jalur Rempah', 30)).toContain(LAYERS_RULE);
    const p = { id: 'p', title: 'T', slug: 't', folder: '/w/t', kind: 'explainer', format: '9:16', language: 'id', status: 'draft',
      styleId: null, scheduledAt: null, reviewState: 'none', postedAt: null, remindedAt: null, reviewRemindedAt: null,
      durationSec: null, createdAt: '', updatedAt: '' } as const;
    expect(buildProjectBrief(p, null, { fps: 30, frameCheck: false })).toContain(LAYERS_RULE);
  });

  it('tells every agent to leave the final mp4 in renders/, wherever it gets its instructions', () => {
    expect(RENDERS_RULE).toBe(
      "When the video is finished, make sure the final mp4 is in the project's renders/ folder (copy it there if your pipeline writes it elsewhere). Tayang's preview and status read it from there.",
    );
    expect(read('skills/tayang-studio/SKILL.md')).toContain(RENDERS_RULE);
    expect(buildSessionPreamble()).toContain(RENDERS_RULE);
    expect(buildAutopilotBuildPrompt('Jalur Rempah', 30)).toContain(RENDERS_RULE);
    expect(AUTOPILOT_RENDER_NOW).toContain(RENDERS_RULE);
    const p = { id: 'p', title: 'T', slug: 't', folder: '/w/t', kind: 'explainer', format: '9:16', language: 'id', status: 'draft',
      styleId: null, scheduledAt: null, reviewState: 'none', postedAt: null, remindedAt: null, reviewRemindedAt: null,
      durationSec: null, createdAt: '', updatedAt: '' } as const;
    // With and without a template (a template's pipeline may write elsewhere).
    expect(buildProjectBrief(p, null, { fps: 30, frameCheck: false })).toContain(RENDERS_RULE);
    const tmpl = { id: 's', name: 'Atlas', notes: {}, template: { url: 'x' } } as never;
    expect(buildProjectBrief(p, tmpl, { fps: 30, frameCheck: true })).toContain(RENDERS_RULE);
  });
});
