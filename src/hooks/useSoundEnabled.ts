import { useCallback, useState } from "react";

const STORAGE_KEY = "hitstime.sound";
const DISABLED = "0";
const ENABLED = "1";

function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== DISABLED;
  } catch {
    return true;
  }
}

/** Player's sound preference, on by default and remembered on this device. */
export function useSoundEnabled(): [boolean, () => void] {
  const [enabled, setEnabled] = useState(readPreference);

  const toggle = useCallback(() => {
    setEnabled((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_KEY, next ? ENABLED : DISABLED);
      } catch {
        // Private mode: the choice just lasts for this visit.
      }
      return next;
    });
  }, []);

  return [enabled, toggle];
}
