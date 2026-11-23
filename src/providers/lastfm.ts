import axios from 'axios';
import { NowPlayingData, UserData } from '../types';

const LASTFM_API_BASE = 'https://ws.audioscrobbler.com/2.0/';

const resolveApiKey = (userApiKey?: string) => userApiKey || process.env.LASTFM_API_KEY || '';

const pickImage = (images: any): string | null => {
  if (!Array.isArray(images)) return null;
  const order = ['extralarge', 'large', 'medium', 'small'];
  for (const size of order) {
    const match = images.find((img: any) => img?.size === size && img['#text']);
    if (match) return match['#text'];
  }
  const anyImg = images.find((img: any) => img?.['#text']);
  return anyImg ? anyImg['#text'] : null;
};

export const validateLastFmUser = async (username: string, userApiKey?: string) => {
  const apiKey = resolveApiKey(userApiKey);
  if (!apiKey) {
    throw new Error('Last.fm API Key is required (none configured on server).');
  }

  const response = await axios.get(LASTFM_API_BASE, {
    params: {
      method: 'user.getinfo',
      user: username,
      api_key: apiKey,
      format: 'json',
    },
  });

  if (response.data?.error || !response.data?.user) {
    throw new Error(response.data?.message || 'Last.fm user not found');
  }

  return {
    username: response.data.user.name as string,
    displayName: (response.data.user.realname || response.data.user.name) as string,
  };
};

export const getLastFmNowPlaying = async (user: UserData): Promise<NowPlayingData | null> => {
  const username = user.username || user.providerUserId;
  const apiKey = resolveApiKey(user.apiKey);
  if (!username || !apiKey) return null;

  try {
    const response = await axios.get(LASTFM_API_BASE, {
      params: {
        method: 'user.getrecenttracks',
        user: username,
        api_key: apiKey,
        format: 'json',
        limit: 1,
      },
    });

    const tracks = response.data?.recenttracks?.track;
    const track = Array.isArray(tracks) ? tracks[0] : tracks;
    if (!track || !track.name) return null;

    const isPlaying = track['@attr']?.nowplaying === 'true';
    return {
      provider: 'lastfm',
      trackName: track.name,
      artistName: track.artist?.['#text'] || track.artist?.name || 'Unknown Artist',
      albumArtUrl: pickImage(track.image),
      trackUrl: track.url || null,
      isPlaying,
      isFallback: !isPlaying,
    };
  } catch (error) {
    console.error('Error fetching Last.fm now playing:', error);
    return null;
  }
};
