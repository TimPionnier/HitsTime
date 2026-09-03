import { useState } from 'react';
import { useApp } from '../store';

/** ⓘ — explains where the years come from, so the player plays knowingly. */
export function YearInfoTooltip() {
  const t = useApp((s) => s.t);
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        aria-label={t('yearInfoShort')}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="grid size-5 place-items-center rounded-full border border-muted/60 text-xs text-muted transition-colors hover:border-white hover:text-white"
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-1/2 top-7 z-20 w-72 -translate-x-1/2 rounded-xl bg-raised p-3 text-left text-xs leading-relaxed text-white shadow-xl shadow-black/50"
        >
          <span className="mb-1 block font-bold">{t('yearInfoShort')}</span>
          {t('yearInfo')}
        </span>
      )}
    </span>
  );
}
