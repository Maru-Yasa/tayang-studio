# Tayang Studio: design

Status: updated to match what was built on `feat/style-popup`, 2026-11-04. Design canvas: https://claude.ai/artifact/YQ5VdN8VyaRqaHq8hYBD1h

Lines marked **(my call)** were decided by Claude while designing and are open to change. Lines marked **(owner decision)** record a later owner ruling. Everything else was decided by the owner.

## Why

Many Indonesian creators need motion design for TikTok, Reels and Shorts but struggle to make it. They're new to Claude and AI agents and don't know how to prompt, so a blank chat box gives them nothing to start from.

Tayang Studio is a free, open-source desktop app that guides them from idea to finished motion video. It picks topics, writes scripts and handles the prompting, while the user's own AI agent does the building. It also promotes tayang.app, which sells the paid features (see Money).

## Goals

- A creator who has never prompted an AI makes a finished motion video they would actually post.
- Works with the agent the user already has: Claude Code, opencode, Gemini CLI, Codex or any agent that speaks ACP.
- Runs on macOS, Windows and Linux.
- Free to use. Paid features come later through tayang.app.

## Non-goals

- **Not a video editor.** No multi-track timeline, keyframes or clip trimming. The user watches a preview and talks to the agent.
- Not a general Claude Code shell. Coding-agent features that don't serve making a video stay hidden.
- No AI built into Tayang itself. All generation and every install runs through the user's agent.

## Anti-goals

These would make it a failure even if it worked technically:

