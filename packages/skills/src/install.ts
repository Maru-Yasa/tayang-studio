import type { AgentId, SystemInfo, ToolId } from '@tayang/shared';

const KEY_MASK = 'sk_••••';

/** Where Node.js comes from: agents need Node to run, so the agent can't install it. */
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';

/** Where Google Chrome comes from on a Mac without Homebrew: a drag-to-Applications app the agent can't install. */
export const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';

/** A system package install. Only Linux package managers need sudo. */
function pmInstall(sys: SystemInfo, pkg: string): string {
  switch (sys.packageManager) {
    case 'brew':
      return `brew install ${pkg}`;
    case 'winget':
      return `winget install ${pkg}`;
    case 'dnf':
      return `sudo dnf install -y ${pkg}`;
    case 'pacman':
      return `sudo pacman -S --noconfirm ${pkg}`;
    default:
      return `sudo apt install -y ${pkg}`;
  }
}

/** A Mac without Homebrew installs into ~/.local/bin, no sudo. */
const macNoBrew = (sys: SystemInfo) => sys.os === 'macos' && sys.packageManager !== 'brew';

/**
 * The page the user installs a tool from themselves, when the agent can't: Node (agents run on it) and
 * Chrome on a Mac without Homebrew. Null when the agent installs it.
 */
export function manualInstallUrl(tool: ToolId, sys: SystemInfo | null): string | null {
  if (tool === 'node') return NODE_DOWNLOAD_URL;
  if (tool === 'chrome' && sys && macNoBrew(sys)) return CHROME_DOWNLOAD_URL;
  return null;
}

const MAC_FFMPEG = [
  'mkdir -p ~/.local/bin',
  'curl -L -o /tmp/ffmpeg.zip https://ffmpeg.martin-riedl.de/redirect/latest/macos/<arm64|amd64>/release/ffmpeg.zip',
  'curl -L -o /tmp/ffprobe.zip https://ffmpeg.martin-riedl.de/redirect/latest/macos/<arm64|amd64>/release/ffprobe.zip',
  'unzip -o /tmp/ffmpeg.zip -d ~/.local/bin && unzip -o /tmp/ffprobe.zip -d ~/.local/bin',
  'chmod +x ~/.local/bin/ffmpeg ~/.local/bin/ffprobe',
];

const LINUX_FFMPEG = [
  'mkdir -p ~/.local/bin',
  "curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-<amd64|arm64>-static.tar.xz | tar -xJ -C ~/.local/bin --strip-components=1 --wildcards '*/ffmpeg' '*/ffprobe'",
];

const MAC_YTDLP = [
  'mkdir -p ~/.local/bin',
  'curl -L -o ~/.local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  'chmod +x ~/.local/bin/yt-dlp',
];

function uvInstall(sys: SystemInfo): string {
  if (sys.os === 'windows') return 'winget install --id astral-sh.uv -e';
  if (sys.packageManager === 'brew') return 'brew install uv';
  // The official installer puts uv in ~/.local/bin, no sudo.
  return 'curl -LsSf https://astral.sh/uv/install.sh | sh';
}

/** The command that adds the ElevenLabs MCP server for every folder, for agents that have one. */
function elevenLabsAdd(agent: AgentId, key: string): string | null {
  const env = `ELEVENLABS_API_KEY=${key}`;
  switch (agent) {
    case 'claude':
      return `claude mcp add -s user elevenlabs -e ${env} -- uvx elevenlabs-mcp`;
    case 'codex':
      return `codex mcp add elevenlabs --env ${env} -- uvx elevenlabs-mcp`;
    case 'opencode':
      return `opencode mcp add --global --env ${env} elevenlabs -- uvx elevenlabs-mcp`;
    default:
      return null;
  }
}

/** The user-level config file an agent keeps its MCP servers in, the key they go under and one entry. */
function elevenLabsEntry(agent: AgentId, key: string): { file: string; under: string; entry: string } {
  const env = { ELEVENLABS_API_KEY: key };
  const opencode = JSON.stringify({ type: 'local', command: ['uvx', 'elevenlabs-mcp'], environment: env, enabled: true });
  const standard = JSON.stringify({ command: 'uvx', args: ['elevenlabs-mcp'], env });
  switch (agent) {
    case 'opencode':
      return { file: '`~/.config/opencode/opencode.json` (or the `opencode.jsonc` there, if that is the one that exists)', under: 'mcp', entry: opencode };
    case 'custom':
      // "Your API": Tayang's own engine, whose config folder is in its environment.
      return { file: '`opencode.json` in the folder the `OPENCODE_CONFIG_DIR` environment variable names', under: 'mcp', entry: opencode };
    case 'antigravity':
      return { file: '`~/.gemini/antigravity/mcp_config.json`', under: 'mcpServers', entry: standard };
    default:
      return { file: '`~/.gemini/settings.json`', under: 'mcpServers', entry: standard };
  }
}

function elevenLabsCommands(sys: SystemInfo, agent: AgentId, key: string): string[] {
  const add = elevenLabsAdd(agent, key);
  return add ? [uvInstall(sys), add] : [uvInstall(sys)];
}

export function installCommands(tool: ToolId, sys: SystemInfo, agent: AgentId): string[] {
  return commandsFor(tool, sys, agent, KEY_MASK);
}

