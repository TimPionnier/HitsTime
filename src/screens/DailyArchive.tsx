import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { EPOCH, dateForDayIndex, dayIndexFor, localDateISO } from '../engine/daily';
import { allAttempts, formatMs, statsFrom } from '../services/dailyStore';

/**
 * Every challenge from day 1 to today.
 *
 * The calendar never generates a challenge — it reads stored attempts only.
 * Generating one per cell would mean a SHA-256 and a constrained draw for every
 * day ever, on every render; generation stays lazy and happens once, when a
 * date is actually opened.
 */
export function DailyArchive() {
  const startDaily = useApp((s) => s.startDaily);
  const t = useApp((s) => s.t);

  const attempts = useMemo(() => allAttempts(), []);
  const stats = useMemo(() => statsFrom(attempts), [attempts]);

  const today = localDateISO();
  const totalDays = Math.max(1, dayIndexFor(today));
  const PAGE = 70;
  const [shown, setShown] = useState(PAGE);

  // Newest first — the day a player is most likely to want is today's.
  const days = useMemo(() => {
    const out: number[] = [];
    for (let i = totalDays; i >= Math.max(1, totalDays - shown + 1); i--) out.push(i);
    return out;
  }, [totalDays, shown]);

  if (dayIndexFor(today) < 1) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-lg font-bold">{t('dailyNotYet')}</p>
        <p className="text-sm text-muted">{EPOCH}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 sm:px-6 py-4">
      <h2 className="text-center text-xl sm:text-2xl font-extrabold">{t('dailyArchive')}</h2>

      <div className="mx-auto mt-4 grid w-full max-w-md grid-cols-4 gap-2 text-center">
        <Stat label={t('dailyPlayed')} value={String(stats.played)} />
        <Stat label={t('dailyPerfectCount')} value={String(stats.perfect)} />
        <Stat label={t('dailyStreakLabel')} value={String(stats.currentStreak)} />
        <Stat
          label={t('dailyBest')}
          value={stats.bestAdjustedMs === null ? '—' : formatMs(stats.bestAdjustedMs)}
        />
      </div>

      <div className="mx-auto mt-6 grid w-full max-w-2xl grid-cols-5 gap-2 sm:grid-cols-7">
        {days.map((dayIndex) => {
          const date = dateForDayIndex(dayIndex);
          const attempt = attempts[date];
          const done = attempt?.status === 'finished';
          const perfect = done && attempt.errors === 0;
          return (
            <button
              key={date}
              onClick={() => void startDaily(date)}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-xl border px-1 py-2 text-center transition-colors ${
                perfect
                  ? 'border-accent bg-accent/15 text-accent'
                  : done
                    ? 'border-muted/40 bg-raised text-white'
                    : 'border-muted/20 text-muted hover:border-accent hover:text-accent'
              }`}
            >
              <span className="text-xs font-bold">#{dayIndex}</span>
              <span className="text-[9px] leading-tight opacity-70">{date.slice(5)}</span>
              {done && (
                <span className="text-[9px] font-bold">
                  {attempt.errors === 0 ? '★' : `${attempt.errors}✗`}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {shown < totalDays && (
        <button
          onClick={() => setShown((n) => n + PAGE)}
          className="mx-auto mt-6 rounded-full border border-muted/40 px-5 py-2 text-sm text-muted hover:border-accent hover:text-accent"
        >
          {t('loading')}
        </button>
      )}
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
