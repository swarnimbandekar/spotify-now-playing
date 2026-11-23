import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { getNowPlaying, getImageBase64, invalidateCache, getUserConnections } from './providers';
import { getSpotifyAuthUrl, getSpotifyTokens, getSpotifyProfile } from './providers/spotify';
import { getYouTubeAuthUrl, getYouTubeTokens, getYouTubeProfile } from './providers/youtube';
import {
  saveProviderConnection,
  disconnectProvider,
  getUser,
  getUserByProviderId,
  deleteUser,
} from './storage';
import { getTemplate, getSVGTemplate } from './template';
import { ProviderConnection, ProviderId, PROVIDERS } from './types';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

const getRedirectUri = (req: express.Request): string => {
  if (process.env.REDIRECT_URI) return process.env.REDIRECT_URI;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0] || req.protocol;
  return `${protocol}://${req.get('host')}/callback`;
};

const isValidProvider = (value: unknown): value is ProviderId => {
  return typeof value === 'string' && value in PROVIDERS;
};

const hasServerCredentials = (provider: ProviderId): boolean => {
  if (provider === 'spotify') {
    return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_SECRET_ID);
  }
  return Boolean(
    (process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID) &&
    (process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET)
  );
};

const maskSecret = (val?: string) => {
  if (!val) return '';
  if (val.length <= 8) return `${val.substring(0, 2)}...`;
  return `${val.substring(0, 4)}...${val.substring(val.length - 4)}`;
};

const escapeHtml = (unsafe: string) =>
  unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const SPOTIFY_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="#1DB954"><path d="M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zm5.508 17.303c-.216.354-.675.466-1.03.25-2.853-1.743-6.444-2.138-10.673-1.172-.406.092-.813-.16-.904-.565-.092-.406.161-.813.566-.905 4.633-1.06 8.583-.615 11.79 1.344.355.216.467.675.251 1.03zm1.48-3.26c-.272.443-.848.583-1.291.31-3.262-2.004-8.23-2.585-12.086-1.414-.498.151-1.025-.13-1.176-.628-.151-.498.13-1.025.628-1.176 4.417-1.34 9.878-.68 13.616 1.616.442.272.583.848.31 1.291zm.128-3.4c-3.912-2.323-10.363-2.537-14.126-1.396-.6.182-1.234-.162-1.416-.763-.182-.6.162-1.233.763-1.415 4.316-1.31 11.439-1.062 15.968 1.625.539.319.718 1.018.399 1.556-.32.538-1.019.718-1.557.399z"/></svg>`;

const YOUTUBE_ICON = `<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#FF0033"/><circle cx="12" cy="12" r="7.5" fill="none" stroke="#fff" stroke-width="1.4"/><polygon points="10,8.5 16,12 10,15.5" fill="#fff"/></svg>`;

app.set('trust proxy', true);
app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const POPUP_SCRIPT = `
  function handleOAuthSubmit(event, provider) {
    const form = event.target;
    const status = document.getElementById('statusMsg');
    const popupName = 'oauth_' + provider;
    const w = 520;
    const h = 680;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);

    const popup = window.open(
      '',
      popupName,
      'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top + ',resizable=yes,scrollbars=yes'
    );

    if (!popup || popup.closed || typeof popup.closed === 'undefined') {
      form.target = '_self';
      form.querySelector('input[name="popup"]').value = '0';
      return true;
    }

    form.target = popupName;
    form.querySelector('input[name="popup"]').value = '1';
    if (status) {
      status.textContent = 'Complete authorization in the ' + (provider === 'spotify' ? 'Spotify' : 'YouTube Music') + ' popup...';
    }

    const pollClosed = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollClosed);
        if (status && status.textContent.startsWith('Complete')) {
          status.textContent = '';
        }
      }
    }, 500);

    return true;
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === 'oauth-success' && event.data.uid) {
      const status = document.getElementById('statusMsg');
      if (status) status.textContent = 'Connected! Updating dashboard...';
      window.location.href = '/dashboard?uid=' + encodeURIComponent(event.data.uid);
    }
  });
`;

