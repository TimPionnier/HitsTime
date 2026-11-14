import { useEffect, useState } from "react";
import { animate, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";

const TWEEN_S = 0.5;

/** Follows `target`, gliding to each new value instead of jumping. */
export function useTweenedNumber(target: number): number {
  const reduceMotion = useReducedMotion();
  const value = useMotionValue(target);
  const [shown, setShown] = useState(target);
  useMotionValueEvent(value, "change", setShown);

  useEffect(() => {
    const controls = animate(value, target, {
      duration: reduceMotion ? 0 : TWEEN_S,
      ease: "easeOut",
    });
    return () => controls.stop();
  }, [value, target, reduceMotion]);

  return shown;
}
