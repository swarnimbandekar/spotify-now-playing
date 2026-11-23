import axios from 'axios';
import crypto from 'crypto';
import { saveUser } from '../storage';
import { NowPlayingData, UserData } from '../types';

const SUBSONIC_API_VERSION = '1.16.1';
const SUBSONIC_CLIENT_NAME = 'now-playing';

export const normalizeServerUrl = (url: string) => {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
};

export const createSubsonicAuth = (password: string) => {
  const salt = crypto.randomBytes(8).toString('hex');
  const token = crypto.createHash('md5').update(`${password}${salt}`).digest('hex');
  return { salt, token };
};

export const validateSubsonicUser = async (rawServerUrl: string, username: string, password: string) => {
  const serverUrl = normalizeServerUrl(rawServerUrl);
  const { salt, token } = createSubsonicAuth(password);

  const response = await axios.get(`${serverUrl}/rest/ping.view`, {
    params: {
      u: username,
      t: token,
      s: salt,
      v: SUBSONIC_API_VERSION,
      c: SUBSONIC_CLIENT_NAME,
      f: 'json',
    },
    timeout: 8000,
  });

  const subsonicRes = response.data?.['subsonic-response'];
  if (!subsonicRes || subsonicRes.status !== 'ok') {
    throw new Error(subsonicRes?.error?.message || 'Subsonic authentication failed');
  }

  return {
    serverUrl,
    username,
    subsonicToken: token,
    subsonicSalt: salt,
  };
};

export const getSubsonicNowPlaying = async (user: UserData): Promise<NowPlayingData | null> => {
  const { serverUrl, username, subsonicToken, subsonicSalt } = user;
  if (!serverUrl || !username || !subsonicToken || !subsonicSalt) return null;

  try {
    const response = await axios.get(`${serverUrl}/rest/getNowPlaying.view`, {
      params: {
        u: username,
        t: subsonicToken,
        s: subsonicSalt,
        v: SUBSONIC_API_VERSION,
        c: SUBSONIC_CLIENT_NAME,
        f: 'json',
      },
      timeout: 8000,
    });

    const entries = response.data?.['subsonic-response']?.nowPlaying?.entry;
    const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
    const entry =
      list.find((item: any) => item.username?.toLowerCase() === username.toLowerCase()) || list[0];

    if (!entry) {
      if (user.lastPlayed && 'trackName' in user.lastPlayed) {
        return { ...user.lastPlayed, provider: 'subsonic', isPlaying: false, isFallback: true };
      }
      return null;
    }

    const coverArtUrl = entry.coverArt
      ? `${serverUrl}/rest/getCoverArt.view?id=${encodeURIComponent(
          entry.coverArt
        )}&size=256&u=${encodeURIComponent(username)}&t=${subsonicToken}&s=${subsonicSalt}&v=${SUBSONIC_API_VERSION}&c=${SUBSONIC_CLIENT_NAME}`
      : null;

    const data: NowPlayingData = {
      provider: 'subsonic',
      trackName: entry.title || 'Unknown Track',
      artistName: entry.artist || 'Unknown Artist',
      albumArtUrl: coverArtUrl,
      trackUrl: serverUrl,
      isPlaying: true,
      isFallback: false,
    };

    const { uid, ...rest } = user;
    await saveUser(uid, { ...rest, lastPlayed: data }).catch((err) =>
      console.error('Error saving Subsonic lastPlayed:', err)
    );

    return data;
  } catch (error) {
    console.error('Error fetching Subsonic now playing:', error);
    if (user.lastPlayed && 'trackName' in user.lastPlayed) {
      return { ...user.lastPlayed, provider: 'subsonic', isPlaying: false, isFallback: true };
    }
    return null;
  }
};
