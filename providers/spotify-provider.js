'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ACCOUNTS_URL = 'https://accounts.spotify.com';
const API_URL = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function mapTrack(track) {
  if (!track) return null;
  const artists = Array.isArray(track.artists)
    ? track.artists.map(function (artist) { return { id: artist.id || '', name: artist.name || '', uri: artist.uri || '' }; })
    : [];
  const images = track.album && Array.isArray(track.album.images) ? track.album.images : [];
  return {
    id: track.id || '',
    name: track.name || 'Spotify Track',
    artist: artists.map(function (artist) { return artist.name; }).filter(Boolean).join(' / '),
    artists: artists,
    album: track.album && track.album.name || '',
    cover: images[0] && images[0].url || '',
    duration: Number(track.duration_ms) || 0,
    durationMs: Number(track.duration_ms) || 0,
    explicit: !!track.explicit,
    playable: track.is_playable !== false,
    provider: 'spotify',
    source: 'spotify',
    type: 'spotify',
    uri: track.uri || (track.id ? 'spotify:track:' + track.id : ''),
    spotifyUrl: track.external_urls && track.external_urls.spotify || '',
  };
}

function mapPlaylist(item) {
  if (!item) return null;
  const images = Array.isArray(item.images) ? item.images : [];
  return {
    id: item.id || '',
    name: item.name || 'Spotify Playlist',
    description: item.description || '',
    cover: images[0] && images[0].url || '',
    trackCount: item.items && item.items.total || item.tracks && item.tracks.total || 0,
    owner: item.owner && (item.owner.display_name || item.owner.id) || '',
    uri: item.uri || '',
    spotifyUrl: item.external_urls && item.external_urls.spotify || '',
    provider: 'spotify',
  };
}

function callbackHtml(ok, message) {
  const title = ok ? 'Spotify 已连接' : 'Spotify 连接失败';
  const color = ok ? '#1ed760' : '#ff6b77';
  const safe = String(message || '').replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#07090b;color:#f7faf8;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(440px,calc(100vw - 48px));padding:34px;border:1px solid rgba(255,255,255,.12);border-radius:24px;background:rgba(255,255,255,.055);box-shadow:0 24px 80px rgba(0,0,0,.5);text-align:center}.dot{width:12px;height:12px;border-radius:50%;margin:0 auto 18px;background:' + color + ';box-shadow:0 0 28px ' + color + '}h1{margin:0 0 10px;font-size:22px}p{margin:0;color:rgba(255,255,255,.62);line-height:1.6}</style></head><body><main class="card"><div class="dot"></div><h1>' + title + '</h1><p>' + safe + '</p><p style="margin-top:16px">现在可以关闭此页面并返回 Mineradio。</p></main></body></html>';
}

