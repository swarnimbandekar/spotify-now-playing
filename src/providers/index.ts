import axios from 'axios';
import NodeCache from 'node-cache';
import { getUser } from '../storage';
import { NowPlayingData, ProviderConnection, ProviderId, UserData } from '../types';
import { getSpotifyNowPlaying, normalizeSpotifyTrack, ProviderFetchResult } from './spotify';
import { getYouTubeNowPlaying } from './youtube';

const cache = new NodeCache({ stdTTL: 30 }); // Cache for 30 seconds

export const getUserConnections = (
  user: UserData | null
): Partial<Record<ProviderId, ProviderConnection>> => {
  if (!user) return {};

  const connections: Partial<Record<ProviderId, ProviderConnection>> = {};

  if (user.providers?.spotify?.accessToken) {
    connections.spotify = user.providers.spotify;
  } else if (user.accessToken && (!user.provider || user.provider === 'spotify')) {
    // Legacy single-provider Spotify user
    let legacyLastPlayed: NowPlayingData | undefined;
    if (user.lastPlayed) {
      if ('trackName' in user.lastPlayed) {
        legacyLastPlayed = user.lastPlayed;
      } else if ('item' in user.lastPlayed && user.lastPlayed.item) {
        legacyLastPlayed = normalizeSpotifyTrack(user.lastPlayed.item, false, true);
      }
    }
    connections.spotify = {
      providerUserId: user.providerUserId || user.spotifyId || '',
      displayName: user.displayName,
      accessToken: user.accessToken,
      refreshToken: user.refreshToken || '',
      expiresAt: user.expiresAt || 0,
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      lastPlayed: legacyLastPlayed,
    };
  }

  if (user.providers?.youtube?.accessToken) {
    connections.youtube = user.providers.youtube;
  } else if (user.accessToken && user.provider === 'youtube') {
    connections.youtube = {
      providerUserId: user.providerUserId || '',
      displayName: user.displayName,
      accessToken: user.accessToken,
      refreshToken: user.refreshToken || '',
      expiresAt: user.expiresAt || 0,
      clientId: user.clientId,
      clientSecret: user.clientSecret,
      lastPlayed: user.lastPlayed && 'trackName' in user.lastPlayed ? user.lastPlayed : undefined,
    };
  }

  return connections;
};

export const invalidateCache = (uid: string) => {
  cache.del(uid);
};

/**
 * Picks the single best track to display when one or both providers are connected:
 * 1. Real-time active playback on Spotify wins if Spotify is actively playing
 *    (unless YouTube Music detected an even newer track change while Spotify is not playing).
 * 2. If only one provider is actively playing, show that one.
 * 3. If both are actively playing or both are idle/fallback, show whichever had the most recent activity.
 */
const pickActiveTrack = (results: ProviderFetchResult[]): NowPlayingData | null => {
  const valid = results.filter((r): r is { data: NowPlayingData; lastActiveAt: number } => Boolean(r.data));
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0].data;

  const playing = valid.filter((r) => r.data.isPlaying);
  if (playing.length === 1) {
    return playing[0].data;
  }

  const pool = playing.length > 1 ? playing : valid;
  // Prefer Spotify on exact timestamp tie since Spotify has true live playback state
  pool.sort((a, b) => {
    if (b.lastActiveAt !== a.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
    if (a.data.provider === 'spotify') return -1;
    if (b.data.provider === 'spotify') return 1;
    return 0;
  });

  return pool[0].data;
};

export const getNowPlaying = async (uid: string): Promise<NowPlayingData | null> => {
  const cachedData = cache.get<NowPlayingData | null>(uid);
  if (cachedData !== undefined) return cachedData;

  const user = await getUser(uid);
  if (!user) return null;

  const connections = getUserConnections(user);
  const tasks: Promise<ProviderFetchResult>[] = [];

  if (connections.spotify) {
    tasks.push(getSpotifyNowPlaying(uid, connections.spotify));
  }
  if (connections.youtube) {
    tasks.push(getYouTubeNowPlaying(uid, connections.youtube));
  }

  if (tasks.length === 0) {
    cache.set(uid, null);
    return null;
  }

  const settled = await Promise.allSettled(tasks);
  const results: ProviderFetchResult[] = settled
    .filter((r): r is PromiseFulfilledResult<ProviderFetchResult> => r.status === 'fulfilled')
    .map((r) => r.value);

  const chosen = pickActiveTrack(results);
  cache.set(uid, chosen);
  return chosen;
};

export const getImageBase64 = async (url: string): Promise<string | null> => {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 6000 });
    const buffer = Buffer.from(response.data, 'binary');
    const mimeType = response.headers['content-type'] || 'image/jpeg';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (error) {
    console.error('Error fetching image for base64 conversion:', error);
    return null;
  }
};
