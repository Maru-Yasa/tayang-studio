import { UpgradeCard } from '@/components/UpgradeCard';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Calendar, LayoutPanelLeft, Share2, MessageCircle, Palette, Plane, Plus, Smartphone, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { RecentChat } from '@tayang/shared';
import logo from '@/assets/brand/tayang-horizontal-reversed-color.svg';
import mark from '@/assets/brand/oyen-symbol-color.svg';
import { UpdateBanner } from '@/components/UpdateBanner';
import { Button } from '@/components/Button';
import { AllChats } from '@/components/AllChats';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { listRecentChats, setThreadArchived } from '@/lib/ipc';
import { recentChats } from '@/lib/recentChats';
import { useApp, type Route } from '@/state/app';
import { useChat } from '@/state/chat';
import { useJobs } from '@/state/jobs';
import { cn } from '@/lib/utils';
import { AUTOPILOT_ENABLED } from '@/lib/features';

/** Recent shows this many; See all lists every chat. */
const RECENT = 10;
/** One more than Recent shows: Rust counts a project once, so an eleventh row means See all has more. */
const RECENT_FETCH = RECENT + 1;

type ChatStatus = 'working' | 'needs-you' | 'idle';
const DOT: Record<ChatStatus, string> = {
  working: 'animate-pulse bg-foreground motion-reduce:animate-none',
  'needs-you': 'bg-primary',
  idle: 'bg-[#4A4A4A]',
};

export type SidebarKey = 'chat' | 'videos' | 'social' | 'style' | 'autopilot' | 'agents' | 'skills' | 'calendar' | 'settings';

const NAV: { key: SidebarKey; icon: typeof Calendar; route: Route }[] = [
  { key: 'chat', icon: MessageCircle, route: { name: 'chat-new' } },
  { key: 'videos', icon: Smartphone, route: { name: 'videos' } },
  { key: 'social', icon: Share2, route: { name: 'social' } },
  { key: 'style', icon: Palette, route: { name: 'style' } },
  { key: 'autopilot', icon: Plane, route: { name: 'autopilot' } },
  { key: 'agents', icon: LayoutPanelLeft, route: { name: 'agents' } },
  { key: 'skills', icon: Sparkles, route: { name: 'skills' } },
  { key: 'calendar', icon: Calendar, route: { name: 'calendar' } },
];

