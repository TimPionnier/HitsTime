import { useState, useEffect, useCallback } from 'react';
import { useApp, type GameMode } from '../store';

const MODES: GameMode[] = ['timeline', 'olderYounger'];

export function ModeSelect() {
  const t = useApp((s) => s.t);
  const startGame = useApp((s) => s.startGame);
  const prefetching = useApp((s) => s.prefetching);
  const error = useApp((s) => s.error);

  const [selected, setSelected] = useState(0);

  const pick = useCallback(
    (mode: GameMode) => {
      void startGame(mode);
    },
    [startGame],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => (s - 1 + MODES.length) % MODES.length);
      } else if (e.code === 'ArrowRight' || e.code === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => (s + 1) % MODES.length);
      } else if (e.code === 'Enter') {
        e.preventDefault();
        pick(MODES[selected]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, pick]);

  const cards: { mode: GameMode; icon: string; label: string; hint: string }[] = [
    { mode: 'timeline', icon: '📐', label: t('timelineMode'), hint: t('timelineModeHint') },
    { mode: 'olderYounger', icon: '⚖️', label: t('olderYounger'), hint: t('olderYoungerHint') },
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 sm:gap-8 px-4 sm:px-6">
      <div className="text-center">
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
          Hits<span className="text-accent">Time</span>
        </h1>
        <p className="mt-2 sm:mt-3 max-w-md text-sm sm:text-base text-muted">{t('tagline')}</p>
      </div>

      <h2 className="text-lg sm:text-xl font-bold">{t('chooseMode')}</h2>

      {prefetching && (
        <div className="flex items-center gap-2">
          <div className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-xs text-muted">{t('loadingTracks')}</span>
        </div>
      )}

      {error && <p className="max-w-md text-sm font-semibold text-danger">{error}</p>}

      <div className="flex w-full flex-col sm:flex-row items-stretch justify-center gap-3 sm:gap-4">
        {cards.map((c, i) => (
          <button
            key={c.mode}
            onClick={() => pick(c.mode)}
            onMouseEnter={() => setSelected(i)}
            className={`flex w-full sm:w-64 flex-row sm:flex-col items-center gap-3 sm:gap-3 rounded-2xl p-4 sm:p-6 text-left sm:text-center transition-all hover:scale-[1.03] ${
              selected === i
                ? 'bg-raised ring-2 ring-accent'
                : 'bg-surface hover:bg-raised'
            }`}
          >
            <span className="text-3xl sm:text-4xl">{c.icon}</span>
            <div className="flex flex-col sm:items-center">
              <span className="text-base sm:text-lg font-bold">{c.label}</span>
              <span className="text-xs text-muted">{c.hint}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
