import { useEffect } from 'react';
import { useApp } from '../store';

const CLIP = 30;

export function PlaybackBar() {
  const clip = useApp((s) => s.clip);
  const playClip = useApp((s) => s.playClip);
  const gameMode = useApp((s) => s.gameMode);
  const t = useApp((s) => s.t);

  // Spacebar starts the clip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && clip.status === 'idle') {
        e.preventDefault();
        playClip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clip.status, playClip]);

  const pct = Math.min(100, (clip.progress / CLIP) * 100);

  return (
    <div className="flex w-72 flex-col items-center gap-2">
      {clip.status === 'idle' && (
        <>
          <button
            onClick={playClip}
            className="flex items-center gap-2 rounded-full bg-accent px-6 py-3 font-bold text-ground transition-transform hover:scale-105"
          >
            <span className="text-lg leading-none">{"▶"}</span> {t('playClip')}
          </button>
          <p className="text-xs text-muted">{t('clipOnce')}</p>
        </>
      )}
      {clip.status !== 'idle' && (
        <>
          <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs font-semibold text-muted">
            {clip.status === 'playing'
              ? `${t('playing')} ${Math.floor(clip.progress)}s / ${CLIP}s`
              : t(gameMode === 'olderYounger' ? 'clipDoneOY' : 'clipDone')}
          </p>
        </>
      )}
    </div>
  );
}
