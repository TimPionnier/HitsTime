import { Check, X } from "lucide-react";
import { useApp } from "../../store";
import { cn } from "../../lib/cn";
import { isFullGuess, type TrackGuess } from "../../engine/guess";
import type { TKey } from "../../services/i18n";

const FIELDS: { field: keyof TrackGuess; label: TKey }[] = [
  { field: "title", label: "guessTitle" },
  { field: "artist", label: "guessArtist" },
];

/** Hard mode: title and artist fields while the round is open, then their verdict. */
export function GuessInputs() {
  const hard = useApp((s) => (s.gameMode === "daily" ? s.dailyAttempt?.hard === true : s.hardMode));
  const phase = useApp((s) => s.game?.phase);
  const revealedTrack = useApp((s) => s.game?.reveal?.track);
  const guess = useApp((s) => s.guess);
  const guessResult = useApp((s) => s.guessResult);
  const setGuess = useApp((s) => s.setGuess);
  const t = useApp((s) => s.t);

  if (!hard) return null;

  if (phase === "revealing" && guessResult && revealedTrack) {
    const full = isFullGuess(guessResult);
    const rows = [
      { field: "title", found: guessResult.titleFound, answer: revealedTrack.title },
      { field: "artist", found: guessResult.artistFound, answer: revealedTrack.artist },
    ];
    return (
      <ul className="flex w-full max-w-md flex-col gap-1">
        {rows.map((row) => (
          <li
            key={row.field}
            className={cn(
              "flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-bold",
              "bg-raised text-white",
              !row.found && "bg-danger/15 text-danger",
              full && "bg-gold/15 text-gold",
            )}
          >
            {row.found ? (
              <Check size={16} strokeWidth={3} className="shrink-0" aria-hidden="true" />
            ) : (
              <X size={16} strokeWidth={3} className="shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate">{row.answer}</span>
          </li>
        ))}
      </ul>
    );
  }

  if (phase !== "listening" && phase !== "pendingValidation") return null;

  return (
    <div className="grid w-full max-w-md grid-cols-2 gap-2">
      {FIELDS.map(({ field, label }) => (
        <input
          key={field}
          type="text"
          value={guess[field]}
          onChange={(e) => setGuess(field, e.target.value)}
          onKeyDown={(e) => {
            // Hands the keyboard back to the timeline shortcuts (arrows, Enter).
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder={t(label)}
          aria-label={t(label)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          className="w-full min-w-0 rounded-xl bg-raised px-3 py-2 text-sm font-semibold text-white outline-none ring-1 ring-muted/30 placeholder:font-normal placeholder:text-muted focus:ring-2 focus:ring-accent"
        />
      ))}
    </div>
  );
}
