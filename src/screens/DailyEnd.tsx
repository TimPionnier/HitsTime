import { useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { TimelineCard } from '../components/TimelineCard';
import {
  ERROR_PENALTY_MS,
  PEEK_PENALTY_MS,
  allAttempts,
  formatMs,
  statsFrom,
} from '../services/dailyStore';
import { ROUNDS } from '../engine/daily';
import { GlobalStats } from '../components/GlobalStats';
import { dailyScope } from '../services/analytics';

export function DailyEnd() {
  const attempt = useApp((s) => s.dailyAttempt);
  const daily = useApp((s) => s.daily);
  const endTimeline = useApp((s) => s.endTimeline);
  const openArchive = useApp((s) => s.openArchive);
  const startDaily = useApp((s) => s.startDaily);
  const changeMode = useApp((s) => s.changeMode);
  const t = useApp((s) => s.t);

  const scroller = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const stats = useMemo(() => statsFrom(allAttempts()), [attempt]);

  if (!attempt || !daily) return null;

  const wrongIds = new Set(attempt.rounds.filter((r) => !r.correct).map((r) => r.trackId));
  const peeks = attempt.peeks ?? 0;

  /**
   * Correct/incorrect per round and nothing else. A grid that encoded years, or
   * which slot each card went to, could be reassembled into the answer across a
   * handful of shares.
   */
  const share = [
    `HitsTime ${t('dailyPuzzle')} #${daily.dayIndex}`,
    attempt.rounds.map((r) => (r.correct ? '🟩' : '🟥')).join(''),
    `${ROUNDS - attempt.errors}/${ROUNDS} · ${formatMs(attempt.adjustedMs)}`,
  ].join('\n');

  const copy = () => {
    navigator.clipboard?.writeText(share).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };

  const scrollBy = (dx: number) => scroller.current?.scrollBy({ left: dx, behavior: 'smooth' });
  const arrowCls =
    'grid size-9 sm:size-11 shrink-0 place-items-center rounded-full bg-raised text-xl text-muted transition-colors hover:bg-accent hover:text-ground';

  return (
    <div className="flex h-full flex-col items-center gap-4 overflow-y-auto px-4 sm:px-6 py-4">
      <div className="text-center">
        <p className="text-sm text-muted">
          {t('dailyPuzzle')} #{daily.dayIndex} · {attempt.date}
        </p>
        <p className="mt-1 text-4xl sm:text-5xl font-extrabold tabular-nums text-accent">
          {formatMs(attempt.adjustedMs)}
        </p>
        <p className="mt-1 text-sm font-bold">
          {attempt.errors === 0 && peeks === 0 ? (
            <span className="text-accent">{t('dailyPerfect')}</span>
          ) : (
            <span className="text-danger">
              {attempt.errors > 0 && (
                <>
                  {attempt.errors} {t('dailyErrors')} · +
                  {formatMs(attempt.errors * ERROR_PENALTY_MS)} {t('dailyPenalty')}
                </>
              )}
              {attempt.errors > 0 && peeks > 0 && ' · '}
              {peeks > 0 && (
                <>
                  {t('dailyPeek')} · +{formatMs(peeks * PEEK_PENALTY_MS)}
                </>
              )}
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-muted">
          {formatMs(attempt.rawActiveMs)} {t('dailyTime')}
        </p>
      </div>

      {/* Round by round — the share grid, unobfuscated for the player's own eyes. */}
      <div className="flex flex-wrap justify-center gap-1">
        {attempt.rounds.map((r, i) => (
          <span
            key={i}
            className={`grid size-7 place-items-center rounded text-xs font-bold ${
              r.correct ? 'bg-accent/20 text-accent' : 'bg-danger/20 text-danger'
            }`}
          >
            {i + 1}
          </span>
        ))}
      </div>

      {endTimeline && endTimeline.tracks.length > 0 && (
        <div className="w-full">
          <h2 className="mb-2 text-center text-sm font-bold uppercase tracking-widest text-muted">
            {t('yourTimeline')}
          </h2>
          <div className="flex items-center gap-1 sm:gap-2">
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
                    tone={wrongIds.has(track.id) ? 'wrong' : 'normal'}
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
      )}

      <div className="grid w-full max-w-md grid-cols-4 gap-2 text-center">
        <Stat label={t('dailyPlayed')} value={String(stats.played)} />
        <Stat label={t('dailyPerfectCount')} value={String(stats.perfect)} />
        <Stat label={t('dailyStreakLabel')} value={String(stats.currentStreak)} />
        <Stat
          label={t('dailyBest')}
          value={stats.bestAdjustedMs === null ? '—' : formatMs(stats.bestAdjustedMs)}
        />
      </div>

      {/* Everyone who played THIS puzzle — scoped to the date, which is the
          only comparison in the game that is actually like-for-like. A peeked
          run is not ranked: its score carries five minutes the distribution
          excludes. */}
      <GlobalStats
        mode="daily"
        scope={dailyScope(attempt.date)}
        score={attempt.adjustedMs}
        comparable={peeks === 0}
      />

      <div className="flex flex-wrap items-center justify-center gap-2 pb-4">
        <button
          onClick={copy}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-ground transition-transform hover:scale-105"
        >
          {copied ? t('dailyCopied') : t('dailyShare')}
        </button>
        <button
          onClick={openArchive}
          className="rounded-full border border-muted/40 px-5 py-2.5 text-sm text-muted hover:border-accent hover:text-accent"
        >
          {t('dailyArchive')}
        </button>
        <button
          onClick={() => void startDaily()}
          className="rounded-full border border-muted/40 px-5 py-2.5 text-sm text-muted hover:border-accent hover:text-accent"
        >
          {t('dailyBackToday')}
        </button>
        <button
          onClick={changeMode}
          className="rounded-full border border-muted/40 px-5 py-2.5 text-sm text-muted hover:border-accent hover:text-accent"
        >
          {t('changeMode')}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-raised px-2 py-2">
      <div className="text-lg font-extrabold text-accent">{value}</div>
      <div className="text-[10px] leading-tight text-muted">{label}</div>
    </div>
  );
}
