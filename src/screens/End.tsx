import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../store';
import { bestScores } from '../services/leaderboard';
import { Leaderboard } from '../components/Leaderboard';
import { TimelineCard } from '../components/TimelineCard';

const ACTIONS = ['replay', 'changeMode'] as const;

function EndTimeline() {
  const endTimeline = useApp((s) => s.endTimeline);
  const t = useApp((s) => s.t);
  const scroller = useRef<HTMLDivElement>(null);

  if (!endTimeline || endTimeline.tracks.length === 0) return null;

  const wrongId = endTimeline.wrongTrack?.track.id ?? null;
  const scrollBy = (dx: number) => scroller.current?.scrollBy({ left: dx, behavior: 'smooth' });

  const arrowCls =
    'grid size-9 sm:size-11 shrink-0 place-items-center rounded-full bg-raised text-xl text-muted transition-colors hover:bg-accent hover:text-ground';

  return (
    <div className="w-full">
      <h2 className="mb-2 text-center text-sm font-bold uppercase tracking-widest text-muted">
        {t('yourTimeline')}
      </h2>
      <div className="flex items-center gap-1 sm:gap-2 px-1 sm:px-3">
        <button className={arrowCls} onClick={() => scrollBy(-200)} aria-label="Scroll left">
          ‹
        </button>
        <div
          ref={scroller}
          className="timeline-scroll flex flex-1 items-center gap-1 overflow-x-auto py-2"
        >
          <div className="mx-auto flex items-center gap-1">
            {endTimeline.tracks.map((track) => (
              <TimelineCard
                key={track.id}
                track={track}
                tone={track.id === wrongId ? 'wrong' : 'normal'}
                small
              />
            ))}
          </div>
        </div>
        <button className={arrowCls} onClick={() => scrollBy(200)} aria-label="Scroll right">
          ›
        </button>
      </div>
    </div>
  );
}

export function EndScreen() {
  const game = useApp((s) => s.game);
  const oyGame = useApp((s) => s.oyGame);
  const gameMode = useApp((s) => s.gameMode);
  const playlist = useApp((s) => s.playlist);
  const provider = useApp((s) => s.provider);
  const replaySame = useApp((s) => s.replaySame);
  const changeMode = useApp((s) => s.changeMode);
  const endTimeline = useApp((s) => s.endTimeline);
  const t = useApp((s) => s.t);

  const [selected, setSelected] = useState(0);

  const exec = useCallback(
    (action: (typeof ACTIONS)[number]) => {
      if (action === 'replay') void replaySame();
      else changeMode();
    },
    [replaySame, changeMode],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => (s - 1 + ACTIONS.length) % ACTIONS.length);
      } else if (e.code === 'ArrowRight' || e.code === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => (s + 1) % ACTIONS.length);
      } else if (e.code === 'Enter') {
        e.preventDefault();
        exec(ACTIONS[selected]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, exec]);

  const activeGame = gameMode === 'timeline' ? game : oyGame;
  if (!activeGame) return null;

  const cleared = activeGame.phase === 'cleared';
  const entries = bestScores(provider.id, playlist.id, gameMode);

  const btnClass = (i: number, base: string) =>
    `${base} ${selected === i ? 'ring-2 ring-accent' : ''}`;

  return (
    <div className="flex h-full flex-col items-center gap-4 sm:gap-6 overflow-y-auto px-4 sm:px-6 py-4">
      <span className="text-4xl sm:text-5xl">{cleared ? '🏆' : '💥'}</span>
      <h1 className={`text-2xl sm:text-4xl font-extrabold ${cleared ? 'text-accent' : ''}`}>
        {cleared ? t('cleared') : t('gameOver')}
      </h1>
      <div>
        <p className="text-sm uppercase tracking-widest text-muted">{t('finalScore')}</p>
        <p className="text-5xl sm:text-6xl font-extrabold text-accent text-center">{activeGame.score}</p>
        <p className="mt-1 text-xs text-muted text-center">
          {gameMode === 'timeline' ? t('timelineMode') : t('olderYounger')}
        </p>
      </div>

      {/* Timeline review (timeline mode only) */}
      {endTimeline && <EndTimeline />}

      <div className="flex w-full flex-col items-center gap-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted">
          {t('leaderboard')}
        </h2>
        <Leaderboard entries={entries} />
      </div>
      <div className="flex gap-3 pb-4">
        <button
          onClick={() => exec('replay')}
          onMouseEnter={() => setSelected(0)}
          className={btnClass(
            0,
            'rounded-full bg-accent px-5 sm:px-6 py-2.5 sm:py-3 font-bold text-ground transition-transform hover:scale-105',
          )}
        >
          {t('playAgain')}
        </button>
        <button
          onClick={() => exec('changeMode')}
          onMouseEnter={() => setSelected(1)}
          className={btnClass(
            1,
            'rounded-full bg-surface px-5 sm:px-6 py-2.5 sm:py-3 font-bold transition-colors hover:bg-raised',
          )}
        >
          {t('changeMode')}
        </button>
      </div>
    </div>
  );
}
