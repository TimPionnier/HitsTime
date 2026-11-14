import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import {
  ARTIST_POINTS,
  PERFECT_POINTS,
  PLACEMENT_POINTS,
  SPEED_BONUS_MAX,
  SPEED_FULL_MS,
  SPEED_ZERO_MS,
  TITLE_POINTS,
  WRONG_PLACEMENT_PENALTY,
} from "../engine/points";

const MS_PER_SECOND = 1000;

/** ⓘ — explains how the daily points are counted and where the years come from. */
export function DailyInfoTooltip() {
  const t = useApp((s) => s.t);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  // A tap outside closes it: touch screens have no hover to leave.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  // Built from the scoring constants so the explanation cannot drift from the rules.
  // Title and artist are worth the same today; the text speaks of one figure.
  const guessPoints = Math.min(TITLE_POINTS, ARTIST_POINTS);
  return (
    <span ref={root} className="relative inline-flex">
      <button
        aria-label={t("scoreInfoShort")}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="grid size-5 place-items-center rounded-full border border-muted/60 text-xs text-muted transition-colors hover:border-white hover:text-white"
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className="fixed inset-x-4 top-24 z-50 max-h-[70vh] overflow-y-auto rounded-xl bg-raised p-3 text-left text-xs font-normal normal-nums leading-relaxed text-white shadow-xl shadow-black/50 sm:absolute sm:inset-x-auto sm:left-1/2 sm:top-7 sm:w-80 sm:-translate-x-1/2"
        >
          <span className="mb-1 block font-bold">{t("scoreInfoShort")}</span>
          {t("scoreInfo", {
            placement: PLACEMENT_POINTS,
            speed: SPEED_BONUS_MAX,
            fast: SPEED_FULL_MS / MS_PER_SECOND,
            slow: SPEED_ZERO_MS / MS_PER_SECOND,
            wrong: -WRONG_PLACEMENT_PENALTY,
            guess: guessPoints,
            perfect: PERFECT_POINTS,
          })}
          <span className="mb-1 mt-3 block font-bold">{t("yearInfoShort")}</span>
          {t("yearInfo")}
        </span>
      )}
    </span>
  );
}
