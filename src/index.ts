import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { getNowPlaying, getImageBase64, invalidateCache, resolveProvider } from './providers';
import { getSpotifyAuthUrl, getSpotifyTokens, getSpotifyProfile } from './providers/spotify';
import { getDeezerAuthUrl, getDeezerTokens, getDeezerProfile } from './providers/deezer';
import { validateLastFmUser } from './providers/lastfm';
import { validateListenBrainzUser } from './providers/listenbrainz';
import { validateSubsonicUser } from './providers/subsonic';
import { saveUser, getUser, getUserByProviderId, deleteUser } from './storage';
import { getTemplate, getSVGTemplate } from './template';
import { ProviderId, PROVIDERS, UserData } from './types';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
const hasServerLastFmKey = Boolean(process.env.LASTFM_API_KEY);

const getRedirectUri = (req: express.Request): string => {
  if (process.env.REDIRECT_URI) return process.env.REDIRECT_URI;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0] || req.protocol;
  return `${protocol}://${req.get('host')}/callback`;
};

const isValidProvider = (value: unknown): value is ProviderId => {
  return typeof value === 'string' && value in PROVIDERS;
};

const maskSecret = (val?: string) => {
  if (!val) return 'Unknown';
  if (val.length <= 8) return `${val.substring(0, 2)}...`;
  return `${val.substring(0, 4)}...${val.substring(val.length - 4)}`;
};

const getConnectionLabel = (user: UserData | null): string => {
  if (!user) return 'Unknown';
  const provider = resolveProvider(user);
  switch (provider) {
    case 'spotify':
      return `Spotify App: <strong>${maskSecret(user.clientId)}</strong>`;
    case 'deezer':
      return `Deezer App: <strong>${maskSecret(user.clientId)}</strong>`;
    case 'lastfm':
      return `Last.fm: <strong>@${user.username || user.providerUserId}</strong>`;
    case 'listenbrainz':
      return `ListenBrainz: <strong>@${user.username || user.providerUserId}</strong>`;
    case 'subsonic':
      return `Subsonic: <strong>${user.username}@${user.serverUrl}</strong>`;
  }
};

