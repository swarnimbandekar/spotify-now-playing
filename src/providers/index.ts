import axios from 'axios';
import NodeCache from 'node-cache';
import { getUser } from '../storage';
import { NowPlayingData, ProviderConnection, ProviderId, UserData } from '../types';
import { getSpotifyNowPlaying, normalizeSpotifyTrack } from './spotify';

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

  return connections;
};

export const invalidateCache = (uid: string) => {
  cache.del(uid);
};

export const getNowPlaying = async (uid: string): Promise<NowPlayingData | null> => {
  const cachedData = cache.get<NowPlayingData | null>(uid);
  if (cachedData !== undefined) return cachedData;

  const user = await getUser(uid);
  if (!user) return null;

  const connections = getUserConnections(user);
  if (!connections.spotify) {
    cache.set(uid, null);
    return null;
  }

  const result = await getSpotifyNowPlaying(uid, connections.spotify);
  cache.set(uid, result.data);
  return result.data;
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
