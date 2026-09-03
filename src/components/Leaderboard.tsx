import type { ScoreEntry } from '../services/leaderboard';
import { useApp } from '../store';

export function Leaderboard({ entries }: { entries: ScoreEntry[] }) {
  const t = useApp((s) => s.t);
  const lang = useApp((s) => s.lang);
  if (entries.length === 0) {
    return <p className="text-sm text-muted">{t('noScores')}</p>;
  }
  return (
    <ol className="w-full max-w-sm space-y-2">
      {entries.map((e, i) => (
        <li
          key={`${e.date}-${i}`}
          className="flex items-center justify-between rounded-xl bg-raised px-4 py-2"
        >
          <span className="flex items-center gap-3">
            <span className={`w-5 text-right font-extrabold ${i === 0 ? 'text-accent' : 'text-muted'}`}>
              {i + 1}
            </span>
            <span className="text-sm text-muted">
              {new Date(e.date).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB')}
              {e.cleared && <span className="ml-2 text-accent">★</span>}
            </span>
          </span>
          <span className="text-lg font-extrabold">{e.score}</span>
        </li>
      ))}
    </ol>
  );
}
