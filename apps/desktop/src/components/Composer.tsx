import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { ArrowUp, AtSign, Check, ChevronDown, File as FileIcon, Loader2, Palette, Paperclip, Square, X, Zap } from 'lucide-react';
import type { AgentId, AgentInfo, MessagePart, Project, Style } from '@tayang/shared';
import { AgentLogo } from '@/components/AgentLogo';
import { FrameChip } from '@/components/MessageList';
import { filterProjects, filterStyles, MentionMenu, styleKey, videoKey } from '@/components/MentionMenu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AGENT_NAMES } from '@/lib/agents';
import { assetUrl, attachFile, detectAgents, setAgentModel } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useApp } from '@/state/app';
import { autoOn, useChat, type StyleRef } from '@/state/chat';
import { modelOptions, useModels } from '@/state/models';
import { track } from '@/lib/analytics';

export const QUICK_CHIPS = ['faster', 'bigger', 'colors', 'music', 'short'] as const;

const TOKEN = /(^|\s)@(\S*)$/;
const NONE: MessagePart[] = [];

type FilePart = Extract<MessagePart, { type: 'file' }>;

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface MentionRef {
  projectId: string;
  title: string;
}

function FileChip({ part, onRemove }: { part: FilePart; onRemove(): void }) {
  const { t } = useTranslation();
  const image = part.mime.startsWith('image/');
  return (
    <span className="inline-flex h-8 max-w-60 items-center gap-2 rounded-sm border border-hairline bg-transparent pl-2 pr-1 text-xs text-text-2">
      {image ? (
        <img src={assetUrl(part.path)} alt={part.name} className="size-5 shrink-0 rounded-[4px] object-cover" />
      ) : (
        <FileIcon size={14} strokeWidth={1.5} className="shrink-0" aria-hidden="true" />
      )}
      <span className="truncate font-medium text-foreground">{part.name}</span>
      <span className="shrink-0 font-mono text-text-3">{fileSize(part.size)}</span>
      <button
        type="button"
        aria-label={t('composer.removeFile')}
        onClick={onRemove}
        className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-text-3"
      >
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </span>
  );
}

const AGENT_ORDER: AgentId[] = ['claude', 'opencode', 'codex', 'gemini', 'antigravity'];

/** Every toolbar control: a 32×32 icon button, same radius and hover. */
const ICON_BUTTON =
  'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center gap-0.5 rounded-md border-none bg-transparent p-0 text-text-2 transition-colors hover:bg-raised hover:text-foreground disabled:cursor-default disabled:opacity-50';

/** A toolbar control with its full label as a tooltip. */
function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The agent's logo and a small chevron; the name is in the label and tooltip. */
const AgentFace = ({ agent }: { agent: AgentId }) => (
  <>
    <AgentLogo id={agent} size={16} />
    <ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" />
  </>
);

