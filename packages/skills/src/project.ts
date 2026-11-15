import { slugify, type Project, type Settings, type Style, type VideoLanguage } from '@tayang/shared';
import { AI_ASSETS_RULE, FOREGROUND_RULE, POST_RULE, RENDERS_RULE, STYLE_REFS_DIR, frameCheckPrompt } from './frameCheck';

const LANGUAGE: Record<VideoLanguage, string> = { id: 'Indonesian', en: 'English' };

/** Sent before a project chat's prompt when the frame check is turned off in Settings. */
export const SKIP_FRAME_CHECK = 'Skip the frame check this time.';

const NOTE_LABELS: [keyof Style['notes'], string][] = [
  ['camera', 'Camera'],
  ['pacing', 'Pacing'],
  ['type', 'Type'],
  ['color', 'Color'],
  ['captions', 'Captions'],
  ['transitions', 'Transitions'],
];

/** The style's prompt followed by one `Label: note` line per non-empty aspect. */
/** Where Tayang copies a style's reference frames in the project: style-refs/<file name>. */
export const projectRefs = (style: Style | null): string[] =>
  (style?.references ?? []).map((p) => `${STYLE_REFS_DIR}/${p.split(/[\\/]/).pop()}`);

function styleSection(style: Style): string {
  const notes = NOTE_LABELS.flatMap(([k, label]) => {
    const v = style.notes[k]?.trim();
    return v ? [`${label}: ${v}`] : [];
  });
  const refs = projectRefs(style);
  return [
    `Style: ${style.name}`,
    style.prompt,
    ...notes,
    ...(style.build?.trim() ? [`How to build this look: ${style.build.trim()}`] : []),
    ...(style.palette?.length ? [`Palette: ${style.palette.join(', ')}`] : []),
    ...(refs.length
      ? [
          `Reference contact sheets: ${refs.join(', ')}. Each is a 4x3 grid of frames from the source video in time order (left to right, top to bottom); together they show the whole video. Open them all before you start and keep them open: your frames must look like them (rendering technique, characters, palette, lighting, camera, captions, pacing). Match the look, never copy their content.`,
        ]
      : []),
  ].join('\n');
}

/** The project's AGENTS.md. The quality loop is only included when `settings.frameCheck` is on. */
export function buildProjectBrief(
  p: Project,
  style: Style | null,
  settings: Pick<Settings, 'fps' | 'frameCheck'>,
): string {
  const template = !!style?.template;
  // A copied style decides its own engine; only a template's own toolchain overrides it.
  const remotion = !template && style?.engine === 'remotion';
  const lines = [
    `# ${p.title}`,
    '',
    '## Project',
    `- Kind: ${p.kind}`,
    `- Format: ${p.format}, ${settings.fps} fps`,
    `- Video language: ${LANGUAGE[p.language]}. All on-screen text and voice-over are in ${LANGUAGE[p.language]}.`,
    '',
    '## How to work',
    template
      ? '- Follow STYLE.md for the toolchain; install and render with the commands in tayang.json.'
      : remotion
        ? '- Build it with Remotion in this folder (set it up with npm if it is not there yet, with @remotion/cli installed locally, and the entry point at src/index.ts). For a 3D look add three and @remotion/three and build the world in three.js inside Remotion. Register the composition you render first in the root: Tayang\'s live preview plays the first one, so the user can watch the video before it is rendered.'
        : '- Use HyperFrames (`npx hyperframes`) to build and render the video.',
    '- Keep all files in this folder. Do not write outside it.',
    `- ${FOREGROUND_RULE}`,
    `- ${RENDERS_RULE}`,
    `- ${POST_RULE}`,
    `- ${AI_ASSETS_RULE}`,
    ...(template
      ? ['- When a version is ready, render it with the command in tayang.json so Tayang can show it.']
      : remotion
        ? [
            `- When a version is ready, render it with \`npx remotion render <entry> <composition> renders/${p.slug || slugify(p.title)}-<n>.mp4\` so Tayang can show it.`,
          ]
        : [
            `- When a version is ready, render it with \`npx -y hyperframes@0.9.10 render --output renders/${p.slug || slugify(p.title)}-<n>.mp4\` so Tayang can show it.`,
          ]),
    '',
    '## Style',
    style ? styleSection(style) : 'No style selected. Choose a clean, readable look and keep it consistent.',
    ...(style?.template
      ? [
          '',
          `This project starts from the ${style.name} template. Read STYLE.md first, then run the install command in tayang.json once. Render with the command in tayang.json.`,
        ]
      : []),
    '',
    ...(settings.frameCheck
      ? ['## Quality loop', frameCheckPrompt({ engine: style?.engine === 'remotion' ? 'remotion' : 'hyperframes', references: projectRefs(style).length > 0 }), '']
      : []),
  ];
  return lines.join('\n');
}
