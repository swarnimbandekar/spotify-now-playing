export type ProviderId = 'spotify' | 'youtube';

export interface NowPlayingData {
  provider: ProviderId;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  trackUrl: string | null;
  isPlaying: boolean;
  isFallback: boolean;
}

export interface UserData {
  uid: string;
  provider?: ProviderId;
  providerUserId?: string;
  spotifyId?: string;
  displayName: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  lastPlayed?: NowPlayingData | { item: any };
}

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  color: string;
  description: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  spotify: {
    id: 'spotify',
    name: 'Spotify',
    color: '#1DB954',
    description: 'Live currently playing & recently played tracks via Spotify OAuth.',
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube Music',
    color: '#FF0033',
    description: 'Recently played & liked tracks from YouTube Music via Google OAuth.',
  },
};
