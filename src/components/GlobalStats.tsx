/**
 * The "everyone else" numbers.
 *
 * Renders nothing — not a spinner, not a placeholder — until real data is in
 * hand, and nothing at all if the endpoint is unset or unreachable. A loading
 * state on an end screen reads as broken; absence reads as "this feature isn't
 * here", which is what it is when nobody deployed the Worker.
 *
 * There is deliberately no best score and no leaderboard here. Nothing
 * verifies a submitted score, so a single number owned by one player would be
 * owned by whoever forged it, permanently. A percentile off the histogram is
 * the same motivation with none of that: one faked entry moves it by one player
 * out of hundreds. See docs/analytics-architecture.md §1.3 and the commitment
 * in docs/anti-cheat-architecture.md §3.
 */
import { useEffect, useState } from 'react';

import { useApp } from '../store';
import { formatMs } from '../services/dailyStore';
import { beatShare, fetchStats, type GlobalStats as Stats } from '../services/stats';

interface Props {
  mode: string;
  scope?: string | null;
  /** The player's own score, when there is one to compare. */
  score?: number;
  /**
   * Suppress the comparison.
   *
   * Set when the run carries a peek penalty: the player's score includes five
   * minutes that the distribution excludes, so a percentile would be arithmetic
   * against a different population. The average still shows — it just isn't
   * theirs to be ranked in.
   */
  comparable?: boolean;
}

/** Shared loader for both layouts below. */
function useStats(mode: string, scope?: string | null): Stats | null {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let live = true;
    void fetchStats(mode, scope).then((s) => {
      if (live) setStats(s);
    });
    return () => {
      live = false;
    };
  }, [mode, scope]);

  return stats;
}

/**
 * One quiet line for the mode-select cards: is anyone here?
 *
 * Counts only, so it needs no sample floor — "3 played today" is honest at
 * three, where an average of three runs is not.
 */
export function ModePlayCount({ mode }: { mode: string }) {
  const t = useApp((s) => s.t);
  const stats = useStats(mode);

  if (!stats || stats.plays <= 0) return null;

  return (
    <span className="text-[10px] leading-tight text-muted/70">
      {t('statsPlayedToday', { n: stats.plays })}
    </span>
  );
}

export function GlobalStats({ mode, scope, score, comparable = true }: Props) {
  const t = useApp((s) => s.t);
  const stats = useStats(mode, scope);

  if (!stats) return null;

  const isTime = stats.direction === 'min';
  // `avg` and `buckets` arrive null until the server's sample floor is met, so
  // this branch is the small-sample case: a percentile out of six players is
  // noise wearing a percent sign.
  const enough = stats.avg !== null && stats.buckets !== null && stats.n >= stats.min_sample;

  const share =
    enough && comparable && typeof score === 'number' && stats.buckets
      ? beatShare(stats.buckets, score, stats.direction)
      : null;

  const lines: string[] = [];
  if (share !== null) {
    lines.push(
      t(isTime ? 'statsFasterThan' : 'statsBetterThan', { p: Math.round(share * 100) }),
    );
  }
  if (enough && stats.avg !== null) {
    lines.push(
      isTime
        ? t('statsAvgTime', { v: formatMs(stats.avg) })
        : t('statsAvgPoints', { v: stats.avg }),
    );
  }
  if (lines.length === 0) {
    // Nothing comparable yet — say how busy it is and stop there.
    if (stats.finishes <= 0) return null;
    lines.push(t('statsPlayedPuzzle', { n: stats.finishes }));
  }

  return (
    <div className="w-full max-w-md text-center">
      <div className="mb-1 flex items-center gap-2">
        <span className="h-px flex-1 bg-muted/20" />
        {/* Labelled, because the grid directly above these numbers is the
            player's OWN history and the two are easy to confuse. */}
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted/70">
          {t('everyone')}
        </span>
        <span className="h-px flex-1 bg-muted/20" />
      </div>
      <p className="text-xs text-muted">{lines.join(' · ')}</p>
      <p className="mt-0.5 text-[10px] text-muted/60">{t('statsPrivacy')}</p>
    </div>
  );
}