app.set('trust proxy', true);
app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  const { uid } = req.signedCookies;
  if (uid) {
    return res.redirect(`/dashboard?uid=${uid}`);
  }

  const redirectUri = getRedirectUri(req);

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
            padding: 24px 0;
          }
          .background-glow {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 600px;
            height: 600px;
            background: radial-gradient(circle, rgba(29, 185, 84, 0.15) 0%, rgba(0, 0, 0, 0) 70%);
            z-index: -1;
            pointer-events: none;
            transition: background 0.3s ease;
          }
          .container { 
            text-align: center; 
            background: rgba(18, 18, 18, 0.7); 
            padding: 36px; 
            border-radius: 32px; 
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 24px 64px rgba(0,0,0,0.6);
            max-width: 500px;
            width: 90%;
          }
          h1 { margin: 0 0 10px 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
          p { margin: 0 0 24px 0; color: var(--text-dim); line-height: 1.6; font-size: 15px; }
          .provider-tabs {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            justify-content: center;
            margin-bottom: 24px;
          }
          .provider-tab {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: var(--text-dim);
            padding: 8px 14px;
            border-radius: 999px;
            font-family: inherit;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
          }
          .provider-tab:hover {
            color: var(--text-main);
            border-color: rgba(255, 255, 255, 0.25);
          }
          .provider-tab.active {
            background: var(--accent);
            color: #000;
            border-color: var(--accent);
          }
          .provider-panel { display: none; }
          .provider-panel.active { display: block; }
          .form-group {
            text-align: left;
            margin-bottom: 18px;
          }
          label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--text-dim);
          }
          input {
            width: 100%;
            padding: 12px 16px;
            background: var(--input-bg);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            color: white;
            font-family: inherit;
            font-size: 14px;
            box-sizing: border-box;
            transition: border-color 0.2s;
          }
          input:focus {
            outline: none;
            border-color: var(--accent);
          }
          .btn { 
            width: 100%;
            background: var(--accent); 
            color: #000; 
            padding: 14px; 
            border-radius: 100px; 
            border: none;
            font-family: inherit;
            font-weight: 700; 
            font-size: 16px;
            cursor: pointer;
            transition: all 0.3s;
            margin-top: 8px;
          }
          .btn:hover { 
            filter: brightness(1.1);
            transform: translateY(-2px);
          }
          .info-box {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.12);
            padding: 14px;
            border-radius: 12px;
            margin-bottom: 20px;
            font-size: 13px;
            text-align: left;
            color: var(--text-dim);
            line-height: 1.5;
          }
          .info-box strong { color: var(--text-main); }
          .setup-guide {
            text-align: left;
            margin-top: 24px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 16px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.1);
          }
          .setup-guide summary {
            padding: 14px 16px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            color: var(--text-dim);
            list-style: none;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .setup-guide summary::before {
            content: '→';
            display: inline-block;
            transition: transform 0.2s;
          }
          .setup-guide[open] summary::before {
            transform: rotate(90deg);
          }
          .setup-content {
            padding: 0 16px 16px 16px;
            font-size: 13px;
            color: var(--text-dim);
            line-height: 1.6;
          }
          .setup-content ol { padding-left: 20px; margin: 10px 0; }
          .setup-content li { margin-bottom: 6px; }
          .setup-content strong { color: var(--text-main); }
          footer {
            margin-top: 32px;
            font-size: 14px;
            color: var(--text-dim);
          }
        </style>
      </head>
      <body>
        <div class="background-glow" id="bgGlow"></div>
        <div class="container">
          <h1>Music Now Playing</h1>
          <p>Create a live "Now Playing" SVG widget for your GitHub profile across your favorite music platforms.</p>

          <div class="provider-tabs" role="tablist">
            <button type="button" class="provider-tab active" data-provider="spotify" data-color="#1DB954">Spotify</button>
            <button type="button" class="provider-tab" data-provider="lastfm" data-color="#D51007">Last.fm</button>
            <button type="button" class="provider-tab" data-provider="listenbrainz" data-color="#EB743B">ListenBrainz</button>
            <button type="button" class="provider-tab" data-provider="deezer" data-color="#A238FF">Deezer</button>
            <button type="button" class="provider-tab" data-provider="subsonic" data-color="#3B82F6">Navidrome</button>
          </div>

          <!-- SPOTIFY -->
          <div class="provider-panel active" id="panel-spotify">
            <div class="info-box">
              Add <strong>${redirectUri}</strong> as a Redirect URI in your Spotify App.
            </div>
            <form action="/login" method="POST">
              <input type="hidden" name="provider" value="spotify">
              <div class="form-group">
                <label for="sp-clientId">Spotify Client ID</label>
                <input type="text" id="sp-clientId" name="clientId" placeholder="Enter your Client ID" required>
              </div>
              <div class="form-group">
                <label for="sp-clientSecret">Spotify Client Secret</label>
                <input type="password" id="sp-clientSecret" name="clientSecret" placeholder="Enter your Client Secret" required>
              </div>
              <button type="submit" class="btn">Connect Spotify</button>
            </form>
            <details class="setup-guide">
              <summary>How to set up your Spotify App</summary>
              <div class="setup-content">
                <ol>
                  <li>Visit the <a href="https://developer.spotify.com/dashboard" target="_blank" style="color: #1DB954;">Spotify Developer Dashboard</a>.</li>
                  <li>Click <strong>Create app</strong>, then open <strong>Settings</strong>.</li>
                  <li>Add Redirect URI: <code style="background: #000; padding: 2px 6px; border-radius: 4px;">${redirectUri}</code></li>
                  <li>Copy your <strong>Client ID</strong> and <strong>Client Secret</strong> above.</li>
                </ol>
              </div>
            </details>
          </div>

          <!-- LAST.FM -->
          <div class="provider-panel" id="panel-lastfm">
            <div class="info-box">
              <strong>Covers Apple Music, YouTube Music, Tidal, Qobuz, SoundCloud & more!</strong><br>
              Just connect a scrobbler (like Pano Scrobbler, Web Scrobbler, or Tidal's built-in Last.fm link) and enter your Last.fm username.
            </div>
            <form action="/login" method="POST">
              <input type="hidden" name="provider" value="lastfm">
              <div class="form-group">
                <label for="lfm-username">Last.fm Username</label>
                <input type="text" id="lfm-username" name="username" placeholder="e.g. johndoe" required>
              </div>
              <div class="form-group">
                <label for="lfm-apiKey">Last.fm API Key ${hasServerLastFmKey ? '(Optional — server key configured)' : '(Required)'}</label>
                <input type="text" id="lfm-apiKey" name="apiKey" placeholder="Get one at last.fm/api/account/create" ${hasServerLastFmKey ? '' : 'required'}>
              </div>
              <button type="submit" class="btn" style="color: #fff;">Connect Last.fm</button>
            </form>
          </div>

          <!-- LISTENBRAINZ -->
          <div class="provider-panel" id="panel-listenbrainz">
            <div class="info-box">
              <strong>Open-source scrobbling by MetaBrainz.</strong><br>
              No API key or OAuth needed — just enter your ListenBrainz username! Works with Web Scrobbler, Pano Scrobbler, Navidrome, and Jellyfin.
            </div>
            <form action="/login" method="POST">
              <input type="hidden" name="provider" value="listenbrainz">
              <div class="form-group">
                <label for="lb-username">ListenBrainz Username</label>
                <input type="text" id="lb-username" name="username" placeholder="e.g. johndoe" required>
              </div>
              <button type="submit" class="btn">Connect ListenBrainz</button>
            </form>
          </div>

          <!-- DEEZER -->
          <div class="provider-panel" id="panel-deezer">
            <div class="info-box">
              Add <strong>${redirectUri}</strong> as the Redirect URL in your <a href="https://developers.deezer.com/myapps" target="_blank" style="color: #A238FF;">Deezer App</a>.
            </div>
            <form action="/login" method="POST">
              <input type="hidden" name="provider" value="deezer">
              <div class="form-group">
                <label for="dz-clientId">Deezer App ID</label>
                <input type="text" id="dz-clientId" name="clientId" placeholder="Enter your Deezer App ID" required>
              </div>
              <div class="form-group">
                <label for="dz-clientSecret">Deezer Secret Key</label>
                <input type="password" id="dz-clientSecret" name="clientSecret" placeholder="Enter your Deezer Secret Key" required>
              </div>
              <button type="submit" class="btn" style="color: #fff;">Connect Deezer</button>
            </form>
          </div>

          <!-- SUBSONIC / NAVIDROME -->
          <div class="provider-panel" id="panel-subsonic">
            <div class="info-box">
              Works with <strong>Navidrome, Airsonic, Gonic,</strong> and any Subsonic-compatible server reachable over HTTPS. Your password is converted to a salted MD5 token and never stored in plaintext.
            </div>
            <form action="/login" method="POST">
              <input type="hidden" name="provider" value="subsonic">
              <div class="form-group">
                <label for="sub-url">Server URL</label>
                <input type="url" id="sub-url" name="serverUrl" placeholder="https://music.yourdomain.com" required>
              </div>
              <div class="form-group">
                <label for="sub-user">Username</label>
                <input type="text" id="sub-user" name="username" placeholder="Enter your username" required>
              </div>
              <div class="form-group">
                <label for="sub-pass">Password</label>
                <input type="password" id="sub-pass" name="password" placeholder="Enter your password" required>
              </div>
              <button type="submit" class="btn" style="color: #fff;">Connect Server</button>
            </form>
          </div>

          <div style="margin-top: 24px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
            <p style="margin: 0;">🔒 <strong>Privacy Note:</strong> Your credentials are stored securely and used only to fetch your music activity. You can revoke access at any time from your dashboard.</p>
          </div>
        </div>

        <footer>
          By <a href="https://swarnimbandekar.in" target="_blank" style="color: white; text-decoration: none; font-weight: 600;">swarnimbandekar</a> | <a href="https://github.com/swarnimbandekar/spotify-now-playing" target="_blank" style="color: var(--text-dim); text-decoration: none;">Source Code</a>
        </footer>

        <script>
          const tabs = document.querySelectorAll('.provider-tab');
          const panels = document.querySelectorAll('.provider-panel');
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
        </script>
      </body>
    </html>
  `);
});

app.post('/login', async (req, res) => {
  const rawProvider = req.body.provider || 'spotify';
  if (!isValidProvider(rawProvider)) {
    return res.status(400).send('Unsupported provider');
  }

  const provider: ProviderId = rawProvider;
  const cookieOptions = {
    maxAge: 15 * 60 * 1000,
    httpOnly: true,
    signed: true,
    sameSite: 'lax' as const,
    secure: isProduction,
  };

  // OAuth providers (Spotify, Deezer)
  if (provider === 'spotify' || provider === 'deezer') {
    const { clientId, clientSecret } = req.body;
    if (!clientId || !clientSecret) {
      return res.status(400).send('Client ID and Client Secret are required');
    }

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, cookieOptions);
    res.cookie('temp_provider', provider, cookieOptions);
    res.cookie('temp_client_id', clientId.trim(), cookieOptions);
    res.cookie('temp_client_secret', clientSecret.trim(), cookieOptions);

    const redirectUri = getRedirectUri(req);
    const authUrl =
      provider === 'spotify'
        ? getSpotifyAuthUrl(state, clientId.trim(), redirectUri)
        : getDeezerAuthUrl(state, clientId.trim(), redirectUri);

    return res.redirect(authUrl);
  }

  // Direct credential / username providers (Last.fm, ListenBrainz, Subsonic)
  try {
    let providerUserId = '';
    let userData: Omit<UserData, 'uid'>;

    if (provider === 'lastfm') {
      const username = (req.body.username || '').trim();
      const apiKey = (req.body.apiKey || '').trim();
      if (!username) return res.status(400).send('Last.fm username is required');

      const info = await validateLastFmUser(username, apiKey || undefined);
      providerUserId = info.username.toLowerCase();
      userData = {
        provider: 'lastfm',
        providerUserId,
        displayName: info.displayName,
        username: info.username,
        ...(apiKey ? { apiKey } : {}),
      };
    } else if (provider === 'listenbrainz') {
      const username = (req.body.username || '').trim();
      if (!username) return res.status(400).send('ListenBrainz username is required');

      const info = await validateListenBrainzUser(username);
      providerUserId = info.username.toLowerCase();
      userData = {
        provider: 'listenbrainz',
        providerUserId,
        displayName: info.displayName,
        username: info.username,
      };
    } else {
      const serverUrl = (req.body.serverUrl || '').trim();
      const username = (req.body.username || '').trim();
      const password = req.body.password || '';
      if (!serverUrl || !username || !password) {
        return res.status(400).send('Server URL, username, and password are required');
      }

      const info = await validateSubsonicUser(serverUrl, username, password);
      providerUserId = `${info.username.toLowerCase()}@${info.serverUrl.toLowerCase()}`;
      userData = {
        provider: 'subsonic',
        providerUserId,
        displayName: info.username,
        username: info.username,
        serverUrl: info.serverUrl,
        subsonicToken: info.subsonicToken,
        subsonicSalt: info.subsonicSalt,
      };
    }

    const existingUser = await getUserByProviderId(provider, providerUserId);
    const uid = existingUser ? existingUser.uid : crypto.randomBytes(5).toString('hex');
    await saveUser(uid, userData);
    invalidateCache(uid);

    res.cookie('uid', uid, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: isProduction,
    });

    return res.redirect(`/dashboard?uid=${uid}`);
  } catch (error: any) {
    console.error(`Error connecting ${provider}:`, error?.message || error);
    return res.status(400).send(`Failed to connect ${PROVIDERS[provider].name}: ${error?.message || 'Invalid credentials'}`);
  }
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const {
    oauth_state,
    temp_provider,
    temp_client_id: clientId,
    temp_client_secret: clientSecret,
  } = req.signedCookies;

  if (!code) return res.status(400).send('No code provided');
  if (!state || state !== oauth_state) {
    return res.status(403).send('Invalid state parameter');
  }
  if (!clientId || !clientSecret) {
    return res.status(400).send('Credentials missing. Please try again from the home page.');
  }

  const provider: ProviderId = isValidProvider(temp_provider) ? temp_provider : 'spotify';

  res.clearCookie('oauth_state');
  res.clearCookie('temp_provider');
  res.clearCookie('temp_client_id');
  res.clearCookie('temp_client_secret');

  try {
    let providerUserId = '';
    let displayName = '';
    let accessToken = '';
    let refreshToken = '';
    let expiresAt = 0;

    if (provider === 'deezer') {
      const tokens = await getDeezerTokens(code as string, clientId, clientSecret);
      const profile = await getDeezerProfile(tokens.access_token);
      providerUserId = String(profile.id);
      displayName = profile.name || providerUserId;
      accessToken = tokens.access_token;
      expiresAt = tokens.expires ? Date.now() + Number(tokens.expires) * 1000 : 0;
    } else {
      const tokens = await getSpotifyTokens(code as string, clientId, clientSecret, getRedirectUri(req));
      const profile = await getSpotifyProfile(tokens.access_token);
      providerUserId = profile.id;
      displayName = profile.display_name || profile.id;
      accessToken = tokens.access_token;
      refreshToken = tokens.refresh_token || '';
      expiresAt = Date.now() + tokens.expires_in * 1000;
    }

    const existingUser = await getUserByProviderId(provider, providerUserId);
    const uid = existingUser ? existingUser.uid : crypto.randomBytes(5).toString('hex');

    const userData: Omit<UserData, 'uid'> = {
      provider,
      providerUserId,
      ...(provider === 'spotify' ? { spotifyId: providerUserId } : {}),
      displayName,
      accessToken,
      refreshToken: refreshToken || existingUser?.refreshToken || '',
      expiresAt,
      clientId,
      clientSecret,
    };

    await saveUser(uid, userData);
    invalidateCache(uid);

    res.cookie('uid', uid, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: isProduction,
    });

    res.redirect(`/dashboard?uid=${uid}`);
  } catch (error) {
    console.error('Error in callback:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/dashboard', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).send('No UID provided');

  const user = await getUser(uid as string);
  const provider = user ? resolveProvider(user) : 'spotify';
  const providerMeta = PROVIDERS[provider];
  const nowPlaying = await getNowPlaying(uid as string);
  const widgetHtml = getTemplate(nowPlaying);

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const baseUrl = `${protocol}://${req.get('host')}`;
  const widgetUrl = `${baseUrl}/now-playing?uid=${uid}`;
  const connectionLabel = getConnectionLabel(user);

  res.send(`
    <html>
      <head>
        <title>Dashboard | ${providerMeta.name} Now Playing</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap');
          :root {
            --accent: ${providerMeta.color};
            --bg-dark: #090909;
            --surface: #121212;
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
          .container { 
            max-width: 800px; 
            width: 100%;
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
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
          .credentials-info {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 14px;
            color: var(--text-dim);
            background: rgba(255, 255, 255, 0.05);
            padding: 12px 16px;
            border-radius: 12px;
            margin-top: 12px;
          }
          h2 { margin-top: 0; font-size: 20px; color: var(--text-main); margin-bottom: 24px; }
          .preview-container {
            display: flex;
            justify-content: center;
            padding: 24px;
            background: #000;
            border-radius: 16px;
            border: 1px dashed var(--border);
            margin-bottom: 24px;
          }
          .snippet-group { margin-bottom: 24px; }
          .snippet-label {
            font-size: 14px;
            color: var(--text-dim);
            margin-bottom: 8px;
            display: block;
          }
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
          .footer {
            text-align: center;
            margin-top: 40px;
            color: var(--text-dim);
            font-size: 14px;
          }
          .footer a { color: #fff; text-decoration: none; font-weight: 600; }
          .btn-outline {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-dim);
          }
          .btn-outline:hover {
            border-color: var(--text-main);
            color: var(--text-main);
          }
          .btn-danger {
            background: transparent;
            border: 1px solid rgba(255, 68, 68, 0.3);
            color: #ff4444;
          }
          .btn-danger:hover {
            background: rgba(255, 68, 68, 0.1);
            border-color: #ff4444;
          }
          .management-actions { display: flex; gap: 12px; margin-top: 24px; }
          .btn-small {
            padding: 10px 20px;
            font-size: 13px;
            border-radius: 8px;
            text-decoration: none;
            display: inline-block;
            cursor: pointer;
            font-family: inherit;
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <a href="/" class="logo">
              <span class="logo-dot"></span>
              <span>Dashboard</span>
            </a>
            <a href="/logout" class="btn-small btn-outline">Logout</a>
          </div>

          <div class="card">
            <h2>Your Live Preview</h2>
            <div class="preview-container">
              ${widgetHtml}
            </div>
            <p style="font-size: 14px; color: var(--text-dim); text-align: center;">Play a track on ${providerMeta.name} to see live updates.</p>
            <p style="font-size: 12px; color: #fbbf24; text-align: center; margin-top: -10px;">Note: GitHub caches images for a few minutes. Updates may not be instantaneous on your profile.</p>
            
            <div class="credentials-info">
              <svg style="width: 18px; height: 18px; fill: var(--accent);" viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 6c1.4 0 2.5 1.1 2.5 2.5S13.4 12 12 12s-2.5-1.1-2.5-2.5S10.6 7 12 7zm0 10c-2.3 0-4.3-1.1-5.6-2.8.2-1.3 2.7-2.2 5.6-2.2s5.4.9 5.6 2.2C16.3 15.9 14.3 17 12 17z"/></svg>
              <span>${connectionLabel}</span>
            </div>
          </div>

          <div class="card">
            <h2>Embed Your Widget</h2>
            
            <div class="snippet-group">
              <span class="snippet-label">Markdown (for GitHub Profile Readme)</span>
              <div class="snippet-box" onclick="copyToClipboard(this)">
                <span class="snippet-content">[![${providerMeta.name} Now Playing](${widgetUrl})](${widgetUrl})</span>
                <span class="copy-hint">Click to copy</span>
              </div>
            </div>

            <div class="snippet-group">
              <span class="snippet-label">HTML Embed</span>
              <div class="snippet-box" onclick="copyToClipboard(this)">
                <span class="snippet-content">
                  &lt;a href="${widgetUrl}" target="_blank"&gt;
                    &lt;img src="${widgetUrl}" alt="${providerMeta.name} Now Playing" /&gt;
                  &lt;/a&gt;
                </span>
                <span class="copy-hint">Click to copy</span>
              </div>
            </div>

            <div class="snippet-group">
              <span class="snippet-label">Direct Link (Embed in pages)</span>
              <div class="snippet-box" onclick="copyToClipboard(this)">
                <span class="snippet-content">${widgetUrl}</span>
                <span class="copy-hint">Click to copy</span>
              </div>
            </div>
          </div>

          <div class="card">
            <h2>Manage Access</h2>
            <p style="font-size: 14px; color: var(--text-dim); margin-bottom: 20px;">
              Your connection credentials are stored in our database only to facilitate this service. 
              Revoking access will permanently delete your credentials and tokens from our records.
            </p>
            <div class="management-actions">
              <form action="/revoke" method="POST" onsubmit="return confirm('Are you sure you want to revoke access? This will permanently delete your stored credentials and you will need to reconnect.')">
                <button type="submit" class="btn-small btn-danger">Revoke Access & Delete Data</button>
              </form>
            </div>
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
