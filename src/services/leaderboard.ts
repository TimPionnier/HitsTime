export interface ScoreEntry {
  providerId: string;
  playlistId: string;
  playlistName: string;
  gameMode?: string; // 'timeline' | 'olderYounger'
  score: number;
  cleared: boolean;
  date: string; // ISO
}

const KEY = 'hitstime.leaderboard.v1';
const MAX_ENTRIES = 200;

function readAll(): ScoreEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScoreEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: ScoreEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // storage unavailable (private mode…) — scores just aren't persisted
  }
}

export function addScore(entry: ScoreEntry): void {
  writeAll([entry, ...readAll()]);
}

/** Best scores for one playlist and mode, highest first then most recent. */
export function bestScores(
  providerId: string,
  playlistId: string,
  gameMode?: string,
  limit = 5,
): ScoreEntry[] {
  return readAll()
    .filter(
      (e) =>
        e.providerId === providerId &&
        e.playlistId === playlistId &&
        (gameMode ? (e.gameMode ?? 'timeline') === gameMode : true),
    )
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .slice(0, limit);
}
