import { useEffect } from 'react';
import { useApp } from '../store';
import { PlaybackBar } from '../components/PlaybackBar';
import { TimelineCard } from '../components/TimelineCard';
import { YearInfoTooltip } from '../components/YearInfoTooltip';

/** Score font size grows with streak: base 3rem, +0.25rem per streak level, capped at 6rem. */
function scoreFontSize(streak: number): string {
  const rem = Math.min(6, 3 + streak * 0.25);
  return `${rem}rem`;
}

export function OlderYoungerGame() {
  const oyGame = useApp((s) => s.oyGame);
  const playlist = useApp((s) => s.playlist);
  const guessOY = useApp((s) => s.guessOlderYounger);
  const t = useApp((s) => s.t);
  const error = useApp((s) => s.error);
  const loading = useApp((s) => s.loading);
  const prefetching = useApp((s) => s.prefetching);
  const clip = useApp((s) => s.clip);

  const phase = oyGame?.phase;
  const canGuess =
    (phase === 'listening' || phase === 'pendingGuess') &&
    (clip.status === 'playing' || clip.status === 'done');

  // Arrow keys: Left/Up = older, Right/Down = younger
  // Must be before any early returns to respect hook rules
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!canGuess) return;
      if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
        e.preventDefault();
        guessOY('older');
      } else if (e.code === 'ArrowRight' || e.code === 'ArrowDown') {
        e.preventDefault();
        guessOY('younger');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canGuess, guessOY]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
        <div className="size-10 animate-spin rounded-full border-4 border-accent border-t-transparent" />
        <p className="text-lg font-bold">{t('loadingTracks')}</p>
        {playlist && <p className="text-sm text-muted">{playlist.name}</p>}
      </div>
    );
  }

  if (!oyGame) return null;
  const { reference, score, streak, reveal } = oyGame;

  // During reveal, show the mystery track's info on the card instead of reference
  const displayTrack = phase === 'revealing' && reveal ? reveal.track : reference;
  const cardTone = phase === 'revealing' && reveal
    ? (reveal.correct ? 'correct' : 'wrong')
    : 'normal';

  return (
    <div className="flex h-full flex-col">
      {/* Playlist title */}
      {playlist && (
        <div className="px-6 pt-1 text-center">
          <span className="text-sm text-muted">{playlist.name}</span>
        </div>
      )}

      {/* Score */}
      <div className="flex flex-col items-center px-6 pb-2">
        <div className="flex items-center gap-2">
          <span
            className="font-extrabold text-accent transition-all duration-300"
            style={{ fontSize: scoreFontSize(streak) }}
          >
            {score}
          </span>
          <YearInfoTooltip />
        </div>
        {streak > 1 && (
          <span className="text-xs font-bold text-muted">
            {t('streak')} {streak}
          </span>
        )}
      </div>

      {error && (
        <p className="px-6 text-center text-sm font-semibold text-danger">{error}</p>
      )}

      {prefetching && phase === 'listening' && (
        <p className="px-6 text-center text-xs text-muted">{t('loadingMore')}</p>
      )}

      {/* Main area — single large card */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <TimelineCard track={displayTrack} tone={cardTone} large />

        {/* Playback bar */}
        {(phase === 'listening' || phase === 'pendingGuess') && <PlaybackBar />}

        {/* Guess buttons */}
        {canGuess && (
          <div className="flex gap-4">
            <button
              onClick={() => guessOY('older')}
              className="rounded-full bg-surface px-8 py-3 text-lg font-bold transition-all hover:scale-105 hover:bg-raised"
            >
              {"⬆ "}{t('older')}
            </button>
            <button
              onClick={() => guessOY('younger')}
              className="rounded-full bg-surface px-8 py-3 text-lg font-bold transition-all hover:scale-105 hover:bg-raised"
            >
              {"⬇ "}{t('younger')}
            </button>
          </div>
        )}

        {/* Reveal result */}
        {phase === 'revealing' && reveal && (
          <p
            className={`text-3xl font-extrabold ${reveal.correct ? 'text-accent' : 'text-danger'}`}
          >
            {reveal.correct
              ? `${t('correct').replace('+1', `+${reveal.pointsAwarded}`)}`
              : t('wrongOY')}
          </p>
        )}
      </div>
    </div>
  );
}