function AgentPicker({
  agent,
  disabled,
  onChange,
}: {
  agent: AgentId;
  disabled?: boolean;
  onChange(id: AgentId): void;
}) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const load = (open: boolean) => {
    if (!open) return;
    detectAgents()
      .then(setAgents)
      .catch(() => {});
  };
  const listed = AGENT_ORDER.map((id) => agents.find((a) => a.id === id)).filter((a): a is AgentInfo => !!a);
  return (
    <DropdownMenu onOpenChange={load}>
      <Tip label={t('composer.agentLabel', { name: AGENT_NAMES[agent] })}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            disabled={disabled}
            aria-label={t('composer.agentLabel', { name: AGENT_NAMES[agent] })}
            className={cn(ICON_BUTTON, 'w-auto min-w-8 px-1.5')}
          >
            <AgentFace agent={agent} />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent side="top" align="start" className="w-64 border-hairline bg-card">
        {listed.map((a) => (
          <DropdownMenuItem
            key={a.id}
            disabled={!a.installed}
            onSelect={() => onChange(a.id)}
            className="h-9 gap-2 text-[13px]"
          >
            <AgentLogo id={a.id} size={16} />
            <span className="font-medium">{AGENT_NAMES[a.id]}</span>
            <span className="ml-auto font-mono text-[11px] text-text-3">
              {a.installed ? (a.version ?? '') : t('composer.notInstalled')}
            </span>
            {a.id === agent && <Check data-testid="agent-check" size={14} strokeWidth={1.5} aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => useApp.getState().navigate({ name: 'settings' })}
          className="h-9 text-[13px]"
        >
          {t('composer.setUpAgents')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A model value's readable tail when the agent gave no name for it ("opencode/big-pickle" → "big-pickle"). */
const shortModel = (value: string) => value.split('/').pop() ?? value;

/**
 * The agent's model: what the chat's session runs on, or the one picked for the agent, else its
 * default. Picking one saves it for the agent (later sessions start on it) and switches the chat's
 * running session now. The list comes from the agent itself; before any session it is asked once.
 */
export function ModelPicker({ agent, chatId, disabled }: { agent: AgentId; chatId: string | null; disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = useApp((s) => s.settings?.agentModels?.[agent] ?? null);
  const live = useModels((s) => (chatId ? (s.byChat[chatId]?.current ?? null) : null));
  const options = useModels((s) => modelOptions(s, agent, chatId));
  const loading = useModels((s) => !!s.loading[agent]);
  const failed = useModels((s) => s.failed[agent] ?? null);
  useEffect(() => useModels.getState().listen(), []);

  const current = live ?? picked;
  const label = current ? (options.find((o) => o.value === current)?.name ?? shortModel(current)) : t('composer.modelDefault');

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    setError(null);
    if (o) void useModels.getState().load(agent);
  };

  const choose = async (value: string | null) => {
    setOpen(false);
    try {
      useApp.getState().setSettings(await setAgentModel(agent, value, chatId));
      track('model picked', { agent, model: value ?? 'default' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOpen(true);
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tip label={t('composer.modelLabel', { name: label })}>
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            disabled={disabled}
            aria-label={t('composer.modelLabel', { name: label })}
            className={cn(ICON_BUTTON, 'w-auto max-w-44 px-1.5 text-[12px]')}
          >
            <span className="truncate">{label}</span>
            {loading ? (
              <Loader2 size={12} strokeWidth={1.5} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
            ) : (
              <ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
            )}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent side="top" align="start" className="w-80 border-hairline bg-card p-0">
        <Command>
          <CommandInput placeholder={t('composer.findModel')} />
          <CommandList className="max-h-72">
            {loading && !options.length ? (
              <div role="status" aria-busy="true" className="flex flex-col gap-1 px-1 py-1">
                <span className="flex items-center gap-2 px-2 py-2 text-xs text-text-3">
                  <Loader2 size={13} strokeWidth={1.5} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
                  {t('composer.loadingModels', { agent: AGENT_NAMES[agent] })}
                </span>
                {[72, 56, 64, 48].map((w) => (
                  <span key={w} aria-hidden="true" className="flex h-9 items-center px-2">
                    <span className="h-3 animate-pulse rounded bg-raised motion-reduce:animate-none" style={{ width: `${w}%` }} />
                  </span>
                ))}
              </div>
            ) : (
              <>
                {loading && (
                  <span role="status" className="flex items-center gap-2 px-3 pt-2 pb-1 text-[11px] text-text-3">
                    <Loader2 size={12} strokeWidth={1.5} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
                    {t('composer.refreshingModels')}
                  </span>
                )}
                <CommandEmpty>{t('composer.noModelMatch')}</CommandEmpty>
                {!options.length && <p className="m-0 px-3 pt-3 pb-1 text-xs text-text-3">{t('composer.noModels')}</p>}
                <CommandItem value="__default" onSelect={() => void choose(null)} className="h-9 gap-2 text-[13px]">
                  <span>{t('composer.modelDefault')}</span>
                  {!picked && <Check size={14} strokeWidth={1.5} aria-hidden="true" className="ml-auto" />}
                </CommandItem>
                {options.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={`${o.name} ${o.value}`}
                    title={o.description ?? o.value}
                    onSelect={() => void choose(o.value)}
                    className="min-h-9 gap-2 text-[13px]"
                  >
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    {o.value === current && <Check size={14} strokeWidth={1.5} aria-hidden="true" />}
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
        {(error || failed) && (
          <p role="alert" className="m-0 border-t border-hairline px-3 py-2 text-xs text-orange-light">
            {error ?? t('composer.modelsFailed', { message: failed ?? '' })}
          </p>
        )}
        <p className="m-0 border-t border-hairline px-3 py-2 text-[11px] text-text-3">{t('composer.modelHint', { agent: AGENT_NAMES[agent] })}</p>
      </PopoverContent>
    </Popover>
  );
}

export function Composer({
  chatId,
  onSend,
  disabled,
  projects,
  mention = null,
  onMention,
  quickChips,
  sees,
  placeholder,
  mentionSignal = 0,
  onStop,
  agentId,
  onAgentChange,
  ensureChat,
  initialText,
  draftKey,
  styles,
  styleHint,
  autoFocus,
}: {
  chatId: string | null;
  /** Resolve to false when sending failed: the draft is then kept. */
  onSend(parts: MessagePart[]): void | boolean | Promise<void | boolean>;
  disabled?: boolean;
  /** Videos the @ menu can list. Omit to turn the menu off. */
  projects?: Project[];
  mention?: MentionRef | null;
  onMention?(m: MentionRef | null): void;
  quickChips?: boolean;
  /** Project chat only: the title shown in "This chat sees ...". */
  sees?: string;
  placeholder?: string;
  /** Bump to open the @ menu from outside. */
  mentionSignal?: number;
  /** While the agent is working (`disabled`), show a Stop button that calls this. */
  onStop?(): void;
  /** The agent this chat talks to; defaults to the one picked in Settings. */
  agentId?: AgentId;
  /** Turns the agent button into a picker. Disabled while a turn runs. */
  onAgentChange?(id: AgentId): void;
  /** A new chat has no id until its first send: attaching creates it. */
  ensureChat?(): Promise<string>;
  /** Starts the box with this text (not sent). */
  initialText?: string;
  /** Keeps the unsent text and style chip in the chat store under this key, so they are there when the screen comes back. */
  draftKey?: string;
  /** Styles the @ menu can list. Omit to leave them out. */
  styles?: Style[];
  /** A line under the style chip, saying what the style does here. */
  styleHint?: string;
  /** Takes the focus, and takes it back each time the box is enabled again (after a turn). */
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const defaultAgent = useApp((s) => s.settings?.defaultAgent ?? 'claude');
  const agent = agentId ?? defaultAgent;
  const settingsAuto = useApp((s) => s.settings?.autoMode ?? false);
  const auto = useChat((s) => autoOn(s, chatId, settingsAuto));
  const autoBusy = useChat((s) => !!chatId && !!s.autoBusy[chatId]);
  const attachments = useChat((s) => (chatId ? s.attachments[chatId] : undefined)) ?? NONE;
  const [text, setText] = useState(() => initialText ?? (draftKey ? useChat.getState().drafts[draftKey]?.text : undefined) ?? '');
  const [styleRef, setStyleRef] = useState<StyleRef | null>(() => (draftKey ? useChat.getState().drafts[draftKey]?.style : null) ?? null);
  useEffect(() => {
    if (draftKey) useChat.getState().setDraft(draftKey, { text, style: styleRef });
  }, [draftKey, text, styleRef]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const attachPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    setAttachError(null);
    try {
      const id = chatId ?? (await ensureChat?.());
      if (!id) return;
      for (const path of paths) {
        try {
          useChat.getState().attach(id, await attachFile(id, path));
        } catch (e) {
          setAttachError(errorText(e));
        }
      }
    } catch (e) {
      setAttachError(errorText(e));
    }
  };
  // Dropped paths arrive from the window, so the latest closure goes through a ref.
  const attachRef = useRef(attachPaths);
  attachRef.current = attachPaths;

  const pickFiles = async () => {
    try {
      const picked = await openDialog({ multiple: true, directory: false });
      if (!picked) return;
      await attachPaths(Array.isArray(picked) ? picked : [picked]);
    } catch (e) {
      setAttachError(errorText(e));
    }
  };

  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    const over = (pos: { x: number; y: number }) => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return false;
      const x = pos.x / window.devicePixelRatio;
      const y = pos.y / window.devicePixelRatio;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    try {
      getCurrentWebview()
        .onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type === 'leave') setDragging(false);
          else if (p.type === 'drop') {
            const hit = over(p.position);
            setDragging(false);
            if (hit && !disabledRef.current) void attachRef.current(p.paths);
          } else setDragging(over(p.position) && !disabledRef.current);
        })
        .then((fn) => (gone ? fn() : (off = fn)))
        .catch(() => {});
    } catch {
      /* not running inside Tauri */
    }
    return () => {
      gone = true;
      off?.();
    };
  }, []);
  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus();
  }, [autoFocus, disabled]);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    if (mentionSignal > 0) {
      setText((t) => (t && !/\s$/.test(t) ? `${t} @` : `${t}@`));
      setDismissed(null);
      ref.current?.focus();
    }
  }, [mentionSignal]);

  const mentions = !!projects || !!styles;
  const token = mentions ? TOKEN.exec(text) : null;
  const query = token?.[2] ?? '';
  const videoMatches = token && projects ? filterProjects(projects, query) : undefined;
  const styleMatches = token && styles ? filterStyles(styles, query) : undefined;
  // One list across both groups, in the order the menu shows them.
  const items = [...(videoMatches ?? []).map(videoKey), ...(styleMatches ?? []).map(styleKey)];
  const open = !!token && dismissed !== text;
  const current = items.includes(active) ? active : items[0];

  const pick = (p: Project) => {
    onMention?.({ projectId: p.id, title: p.title });
    setText((t) => t.replace(TOKEN, '$1'));
    ref.current?.focus();
  };

  const pickStyle = (s: Style) => {
    setStyleRef({ styleId: s.id, name: s.name });
    setText((t) => t.replace(TOKEN, '$1'));
    ref.current?.focus();
  };

  const pickKey = (key: string) => {
    const p = videoMatches?.find((x) => videoKey(x) === key);
    if (p) return pick(p);
    const s = styleMatches?.find((x) => styleKey(x) === key);
    if (s) pickStyle(s);
  };

  const canSend = !disabled && (text.trim().length > 0 || !!mention || !!styleRef || attachments.length > 0);
  const sending = useRef(false);
  const send = async () => {
    if (!canSend || sending.current) return;
    const parts: MessagePart[] = [];
    if (text.trim()) parts.push({ type: 'text', text: text.trim() });
    if (mention) parts.push({ type: 'mention', ...mention });
    if (styleRef) parts.push({ type: 'style-mention', ...styleRef });
    sending.current = true;
    const draft = text;
    const draftStyle = styleRef;
    setText('');
    setStyleRef(null);
    const giveBack = () => {
      setText((t) => t || draft);
      setStyleRef((s) => s ?? draftStyle);
    };
    try {
      // The prompt may run for the whole turn, so clear now and give the draft back on failure.
      if ((await onSend(parts)) === false) giveBack();
    } catch {
      giveBack();
    } finally {
      sending.current = false;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open && items.length > 0) {
      const i = Math.max(0, items.indexOf(current ?? ''));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = items.length;
        setActive(items[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]!);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (current) pickKey(current);
        return;
      }
    }
    if (open && e.key === 'Escape') {
      e.preventDefault();
      setDismissed(text);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (open) setDismissed(text);
      else void send();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {quickChips && (
        <div className="flex flex-wrap gap-2">
          {QUICK_CHIPS.map((q) => (
            <button
              key={q}
              type="button"
              disabled={disabled}
              onClick={() => void onSend([{ type: 'text', text: t(`composer.chips.${q}`) }])}
              className="h-8 cursor-pointer rounded-full border border-hairline bg-transparent px-3 text-[13px] text-text-2 transition-colors hover:bg-raised hover:text-foreground disabled:cursor-default disabled:opacity-50"
            >
              {t(`composer.chips.${q}`)}
            </button>
          ))}
        </div>
      )}
      <Popover open={open}>
        <PopoverAnchor asChild>
          <div
            ref={box}
            data-no-drag
            className={`flex flex-col gap-3 rounded-lg border bg-card p-3 transition-colors ${dragging ? 'border-primary' : 'border-hairline focus-within:border-[#3A3A3A]'}`}
          >
            {attachError && (
              <p role="alert" className="m-0 text-xs text-orange-light">
                {attachError}
              </p>
            )}
            {(mention || styleRef || attachments.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {mention && (
                  <span className="inline-flex h-6 items-center gap-1 rounded-sm border border-deep-orange bg-tint pl-2 pr-1 text-[13px] font-medium text-orange-light">
                    @{mention.title}
                    <button
                      type="button"
                      aria-label={t('composer.removeVideo')}
                      onClick={() => onMention?.(null)}
                      className="inline-flex size-4 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-orange-light"
                    >
                      <X size={12} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  </span>
                )}
                {styleRef && (
                  <span className="inline-flex h-6 items-center gap-1 rounded-sm border border-hairline bg-raised pl-2 pr-1 text-[13px] font-medium text-foreground">
                    <Palette size={12} strokeWidth={1.5} aria-hidden="true" className="text-text-2" />
                    <span>@{styleRef.name}</span>
                    <button
                      type="button"
                      aria-label={t('composer.removeStyle', { name: styleRef.name })}
                      onClick={() => setStyleRef(null)}
                      className="inline-flex size-4 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-text-2"
                    >
                      <X size={12} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  </span>
                )}
                {attachments.map((a, i) =>
                  a.type === 'frame' ? (
                    <span key={i} className="inline-flex items-center gap-1">
                      <FrameChip part={a} />
                      <button
                        type="button"
                        aria-label={t('composer.removeFrame')}
                        onClick={() => chatId && useChat.getState().detach(chatId, i)}
                        className="inline-flex size-5 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-text-3"
                      >
                        <X size={14} strokeWidth={1.5} aria-hidden="true" />
                      </button>
                    </span>
                  ) : a.type === 'file' ? (
                    <FileChip key={i} part={a} onRemove={() => chatId && useChat.getState().detach(chatId, i)} />
                  ) : null,
                )}
              </div>
            )}
            {styleRef && styleHint && <p className="m-0 -mt-1 text-xs text-text-3">{styleHint}</p>}
            <label htmlFor="composer-message" className="sr-only">
              {t('composer.message')}
            </label>
            <Textarea
              id="composer-message"
              ref={ref}
              rows={2}
              value={text}
              disabled={disabled}
              placeholder={placeholder ?? t('composer.placeholder')}
              onChange={(e) => {
                setText(e.target.value);
                setActive('');
              }}
              onKeyDown={onKeyDown}
              className="min-h-12 resize-none rounded-none border-0 bg-transparent p-0 text-[14px] leading-[1.6] shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
            />
            <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-1">
              <Tip label={t('composer.attach')}>
                <button
                  type="button"
                  aria-label={t('composer.attach')}
                  disabled={disabled}
                  onClick={() => void pickFiles()}
                  className={ICON_BUTTON}
                >
                  <Paperclip size={16} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </Tip>
              {onAgentChange ? (
                <AgentPicker agent={agent} disabled={disabled || autoBusy} onChange={onAgentChange} />
              ) : (
                <Tip label={t('composer.agentLabel', { name: AGENT_NAMES[agent] })}>
                  <button
                    type="button"
                    aria-label={t('composer.agentLabel', { name: AGENT_NAMES[agent] })}
                    className={cn(ICON_BUTTON, 'w-auto min-w-8 px-1.5')}
                  >
                    <AgentFace agent={agent} />
                  </button>
                </Tip>
              )}
              <ModelPicker agent={agent} chatId={chatId} disabled={disabled || autoBusy} />
              {onAgentChange && (
                <Tip label={`${auto ? t('composer.autoOn') : t('composer.autoOff')} · ${t('composer.autoTitle')}`}>
                  <button
                    type="button"
                    aria-pressed={auto}
                    aria-label={t('composer.auto')}
                    disabled={disabled || autoBusy}
                    onClick={() => void useChat.getState().setAuto(chatId, !auto)}
                    className={cn(ICON_BUTTON, auto && 'bg-tint text-orange-light hover:bg-tint hover:text-orange-light')}
                  >
                    <Zap size={16} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </Tip>
              )}
              {mentions && (
                <Tip label={t('composer.mention')}>
                  <button
                    type="button"
                    aria-label={t('composer.mention')}
                    disabled={disabled}
                    onClick={() => {
                      setText((t) => (t && !/\s$/.test(t) ? `${t} @` : `${t}@`));
                      setDismissed(null);
                      ref.current?.focus();
                    }}
                    className={ICON_BUTTON}
                  >
                    <AtSign size={16} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </Tip>
              )}
              {sees && <span className="truncate text-xs text-text-3">{t('composer.sees', { title: sees })}</span>}
              {disabled && onStop ? (
                <button
                  type="button"
                  aria-label={t('composer.stop')}
                  onClick={onStop}
                  className="ml-auto inline-flex size-8 cursor-pointer items-center justify-center rounded-md border border-hairline bg-raised text-foreground transition-colors hover:bg-[#333333]"
                >
                  <Square size={12} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={t('composer.send')}
                  disabled={!canSend}
                  onClick={() => void send()}
                  className="ml-auto inline-flex size-8 cursor-pointer items-center justify-center rounded-md border-none bg-primary text-primary-foreground transition-colors hover:bg-accent-hover disabled:cursor-default disabled:opacity-50"
                >
                  <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </div>
            </TooltipProvider>
          </div>
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          className="w-[400px] border-hairline bg-card p-2"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <MentionMenu
            projects={videoMatches}
            styles={styleMatches}
            query={query}
            value={current ?? ''}
            onValueChange={setActive}
            onPick={pick}
            onPickStyle={pickStyle}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
