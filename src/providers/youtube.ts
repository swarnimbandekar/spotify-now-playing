import axios from 'axios';
import NodeCache from 'node-cache';
import { updateProviderConnection } from '../storage';
import { NowPlayingData, ProviderConnection } from '../types';
import { ProviderFetchResult } from './spotify';

const visitorCache = new NodeCache({ stdTTL: 1800 }); // 30 minutes
const VISITOR_CACHE_KEY = 'ytm_visitor_data';
const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

const getServerYouTubeCreds = () => ({
  clientId: process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
});

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
  const updatedRefresh = refresh_token || conn.refreshToken;

  conn.accessToken = access_token;
  conn.refreshToken = updatedRefresh;
  conn.expiresAt = expiresAt;

  await updateProviderConnection(uid, 'youtube', {
    ...conn,
    accessToken: access_token,
    refreshToken: updatedRefresh,
    expiresAt,
  });

  return access_token;
};

const getVisitorData = async (): Promise<string> => {
  const cached = visitorCache.get<string>(VISITOR_CACHE_KEY);
  if (cached) return cached;

  try {
    const res = await fetch('https://music.youtube.com/youtubei/v1/browse?alt=json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0',
        Origin: 'https://music.youtube.com',
        Cookie: 'SOCS=CAI',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20250310.01.00',
            hl: 'en',
          },
          user: {},
        },
        browseId: 'FEmusic_home',
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const json: any = await res.json();
      const visitorData = json?.responseContext?.visitorData;
      if (typeof visitorData === 'string' && visitorData) {
        visitorCache.set(VISITOR_CACHE_KEY, visitorData);
        return visitorData;
      }
    }
  } catch (err) {
    console.error('Error fetching YouTube Music visitorData:', err);
  }

  return '';
};

const extractTextFromRuns = (runs: any[]): string => {
  if (!Array.isArray(runs)) return '';
  return runs.map((r) => r?.text || '').join('').trim();
};

