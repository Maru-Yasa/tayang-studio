import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, PanelRight, Send, SquareTerminal } from 'lucide-react';
import type { AgentId, Chat, MessagePart, Project } from '@tayang/shared';
import { TraceButton } from '@/components/TraceDialog';
import { Button } from '@/components/Button';
import { Composer } from '@/components/Composer';
import { MessageList } from '@/components/MessageList';
import { PermissionCard } from '@/components/PermissionCard';
import { QuestionCard } from '@/components/QuestionCard';
import { ResizeHandle } from '@/components/ResizeHandle';
import { Preview } from '@/screens/preview/Preview';
import { FileTree } from '@/components/workspace/FileTree';
import { Workspace } from '@/components/workspace/Workspace';
import { ScheduleDialog } from '@/components/ScheduleDialog';
import { PostDialog } from '@/components/PostDialog';
import { ScrollToBottom } from '@/components/ScrollToBottom';
import { TurnRail } from '@/components/TurnRail';
import { StepBar } from '@/components/StepBar';
import { stylesFor, useStyles } from '@/components/TemplateChip';
import { styleContext } from '@/lib/mentions';
import { getChat, listProjects, mediaProbe, mediaRender, renderCommand, updateProject, type RenderCommand } from '@/lib/ipc';
import { LANGUAGE_NAMES } from '@/i18n';
import { projectSendOptions } from '@/lib/openProject';
import { useApp } from '@/state/app';
import { headPermission, headQuestion, useChat, type SendOpts } from '@/state/chat';
import { useUsage } from '@/state/usage';
import { FILES, PREVIEW, useFittedLayout, useLayout } from '@/state/layout';
import { useProjectTabs, useWorkspace } from '@/state/workspace';
import { setRenderArgv, useRender } from '@/state/render';
import { advanceProject } from '@/lib/projectStatus';
import { cn } from '@/lib/utils';
import { track, trackError } from '@/lib/analytics';

const NO_MESSAGES: never[] = [];
/** How often the file sidebar reads its folders again while the agent works. */
const TREE_REFRESH_MS = 4000;
/** One argv as a shell-looking line: arguments with spaces or quotes are double-quoted. */
const shellDisplay = (argv: string[]) =>
  argv.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ');

