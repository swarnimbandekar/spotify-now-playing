import axios from 'axios';
import NodeCache from 'node-cache';
import { getUser } from '../storage';
import { NowPlayingData, ProviderId, UserData } from '../types';
import { getSpotifyNowPlaying } from './spotify';
import { getLastFmNowPlaying } from './lastfm';
import { getListenBrainzNowPlaying } from './listenbrainz';
import { getDeezerNowPlaying } from './deezer';
import { getSubsonicNowPlaying } from './subsonic';

const cache = new NodeCache({ stdTTL: 30 }); // Cache for 30 seconds

export const resolveProvider = (user: UserData): ProviderId => {
  return user.provider || 'spotify';
};

export const invalidateCache = (uid: string) => {
  cache.del(uid);
};

export const getNowPlaying = async (uid: string): Promise<NowPlayingData | null> => {
  const cachedData = cache.get<NowPlayingData | null>(uid);
  if (cachedData !== undefined) return cachedData;

  const user = await getUser(uid);
  if (!user) return null;

  const provider = resolveProvider(user);
  let data: NowPlayingData | null = null;

  switch (provider) {
    case 'spotify':
      data = await getSpotifyNowPlaying(user);
      break;
    case 'lastfm':
      data = await getLastFmNowPlaying(user);
      break;
    case 'listenbrainz':
      data = await getListenBrainzNowPlaying(user);
      break;
    case 'deezer':
      data = await getDeezerNowPlaying(user);
      break;
    case 'subsonic':
      data = await getSubsonicNowPlaying(user);
      break;
    default:
      data = null;
  }

  cache.set(uid, data);
  return data;
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