app.get('/', (req, res) => {
  const { uid } = req.signedCookies;
  if (uid) {
    return res.redirect(`/dashboard?uid=${uid}`);
  }

  const redirectUri = getRedirectUri(req);
  const spotifyHasServer = hasServerCredentials('spotify');
  const youtubeHasServer = hasServerCredentials('youtube');

  res.send(`
    <html>
      <head>
        <title>Now Playing Widget</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap');
          :root {
            --accent: #1DB954;
            --bg-dark: #090909;
            --surface: #121212;
            --text-main: #FFFFFF;
            --text-dim: #A7A7A7;
            --input-bg: #1A1A1A;
            --border: rgba(255, 255, 255, 0.1);
          }
          body { 
            font-family: 'Outfit', sans-serif; 
            background: var(--bg-dark); 
            color: var(--text-main); 
            display: flex; 
            flex-direction: column;
            align-items: center; 
            justify-content: center; 
            min-height: 100vh; 
            margin: 0;
            padding: 24px 16px;
            box-sizing: border-box;
          }
          .background-glow {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 640px;
            height: 640px;
            background: radial-gradient(circle, rgba(29, 185, 84, 0.15) 0%, rgba(0, 0, 0, 0) 70%);
            z-index: -1;
            pointer-events: none;
            transition: background 0.3s ease;
          }
          .container { 
            text-align: center; 
            background: rgba(18, 18, 18, 0.78); 
            padding: 36px; 
            border-radius: 32px; 
            backdrop-filter: blur(20px);
            border: 1px solid var(--border);
            box-shadow: 0 24px 64px rgba(0,0,0,0.6);
            max-width: 480px;
            width: 100%;
            box-sizing: border-box;
          }
          h1 { margin: 0 0 10px 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
          p { margin: 0 0 24px 0; color: var(--text-dim); line-height: 1.6; font-size: 15px; }
          .player-tabs {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 24px;
          }
          .player-tab {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 12px 16px;
            border-radius: 14px;
            border: 1px solid var(--border);
            background: rgba(255, 255, 255, 0.04);
            color: var(--text-dim);
            font-family: inherit;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
          }
          .player-tab:hover { color: var(--text-main); border-color: rgba(255,255,255,0.25); }
          .player-tab.active {
            color: #fff;
            border-color: var(--accent);
            background: rgba(255, 255, 255, 0.08);
          }
          .player-panel { display: none; text-align: left; }
          .player-panel.active { display: block; }
          .info-box {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--border);
            padding: 12px 14px;
            border-radius: 12px;
            margin-bottom: 18px;
            font-size: 13px;
            color: var(--text-dim);
            line-height: 1.5;
          }
          .info-box strong { color: var(--text-main); word-break: break-all; }
          .form-group { margin-bottom: 16px; }
          label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 6px;
            color: var(--text-dim);
          }
          input {
            width: 100%;
            padding: 12px 14px;
            background: var(--input-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            color: white;
            font-family: inherit;
            font-size: 14px;
            box-sizing: border-box;
            transition: border-color 0.2s;
          }
          input:focus { outline: none; border-color: var(--accent); }
          .btn { 
            width: 100%;
            background: var(--accent); 
            color: #000; 
            padding: 14px; 
            border-radius: 100px; 
            border: none;
            font-family: inherit;
            font-weight: 700; 
            font-size: 15px;
            cursor: pointer;
            transition: all 0.25s;
            margin-top: 6px;
          }
          .btn.youtube-btn { color: #fff; }
          .btn:hover { filter: brightness(1.08); transform: translateY(-2px); }
          .setup-guide {
            margin-top: 18px;
            background: rgba(255, 255, 255, 0.04);
            border-radius: 14px;
            border: 1px solid var(--border);
            overflow: hidden;
          }
          .setup-guide summary {
            padding: 12px 14px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
            color: var(--text-dim);
            list-style: none;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .setup-guide summary::before { content: '→'; transition: transform 0.2s; }
          .setup-guide[open] summary::before { transform: rotate(90deg); }
          .setup-content {
            padding: 0 14px 14px 14px;
            font-size: 12.5px;
            color: var(--text-dim);
            line-height: 1.6;
          }
          .setup-content ol { padding-left: 18px; margin: 8px 0 0 0; }
          .setup-content li { margin-bottom: 6px; }
          .setup-content code {
            background: #000;
            padding: 2px 6px;
            border-radius: 4px;
            border: 1px solid #333;
            color: #fff;
            word-break: break-all;
          }
          .status-msg {
            margin-top: 16px;
            font-size: 13px;
            color: var(--text-dim);
            text-align: center;
            min-height: 18px;
          }
          .privacy {
            margin-top: 16px;
            font-size: 12px;
            color: var(--text-dim);
            line-height: 1.5;
            text-align: center;
          }
          footer {
            margin-top: 28px;
            font-size: 14px;
            color: var(--text-dim);
          }
        </style>
      </head>
      <body>
        <div class="background-glow" id="bgGlow"></div>
        <div class="container">
          <h1>Now Playing</h1>
          <p>Connect Spotify, YouTube Music, or <strong>both</strong> to one unified SVG widget. You can add the second player anytime from your dashboard.</p>

          <div class="player-tabs">
            <button type="button" class="player-tab active" data-provider="spotify" data-color="#1DB954">
              ${SPOTIFY_ICON}
              <span>Spotify</span>
            </button>
            <button type="button" class="player-tab" data-provider="youtube" data-color="#FF0033">
              ${YOUTUBE_ICON}
              <span>YouTube Music</span>
            </button>
          </div>

          <!-- SPOTIFY -->
          <div class="player-panel active" id="panel-spotify">
            <div class="info-box">
              Add <strong>${redirectUri}</strong> as a Redirect URI in your Spotify App.
            </div>
            <form action="/auth/spotify" method="POST" onsubmit="return handleOAuthSubmit(event, 'spotify')">
              <input type="hidden" name="popup" value="1">
              <div class="form-group">
                <label for="sp-clientId">Spotify Client ID ${spotifyHasServer ? '(Optional)' : ''}</label>
                <input type="text" id="sp-clientId" name="clientId" placeholder="Enter your Spotify Client ID" ${spotifyHasServer ? '' : 'required'}>
              </div>
              <div class="form-group">
                <label for="sp-clientSecret">Spotify Client Secret ${spotifyHasServer ? '(Optional)' : ''}</label>
                <input type="password" id="sp-clientSecret" name="clientSecret" placeholder="Enter your Spotify Client Secret" ${spotifyHasServer ? '' : 'required'}>
              </div>
              <button type="submit" class="btn">Connect Spotify</button>
            </form>
            <details class="setup-guide">
              <summary>How to create your Spotify App</summary>
              <div class="setup-content">
                <ol>
                  <li>Open the <a href="https://developer.spotify.com/dashboard" target="_blank" style="color:#1DB954;">Spotify Developer Dashboard</a> and click <strong>Create app</strong>.</li>
                  <li>Add Redirect URI: <code>${redirectUri}</code> and save.</li>
                  <li>Copy your <strong>Client ID</strong> and <strong>Client Secret</strong> above and click <strong>Connect Spotify</strong>.</li>
                </ol>
              </div>
            </details>
          </div>

          <!-- YOUTUBE MUSIC -->
          <div class="player-panel" id="panel-youtube">
            <div class="info-box">
              Add <strong>${redirectUri}</strong> as an Authorized Redirect URI in your Google Cloud OAuth Client.
            </div>
            <form action="/auth/youtube" method="POST" onsubmit="return handleOAuthSubmit(event, 'youtube')">
              <input type="hidden" name="popup" value="1">
              <div class="form-group">
                <label for="yt-clientId">Google OAuth Client ID ${youtubeHasServer ? '(Optional)' : ''}</label>
                <input type="text" id="yt-clientId" name="clientId" placeholder="xxxx.apps.googleusercontent.com" ${youtubeHasServer ? '' : 'required'}>
              </div>
              <div class="form-group">
                <label for="yt-clientSecret">Google OAuth Client Secret ${youtubeHasServer ? '(Optional)' : ''}</label>
                <input type="password" id="yt-clientSecret" name="clientSecret" placeholder="GOCSPX-..." ${youtubeHasServer ? '' : 'required'}>
              </div>
              <button type="submit" class="btn youtube-btn">Connect YouTube Music</button>
            </form>
            <details class="setup-guide">
              <summary>How to create your Google / YouTube OAuth App</summary>
              <div class="setup-content">
                <ol>
                  <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#FF0033;">Google Cloud Console</a> and enable <strong>YouTube Data API v3</strong>.</li>
                  <li>Under <strong>OAuth consent screen</strong>, add your Gmail as a Test User.</li>
                  <li>Create an <strong>OAuth client ID (Web application)</strong> with Redirect URI: <code>${redirectUri}</code>.</li>
                  <li>Copy your <strong>Client ID</strong> and <strong>Client Secret</strong> above and click <strong>Connect YouTube Music</strong>.</li>
                </ol>
              </div>
            </details>
          </div>

          <div class="status-msg" id="statusMsg"></div>

          <div class="privacy">
            🔒 Your credentials and tokens are stored securely and used only to fetch your music activity.
          </div>
        </div>

        <footer>
          By <a href="https://swarnimbandekar.in" target="_blank" style="color: white; text-decoration: none; font-weight: 600;">swarnimbandekar</a> | <a href="https://github.com/swarnimbandekar/spotify-now-playing" target="_blank" style="color: var(--text-dim); text-decoration: none;">Source Code</a>
        </footer>

        <script>
          const tabs = document.querySelectorAll('.player-tab');
          const panels = document.querySelectorAll('.player-panel');
          const glow = document.getElementById('bgGlow');

          tabs.forEach(tab => {
            tab.addEventListener('click', () => {
              const provider = tab.dataset.provider;
              const color = tab.dataset.color;
              tabs.forEach(t => t.classList.remove('active'));
              panels.forEach(p => p.classList.remove('active'));
              tab.classList.add('active');
              document.getElementById('panel-' + provider).classList.add('active');
              document.documentElement.style.setProperty('--accent', color);
              glow.style.background = 'radial-gradient(circle, ' + color + '26 0%, rgba(0, 0, 0, 0) 70%)';
            });
          });

          ${POPUP_SCRIPT}
        </script>
      </body>
    </html>
  `);
});

