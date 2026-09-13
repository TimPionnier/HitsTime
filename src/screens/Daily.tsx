import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Timeline } from '../components/Timeline';
import { PlaybackBar } from '../components/PlaybackBar';
import { MysteryCardFace } from '../components/TimelineCard';
import { YearInfoTooltip } from '../components/YearInfoTooltip';
import { ERROR_PENALTY_MS, PEEK_PENALTY_MS, formatMs } from '../services/dailyStore';
import { ROUNDS } from '../engine/daily';

/**
 * The live clock.
 *
 * Ticks at 100ms for two reasons: it reads smoothly, and DailyTimer discards
 * gaps over 2s, so polling it often is what keeps a present player's time
 * accruing.
 */
function useLiveElapsed(active: boolean): number {
  const dailyElapsedMs = useApp((s) => s.dailyElapsedMs);
  const [ms, setMs] = useState(0);

  useEffect(() => {
    setMs(dailyElapsedMs());
    if (!active) return;
    const id = window.setInterval(() => setMs(dailyElapsedMs()), 100);
    return () => window.clearInterval(id);
  }, [active, dailyElapsedMs]);

  return ms;
}

export function DailyScreen() {
  const game = useApp((s) => s.game);
  const daily = useApp((s) => s.daily);
  const dailyAttempt = useApp((s) => s.dailyAttempt);
  const confirm = useApp((s) => s.confirm);
  const withdraw = useApp((s) => s.withdraw);
  const openArchive = useApp((s) => s.openArchive);
  const t = useApp((s) => s.t);
  const error = useApp((s) => s.error);
  const loading = useApp((s) => s.loading);

  const phase = game?.phase;
  const raw = useLiveElapsed(phase === 'listening' || phase === 'pendingValidation');

  // Flash the penalty as it lands, so the cost of a mistake is visible at the
  // moment it happens rather than as an end-screen surprise.
  const [flash, setFlash] = useState(false);
  const errors = game?.errors ?? 0;
  useEffect(() => {
    if (errors === 0) return;
    setFlash(true);
    const id = window.setTimeout(() => setFlash(false), 900);
    return () => window.clearTimeout(id);
  }, [errors]);

  if (loading || !game || !daily) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
        <div className="size-10 animate-spin rounded-full border-4 border-accent border-t-transparent" />
        <p className="text-lg font-bold">{t('loadingTracks')}</p>
      </div>
    );
  }

  const { reveal } = game;
  const round = game.timeline.length - 1 + (phase === 'revealing' ? 0 : 1);
  const peeks = daily ? (dailyAttempt?.peeks ?? 0) : 0;
  const adjusted = raw + errors * ERROR_PENALTY_MS + peeks * PEEK_PENALTY_MS;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 sm:px-6 pt-1 text-sm">
        <button onClick={openArchive} className="text-muted underline hover:text-white">
          {t('dailyPuzzle')} #{daily.dayIndex}
        </button>
        <span className="text-muted">
          {Math.min(round, ROUNDS)}/{ROUNDS}
        </span>
      </div>

      {/* Clock — the score, penalties included. */}
      <div className="flex flex-col items-center px-4 sm:px-6 pb-1 sm:pb-2">
        <div className="flex items-center gap-2">
          <span
            className={`font-extrabold tabular-nums transition-all duration-300 ${
              flash ? 'scale-110 text-danger' : 'text-accent'
            }`}
            style={{ fontSize: '3rem' }}
          >
            {formatMs(adjusted)}
          </span>
          <YearInfoTooltip />
        </div>
        <span className="text-xs font-bold text-muted">
          {errors > 0 || peeks > 0 ? (
            <span className="text-danger">
              {errors > 0 && (
                <>
                  {errors} {t('dailyErrors')} · +{formatMs(errors * ERROR_PENALTY_MS)}{' '}
                  {t('dailyPenalty')}
                </>
              )}
              {errors > 0 && peeks > 0 && ' · '}
              {peeks > 0 && (
                <>
                  {t('dailyPeek')} · +{formatMs(peeks * PEEK_PENALTY_MS)}
                </>
              )}
            </span>
          ) : (
            t('dailyPerfect')
          )}
        </span>
      </div>

      {error && <p className="px-6 text-center text-sm font-semibold text-danger">{error}</p>}

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
              {'↩'}
            </button>
          </div>
        )}
        {phase === 'revealing' && reveal && (
          <p
            className={`text-2xl sm:text-3xl font-extrabold ${
              reveal.correct ? 'text-accent' : 'text-danger'
            }`}
          >
            {reveal.correct ? t('correct').replace('+1', '') : `${t('wrong')} +30s`}
          </p>
        )}
      </div>

      <div className="pb-2 sm:pb-6">
        <Timeline />
      </div>
    </div>
  );
}
