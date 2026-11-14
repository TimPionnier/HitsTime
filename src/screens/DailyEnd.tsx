import { useMemo, useRef, useState } from "react";
import { PerfectRunCelebration } from "../components/PerfectRunCelebration";
import { useApp } from "../store";
import { TimelineCard, type CardTone } from "../components/TimelineCard";
import {
  allAttempts,
  formatMs,
  perfectTrackIds,
  roundNumbersFor,
  roundOf,
  statsFrom,
} from "../services/dailyStore";
import { pointsBreakdown } from "../engine/points";
import { ROUNDS } from "../engine/daily";
import { isFullGuess } from "../engine/guess";
import { cn } from "../lib/cn";
import { usePlaylistUrl } from "../hooks/usePlaylistUrl";
import { ChevronDown, ListMusic, Star, Volume2, VolumeX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { GlobalStats } from "../components/GlobalStats";
import { DAILY_ANALYTICS_MODE, dailyScope } from "../services/analytics";
import { useSoundEnabled } from "../hooks/useSoundEnabled";
import { DailyInfoTooltip } from "../components/DailyInfoTooltip";

const DETAIL_ANIMATION_S = 0.2;

const detailVariants = {
  closed: { height: 0, opacity: 0, transition: { duration: DETAIL_ANIMATION_S } },
  open: { height: "auto", opacity: 1, transition: { duration: DETAIL_ANIMATION_S } },
};

export function DailyEnd() {
  const attempt = useApp((s) => s.dailyAttempt);
  const daily = useApp((s) => s.daily);
  const endTimeline = useApp((s) => s.endTimeline);
  const openArchive = useApp((s) => s.openArchive);
  const changeMode = useApp((s) => s.changeMode);
  const t = useApp((s) => s.t);

  const scroller = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLParagraphElement>(null);
  const [soundEnabled, toggleSound] = useSoundEnabled();
  const [copied, setCopied] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const stats = useMemo(() => statsFrom(allAttempts()), [attempt]);
  const playlistUrl = usePlaylistUrl(daily?.dayIndex ?? 0);

  if (!attempt || !daily) return null;

  const wrongIds = new Set(attempt.rounds.filter((r) => !r.correct).map((r) => r.trackId));
  const roundNumbers = roundNumbersFor(attempt.rounds);
  const toneOf = (trackId: string): CardTone => {
    if (wrongIds.has(trackId)) return "wrong";
    return perfectIds.has(trackId) ? "perfect" : "normal";
  };
  const perfectIds = perfectTrackIds(attempt.rounds);
  const perfects = perfectIds.size;
  const isGoldenRun = attempt.rounds.length > 0 && perfects === attempt.rounds.length;
  const perfectsLabel = t(perfects === 1 ? "perfectOne" : "perfectMany", { n: perfects });
  const points = pointsBreakdown(attempt.rounds);

  /**
   * Correct/incorrect per round and nothing else. A grid that encoded years, or
   * which slot each card went to, could be reassembled into the answer across a
   * handful of shares.
   */
  const share = [
    `HitsTime ${t("dailyPuzzle")} #${daily.dayIndex}`,
    attempt.rounds
      .map((r) => {
        if (!r.correct) return "🟥";
        return isFullGuess(r) ? "⭐" : "🟩";
      })
      .join(""),
    `${points.total} ${t("pointsUnit")} · ${ROUNDS - attempt.errors}/${ROUNDS} · ${perfectsLabel}`,
    // Resolved against the live document, NOT hardcoded: `base` is './', the
    // site lives under a repository subpath on GitHub Pages, and a pasted
    // origin would rot silently the day it moves. A share from a dev machine
    // therefore carries a localhost link, which only the developer ever sees.
    //
    // Relies on the document URL ending in '/': resolving './' against
    // '…/HitsTime' (no slash) would yield the domain root, since the client
    // cannot tell a directory from a file. Safe here because GitHub Pages
    // 301s '/HitsTime' to '/HitsTime/' before any script runs.
    new URL(import.meta.env.BASE_URL, window.location.href).href,
  ].join("\n");

  const copy = () => {
    navigator.clipboard?.writeText(share).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };

  const scrollBy = (dx: number) => scroller.current?.scrollBy({ left: dx, behavior: "smooth" });
  const arrowCls =
    "grid size-9 sm:size-11 shrink-0 place-items-center rounded-full bg-raised text-xl text-muted transition-colors hover:bg-accent hover:text-ground";

  return (
    <div
      className={cn(
        "relative flex h-full flex-col items-center gap-4 overflow-y-auto px-4 sm:px-6 py-4",
        isGoldenRun && "theme-gold",
      )}
    >
      {attempt.errors === 0 && attempt.rounds.length > 0 && (
        <PerfectRunCelebration
          originRef={scoreRef}
          golden={isGoldenRun}
          soundEnabled={soundEnabled}
        />
      )}
      {attempt.errors === 0 && attempt.rounds.length > 0 && (
        <button
          onClick={toggleSound}
          aria-label={t(soundEnabled ? "soundOff" : "soundOn")}
          aria-pressed={soundEnabled}
          className="absolute right-4 top-16 z-50 grid size-9 place-items-center rounded-full bg-raised text-muted transition-colors hover:text-accent"
        >
          {soundEnabled ? (
            <Volume2 size={18} strokeWidth={2} aria-hidden="true" />
          ) : (
            <VolumeX size={18} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      )}
      <div className="text-center">
        <p className="text-sm text-muted">
          {t("dailyPuzzle")} #{daily.dayIndex} · {attempt.date}
        </p>
        <div className="mt-1 flex flex-col items-center">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDetailOpen((open) => !open)}
              aria-expanded={detailOpen}
              aria-controls="points-detail"
              aria-label={t("pointsDetail")}
              className="group flex flex-col items-center"
            >
              <span
                ref={scoreRef}
                className="text-4xl sm:text-5xl font-extrabold tabular-nums text-accent"
              >
                {points.total} <span className="text-xl sm:text-2xl">{t("pointsUnit")}</span>
              </span>
              <ChevronDown
                size={20}
                strokeWidth={2.5}
                className={cn(
                  "text-muted transition-transform group-hover:text-accent",
                  detailOpen && "rotate-180",
                )}
                aria-hidden="true"
              />
            </button>
            <DailyInfoTooltip />
          </div>
        </div>
        <p className="mt-1 text-sm font-bold">
          {attempt.errors === 0 ? (
            <span className="text-accent">{t("dailyPerfect")}</span>
          ) : (
            <span className="text-danger">
              {attempt.errors} {t(attempt.errors === 1 ? "dailyErrorOne" : "dailyErrors")}
            </span>
          )}
          {perfects > 0 && (
            <span className="text-gold">
              {" \u00b7 "}
              {perfectsLabel}
            </span>
          )}
        </p>
        <AnimatePresence initial={false}>
          {detailOpen && (
            <motion.div
              id="points-detail"
              variants={detailVariants}
              initial="closed"
              animate="open"
              exit="closed"
              className="overflow-hidden"
            >
              <dl className="mx-auto mt-2 grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 text-left text-xs text-muted">
                <PointsLine label={t("pointsPlacement")} value={points.placement} />
                <PointsLine label={t("pointsSpeed")} value={points.speed} />
                <PointsLine label={t("pointsGuesses")} value={points.guesses} />
                <PointsLine label={t("pointsPerfects")} value={points.perfect} />
              </dl>
              <p className="mt-2 text-xs text-muted">
                {formatMs(attempt.rawActiveMs)} {t("dailyTime")}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Round by round — the share grid, unobfuscated for the player's own eyes. */}
      <div className="flex flex-wrap justify-center gap-1">
        {attempt.rounds.map((r, i) => {
          if (r.correct && isFullGuess(r)) {
            return (
              <span
                key={i}
                className="relative grid size-6 sm:size-7 place-items-center text-[11px] sm:text-xs font-bold text-ground"
              >
                <Star
                  size={28}
                  strokeWidth={1.5}
                  className="absolute inset-0 size-full fill-gold text-gold"
                  aria-hidden="true"
                />
                <span className="relative">{i + 1}</span>
              </span>
            );
          }
          return (
            <span
              key={i}
              className={cn(
                "grid size-6 sm:size-7 place-items-center rounded text-[11px] sm:text-xs font-bold",
                r.correct ? "bg-accent/20 text-accent" : "bg-danger/20 text-danger",
              )}
            >
              {i + 1}
            </span>
          );
        })}
      </div>

      {endTimeline && endTimeline.tracks.length > 0 && (
        <div className="w-full">
          <h2 className="mb-2 text-center text-sm font-bold uppercase tracking-widest text-muted">
            {t("yourTimeline")}
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
                    tone={toneOf(track.id)}
                    small
                    round={roundOf(roundNumbers, track.id)}
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
        <Stat label={t("dailyPlayed")} value={String(stats.played)} />
        <Stat label={t("dailyPerfectCount")} value={String(stats.perfect)} />
        <Stat label={t("dailyStreakLabel")} value={String(stats.currentStreak)} />
        <Stat
          label={t("dailyBest")}
          value={stats.bestPoints === null ? "—" : String(stats.bestPoints)}
        />
      </div>

      {/* Everyone who played THIS puzzle, scoped to the date: the only
          comparison in the game that is actually like-for-like. */}
      <GlobalStats
        mode={DAILY_ANALYTICS_MODE}
        scope={dailyScope(attempt.date)}
        score={points.total}
      />

      <div className="flex flex-wrap items-center justify-center gap-2 pb-4">
        <button
          onClick={copy}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-ground transition-transform hover:scale-105"
        >
          {copied ? t("dailyCopied") : t("dailyShare")}
        </button>
        {playlistUrl && (
          <a
            href={playlistUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-muted/40 px-5 py-2.5 text-sm text-muted hover:border-accent hover:text-accent"
          >
            <ListMusic size={16} strokeWidth={2} className="shrink-0" aria-hidden="true" />
            {t("dailyPlaylist")}
          </a>
        )}
        <button
          onClick={openArchive}
          className="rounded-full border border-muted/40 px-5 py-2.5 text-sm text-muted hover:border-accent hover:text-accent"
        >
          {t("dailyArchive")}
        </button>
        <button
          onClick={changeMode}
          className="rounded-full border border-muted/40 px-5 py-2.5 text-sm text-muted hover:border-accent hover:text-accent"
        >
          {t("changeMode")}
        </button>
      </div>
    </div>
  );
}

function PointsLine({ label, value }: { label: string; value: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="text-right font-bold tabular-nums text-white">
        {value > 0 ? "+" : ""}
        {value}
      </dd>
    </>
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