- The user has to write a prompt to get a decent result.
- The user sees broken output (overlapping text, cut-off captions) that the agent could have caught.
- A command runs on the user's computer without them seeing and approving it first.
  - Exceptions, each told to the user where they decide **(owner decision)**: Auto mode for chats (opt-in in Settings and per chat), a style study (always auto), and autopilots (always auto: the wizard's Agent & review step, its summary and Settings › Agents say so). Installs always ask.
- It looks like a generic AI tool rather than Tayang.

## Constraints and architecture

**Repo:** one monorepo containing the desktop app and the backend. **(my call: the layout below, managed with pnpm workspaces)**

```
apps/
  desktop/     Tauri app: Rust backend in src-tauri/, web UI in src/
  api/         Hono app on Cloudflare Workers, deployed with wrangler
packages/
  shared/      Types and API contracts shared by desktop and api
  skills/      The prompts and skills Tayang gives the agent (styles, frame check, install recipes)
docs/
```

**Desktop (`apps/desktop`)**
- **Shell:** Tauri, on macOS, Windows and Linux.
- **Agent connection:** ACP (Agent Client Protocol) for every agent. Claude Code connects through its ACP adapter. The Rust side speaks ACP directly; there's an official crate, `agent-client-protocol`.
- **Storage:** local SQLite holds projects, chats, styles, the job queue and settings. **(my call: through `tauri-plugin-sql` or `rusqlite`)**
- **Working folder:** the user picks one folder in Settings, with a default like `~/Tayang` that the user can change. Each video project is a subfolder of it, and the agent's ACP session runs with that project folder as its working directory, so it only touches files there. **(interpreted from "set working directory"; the default path is my call)**
- **Interface language:** English and Indonesian **(owner decision)**. The first run follows the system language; Settings › General has a picker, and the agent is told to reply in Indonesian when the interface is. Text Tayang saves (system lines, job notes, slot errors) is stored in English and shown in the reader's language.
- **License:** open source.
- **Rendering engine:** HyperFrames (Apache-2.0), with Remotion acceptable. **(my call: HyperFrames first)**

**Backend (`apps/api`)**
- Hono on Cloudflare Workers, with a Cloudflare D1 database, deployed with wrangler.
- The owner will build it later. The desktop app has to work fully offline without it.
- Expected jobs **(my call)**:
  - tayang.app sign-in
  - checking which paid features an account has
  - syncing premium styles
  - Autopilot scheduling handoff
  - anonymous crash and usage reports, only if the user opts in

**Install analytics (owner request).** The desktop app sends one anonymous ping a day: a random install ID, the operating system (macOS, Windows or Linux), its version, the CPU architecture and the app version. The API counts installs, platforms, versions and 7/30-day active installs, readable by the owner through a token-protected `/v1/stats` endpoint or a wrangler script. No IP addresses, names, paths or video data are stored. It's on by default and can be turned off in Settings, which says exactly what is sent. **(on by default with a visible switch is my call)**

## Brand

Follow `niche-to-video/BRANDING.md`:

- **Logo and mascot:** Oyen. Use the outlined logo SVGs, never live text.
- **Colors:** ink `#141414` and orange `#F2470C`.
- **Fonts:** Plus Jakarta Sans for the interface, IBM Plex Mono for figures and meta, Lora for script text.
- **Texture:** the on-air dither, once per screen.
- **Oyen's expressions show job state:** wink = queued, sleepy = working, happy = done, surprised = error, default = idle or needs you.

Third-party agents and tools appear with their real logos: Claude, opencode, Gemini, OpenAI/Codex, Node.js, FFmpeg, ElevenLabs, Chrome.

Polished with the unslop skill by Damir Sokolovsky (@heydamir), CC BY 4.0:

- Neutral ink surfaces
- One orange action per screen
- Sentence case, except the brand's mono kicker above the hero headline and on the Autopilot card
- Weights 400 to 600, with 800 only for the onboarding hero
- 4px spacing grid
- 1.5 stroke icons

The copy says "this computer", never "this Mac".

## Screens

### Onboarding

Three steps, then the user lands in a new chat.

1. **Welcome:** brand banner layout.
2. **Connect your agent:** finds the agents installed on this computer, each with its real logo, and has a guided Claude Code install for beginners.
3. **Check your computer:** detects the operating system and package manager and checks each tool.
   - **Required:**
     - Node.js 22 or newer
     - FFmpeg
     - Chrome or Chromium to draw frames **(my call: Chrome is listed because HyperFrames renders through a browser; confirm against the HyperFrames docs)**
   - **Recommended:**
     - **ElevenLabs MCP,** looked up in the connected agent's MCP config. If it's missing, a warning says videos get captions and music but no voiceover.
     - **yt-dlp,** needed to copy a style from a video link.
   - "Start my first video" is disabled until every required tool is ready. Recommended ones can be added later in Settings.

**Installing goes through the agent.** Tayang never runs installers itself. When the user presses Install:

1. **Tayang asks the agent in plain words,** for example "Install FFmpeg on this computer with the system package manager, then confirm `ffmpeg -version` works."
2. **The agent picks the commands for this operating system:**
   - macOS: Homebrew, e.g. `brew install ffmpeg`
   - Windows: winget, e.g. `winget install Gyan.FFmpeg`
   - Linux: the distro's package manager, e.g. `apt install ffmpeg`
3. **Tayang shows exactly what the agent wants to run** (the request plus the commands) with "Allow and install" and Cancel. Nothing runs before Allow. This is the agent's own ACP permission request, shown in Tayang's interface.
4. **The agent runs the commands while Tayang shows progress** (sleepy Oyen and a short step log). It then checks the version, and the item turns ready with "Installed by Claude Code".
5. **If it fails,** the item shows surprised Oyen, the agent's own explanation, and two choices: "Ask the agent to fix it" or a manual install guide. **(my call)**

For the ElevenLabs MCP, Tayang first asks for an API key, stored only in the agent's MCP settings on this computer. The agent then installs `uv` if needed, runs `claude mcp add -s user elevenlabs -e ELEVENLABS_API_KEY=… -- uvx elevenlabs-mcp` (or the equivalent for another agent), and makes one test call.

### App

The app uses a sidebar with **Chat, Videos, Style, Autopilot, Agents, Calendar** and Settings.

#### Chat

There are two kinds of chat.

- **Video project chat.** It is tied to one video and always has that video as context. The user moves through five steps: Topic, Script, Style, Build, Render. Suggestions are clickable cards, and quick changes ("Faster pace", "Make it 15s") are one-click chips.
- **New chat.** It has no context. A video only becomes context when the user mentions it with `@`. Typing `@` opens a list of the user's videos (↑ ↓ to move, ↵ to attach), and the attached video shows as a chip in the message. The header reads "No video attached" or "1 video attached".

The right panel of a video project chat is a **preview, not an editor**:

- A 9:16 player with play and step one frame back or forward.
- **A custom frame scrubber.** A strip of frame thumbnails with a draggable handle. A tooltip shows the timecode and scene, and scene names sit under the strip. Unbuilt scenes are hatched and show sleepy Oyen when the playhead is on them. Keys: ← → step one frame, Shift + ← → step one second.
- **Send frame to chat.** Renders the exact frame to a PNG and attaches it to the next message as an image. It goes with the timecode, the frame number, the scene id and any spot the user marked on it.
- ~~**Mark a spot.**~~ Removed on 2026-11-05: the user found it unclear and didn't need it. A sent frame carries no marks; older messages with marks still show their count.
- **Rendering banner.** While the agent's render command or Tayang's own Render runs, a slim banner reads "Rendering video… 1m 20s" and the preview reloads the new render when it ends.

How the conversation reads (as built):

- **Markdown.** Agent prose renders as GFM Markdown, never raw HTML. Remote images stay alt text; links open outside the app, https and mailto only.
- **Activity line.** Tool calls and thoughts between text collapse into one muted line ("Thought process · Ran 3 commands · edited 2 files"), expandable to rows. Failed steps are marked, skill loads hidden; thoughts are stored with the chat.
- **Working line.** While a turn runs, the live reply always ends in "Working · 2m 10s"; a running activity line carries the time itself. While the agent's render runs it reads "Rendering video · 1m 20s" (render commands are spotted from tayang.json, HyperFrames, Remotion, npm/pnpm render and ffmpeg writing an MP4). The skills tell agents to run long jobs in the foreground, never in the background after the turn ends **(owner report)**.
- **Images in chat (owner request).** Images the agent makes in the project folder during a turn appear in its message as a strip of 96 px thumbnails (8, then "+N more") with a lightbox (arrows, Open in folder). They are stored with the message and never sent back to the agent.
- **Turn rail and scroll pill.** A rail of the user's turns replaces the scrollbar (hover shows the prompt, click jumps); a pill scrolls back to the latest message.
- **Auto mode.** A per-chat Auto toggle, defaulting to Settings. Claude switches its session to auto; other agents' requests are approved by Tayang one at a time. Turning it off fails closed (the session is stopped).

#### Videos

A grid of every video in the working folder, with tabs for All, In progress, Rendered and Scheduled. A card shows a pulsing "Rendering" chip while its video renders, and a Schedule button.

#### Style

Style is a **prompt library**. Each style is a prompt the agent follows for a look, plus a readable breakdown:

- Camera
- Pacing
- Type
- Color
- Captions
- Transitions

**Built-in styles come from the API (owner request).** The Hono API serves the built-in style list (D1 table `styles`) and each style's starter template and preview image (Cloudflare R2). The desktop app syncs that list into its SQLite cache when online and works from the cache offline. A style can carry a **starter template**: a clean copy of a working video project that Tayang unpacks into a new project's folder, so the agent starts from a proven format instead of a blank folder. Launch set **(content from the owner's own projects)**:
- **Atlas journey** — from `niche-to-video/prototype/geo`: a warm illustrated globe, one continuous camera flight, sprites that travel routes, word-by-word captions (Remotion + d3-geo).
- **Cartoon 3D world** — from `video/tayang-ch-02`: flat 2D characters in a painted three.js world (Remotion + three.js, the MIT-licensed `cartoon-3d-short` skill, CC0 Kenney assets).
- **Cartoon 3D what-if** — also from `video/tayang-ch-02` (short form, `InvisibleShort`): the "What if you…" Day 1 → Day 30 escalation with an on-screen overlay layer, every step a real fact. Long-form 16:9 waits (owner: focus on short form for now).
- Bold explainer, Kinetic quote and News recap are removed (owner request). Built-in styles are only the three template styles.
Templates never include `.env`, `node_modules`, renders, episodes or other private material. A template declares its engine and render command in `tayang.json`, and Render preview uses it. **(storage, packaging and render contract are my calls)**

Styles come from three places: **built in**, **copied from a video** and **yours**.

**Copy a style from a video.** The user pastes a TikTok, Instagram Reels or YouTube link. The agent then:

1. Downloads the video locally with yt-dlp.
2. Samples frames at scene changes plus a regular interval, about 48 frames. It measures cut lengths and the beat if there's music. **(my call: ffmpeg scene detection, frames sent to the agent as contact sheets to save tokens)**
3. Studies the frames with timestamps. It looks at camera movement (zoom, pan, shake), pacing (shot length, holds), type (family, weight, words per card, position), color, captions and transitions.
4. Writes a style: the breakdown plus a prompt the user can read and edit.
5. Deletes the downloaded video and frames, keeping only a 10-second silent preview clip and a poster frame on this computer (in the app data folder, never uploaded). Tayang copies the look, not the footage. The Style screen says exactly this **(owner decision)**.

**Style popup (as built).** A card opens a dialog with the style's looping silent preview (or its poster; static under reduced motion), its breakdown and prompt. A copied style without a local preview falls back to its YouTube thumbnail (from i.ytimg.com; the README's Privacy section says so).
- **Edit** (yours and copied): name, the six notes and the prompt.
- **Clone** (built-ins can't be edited): a copy that is yours, with `basedOn` pointing at the original. The clone installs its original's current template, or its own snapshot when the original is gone.
- **Delete** (not built-ins). A style an autopilot uses can't be deleted ("This style is used by autopilot <name>. Change that autopilot first."), and the built-in sync keeps a built-in an autopilot or a clone still uses **(owner decision: a style in use never vanishes)**.
- Built-in previews come from `GET /v1/styles/:id/preview` and `/preview-video` (with Range).

The study shows up as a job on the Agents board and in the Style screen with its steps: Downloaded, Frames sampled, Reading, Writing the prompt.

#### Agents

A kanban board with four columns: Queued, Working, Needs you, Done. Each column has its Oyen expression. Failed jobs land in Needs you with surprised Oyen and a "Fix it" action.

**A project chat's build job is done only with a video (owner report).** When a turn ends, the job is Done only if a non-empty render appeared since the turn started (its note is the file name). Otherwise it needs you: "The agent is waiting for your answer" when the agent asked something, else "No video yet. The agent stopped before rendering", with Open chat and Continue (asks the agent to render and check the frames). A render that arrives later makes it Done (checked on the board, at start and every tick). While a render runs the job reads "Rendering video". A user's Stop is Done with "Cancelled"; autopilot jobs follow the autopilot.

#### Calendar

A month view with each video and its state, scheduling (Schedule, drag to another day, Mark as posted), autopilot slot ghosts with Try again, topic ideas for the week, and a "Manage autopilots" link to the Autopilot screen. The free app only reminds the user to post. See Autopilot and Calendar below.

#### Agent usage

The sidebar's bottom shows the default agent's usage, the same way Orca does: a thin bar for the 5-hour window and a line like "33% used 1h 41m · 48% used 3d 13h · 26% used Fable". Clicking it opens a Usage panel for all installed agents (Detailed or Compact), with each agent's 5-hour, weekly and model-specific weekly limits, reset times, a refresh button, and links to usage history (Agents) and account settings. Claude's numbers come from Anthropic's usage endpoint using the token Claude Code already stores on this computer (read locally, sent only to Anthropic). Agents without a usage source show "Usage isn't available for <agent> yet". **(owner request; data source is my call)**

#### Settings

- Default agent
- Auto mode for chats (with "Autopilots always use Auto mode.")
- Interface language
- Background mode, Open at login, Send a test notification
- "Check every frame before showing me"
- Working folder
- Video defaults: language, format, frame rate
- Where to render
- Tools: the same checks and installs as onboarding step 3
- tayang.app sign-in

## Agent skills and A2UI (owner request)

**What the agent suggests (owner request).** Tayang only makes videos built in code (motion design and animation). The agent must never suggest or plan anything that needs filming, real footage, a presenter, or a real person's likeness or voice. Topic ideas fit the installed styles, use real and checkable facts, start with one short friendly sentence in the video language, and arrive as A2UI option cards ("Make this"), never as raw JSON.

**Skills only inside Tayang.** Tayang's agent skills (how Tayang works, project briefs, styles and templates, the frame check, rendering, and A2UI) are loaded only for sessions Tayang starts. Nothing is installed into the user's global agent config, so the same agent used elsewhere behaves normally.
- Claude Code: Tayang ships its skills as a Claude Code plugin bundled with the app and passes it per session through the ACP adapter (`_meta.claudeCode.options.plugins = [{ type: "local", path }]`), plus a short `_meta.systemPrompt.append` that says the agent is running inside Tayang Studio.
- Other agents (no per-session plugin support over ACP): the same skill text is sent as a preamble in the first prompt of each Tayang session.
- Every agent Tayang starts gets `TAYANG_STUDIO=1` in its environment.

**A2UI for options.** When the agent needs the user to choose or fill something in (topic ideas, style picks, yes/no confirmations, short forms), it answers with an A2UI v0.9 surface (`application/a2ui+json`; messages `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`; basic catalog) in a fenced ```a2ui block instead of a numbered list. Tayang renders it inline in the chat with its own components (Card, Column, Row, List, Text, Image, Icon, Divider, Button, ChoicePicker, TextField, CheckBox, Slider, Tabs). When the user acts, Tayang sends the A2UI `action` message back (`{"version":"v0.9","action":{name, surfaceId, sourceComponentId, timestamp, context}}`) with a readable summary. Unsupported components render as a short muted note; agent text stays text, never HTML. **(transport via fenced blocks in ACP text is my call)**

## Quality loop

Before showing the user anything, the agent:

1. renders stills of every scene
2. checks them for overlaps, cut-off text and timing
3. fixes what it finds.

The chat shows "Frames checked" when the loop has passed. **(my call: default on, can be switched off in Settings)**

## Money

Free: everything needed to make a video.

Paid, through tayang.app and checked by the Hono backend **(my call)**:

- Voiceover
- Cloud rendering
- Premium styles
- Autopilot posting

## Open questions

1. **Video language.** The content in the mockups is in Bahasa Indonesia and the interface in English. Is that right?
2. **Downloading from TikTok, Instagram and YouTube.** Their terms may forbid downloading, and Instagram often needs a logged-in session. Decide whether to download locally, ask the user to upload the file instead, or both, and how to word the disclaimer.
3. **Rendering engine.** HyperFrames only, or Remotion too?
4. **Which features are paid** and when they launch.
5. **Working folder.** Confirm it means a user-chosen folder where projects live and the agent runs, and the default path.

## Next

Before planning, this document gets a builder check: a fresh reader looks for gaps. After that comes an implementation plan.

## Autopilot and Calendar

### Owner decisions (2026-11-04)
- Autopilot = niche + style + frequency ("2 videos a day or etc"); the user can have **many autopilots**, each can be **paused/resumed**.
- Each autopilot chooses **automatic** (finished videos go straight to "Ready") or **review first** (finished videos wait for Approve).
- Posting has two modes, **manual** and **automatic**; automatic comes later. Now: manual = a reminder at post time.
- A Settings switch decides whether Tayang Studio **keeps running in the background**.
- **No usage guard**; the user pauses autopilots themselves.

### Calendar becomes real (prerequisite)
- A video (project) can be scheduled: "Schedule" (date + time) on Videos, Preview and the Calendar day; drag a video to another day to move it; "Mark as posted".
- Calendar cells show each video with its state: Planned (autopilot slot, no video yet) · Making · Needs review · Ready · Posted · Failed.
- Reminder at post time (system notification): "Time to post <title>"; a not-yet-approved video instead says "Review <title> before it's due". Missed reminders while the app was closed show once on next launch.
- The Autopilot promo card's false "Tayang reminds you" claim goes away (the panel below replaces it).

### Autopilot

- **As built (autopilot setup, Nov 2026; `AUTOPILOT_ENABLED` is on):** an autopilot has a niche (from the API's `GET /v1/niches`, its prompt copied onto the autopilot, or the user's own text), a style, a voice (`GET /v1/voices`, names the fal ElevenLabs model takes, or the default), a language (id, en), a length (45, 60 or 90 s; older lengths stay until changed), days (every day, weekdays, weekends or chosen days) with 1 to 6 videos a day, and up to 10 accounts to post to. All of it can be edited later in the wizard.
  - **Publishing:** review first posts on Approve; fully automatic posts when the render is done. Posts are scheduled with PostForMe for the slot's time, so they go out with the app closed, or right away when that time has passed. The request id comes from the video, so a video can't post twice. A failed post keeps the video: its slot is Done and says so. With no accounts, the autopilot only reminds.
  - **Two ways to create:** the wizard, or **Create with AI chat**: the agent asks with its question tool and sends the result to `POST $TAYANG_AI_URL/autopilot`. That never creates anything: when its turn ends the wizard opens on Summary with the suggestion, ids not in the catalogs dropped, and the user starts it there.
- Fields: name, niche (free text + example chips), language, style (from the Style library), agent, frequency (N per day at set times, or N per week on chosen days + time), length (short form), review first on/off, posting = Manual (Automatic shown disabled "Coming soon"), active/paused.
- **As built (A5):** a separate **Autopilot screen** replaces the planned Calendar panel. Cards (style thumbnail, niche, frequency, status chip, next video, made/failed counts) with Stop now, Pause/Resume, Edit and Delete; a detail view with the next 7 days of slots and the videos it made. **New autopilot** is a 5-step wizard (Niche, Style, Schedule, Agent & review, Summary) with a leave guard. The Calendar only links there.
- Engine (runs in the app while it is open, including hidden in the tray):
  - Keeps the next 7 days of slots planned on the Calendar per active autopilot.
  - Production starts for the next slot due within 24 h; **one video at a time across all autopilots** (a queue), so they don't fight over the agent.
  - For a slot: ask the agent for ONE motion-design topic for the niche + style that isn't a repeat of the autopilot's earlier titles → create the project from the style's template (existing topic flow) → build and render in a dedicated autopilot chat in **auto mode** (no permission cards) → when a render exists the video becomes Needs review (review first) or Ready.
  - **As built:** the topic comes from a hidden per-autopilot chat (`autopilot-<id>`, a fresh session per slot, no skills). The video is built in a **normal project chat** in auto mode, which is retired with a recap afterwards so the user can continue it. Each turn times out after 45 minutes. Failures are stored slot errors in the user's language (no topic, no render, timed out, busy, stopped, "This autopilot's style is missing"). Recovery after a restart fails slots left making and their build jobs. Autopilots always run in Auto mode, and the user is told so where they decide **(owner decision)**.
  - Failure → the slot shows Failed with Try again; the autopilot moves on to the next slot.
  - Pause stops new work (the current video finishes; "Stop now" cancels it). Missed slots while the app was closed are produced on next launch if still in the future, else marked Skipped.
  - Every autopilot video and chat is visible like any other (Videos, Agents board, chat history) so the user can step in.

### Background mode (Settings › General)
- "Keep Tayang running in the background" (default off): closing the window hides it to the tray/menu bar instead of quitting; tray menu: Open Tayang · Pause all autopilots · Quit. Plus "Open at login" (only enabled when background is on).
- Where no system tray can be made (Linux without AppIndicator), turning it on fails safely: the setting goes back off with "Background mode needs a system tray, which isn't available here", and the window is never hidden.

### Agent scheduling (owner request)
- The agent proposes a schedule as an A2UI card whose button sends the reserved `schedule_videos` action with `items` (`projectId` for this chat's own video or a mentioned one, else a new draft title; `at` in RFC 3339 with the user's offset). It works in every user-facing chat.
- Pressing it never writes directly: Tayang checks the items (1–20, future, within a year, real dates, only this chat's videos, no duplicates) and shows its own confirmation built from them ("New draft", "Moves from <time>"). Only "Schedule N videos" there writes, all-or-nothing in Rust (drafts removed and old schedules restored on any failure). Then one stored line with Open calendar; the agent learns about it with the next message.
- Every session tells the agent the user's time zone and time; a project chat also gets its video's id. The Schedule dialog has **Let the agent pick**, which asks the video's chat for the best time in the next 7 days.

### Not now
- Automatic posting to TikTok/Reels/Shorts (later, likely tayang.app).
- .ics export.