function commandsFor(tool: ToolId, sys: SystemInfo, agent: AgentId, key: string): string[] {
  const pm = sys.packageManager;
  switch (tool) {
    case 'ffmpeg':
      if (pm === 'brew') return ['brew install ffmpeg'];
      if (pm === 'winget' || sys.os === 'windows') return ['winget install --id Gyan.FFmpeg -e'];
      if (sys.os === 'macos') return MAC_FFMPEG;
      return LINUX_FFMPEG;
    case 'ytdlp':
      if (pm === 'brew') return ['brew install yt-dlp'];
      if (pm === 'winget' || sys.os === 'windows') return ['winget install --id yt-dlp.yt-dlp -e'];
      if (sys.os === 'macos') return MAC_YTDLP;
      return ['pipx install yt-dlp'];
    case 'node':
      if (pm === 'brew') return ['brew install node@22'];
      if (pm === 'winget' || sys.os === 'windows') return ['winget install --id OpenJS.NodeJS.LTS -e'];
      return [pmInstall(sys, 'nodejs')];
    case 'chrome':
      if (pm === 'brew') return ['brew install --cask google-chrome'];
      if (pm === 'winget' || sys.os === 'windows') return ['winget install --id Google.Chrome -e'];
      if (sys.os === 'macos') return []; // the user installs it from CHROME_DOWNLOAD_URL
      return [pmInstall(sys, 'chromium')];
    case 'elevenlabs-mcp':
      return elevenLabsCommands(sys, agent, key);
    default:
      return [];
  }
}

/** True when this install can only go through the system package manager with sudo. */
export function needsSudo(tool: ToolId, sys: SystemInfo): boolean {
  return commandsFor(tool, sys, 'claude', '').some((c) => c.startsWith('sudo '));
}

const VERIFY: Record<ToolId, string> = {
  ffmpeg: '`ffmpeg -version`',
  ytdlp: '`yt-dlp --version`',
  node: '`node --version`',
  chrome: 'the path where Chrome or Chromium is installed',
  'elevenlabs-mcp': 'your MCP server list',
};

const NAMES: Record<ToolId, string> = {
  ffmpeg: 'ffmpeg',
  ytdlp: 'yt-dlp',
  node: 'Node.js 22 or newer',
  chrome: 'Google Chrome (or Chromium on Linux)',
  'elevenlabs-mcp': 'the ElevenLabs MCP server',
};

const USER_SPACE =
  'Install it for this user only, without sudo: put the binaries in `~/.local/bin` (create it if needed). Pick the build for this computer\'s CPU (`uname -m`).';

export function buildInstallPrompt(
  tool: ToolId,
  sys: SystemInfo,
  agent: AgentId,
  opts?: { elevenLabsKey?: string },
): string {
  const lines: string[] = [];
  lines.push(`Please install ${NAMES[tool]} on this computer (${sys.os} ${sys.osVersion}).`);
  const run = (cmds: string[]) => lines.push(...cmds.map((c) => `  ${c}`));
  if (tool === 'elevenlabs-mcp') {
    const key = opts?.elevenLabsKey ?? '<ELEVENLABS_API_KEY>';
    const cmds = commandsFor(tool, sys, agent, key);
    const { file, under, entry } = elevenLabsEntry(agent, key);
    const byHand = `add this under \`${under}\` in ${file}, creating the file if it is missing and keeping everything already in it:`;
    if (agent === 'claude' || agent === 'codex') {
      lines.push('Install `uv` first if it is missing, then register the MCP server. Run:');
      run(cmds);
    } else if (agent === 'opencode') {
      lines.push('Install `uv` first if it is missing, then register the MCP server for every folder. Run:');
      run(cmds);
      lines.push(`If your \`opencode mcp add\` does not take those flags, ${byHand}`);
      run([`"elevenlabs": ${entry}`]);
    } else {
      lines.push('Install `uv` first if it is missing:');
      run(cmds);
      lines.push(`Then ${byHand}`);
      run([`"elevenlabs": ${entry}`]);
    }
    // Tayang checks the config file itself; a version number would only be noise if this fails.
    lines.push('Then reply with one short line: "done", or what went wrong.');
    return lines.join('\n');
  } else if (needsSudo(tool, sys)) {
    // A sudo password prompt can't be answered from inside the agent.
    lines.push('This needs the system package manager with sudo. Do not run sudo yourself.');
    lines.push('Ask the user to run this command in their own terminal, then check that it worked:');
    run(commandsFor(tool, sys, agent, ''));
  } else if ((tool === 'ffmpeg' || tool === 'ytdlp') && (macNoBrew(sys) || sys.os === 'linux')) {
    lines.push(sys.os === 'macos' ? `This Mac has no Homebrew. ${USER_SPACE}` : USER_SPACE);
    if (tool === 'ytdlp' && sys.os === 'linux') {
      lines.push('Use pipx (install pipx for this user first if it is missing). Run:');
    } else {
      lines.push('For example (replace the <a|b> part with the right CPU build):');
    }
    run(commandsFor(tool, sys, agent, ''));
    if (tool === 'ffmpeg') lines.push('Install `ffprobe` next to `ffmpeg`: Tayang needs both.');
  } else {
    lines.push('Run:');
    run(commandsFor(tool, sys, agent, ''));
  }
  lines.push(`Then verify with ${VERIFY[tool]} and reply with only the version you see.`);
  return lines.join('\n');
}
