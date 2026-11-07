import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { VideoLanguage } from '@tayang/shared';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** Each language by its own name, whatever the app's language is. */
const LANGUAGES: { id: VideoLanguage; flag: string; name: string }[] = [
  { id: 'id', flag: '🇮🇩', name: 'Bahasa Indonesia' },
  { id: 'en', flag: '🇬🇧', name: 'English' },
];

/** "🇮🇩 Bahasa Indonesia". */
export function languageLabel(id: VideoLanguage): string {
  const l = LANGUAGES.find((x) => x.id === id);
  return l ? `${l.flag} ${l.name}` : id;
}

/** Picks a video language from a searchable list, with each one's flag. */
export function LanguageCombobox({ value, onChange, labelledBy }: { value: VideoLanguage; onChange(v: VideoLanguage): void; labelledBy: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-labelledby={labelledBy}
          className="flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          <span className="truncate">{languageLabel(value)}</span>
          <ChevronsUpDown size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-text-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-0">
        <Command>
          <CommandInput placeholder={t('autopilot.form.languageSearch')} />
          <CommandList>
            <CommandEmpty>{t('autopilot.form.languageNone')}</CommandEmpty>
            {LANGUAGES.map((l) => (
              <CommandItem
                key={l.id}
                value={l.name}
                onSelect={() => {
                  onChange(l.id);
                  setOpen(false);
                }}
              >
                <span aria-hidden="true">{l.flag}</span>
                <span className="flex-1">{l.name}</span>
                <Check size={14} strokeWidth={2} aria-hidden="true" className={cn(l.id === value ? 'opacity-100' : 'opacity-0')} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
