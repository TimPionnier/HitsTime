import type { GameTrack } from '../engine/types';
import { ANCHOR_ROUND } from '../services/dailyStore';

/** `perfect`: well placed with title and artist both found. */
export type CardTone = 'normal' | 'correct' | 'wrong' | 'perfect';

const toneRing: Record<CardTone, string> = {
  normal: '',
  correct: 'ring-2 ring-accent shadow-lg shadow-accent/20',
  wrong: '',
  perfect: '',
};

const toneText: Record<CardTone, string> = {
  normal: 'text-accent',
  correct: 'text-accent',
  wrong: 'text-danger',
  perfect: 'text-gold',
};

const toneBadge: Record<CardTone, string> = {
  normal: 'bg-accent text-ground',
  correct: 'bg-accent text-ground',
  wrong: 'bg-danger text-ground',
  perfect: 'bg-gold text-ground',
};

/**
 * A revealed timeline card. Layout per spec:
 * artist 25% (top) / year 50% (middle, dominant) / title 25% (bottom).
 * Album cover displayed as background when available.
 */
export function TimelineCard({
  track,
  tone = 'normal',
  large = false,
  small = false,
  round,
}: {
  track: GameTrack;
  tone?: CardTone;
  large?: boolean;
  small?: boolean;
  /** Daily mode: the round in which this card was played. */
  round?: number;
}) {
  const size = large ? 'h-[26rem] w-72' : small
      ? 'h-36 w-24 sm:h-44 sm:w-28 short:h-32 short:w-20 tiny:h-24 tiny:w-16'
      : 'h-44 w-28 sm:h-52 sm:w-36 short:h-36 short:w-24 tiny:h-24 tiny:w-20';
  const yearText = large ? 'text-6xl' : small ? 'text-2xl sm:text-3xl' : 'text-3xl sm:text-4xl';
  const labelText = large ? 'text-sm' : small ? 'text-[9px] sm:text-[10px]' : 'text-[10px] sm:text-xs';

  const yearColor = round === ANCHOR_ROUND ? 'text-start' : toneText[tone];

  return (
    <div
      className={`relative flex ${size} shrink-0 flex-col overflow-hidden rounded-2xl text-center transition-shadow ${toneRing[tone]}`}
    >
      {/* Album cover background */}
      {track.cover ? (
        <>
          <img
            src={track.cover}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-black/55" />
        </>
      ) : (
        <div className="absolute inset-0 bg-raised" />
      )}

      {round !== undefined && (
        <span
          className={`absolute left-0 top-0 z-20 rounded-br-xl px-2 py-0.5 text-[11px] font-bold sm:text-xs ${
            round === ANCHOR_ROUND ? 'bg-start text-ground' : toneBadge[tone]
          }`}
        >
          #{round}
        </span>
      )}

      {/* Content on top of cover */}
      <div className="relative z-10 flex h-[25%] items-center justify-center px-3">
        <span className={`line-clamp-2 ${labelText} font-semibold text-white/80 drop-shadow`}>{track.artist}</span>
      </div>
      <div className="relative z-10 flex h-[50%] items-center justify-center">
        <span
          className={`${yearText} font-extrabold drop-shadow-lg ${yearColor}`}
        >
          {track.year}
        </span>
      </div>
      <div className="relative z-10 flex h-[25%] items-center justify-center px-3">
        <span className={`line-clamp-2 ${labelText} font-semibold text-white drop-shadow`}>{track.title}</span>
      </div>
    </div>
  );
}

/** The face-down mystery card (also used inline in the timeline while pending). */
export function MysteryCardFace({ small = false }: { small?: boolean }) {
  return (
    <div
      className={`flex ${
        small
          ? 'h-44 w-28 shrink-0 sm:h-52 sm:w-36 short:h-36 short:w-24 tiny:h-24 tiny:w-20'
          : 'h-48 min-h-20 aspect-[2/3] shrink sm:h-60 tiny:hidden'
      } flex-col items-center justify-center gap-2 rounded-xl sm:rounded-2xl border-2 border-dashed border-accent/70 bg-surface`}
    >
      <span className="text-4xl sm:text-5xl font-extrabold text-accent">?</span>
    </div>
  );
}
