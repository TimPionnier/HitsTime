/** A track as the game engine sees it — provider-agnostic. */
export interface GameTrack {
  id: string;
  title: string;
  artist: string;
  /** Release year of the album the track appears on (provider-reported). */
  year: number;
  /** Album cover URL (for card background). */
  cover?: string;
  /** Opaque provider payload (Spotify URI, Deezer preview URL, …). */
  providerData?: unknown;
}

export interface PlaylistMeta {
  id: string;
  name: string;
  cover?: string;
  trackCount: number;
  owner?: string;
}

export type GamePhase =
  | 'idle'
  | 'listening' // mystery drawn, clip playable / playing
  | 'pendingValidation' // card provisionally placed, awaiting confirm
  | 'revealing' // reveal animation, result known
  | 'gameOver'
  | 'cleared'; // deck exhausted — playlist cleared, it's a win

export interface RevealResult {
  correct: boolean;
  /** Index where the card would have been correct (lowest valid slot). */
  correctIndex: number;
  /** Index the player chose. */
  chosenIndex: number;
  track: GameTrack;
  /** Points awarded this round (streak-based: 1st correct = +1, 2nd = +2, …). */
  pointsAwarded: number;
}

export interface GameState {
  phase: GamePhase;
  /** Cards on the timeline, sorted ascending by year. */
  timeline: GameTrack[];
  /** The current unknown track (hidden from the UI until reveal). */
  mystery: GameTrack | null;
  /** Provisional slot index chosen by the player (0 = before first card). */
  pendingIndex: number | null;
  score: number;
  /** Consecutive correct answers (resets on game start). */
  streak: number;
  /** Remaining tracks to draw. */
  deck: GameTrack[];
  reveal: RevealResult | null;
}
