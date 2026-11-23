import axios from 'axios';
import { saveUser } from '../storage';
import { NowPlayingData, UserData } from '../types';

export const getDeezerAuthUrl = (state: string, clientId: string, redirectUri: string) => {
  return `https://connect.deezer.com/oauth/auth.php?app_id=${encodeURIComponent(
    clientId
  )}&redirect_uri=${encodeURIComponent(redirectUri)}&perms=listening_history,offline_access,basic_access&state=${state}`;
};

export const getDeezerTokens = async (code: string, clientId: string, clientSecret: string) => {
  const response = await axios.get('https://connect.deezer.com/oauth/access_token.php', {
    params: {
      app_id: clientId,
      secret: clientSecret,
      code,
      output: 'json',
    },
  });

  if (!response.data?.access_token) {
    throw new Error('Failed to obtain Deezer access token');
  }
  return response.data;
};

export const getDeezerProfile = async (accessToken: string) => {
  const response = await axios.get('https://api.deezer.com/user/me', {
    params: { access_token: accessToken },
  });
  if (response.data?.error) {
    throw new Error(response.data.error.message || 'Failed to fetch Deezer profile');
  }
  return response.data;
};

export const getDeezerNowPlaying = async (user: UserData): Promise<NowPlayingData | null> => {
  if (!user.accessToken) return null;

  try {
    const response = await axios.get('https://api.deezer.com/user/me/history', {
      params: {
        access_token: user.accessToken,
        limit: 1,
      },
    });

    const track = response.data?.data?.[0];
    if (!track) {
      if (user.lastPlayed && 'trackName' in user.lastPlayed) {
        return { ...user.lastPlayed, provider: 'deezer', isPlaying: false, isFallback: true };
      }
      return null;
    }

    // Deezer has no live currently-playing endpoint; infer from latest history timestamp + duration
    const nowSec = Math.floor(Date.now() / 1000);
    const isPlaying = Boolean(track.timestamp && track.duration && track.timestamp + track.duration > nowSec);

    const data: NowPlayingData = {
      provider: 'deezer',
      trackName: track.title,
      artistName: track.artist?.name || 'Unknown Artist',
      albumArtUrl: track.album?.cover_medium || track.album?.cover || null,
      trackUrl: track.link || null,
      isPlaying,
      isFallback: !isPlaying,
    };

    const { uid, ...rest } = user;
    await saveUser(uid, { ...rest, lastPlayed: data }).catch((err) =>
      console.error('Error saving Deezer lastPlayed:', err)
    );

    return data;
  } catch (error) {
    console.error('Error fetching Deezer now playing:', error);
    if (user.lastPlayed && 'trackName' in user.lastPlayed) {
      return { ...user.lastPlayed, provider: 'deezer', isPlaying: false, isFallback: true };
    }
    return null;
  }
};