const startOAuthFlow = (req: express.Request, res: express.Response) => {
  const { provider } = req.params;
  if (!isValidProvider(provider)) {
    return res.status(400).send('Unsupported provider');
  }

  const bodyClientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
  const bodyClientSecret = typeof req.body?.clientSecret === 'string' ? req.body.clientSecret.trim() : '';

  const clientId =
    bodyClientId ||
    (provider === 'spotify'
      ? process.env.SPOTIFY_CLIENT_ID || ''
      : process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '');
  const clientSecret =
    bodyClientSecret ||
    (provider === 'spotify'
      ? process.env.SPOTIFY_SECRET_ID || ''
      : process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '');

  if (!clientId || !clientSecret) {
    return res.status(400).send(`${PROVIDERS[provider].name} Client ID and Client Secret are required.`);
  }

  const state = crypto.randomBytes(16).toString('hex');
  const isPopup = req.query.popup === '1' || req.body?.popup === '1';
  const cookieOptions = {
    maxAge: 15 * 60 * 1000,
    httpOnly: true,
    signed: true,
    sameSite: 'lax' as const,
    secure: isProduction,
  };

  res.cookie('oauth_state', state, cookieOptions);
  res.cookie('temp_provider', provider, cookieOptions);
  res.cookie('oauth_popup', isPopup ? '1' : '0', cookieOptions);
  if (bodyClientId && bodyClientSecret) {
    res.cookie('temp_client_id', bodyClientId, cookieOptions);
    res.cookie('temp_client_secret', bodyClientSecret, cookieOptions);
  } else {
    res.clearCookie('temp_client_id');
    res.clearCookie('temp_client_secret');
  }

  const redirectUri = getRedirectUri(req);
  const authUrl =
    provider === 'spotify'
      ? getSpotifyAuthUrl(state, redirectUri, clientId)
      : getYouTubeAuthUrl(state, redirectUri, clientId);

  res.redirect(authUrl);
};

