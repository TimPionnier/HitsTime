import type { GameTrack } from '../../engine/types';
import type { MusicProvider } from '../types';
import {
  searchPlaylists,
  getPlayableTracks,
  getRawTrackList,
  resolveTrackBatch,
} from './api';

const CLIP_SECONDS = 30;

export function createDeezerProvider(): MusicProvider {
  let audio: HTMLAudioElement | null = null;
  let clipTimer: ReturnType<typeof setInterval> | null = null;
  let finish: (() => void) | null = null;

  const stopClip = () => {
    if (clipTimer) clearInterval(clipTimer);
    clipTimer = null;
    if (audio) {
      audio.pause();
      audio.src = '';
      audio = null;
    }
    finish?.();
    finish = null;
  };

  return {
    id: 'deezer',
    label: 'Deezer',

    connect: async () => {
      // No auth needed — public API with JSONP.
    },

    isReady: () => true,

    // No getMyPlaylists — would require Deezer OAuth, not needed.
    searchPlaylists,
    getPlayableTracks,
    getRawTrackList,
    resolveTrackBatch,

    play30s: async (track: GameTrack, onProgress: (s: number) => void) => {
      const previewUrl = (track.providerData as { previewUrl?: string } | undefined)?.previewUrl;
      if (!previewUrl) throw new Error('Track has no Deezer preview URL');

      stopClip();
      audio = new Audio(previewUrl);

      await new Promise<void>((resolve, reject) => {
        audio!.addEventListener('canplaythrough', () => resolve(), { once: true });
        audio!.addEventListener('error', () => reject(new Error('Audio failed to load')), {
          once: true,
        });
        audio!.load();
      });

      audio.play();
      const startedAt = Date.now();
      onProgress(0);

      await new Promise<void>((resolve) => {
        finish = resolve;
        clipTimer = setInterval(() => {
          const s = Math.min(CLIP_SECONDS, (Date.now() - startedAt) / 1000);
          onProgress(s);
          if (s >= CLIP_SECONDS) stopClip();
        }, 200);

        // Also stop when the preview naturally ends (some are shorter than 30s).
        audio!.addEventListener('ended', () => stopClip(), { once: true });
      });
    },

    stop: stopClip,
  };
}
