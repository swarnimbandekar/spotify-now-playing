import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { getNowPlaying, getImageBase64, invalidateCache, getUserConnections } from './providers';
import { getSpotifyAuthUrl, getSpotifyTokens, getSpotifyProfile } from './providers/spotify';
import {
  saveProviderConnection,
  getUser,
  getUserByProviderId,
  deleteUser,
} from './storage';
import { getTemplate, getSVGTemplate } from './template';
import { ProviderConnection, UserData } from './types';

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

const hasServerCredentials = (): boolean => {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_SECRET_ID);
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

const SPOTIFY_ICON = `<svg class="spotify-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zm5.508 17.303c-.216.354-.675.466-1.03.25-2.853-1.743-6.444-2.138-10.673-1.172-.406.092-.813-.16-.904-.565-.092-.406.161-.813.566-.905 4.633-1.06 8.583-.615 11.79 1.344.355.216.467.675.251 1.03zm1.48-3.26c-.272.443-.848.583-1.291.31-3.262-2.004-8.23-2.585-12.086-1.414-.498.151-1.025-.13-1.176-.628-.151-.498.13-1.025.628-1.176 4.417-1.34 9.878-.68 13.616 1.616.442.272.583.848.31 1.291zm.128-3.4c-3.912-2.323-10.363-2.537-14.126-1.396-.6.182-1.234-.162-1.416-.763-.182-.6.162-1.233.763-1.415 4.316-1.31 11.439-1.062 15.968 1.625.539.319.718 1.018.399 1.556-.32.538-1.019.718-1.557.399z"/></svg>`;

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
  const spotifyHasServer = hasServerCredentials();

  res.send(`
    <html>
      <head>
        <title>Spotify Now Playing</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap');
          :root {
            --spotify-green: #1DB954;
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
            padding: 24px 16px;
            box-sizing: border-box;
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
          }
          .container { 
            text-align: center; 
            background: rgba(18, 18, 18, 0.7); 
            padding: 40px; 
            border-radius: 32px; 
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 24px 64px rgba(0,0,0,0.6);
            max-width: 440px;
            width: 100%;
            box-sizing: border-box;
          }
          .icon-container { margin-bottom: 24px; }
          .spotify-icon { width: 48px; height: 48px; fill: var(--spotify-green); }
          h1 { margin: 0 0 12px 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
          p { margin: 0 0 28px 0; color: var(--text-dim); line-height: 1.6; font-size: 15px; }
          .form-group { text-align: left; margin-bottom: 18px; }
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
          input:focus { outline: none; border-color: var(--spotify-green); }
          .btn { 
            width: 100%;
            background: var(--spotify-green); 
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
          .btn:hover { background: #1ed760; transform: translateY(-2px); }
          .info-box {
            background: rgba(29, 185, 84, 0.1);
            border: 1px solid rgba(29, 185, 84, 0.2);
            padding: 14px;
            border-radius: 12px;
            margin-bottom: 20px;
            font-size: 13px;
            text-align: left;
            color: #1ed760;
            word-break: break-all;
          }
          .status-msg {
            margin-top: 14px;
            font-size: 13px;
            color: var(--spotify-green);
            min-height: 18px;
          }
          .setup-guide {
            text-align: left;
            margin-top: 24px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 16px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.1);
          }
          .setup-guide summary {
            padding: 16px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            color: var(--text-dim);
            list-style: none;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .setup-guide summary::before { content: '→'; transition: transform 0.2s; }
          .setup-guide[open] summary::before { transform: rotate(90deg); }
          .setup-content {
            padding: 0 16px 16px 16px;
            font-size: 13px;
            color: var(--text-dim);
            line-height: 1.6;
          }
          .setup-content ol { padding-left: 20px; margin: 10px 0; }
          .setup-content li { margin-bottom: 8px; }
          .setup-content strong { color: var(--spotify-green); }
          footer { margin-top: 32px; font-size: 14px; color: var(--text-dim); }
        </style>
      </head>
      <body>
        <div class="background-glow"></div>
        <div class="container">
          <div class="icon-container">${SPOTIFY_ICON}</div>
          <h1>Spotify Now Playing</h1>
          <p>Create a live Spotify SVG widget for your GitHub profile using your own Spotify App credentials.</p>

          <div class="info-box">
            Add <strong>${redirectUri}</strong> as a Redirect URI in your Spotify App.
          </div>

          <form action="/auth/spotify" method="POST" onsubmit="return handleOAuthSubmit(event)">
            <input type="hidden" name="popup" value="1">
            <div class="form-group">
              <label for="clientId">Spotify Client ID ${spotifyHasServer ? '(Optional)' : ''}</label>
              <input type="text" id="clientId" name="clientId" placeholder="Enter your Client ID" ${spotifyHasServer ? '' : 'required'}>
            </div>
            <div class="form-group">
              <label for="clientSecret">Spotify Client Secret ${spotifyHasServer ? '(Optional)' : ''}</label>
              <input type="password" id="clientSecret" name="clientSecret" placeholder="Enter your Client Secret" ${spotifyHasServer ? '' : 'required'}>
            </div>
            <button type="submit" class="btn">Connect Spotify</button>
          </form>

          <div class="status-msg" id="statusMsg"></div>

          <div style="margin-top: 16px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
            <p style="margin: 0;">🔒 <strong>Privacy Note:</strong> Your credentials are stored securely and used only to fetch your music activity. You can revoke access anytime from your dashboard.</p>
          </div>

          <details class="setup-guide">
            <summary>How to set up your Spotify App</summary>
            <div class="setup-content">
              <ol>
                <li>Visit the <a href="https://developer.spotify.com/dashboard" target="_blank" style="color: var(--spotify-green);">Spotify Developer Dashboard</a>.</li>
                <li>Click <strong>Create app</strong> and give it a name and description.</li>
                <li>Go to <strong>Settings</strong> and add the Redirect URI:<br>
                <code style="background: #000; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 4px; border: 1px solid #333; word-break: break-all;">${redirectUri}</code></li>
                <li>Click <strong>Save</strong> and copy your <strong>Client ID</strong> and <strong>Client Secret</strong> above.</li>
              </ol>
            </div>
          </details>
        </div>

        <footer>
          By <a href="https://swarnimbandekar.in" target="_blank" style="color: white; text-decoration: none; font-weight: 600;">swarnimbandekar</a> | <a href="https://github.com/swarnimbandekar/spotify-now-playing" target="_blank" style="color: var(--text-dim); text-decoration: none;">Source Code</a>
        </footer>

        <script>
          function handleOAuthSubmit(event) {
            const form = event.target;
            const status = document.getElementById('statusMsg');
            const popupName = 'oauth_spotify';
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
            status.textContent = 'Complete authorization in the Spotify popup...';

            const pollClosed = setInterval(() => {
              if (popup.closed) {
                clearInterval(pollClosed);
                if (status.textContent.startsWith('Complete')) {
                  status.textContent = '';
                }
              }
            }, 500);

            return true;
          }

          window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin) return;
            if (event.data && event.data.type === 'oauth-success' && event.data.uid) {
              document.getElementById('statusMsg').textContent = 'Connected! Loading your widget...';
              window.location.href = '/dashboard?uid=' + encodeURIComponent(event.data.uid);
            }
          });
        </script>
      </body>
    </html>
  `);
});

