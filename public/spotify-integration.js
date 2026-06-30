(function () {
  'use strict';

  var state = {
    status: { configured: false, loggedIn: false },
    playback: { active: false, isPlaying: false, progressMs: 0, durationMs: 0 },
    currentSong: null,
    playbackAt: 0,
    pollTimer: 0,
    pollBusy: false,
    authTimer: 0,
  };

  var spotifyUserPlaybackUnlocked = false;

  function unlockSpotifyUserPlayback() {
    spotifyUserPlaybackUnlocked = true;
  }

  document.addEventListener('pointerdown', unlockSpotifyUserPlayback, true);
  document.addEventListener('keydown', unlockSpotifyUserPlayback, true);
  document.addEventListener('touchstart', unlockSpotifyUserPlayback, true);

  function toast(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
  }

  async function request(path, options) {
    var response = await fetch(path, Object.assign({ cache: 'no-store' }, options || {}));
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var error = new Error(data.error || 'Spotify 请求失败');
      error.status = response.status;
      error.code = data.code || '';
      throw error;
    }
    return data;
  }

  function post(path, body) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  function ensureUi() {
    if (!document.getElementById('spotify-status-btn')) {
      var account = document.getElementById('user-btn');
      var button = document.createElement('button');
      button.id = 'spotify-status-btn';
      button.className = 'icon-btn';
      button.type = 'button';
      button.title = 'Spotify Connect';
      button.textContent = 'SP';
      button.addEventListener('click', showSetup);
      if (account && account.parentNode) account.parentNode.insertBefore(button, account);
    }
    var loginTabs = document.getElementById('login-platform-tabs');
    if (loginTabs && !document.getElementById('login-provider-spotify')) {
      var loginButton = document.createElement('button');
      loginButton.id = 'login-provider-spotify';
      loginButton.className = 'spotify';
      loginButton.type = 'button';
      loginButton.textContent = 'Spotify';
      loginButton.addEventListener('click', function () {
        if (typeof window.closeLoginModal === 'function') window.closeLoginModal();
        showSetup();
      });
      loginTabs.appendChild(loginButton);
    }
    if (!document.getElementById('spotify-modal')) {
      var modal = document.createElement('div');
      modal.id = 'spotify-modal';
      modal.className = 'modal-mask';
      modal.innerHTML = '<div class="modal spotify-dialog" role="dialog" aria-modal="true" aria-label="Spotify Connect 设置">' +
        '<div class="spotify-head"><div class="spotify-brand"><div class="spotify-logo">SP</div><div><div class="spotify-title">Spotify Connect</div><div class="spotify-subtitle">搜索、资料、歌单与播放控制。Spotify 音频不会进入节拍分析器。</div></div></div><button class="spotify-close" type="button" aria-label="关闭">×</button></div>' +
        '<div class="spotify-section"><label class="spotify-label" for="spotify-client-id">Developer Client ID</label><div class="spotify-input-row"><input id="spotify-client-id" class="spotify-input" autocomplete="off" spellcheck="false" placeholder="粘贴 Spotify Client ID"><button id="spotify-save-config" class="spotify-btn" type="button">保存</button></div><div class="spotify-redirect"><span id="spotify-redirect-uri">正在读取回调地址…</span><button id="spotify-copy-redirect" class="spotify-btn" type="button">复制</button></div><div class="spotify-note">先在 Spotify Developer Dashboard 创建应用，把上面的地址加入 Redirect URIs。动态端口使用官方支持的 127.0.0.1 loopback 规则，不要填写 localhost。</div></div>' +
        '<div class="spotify-section"><div id="spotify-connection-status" class="spotify-status"><span class="spotify-status-dot"></span><span>尚未连接</span></div><div class="spotify-note" id="spotify-device-note">播放会发送到你当前活跃的 Spotify 设备；播放控制通常需要 Premium。</div></div>' +
        '<div class="spotify-actions"><button id="spotify-saved" class="spotify-btn" type="button">喜欢的音乐</button><button id="spotify-logout" class="spotify-btn danger" type="button">断开</button><button id="spotify-connect" class="spotify-btn primary" type="button">连接 Spotify</button></div>' +
        '</div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function (event) { if (event.target === modal || event.target.closest('.spotify-close')) hideSetup(); });
      document.getElementById('spotify-save-config').addEventListener('click', saveConfig);
      document.getElementById('spotify-connect').addEventListener('click', connect);
      document.getElementById('spotify-saved').addEventListener('click', loadSavedTracks);
      document.getElementById('spotify-logout').addEventListener('click', logout);
      document.getElementById('spotify-copy-redirect').addEventListener('click', copyRedirect);
    }
  }

  function renderStatus() {
    ensureUi();
    var statusButton = document.getElementById('spotify-status-btn');
    var statusLine = document.getElementById('spotify-connection-status');
    var input = document.getElementById('spotify-client-id');
    var redirect = document.getElementById('spotify-redirect-uri');
    var connectButton = document.getElementById('spotify-connect');
    var logoutButton = document.getElementById('spotify-logout');
    var profile = state.status.profile || {};
    if (statusButton) {
      statusButton.classList.toggle('connected', !!state.status.loggedIn);
      statusButton.title = state.status.loggedIn ? 'Spotify · ' + (profile.name || '已连接') : '连接 Spotify';
    }
    if (statusLine) {
      statusLine.classList.toggle('connected', !!state.status.loggedIn);
      statusLine.querySelector('span:last-child').textContent = state.status.loggedIn
        ? '已连接 · ' + (profile.name || 'Spotify User') + (profile.product ? ' · ' + profile.product : '')
        : (state.status.configured ? 'Client ID 已保存，等待授权' : '尚未配置 Spotify Client ID');
    }
    if (input) {
      input.placeholder = state.status.clientIdMasked || '粘贴 Spotify Client ID';
      if (state.status.loggedIn) input.value = '';
    }
    if (redirect) redirect.textContent = state.status.dashboardRedirectUri || state.status.redirectUri || '';
    if (connectButton) connectButton.textContent = state.status.loggedIn ? '重新授权' : '连接 Spotify';
    if (logoutButton) logoutButton.style.display = state.status.loggedIn ? '' : 'none';
  }

  async function refreshStatus(silent) {
    try {
      state.status = await request('/api/spotify/status?t=' + Date.now());
      renderStatus();
      if (state.status.loggedIn) startPolling();
      return state.status;
    } catch (error) {
      if (!silent) toast(error.message);
      return state.status;
    }
  }

  async function showSetup() {
    ensureUi();
    await refreshStatus(true);
    document.getElementById('spotify-modal').classList.add('show');
  }

  function hideSetup() {
    var modal = document.getElementById('spotify-modal');
    if (modal) modal.classList.remove('show');
  }

  async function saveConfig() {
    var input = document.getElementById('spotify-client-id');
    var clientId = String(input && input.value || '').trim();
    if (!clientId) { toast('请粘贴 Spotify Client ID'); return false; }
    try {
      state.status = await post('/api/spotify/config', { clientId: clientId });
      if (input) input.value = '';
      renderStatus();
      toast('Spotify Client ID 已保存在本机');
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  }

  async function connect() {
    var input = document.getElementById('spotify-client-id');
    if (input && String(input.value || '').trim()) {
      var saved = await saveConfig();
      if (!saved) return;
    }
    try {
      var login = await request('/api/spotify/login?t=' + Date.now());
      window.open(login.authorizeUrl, '_blank');
      toast('请在浏览器完成 Spotify 授权');
      if (state.authTimer) clearInterval(state.authTimer);
      var attempts = 0;
      state.authTimer = setInterval(async function () {
        attempts += 1;
        var status = await refreshStatus(true);
        if (status.loggedIn || attempts > 80) {
          clearInterval(state.authTimer);
          state.authTimer = 0;
          if (status.loggedIn) { toast('Spotify 已连接'); hideSetup(); }
        }
      }, 1500);
    } catch (error) {
      toast(error.message);
    }
  }

  async function logout() {
    try {
      state.status = await post('/api/spotify/logout');
      stopPolling();
      deactivate();
      renderStatus();
      toast('Spotify 已断开');
    } catch (error) { toast(error.message); }
  }

  function copyRedirect() {
    var value = state.status.dashboardRedirectUri || state.status.redirectUri || '';
    if (!value) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { toast('回调地址已复制'); }).catch(function () { toast('复制失败，请手动复制'); });
    }
  }

  async function loadSavedTracks() {
    var status = await refreshStatus(true);
    if (!status.loggedIn) { toast('请先连接 Spotify'); return; }
    try {
      var data = await request('/api/spotify/library/tracks?limit=100&t=' + Date.now());
      if (typeof window.setSearchMode === 'function') window.setSearchMode('spotify');
      if (typeof window.renderSongSearchResults === 'function') window.renderSongSearchResults(data.songs || []);
      var results = document.getElementById('search-results');
      var area = document.getElementById('search-area');
      if (results) results.classList.add('show');
      if (area) area.classList.add('peek');
      hideSetup();
      toast('已载入 Spotify 喜欢的音乐');
    } catch (error) { toast(error.message); }
  }

  async function search(query) {
    var status = await refreshStatus(true);
    if (!status.loggedIn) {
      showSetup();
      throw new Error(status.configured ? '请先完成 Spotify 授权' : '请先配置 Spotify Client ID');
    }
    var data = await request('/api/spotify/search?keywords=' + encodeURIComponent(query) + '&limit=5');
    return data.songs || [];
  }

  function isCurrent() {
    if (!state.currentSong) return false;
    var current = typeof window.currentCoverSong === 'function' ? window.currentCoverSong() : null;
    return !!(current && (current.provider === 'spotify' || current.source === 'spotify'));
  }

  function updateProgress() {
    if (!isCurrent()) return;
    var elapsed = state.playback.isPlaying && state.playbackAt ? Date.now() - state.playbackAt : 0;
    var progress = Math.min(Number(state.playback.durationMs) || 0, (Number(state.playback.progressMs) || 0) + elapsed);
    var duration = Number(state.playback.durationMs) || Number(state.currentSong && state.currentSong.durationMs) || 0;
    if (typeof window.setProgressVisual === 'function') window.setProgressVisual(duration > 0 ? progress / duration * 100 : 0);
    var display = document.getElementById('time-display');
    if (display && typeof window.formatProgramTime === 'function') display.textContent = window.formatProgramTime(progress / 1000) + ' / ' + window.formatProgramTime(duration / 1000);
  }

  function applyPlayback(playback) {
    var previousUri = state.currentSong && state.currentSong.uri || '';
    state.playback = playback || { active: false, isPlaying: false, progressMs: 0, durationMs: 0 };
    state.playbackAt = Date.now();
    if (state.playback.track && state.playback.track.uri && state.playback.track.uri !== previousUri && state.currentSong) {
      state.currentSong = state.playback.track;
      if (typeof window.syncSpotifyPlaybackTrack === 'function') {
        window.syncSpotifyPlaybackTrack(state.playback.track);
      }
    }
    if (!isCurrent()) return;
    window.playing = !!state.playback.isPlaying;
    if (typeof window.setPlayIcon === 'function') window.setPlayIcon(window.playing);
    if (state.playback.volumePercent != null && typeof window.syncExternalVolumeFromSpotify === 'function') {
      window.syncExternalVolumeFromSpotify(state.playback.volumePercent / 100);
    }
    if ((state.playback.repeatState || state.playback.shuffleState != null) && typeof window.syncSpotifyPlaybackMode === 'function') {
      window.syncSpotifyPlaybackMode({
        repeatState: state.playback.repeatState || 'off',
        shuffleState: !!state.playback.shuffleState,
      });
    }
    var note = document.getElementById('spotify-device-note');
    if (note && state.playback.device) note.textContent = '当前设备：' + state.playback.device.name + ' · ' + (state.playback.device.type || 'Spotify Connect');
    updateProgress();
  }

  function modePayload(mode) {
    mode = String(mode || 'loop').toLowerCase();
    if (mode === 'shuffle') return { mode: 'shuffle', shuffleState: true, repeatState: 'context' };
    if (mode === 'single') return { mode: 'single', shuffleState: false, repeatState: 'track' };
    return { mode: 'loop', shuffleState: false, repeatState: 'context' };
  }

  async function pollPlayback(silent) {
    if (!state.status.loggedIn || state.pollBusy) return;
    state.pollBusy = true;
    try { applyPlayback(await request('/api/spotify/player?t=' + Date.now())); }
    catch (error) { if (!silent) toast(error.message); }
    finally { state.pollBusy = false; }
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(function () { pollPlayback(true); }, 2200);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }

  async function prepareTrack(song, uris) {
    if (!spotifyUserPlaybackUnlocked) {
      console.warn('[Spotify] blocked automatic playback before user interaction:', song && song.name);
      if (typeof window.hideLoading === 'function') window.hideLoading();
      return false;
    }
    state.currentSong = song;
    var mode = typeof window.currentPlayMode === 'function' ? window.currentPlayMode() : 'loop';
    document.body.classList.add('spotify-source-active');
    state.playback = { active: true, isPlaying: true, progressMs: 0, durationMs: Number(song.durationMs || song.duration) || 0 };
    state.playbackAt = Date.now();
    window.playing = true;
    if (typeof window.setPlayIcon === 'function') window.setPlayIcon(true);
    try {
      uris = Array.isArray(uris) && uris.length ? uris : [song.uri];
      await post('/api/spotify/player/play', Object.assign({ uris: uris, positionMs: 0 }, modePayload(mode)));
      if (typeof window.hideLoading === 'function') window.hideLoading();
      toast('已发送到 Spotify Connect · 使用环境视觉');
      startPolling();
      setTimeout(function () { pollPlayback(true); }, 700);
      return true;
    } catch (error) {
      window.playing = false;
      if (typeof window.setPlayIcon === 'function') window.setPlayIcon(false);
      if (typeof window.hideLoading === 'function') window.hideLoading();
      toast(error.status === 404 ? '请先在 Spotify 打开任意设备并播放一次' : error.message);
      return false;
    }
  }

  async function toggle() {
    if (!isCurrent()) return false;
    try {
      var path = state.playback.isPlaying ? '/api/spotify/player/pause' : '/api/spotify/player/resume';
      await post(path);
      state.playback.isPlaying = !state.playback.isPlaying;
      state.playbackAt = Date.now();
      window.playing = state.playback.isPlaying;
      if (typeof window.setPlayIcon === 'function') window.setPlayIcon(window.playing);
      setTimeout(function () { pollPlayback(true); }, 450);
      return true;
    } catch (error) { toast(error.message); return false; }
  }

  async function skip(direction) {
    if (!isCurrent()) return false;
    try {
      await post(direction === 'previous' ? '/api/spotify/player/previous' : '/api/spotify/player/next');
      state.playbackAt = Date.now();
      setTimeout(function () { pollPlayback(true); }, 450);
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  }

  async function seek(seconds) {
    if (!isCurrent()) return false;
    var positionMs = Math.max(0, Math.round(Number(seconds) * 1000));
    try {
      await post('/api/spotify/player/seek', { positionMs: positionMs });
      state.playback.progressMs = positionMs;
      state.playbackAt = Date.now();
      updateProgress();
      return true;
    } catch (error) { toast(error.message); return false; }
  }

  function currentSeconds() {
    if (!isCurrent()) return 0;
    var elapsed = state.playback.isPlaying && state.playbackAt ? Date.now() - state.playbackAt : 0;
    return Math.max(0, (Number(state.playback.progressMs) || 0) + elapsed) / 1000;
  }

  function durationSeconds() {
    if (!isCurrent()) return 0;
    return Math.max(0, Number(state.playback.durationMs) || Number(state.currentSong && (state.currentSong.durationMs || state.currentSong.duration)) || 0) / 1000;
  }

  // 本地音量滑条只控制本地 <audio>/gainNode, 不会影响 Spotify Connect 设备的实际音量。
  // 这里把音量转发到 Connect 设备; 拖动滑条时做防抖, 避免每个像素都发一次请求。
  var volumeDebounceTimer = 0;
  var pendingVolumePercent = null;
  function setVolume(value) {
    if (!isCurrent()) return false;
    var percent = Math.max(0, Math.min(100, Math.round(Number(value) * 100)));
    pendingVolumePercent = percent;
    if (volumeDebounceTimer) return true;
    volumeDebounceTimer = setTimeout(function () {
      volumeDebounceTimer = 0;
      var target = pendingVolumePercent;
      pendingVolumePercent = null;
      if (target == null) return;
      post('/api/spotify/player/volume', { volumePercent: target }).catch(function (error) {
        // 不少 Spotify Connect 设备 (尤其手机) 不支持远程调音量, 静默失败避免打扰用户。
        console.warn('[Spotify] setVolume failed:', error.message);
      });
    }, 260);
    return true;
  }

  async function setPlaybackMode(mode) {
    if (!isCurrent()) return false;
    try {
      await post('/api/spotify/player/mode', modePayload(mode));
      state.playback.shuffleState = mode === 'shuffle';
      state.playback.repeatState = mode === 'single' ? 'track' : 'context';
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  }

  function deactivate() {
    state.currentSong = null;
    document.body.classList.remove('spotify-source-active');
  }

  window.SpotifyIntegration = {
    init: function () { ensureUi(); refreshStatus(true); setInterval(updateProgress, 500); },
    showSetup: showSetup,
    search: search,
    prepareTrack: prepareTrack,
    isCurrent: isCurrent,
    toggle: toggle,
    next: function () { return skip('next'); },
    previous: function () { return skip('previous'); },
    seek: seek,
    setVolume: setVolume,
    setPlaybackMode: setPlaybackMode,
    currentSeconds: currentSeconds,
    durationSeconds: durationSeconds,
    deactivate: deactivate,
    refreshStatus: refreshStatus,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.SpotifyIntegration.init);
  else window.SpotifyIntegration.init();
})();
