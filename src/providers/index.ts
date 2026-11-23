import axios from 'axios';
import NodeCache from 'node-cache';
import { getUser } from '../storage';
import { NowPlayingData, ProviderConnection, ProviderId, UserData } from '../types';
import { getSpotifyNowPlaying, normalizeSpotifyTrack, ProviderFetchResult } from './spotify';
import { getYouTubeNowPlaying } from './youtube';

const cache = new NodeCache({ stdTTL: 30 }); // Cache for 30 seconds

const stripUndefined = <T extends Record<string, any>>(obj?: T): Partial<T> => {
  if (!obj) return {};
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned as Partial<T>;
};

export const getUserConnections = (
  user: UserData | null
): Partial<Record<ProviderId, ProviderConnection>> => {
  if (!user) return {};

  const connections: Partial<Record<ProviderId, ProviderConnection>> = {};

  // Merge legacy top-level Spotify fields with nested providers.spotify (nested takes precedence)
  let legacySpotify: Partial<ProviderConnection> | undefined;
  if (user.accessToken && (!user.provider || user.provider === 'spotify')) {
    let legacyLastPlayed: NowPlayingData | undefined;
    if (user.lastPlayed) {
      if ('trackName' in user.lastPlayed) {
        legacyLastPlayed = user.lastPlayed;
      } else if ('item' in user.lastPlayed && user.lastPlayed.item) {
        legacyLastPlayed = normalizeSpotifyTrack(user.lastPlayed.item, false, true);
      }
    }
    legacySpotify = {
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

  const nestedSpotify = stripUndefined(user.providers?.spotify);
  if (nestedSpotify.accessToken || legacySpotify?.accessToken) {
    connections.spotify = {
      providerUserId: '',
      displayName: user.displayName || '',
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      ...stripUndefined(legacySpotify),
      ...nestedSpotify,
    } as ProviderConnection;
  }

  // Merge legacy top-level YouTube fields with nested providers.youtube (nested takes precedence)
  let legacyYoutube: Partial<ProviderConnection> | undefined;
  if (user.accessToken && user.provider === 'youtube') {
    legacyYoutube = {
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

  const nestedYoutube = stripUndefined(user.providers?.youtube);
  if (nestedYoutube.accessToken || legacyYoutube?.accessToken) {
    connections.youtube = {
      providerUserId: '',
      displayName: user.displayName || '',
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      ...stripUndefined(legacyYoutube),
      ...nestedYoutube,
    } as ProviderConnection;
  }

  return connections;
};

export const invalidateCache = (uid: string) => {
  cache.del(uid);
};

/**
 * Picks the single best track to display when one or both providers are connected:
 * 1. If only one player is actively playing, show that player.
 * 2. If both are actively playing or both are idle/fallback, show whichever had the most recent activity.
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