const parseMusicResponsiveListItem = (renderer: any): NowPlayingData | null => {
  if (!renderer || typeof renderer !== 'object') return null;

  const flexColumns = Array.isArray(renderer.flexColumns) ? renderer.flexColumns : [];
  let titleText = '';
  let artistText = '';
  let videoId: string | undefined =
    renderer.playlistItemData?.videoId ||
    renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint?.watchEndpoint?.videoId;

  for (let i = 0; i < flexColumns.length; i++) {
    const colRuns = flexColumns[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
    if (!Array.isArray(colRuns) || colRuns.length === 0) continue;

    for (const run of colRuns) {
      const watchId = run?.navigationEndpoint?.watchEndpoint?.videoId;
      if (watchId && !videoId) {
        videoId = watchId;
      }
    }

    const firstNav = colRuns[0]?.navigationEndpoint;
    if (firstNav?.watchEndpoint && !titleText) {
      titleText = extractTextFromRuns(colRuns);
      continue;
    }

    const pageType =
      firstNav?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType;
    if (
      !artistText &&
      (pageType === 'MUSIC_PAGE_TYPE_ARTIST' ||
        pageType === 'MUSIC_PAGE_TYPE_UNKNOWN' ||
        pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL')
    ) {
      const artists = colRuns
        .map((r: any) => r?.text?.trim())
        .filter(
          (t: string) =>
            t && t !== '•' && t !== '&' && t !== ',' && !/^\d+:\d+$/.test(t)
        );
      if (artists.length > 0) {
        artistText = artists.join(', ');
      }
    }
  }

  if (!titleText) {
    titleText = extractTextFromRuns(
      flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
    );
  }
  if (!artistText) {
    const fallbackRuns = flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const firstArtist = fallbackRuns
      .map((r: any) => r?.text?.trim())
      .filter((t: string) => t && t !== '•' && t !== '&' && t !== ',' && !/^\d+:\d+$/.test(t))[0];
    artistText = firstArtist || 'YouTube Music';
  }

  if (!videoId && Array.isArray(renderer.menu?.menuRenderer?.items)) {
    for (const item of renderer.menu.menuRenderer.items) {
      const menuVideoId =
        item?.menuNavigationItemRenderer?.navigationEndpoint?.watchEndpoint?.videoId ||
        item?.menuServiceItemRenderer?.serviceEndpoint?.queueAddEndpoint?.queueTarget?.videoId;
      if (menuVideoId) {
        videoId = menuVideoId;
        break;
      }
    }
  }

  if (!titleText || titleText === 'Song deleted') return null;

  const albumArtUrl = pickBestThumbnail(
    renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
      renderer.thumbnail?.thumbnails
  );

  return {
    provider: 'youtube',
    trackName: titleText,
    artistName: artistText || 'YouTube Music',
    albumArtUrl,
    trackUrl: videoId ? `https://music.youtube.com/watch?v=${videoId}` : 'https://music.youtube.com',
    isPlaying: false,
    isFallback: true,
  };
};

const parseVideoRenderer = (renderer: any): NowPlayingData | null => {
  if (!renderer || typeof renderer !== 'object') return null;
  const trackName =
    extractTextFromRuns(renderer.title?.runs) || renderer.title?.simpleText || '';
  if (!trackName) return null;

  const artistName =
    extractTextFromRuns(renderer.ownerText?.runs) ||
    extractTextFromRuns(renderer.shortBylineText?.runs) ||
    extractTextFromRuns(renderer.longBylineText?.runs) ||
    'YouTube Music';

  const videoId = renderer.videoId || renderer.navigationEndpoint?.watchEndpoint?.videoId;
  const albumArtUrl = pickBestThumbnail(renderer.thumbnail?.thumbnails);

  return {
    provider: 'youtube',
    trackName,
    artistName,
    albumArtUrl,
    trackUrl: videoId ? `https://music.youtube.com/watch?v=${videoId}` : 'https://music.youtube.com',
    isPlaying: false,
    isFallback: true,
  };
};

const parseLockupViewModel = (vm: any): NowPlayingData | null => {
  if (!vm || typeof vm !== 'object') return null;
  const meta = vm.metadata?.lockupMetadataViewModel;
  const trackName = meta?.title?.content;
  if (!trackName) return null;

  const artistName =
    meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text
      ?.content || 'YouTube Music';
  const videoId = vm.contentId;
  const albumArtUrl = pickBestThumbnail(
    vm.contentImage?.thumbnailViewModel?.image?.sources ||
      vm.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image
        ?.sources
  );

  return {
    provider: 'youtube',
    trackName,
    artistName,
    albumArtUrl,
    trackUrl: videoId ? `https://music.youtube.com/watch?v=${videoId}` : 'https://music.youtube.com',
    isPlaying: false,
    isFallback: true,
  };
};

const extractFirstHistoryTrack = (node: any): NowPlayingData | null => {
  if (!node || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = extractFirstHistoryTrack(item);
      if (found) return found;
    }
    return null;
  }

  if (node.musicResponsiveListItemRenderer) {
    const parsed = parseMusicResponsiveListItem(node.musicResponsiveListItemRenderer);
    if (parsed) return parsed;
  }
  if (node.videoRenderer) {
    const parsed = parseVideoRenderer(node.videoRenderer);
    if (parsed) return parsed;
  }
  if (node.compactVideoRenderer) {
    const parsed = parseVideoRenderer(node.compactVideoRenderer);
    if (parsed) return parsed;
  }
  if (node.lockupViewModel) {
    const parsed = parseLockupViewModel(node.lockupViewModel);
    if (parsed) return parsed;
  }

  for (const key of Object.keys(node)) {
    if (key === 'responseContext' || key === 'trackingParams') continue;
    const val = node[key];
    if (val && typeof val === 'object') {
      const found = extractFirstHistoryTrack(val);
      if (found) return found;
    }
  }

  return null;
};

interface InnerTubeStrategy {
  url: string;
  origin: string;
  referer: string;
  userAgent: string;
  clientNameId: string;
  clientVersion: string;
  browseId: string;
  client: Record<string, any>;
}

const fetchInnerTubeHistory = async (accessToken: string): Promise<NowPlayingData | null> => {
  const visitorData = await getVisitorData();
  const requestTime = String(Math.floor(Date.now() / 1000));

  const strategies: InnerTubeStrategy[] = [
    {
      url: 'https://music.youtube.com/youtubei/v1/browse?alt=json',
      origin: 'https://music.youtube.com',
      referer: 'https://music.youtube.com/',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0',
      clientNameId: '67',
      clientVersion: '1.20250310.01.00',
      browseId: 'FEmusic_history',
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20250310.01.00',
        hl: 'en',
        ...(visitorData ? { visitorData } : {}),
      },
    },
    {
      url: 'https://music.youtube.com/youtubei/v1/browse?alt=json',
      origin: 'https://music.youtube.com',
      referer: 'https://music.youtube.com/',
      userAgent: 'com.google.android.apps.youtube.music/7.21.50 (Linux; U; Android 14; en_US) gzip',
      clientNameId: '21',
      clientVersion: '7.21.50',
      browseId: 'FEmusic_history',
      client: {
        clientName: 'ANDROID_MUSIC',
        clientVersion: '7.21.50',
        androidSdkVersion: 34,
        osName: 'Android',
        osVersion: '14',
        platform: 'MOBILE',
        hl: 'en',
        ...(visitorData ? { visitorData } : {}),
      },
    },
    {
      url: 'https://www.youtube.com/youtubei/v1/browse?alt=json',
      origin: 'https://www.youtube.com',
      referer: 'https://www.youtube.com/',
      userAgent: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)',
      clientNameId: '5',
      clientVersion: '20.11.6',
      browseId: 'FEhistory',
      client: {
        clientName: 'IOS',
        clientVersion: '20.11.6',
        deviceMake: 'Apple',
        deviceModel: 'iPhone10,4',
        osName: 'iOS',
        osVersion: '16.7.7.20H330',
        hl: 'en',
        ...(visitorData ? { visitorData } : {}),
      },
    },
  ];

  for (const strategy of strategies) {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: '*/*',
        Origin: strategy.origin,
        Referer: strategy.referer,
        Cookie: 'SOCS=CAI',
        'User-Agent': strategy.userAgent,
        'X-Goog-Request-Time': requestTime,
        'X-Youtube-Client-Name': strategy.clientNameId,
        'X-Youtube-Client-Version': strategy.clientVersion,
      };
      if (visitorData) {
        headers['X-Goog-Visitor-Id'] = visitorData;
      }

      const res = await fetch(strategy.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          context: {
            client: strategy.client,
            user: {},
          },
          browseId: strategy.browseId,
        }),
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) {
        console.warn(`YouTube history strategy ${strategy.client.clientName} returned ${res.status}`);
        continue;
      }

      const json: any = await res.json();
      const parsed = extractFirstHistoryTrack(json?.contents);
      if (parsed) {
        return parsed;
      }
    } catch (err) {
      console.warn(`YouTube history strategy ${strategy.client.clientName} failed:`, err);
    }
  }

  return null;
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
    const data = await fetchInnerTubeHistory(accessToken);

    if (data) {
      const prev = conn.lastPlayed;
      const hadPrev = Boolean(prev?.trackName);

      if (!hadPrev) {
        // Initial seed of history — never treat existing history as actively playing
        lastActiveAt = conn.lastActiveAt || 1;
        const seededData: NowPlayingData = { ...data, isPlaying: false, isFallback: true };
        await updateProviderConnection(uid, 'youtube', {
          ...conn,
          lastPlayed: seededData,
          lastActiveAt,
        }).catch((err) => console.error('Error seeding YouTube Music lastPlayed:', err));
        return { data: seededData, lastActiveAt };
      }

      const trackChanged =
        prev!.trackName !== data.trackName || prev!.artistName !== data.artistName;

      if (trackChanged) {
        lastActiveAt = Date.now();
        const savedFallback: NowPlayingData = { ...data, isPlaying: false, isFallback: true };
        await updateProviderConnection(uid, 'youtube', {
          ...conn,
          lastPlayed: savedFallback,
          lastActiveAt,
        }).catch((err) => console.error('Error saving YouTube Music lastPlayed:', err));
        return {
          data: { ...data, isPlaying: true, isFallback: false },
          lastActiveAt,
        };
      }

      const isRecentlyChanged =
        lastActiveAt > 1 && Date.now() - lastActiveAt < ACTIVE_WINDOW_MS;
      return {
        data: {
          ...data,
          isPlaying: isRecentlyChanged,
          isFallback: !isRecentlyChanged,
        },
        lastActiveAt,
      };
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
