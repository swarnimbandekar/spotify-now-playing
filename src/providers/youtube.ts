import axios from 'axios';
import { updateProviderConnection } from '../storage';
import { NowPlayingData, ProviderConnection } from '../types';
import { ProviderFetchResult } from './spotify';

const getServerYouTubeCreds = () => ({
  clientId: process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
});

const cleanChannelName = (name: string) => name.replace(/\s*-\s*Topic$/i, '').trim();

const pickBestThumbnail = (thumbnails: any): string | null => {
  if (!thumbnails) return null;
  if (Array.isArray(thumbnails)) {
    const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0]?.url || null;
  }
  return (
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.standard?.url ||
    thumbnails.default?.url ||
    null
  );
};

export const getYouTubeAuthUrl = (state: string, redirectUri: string, clientId?: string) => {
  const resolvedClientId = clientId || getServerYouTubeCreds().clientId;
  const params = new URLSearchParams({
    client_id: resolvedClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/userinfo.profile',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};

export const getYouTubeTokens = async (
  code: string,
  redirectUri: string,
  clientId?: string,
  clientSecret?: string
) => {
  const creds = getServerYouTubeCreds();
  const resolvedClientId = clientId || creds.clientId;
  const resolvedClientSecret = clientSecret || creds.clientSecret;

  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      code,
      client_id: resolvedClientId,
      client_secret: resolvedClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return response.data;
};

export const getYouTubeProfile = async (accessToken: string) => {
  try {
    const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: true },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const channel = channelRes.data?.items?.[0];
    if (channel) {
      return {
        id: channel.id as string,
        displayName: (channel.snippet?.title || channel.id) as string,
      };
    }
  } catch {
    // Fall back to Google userinfo if no YouTube channel exists yet
  }

  const userInfoRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return {
    id: String(userInfoRes.data.id),
    displayName: (userInfoRes.data.name || userInfoRes.data.id) as string,
  };
};

export const refreshYouTubeToken = async (uid: string, conn: ProviderConnection): Promise<string> => {
  const creds = getServerYouTubeCreds();
  const clientId = conn.clientId || creds.clientId;
  const clientSecret = conn.clientSecret || creds.clientSecret;

  if (!conn.refreshToken || !clientId || !clientSecret) {
    throw new Error('Missing YouTube Music refresh credentials');
  }

  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: conn.refreshToken,
      grant_type: 'refresh_token',
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const { access_token, expires_in, refresh_token } = response.data;
  const expiresAt = Date.now() + expires_in * 1000;
  await updateProviderConnection(uid, 'youtube', {
    accessToken: access_token,
    refreshToken: refresh_token || conn.refreshToken,
    expiresAt,
  });

  return access_token;
};

const fetchInnerTubeHistory = async (accessToken: string): Promise<NowPlayingData | null> => {
  const response = await axios.post(
    'https://music.youtube.com/youtubei/v1/browse',
    {
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20250101.01.00',
          hl: 'en',
        },
      },
      browseId: 'FEmusic_history',
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Origin: 'https://music.youtube.com',
        Referer: 'https://music.youtube.com/',
      },
      timeout: 6000,
    }
  );

  const sections =
    response.data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents;

  if (!Array.isArray(sections)) return null;

  for (const section of sections) {
    const items = section?.musicShelfRenderer?.contents;
    if (!Array.isArray(items) || items.length === 0) continue;

    const renderer = items[0]?.musicResponsiveListItemRenderer;
    if (!renderer) continue;

    const flexColumns = renderer.flexColumns || [];
    const trackName =
      flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
    const artistRuns =
      flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const artistName =
      artistRuns
        .map((r: any) => r.text)
        .filter((t: string) => t && t.trim() !== '•' && t.trim() !== '&')
        .slice(0, 1)
        .join(', ') || 'YouTube Music';

    const videoId =
      renderer.playlistItemData?.videoId ||
      renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
        ?.playNavigationEndpoint?.watchEndpoint?.videoId;

    const albumArtUrl = pickBestThumbnail(
      renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
    );

    if (trackName) {
      return {
        provider: 'youtube',
        trackName,
        artistName,
        albumArtUrl,
        trackUrl: videoId ? `https://music.youtube.com/watch?v=${videoId}` : 'https://music.youtube.com',
        isPlaying: false,
        isFallback: true,
      };
    }
  }

  return null;
};

