import { NowPlayingData, PROVIDERS } from './types';

const truncate = (str: string, n: number) => {
  return str.length > n ? str.slice(0, n - 1) + '...' : str;
};

const escapeHtml = (unsafe: string) => {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const FONT_STACK = "'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const getSVGTemplate = (data: NowPlayingData | null, albumArtBase64?: string | null) => {
  const width = 350;
  const height = 114;

  if (!data) {
    return `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="${width}" height="${height}" rx="16" fill="#121212" />
        <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="15.5" stroke="white" stroke-opacity="0.1" />
        <text fill="#A7A7A7" font-family="${FONT_STACK}" font-size="14" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">Not playing anything</text>
      </svg>
    `;
  }

  const { trackName: rawTrack, artistName: rawArtist, albumArtUrl, isPlaying, isFallback, provider } = data;
  const accentColor = PROVIDERS[provider]?.color || '#1DB954';
  const rawTrackName = escapeHtml(rawTrack);
  const rawArtistName = escapeHtml(rawArtist);
  const trackName = escapeHtml(truncate(rawTrack, 25));
  const artistName = escapeHtml(truncate(rawArtist, 30));
  const albumArt = albumArtBase64 || albumArtUrl;
  const statusLabel = isFallback ? 'Recently Played' : (isPlaying ? 'Currently Playing' : 'Paused');
  const statusColor = isFallback ? '#A7A7A7' : accentColor;

  const albumArtElement = albumArt
    ? `<image href="${escapeHtml(albumArt)}" x="16" y="17" width="80" height="80" clip-path="url(#albumArtClip)" preserveAspectRatio="xMidYMid slice" />`
    : `
      <rect x="16" y="17" width="80" height="80" rx="12" fill="#1E1E1E" />
      <path d="M64 42v20.5a5.5 5.5 0 1 1-3-4.9V47l-11 2.6v15.9a5.5 5.5 0 1 1-3-4.9V45.5l17-4.5z" fill="#555555" />
    `;

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&amp;display=swap');
        .track-name { font: 600 16px ${FONT_STACK}; fill: white; }
        .artist-name { font: 400 14px ${FONT_STACK}; fill: #b3b3b3; }
        .status-text { font: 600 11px ${FONT_STACK}; fill: ${statusColor}; text-transform: uppercase; letter-spacing: 0.1em; }
        
        .bars-container { display: ${isPlaying ? 'block' : 'none'}; }
        .bar { 
          fill: ${accentColor}; 
          animation: equalize 1s infinite; 
          transform-origin: bottom;
          transform-box: fill-box;
        }
        .bar:nth-child(1) { animation-delay: 0.1s; }
        .bar:nth-child(2) { animation-delay: 0.3s; }
        .bar:nth-child(3) { animation-delay: 0.5s; }
        .bar:nth-child(4) { animation-delay: 0.2s; }

        @keyframes equalize {
          0% { transform: scaleY(0.3); }
          50% { transform: scaleY(1); }
          100% { transform: scaleY(0.3); }
        }

        .fade-in { animation: fadeIn 0.8s ease-out forwards; opacity: 0; }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .pulse { animation: pulse 2s infinite; display: ${!isPlaying ? 'block' : 'none'}; }
        @keyframes pulse {
          0% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.1); }
          100% { opacity: 1; transform: scale(1); }
        }
      </style>
      
      <g class="fade-in">
        <rect width="${width}" height="${height}" rx="16" fill="#121212" />
        <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="15.5" stroke="white" stroke-opacity="0.1" />
        
        <clipPath id="albumArtClip">
          <rect x="16" y="17" width="80" height="80" rx="12" />
        </clipPath>
        
        <clipPath id="textClip">
          <rect x="0" y="-16" width="222" height="65" />
        </clipPath>
        
        ${albumArtElement}
        
        <g transform="translate(112, 35)">
          <g clip-path="url(#textClip)">
            <text class="track-name" x="0" y="0"><title>${rawTrackName}</title>${trackName}</text>
            <text class="artist-name" x="0" y="22"><title>${rawArtistName}</title>${artistName}</text>
          </g>
          
          <g transform="translate(0, 40)">
            ${isPlaying ? `
              <g class="bars-container" transform="translate(0, 1)">
                <rect class="bar" x="0" y="0" width="3" height="12" rx="1.5" />
                <rect class="bar" x="5" y="0" width="3" height="12" rx="1.5" />
                <rect class="bar" x="10" y="0" width="3" height="12" rx="1.5" />
                <rect class="bar" x="15" y="0" width="3" height="12" rx="1.5" />
              </g>
            ` : `
              <circle class="pulse" cx="4" cy="7" r="4" fill="${statusColor}" style="transform-origin: 4px 7px;" />
            `}
            <text class="status-text" x="${isPlaying ? 24 : 16}" y="11">${statusLabel}</text>
          </g>
        </g>
      </g>
    </svg>
  `;
};

export const getTemplate = (data: NowPlayingData | null) => {
  if (!data) {
    return `
      <div id="music-widget" style="font-family: ${FONT_STACK}; background: #121212; color: #fff; padding: 20px; border-radius: 12px; width: 300px; display: flex; align-items: center; justify-content: center; border: 1px solid #333;">
        <p style="margin: 0; font-size: 14px; color: #b3b3b3;">Not playing anything</p>
      </div>
    `;
  }

  const { trackName: rawTrack, artistName: rawArtist, albumArtUrl, trackUrl, isPlaying, isFallback, provider } = data;
  const accentColor = PROVIDERS[provider]?.color || '#1DB954';
  const trackName = escapeHtml(rawTrack);
  const artistName = escapeHtml(rawArtist);
  const statusLabel = isFallback ? 'Recently Played' : (isPlaying ? 'Currently Playing' : 'Paused');
  const statusColor = isFallback ? '#A7A7A7' : accentColor;
  const tag = trackUrl ? 'a' : 'div';
  const hrefAttr = trackUrl ? `href="${escapeHtml(trackUrl)}" target="_blank"` : '';

  return `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&display=swap');
      #music-widget {
        font-family: ${FONT_STACK};
        background: rgba(18, 18, 18, 0.8);
        backdrop-filter: blur(10px);
        color: #fff;
        padding: 16px;
        border-radius: 16px;
        width: 350px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 16px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        text-decoration: none;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        animation: slideUp 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      @keyframes slideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #music-widget:hover {
        transform: translateY(-4px);
        box-shadow: 0 12px 40px rgba(0,0,0,0.6);
        border-color: ${statusColor};
        background: rgba(24, 24, 24, 0.9);
      }
      .album-art {
        width: 80px;
        height: 80px;
        border-radius: 12px;
        object-fit: cover;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        flex-shrink: 0;
        background: #1e1e1e;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .track-info {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        flex: 1;
        min-width: 0;
      }
      .track-name {
        font-size: 16px;
        font-weight: 600;
        margin: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: #fff;
        letter-spacing: -0.01em;
      }
      .artist-name {
        font-size: 14px;
        color: #b3b3b3;
        margin: 4px 0 0 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .status {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        background: ${statusColor};
        border-radius: 50%;
        box-shadow: 0 0 12px ${statusColor}66;
        animation: pulse 2s infinite;
      }
      .status-text {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: ${statusColor};
        font-weight: 600;
      }
      .audio-bars {
        display: ${isPlaying ? 'flex' : 'none'};
        align-items: flex-end;
        gap: 2px;
        height: 12px;
      }
      .audio-bars div {
        width: 3px;
        background: ${accentColor};
        animation: equalize 1s infinite;
        border-radius: 1px;
      }
      @keyframes equalize {
        0% { height: 4px; }
        50% { height: 12px; }
        100% { height: 4px; }
      }
      @keyframes pulse {
        0% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.1); }
        100% { opacity: 1; transform: scale(1); }
      }
    </style>
    <${tag} id="music-widget" ${hrefAttr}>
      ${
        albumArtUrl
          ? `<img src="${escapeHtml(albumArtUrl)}" class="album-art" alt="Album Art">`
          : `<div class="album-art"><svg width="32" height="32" viewBox="0 0 24 24" fill="#555"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`
      }
      <div class="track-info">
        <p class="track-name" title="${trackName}">${trackName}</p>
        <p class="artist-name" title="${artistName}">${artistName}</p>
        <div class="status">
          ${isPlaying ? `
            <div class="audio-bars">
              <div style="animation-delay: 0.1s"></div>
              <div style="animation-delay: 0.3s"></div>
              <div style="animation-delay: 0.5s"></div>
              <div style="animation-delay: 0.2s"></div>
            </div>
          ` : `
            <div class="status-dot"></div>
          `}
          <span class="status-text">${statusLabel}</span>
        </div>
      </div>
    </${tag}>
  `;
};
