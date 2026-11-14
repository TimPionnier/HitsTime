import { useApp } from '../store';
import { Timeline } from '../components/Timeline';
import { PlaybackBar } from '../components/PlaybackBar';
import { MysteryCardFace } from '../components/TimelineCard';
import { YearInfoTooltip } from '../components/YearInfoTooltip';
import { GuessInputs } from '../components/GuessInputs';
import { BonusBadge } from '../components/BonusBadge';
import { GUESS_BONUS_POINTS, isFullGuess } from '../engine/guess';
import { cn } from '../lib/cn';

/** Score font size grows with streak: base 3rem, +0.25rem per streak level, capped at 6rem. */
function scoreFontSize(streak: number): string {
  const rem = Math.min(6, 3 + streak * 0.25);
  return `${rem}rem`;
}

export function GameScreen() {
  const game = useApp((s) => s.game);
  const playlist = useApp((s) => s.playlist);
  const confirm = useApp((s) => s.confirm);
  const withdraw = useApp((s) => s.withdraw);
  const t = useApp((s) => s.t);
  const error = useApp((s) => s.error);
  const loading = useApp((s) => s.loading);
  const prefetching = useApp((s) => s.prefetching);
  const guessResult = useApp((s) => s.guessResult);
  const guessBonusPoints = useApp((s) => s.guessBonusPoints);

  // Loading overlay (replay)
  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
        <div className="size-10 animate-spin rounded-full border-4 border-accent border-t-transparent" />
        <p className="text-lg font-bold">{t('loadingTracks')}</p>
        {playlist && <p className="text-sm text-muted">{playlist.name}</p>}
      </div>
    );
  }

  if (!game) return null;
  const { phase, score, streak, reveal } = game;
  const roundBonusPoints =
    phase === 'revealing' && guessResult && isFullGuess(guessResult) ? GUESS_BONUS_POINTS : 0;

  return (
    <div className="flex h-full flex-col">
      {/* Playlist title */}
      {playlist && (
        <div className="px-6 pt-1 text-center">
          <span className="text-sm text-muted">{playlist.name}</span>
        </div>
      )}

      {/* Score — centered, grows with streak */}
      <div className="flex flex-col items-center px-4 sm:px-6 pb-1 sm:pb-2">
        <div className="relative flex items-center gap-2">
          <div className="absolute inset-y-0 right-full mr-3 flex items-center">
            <BonusBadge label={roundBonusPoints > 0 ? `+${roundBonusPoints}` : null} />
          </div>
          <span
            className="font-extrabold text-accent transition-all duration-300"
            style={{ fontSize: scoreFontSize(streak) }}
          >
            {score + guessBonusPoints}
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

      {/* Center stage */}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 sm:gap-4 px-4 sm:px-6">
        {phase === 'listening' && (
          <>
            <MysteryCardFace />
            <PlaybackBar />
          </>
        )}
        {phase === 'pendingValidation' && (
          <div className="flex flex-col items-center gap-2 sm:gap-3">
            <button
              onClick={confirm}
              className="rounded-full bg-accent px-6 sm:px-8 py-2.5 sm:py-3 text-base sm:text-lg font-bold text-ground transition-transform hover:scale-105"
            >
              {t('validate')}
            </button>
            <p className="text-sm text-muted">{t('tapAgain')}</p>
            <button onClick={withdraw} className="text-xs text-muted underline hover:text-white">
              {"↩"}
            </button>
          </div>
        )}
        {phase === 'revealing' && reveal && (
          <p
            className={cn(
              'text-2xl sm:text-3xl font-extrabold',
              reveal.correct ? 'text-accent' : 'text-danger',
              reveal.correct && roundBonusPoints > 0 && 'text-gold',
            )}
          >
            {reveal.correct ? `${t('correct').replace('+1', `+${reveal.pointsAwarded}`)}` : t('wrong')}
          </p>
        )}
      </div>

      <div className="flex justify-center px-4 pb-2 sm:px-6 sm:pb-3">
        <GuessInputs />
      </div>

      {/* Timeline */}
      <div className="pb-2 sm:pb-6">
        <Timeline />
      </div>
    </div>
  );
}
