import type { AgentId, ToolId } from '@tayang/shared';
import { KeyRound } from 'lucide-react';
import antigravity from '@/assets/brand/antigravity.svg';
import claude from '@/assets/brand/claude.svg';
import gemini from '@/assets/brand/googlegemini.svg';
import openai from '@/assets/brand/openai.svg';
import opencode from '@/assets/brand/opencode.svg';
import node from '@/assets/brand/nodedotjs.svg';
import ffmpeg from '@/assets/brand/ffmpeg.svg';
import chrome from '@/assets/brand/googlechrome.svg';

const SRC: Partial<Record<AgentId | ToolId, string>> = {
  claude,
  gemini,
  codex: openai,
  antigravity,
  opencode,
  node,
  ffmpeg,
  chrome,
};

export function AgentLogo({ id, size = 24 }: { id: AgentId | ToolId; size?: number }) {
  const src = SRC[id];
  // Your API has no brand of its own: a key.
  if (id === 'custom') return <KeyRound aria-hidden="true" size={size * 0.8} strokeWidth={1.5} className="text-text-2" />;
  if (!src) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center rounded-md bg-raised font-mono text-xs text-text-2"
        style={{ width: size, height: size }}
      >
        {id.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt="" aria-hidden="true" width={size} height={size} style={{ width: size, height: size }} />;
}