app.get('/auth/:provider', startOAuthFlow);
app.post('/auth/:provider', startOAuthFlow);

app.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const {
    uid: sessionUid,
    oauth_state,
    temp_provider,
    oauth_popup,
    temp_client_id: userClientId,
    temp_client_secret: userClientSecret,
  } = req.signedCookies;

  if (oauthError) {
    return res.status(400).send(`Authorization denied: ${oauthError}`);
  }
  if (!code) return res.status(400).send('No authorization code provided');
  if (!state || state !== oauth_state) {
    return res.status(403).send('Invalid state parameter');
  }

  const provider: ProviderId = isValidProvider(temp_provider) ? temp_provider : 'spotify';
  const isPopup = oauth_popup === '1';

  res.clearCookie('oauth_state');
  res.clearCookie('temp_provider');
  res.clearCookie('oauth_popup');
  res.clearCookie('temp_client_id');
  res.clearCookie('temp_client_secret');

  try {
    const redirectUri = getRedirectUri(req);
    let providerUserId = '';
    let displayName = '';
    let accessToken = '';
    let refreshToken = '';
    let expiresAt = 0;

    if (provider === 'youtube') {
      const tokens = await getYouTubeTokens(code as string, redirectUri, userClientId, userClientSecret);
      const profile = await getYouTubeProfile(tokens.access_token);
      providerUserId = profile.id;
      displayName = profile.displayName;
      accessToken = tokens.access_token;
      refreshToken = tokens.refresh_token || '';
      expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;
    } else {
      const tokens = await getSpotifyTokens(code as string, redirectUri, userClientId, userClientSecret);
      const profile = await getSpotifyProfile(tokens.access_token);
      providerUserId = profile.id;
      displayName = profile.display_name || profile.id;
      accessToken = tokens.access_token;
      refreshToken = tokens.refresh_token || '';
      expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;
    }

    // If user is already logged in (linking a second player from /dashboard), keep their existing UID!
    let targetUser = sessionUid ? await getUser(sessionUid) : null;
    if (!targetUser) {
      targetUser = await getUserByProviderId(provider, providerUserId);
    }

    const uid = targetUser ? targetUser.uid : crypto.randomBytes(5).toString('hex');
    const existingConnections = getUserConnections(targetUser);
    const prevConn = existingConnections[provider];

    const connection: ProviderConnection = {
      providerUserId,
      displayName,
      accessToken,
      refreshToken: refreshToken || prevConn?.refreshToken || '',
      expiresAt,
      ...(userClientId && userClientSecret
        ? { clientId: userClientId, clientSecret: userClientSecret }
        : prevConn?.clientId && prevConn?.clientSecret
          ? { clientId: prevConn.clientId, clientSecret: prevConn.clientSecret }
          : {}),
    };

    await saveProviderConnection(uid, provider, connection, targetUser?.displayName || displayName);
    invalidateCache(uid);

    res.cookie('uid', uid, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: isProduction,
    });

    if (isPopup) {
      return res.send(`
        <html>
          <body style="background:#090909;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
            <p>Connected! Updating dashboard...</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'oauth-success', uid: ${JSON.stringify(uid)} }, window.location.origin);
                window.close();
              } else {
                window.location.href = '/dashboard?uid=' + encodeURIComponent(${JSON.stringify(uid)});
              }
            </script>
          </body>
        </html>
      `);
    }

    res.redirect(`/dashboard?uid=${uid}`);
  } catch (error) {
    console.error('Error in OAuth callback:', error);
    res.status(500).send('Authentication failed');
  }
});