const startSpotifyAuth = (req: express.Request, res: express.Response) => {
  const bodyClientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
  const bodyClientSecret = typeof req.body?.clientSecret === 'string' ? req.body.clientSecret.trim() : '';

  const clientId = bodyClientId || process.env.SPOTIFY_CLIENT_ID || '';
  const clientSecret = bodyClientSecret || process.env.SPOTIFY_SECRET_ID || '';

  if (!clientId || !clientSecret) {
    return res.status(400).send('Spotify Client ID and Client Secret are required.');
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
  res.cookie('oauth_popup', isPopup ? '1' : '0', cookieOptions);
  if (bodyClientId && bodyClientSecret) {
    res.cookie('temp_client_id', bodyClientId, cookieOptions);
    res.cookie('temp_client_secret', bodyClientSecret, cookieOptions);
  } else {
    res.clearCookie('temp_client_id');
    res.clearCookie('temp_client_secret');
  }

  res.redirect(getSpotifyAuthUrl(state, getRedirectUri(req), clientId));
};

app.get('/auth/spotify', startSpotifyAuth);
app.post('/auth/spotify', startSpotifyAuth);
app.post('/login', startSpotifyAuth);

app.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const {
    oauth_state,
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

  const isPopup = oauth_popup === '1';

  res.clearCookie('oauth_state');
  res.clearCookie('oauth_popup');
  res.clearCookie('temp_client_id');
  res.clearCookie('temp_client_secret');

  try {
    const redirectUri = getRedirectUri(req);
    const tokens = await getSpotifyTokens(code as string, redirectUri, userClientId, userClientSecret);
    const profile = await getSpotifyProfile(tokens.access_token);
    const providerUserId = profile.id;
    const displayName = profile.display_name || profile.id;

    const existingUser = await getUserByProviderId('spotify', providerUserId);
    const uid = existingUser ? existingUser.uid : crypto.randomBytes(5).toString('hex');
    const prevConn = getUserConnections(existingUser).spotify;

    const connection: ProviderConnection = {
      providerUserId,
      displayName,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || prevConn?.refreshToken || '',
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      ...(userClientId && userClientSecret
        ? { clientId: userClientId, clientSecret: userClientSecret }
        : prevConn?.clientId && prevConn?.clientSecret
          ? { clientId: prevConn.clientId, clientSecret: prevConn.clientSecret }
          : {}),
    };

    await saveProviderConnection(uid, 'spotify', connection, displayName);
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
            <p>Connected! Redirecting...</p>
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

app.get('/dashboard', async (req, res) => {
  const uid = (req.query.uid as string) || req.signedCookies.uid;
  if (!uid) return res.redirect('/');

  const user = await getUser(uid);
  const conn = getUserConnections(user).spotify;
  const nowPlaying = await getNowPlaying(uid);
  const widgetHtml = getTemplate(nowPlaying);

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const baseUrl = `${protocol}://${req.get('host')}`;
  const widgetUrl = `${baseUrl}/now-playing?uid=${uid}`;

  const connectionLabel = conn
    ? `Connected as <strong>${escapeHtml(conn.displayName)}</strong>${conn.clientId ? ` (App: <strong>${maskSecret(conn.clientId)}</strong>)` : ''}`
    : 'Not connected';

  res.send(`
    <html>
      <head>
        <title>Dashboard | Spotify Now Playing</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&display=swap');
          :root {
            --spotify-green: #1DB954;
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
          .container { max-width: 800px; width: 100%; }
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
          .logo .spotify-icon { width: 32px; height: 32px; fill: var(--spotify-green); }
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
          .snippet-label { font-size: 14px; color: var(--text-dim); margin-bottom: 8px; display: block; }
          .snippet-box {
            background: #000;
            border: 1px solid var(--border);
            padding: 16px;
            padding-right: 100px;
            border-radius: 12px;
            font-family: monospace;
            font-size: 13px;
            color: var(--spotify-green);
            word-break: break-all;
            position: relative;
            cursor: pointer;
            transition: border-color 0.2s;
            overflow: hidden;
          }
          .snippet-box:hover { border-color: var(--spotify-green); }
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
          .footer { text-align: center; margin-top: 40px; color: var(--text-dim); font-size: 14px; }
          .footer a { color: #fff; text-decoration: none; font-weight: 600; }
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
            <a href="/dashboard?uid=${uid}" class="logo">
              ${SPOTIFY_ICON}
              <span>Dashboard</span>
            </a>
            <a href="/logout" class="btn-small btn-outline">Logout</a>
          </div>

          <div class="card">
            <h2>Your Live Preview</h2>
            <div class="preview-container">
              ${widgetHtml}
            </div>
            <p style="font-size: 14px; color: var(--text-dim); text-align: center;">Make sure you have music playing on Spotify to see the live data.</p>
            <p style="font-size: 12px; color: #fbbf24; text-align: center; margin-top: -10px;">Note: GitHub caches images for a few minutes. Updates may not be instantaneous on your profile.</p>
            
            <div class="credentials-info">
              <svg style="width: 18px; height: 18px; fill: var(--spotify-green);" viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 6c1.4 0 2.5 1.1 2.5 2.5S13.4 12 12 12s-2.5-1.1-2.5-2.5S10.6 7 12 7zm0 10c-2.3 0-4.3-1.1-5.6-2.8.2-1.3 2.7-2.2 5.6-2.2s5.4.9 5.6 2.2C16.3 15.9 14.3 17 12 17z"/></svg>
              <span>${connectionLabel}</span>
            </div>
          </div>

          <div class="card">
            <h2>Embed Your Widget</h2>
            
            <div class="snippet-group">
              <span class="snippet-label">Markdown (for GitHub Profile Readme)</span>
              <div class="snippet-box" onclick="copyToClipboard(this)">
                <span class="snippet-content">[![Spotify Now Playing](${widgetUrl})](${widgetUrl})</span>
                <span class="copy-hint">Click to copy</span>
              </div>
            </div>

            <div class="snippet-group">
              <span class="snippet-label">HTML Embed</span>
              <div class="snippet-box" onclick="copyToClipboard(this)">
                <span class="snippet-content">
                  &lt;a href="${widgetUrl}" target="_blank"&gt;
                    &lt;img src="${widgetUrl}" alt="Spotify Now Playing" /&gt;
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
              Your Spotify credentials (Client ID and Secret) are stored in our database only to facilitate this service. 
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
