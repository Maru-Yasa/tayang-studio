import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FileUp, Link2, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/Button';
import { Oyen } from '@/components/Oyen';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { discardGithubSkills, fetchGithubSkills, importSkill, installGithubSkills, type SkillDownload } from '@/lib/ipc';
import { cn } from '@/lib/utils';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Adds skills from a GitHub link (download, choose, add) or from a SKILL.md on this computer.
 * Skills that come with scripts are marked, and adding one says what that means.
 */
export function SkillImportDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange(open: boolean): void; onAdded(): void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState<SkillDownload | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // The download to throw away if the dialog closes without adding.
  const pending = useRef<string | null>(null);

  const forget = () => {
    if (pending.current) void discardGithubSkills(pending.current).catch(() => {});
    pending.current = null;
  };

  useEffect(() => {
    if (open) return;
    forget();
    setUrl('');
    setDownload(null);
    setPicked(new Set());
    setError(null);
    setBusy(false);
  }, [open]);

  const find = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    forget();
    setBusy(true);
    setError(null);
    setDownload(null);
    try {
      const d = await fetchGithubSkills(url.trim());
      pending.current = d.id;
      setDownload(d);
      setPicked(new Set(d.skills.length === 1 ? d.skills.map((s) => s.folder) : []));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!download || !picked.size) return;
    setBusy(true);
    setError(null);
    try {
      const picks = download.skills.filter((s) => picked.has(s.folder)).map((s) => ({ folder: s.folder, source: s.source }));
      const result = await installGithubSkills(download.id, picks);
      pending.current = null;
      onAdded();
      if (result.failed.length) {
        setDownload(null);
        setError(t('skills.someFailed', { list: result.failed.join('; ') }));
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async () => {
    setError(null);
    try {
      const file = await openDialog({ multiple: false, directory: false, filters: [{ name: 'SKILL.md', extensions: ['md'] }] });
      if (typeof file !== 'string') return;
      await importSkill(file);
      onAdded();
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const toggle = (folder: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(folder);
      else next.delete(folder);
      return next;
    });

  const runsCode = download?.skills.some((s) => picked.has(s.folder) && s.scriptCount > 0) ?? false;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{t('skills.importTitle')}</DialogTitle>
          <DialogDescription>{t('skills.importHint')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void find(e)} className="flex flex-col gap-1.5">
          <label htmlFor="skill-github" className="flex items-center gap-1.5 text-[13px] font-medium">
            <Link2 size={14} strokeWidth={1.5} aria-hidden="true" />
            {t('skills.fromGithub')}
          </label>
          <div className="flex gap-2">
            <Input
              id="skill-github"
              autoFocus
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('skills.githubPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className="h-9 flex-1 font-mono text-[13px]"
            />
            <Button type="submit" variant="secondary" disabled={busy || !url.trim()}>
              {busy && !download ? t('skills.finding') : t('skills.find')}
            </Button>
          </div>
          <span className="text-xs text-text-3">{t('skills.githubHint')}</span>
        </form>

        {download && (
          <section aria-label={t('skills.found', { count: download.skills.length })} className="flex flex-col gap-2">
            <span className="text-[13px] text-text-2">{t('skills.found', { count: download.skills.length })}</span>
            <ul className="m-0 flex max-h-[40vh] list-none flex-col overflow-y-auto rounded-xl border border-border p-0">
              {download.skills.map((s) => {
                const id = `found-${s.folder || 'root'}`;
                return (
                  <li key={s.folder} className="flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                    <Checkbox id={id} className="mt-0.5" checked={picked.has(s.folder)} onCheckedChange={(v) => toggle(s.folder, v === true)} />
                    <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px] font-medium">{s.name}</span>
                        {s.scriptCount > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-deep-orange px-1.5 py-px text-[10px] font-medium text-orange-light">
                            <TerminalSquare size={10} aria-hidden="true" />
                            {t('skills.runsCode')}
                          </span>
                        )}
                      </span>
                      <span className="line-clamp-2 text-xs text-text-2">{s.description}</span>
                      {s.scriptCount > 0 && (
                        <span className="truncate font-mono text-[11px] text-text-3">
                          {s.scripts.slice(0, 3).join(', ')}
                          {s.scriptCount > 3 && ` ${t('skills.moreFiles', { count: s.scriptCount - 3 })}`}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {runsCode && (
          <div role="note" className="flex items-start gap-3 rounded-lg border border-deep-orange px-3 py-2.5">
            <Oyen mood="surprised" size={24} />
            <span className="text-[13px] text-text-2">{t('skills.codeWarning')}</span>
          </div>
        )}

        {error && (
          <p role="alert" className="m-0 break-words text-[13px] text-orange-light">
            {error}
          </p>
        )}

        {download ? (
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('skills.cancel')}
            </Button>
            <Button type="button" disabled={busy || !picked.size} onClick={() => void add()}>
              {picked.size ? t('skills.add', { count: picked.size }) : t('skills.addNone')}
            </Button>
          </DialogFooter>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 text-xs text-text-3">
              <span className="h-px flex-1 bg-border" />
              {t('skills.or')}
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void pickFile()} className={cn('w-full gap-2')}>
              <FileUp size={16} strokeWidth={1.5} aria-hidden="true" />
              {t('skills.pickFile')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