app.post('/disconnect/:provider', async (req, res) => {
  const { provider } = req.params;
  const { uid } = req.signedCookies;

  if (!uid) return res.redirect('/');
  if (!isValidProvider(provider)) return res.status(400).send('Unsupported provider');

  await disconnectProvider(uid, provider);
  invalidateCache(uid);
  res.redirect(`/dashboard?uid=${uid}`);
});

app.get('/dashboard', async (req, res) => {
  const uid = (req.query.uid as string) || req.signedCookies.uid;
  if (!uid) return res.redirect('/');

  const user = await getUser(uid);
  const connections = getUserConnections(user);
  const nowPlaying = await getNowPlaying(uid);
  const widgetHtml = getTemplate(nowPlaying);

  const activeProvider = nowPlaying?.provider || (connections.spotify ? 'spotify' : connections.youtube ? 'youtube' : 'spotify');
  const accentColor = PROVIDERS[activeProvider].color;

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const baseUrl = `${protocol}://${req.get('host')}`;
  const widgetUrl = `${baseUrl}/now-playing?uid=${uid}`;
  const redirectUri = getRedirectUri(req);

  const spotifyHasServer = hasServerCredentials('spotify');
  const youtubeHasServer = hasServerCredentials('youtube');

  const renderPlayerCard = (provider: ProviderId) => {
    const conn = connections[provider];
    const meta = PROVIDERS[provider];
    const icon = provider === 'spotify' ? SPOTIFY_ICON : YOUTUBE_ICON;
    const hasServer = provider === 'spotify' ? spotifyHasServer : youtubeHasServer;
    const isConnected = Boolean(conn);
    const idLabel = provider === 'spotify' ? 'Spotify Client ID' : 'Google OAuth Client ID';
    const secretLabel = provider === 'spotify' ? 'Spotify Client Secret' : 'Google OAuth Client Secret';
    const idPlaceholder = provider === 'spotify' ? 'Spotify Client ID' : 'xxxx.apps.googleusercontent.com';
    const secretPlaceholder = provider === 'spotify' ? 'Spotify Client Secret' : 'GOCSPX-...';

    if (isConnected && conn) {
      const appHint = conn.clientId ? ` · App ${maskSecret(conn.clientId)}` : '';
      return `
        <div class="player-card connected" style="border-color: ${meta.color}55;">
          <div class="player-card-head">
            <div class="player-card-title">
              ${icon}
              <div>
                <strong>${meta.name}</strong>
                <div class="player-meta">${escapeHtml(conn.displayName)}${appHint}</div>
              </div>
            </div>
            <span class="badge" style="background: ${meta.color}22; color: ${meta.color}; border-color: ${meta.color}55;">Connected</span>
          </div>
          <form action="/disconnect/${provider}" method="POST" style="margin-top: 14px;" onsubmit="return confirm('Disconnect ${meta.name} from your widget?')">
            <button type="submit" class="btn-small btn-outline" style="width: 100%;">Disconnect ${meta.name}</button>
          </form>
        </div>
      `;
    }

    return `
      <div class="player-card">
        <div class="player-card-head">
          <div class="player-card-title">
            ${icon}
            <div>
              <strong>${meta.name}</strong>
              <div class="player-meta">Not connected</div>
            </div>
          </div>
          <span class="badge muted">Disconnected</span>
        </div>
        <form action="/auth/${provider}" method="POST" onsubmit="return handleOAuthSubmit(event, '${provider}')" style="margin-top: 14px;">
          <input type="hidden" name="popup" value="1">
          <input class="mini-input" type="text" name="clientId" placeholder="${idPlaceholder}${hasServer ? ' (Optional)' : ''}" ${hasServer ? '' : 'required'}>
          <input class="mini-input" type="password" name="clientSecret" placeholder="${secretPlaceholder}${hasServer ? ' (Optional)' : ''}" ${hasServer ? '' : 'required'}>
          <button type="submit" class="btn-connect" style="background: ${meta.color}; color: ${provider === 'spotify' ? '#000' : '#fff'};">
            Connect ${meta.name}
          </button>
        </form>
        <div class="mini-hint">Redirect URI: <code>${redirectUri}</code></div>
      </div>
    `;
  };

  res.send(`
    <html>
      <head>
        <title>Dashboard | Now Playing</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap');
          :root {
            --accent: ${accentColor};
            --bg-dark: #090909;
            --surface: #121212;
            --input-bg: #1A1A1A;
            --text-main: #FFFFFF;
            --text-dim: #A7A7A7;
            --border: rgba(255, 255, 255, 0.1);
          }
          body { 
            font-family: 'Outfit', sans-serif; 
            background: var(--bg-dark); 
            color: var(--text-main); 
            display: flex; 
            flex-direction: column;
            align-items: center; 
            padding: 40px 20px;
            margin: 0; 
          }
          .container { max-width: 820px; width: 100%; }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 36px;
          }
          .logo {
            display: flex;
            align-items: center;
            gap: 12px;
            font-weight: 700;
            font-size: 24px;
            text-decoration: none;
            color: var(--text-main);
          }
          .logo-dot {
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: var(--accent);
            box-shadow: 0 0 16px var(--accent);
          }
          .card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 32px;
            margin-bottom: 24px;
          }
          h2 { margin-top: 0; font-size: 20px; color: var(--text-main); margin-bottom: 20px; }
          .preview-container {
            display: flex;
            justify-content: center;
            padding: 24px;
            background: #000;
            border-radius: 16px;
            border: 1px dashed var(--border);
            margin-bottom: 18px;
          }
          .players-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 16px;
          }
          .player-card {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border);
            border-radius: 18px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
          }
          .player-card-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
          }
          .player-card-title {
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .player-meta {
            font-size: 12px;
            color: var(--text-dim);
            margin-top: 2px;
          }
          .badge {
            font-size: 11px;
            font-weight: 700;
            padding: 4px 10px;
            border-radius: 999px;
            border: 1px solid var(--border);
            white-space: nowrap;
          }
          .badge.muted { color: var(--text-dim); background: rgba(255,255,255,0.05); }
          .mini-input {
            width: 100%;
            padding: 10px 12px;
            margin-bottom: 10px;
            background: var(--input-bg);
            border: 1px solid var(--border);
            border-radius: 10px;
            color: #fff;
            font-family: inherit;
            font-size: 13px;
            box-sizing: border-box;
          }
          .mini-input:focus { outline: none; border-color: rgba(255,255,255,0.35); }
          .btn-connect {
            width: 100%;
            padding: 11px;
            border: none;
            border-radius: 999px;
            font-family: inherit;
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            transition: filter 0.2s;
          }
          .btn-connect:hover { filter: brightness(1.1); }
          .mini-hint {
            margin-top: 10px;
            font-size: 11px;
            color: var(--text-dim);
            word-break: break-all;
          }
          .mini-hint code {
            background: #000;
            padding: 2px 5px;
            border-radius: 4px;
            color: #ddd;
          }
          .status-msg {
            margin-top: 14px;
            font-size: 13px;
            color: var(--accent);
            text-align: center;
            min-height: 18px;
          }
          .snippet-group { margin-bottom: 20px; }
          .snippet-label { font-size: 14px; color: var(--text-dim); margin-bottom: 8px; display: block; }
          .snippet-box {
            background: #000;
            border: 1px solid var(--border);
            padding: 16px;
            padding-right: 100px;
            border-radius: 12px;
            font-family: monospace;
            font-size: 13px;
            color: var(--accent);
            word-break: break-all;
            position: relative;
            cursor: pointer;
            transition: border-color 0.2s;
            overflow: hidden;
          }
          .snippet-box:hover { border-color: var(--accent); }
          .snippet-content { transition: filter 0.3s ease, opacity 0.3s ease; }
          .snippet-box:hover .snippet-content { filter: blur(4px); opacity: 0.5; }
          .copy-hint {
            position: absolute;
            right: 12px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 11px;
            background: var(--surface);
            color: var(--text-main);
            padding: 6px 10px;
            border-radius: 6px;
            opacity: 0;
            transition: all 0.2s ease;
            border: 1px solid var(--border);
            pointer-events: none;
            white-space: nowrap;
          }
          .snippet-box:hover .copy-hint { opacity: 1; right: 8px; }
          .btn-outline {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-dim);
          }
          .btn-outline:hover { border-color: var(--text-main); color: var(--text-main); }
          .btn-danger {
            background: transparent;
            border: 1px solid rgba(255, 68, 68, 0.3);
            color: #ff4444;
          }
          .btn-danger:hover { background: rgba(255, 68, 68, 0.1); border-color: #ff4444; }
          .btn-small {
            padding: 10px 18px;
            font-size: 13px;
            border-radius: 10px;
            text-decoration: none;
            display: inline-block;
            cursor: pointer;
            font-family: inherit;
            font-weight: 600;
          }
          .footer { text-align: center; margin-top: 32px; color: var(--text-dim); font-size: 14px; }
          .footer a { color: #fff; text-decoration: none; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <a href="/dashboard?uid=${uid}" class="logo">
              <span class="logo-dot"></span>
              <span>Dashboard</span>
            </a>
            <a href="/logout" class="btn-small btn-outline">Logout</a>
          </div>

          <div class="card">
            <h2>Your Live Widget</h2>
            <div class="preview-container">
              ${widgetHtml}
            </div>
            <p style="font-size: 14px; color: var(--text-dim); text-align: center; margin: 0 0 8px 0;">
              One single card — automatically shows whichever connected player is currently playing.
            </p>
            <p style="font-size: 12px; color: #fbbf24; text-align: center; margin: 0;">
              Note: GitHub caches images for a few minutes. Updates may not be instantaneous on your profile.
            </p>
          </div>

          <div class="card">
            <h2>Connected Music Players</h2>
            <div class="players-grid">
              ${renderPlayerCard('spotify')}
              ${renderPlayerCard('youtube')}
            </div>
            <div class="status-msg" id="statusMsg"></div>
          </div>

          <div class="card">
            <h2>Embed Your Widget</h2>
            <div class="snippet-group">
              <span class="snippet-label">Markdown (for GitHub Profile Readme)</span>
              <div class="snippet-box" onclick="copyToClipboard(this)">
                <span class="snippet-content">[![Now Playing](${widgetUrl})](${widgetUrl})</span>
                <span class="copy-hint">Click to copy</span>
              </div>
            </div>

            <div class="snippet-group">
              <span class="snippet-label">HTML Embed</span>
              <div class="snippet-box" onclick="copyToClipboard(this)">
                <span class="snippet-content">
                  &lt;a href="${widgetUrl}" target="_blank"&gt;
                    &lt;img src="${widgetUrl}" alt="Now Playing" /&gt;
                  &lt;/a&gt;
                </span>
                <span class="copy-hint">Click to copy</span>
              </div>
            </div>

            <div class="snippet-group" style="margin-bottom: 0;">
              <span class="snippet-label">Direct Link</span>
              <div class="snippet-box" onclick="copyToClipboard(this)">
                <span class="snippet-content">${widgetUrl}</span>
                <span class="copy-hint">Click to copy</span>
              </div>
            </div>
          </div>

          <div class="card">
            <h2>Danger Zone</h2>
            <p style="font-size: 14px; color: var(--text-dim); margin: 0 0 18px 0;">
              Revoking access will disconnect all players and permanently delete your credentials and tokens from our database.
            </p>
            <form action="/revoke" method="POST" onsubmit="return confirm('Permanently delete your account, credentials, and tokens?')">
              <button type="submit" class="btn-small btn-danger">Revoke All & Delete Data</button>
            </form>
          </div>

          <div class="footer">
            By <a href="https://swarnimbandekar.in" target="_blank">swarnimbandekar</a>
          </div>
        </div>

        <script>
          function copyToClipboard(el) {
            const text = el.innerText.replace('Click to copy', '').trim();
            navigator.clipboard.writeText(text).then(() => {
              const hint = el.querySelector('.copy-hint');
              const originalText = hint.innerText;
              hint.innerText = 'Copied!';
              setTimeout(() => { hint.innerText = originalText; }, 2000);
            });
          }

          ${POPUP_SCRIPT}
        </script>
      </body>
    </html>
  `);
});

app.get('/now-playing', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).send('No UID provided');

  const nowPlaying = await getNowPlaying(uid as string);

  let albumArtBase64: string | null = null;
  if (nowPlaying?.albumArtUrl) {
    albumArtBase64 = await getImageBase64(nowPlaying.albumArtUrl);
  }

  const svg = getSVGTemplate(nowPlaying, albumArtBase64);

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(svg);
});

app.get('/logout', (req, res) => {
  res.clearCookie('uid');
  res.redirect('/');
});

app.post('/revoke', async (req, res) => {
  const { uid } = req.signedCookies;
  if (uid) {
    invalidateCache(uid);
    await deleteUser(uid);
    res.clearCookie('uid');
  }
  res.redirect('/');
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

export default app;
