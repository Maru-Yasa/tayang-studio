import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Download } from 'lucide-react';
import type { SystemInfo, ToolId, ToolStatus } from '@tayang/shared';
import { openUrl } from '@tauri-apps/plugin-opener';
import { installCommands, manualInstallUrl } from '@tayang/skills';
import sleepy from '@/assets/brand/oyen-expr-sleepy.svg';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/Button';
import { PermissionCard } from '@/components/PermissionCard';
import { Input } from '@/components/ui/input';
import { toolDetail, toolName } from '@/lib/tools';
import { cn } from '@/lib/utils';
import { useApp } from '@/state/app';
import { useInstall, type LogLine, type ToolInstall } from '@/state/install';

export const TOOL_ORDER: ToolId[] = ['node', 'ffmpeg', 'chrome', 'elevenlabs-mcp', 'ytdlp'];

/** Tools whose "missing" line differs from the plain detail. */
const HAS_MISSING = new Set<ToolId>(['node', 'ffmpeg', 'ytdlp']);

function LogList({ log, done }: { log: LogLine[]; done: boolean }) {
  if (log.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 rounded-md border border-border bg-sidebar p-3">
      {log.map((l) => {
        const state = done || l.status === 'done' ? 'done' : l.status === 'failed' ? 'failed' : 'active';
        return (
          <li key={l.id} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                state === 'done' && 'bg-text-3',
                state === 'active' && 'bg-primary',
                state === 'failed' && 'border border-[#4A4A4A]',
              )}
            />
            <span className={cn(state === 'active' ? 'text-foreground' : 'font-mono text-text-2')}>{l.title}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function ToolRow({ tool, sys, agentName, busy, onInstall, onAskKey }: {
  tool: ToolStatus;
  sys: SystemInfo | null;
  agentName: string;
  busy: boolean;
  onInstall(key?: string): void;
  onAskKey(): void;
}) {
  const inst: ToolInstall | undefined = useInstall((s) => s.tools[tool.id]);
  const request = useInstall((s) => s.request);
  const respond = useInstall((s) => s.respond);
  const cancel = useInstall((s) => s.cancel);
  const dismiss = useInstall((s) => s.dismiss);
  const active = useInstall((s) => s.active);
  const agent = useApp((s) => s.settings?.defaultAgent) ?? 'claude';
  const [key, setKey] = useState('');
  const { t } = useTranslation();
  const detailText = toolDetail(tool);
  const name = toolName(tool);
  const askText = t(`tools.${tool.id}.ask`);
  const isEleven = tool.id === 'elevenlabs-mcp';

  // Node, and Chrome on a Mac without Homebrew: the user installs it from the download page.
  const manualUrl = manualInstallUrl(tool.id, sys);
  const status = inst?.status ?? 'missing';
  // Installed, but older than Tayang needs: say so, or "Install" reads as if nothing was found.
  const tooOld = tool.id === 'node' && tool.found && !tool.ok && !!tool.version;
  const ok = tool.ok || status === 'done';
  const showMissing = !ok && (status === 'missing' || status === 'failed' || status === 'key');
  const detail = ok
    ? status === 'done'
      ? isEleven ? t('tools.addedTo', { agent: agentName }) : t('tools.installedBy', { agent: agentName })
      : detailText
    : (manualUrl && tool.id === 'chrome' && t('tools.chrome.missingManual')) ||
      (tooOld && t('tools.node.tooOld', { version: tool.version ?? '' })) ||
      (tool.id === 'node' && t('tools.node.missing')) ||
      (tool.id === 'ffmpeg' && t('tools.ffmpeg.missing')) ||
      (tool.id === 'ytdlp' && t('tools.ytdlp.missing')) ||
      detailText;
  const label = isEleven ? t('tools.addTo', { agent: agentName }) : tooOld ? t('tools.update') : t('tools.install');
  const expected = sys ? installCommands(tool.id, sys, agent) : [];

  return (
    <li className="flex flex-col gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-raised text-text-2">
          {tool.id === 'ytdlp' ? <Download size={20} strokeWidth={1.5} aria-hidden="true" /> : <AgentLogo id={tool.id} size={22} />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[15px] font-medium">{name}</span>
          <span className="text-[13px] text-text-3">{detail}</span>
        </div>
        {ok && (
          <span className="inline-flex items-center gap-2 text-sm text-[#D9D9D9] tabular-nums">
            <Check size={16} strokeWidth={1.5} aria-hidden="true" className="text-foreground" />
            {status === 'done' && isEleven ? t('tools.added') : tool.version ?? t('tools.found')}
          </span>
        )}
        {showMissing && status !== 'key' && (
          <Button
            variant={tool.required ? 'primary' : 'secondary'}
            className="h-9 px-3 text-[13px]"
            disabled={busy}
            aria-label={status === 'failed' ? undefined : `${label} ${name}`}
            onClick={() =>
              manualUrl ? void openUrl(manualUrl).catch(() => {}) : isEleven ? onAskKey() : onInstall()
            }
          >
            {status === 'failed' ? t('common.tryAgain') : label}
          </Button>
        )}
        {(status === 'running' || status === 'confirm') && !ok && (
          <span className="inline-flex items-center gap-2 text-[13px] text-text-2">
            <img src={sleepy} alt="" aria-hidden="true" className="size-6" />
            {status === 'running' ? t('tools.installing') : t('tools.waiting')}
          </span>
        )}
        {status === 'running' && !ok && (
          <Button variant="ghost" className="h-9 px-2 text-[13px]" onClick={() => void cancel(tool.id)}>
            {t('common.cancel')}
          </Button>
        )}
      </div>

      {isEleven && !ok && (status === 'missing' || status === 'key') && (
        <div role="alert" className="flex items-start gap-3 rounded-md border border-deep-orange bg-tint p-3">
          <AlertTriangle size={18} strokeWidth={1.5} aria-hidden="true" className="mt-px shrink-0 text-orange-light" />
          <div className="flex flex-col gap-1 text-[13px] leading-normal">
            <span className="font-medium text-orange-light">{t('tools.noVoiceTitle')}</span>
            <span className="text-[#D9C2B8]">
              {t('tools.noVoiceText', { agent: agentName })}
            </span>
          </div>
        </div>
      )}

      {status === 'failed' && inst?.error && (
        <p role="alert" className="m-0 text-[13px] text-orange-light">{inst.error}</p>
      )}

      {status === 'failed' && inst?.reply?.trim() && (
        <details className="text-[13px] text-text-3">
          <summary className="cursor-pointer select-none hover:text-text-2">{t('tools.agentSaid', { agent: agentName })}</summary>
          <p className="m-0 mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-sidebar p-3 text-text-2">
            {inst.reply.trim()}
          </p>
        </details>
      )}

      {status === 'key' && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-ink p-3">
          <label htmlFor="elkey" className="text-[13px] text-[#D9D9D9]">
            {t('tools.keyLabel')}{' '}
            <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer" className="ml-1 text-xs text-primary hover:text-accent-hover">
              {t('tools.getKey')}
            </a>
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="elkey"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk_…"
              autoComplete="off"
              className="h-9 min-w-60 flex-1 bg-card font-mono text-[13px]"
            />
            <Button variant="light" className="h-9 px-3 text-[13px] font-semibold" disabled={!key.trim() || busy} onClick={() => onInstall(key.trim())}>
              {t('common.continue')}
            </Button>
            <Button variant="ghost" className="h-9 px-2 text-[13px]" onClick={() => dismiss(tool.id)}>
              {t('common.cancel')}
            </Button>
          </div>
          <span className="text-xs text-text-3">{t('tools.keyNote')}</span>
        </div>
      )}

      {request && active === tool.id && (
        <PermissionCard request={request} ask={askText} agentId={agent} onRespond={(id) => void respond(id)} />
      )}

      {status === 'confirm' && !request && (
        <div className="flex flex-col gap-2 rounded-md border border-hairline bg-ink p-3">
          <span className="text-xs text-text-3">{t('tools.willAsk', { agent: agentName })}</span>
          <pre className="m-0 rounded-sm border border-border bg-sidebar px-3 py-2 font-mono text-xs leading-[1.7] whitespace-pre-line text-foreground">
            {expected.join('\n')}
          </pre>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-3">{t('tools.nothingRuns')}</span>
            <Button variant="ghost" className="ml-auto h-9 px-2 text-[13px]" onClick={() => void cancel(tool.id)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {(status === 'running' || (status === 'done' && !!inst?.log.length)) && (
        <LogList log={inst?.log ?? []} done={status === 'done'} />
      )}
    </li>
  );
}
