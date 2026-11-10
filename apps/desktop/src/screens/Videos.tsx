import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, FolderOpen, Search } from 'lucide-react';
import type { Project, ProjectStatus } from '@tayang/shared';
import { Button } from '@/components/Button';
import { Oyen } from '@/components/Oyen';
import { ScheduleDialog } from '@/components/ScheduleDialog';
import { SmallPoster, useVideoThumb } from '@/components/VideoPoster';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { locale } from '@/i18n';
import { listProjects, showVideoInFolder } from '@/lib/ipc';
import { openProjectChat } from '@/lib/openProject';
import { ago, mmss } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useApp } from '@/state/app';

type Tab = 'all' | 'progress' | 'rendered' | 'scheduled';

const TABS: { id: Tab; match(p: Project): boolean }[] = [
  { id: 'all', match: () => true },
  { id: 'progress', match: (p) => p.status === 'draft' || p.status === 'building' },
  { id: 'rendered', match: (p) => p.status === 'rendered' },
  // Scheduling leaves `status` alone, so the tab follows the schedule itself.
  { id: 'scheduled', match: (p) => p.status === 'scheduled' || (!!p.scheduledAt && !p.postedAt) },
];

const DOT: Record<ProjectStatus, string> = {
  building: 'bg-primary',
  draft: 'border border-text-3',
  rendered: 'bg-text-3',
  scheduled: 'bg-foreground',
};

