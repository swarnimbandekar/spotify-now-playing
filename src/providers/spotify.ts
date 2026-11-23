import axios from 'axios';
import { saveUser } from '../storage';
import { NowPlayingData, UserData } from '../types';

const getServerSpotifyCreds = () => ({
  clientId: process.env.SPOTIFY_CLIENT_ID || '',
  clientSecret: process.env.SPOTIFY_SECRET_ID || '',
});

const normalizeSpotifyTrack = (
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

const extractFallback = (lastPlayed: UserData['lastPlayed']): NowPlayingData | null => {
  if (!lastPlayed) return null;
  if ('trackName' in lastPlayed) {
    return { ...lastPlayed, provider: 'spotify', isPlaying: false, isFallback: true };
  }
  if ('item' in lastPlayed && lastPlayed.item) {
    return normalizeSpotifyTrack(lastPlayed.item, false, true);
  }
  return null;
};

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

export const refreshSpotifyToken = async (user: UserData): Promise<string> => {
  const creds = getServerSpotifyCreds();
  const clientId = user.clientId || creds.clientId;
  const clientSecret = user.clientSecret || creds.clientSecret;

  if (!user.refreshToken || !clientId || !clientSecret) {
    throw new Error('Missing Spotify refresh credentials');
  }

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.refreshToken,
    }),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const { access_token, expires_in, refresh_token } = response.data;
  const { uid, ...rest } = user;
  await saveUser(uid, {
    ...rest,
    accessToken: access_token,
    refreshToken: refresh_token || user.refreshToken,
    expiresAt: Date.now() + expires_in * 1000,
  });

  return access_token;
};

export const getSpotifyNowPlaying = async (user: UserData): Promise<NowPlayingData | null> => {
  let accessToken = user.accessToken;
  if (!accessToken) return null;

  if (user.expiresAt && Date.now() > user.expiresAt - 60_000) {
    accessToken = await refreshSpotifyToken(user);
    user.accessToken = accessToken;
  }

  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 204 || response.status > 400 || !response.data || !response.data.item) {
      const dbFallback = extractFallback(user.lastPlayed);
      if (dbFallback) return dbFallback;

      try {
        const recentResponse = await axios.get('https://api.spotify.com/v1/me/player/recently-played?limit=1', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const recentTrack = recentResponse.data?.items?.[0]?.track;
        if (recentTrack) {
          const fallbackData = normalizeSpotifyTrack(recentTrack, false, true);
          const { uid, ...rest } = user;
          await saveUser(uid, { ...rest, lastPlayed: fallbackData }).catch((err) =>
            console.error('Error saving Spotify recently played fallback:', err)
          );
          return fallbackData;
        }
      } catch (e) {
        console.error('Error fetching Spotify recently played as fallback:', e);
      }

      return null;
    }

    const data = normalizeSpotifyTrack(response.data.item, Boolean(response.data.is_playing), false);
    const { uid, ...rest } = user;
    await saveUser(uid, { ...rest, lastPlayed: data }).catch((err) =>
      console.error('Error saving Spotify lastPlayed:', err)
    );
    return data;
  } catch (error) {
    console.error('Error fetching Spotify now playing:', error);
    return extractFallback(user.lastPlayed);
  }
};