export function ChatProject({ chatId, draft }: { chatId: string; draft?: string }) {
  const { t } = useTranslation();
  const defaultAgent = useApp((s) => s.settings?.defaultAgent ?? 'claude');
  const [chat, setChat] = useState<Chat | null>(null);
  const agent = chat?.agentId ?? defaultAgent;
  const [project, setProject] = useState<Project | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [posting, setPosting] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [runs, setRuns] = useState<RenderCommand | null>(null);
  const messages = useChat((s) => s.messages[chatId]) ?? NO_MESSAGES;
  const streaming = useChat((s) => !!s.streaming[chatId]);
  const permission = useChat((s) => headPermission(s, chatId));
  const question = useChat((s) => headQuestion(s, chatId));
  const fitted = useFittedLayout(true);
  const renderRunning = useRender((s) => (project ? !!s.runs[project.id] : false));
  const projectsVersion = useApp((s) => s.projectsVersion);
  const seenVersion = useRef(projectsVersion);
  const styles = useStyles();
  const filesOpen = useLayout((s) => s.filesOpen);
  const tabs = useProjectTabs(project?.id ?? '');

  useEffect(() => {
    useChat.getState().listen();
    void useChat.getState().load(chatId);
    let alive = true;
    Promise.all([getChat(chatId), listProjects()])
      .then(([found, projects]: [Chat | null, Project[]]) => {
        if (!alive) return;
        setChat(found);
        setProject(projects.find((p) => p.id === found?.projectId) ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chatId]);

  // The project moved on (its status, a schedule): the header follows.
  useEffect(() => {
    if (!project || projectsVersion === seenVersion.current) return;
    seenVersion.current = projectsVersion;
    let alive = true;
    listProjects()
      .then((all) => {
        const found = all.find((p) => p.id === project.id);
        if (alive && found) setProject(found);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectsVersion, project?.id]);

  // A project with a tayang.json renders with its own command: show it before the user presses Render.
  useEffect(() => {
    if (!project) return;
    let alive = true;
    renderCommand(project.id)
      .then((c) => {
        // The chat spots the agent running this exact command as a render.
        setRenderArgv(project.id, c?.render ?? null);
        if (alive) setRuns(c);
      })
      .catch(() => alive && setRuns(null));
    return () => {
      alive = false;
    };
    // the agent may add tayang.json or node_modules during a turn, and a render installs: refetch on both
  }, [project?.id, reloadKey]);

  useEffect(() => {
    useUsage.getState().setChatAgent(agent);
    return () => useUsage.getState().setChatAgent(null);
  }, [agent]);

  const switchAgent = async (next: AgentId) => {
    if (next === agent || streaming) return;
    try {
      await useChat.getState().switchAgent(chatId, next);
      setChat((c) => (c ? { ...c, agentId: next } : c));
    } catch {
      /* the chat keeps its agent */
    }
  };

  // When a turn ends well the agent may have rendered a new version: reload the preview.
  const wasStreaming = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (wasStreaming.current && !streaming && messages.at(-1)?.role !== 'system') setReloadKey((k) => k + 1);
    wasStreaming.current = streaming;
  }, [streaming, messages]);

  // While the agent works the file sidebar follows its edits: read the open folders again every few seconds.
  const [treeKey, setTreeKey] = useState(0);
  useEffect(() => {
    if (!streaming || !filesOpen) return;
    const timer = setInterval(() => setTreeKey((k) => k + 1), TREE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [streaming, filesOpen]);

  /** What every send from this screen carries: the composer's and an answered A2UI surface's alike. */
  const sendOptions = (prompt: MessagePart[]): SendOpts => projectSendOptions(project, agent, prompt);

  const send = async (parts: MessagePart[]) => {
    const opts = sendOptions(parts);
    // A mentioned style is context for this message; the project keeps its own style and template.
    const ctx = styleContext(parts, await stylesFor(parts, styles));
    if (ctx.length) opts.promptParts = [...ctx, ...(opts.promptParts ?? parts)];
    void useChat.getState().send(chatId, parts, opts);
  };

  const renderVideo = async () => {
    if (!project || rendering) return;
    setRendering(true);
    setRenderError(null);
    useRender.getState().start(project.id, { source: 'tayang' });
    try {
      await mediaRender(project.id);
      const info = await mediaProbe(project.id).catch(() => null);
      await advanceProject(project.id, 'rendered');
      track('video rendered', { by: 'tayang', duration_sec: info?.durationSec ?? null, format: project.format });
      setProject(await updateProject(project.id, { durationSec: info?.durationSec ?? null }));
      useApp.getState().bumpProjects();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setRenderError(t('chat.couldntRender', { message: e instanceof Error ? e.message : String(e) }));
      trackError(e, 'render');
    } finally {
      setRendering(false);
      useRender.getState().end(project.id);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header data-tauri-drag-region className="flex h-16 shrink-0 items-center gap-6 border-b border-border px-6">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-medium">{project?.title ?? t('chat.title')}</span>
          {project && (
            <span className="text-xs text-text-3">
              {t(`kinds.${project.kind}`)} · {project.format} · {LANGUAGE_NAMES[project.language]}
            </span>
          )}
        </div>
        {project && (
          <div className="@container/steps ml-auto flex min-w-0 flex-1 justify-end overflow-hidden">
            <StepBar status={project.status} rendering={renderRunning} />
          </div>
        )}
        {project && (
          <Button variant="secondary" onClick={() => setScheduling(true)}>
            {t('schedule.action')}
          </Button>
        )}
        {project && (
          <Button
            variant="secondary"
            disabled={project.status !== 'rendered' && !project.socialPostId}
            title={project.status !== 'rendered' ? t('post.renderFirst') : undefined}
            onClick={() => setPosting(true)}
          >
            <Send size={14} aria-hidden="true" />
            {project.socialPostId ? t('post.postedLabel') : t('post.action')}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!project || rendering || streaming}
          className={project ? '' : 'ml-auto'}
          onClick={() => void renderVideo()}
        >
          {rendering ? t('chat.rendering') : t('chat.render')}
        </Button>
        <TraceButton chatId={chatId} />
        {project && (
          <button
            type="button"
            aria-pressed={filesOpen}
            aria-controls="chat-files"
            aria-label={filesOpen ? t('workspace.hideFiles') : t('workspace.showFiles')}
            title={filesOpen ? t('workspace.hideFiles') : t('workspace.showFiles')}
            onClick={() => useLayout.getState().toggleFiles()}
            className={cn(
              '-mr-2 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-raised',
              filesOpen ? 'text-foreground' : 'text-text-3',
            )}
          >
            <PanelRight size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </header>
      <ScheduleDialog open={scheduling} onOpenChange={setScheduling} project={project} onSaved={setProject} />
      {project && (
        <PostDialog
          open={posting}
          onOpenChange={setPosting}
          project={project}
          onPosted={setProject}
          agentBusy={streaming}
          onAskAgent={() => void send([{ type: 'text', text: t('post.askAgentPrompt') }])}
        />
      )}
      {runs && runs.render.length > 0 && <RenderCommandLine command={[...(runs.install?.length ? [runs.install] : []), runs.render].map(shellDisplay).join(' && ')} />}
      {renderError && (
        <p role="alert" className="m-0 border-b border-border px-6 py-2 text-xs text-orange-light">
          {renderError}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <section aria-label={t('chat.conversation')} className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} className="no-scrollbar h-full overflow-y-auto px-6 py-6">
            <MessageList messages={messages} streaming={streaming} sendOptions={sendOptions} scrollRef={scrollRef}>
              {question && (
                <QuestionCard
                  question={question}
                  agentId={agent}
                  onRespond={(r, summary) => void useChat.getState().respondQuestion(chatId, r, summary)}
                />
              )}
              {permission && (
                <PermissionCard
                  request={permission}
                  agentId={agent}
                  allowLabel={t('permission.allow')}
                  onRespond={(o) => void useChat.getState().respondPermission(chatId, o)}
                />
              )}
            </MessageList>
          </div>
          <TurnRail messages={messages} scrollRef={scrollRef} />
          <ScrollToBottom scrollRef={scrollRef} />
          </div>
          <div className="px-6 pb-6 pt-2">
            <Composer
              chatId={chatId}
              initialText={draft}
              onSend={send}
              disabled={streaming}
              onStop={() => void useChat.getState().cancel(chatId)}
              agentId={agent}
              onAgentChange={(a) => void switchAgent(a)}
              quickChips
              sees={project?.title}
              styles={styles}
              styleHint={project && !project.styleId ? t('composer.styleForMessage') : undefined}
            />
          </div>
        </section>
        <section
          id="chat-preview"
          aria-label={t('chat.preview')}
          className="relative shrink-0 border-l border-border"
          style={{ width: fitted.preview }}
        >
          <ResizeHandle
            label={t('layout.resizePreview')}
            side="left"
            aria-controls="chat-preview"
            value={fitted.preview}
            min={PREVIEW.min}
            max={fitted.previewMax}
            onResize={(w, live) => useLayout.getState().setPreview(Math.min(w, fitted.previewMax), live)}
            onReset={() => useLayout.getState().resetPreview()}
          />
          {project ? (
            <Workspace
              projectId={project.id}
              reloadKey={reloadKey}
              preview={
                <Preview
                  projectId={project.id}
                  chatId={chatId}
                  reloadKey={reloadKey}
                  onRender={() => void renderVideo()}
                  rendering={rendering}
                />
              }
            />
          ) : (
            <div data-testid="preview-slot" />
          )}
        </section>
        {project && fitted.files > 0 && (
          <aside id="chat-files" aria-label={t('workspace.files')} className="relative shrink-0 border-l border-border" style={{ width: fitted.files }}>
            <ResizeHandle
              label={t('layout.resizeFiles')}
              side="left"
              aria-controls="chat-files"
              value={fitted.files}
              min={FILES.min}
              max={fitted.filesMax}
              onResize={(w, live) => useLayout.getState().setFiles(Math.min(w, fitted.filesMax), live)}
              onReset={() => useLayout.getState().resetFiles()}
            />
            <FileTree
              projectId={project.id}
              folderName={project.folder.split(/[\\/]/).filter(Boolean).pop() ?? project.title}
              activePath={tabs.active}
              reloadKey={reloadKey + treeKey}
              onOpen={(path) => useWorkspace.getState().open(project.id, path)}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

/**
 * What Render will run for a project with a tayang.json, shown before the user presses it: one quiet
 * line, cut short when long (the whole command on hover and in the copy).
 */
function RenderCommandLine({ command }: { command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-6 text-xs text-text-3">
      <SquareTerminal size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      <span className="shrink-0">{t('chat.renderCommand')}</span>
      <code title={command} className="min-w-0 truncate font-mono text-[11px] text-text-2">
        {command}
      </code>
      <button
        type="button"
        aria-label={copied ? t('chat.commandCopied') : t('chat.copyCommand')}
        title={copied ? t('chat.commandCopied') : t('chat.copyCommand')}
        onClick={copy}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-text-3 hover:bg-raised hover:text-foreground"
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      </button>
    </div>
  );
}
