import type { GameTrack, PlaylistMeta } from '../engine/types';

/**
 * Opaque container for a playlist's raw track listing.
 * Allows providers to defer expensive work (e.g. album-date lookups)
 * until a random batch is actually needed.
 */
export interface RawTrackData {
  tracks: GameTrack[];
  unresolvedTracks?: unknown;
  totalCount: number;
}

export interface MusicProvider {
  id: string;
  label: string;
  connect(): Promise<void>;
  isReady(): boolean;
  getMyPlaylists?(): Promise<PlaylistMeta[]>;
  searchPlaylists(query: string): Promise<PlaylistMeta[]>;
  getPlayableTracks(playlistId: string): Promise<GameTrack[]>;
  getRawTrackList?(playlistId: string): Promise<RawTrackData>;
  resolveTrackBatch?(raw: RawTrackData, count: number, excludeIds?: Set<string>): Promise<GameTrack[]>;
  play30s(track: GameTrack, onProgress: (seconds: number) => void): Promise<void>;
  stop(): void;
}
