/**
 * What the agent writes, word for word in any language, once every still is clean. Tayang looks for it to
 * show the "frames checked" badge and hides it from the message.
 */
export const FRAMES_CHECKED_TOKEN = '[tayang:frames-checked]';

/** The old English phrase, still accepted for chats written before the token existed. */
const LEGACY_PHRASE = 'Frames checked';

export const hasFramesChecked = (text: string): boolean => text.includes(FRAMES_CHECKED_TOKEN) || text.includes(LEGACY_PHRASE);

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WRAPPED_TOKEN = new RegExp(`\`*${escapeRe(FRAMES_CHECKED_TOKEN)}\`*`, 'g');
/** Every proper prefix of the token, longest first, so a half-streamed one can be hidden. */
const PARTIAL_TOKEN = new RegExp(
  `\`*(?:${Array.from({ length: FRAMES_CHECKED_TOKEN.length - 1 }, (_, i) => escapeRe(FRAMES_CHECKED_TOKEN.slice(0, FRAMES_CHECKED_TOKEN.length - 1 - i))).join('|')})$`,
);

/**
 * The message as the reader sees it: the token is plumbing, also when the agent wraps it in
 * backticks, and also while it is still being typed at the end of streaming text.
 */
export const stripFramesToken = (text: string): string => {
  const whole = text.replace(WRAPPED_TOKEN, '');
  const cut = whole.replace(PARTIAL_TOKEN, '');
  if (cut === text) return text;
  return cut.replace(/(\S) {2,}/g, '$1 ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};

/** Agents can't speak after their turn ends: long work must run inside the turn, where Tayang shows it. */
export const FOREGROUND_RULE =
  "Never end your turn by saying what you will do next (\"I'll render it again\"): do it in the same turn. End your turn only when the work is done, or when you need the user to answer or allow something. Run installs, renders and pipelines in the foreground and wait for them to finish before you reply. Never start a long job in the background and end your turn: you can't message the user after your turn ends, and Tayang shows the user that you're still working while your turn runs. If a command needs more than a few minutes, say so first, then run it and wait. Keep command output short: use the command's quiet flag, or end a long install or render with `2>&1 | tail -n 30` and read those last lines for errors; progress bars and install logs only fill your context.";

/**
 * AI images and voiceover through Tayang, paid with the user's credits ($TAYANG_AI_URL and
 * $TAYANG_AI_TOKEN are set on every agent session; see the desktop's ai_proxy.rs).
 */
export const AI_ASSETS_RULE =
  'AI images and voice-over come from Tayang when the user has credits. Check them first: `curl -s "$TAYANG_AI_URL/usage" -H "Authorization: Bearer $TAYANG_AI_TOKEN"` (answers credits, imagesAffordable, voiceMinutesAffordable). ' +
  'When it says "ownVoice": true the user set up their own voice: every voice-over comes from /voice whatever the credits, and it costs none. ' +
  'With enough credits, a voice-over comes from Tayang\'s /voice and a picture you can\'t build in code from /image, not another text-to-speech (say, edge-tts, Piper, a pipeline\'s own TTS, a key of your own), stock photos or images from the web. ' +
  'Image: `curl -s -X POST "$TAYANG_AI_URL/image" -H "Authorization: Bearer $TAYANG_AI_TOKEN" -d \'{"prompt":"<what to draw, in English>","aspect":"9:16","out":"assets/<name>.jpg"}\'` (1 credit per image; aspect 9:16, 16:9 or 1:1; up to 4 with "count"). Voice: `curl -s -X POST "$TAYANG_AI_URL/voice" -H "Authorization: Bearer $TAYANG_AI_TOKEN" -d \'{"text":"<the narration>","language":"id","out":"audio/<name>.mp3"}\'` (about 7 credits per minute). The answer lists the saved files. ' +
  'Without enough credits (or signed out), make it the way you would without Tayang: a free voice such as the system\'s text-to-speech, and pictures built in code; tell the user once in one short line that Tayang\'s AI voice and images come with credits. Never drop the voice-over because of credits: only the user decides there is none. Text, charts and maps are always built in code.';

/** Tayang's preview and status read the render from renders/; a template pipeline may write it elsewhere. */
export const RENDERS_RULE =
  "When the video is finished, make sure the final mp4 is in the project's renders/ folder (copy it there if your pipeline writes it elsewhere). Tayang's preview and status read it from there.";

/** What to post with the video: Tayang's Post dialog reads post.json and the user reviews it. */
export const POST_RULE =
  `When a video is finished, and whenever the user asks for a post, write post.json in the project folder: {"title": "<up to 100 characters, a hook in the video's language>", "description": "<1 to 3 short lines in the video's language, no hashtags>", "hashtags": ["<3 to 5, without #>"], "scheduledAt": "<ISO 8601 with the user's UTC offset: the next good slot (11:00-13:00 or 19:00-21:00 local time) at least an hour from now; check the time with date>"}. Tayang's Post dialog fills its fields from it, and the user reviews it there. Never post yourself.`;

/**
 * Look at all stills as one small image instead of one full-size image each: a still costs the
 * agent as many tokens as a whole sheet. `%02d` instead of a glob, which Windows builds of ffmpeg lack.
 */
export const SHEET_STEP =
  'Put the stills on one contact sheet and look at that one image, not at each still: `ffmpeg -y -i stills/scene-%02d.png -vf "scale=360:-2,tile=4x3" -frames:v 1 stills/sheet.jpg` (more than 12 scenes: run it again with `-start_number 13` before `-i` and `stills/sheet-2.jpg` as the output). Look for overlapping elements, text that is cut off or outside the safe area, and timing that does not match the voice or captions. Open a single still only when the sheet shows a problem you need to see closer.';

/** Folder in a project where Tayang puts the style's reference frames. */
export const STYLE_REFS_DIR = 'style-refs';

/** The quality loop for the project's engine; with references, every still is held against them too. */
export function frameCheckPrompt(opts: { engine?: 'hyperframes' | 'remotion'; references?: boolean } = {}): string {
  const still =
    opts.engine === 'remotion'
      ? '1. Render a still of every scene with `npx remotion still` (one frame per scene)'
      : '1. Render a still of every scene with `npx hyperframes`';
  return [
    'Check the frames before you report this video as done.',
    `${still}, named in order: stills/scene-01.png, stills/scene-02.png, …`,
    `2. ${SHEET_STEP}`,
    ...(opts.references
      ? [
          `   Then make a contact sheet of your render the same way as the references (\`ffmpeg -i <your render> -vf "fps=12/<duration>,scale=320:-2,tile=4x3" -frames:v 1 renders/check-sheet.jpg\`) and look at it side by side with the contact sheets in ${STYLE_REFS_DIR}/: the same rendering technique, character design, palette, lighting, camera framing, caption style and pacing. Anything that looks different is a problem to fix.`,
        ]
      : []),
    '3. Fix every problem you find, then render the affected stills again and look at them.',
    `4. When all stills are clean, write ${FRAMES_CHECKED_TOKEN} exactly as shown, whatever language you reply in, then a one-line summary of what you fixed.`,
  ].join('\n');
}

/** The default (HyperFrames, no references) quality loop. */
export const FRAME_CHECK_PROMPT = frameCheckPrompt();

