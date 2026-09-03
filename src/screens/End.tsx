import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../store';
import { bestScores } from '../services/leaderboard';
import { Leaderboard } from '../components/Leaderboard';

const ACTIONS = ['replay', 'changeMode'] as const;

export function EndScreen() {
  const game = useApp((s) => s.game);
  const oyGame = useApp((s) => s.oyGame);
  const gameMode = useApp((s) => s.gameMode);
  const playlist = useApp((s) => s.playlist);
  const provider = useApp((s) => s.provider);
  const replaySame = useApp((s) => s.replaySame);
  const changeMode = useApp((s) => s.changeMode);
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
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <span className="text-5xl">{cleared ? '🏆' : '💥'}</span>
      <h1 className={`text-4xl font-extrabold ${cleared ? 'text-accent' : ''}`}>
        {cleared ? t('cleared') : t('gameOver')}
      </h1>
      <div>
        <p className="text-sm uppercase tracking-widest text-muted">{t('finalScore')}</p>
        <p className="text-6xl font-extrabold text-accent">{activeGame.score}</p>
        <p className="mt-1 text-xs text-muted">
          {gameMode === 'timeline' ? t('timelineMode') : t('olderYounger')}
        </p>
      </div>
      <div className="flex w-full flex-col items-center gap-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted">
          {t('leaderboard')}
        </h2>
        <Leaderboard entries={entries} />
      </div>
      <div className="flex gap-3">
        <button
          onClick={() => exec('replay')}
          onMouseEnter={() => setSelected(0)}
          className={btnClass(
            0,
            'rounded-full bg-accent px-6 py-3 font-bold text-ground transition-transform hover:scale-105',
          )}
        >
          {t('playAgain')}
        </button>
        <button
          onClick={() => exec('changeMode')}
          onMouseEnter={() => setSelected(1)}
          className={btnClass(
            1,
            'rounded-full bg-surface px-6 py-3 font-bold transition-colors hover:bg-raised',
          )}
        >
          {t('changeMode')}
        </button>
      </div>
    </div>
  );
}
