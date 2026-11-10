import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FileUp, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { BUILTIN_SKILLS, type UserSkill } from '@tayang/skills';
import { Button } from '@/components/Button';
import { Markdown } from '@/components/Markdown';
import { Oyen } from '@/components/Oyen';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { deleteSkill, importSkill, listSkills, readSkill, saveSkill, setSkillEnabled } from '@/lib/ipc';
import { cn } from '@/lib/utils';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the editor is open on: a new skill, or one of the user's. */
type Editing = { id?: string; name: string; description: string; body: string };

function SkillEditor({ editing, onClose, onSaved }: { editing: Editing | null; onClose(): void; onSaved(): void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Editing | null>(editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(editing);
    setError(null);
  }, [editing]);
  const isNew = !editing?.id;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveSkill(draft);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<Editing>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[640px]">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{isNew ? t('skills.newTitle') : t('skills.editTitle', { name: editing?.id ?? '' })}</DialogTitle>
            <DialogDescription>{t('skills.editorHint')}</DialogDescription>
          </DialogHeader>
          {isNew && (
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              {t('skills.name')}
              <Input
                autoFocus
                value={draft?.name ?? ''}
                onChange={(e) => set({ name: e.target.value })}
                placeholder={t('skills.namePlaceholder')}
                maxLength={64}
                className="h-9"
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            {t('skills.whenToUse')}
            <Textarea
              autoFocus={!isNew}
              value={draft?.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
              placeholder={t('skills.whenPlaceholder')}
              rows={2}
              className="min-h-0 resize-none text-[13px]"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            {t('skills.instructions')}
            <Textarea
              value={draft?.body ?? ''}
              onChange={(e) => set({ body: e.target.value })}
              placeholder={t('skills.instructionsPlaceholder')}
              rows={12}
              spellCheck={false}
              className="max-h-[50vh] font-mono text-[12px] leading-relaxed"
            />
          </label>
          {error && (
            <p role="alert" className="m-0 text-xs text-orange-light">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('skills.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !draft?.description.trim() || !draft?.body.trim() || (isNew && !draft?.name.trim())}>
              {isNew ? t('skills.create') : t('skills.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SkillCard({
  skill,
  onEdit,
  onToggle,
  onDelete,
}: {
  skill: UserSkill;
  onEdit(): void;
  onToggle(on: boolean): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <article className={cn('flex items-start gap-4 rounded-xl border border-border bg-card p-4', !skill.enabled && 'opacity-70')}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-mono text-[13px] font-medium">{skill.id}</span>
        <span className="line-clamp-2 text-[13px] text-text-2">{skill.description}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {confirming ? (
          <>
            <Button variant="ghost" className="h-8 px-2 text-[13px]" onClick={() => setConfirming(false)}>
              {t('skills.keep')}
            </Button>
            <Button variant="secondary" className="h-8 px-3 text-[13px] text-orange-light" onClick={onDelete}>
              {t('skills.deleteConfirm')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="icon" className="size-8 px-0" aria-label={t('skills.edit', { name: skill.id })} title={t('skills.editTip')} onClick={onEdit}>
              <Pencil size={14} strokeWidth={1.5} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 px-0"
              aria-label={t('skills.delete', { name: skill.id })}
              title={t('skills.deleteTip')}
              onClick={() => setConfirming(true)}
            >
              <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
            </Button>
            <Switch
              className="ml-2"
              checked={skill.enabled}
              onCheckedChange={onToggle}
              aria-label={t('skills.toggle', { name: skill.id })}
            />
          </>
        )}
      </div>
    </article>
  );
}

/** The skills agents use in Tayang: the built-in one, and the user's own (added, imported, turned off). */
export function Skills() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<UserSkill[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [viewing, setViewing] = useState<(typeof BUILTIN_SKILLS)[number] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listSkills()
      .then(setSkills)
      .catch((e) => {
        setSkills([]);
        setError(errorText(e));
      });
  }, []);
  useEffect(load, [load]);

  const act = (run: () => Promise<unknown>) => {
    setError(null);
    void run()
      .catch((e) => setError(errorText(e)))
      .finally(load);
  };

  const importOne = () =>
    act(async () => {
      const picked = await openDialog({ multiple: false, directory: false, filters: [{ name: 'SKILL.md', extensions: ['md'] }] });
      if (typeof picked === 'string') await importSkill(picked);
    });

  const edit = (s: UserSkill) =>
    act(async () => {
      const d = await readSkill(s.id);
      setEditing({ id: s.id, name: s.id, description: d.skill.description, body: d.body });
    });

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-8">
      <div data-tauri-drag-region className="flex flex-wrap items-center gap-4">
        <div className="mr-auto flex flex-col gap-1">
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.01em]">{t('skills.title')}</h1>
          <span className="text-sm text-text-2">{t('skills.subtitle')}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={importOne}>
            <FileUp size={16} strokeWidth={1.5} aria-hidden="true" />
            {t('skills.import')}
          </Button>
          <Button onClick={() => setEditing({ name: '', description: '', body: '' })}>
            <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
            {t('skills.new')}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="m-0 rounded-md border border-deep-orange px-3 py-2 text-[13px] text-orange-light">
          {error}
        </p>
      )}

      <section aria-labelledby="skills-yours" className="flex flex-col gap-2">
        <h2 id="skills-yours" className="m-0 text-[13px] font-medium text-text-3">
          {t('skills.yours')}
        </h2>
        {skills?.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <Oyen mood="wink" size={40} />
            <span className="text-sm font-medium">{t('skills.emptyTitle')}</span>
            <span className="max-w-[420px] text-[13px] text-text-2">{t('skills.emptyBody')}</span>
          </div>
        )}
        {skills?.map((s) => (
          <SkillCard
            key={s.id}
            skill={s}
            onEdit={() => edit(s)}
            onToggle={(on) => act(() => setSkillEnabled(s.id, on))}
            onDelete={() => act(() => deleteSkill(s.id))}
          />
        ))}
      </section>

      <section aria-labelledby="skills-builtin" className="flex flex-col gap-2">
        <h2 id="skills-builtin" className="m-0 text-[13px] font-medium text-text-3">
          {t('skills.builtin')}
        </h2>
        {BUILTIN_SKILLS.map((s) => (
          <article key={s.id} className="flex items-start gap-4 rounded-xl border border-border bg-card p-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-2 font-mono text-[13px] font-medium">
                {s.id}
                <span className="inline-flex items-center gap-1 rounded-full border border-hairline px-1.5 py-px font-sans text-[10px] font-medium text-text-3">
                  <Lock size={10} aria-hidden="true" />
                  {t('skills.alwaysOn')}
                </span>
              </span>
              <span className="line-clamp-2 text-[13px] text-text-2">{s.description}</span>
            </div>
            <Button variant="ghost" className="h-8 shrink-0 px-3 text-[13px]" onClick={() => setViewing(s)}>
              {t('skills.view')}
            </Button>
          </article>
        ))}
      </section>

      <SkillEditor editing={editing} onClose={() => setEditing(null)} onSaved={load} />

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-[720px]">
          <DialogHeader>
            <DialogTitle className="font-mono">{viewing?.id}</DialogTitle>
            <DialogDescription>{t('skills.builtinHint')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto text-[13px]">{viewing && <Markdown text={viewing.body} />}</div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
