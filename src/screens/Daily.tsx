import { useEffect, useState } from "react";
import { useApp } from "../store";
import { Timeline } from "../components/Timeline";
import { PlaybackBar } from "../components/PlaybackBar";
import { MysteryCardFace } from "../components/TimelineCard";
import { DailyInfoTooltip } from "../components/DailyInfoTooltip";
import { perfectTrackIds, pointsOf } from "../services/dailyStore";
import { roundPoints } from "../engine/points";
import { GuessInputs } from "../components/GuessInputs";
import { BonusBadge } from "../components/BonusBadge";
import { useTweenedNumber } from "../hooks/useTweenedNumber";
import { cn } from "../lib/cn";
import { ROUNDS } from "../engine/daily";

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

  const rounds = dailyAttempt?.rounds ?? [];
  const perfects = perfectTrackIds(rounds).size;
  const shownPoints = Math.round(useTweenedNumber(pointsOf({ rounds })));

  if (loading || !game || !daily) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
        <div className="size-10 animate-spin rounded-full border-4 border-accent border-t-transparent" />
        <p className="text-lg font-bold">{t("loadingTracks")}</p>
      </div>
    );
  }

  const { reveal } = game;
  const round = game.timeline.length - 1 + (phase === "revealing" ? 0 : 1);
  const lastRound = phase === "revealing" ? rounds.at(-1) : undefined;
  const roundDelta = lastRound ? roundPoints(lastRound).total : 0;
  const isPerfectRound = lastRound ? roundPoints(lastRound).perfect > 0 : false;
  const badgeTone = isPerfectRound ? "gold" : roundDelta > 0 ? "accent" : "danger";

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-4 sm:px-6 pt-1 text-sm">
        <button onClick={openArchive} className="text-muted underline hover:text-white">
          {t("dailyPuzzle")} #{daily.dayIndex}
        </button>
        <span className="text-muted">
          {Math.min(round, ROUNDS)}/{ROUNDS}
        </span>
      </div>

      {/* Running points total; the last round's gain shows beside it at the reveal. */}
      <div className="flex flex-col items-center px-4 sm:px-6 pb-1 sm:pb-2">
        <div className="relative flex items-center gap-2">
          <div className="absolute inset-y-0 right-full mr-3 flex items-center">
            <BonusBadge
              label={lastRound ? `${roundDelta > 0 ? "+" : ""}${roundDelta}` : null}
              tone={badgeTone}
            />
          </div>
          <span
            className={cn(
              "text-5xl short:text-4xl tiny:text-3xl font-extrabold tabular-nums text-accent transition-all duration-300",
              isPerfectRound && "scale-110 text-gold",
              flash && "scale-110 text-danger",
            )}
          >
            {shownPoints}
          </span>
          <DailyInfoTooltip />
        </div>
        <span className="text-xs font-bold text-muted">
          {errors > 0 ? (
            <span className="text-danger">
              {errors} {t(errors === 1 ? "dailyErrorOne" : "dailyErrors")}
            </span>
          ) : (
            t("dailyPerfect")
          )}
          {perfects > 0 && (
            <span className="text-gold">
              {" \u00b7 "}
              {t(perfects === 1 ? "perfectOne" : "perfectMany", { n: perfects })}
            </span>
          )}
        </span>
      </div>

      {error && <p className="px-6 text-center text-sm font-semibold text-danger">{error}</p>}

      <div className="flex min-h-24 tiny:min-h-12 flex-1 flex-col items-center justify-center gap-3 sm:gap-4 px-4 sm:px-6">
        {phase === "listening" && (
          <>
            <MysteryCardFace />
            <PlaybackBar />
          </>
        )}
        {phase === "pendingValidation" && (
          <div className="flex flex-col items-center gap-2 sm:gap-3">
            <button
              onClick={confirm}
              className="rounded-full bg-accent px-6 sm:px-8 py-2.5 sm:py-3 text-base sm:text-lg font-bold text-ground transition-transform hover:scale-105"
            >
              {t("validate")}
            </button>
            <p className="text-sm text-muted">{t("tapAgain")}</p>
            <button onClick={withdraw} className="text-xs text-muted underline hover:text-white">
              {"↩"}
            </button>
          </div>
        )}
        {phase === "revealing" && reveal && (
          <p
            className={cn(
              "text-2xl sm:text-3xl font-extrabold",
              reveal.correct ? "text-accent" : "text-danger",
              isPerfectRound && "text-gold",
            )}
          >
            {reveal.correct ? t("correct").replace("+1", "") : t("wrong")}
          </p>
        )}
      </div>

      <div className="flex justify-center px-4 pb-2 sm:px-6 sm:pb-3">
        <GuessInputs />
      </div>

      <div className="pb-2 sm:pb-6 tiny:pb-1">
        <Timeline />
      </div>
    </div>
  );
}
