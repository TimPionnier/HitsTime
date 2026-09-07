import { create } from 'zustand';
import type { GameState, GameTrack, PlaylistMeta, RevealResult } from '../engine/types';
import { nextRound, placeAt, skipMystery, startGame, unplace, validate } from '../engine/game';
import {
  startOYGame,
  readyToGuess,
  guessOY,
  nextOYRound,
  skipOYMystery,
  type OYState,
  type OYGuess,
} from '../engine/olderYounger';
import type { MusicProvider, RawTrackData } from '../providers/types';
import { createDeezerProvider } from '../providers/deezer';
import { addScore } from '../services/leaderboard';
import { translate, type Lang, type TKey } from '../services/i18n';

export type Screen = 'modeSelect' | 'game' | 'end';
export type GameMode = 'timeline' | 'olderYounger';

type ClipStatus = 'idle' | 'playing' | 'done';

const BATCH_SIZE = 10;
const PREFETCH_AT = 5;
const REVEAL_MS = 1600;

const DEFAULT_PLAYLIST: PlaylistMeta = {
  id: '15689112801',
  name: 'Blindtest Hitstime',
  cover: 'https://cdn-images.dzcdn.net/images/playlist/c0fcd06d46514d9343c95b0ad11884f0/250x250-000000-80-0-0.jpg',
  trackCount: 320,
  owner: 'mytimothee',
};

interface AppState {
  lang: Lang;
  screen: Screen;
  provider: MusicProvider;
  playlist: PlaylistMeta;
  gameMode: GameMode;
  game: GameState | null;
  oyGame: OYState | null;
  clip: { status: ClipStatus; progress: number };
  loading: boolean;
  error: string | null;

  // End-of-game timeline snapshot (includes the wrong card for review)
  endTimeline: { tracks: GameTrack[]; wrongTrack: RevealResult | null } | null;

  // Batch management
  rawTrackData: RawTrackData | null;
  roundNumber: number;
  prefetchedTracks: GameTrack[] | null;
  prefetching: boolean;
  usedTrackIds: Set<string>;

  t: (key: TKey) => string;
  setLang: (lang: Lang) => void;
  init: () => void;
  startGame: (mode?: GameMode) => Promise<void>;
  playClip: () => void;
  place: (index: number) => void;
  withdraw: () => void;
  confirm: () => void;
  guessOlderYounger: (guess: OYGuess) => void;
  goHome: () => void;
  replaySame: () => Promise<void>;
  changeMode: () => void;
}

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('hitstime.lang');
    if (saved === 'en' || saved === 'fr') return saved;
    return navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}

const deezerProvider = createDeezerProvider();