function createSpotifyProvider(options) {
  const authFile = options.authFile;
  const port = Number(options.port) || 3000;
  const sendJSON = options.sendJSON;
  let auth = { clientId: '', accessToken: '', refreshToken: '', expiresAt: 0, scope: '' };
  let pending = null;

  try { auth = Object.assign(auth, JSON.parse(fs.readFileSync(authFile, 'utf8'))); } catch (_) { }
  if (!auth.clientId && process.env.SPOTIFY_CLIENT_ID) auth.clientId = String(process.env.SPOTIFY_CLIENT_ID).trim();

  function redirectUri() { return 'http://127.0.0.1:' + port + '/api/spotify/callback'; }
  function save() {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify(auth, null, 2), 'utf8');
  }
  function config() {
    const id = String(auth.clientId || '');
    return {
      configured: !!id,
      clientIdMasked: id ? id.slice(0, 5) + '••••••' + id.slice(-4) : '',
      redirectUri: redirectUri(),
      dashboardRedirectUri: redirectUri(),
      policyMode: 'connect-companion',
    };
  }
  function clearTokens() {
    auth.accessToken = '';
    auth.refreshToken = '';
    auth.expiresAt = 0;
    auth.scope = '';
    pending = null;
    save();
  }
  async function timedFetch(url, fetchOptions) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 15000);
    try { return await fetch(url, Object.assign({}, fetchOptions || {}, { signal: controller.signal })); }
    finally { clearTimeout(timer); }
  }
  async function exchangeToken(params) {
    const response = await timedFetch(ACCOUNTS_URL + '/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      const error = new Error(payload.error_description || payload.error || 'Spotify 授权失败');
      error.status = response.status;
      throw error;
    }
    auth.accessToken = payload.access_token || auth.accessToken;
    auth.refreshToken = payload.refresh_token || auth.refreshToken;
    auth.scope = payload.scope || auth.scope;
    auth.expiresAt = Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000;
    save();
  }
  async function accessToken() {
    if (auth.accessToken && Date.now() < Number(auth.expiresAt || 0) - 45000) return auth.accessToken;
    if (!auth.clientId || !auth.refreshToken) {
      const error = new Error('请先连接 Spotify');
      error.status = 401;
      error.code = 'SPOTIFY_LOGIN_REQUIRED';
      throw error;
    }
    await exchangeToken({ client_id: auth.clientId, grant_type: 'refresh_token', refresh_token: auth.refreshToken });
    return auth.accessToken;
  }
  async function api(endpoint, apiOptions, retry) {
    const token = await accessToken();
    const request = apiOptions || {};
    const response = await timedFetch(API_URL + endpoint, Object.assign({}, request, {
      headers: Object.assign({ Authorization: 'Bearer ' + token }, request.headers || {}),
    }));
    if (response.status === 401 && retry !== false && auth.refreshToken) {
      auth.expiresAt = 0;
      return api(endpoint, apiOptions, false);
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      const error = new Error(payload && payload.error && payload.error.message || 'Spotify 请求失败 (' + response.status + ')');
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after') || '';
      throw error;
    }
    return payload;
  }
  async function status() {
    const publicConfig = config();
    if (!publicConfig.configured || (!auth.accessToken && !auth.refreshToken)) return Object.assign(publicConfig, { loggedIn: false });
    try {
      const profile = await api('/me');
      return Object.assign(publicConfig, {
        loggedIn: true,
        profile: {
          id: profile.id || '',
          name: profile.display_name || profile.id || 'Spotify User',
          avatar: profile.images && profile.images[0] && profile.images[0].url || '',
          product: profile.product || '',
          country: profile.country || '',
        },
      });
    } catch (error) {
      if (error.status === 400 || error.status === 401) clearTokens();
      return Object.assign(publicConfig, { loggedIn: false, error: error.message });
    }
  }
  function beginLogin() {
    if (!auth.clientId) {
      const error = new Error('请先填写 Spotify Client ID');
      error.status = 400;
      throw error;
    }
    const verifier = base64url(crypto.randomBytes(64));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    pending = { verifier: verifier, state: state, createdAt: Date.now() };
    const authorize = new URL(ACCOUNTS_URL + '/authorize');
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: auth.clientId, scope: SCOPES, redirect_uri: redirectUri(), state: state,
      code_challenge_method: 'S256', code_challenge: challenge, show_dialog: 'true',
    }).toString();
    return { authorizeUrl: authorize.toString(), redirectUri: redirectUri() };
  }
  async function finishLogin(url) {
    if (url.searchParams.get('error')) throw new Error('用户取消了 Spotify 授权');
    const request = pending;
    pending = null;
    if (!request || Date.now() - request.createdAt > 10 * 60 * 1000) throw new Error('Spotify 登录请求已过期，请重新连接');
    if (url.searchParams.get('state') !== request.state) throw new Error('Spotify 登录状态校验失败');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('Spotify 未返回授权码');
    await exchangeToken({ client_id: auth.clientId, grant_type: 'authorization_code', code: code, redirect_uri: redirectUri(), code_verifier: request.verifier });
  }
  async function pickDevice() {
    const payload = await api('/me/player/devices');
    const devices = Array.isArray(payload.devices) ? payload.devices : [];
    const usable = devices.filter(function (device) {
      return device && device.id && !device.is_restricted;
    });
    if (!usable.length) {
      const error = new Error('No active Spotify device. Open Spotify desktop/mobile and play any song once, then try again.');
      error.status = 404;
      error.code = 'NO_ACTIVE_DEVICE';
      throw error;
    }
    return usable.find(function (device) {
      return device.is_active;
    }) || usable[0];
  }
  async function playback() {
    const state = await api('/me/player?additional_types=track,episode');
    if (!state) return { active: false, isPlaying: false };
    return {
      active: true,
      isPlaying: !!state.is_playing,
      progressMs: Number(state.progress_ms) || 0,
      durationMs: state.item && Number(state.item.duration_ms) || 0,
      track: state.item && state.item.type === 'track' ? mapTrack(state.item) : null,
      itemType: state.item && state.item.type || '',
      device: state.device ? { id: state.device.id || '', name: state.device.name || 'Spotify Device', type: state.device.type || '', restricted: !!state.device.is_restricted } : null,
    };
  }
  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (pathname.indexOf('/api/spotify/') !== 0) return false;
    try {
      if (pathname === '/api/spotify/config' && req.method === 'GET') sendJSON(res, config());
      else if (pathname === '/api/spotify/config' && req.method === 'POST') {
        const body = await options.readBody(req);
        const clientId = String(body.clientId || '').trim();
        if (!/^[A-Za-z0-9]{16,64}$/.test(clientId)) { const error = new Error('Spotify Client ID 格式无效'); error.status = 400; throw error; }
        if (clientId !== auth.clientId) clearTokens();
        auth.clientId = clientId;
        save();
        sendJSON(res, Object.assign({ ok: true }, config()));
      } else if (pathname === '/api/spotify/login' && req.method === 'GET') sendJSON(res, beginLogin());
      else if (pathname === '/api/spotify/callback' && req.method === 'GET') {
        try { await finishLogin(url); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(callbackHtml(true, '授权信息已安全保存到本机。')); }
        catch (error) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(callbackHtml(false, error.message)); }
      } else if (pathname === '/api/spotify/status' && req.method === 'GET') sendJSON(res, await status());
      else if (pathname === '/api/spotify/logout' && req.method === 'POST') { clearTokens(); sendJSON(res, Object.assign({ ok: true, loggedIn: false }, config())); }
      else if (pathname === '/api/spotify/search' && req.method === 'GET') {
        const query = String(url.searchParams.get('keywords') || '').trim();
        const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 12));
        const payload = query ? await api('/search?type=track&limit=' + limit + '&q=' + encodeURIComponent(query)) : { tracks: { items: [] } };
        sendJSON(res, { provider: 'spotify', songs: (payload.tracks && payload.tracks.items || []).map(mapTrack).filter(Boolean) });
      } else if (pathname === '/api/spotify/library/tracks' && req.method === 'GET') {
        const payload = await api('/me/tracks?limit=50&market=from_token');
        sendJSON(res, { provider: 'spotify', songs: (payload.items || []).map(function (item) { return mapTrack(item.track); }).filter(Boolean), total: Number(payload.total) || 0 });
      } else if (pathname === '/api/spotify/library/playlists' && req.method === 'GET') {
        const payload = await api('/me/playlists?limit=50');
        sendJSON(res, { provider: 'spotify', playlists: (payload.items || []).map(mapPlaylist).filter(Boolean) });
      } else if (pathname === '/api/spotify/library/playlist-tracks' && req.method === 'GET') { const id = String(url.searchParams.get('id') || '').replace(/^spotify:playlist:/, '').trim(); if (!id) { const error = new Error('缺少 Spotify 歌单 ID'); error.status = 400; throw error; } const payload = await api('/playlists/' + encodeURIComponent(id) + '/tracks?limit=100&market=from_token'); sendJSON(res, { provider: 'spotify', tracks: (payload.items || []).map(function (item) { return mapTrack(item && item.track); }).filter(Boolean), total: Number(payload.total) || 0 }); 
      } else if (pathname === '/api/spotify/library/playlist-tracks' && req.method === 'GET') { const id = String(url.searchParams.get('id') || '').replace(/^spotify:playlist:/, '').replace(/^spotify:/, '').replace(/^playlist:/, '').trim(); if (!id) { const error = new Error('缺少 Spotify 歌单 ID'); error.status = 400; throw error; } const payload = await api('/playlists/' + encodeURIComponent(id) + '/tracks?limit=100&market=from_token'); sendJSON(res, { provider: 'spotify', tracks: (payload.items || []).map(function (item) { return mapTrack(item && item.track); }).filter(Boolean), total: Number(payload.total) || 0 }); 
      } else if (pathname === '/api/spotify/player' && req.method === 'GET') sendJSON(res, await playback());
      else if (pathname === '/api/spotify/player/play' && req.method === 'POST') {
        const body = await options.readBody(req);
        const device = await pickDevice();
        const uris = Array.isArray(body.uris) ? body.uris.map(String).filter(function (uri) { return uri.indexOf('spotify:track:') === 0; }).slice(0, 50) : [];
        if (!uris.length) { const error = new Error('缺少 Spotify 播放内容'); error.status = 400; throw error; }
        await api('/me/player', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_ids: [device.id], play: true }) });
        await api('/me/player/play?device_id=' + encodeURIComponent(device.id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uris: uris, position_ms: Math.max(0, Number(body.positionMs) || 0) }) });
        sendJSON(res, { ok: true });
      } else if (pathname === '/api/spotify/player/pause' && req.method === 'POST') { await api('/me/player/pause', { method: 'PUT' }); sendJSON(res, { ok: true }); }
      else if (pathname === '/api/spotify/player/resume' && req.method === 'POST') { await api('/me/player/play', { method: 'PUT' }); sendJSON(res, { ok: true }); }
      else if (pathname === '/api/spotify/player/next' && req.method === 'POST') { await api('/me/player/next', { method: 'POST' }); sendJSON(res, { ok: true }); }
      else if (pathname === '/api/spotify/player/previous' && req.method === 'POST') { await api('/me/player/previous', { method: 'POST' }); sendJSON(res, { ok: true }); }
      else if (pathname === '/api/spotify/player/seek' && req.method === 'POST') { const body = await options.readBody(req); await api('/me/player/seek?position_ms=' + Math.max(0, Math.round(Number(body.positionMs) || 0)), { method: 'PUT' }); sendJSON(res, { ok: true }); }
      else sendJSON(res, { error: 'Spotify endpoint not found' }, 404);
      return true;
    } catch (error) {
      sendJSON(res, { error: error.message || 'Spotify 请求失败', code: error.code || '', retryAfter: error.retryAfter || '' }, Number(error.status) || 500);
      return true;
    }
  }
  return { handle: handle, status: status, config: config };
}

module.exports = { createSpotifyProvider: createSpotifyProvider, mapTrack: mapTrack };
