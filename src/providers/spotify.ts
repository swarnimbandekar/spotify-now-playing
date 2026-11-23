import axios from 'axios';
import { updateProviderConnection } from '../storage';
import { NowPlayingData, ProviderConnection } from '../types';

const getServerSpotifyCreds = () => ({
  clientId: process.env.SPOTIFY_CLIENT_ID || '',
  clientSecret: process.env.SPOTIFY_SECRET_ID || '',
});

export const normalizeSpotifyTrack = (
  item: any,
  isPlaying: boolean,
  isFallback: boolean
): NowPlayingData => ({
  provider: 'spotify',
  trackName: item.name,
  artistName: Array.isArray(item.artists) ? item.artists.map((a: any) => a.name).join(', ') : '',
  albumArtUrl: item.album?.images?.[0]?.url || null,
  trackUrl: item.external_urls?.spotify || null,
  isPlaying,
  isFallback,
});

export const getSpotifyAuthUrl = (state: string, redirectUri: string, clientId?: string) => {
  const resolvedClientId = clientId || getServerSpotifyCreds().clientId;
  const scope = 'user-read-currently-playing user-read-playback-state user-read-private user-read-recently-played';
  return `https://accounts.spotify.com/authorize?response_type=code&client_id=${encodeURIComponent(
    resolvedClientId
  )}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
};

export const getSpotifyTokens = async (
  code: string,
  redirectUri: string,
  clientId?: string,
  clientSecret?: string
) => {
  const creds = getServerSpotifyCreds();
  const resolvedClientId = clientId || creds.clientId;
  const resolvedClientSecret = clientSecret || creds.clientSecret;

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${resolvedClientId}:${resolvedClientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  return response.data;
};

export const getSpotifyProfile = async (accessToken: string) => {
  const response = await axios.get('https://api.spotify.com/v1/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return response.data;
};

export const refreshSpotifyToken = async (uid: string, conn: ProviderConnection): Promise<string> => {
  const creds = getServerSpotifyCreds();
  const clientId = conn.clientId || creds.clientId;
  const clientSecret = conn.clientSecret || creds.clientSecret;

  if (!conn.refreshToken || !clientId || !clientSecret) {
    throw new Error('Missing Spotify refresh credentials');
  }

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: conn.refreshToken,
    }),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const { access_token, expires_in, refresh_token } = response.data;
  const expiresAt = Date.now() + expires_in * 1000;
  const updatedRefresh = refresh_token || conn.refreshToken;

  conn.accessToken = access_token;
  conn.refreshToken = updatedRefresh;
  conn.expiresAt = expiresAt;

  await updateProviderConnection(uid, 'spotify', {
    ...conn,
    accessToken: access_token,
    refreshToken: updatedRefresh,
    expiresAt,
  });

  return access_token;
};

export interface ProviderFetchResult {
  data: NowPlayingData | null;
  lastActiveAt: number;
}

export const getSpotifyNowPlaying = async (
  uid: string,
  conn: ProviderConnection
): Promise<ProviderFetchResult> => {
  let accessToken = conn.accessToken;
  let lastActiveAt = conn.lastActiveAt || 0;
  if (!accessToken) return { data: null, lastActiveAt };

  if (conn.expiresAt && Date.now() > conn.expiresAt - 60_000) {
    try {
      accessToken = await refreshSpotifyToken(uid, conn);
    } catch (err) {
      console.error('Error refreshing Spotify token:', err);
      const fb = conn.lastPlayed
        ? { ...conn.lastPlayed, provider: 'spotify' as const, isPlaying: false, isFallback: true }
        : null;
      return { data: fb, lastActiveAt };
    }
  }

  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 6000,
    });

    if (response.status === 204 || response.status > 400 || !response.data || !response.data.item) {
      if (conn.lastPlayed) {
        return {
          data: { ...conn.lastPlayed, provider: 'spotify', isPlaying: false, isFallback: true },
          lastActiveAt,
        };
      }

      try {
        const recentResponse = await axios.get('https://api.spotify.com/v1/me/player/recently-played?limit=1', {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 6000,
        });
        const recentItem = recentResponse.data?.items?.[0];
        if (recentItem?.track) {
          const fallbackData = normalizeSpotifyTrack(recentItem.track, false, true);
          const playedAtMs = recentItem.played_at ? Date.parse(recentItem.played_at) : Date.now();
          lastActiveAt = Number.isNaN(playedAtMs) ? lastActiveAt : Math.max(lastActiveAt, playedAtMs);
          await updateProviderConnection(uid, 'spotify', {
            ...conn,
            lastPlayed: fallbackData,
            lastActiveAt,
          }).catch((err) => console.error('Error saving Spotify recently played fallback:', err));
          return { data: fallbackData, lastActiveAt };
        }
      } catch (e) {
        console.error('Error fetching Spotify recently played as fallback:', e);
      }

      return { data: null, lastActiveAt };
    }

    const isPlaying = Boolean(response.data.is_playing);
    const data = normalizeSpotifyTrack(response.data.item, isPlaying, !isPlaying);
    if (isPlaying) {
      lastActiveAt = Date.now();
    }
    await updateProviderConnection(uid, 'spotify', {
      ...conn,
      lastPlayed: { ...data, isPlaying: false, isFallback: true },
      lastActiveAt,
    }).catch((err) => console.error('Error saving Spotify lastPlayed:', err));
    return { data, lastActiveAt };
  } catch (error) {
    console.error('Error fetching Spotify now playing:', error);
    const fb = conn.lastPlayed
      ? { ...conn.lastPlayed, provider: 'spotify' as const, isPlaying: false, isFallback: true }
      : null;
    return { data: fb, lastActiveAt };
  }
};
