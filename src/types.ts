export type ProviderId = 'spotify' | 'lastfm' | 'listenbrainz' | 'deezer' | 'subsonic';

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
  // OAuth fields (Spotify, Deezer)
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  // Username-based fields (Last.fm, ListenBrainz, Subsonic)
  username?: string;
  apiKey?: string;
  // Subsonic / Navidrome fields
  serverUrl?: string;
  subsonicToken?: string;
  subsonicSalt?: string;
  // Cached last played track (supports normalized NowPlayingData or legacy Spotify { item })
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
    description: 'Direct OAuth integration using your own Spotify App credentials.',
  },
  lastfm: {
    id: 'lastfm',
    name: 'Last.fm',
    color: '#D51007',
    description: 'Works with Apple Music, YouTube Music, Tidal, Qobuz, SoundCloud & local players via scrobbling.',
  },
  listenbrainz: {
    id: 'listenbrainz',
    name: 'ListenBrainz',
    color: '#EB743B',
    description: 'Open-source scrobbling by MetaBrainz. Zero API keys or OAuth required.',
  },
  deezer: {
    id: 'deezer',
    name: 'Deezer',
    color: '#A238FF',
    description: 'Direct OAuth integration using your Deezer App credentials.',
  },
  subsonic: {
    id: 'subsonic',
    name: 'Navidrome / Subsonic',
    color: '#3B82F6',
    description: 'Self-hosted music servers implementing the Subsonic / OpenSubsonic API.',
  },
};
