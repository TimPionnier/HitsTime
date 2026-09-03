import type { GameTrack } from '../engine/types';

export type CardTone = 'normal' | 'correct' | 'wrong';

const toneRing: Record<CardTone, string> = {
  normal: '',
  correct: 'ring-2 ring-accent shadow-lg shadow-accent/20',
  wrong: 'ring-2 ring-danger shadow-lg shadow-danger/20',
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
}: {
  track: GameTrack;
  tone?: CardTone;
  large?: boolean;
}) {
  const size = large ? 'h-[26rem] w-72' : 'h-52 w-36';
  const yearText = large ? 'text-6xl' : 'text-4xl';
  const labelText = large ? 'text-sm' : 'text-xs';

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

      {/* Content on top of cover */}
      <div className="relative z-10 flex h-[25%] items-center justify-center px-3">
        <span className={`line-clamp-2 ${labelText} font-semibold text-white/80 drop-shadow`}>{track.artist}</span>
      </div>
      <div className="relative z-10 flex h-[50%] items-center justify-center">
        <span
          className={`${yearText} font-extrabold drop-shadow-lg ${tone === 'wrong' ? 'text-danger' : 'text-accent'}`}
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
      className={`flex ${small ? 'h-52 w-36' : 'h-60 w-40'} shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent/70 bg-surface`}
    >
      <span className="text-5xl font-extrabold text-accent">?</span>
    </div>
  );
}
