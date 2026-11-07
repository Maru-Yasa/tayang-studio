import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_RENDER_NOW,
  AUTOPILOT_TOPIC_RETRY,
  buildAutopilotBuildPrompt,
  buildAutopilotChatPrompt,
  buildAutopilotTopicPrompt,
  buildTopicIdeasPrompt,
  parseAutopilotTopic,
} from '../src';

const base = {
  niche: 'Home coffee brewing tips',
  style: { name: 'Atlas journey', prompt: 'Animated maps with routes' },
  language: 'id' as const,
  lengthSec: 45,
  previousTitles: ['Why espresso is bitter', 'Pour-over in 60 seconds'],
};

describe('buildAutopilotTopicPrompt', () => {
  const p = buildAutopilotTopicPrompt(base);

  it('asks for exactly one topic for the niche, style, language and length', () => {
    expect(p).toMatch(/exactly ONE topic/);
    expect(p).toContain('"Home coffee brewing tips"');
    expect(p).toContain('Atlas journey');
    expect(p).toContain('Animated maps with routes');
    expect(p).toContain('Indonesian');
    expect(p).toContain('45 seconds');
    expect(buildAutopilotTopicPrompt({ ...base, language: 'en' })).toContain('English');
  });

  it('keeps the motion-only rules of the topic ideas prompt', () => {
    const ideas = buildTopicIdeasPrompt(['data'], 'en');
    for (const rule of [/built entirely in code/, /Never suggest anything that needs filming/, /Facts must be real and checkable/]) {
      expect(ideas).toMatch(rule);
      expect(p).toMatch(rule);
    }
  });

  it('lists every earlier title as one to avoid', () => {
    expect(p).toContain('- Why espresso is bitter');
    expect(p).toContain('- Pour-over in 60 seconds');
    expect(p).toMatch(/not repeat/i);
    expect(buildAutopilotTopicPrompt({ ...base, previousTitles: [] })).toMatch(/no earlier titles/i);
  });

  it('asks for one json block with title, kind and lengthSec, and no tools', () => {
    expect(p).toContain('```json');
    expect(p).toContain('"title"');
    expect(p).toContain('"kind"');
    expect(p).toContain('"lengthSec": 45');
    expect(p).toMatch(/Do not use any tools/);
    expect(p).not.toContain('a2ui');
  });
});

describe('parseAutopilotTopic', () => {
  it('reads the json block', () => {
    expect(parseAutopilotTopic('Here:\n```json\n{"title":"Kenapa kopi pahit","kind":"explainer","lengthSec":45}\n```')).toEqual({
      title: 'Kenapa kopi pahit',
      kind: 'explainer',
      lengthSec: 45,
    });
  });

  it('reads a json block written on one line', () => {
    expect(parseAutopilotTopic('```json {"title":"One line","kind":"data","lengthSec":30}```')?.title).toBe('One line');
  });

  it('accepts bare json and a one-item array, trims the title', () => {
    expect(parseAutopilotTopic('{"title":"  A  ","kind":"data","lengthSec":30}')).toEqual({ title: 'A', kind: 'data', lengthSec: 30 });
    expect(parseAutopilotTopic('```json\n[{"title":"B","kind":"news","lengthSec":20}]\n```')?.title).toBe('B');
  });

  it('falls back to explainer and 30 seconds, and clamps the length', () => {
    expect(parseAutopilotTopic('```json\n{"title":"C","kind":"vlog"}\n```')).toEqual({ title: 'C', kind: 'explainer', lengthSec: 30 });
    expect(parseAutopilotTopic('```json\n{"title":"D","kind":"data","lengthSec":9999}\n```')?.lengthSec).toBe(600);
  });

  it('is null without a usable title', () => {
    for (const text of ['', 'no json here', '```json\n{"kind":"data"}\n```', '```json\n{"title":""}\n```', '```json\nnot json\n```', '```json\n[]\n```']) {
      expect(parseAutopilotTopic(text), text).toBeNull();
    }
  });
});

describe('buildAutopilotBuildPrompt', () => {
  it('walks the agent through script, build, render, frames and the rendered file', () => {
    const p = buildAutopilotBuildPrompt('Kenapa kopi pahit', 45, { language: 'id' });
    expect(p).toContain('"Kenapa kopi pahit"');
    expect(p).toContain('45 seconds');
    expect(p).toContain('Indonesian');
    expect(p).toMatch(/script/i);
    expect(p).toMatch(/tayang\.json/);
    expect(p).toMatch(/frames/i);
    expect(p).toMatch(/rendered file/i);
    expect(p).toMatch(/without asking/i);
  });

  it('leaves the frame check out when it is off', () => {
    expect(buildAutopilotBuildPrompt('T', 30, { frameCheck: false })).not.toMatch(/frames/i);
    expect(buildAutopilotBuildPrompt('T', 30)).toMatch(/frames/i);
  });
});

describe('follow-ups', () => {
  it('asks again for the json block, and asks to render now', () => {
    expect(AUTOPILOT_TOPIC_RETRY).toContain('```json');
    expect(AUTOPILOT_TOPIC_RETRY).toMatch(/earlier titles/);
    expect(AUTOPILOT_RENDER_NOW).toMatch(/^Render it now/);
    expect(AUTOPILOT_RENDER_NOW).toMatch(/tayang\.json/);
  });

  it('names the voice only when one is picked, and always asks for post.json', () => {
    const p = buildAutopilotBuildPrompt('T', 60, { voiceId: 'Rachel' });
    expect(p).toContain('"voice":"Rachel"');
    expect(p).toContain('post.json');
    expect(buildAutopilotBuildPrompt('T', 60)).not.toContain('"voice":');
  });
});

describe('buildAutopilotChatPrompt', () => {
  const input = {
    niches: [{ id: 'science', title: 'Science explained' }],
    voices: [{ id: 'Rachel', name: 'Rachel', description: 'Calm narrator' }],
    styles: [{ id: 'atlas', name: 'Atlas' }],
    accounts: [{ id: 'sa_1', platform: 'tiktok', username: 'oyen' }],
    language: 'id' as const,
  };

  it('gives the agent every option, in the language of the user, and the way to hand over', () => {
    const p = buildAutopilotChatPrompt(input);
    for (const part of ['science: Science explained', 'Rachel: Calm narrator', 'atlas: Atlas', 'sa_1: tiktok @oyen', 'Indonesian', '$TAYANG_AI_URL/autopilot', '45, 60 or 90', 'weekdays']) {
      expect(p).toContain(part);
    }
    expect(p).toMatch(/cannot start it yourself/);
  });

  it('says so when a list is empty, so the agent does not make ids up', () => {
    expect(buildAutopilotChatPrompt({ ...input, accounts: [] })).toContain('(none available)');
  });
});
