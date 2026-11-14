import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { cn } from "../../lib/cn";

const badgeVariants = {
  hidden: { opacity: 0, y: 12, scale: 0.8 },
  visible: { opacity: 1, y: 0, scale: 1 },
  gone: { opacity: 0, y: -12, scale: 1 },
};

const BADGE_TRANSITION = { duration: 0.25, ease: "easeOut" } as const;

export type BonusTone = "gold" | "accent" | "danger";

const TONE_CLASSES: Record<BonusTone, string> = {
  gold: "bg-gold text-ground shadow-gold/30",
  accent: "bg-accent text-ground shadow-accent/30",
  danger: "bg-danger text-white shadow-danger/30",
};

type BonusBadgeProps = {
  /** Text of the bonus just earned ("-20 s", "+2"); null hides the badge. */
  label: string | null;
  tone?: BonusTone;
};

export function BonusBadge({ label, tone = "gold" }: BonusBadgeProps) {
  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {label !== null && (
          <motion.span
            key={label}
            role="status"
            variants={badgeVariants}
            initial="hidden"
            animate="visible"
            exit="gone"
            transition={BADGE_TRANSITION}
            className={cn(
              "whitespace-nowrap rounded-full px-3 py-1 text-base font-extrabold tabular-nums shadow-lg sm:text-lg",
              TONE_CLASSES[tone],
            )}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
