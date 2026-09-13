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
import { translate, type Lang, type TKey, type TVars } from '../services/i18n';
import {
  localDateISO,
  startDailyGame,
  toGameTrack,
  isPlayableDate,
  type DailyChallenge,
} from '../engine/daily';
import { NotPublishedYet, loadChallenge } from '../daily/shards';
import {
  adjustedMsFor,
  getAttempt,
  isSuspect,
  newAttempt,
  saveAttempt,
  withPeek,
  type DailyAttempt,
  type DailyRound,
} from '../services/dailyStore';
import { DailyTimer } from '../services/dailyTimer';
import {
  abandonRun,
  beginRun,
  dailyScope,
  playlistScope,
  reportRun,
  reportShardMissing,
} from '../services/analytics';
import { watchDevtools } from '../services/devtools';

export type Screen = 'modeSelect' | 'game' | 'end' | 'dailyArchive';
export type GameMode = 'timeline' | 'olderYounger' | 'daily';

type ClipStatus = 'idle' | 'playing' | 'done';

const BATCH_SIZE = 10;
const PREFETCH_AT = 5;
const REVEAL_MS = 1600;

/** How long the peek snackbar stays up. */
const SNACK_MS = 7000;

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
  /** Transient message shown over the game. Currently only the peek warning. */
  snack: string | null;

  // End-of-game timeline snapshot (includes the wrong card for review)
  endTimeline: { tracks: GameTrack[]; wrongTrack: RevealResult | null } | null;

  // Daily challenge
  daily: DailyChallenge | null;
  dailyAttempt: DailyAttempt | null;
  dailyDate: string;

  // Batch management
  rawTrackData: RawTrackData | null;
  roundNumber: number;
  prefetchedTracks: GameTrack[] | null;
  prefetching: boolean;
  usedTrackIds: Set<string>;

  t: (key: TKey, vars?: TVars) => string;
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

  startDaily: (date?: string) => Promise<void>;
  openArchive: () => void;
  dailyElapsedMs: () => number;
  dismissSnack: () => void;
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
  /** The daily clock. Recreated per run; null outside daily mode. */
  let timer: DailyTimer | null = null;
  /** performance.now() at the moment the current round became answerable. */
  let roundStartMs = 0;

  /**
   * Charge the peek penalty.
   *
   * Note what this deliberately does NOT do: pause the clock. Stopping time
   * while the panel is open would hand the peeker a free, untimed look at the
   * store once they had paid — the opposite of the intent.
   *
   * Guarded on an answerable daily round, so the panel can be opened freely on
   * the menus, the archive, the end screen, and in the free-play modes. Nothing
   * there is worth hiding.
   *
   * Returns whether the charge landed. The detector uses that to decide whether
   * to latch: a refusal here must leave it armed, or opening the panel before
   * starting a run would disarm it for the whole session.
   */
  const chargePeek = (): boolean => {
    const { gameMode, game, dailyAttempt, t } = get();
    if (gameMode !== 'daily' || !dailyAttempt) return false;
    const phase = game?.phase;
    if (phase !== 'listening' && phase !== 'pendingValidation') return false;

    const charged = withPeek(dailyAttempt);
    if (!charged) return false;

    persistDaily({ peeks: charged.peeks });
    set({ snack: t('peekCaught') });
    window.setTimeout(() => {
      if (get().snack === t('peekCaught')) set({ snack: null });
    }, SNACK_MS);
    return true;
  };

  if (typeof window !== 'undefined') watchDevtools(chargePeek);

  // Pause the clock whenever the tab goes away, so an abandoned tab can't
  // inflate a run and a backgrounded one can't be farmed.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!timer) return;
      if (document.hidden) {
        timer.pause();
      } else if (get().gameMode === 'daily') {
        const phase = get().game?.phase;
        if (phase === 'listening' || phase === 'pendingValidation') timer.resume();
      }
    });
  }

  /** Persist the in-progress run so a reload resumes rather than restarts. */
  const persistDaily = (patch: Partial<DailyAttempt>) => {
    const { dailyAttempt } = get();
    if (!dailyAttempt) return;
    const next: DailyAttempt = { ...dailyAttempt, ...patch };
    next.adjustedMs = adjustedMsFor(next.rawActiveMs, next.errors, next.peeks ?? 0);
    saveAttempt(next);
    set({ dailyAttempt: next });
  };

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
    reportRun({ score, cleared });
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

  /** Tracks already retried this run, so a genuinely dead preview asks once. */
  const previewRetried = new Set<string>();

  /**
   * A clip failed. Re-resolve the track and try once more; only if that also
   * comes back empty do we tell the player to place it blind.
   */
  const retryPreview = (trackId: string) => {
    const { provider, t } = get();
    const give_up = () => {
      set({ clip: { status: 'done', progress: 30 }, error: t('dailyNoPreview') });
      window.setTimeout(() => {
        if (get().error === t('dailyNoPreview')) set({ error: null });
      }, 4000);
    };

    if (!provider.getOnePlayback || previewRetried.has(trackId)) {
      give_up();
      return;
    }
    previewRetried.add(trackId);
    set({ clip: { status: 'idle', progress: 0 }, error: t('dailyRetrying') });

    provider
      .getOnePlayback(trackId)
      .then((live) => {
        const cur = get();
        if (cur.game?.mystery?.id !== trackId) return;
        if (!live.previewUrl) {
          give_up();
          return;
        }
        // Patch the resolved URL into the card and play it.
        const mystery = { ...cur.game.mystery, providerData: { previewUrl: live.previewUrl } };
        set({ game: { ...cur.game, mystery }, error: null, clip: { status: 'idle', progress: 0 } });
        get().playClip();
      })
      .catch(() => {
        if (get().game?.mystery?.id === trackId) give_up();
      });
  };

  /** Seal the daily run: stop the clock, score it, land on the end screen. */
  const finishDaily = (state: GameState) => {
    timer?.pause();
    const rawActiveMs = timer?.elapsedMs() ?? 0;
    const attempt = get().dailyAttempt;
    if (attempt) {
      const finished: DailyAttempt = {
        ...attempt,
        status: 'finished',
        rounds: attempt.rounds,
        errors: state.errors,
        streak: state.streak,
        rawActiveMs,
        adjustedMs: adjustedMsFor(rawActiveMs, state.errors, attempt.peeks ?? 0),
        finishedAtEpochMs: Date.now(),
        // A peek is a suspicion, not a proof — but it belongs in the same flag
        // the implausible-timing check uses, so a future leaderboard has one
        // field to filter on.
        suspect: isSuspect(attempt.rounds, rawActiveMs) || (attempt.peeks ?? 0) > 0,
      };
      saveAttempt(finished);
      set({ dailyAttempt: finished });
      // `peeks` and `suspect` ride along so the server can keep these runs in
      // the play counts while excluding them from averages — a 5-minute
      // heuristic penalty would otherwise swamp a distribution measured in
      // seconds. See docs/analytics-architecture.md §1.6.
      reportRun({
        score: finished.adjustedMs,
        cleared: true,
        errors: finished.errors,
        peeks: finished.peeks ?? 0,
        suspect: finished.suspect ?? false,
      });
    }
    timer = null;
    set({
      game: state,
      screen: 'end',
      endTimeline: { tracks: state.timeline, wrongTrack: null },
    });
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
    snack: null,
    daily: null,
    dailyAttempt: null,
    dailyDate: localDateISO(),
    rawTrackData: null,
    roundNumber: 0,
    prefetchedTracks: null,
    prefetching: false,
    usedTrackIds: new Set<string>(),

    t: (key, vars) => translate(get().lang, key, vars),

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

      // Deliberately NOT awaited: the deal below must not wait on a telemetry
      // round-trip, and a ticket that never arrives just means this run goes
      // uncounted.
      void beginRun(get().gameMode, playlistScope(provider.id, playlist.id));

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
      const mystery = gameMode === 'olderYounger' ? oyGame?.mystery : game?.mystery;
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

          if (cur.gameMode === 'daily') {
            // Never substitute: the challenge IS these ids, and swapping one in
            // would change an archived day's answer. But before telling the
            // player the song has no preview, re-resolve it once — the usual
            // cause is a transient Deezer quota error, which clears in seconds,
            // and "no preview" is a permanent-sounding message for it.
            if (cur.game?.mystery?.id !== trackId) return;
            retryPreview(trackId);
            return;
          }

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
      const { game, provider, gameMode } = get();
      if (!game || game.phase !== 'pendingValidation') return;
      provider?.stop();

      if (gameMode === 'daily') {
        // The clock stops for the reveal: the player cannot influence that
        // animation, and charging for it would punish an error twice.
        const thinkMs = timer ? Math.max(0, timer.elapsedMs() - roundStartMs) : 0;
        timer?.pause();

        const revealed = validate(game, 'continue');
        const round: DailyRound = {
          trackId: game.mystery!.id,
          chosenIndex: game.pendingIndex!,
          correctIndex: revealed.reveal!.correctIndex,
          correct: revealed.reveal!.correct,
          thinkMs,
        };
        const attempt = get().dailyAttempt;
        const rounds = [...(attempt?.rounds ?? []), round];
        const rawActiveMs = timer?.elapsedMs() ?? 0;
        persistDaily({
          rounds,
          errors: revealed.errors,
          streak: revealed.streak,
          rawActiveMs,
        });
        set({ game: revealed, clip: { status: 'idle', progress: 0 } });

        window.setTimeout(() => {
          const cur = get().game;
          if (!cur || cur.phase !== 'revealing') return;
          const advanced = nextRound(cur, 'continue');
          if (advanced.phase === 'cleared') {
            finishDaily(advanced);
          } else {
            set({ game: advanced, clip: { status: 'idle', progress: 0 } });
            roundStartMs = timer?.elapsedMs() ?? 0;
            timer?.resume();
          }
        }, REVEAL_MS);
        return;
      }

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
      abandonRun();
      timer = null;
      set({
        screen: 'modeSelect',
        game: null,
        oyGame: null,
        endTimeline: null,
        error: null,
        snack: null,
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

    /**
     * Load and deal the challenge for `date` (defaults to the player's local
     * today). Everything about which songs, and in which order, comes from
     * engine/daily — Deezer is asked only for preview URLs.
     */
    startDaily: async (date?: string) => {
      const target = date ?? localDateISO();
      const { t } = get();

      if (!isPlayableDate(target)) {
        set({ error: t('dailyNotYet'), screen: 'modeSelect' });
        return;
      }

      set({
        gameMode: 'daily',
        screen: 'game',
        loading: true,
        error: null,
        snack: null,
        dailyDate: target,
        game: null,
        oyGame: null,
        endTimeline: null,
      });

      try {
        const challenge = await loadChallenge(target);
        const cards = [challenge.anchor, ...challenge.draw];

        // The challenge IS these ids. A track whose preview has expired keeps
        // its place with audio disabled — substituting one would change an
        // archived day's answer.
        let playback = new Map<string, { previewUrl?: string; cover?: string }>();
        const provider = get().provider;
        if (provider.getPlaybackData) {
          // Hand over the playlist listing boot already paginated: its entries
          // carry preview URLs, so a day usually costs zero extra requests
          // against Deezer's 50-per-5s budget.
          playback = await provider.getPlaybackData(
            cards.map((c) => c.id),
            get().rawTrackData ?? undefined,
          );
        }

        const tracks: GameTrack[] = cards.map((c) => {
          const live = playback.get(c.id);
          return {
            ...toGameTrack(c),
            cover: live?.cover ?? c.cover,
            providerData: { previewUrl: live?.previewUrl },
          };
        });

        const existing = getAttempt(target);
        // An attempt is write-once per date. Reopening a finished day shows the
        // recorded result instead of handing out a second try.
        if (existing?.status === 'finished') {
          // Rebuild the review board. Every card ends up on the timeline
          // whatever the player did — misplaced ones are inserted at their
          // correct index — so the final board is simply the cards by year.
          const review = [...tracks].sort((a, b) => a.year - b.year);
          set({
            daily: challenge,
            dailyAttempt: existing,
            loading: false,
            screen: 'end',
            game: null,
            endTimeline: { tracks: review, wrongTrack: null },
          });
          return;
        }

        const attempt =
          existing && existing.seedHex === challenge.seedHex
            ? existing
            : newAttempt(target, challenge.poolVersion, challenge.seedHex);

        // Reported here rather than on entry: the early return above serves a
        // finished day as a review screen, and counting that as a play would
        // make the archive inflate today's numbers.
        void beginRun('daily', dailyScope(target), {
          algoVersion: challenge.algoVersion,
          poolVersion: challenge.poolVersion,
        });

        previewRetried.clear();
        timer = new DailyTimer(attempt.rawActiveMs);
        roundStartMs = attempt.rawActiveMs;

        let state = startDailyGame(tracks);
        // Replay any rounds already answered before a reload, so the clock and
        // the board both resume where they were.
        for (const r of attempt.rounds) {
          state = nextRound(validate(placeAt(state, r.chosenIndex), 'continue'), 'continue');
        }

        if (state.phase === 'cleared') {
          set({ daily: challenge, dailyAttempt: attempt, loading: false });
          finishDaily(state);
          return;
        }

        set({
          daily: challenge,
          dailyAttempt: attempt,
          game: state,
          loading: false,
          clip: { status: 'idle', progress: 0 },
        });
        timer.resume();
      } catch (err) {
        timer = null;
        // Not a failure: the player's local day has started but the build that
        // publishes it has not run yet. Saying "something went wrong" would
        // send them to reload forever.
        abandonRun();
        // A missing shard is the signature of a frozen scheduled deploy, which
        // is otherwise invisible: the site keeps serving its last built day.
        if (err instanceof NotPublishedYet) reportShardMissing(target);
        const key = err instanceof NotPublishedYet ? 'dailyNotYet' : 'loadError';
        set({ loading: false, error: get().t(key), screen: 'modeSelect' });
      }
    },

    openArchive: () => {
      get().provider?.stop();
      abandonRun();
      timer = null;
      set({
        screen: 'dailyArchive',
        game: null,
        oyGame: null,
        endTimeline: null,
        error: null,
        snack: null,
      });
    },

    dailyElapsedMs: () => timer?.elapsedMs() ?? get().dailyAttempt?.rawActiveMs ?? 0,

    dismissSnack: () => set({ snack: null }),

    changeMode: () => {
      get().provider?.stop();
      abandonRun();
      timer = null;
      set({
        screen: 'modeSelect',
        game: null,
        oyGame: null,
        endTimeline: null,
        error: null,
        snack: null,
        prefetchedTracks: null,
        prefetching: false,
        usedTrackIds: new Set<string>(),
      });
      // Prefetch for next game
      get().init();
    },
  };
});
