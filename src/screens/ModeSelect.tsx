import { useState, useEffect, useCallback } from 'react';
import { useApp, type GameMode } from '../store';
import { ModePlayCount } from '../components/GlobalStats';
import { cn } from '../lib/cn';

const MODES: GameMode[] = ['daily', 'timeline', 'olderYounger'];

export function ModeSelect() {
  const t = useApp((s) => s.t);
  const startGame = useApp((s) => s.startGame);
  const prefetching = useApp((s) => s.prefetching);
  const error = useApp((s) => s.error);
  const hardMode = useApp((s) => s.hardMode);
  const setHardMode = useApp((s) => s.setHardMode);

  const [selected, setSelected] = useState(0);

  const startDaily = useApp((s) => s.startDaily);

  const pick = useCallback(
    (mode: GameMode) => {
      // Daily doesn't go through the playlist batch pipeline at all — its songs
      // come from the frozen pool, in a fixed order.
      if (mode === 'daily') void startDaily();
      else void startGame(mode);
    },
    [startGame, startDaily],
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
    { mode: 'daily', icon: '📅', label: t('dailyMode'), hint: t('dailyModeHint') },
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
              {/* Renders nothing until there is something to say, so the card
                  looks the same as it does today on a fresh deploy. */}
              <ModePlayCount mode={c.mode} />
            </div>
          </button>
        ))}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={hardMode}
        onClick={() => setHardMode(!hardMode)}
        // Enter on the switch must toggle it, not also start the selected mode
        // through the window shortcut above.
        onKeyDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-md items-center gap-3 rounded-2xl bg-surface px-4 py-3 text-left transition-colors hover:bg-raised"
      >
        <span
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors',
            hardMode ? 'bg-accent' : 'bg-raised ring-1 ring-muted/40',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform',
              hardMode && 'translate-x-5',
            )}
          />
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-bold">{t('hardMode')}</span>
          <span className="text-xs text-muted">{t('hardModeHint')}</span>
        </span>
      </button>
    </div>
  );
}
