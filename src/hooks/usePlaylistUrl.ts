import { useEffect, useState } from "react";
import { fetchPlaylistUrl } from "../services/playlistLink";

/** The Spotify playlist of a daily challenge, or null while loading or when there is none. */
export function usePlaylistUrl(dayIndex: number): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPlaylistUrl(dayIndex).then((found) => {
      if (!cancelled) setUrl(found);
    });
    return () => {
      cancelled = true;
    };
  }, [dayIndex]);

  return url;
}