/** In the icon rail a control shows its name in a tooltip; in the full sidebar it shows it itself. */
function RailTip({ rail, label, children }: { rail: boolean; label: string; children: React.ReactElement }) {
  if (!rail) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function NavItem({
  active,
  label,
  icon: Icon,
  onClick,
  count,
  badge,
  rail = false,
}: {
  active: boolean;
  label: string;
  icon: typeof Calendar;
  onClick: () => void;
  count?: number;
  /** A word after the label (Soon); not on the rail. */
  badge?: string;
  rail?: boolean;
}) {
  // The rail shows the count as a dot: its number goes in the name and the tooltip.
  const railLabel = count !== undefined ? `${label} (${count})` : label;
  return (
    <RailTip rail={rail} label={railLabel}>
      <a
        href="#"
        role="link"
        aria-current={active ? 'page' : undefined}
        aria-label={rail ? railLabel : undefined}
        onClick={(e) => {
          e.preventDefault();
          onClick();
        }}
        className={cn(
          'relative flex h-8 items-center rounded-md text-[13px] font-medium no-underline transition-colors',
          rail ? 'w-9 justify-center' : 'gap-2.5 px-2.5',
          active
            ? 'bg-raised text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
            : 'text-text-2 hover:bg-raised/50 hover:text-foreground',
        )}
      >
        <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
        {!rail && <span className="truncate">{label}</span>}
        {!rail && badge && ' '}
        {!rail && badge && (
          <span className="ml-auto rounded-full border border-hairline px-1.5 py-px text-[10px] font-medium text-text-3">{badge}</span>
        )}
        {count !== undefined &&
          (rail ? (
            <span aria-hidden="true" className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />
          ) : (
            <span className="ml-auto font-mono text-xs text-text-2">{count}</span>
          ))}
      </a>
    </RailTip>
  );
}

export function Sidebar({ active, collapsed = false }: { active: SidebarKey; collapsed?: boolean }) {
  const { t } = useTranslation();
  const navigate = useApp((s) => s.navigate);
  const needsYou = useApp((s) => s.needsYouCount);
  const version = useApp((s) => s.projectsVersion);
  const openChatId = useApp((s) => (s.route.name === 'chat' ? s.route.chatId : null));
  const streaming = useChat((s) => s.streaming);
  const permissions = useChat((s) => s.permissions);
  const jobs = useJobs((s) => s.jobs);
  const [recent, setRecent] = useState<RecentChat[]>([]);
  const [seeAll, setSeeAll] = useState(false);
  // A chat that starts or ends a turn moves up Recent.
  const running = Object.keys(streaming).filter((id) => streaming[id]).sort().join(' ');

  useEffect(() => {
    let alive = true;
    listRecentChats(RECENT_FETCH)
      .then((list) => alive && setRecent(recentChats(list)))
      .catch(() => alive && setRecent([]));
    return () => {
      alive = false;
    };
  }, [version, openChatId, running]);

  const status = (chatId: string): ChatStatus => {
    const waiting =
      !!permissions[chatId]?.length || jobs.some((j) => j.chatId === chatId && (j.status === 'needs-you' || j.status === 'failed'));
    return waiting ? 'needs-you' : streaming[chatId] ? 'working' : 'idle';
  };

  const openChat = (chat: RecentChat) => {
    // A row this session already has may be newer than the list (an agent switch since it was read).
    if (!useChat.getState().rows[chat.id]) useChat.getState().rememberChat(chat);
    setSeeAll(false);
    navigate({ name: 'chat', chatId: chat.id });
  };

  // Archived threads leave Recent (Settings › Archive brings them back); the open one closes.
  const archive = (chat: RecentChat) => {
    setRecent((list) => list.filter((c) => c.id !== chat.id));
    const route = useApp.getState().route;
    if (route.name === 'chat' && route.chatId === chat.id) navigate({ name: 'chat-new' });
    void setThreadArchived(chat.id, true)
      .catch(() => {})
      .finally(() => useApp.getState().bumpProjects());
  };

  // Chat goes back to the chat New chat started while it is still running; New chat always starts fresh.
  const goChat = () => {
    const live = useApp.getState().newChatId;
    navigate(live && useChat.getState().streaming[live] ? { name: 'chat', chatId: live } : { name: 'chat-new' });
  };

  const rail = collapsed;
  return (
    <TooltipProvider delayDuration={200}>
      <nav
        aria-label={t('sidebar.main')}
        data-collapsed={rail || undefined}
        className={cn(
          'flex h-full w-full flex-col overflow-hidden border-r border-border bg-sidebar pb-4 pt-4 text-foreground',
          rail ? 'items-center px-3' : 'px-3',
        )}
      >
        {rail ? (
          // The macOS window buttons sit over the rail's top: the logo starts below them.
          <div className="flex justify-center pb-4 pt-11" data-tauri-drag-region>
            <img src={mark} alt="Tayang" className="block size-7" />
          </div>
        ) : (
          <div className="flex items-center gap-2 px-2 pb-4 pt-5" data-tauri-drag-region>
            <img src={logo} alt="Tayang" className="block h-7 w-auto" />
            <span className="mt-1 text-[13px] text-text-3">{t('sidebar.studio')}</span>
          </div>
        )}

        <RailTip rail={rail} label={t('sidebar.newChat')}>
          <Button
            variant="secondary"
            aria-label={rail ? t('sidebar.newChat') : undefined}
            className={cn('mb-3 h-8 text-[13px]', rail ? 'size-9 px-0' : 'w-full')}
            onClick={() => navigate({ name: 'chat-new' })}
          >
            <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
            {!rail && <span className="truncate">{t('sidebar.newChat')}</span>}
          </Button>
        </RailTip>

        <div className="flex flex-col gap-px">
          {NAV.map((n) => (
            <NavItem
              key={n.key}
              rail={rail}
              active={active === n.key}
              label={t(`sidebar.${n.key}` as 'sidebar.chat')}
              icon={n.icon}
              onClick={() => (n.key === 'chat' ? goChat() : navigate(n.route))}
              count={n.key === 'agents' && needsYou > 0 ? needsYou : undefined}
              badge={n.key === 'autopilot' && !AUTOPILOT_ENABLED ? t('comingSoon.short') : undefined}
            />
          ))}
        </div>

        {!rail && (
          <div data-recent className="scrollbar-on-hover mt-4 flex min-h-0 flex-col gap-px overflow-y-auto">
            <span className="px-2.5 pb-1 text-xs text-text-3">{t('sidebar.recent')}</span>
            {recent.slice(0, RECENT).map((c) => {
              const st = status(c.id);
              const name = c.projectTitle ?? c.title;
              return (
                <div key={c.id} className="group relative flex shrink-0">
                  <a
                    href="#"
                    aria-current={openChatId === c.id ? 'page' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      openChat(c);
                    }}
                    className={cn(
                      'flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-[13px] text-[#D9D9D9] no-underline hover:bg-raised/50',
                      openChatId === c.id && 'bg-raised/50',
                      st !== 'working' && 'group-hover:pr-9 group-focus-within:pr-9',
                    )}
                  >
                    <span aria-hidden="true" data-status={st} className={cn('size-1.5 shrink-0 rounded-full', DOT[st])} />
                    <span className="truncate">{name}</span>
                    {st !== 'idle' && ' '}
                    {st !== 'idle' && <span className="sr-only">{t(st === 'working' ? 'sidebar.working' : 'sidebar.needsYou')}</span>}
                  </a>
                  {/* Not while its agent works: the turn would carry on out of sight. */}
                  {st !== 'working' && (
                    <button
                      type="button"
                      aria-label={t('sidebar.archive', { name })}
                      title={t('sidebar.archiveTip')}
                      onClick={() => archive(c)}
                      className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-text-3 opacity-0 hover:bg-raised hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Archive size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
            {recent.length > RECENT && (
              <button
                type="button"
                onClick={() => setSeeAll(true)}
                className="flex h-7 shrink-0 cursor-pointer items-center rounded-md px-2.5 text-left text-[13px] text-text-3 hover:bg-raised/50 hover:text-foreground"
              >
                {t('sidebar.seeAll')}
              </button>
            )}
            <AllChats open={seeAll} onOpenChange={setSeeAll} onPick={openChat} />
          </div>
        )}

        <div className={cn('mt-auto flex shrink-0 flex-col gap-2 pt-3', rail && 'items-center')}>
          {/* i18n-ignore: an analytics id, not copy */}
          {!rail && <UpgradeCard where="sidebar" />}
          <NavItem
            rail={rail}
            active={active === 'settings'}
            label={t('sidebar.settings')}
            icon={SlidersHorizontal}
            onClick={() => navigate({ name: 'settings' })}
          />
          {!rail && <UpdateBanner />}
        </div>
      </nav>
    </TooltipProvider>
  );
}
