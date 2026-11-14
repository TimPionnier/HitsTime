import { AnimatePresence, MotionConfig, motion } from "motion/react";

const badgeVariants = {
  hidden: { opacity: 0, y: 12, scale: 0.8 },
  visible: { opacity: 1, y: 0, scale: 1 },
  gone: { opacity: 0, y: -12, scale: 1 },
};

const BADGE_TRANSITION = { duration: 0.25, ease: "easeOut" } as const;

type BonusBadgeProps = {
  /** Text of the bonus just earned ("-20 s", "+2"); null hides the badge. */
  label: string | null;
};

export function BonusBadge({ label }: BonusBadgeProps) {
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
            className="whitespace-nowrap rounded-full bg-gold px-3 py-1 text-base font-extrabold tabular-nums text-ground shadow-lg shadow-gold/30 sm:text-lg"
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