export function Videos() {
  const { t } = useTranslation();
  const navigate = useApp((s) => s.navigate);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [scheduleFor, setScheduleFor] = useState<Project | null>(null);
  // Statuses move on by themselves (a chat builds, a render finishes): follow them.
  const version = useApp((s) => s.projectsVersion);

  useEffect(() => {
    let alive = true;
    listProjects()
      .then((p) => alive && setProjects(p))
      .catch(() => alive && setProjects((l) => l ?? []));
    return () => {
      alive = false;
    };
  }, [version]);

  const list = projects ?? [];
  const shown = useMemo(() => {
    const current = TABS.find((x) => x.id === tab)!;
    const needle = q.trim().toLowerCase();
    return list.filter((p) => current.match(p) && (!needle || p.title.toLowerCase().includes(needle)));
  }, [list, tab, q]);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-8">
      <div data-tauri-drag-region className="flex flex-wrap items-center gap-4">
        <div className="mr-auto flex flex-col gap-1">
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.01em]">{t('videos.title')}</h1>
          <span className="text-sm text-text-2">{t('videos.subtitle')}</span>
        </div>
        <div className="relative w-60">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" className="absolute top-1/2 left-3 -translate-y-1/2 text-text-3" />
          <Input
            type="search"
            aria-label={t('videos.searchAria')}
            placeholder={t('videos.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 bg-card pl-9"
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList variant="line" aria-label={t('videos.filterAria')} className="h-10 w-full justify-start border-b border-border p-0">
          {TABS.map((tb) => (
            <TabsTrigger key={tb.id} value={tb.id} className="h-10 flex-none px-3 text-sm">
              {t(`videos.tabs.${tb.id}`)}
              <span className="ml-1 font-mono text-xs text-text-3">{list.filter((p) => tb.match(p)).length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {projects && list.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
          <Oyen mood="default" size={64} />
          <span className="text-base font-medium">{t('videos.empty')}</span>
          <Button onClick={() => navigate({ name: 'chat-new' })}>{t('videos.newChat')}</Button>
        </div>
      ) : (
        <div className="@container flex flex-col">
          <div aria-hidden="true" className="flex items-center gap-4 border-b border-border px-3 pb-2 text-xs text-text-3">
            <span className="w-10 shrink-0" />
            <span className="min-w-0 flex-1">{t('videos.columns.video')}</span>
            <span className="w-32 shrink-0">{t('videos.columns.status')}</span>
            <span className="hidden w-14 shrink-0 @2xl:block">{t('videos.columns.length')}</span>
            <span className="hidden w-40 shrink-0 @3xl:block">{t('videos.columns.schedule')}</span>
            <span className="hidden w-24 shrink-0 text-right @xl:block">{t('videos.columns.updated')}</span>
            {/* The folder and schedule buttons. */}
            <span className="w-[72px] shrink-0" />
          </div>
          <ul aria-label={t('videos.title')} className="m-0 flex list-none flex-col p-0">
            {shown.map((p) => (
              <VideoRow key={p.id} project={p} onSchedule={() => setScheduleFor(p)} />
            ))}
          </ul>
          {shown.length === 0 && <p className="m-0 px-3 py-6 text-sm text-text-3">{t('videos.noMatch')}</p>}
        </div>
      )}
      <ScheduleDialog
        open={scheduleFor !== null}
        onOpenChange={(o) => !o && setScheduleFor(null)}
        project={scheduleFor}
        onSaved={(saved) => setProjects((l) => l && l.map((x) => (x.id === saved.id ? saved : x)))}
      />
    </div>
  );
}

/**
 * One video as a compact row: its picture, title and kind, status, length, schedule and when it last
 * changed. The row opens the video's chat (where everything else is); the folder button shows its newest
 * render (or its project folder) in the file manager; the clock schedules it.
 */
function VideoRow({ project: p, onSchedule }: { project: Project; onSchedule(): void }) {
  const { t } = useTranslation();
  const thumb = useVideoThumb(p);
  const at = p.scheduledAt && !Number.isNaN(new Date(p.scheduledAt).getTime()) ? new Date(p.scheduledAt) : null;
  return (
    <li className="group relative flex items-center gap-4 rounded-lg px-3 py-2 hover:bg-raised/50">
      {/* The whole row opens the chat; the schedule button sits above it. */}
      <button
        type="button"
        aria-label={t('videos.open', { title: p.title })}
        onClick={() => void openProjectChat(p).catch(() => {})}
        className="absolute inset-0 cursor-pointer rounded-lg border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-ring"
      />
      <SmallPoster thumb={thumb} />
      <div className="pointer-events-none flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{p.title}</span>
        <span className="truncate text-xs text-text-3">
          {t(`kinds.${p.kind}`)} · {p.format}
        </span>
      </div>
      <span className="pointer-events-none flex w-32 shrink-0 items-center gap-2 text-xs text-text-2">
        <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', thumb.rendering ? 'tayang-pulse bg-primary' : DOT[p.status])} />
        {thumb.rendering ? t('videos.renderingNow') : t(`videos.status.${p.status}`)}
      </span>
      <span className="pointer-events-none hidden w-14 shrink-0 font-mono text-xs text-text-3 @2xl:block">
        {thumb.durationSec ? mmss(thumb.durationSec) : '—'}
      </span>
      <span className="pointer-events-none hidden w-40 shrink-0 truncate text-xs @3xl:block">
        {at ? (
          <span className={p.postedAt ? 'text-text-3' : 'text-foreground'}>
            {new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(at)}
          </span>
        ) : (
          <span className="text-text-3">—</span>
        )}
      </span>
      <span className="pointer-events-none hidden w-24 shrink-0 text-right text-xs text-text-3 @xl:block">{ago(p.updatedAt)}</span>
      {/* The folder and schedule buttons, together as wide as the header's last column. */}
      <span className="relative flex w-[72px] shrink-0 items-center justify-end gap-2">
        <button
          type="button"
          aria-label={t('videos.showInFolderFor', { title: p.title })}
          title={t('videos.showInFolder')}
          onClick={() => void showVideoInFolder(p.id).catch(() => {})}
          className="relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-text-3 opacity-0 group-hover:opacity-100 hover:bg-raised hover:text-foreground focus-visible:opacity-100"
        >
          <FolderOpen size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t('schedule.actionFor', { title: p.title })}
          title={t('schedule.action')}
          onClick={onSchedule}
          className={cn(
            'relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-text-3 hover:bg-raised hover:text-foreground',
            !at && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <CalendarClock size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}
