import { useRef, useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { useApp } from '../store';
import { TimelineCard, MysteryCardFace } from './TimelineCard';
import type { GameTrack } from '../engine/types';

function FlipIn({ children }: { children: React.ReactNode }) {
  return (
    <div className="card-3d">
      <motion.div
        initial={{ rotateY: 90, opacity: 0.4 }}
        animate={{ rotateY: 0, opacity: 1 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </div>
  );
}

/** Hover gap between two cards: expands into an empty "+" slot; click to place. */
function GapSlot({
  onPick,
  disabled,
  focused,
}: {
  onPick: () => void;
  disabled: boolean;
  focused: boolean;
}) {
  if (disabled) return <div className="w-2 shrink-0" />;
  return (
    <button
      onClick={onPick}
      aria-label="Place card here"
      className={`flex h-44 sm:h-52 shrink-0 items-center justify-center rounded-xl border-2 border-dashed text-2xl font-bold transition-all ${
        focused
          ? 'w-20 sm:w-28 border-accent text-accent bg-accent/10'
          : 'w-8 sm:w-10 border-muted/30 text-muted/50 hover:w-20 sm:hover:w-28 hover:border-accent hover:text-accent hover:bg-accent/10 active:w-20 active:border-accent active:text-accent'
      }`}
    >
      +
    </button>
  );
}

/** Marker shown at the slot where a misplaced card actually belonged. */
function BelongedHere({ label }: { label: string }) {
  return (
    <div className="flex h-44 sm:h-52 w-14 sm:w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border-2 border-accent bg-accent/10 px-1 text-center">
      <span className="text-2xl">↓</span>
      <span className="text-[10px] font-bold leading-tight text-accent">{label}</span>
    </div>
  );
}

export function Timeline() {
  const game = useApp((s) => s.game);
  const place = useApp((s) => s.place);
  const confirm = useApp((s) => s.confirm);
  const t = useApp((s) => s.t);
  const scroller = useRef<HTMLDivElement>(null);
  const [focusedGap, setFocusedGap] = useState<number | null>(null);
  const gapRefs = useRef<Map<number, HTMLElement>>(new Map());

  const phase = game?.phase;
  const pendingIndex = game?.pendingIndex ?? null;
  const timelineLen = game?.timeline.length ?? 0;
  const canPlace = phase === 'listening' || phase === 'pendingValidation';
  const totalGaps = timelineLen + 1;

  const scrollGapIntoView = (index: number) => {
    const el = gapRefs.current.get(index);
    if (el) el.scrollIntoView({ inline: 'center', behavior: 'smooth' });
  };

  // Arrow keys for gap navigation — must be before any early return
  useEffect(() => {
    if (!canPlace) {
      setFocusedGap(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setFocusedGap((g) => {
          const next = g === null ? 0 : Math.max(0, g - 1);
          scrollGapIntoView(next);
          return next;
        });
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setFocusedGap((g) => {
          const next = g === null ? 0 : Math.min(totalGaps - 1, g + 1);
          scrollGapIntoView(next);
          return next;
        });
      } else if (e.code === 'Enter') {
        e.preventDefault();
        if (focusedGap !== null) {
          if (pendingIndex === focusedGap && phase === 'pendingValidation') {
            confirm();
          } else {
            place(focusedGap);
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canPlace, focusedGap, totalGaps, pendingIndex, phase, confirm, place]);

  if (!game) return null;
  const { timeline, reveal } = game;
  const wrongReveal = phase === 'revealing' && reveal && !reveal.correct ? reveal : null;

  const scrollBy = (dx: number) => scroller.current?.scrollBy({ left: dx, behavior: 'smooth' });

  const toneFor = (track: GameTrack): 'normal' | 'correct' =>
    phase === 'revealing' && reveal?.correct && reveal.track.id === track.id ? 'correct' : 'normal';

  const items: React.ReactNode[] = [];
  for (let i = 0; i <= timeline.length; i++) {
    // slot i
    if (pendingIndex === i && phase === 'pendingValidation') {
      items.push(
        <motion.button
          key="pending"
          layout
          ref={(el) => { if (el) gapRefs.current.set(i, el); }}
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          onClick={confirm}
          aria-label={t('validate')}
          className={`shrink-0 cursor-pointer rounded-xl sm:rounded-2xl ring-2 ring-accent transition-transform hover:scale-[1.03] ${
            focusedGap === i ? 'scale-[1.05] brightness-110' : ''
          }`}
        >
          <MysteryCardFace small />
        </motion.button>,
      );
    } else if (wrongReveal && wrongReveal.chosenIndex === i) {
      items.push(
        <FlipIn key="wrong-card">
          <TimelineCard track={wrongReveal.track} tone="wrong" />
        </FlipIn>,
      );
    } else if (wrongReveal && wrongReveal.correctIndex === i) {
      items.push(<BelongedHere key="belonged" label={t('belongedHere')} />);
    } else {
      const gapIndex = i;
      items.push(
        <div
          key={`gap-${i}`}
          ref={(el) => { if (el) gapRefs.current.set(gapIndex, el); }}
        >
          <GapSlot
            disabled={!canPlace}
            focused={focusedGap === gapIndex}
            onPick={() => { place(gapIndex); setFocusedGap(gapIndex); }}
          />
        </div>,
      );
    }
    // card i
    if (i < timeline.length) {
      const track = timeline[i];
      const isNew = phase === 'revealing' && reveal?.correct && reveal.track.id === track.id;
      items.push(
        isNew ? (
          <FlipIn key={track.id}>
            <TimelineCard track={track} tone="correct" />
          </FlipIn>
        ) : (
          <motion.div key={track.id} layout>
            <TimelineCard track={track} tone={toneFor(track)} />
          </motion.div>
        ),
      );
    }
  }

  const arrowCls =
    'hidden sm:grid size-11 shrink-0 place-items-center rounded-full bg-raised text-xl text-muted transition-colors hover:bg-accent hover:text-ground';

  return (
    <div className="flex items-center gap-1 sm:gap-2 px-1 sm:px-3">
      <button className={arrowCls} onClick={() => scrollBy(-320)} aria-label="Scroll left">
        ‹
      </button>
      <div
        ref={scroller}
        className="timeline-scroll flex flex-1 items-center gap-1 overflow-x-auto py-2 sm:py-4"
      >
        <div className="mx-auto flex items-center gap-1">{items}</div>
      </div>
      <button className={arrowCls} onClick={() => scrollBy(320)} aria-label="Scroll right">
        ›
      </button>
    </div>
  );
}