export const useApp = create<AppState>((set, get) => {
  /** Fetch a batch of tracks using the batch interface or fallback. */
  async function fetchBatch(
    provider: MusicProvider,
    playlistId: string,
    excludeIds?: Set<string>,
  ): Promise<{ tracks: GameTrack[]; raw: RawTrackData | null }> {
    if (provider.getRawTrackList && provider.resolveTrackBatch) {
      const raw = await provider.getRawTrackList(playlistId);
      if (raw.totalCount > BATCH_SIZE) {
        const tracks = await provider.resolveTrackBatch(raw, BATCH_SIZE, excludeIds);
        return { tracks, raw };
      }
      if (raw.tracks.length > 0) return { tracks: raw.tracks, raw };
      const tracks = await provider.resolveTrackBatch(raw, raw.totalCount, excludeIds);
      return { tracks, raw };
    }
    const tracks = await provider.getPlayableTracks(playlistId);
    return { tracks, raw: null };
  }

  /** Resolve a new batch from cached raw data, excluding already-used tracks. */
  async function resolveBatch(provider: MusicProvider, raw: RawTrackData, excludeIds?: Set<string>): Promise<GameTrack[]> {
    if (provider.resolveTrackBatch) {
      return provider.resolveTrackBatch(raw, BATCH_SIZE, excludeIds);
    }
    let pool = raw.tracks;
    if (excludeIds && excludeIds.size > 0) {
      pool = pool.filter((t) => !excludeIds.has(t.id));
    }
    return [...pool].sort(() => Math.random() - 0.5).slice(0, BATCH_SIZE);
  }

  /** Record the score and land on the end screen. */
  const finishGame = (score: number, cleared: boolean) => {
    const { playlist, provider, gameMode, game } = get();
    addScore({
      providerId: provider.id,
      playlistId: playlist.id,
      playlistName: playlist.name,
      gameMode,
      score,
      cleared,
      date: new Date().toISOString(),
    });

    // Build end-of-game timeline snapshot for the review screen
    let endTimeline: AppState['endTimeline'] = null;
    if (gameMode === 'timeline' && game) {
      const timeline = [...game.timeline];
      const wrongTrack = game.reveal && !game.reveal.correct ? game.reveal : null;
      // Insert the wrong card at the position the player chose, so they can see the full picture
      if (wrongTrack) {
        timeline.splice(wrongTrack.chosenIndex, 0, wrongTrack.track);
      }
      endTimeline = { tracks: timeline, wrongTrack };
    }

    set({ screen: 'end', endTimeline });
  };

  /** Trigger background pre-fetch when approaching batch end. */
  const maybePrefetch = () => {
    const { roundNumber, rawTrackData, provider, prefetching, prefetchedTracks, usedTrackIds } = get();
    if (
      roundNumber >= PREFETCH_AT &&
      rawTrackData &&
      provider &&
      !prefetching &&
      !prefetchedTracks
    ) {
      set({ prefetching: true });
      resolveBatch(provider, rawTrackData, usedTrackIds)
        .then((tracks) => set({ prefetchedTracks: tracks, prefetching: false }))
        .catch(() => set({ prefetching: false }));
    }
  };

  /** Collect IDs from a track array into the usedTrackIds set. */
  const markUsed = (tracks: GameTrack[]) => {
    const { usedTrackIds } = get();
    const updated = new Set(usedTrackIds);
    for (const t of tracks) updated.add(t.id);
    set({ usedTrackIds: updated });
  };

  /** When deck is empty but we have pre-fetched tracks, inject them into the current game. */
  const handleDeckEmpty = () => {
    const { prefetchedTracks, gameMode, game, oyGame } = get();
    if (!prefetchedTracks || prefetchedTracks.length < 2) return false;

    markUsed(prefetchedTracks);

    if (gameMode === 'timeline' && game) {
      const deck = [...prefetchedTracks];
      const mystery = deck.shift()!;
      set({
        game: {
          ...game,
          phase: 'listening',
          deck,
          mystery,
          pendingIndex: null,
          reveal: null,
        },
        prefetchedTracks: null,
        roundNumber: 0,
        clip: { status: 'idle', progress: 0 },
      });
      return true;
    }
    if (gameMode === 'olderYounger' && oyGame) {
      const deck = [...prefetchedTracks];
      const mystery = deck.shift()!;
      set({
        oyGame: {
          ...oyGame,
          phase: 'listening',
          deck,
          mystery,
          guess: null,
          reveal: null,
        },
        prefetchedTracks: null,
        roundNumber: 0,
        clip: { status: 'idle', progress: 0 },
      });
      return true;
    }
    return false;
  };

  return {
    lang: initialLang(),
    screen: 'modeSelect',
    provider: deezerProvider,
    playlist: DEFAULT_PLAYLIST,
    gameMode: 'timeline',
    game: null,
    oyGame: null,
    endTimeline: null,
    clip: { status: 'idle', progress: 0 },
    loading: false,
    error: null,
    rawTrackData: null,
    roundNumber: 0,
    prefetchedTracks: null,
    prefetching: false,
    usedTrackIds: new Set<string>(),

    t: (key) => translate(get().lang, key),

    setLang: (lang) => {
      try {
        localStorage.setItem('hitstime.lang', lang);
      } catch {
        /* ignore */
      }
      set({ lang });
    },

    /** Called on app boot to start prefetching tracks. */
    init: () => {
      const { provider, playlist } = get();
      set({ prefetching: true });
      fetchBatch(provider, playlist.id)
        .then(({ tracks, raw }) => {
          set({ prefetchedTracks: tracks, rawTrackData: raw, prefetching: false });
        })
        .catch(() => {
          set({ prefetching: false, error: get().t('loadError') });
        });
    },

    startGame: async (modeOverride?: GameMode) => {
      const { provider, playlist, t } = get();

      set({
        ...(modeOverride ? { gameMode: modeOverride } : {}),
        screen: 'game',
        loading: true,
        error: null,
      });

      let tracks: GameTrack[];
      let raw: RawTrackData | null;

      try {
        const cur = get();
        if (cur.prefetchedTracks && cur.prefetchedTracks.length >= 2) {
          tracks = cur.prefetchedTracks;
          raw = cur.rawTrackData;
        } else {
          const result = await fetchBatch(provider, playlist.id);
          tracks = result.tracks;
          raw = result.raw;
        }

        if (tracks.length < 2) {
          set({ loading: false, error: t('notEnoughTracks') });
          return;
        }
      } catch {
        set({ loading: false, error: t('loadError') });
        return;
      }

      const usedTrackIds = new Set(tracks.map((t) => t.id));

      const { gameMode } = get();
      if (gameMode === 'timeline') {
        set({
          game: startGame(tracks),
          oyGame: null,
          rawTrackData: raw,
          roundNumber: 0,
          prefetchedTracks: null,
          prefetching: false,
          usedTrackIds,
          screen: 'game',
          loading: false,
          clip: { status: 'idle', progress: 0 },
        });
      } else {
        set({
          oyGame: startOYGame(tracks),
          game: null,
          rawTrackData: raw,
          roundNumber: 0,
          prefetchedTracks: null,
          prefetching: false,
          usedTrackIds,
          screen: 'game',
          loading: false,
          clip: { status: 'idle', progress: 0 },
        });
      }
    },

    playClip: () => {
      const { provider, game, oyGame, gameMode, clip } = get();
      const mystery = gameMode === 'timeline' ? game?.mystery : oyGame?.mystery;
      if (!provider || !mystery || clip.status !== 'idle') return;
      const trackId = mystery.id;
      set({ clip: { status: 'playing', progress: 0 } });

      provider
        .play30s(mystery, (seconds) => {
          const cur = get();
          if (cur.clip.status === 'playing') {
            set({ clip: { status: seconds >= 30 ? 'done' : 'playing', progress: seconds } });
          }
        })
        .then(() => {
          const cur = get();
          if (cur.clip.status === 'playing') set({ clip: { status: 'done', progress: 30 } });
          if (get().gameMode === 'olderYounger' && get().oyGame?.phase === 'listening') {
            set({ oyGame: readyToGuess(get().oyGame!) });
          }
        })
        .catch(() => {
          const cur = get();
          const curMystery = cur.gameMode === 'timeline' ? cur.game?.mystery : cur.oyGame?.mystery;
          if (!curMystery || curMystery.id !== trackId) return;

          if (cur.gameMode === 'timeline' && cur.game) {
            const skipped = skipMystery(cur.game);
            if (skipped.phase === 'cleared') {
              if (!handleDeckEmpty()) finishGame(skipped.score, true);
              return;
            }
            set({ game: skipped, clip: { status: 'idle', progress: 0 }, error: cur.t('clipSkipped') });
          } else if (cur.oyGame) {
            const skipped = skipOYMystery(cur.oyGame);
            if (skipped.phase === 'cleared') {
              if (!handleDeckEmpty()) finishGame(skipped.score, true);
              return;
            }
            set({ oyGame: skipped, clip: { status: 'idle', progress: 0 }, error: cur.t('clipSkipped') });
          }
          window.setTimeout(() => {
            if (get().error === cur.t('clipSkipped')) set({ error: null });
          }, 4000);
        });
    },

    place: (index) => {
      const { game } = get();
      if (!game) return;
      set({ game: placeAt(game, index) });
    },

    withdraw: () => {
      const { game } = get();
      if (!game) return;
      set({ game: unplace(game) });
    },

    confirm: () => {
      const { game, provider } = get();
      if (!game || game.phase !== 'pendingValidation') return;
      provider?.stop();
      const revealed = validate(game);
      const round = get().roundNumber + 1;
      set({ game: revealed, clip: { status: 'idle', progress: 0 }, roundNumber: round });
      maybePrefetch();

      window.setTimeout(() => {
        const cur = get().game;
        if (!cur || cur.phase !== 'revealing') return;
        const advanced = nextRound(cur);
        if (advanced.phase === 'gameOver') {
          set({ game: advanced });
          finishGame(advanced.score, false);
        } else if (advanced.phase === 'cleared') {
          set({ game: advanced });
          if (!handleDeckEmpty()) finishGame(advanced.score, true);
        } else {
          set({ game: advanced, clip: { status: 'idle', progress: 0 } });
        }
      }, REVEAL_MS);
    },

    guessOlderYounger: (guess: OYGuess) => {
      const { oyGame, provider, clip } = get();
      if (!oyGame) return;
      if (oyGame.phase !== 'pendingGuess' && oyGame.phase !== 'listening') return;
      if (clip.status === 'idle') return;
      provider?.stop();
      const ready = oyGame.phase === 'listening' ? readyToGuess(oyGame) : oyGame;
      const revealed = guessOY(ready, guess);
      const round = get().roundNumber + 1;
      set({ oyGame: revealed, clip: { status: 'idle', progress: 0 }, roundNumber: round });
      maybePrefetch();

      window.setTimeout(() => {
        const cur = get().oyGame;
        if (!cur || cur.phase !== 'revealing') return;
        const advanced = nextOYRound(cur);
        if (advanced.phase === 'gameOver') {
          set({ oyGame: advanced });
          finishGame(advanced.score, false);
        } else if (advanced.phase === 'cleared') {
          set({ oyGame: advanced });
          if (!handleDeckEmpty()) finishGame(advanced.score, true);
        } else {
          set({ oyGame: advanced, clip: { status: 'idle', progress: 0 } });
        }
      }, REVEAL_MS);
    },

    goHome: () => {
      get().provider?.stop();
      set({
        screen: 'modeSelect',
        game: null,
        oyGame: null,
        endTimeline: null,
        error: null,
        rawTrackData: null,
        prefetchedTracks: null,
        prefetching: false,
        loading: false,
        usedTrackIds: new Set<string>(),
      });
      // Prefetch for next game
      get().init();
    },

    replaySame: async () => {
      await get().startGame();
    },

    changeMode: () => {
      get().provider?.stop();
      set({
        screen: 'modeSelect',
        game: null,
        oyGame: null,
        endTimeline: null,
        error: null,
        prefetchedTracks: null,
        prefetching: false,
        usedTrackIds: new Set<string>(),
      });
      // Prefetch for next game
      get().init();
    },
  };
});