const fetchLikedMusicFallback = async (accessToken: string): Promise<NowPlayingData | null> => {
  try {
    const lmRes = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
      params: { part: 'snippet', playlistId: 'LM', maxResults: 1 },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 6000,
    });
    const item = lmRes.data?.items?.[0]?.snippet;
    if (item?.title) {
      const videoId = item.resourceId?.videoId;
      return {
        provider: 'youtube',
        trackName: item.title,
        artistName: cleanChannelName(item.videoOwnerChannelTitle || item.channelTitle || 'YouTube Music'),
        albumArtUrl: pickBestThumbnail(item.thumbnails),
        trackUrl: videoId ? `https://music.youtube.com/watch?v=${videoId}` : 'https://music.youtube.com',
        isPlaying: false,
        isFallback: true,
      };
    }
  } catch {
    // Fall through to general liked videos
  }

  const likeRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
    params: { part: 'snippet', myRating: 'like', maxResults: 1 },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 6000,
  });
  const video = likeRes.data?.items?.[0];
  if (!video?.snippet?.title) return null;

  return {
    provider: 'youtube',
    trackName: video.snippet.title,
    artistName: cleanChannelName(video.snippet.channelTitle || 'YouTube Music'),
    albumArtUrl: pickBestThumbnail(video.snippet.thumbnails),
    trackUrl: `https://music.youtube.com/watch?v=${video.id}`,
    isPlaying: false,
    isFallback: true,
  };
};

export const getYouTubeNowPlaying = async (
  uid: string,
  conn: ProviderConnection
): Promise<ProviderFetchResult> => {
  let accessToken = conn.accessToken;
  let lastActiveAt = conn.lastActiveAt || 0;
  if (!accessToken) return { data: null, lastActiveAt };

  if (conn.expiresAt && Date.now() > conn.expiresAt - 60_000) {
    try {
      accessToken = await refreshYouTubeToken(uid, conn);
    } catch (err) {
      console.error('Error refreshing YouTube Music token:', err);
      const fb = conn.lastPlayed
        ? { ...conn.lastPlayed, provider: 'youtube' as const, isPlaying: false, isFallback: true }
        : null;
      return { data: fb, lastActiveAt };
    }
  }

  try {
    let data: NowPlayingData | null = null;

    try {
      data = await fetchInnerTubeHistory(accessToken);
    } catch {
      // InnerTube may reject web OAuth clients; fall back to official YouTube Data API v3
    }

    if (!data) {
      data = await fetchLikedMusicFallback(accessToken);
    }

    if (data) {
      const prev = conn.lastPlayed;
      const trackChanged =
        !prev || prev.trackName !== data.trackName || prev.artistName !== data.artistName;

      if (trackChanged) {
        lastActiveAt = Date.now();
      }

      // If a brand-new track appeared in YT Music history within the last 4 minutes, treat it as actively playing
      const isRecentlyChanged = lastActiveAt > 0 && Date.now() - lastActiveAt < 4 * 60 * 1000;
      const resolvedData: NowPlayingData = {
        ...data,
        isPlaying: isRecentlyChanged,
        isFallback: !isRecentlyChanged,
      };

      if (trackChanged) {
        await updateProviderConnection(uid, 'youtube', {
          lastPlayed: data,
          lastActiveAt,
        }).catch((err) => console.error('Error saving YouTube Music lastPlayed:', err));
      }

      return { data: resolvedData, lastActiveAt };
    }

    const fb = conn.lastPlayed
      ? { ...conn.lastPlayed, provider: 'youtube' as const, isPlaying: false, isFallback: true }
      : null;
    return { data: fb, lastActiveAt };
  } catch (error) {
    console.error('Error fetching YouTube Music track:', error);
    const fb = conn.lastPlayed
      ? { ...conn.lastPlayed, provider: 'youtube' as const, isPlaying: false, isFallback: true }
      : null;
    return { data: fb, lastActiveAt };
  }
};
