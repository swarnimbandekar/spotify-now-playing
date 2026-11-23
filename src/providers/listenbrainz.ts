import axios from 'axios';
import { NowPlayingData, UserData } from '../types';

const LB_API_BASE = 'https://api.listenbrainz.org/1';

const buildListenData = (listen: any, isPlaying: boolean): NowPlayingData | null => {
  const meta = listen?.track_metadata;
  if (!meta?.track_name) return null;

  const releaseMbid = meta.mbid_mapping?.release_mbid || meta.additional_info?.release_mbid;
  const recordingMbid = meta.mbid_mapping?.recording_mbid || meta.additional_info?.recording_mbid;

  return {
    provider: 'listenbrainz',
    trackName: meta.track_name,
    artistName: meta.artist_name || 'Unknown Artist',
    albumArtUrl: releaseMbid ? `https://coverartarchive.org/release/${releaseMbid}/front-250` : null,
    trackUrl: recordingMbid ? `https://musicbrainz.org/recording/${recordingMbid}` : null,
    isPlaying,
    isFallback: !isPlaying,
  };
};

export const validateListenBrainzUser = async (username: string) => {
  const response = await axios.get(`${LB_API_BASE}/user/${encodeURIComponent(username)}/playing-now`);
  if (!response.data?.payload) {
    throw new Error('ListenBrainz user not found');
  }
  return {
    username: (response.data.payload.user_id || username) as string,
    displayName: (response.data.payload.user_id || username) as string,
  };
};

export const getListenBrainzNowPlaying = async (user: UserData): Promise<NowPlayingData | null> => {
  const username = user.username || user.providerUserId;
  if (!username) return null;

  try {
    const playingNowRes = await axios.get(`${LB_API_BASE}/user/${encodeURIComponent(username)}/playing-now`);
    const activeListen = playingNowRes.data?.payload?.listens?.[0];
    if (activeListen) {
      const parsed = buildListenData(activeListen, true);
      if (parsed) return parsed;
    }

    const recentRes = await axios.get(`${LB_API_BASE}/user/${encodeURIComponent(username)}/listens`, {
      params: { count: 1 },
    });
    const recentListen = recentRes.data?.payload?.listens?.[0];
    if (recentListen) {
      return buildListenData(recentListen, false);
    }

    return null;
  } catch (error) {
    console.error('Error fetching ListenBrainz now playing:', error);
    return null;
  }
};
