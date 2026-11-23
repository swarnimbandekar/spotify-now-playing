export type ProviderId = 'spotify';

export interface NowPlayingData {
  provider: ProviderId;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  trackUrl: string | null;
  isPlaying: boolean;
  isFallback: boolean;
}

export interface ProviderConnection {
  providerUserId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId?: string;
  clientSecret?: string;
  lastPlayed?: NowPlayingData;
  lastActiveAt?: number;
}

export interface UserData {
  uid: string;
  displayName: string;
  providers?: {
    spotify?: ProviderConnection;
  };
  // Legacy single-provider fields (preserved for backward compatibility)
  provider?: ProviderId;
  providerUserId?: string;
  spotifyId?: string;
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
};
