(function () {
  'use strict';

  var state = {
    active: false,
    starting: false,
    stream: null,
    context: null,
    source: null,
    analyser: null,
    beatAnalyser: null,
    analyserSink: null,
    beatSink: null,
    previous: null,
  };

  function toast(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
    else console.log('[System Audio DJ]', message);
  }

  function desktopSupported() {
    return !!(
      window.desktopWindow
      && window.desktopWindow.isDesktop
      && navigator.mediaDevices
      && typeof navigator.mediaDevices.getDisplayMedia === 'function'
    );
  }

  function safeRead(name, fallback) {
    try {
      if (name === 'analyser') return analyser;
      if (name === 'beatAnalyser') return beatAnalyser;
      if (name === 'audioReady') return audioReady;
      if (name === 'FFT_SIZE') return FFT_SIZE;
      if (name === 'BEAT_FFT_SIZE') return BEAT_FFT_SIZE;
    } catch (_) {}
    return fallback;
  }

  function setGlobalAnalyserBindings(mainAnalyser, realtimeBeatAnalyser) {
    try { analyser = mainAnalyser; } catch (_) { window.__mineradioSystemAnalyser = mainAnalyser; }
    try { beatAnalyser = realtimeBeatAnalyser; } catch (_) { window.__mineradioSystemBeatAnalyser = realtimeBeatAnalyser; }
    try { audioReady = !!mainAnalyser; } catch (_) {}
  }

  function resetRealtimeEngine() {
    try {
      if (typeof resetRealtimeBeatEngine === 'function') resetRealtimeBeatEngine();
    } catch (_) {}
  }

  function updateButton() {
    var button = document.getElementById('system-audio-dj-btn');
    if (!button) return;
    button.classList.toggle('active', state.active);
    button.classList.toggle('busy', state.starting);
    button.setAttribute('aria-pressed', state.active ? 'true' : 'false');
    button.title = state.starting
      ? '正在连接系统音频…'
      : (state.active ? '关闭系统音频 DJ 分析' : '系统音频 DJ 分析');
    button.textContent = state.starting ? '…' : 'DJ';
  }

  function ensureUi() {
    if (!desktopSupported() || document.getElementById('system-audio-dj-btn')) return;

    var button = document.createElement('button');
    button.id = 'system-audio-dj-btn';
    button.type = 'button';
    button.className = 'icon-btn system-audio-dj-btn';
    button.textContent = 'DJ';
    button.title = '系统音频 DJ 分析';
    button.setAttribute('aria-label', '系统音频 DJ 分析');
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', function () {
      if (state.active || state.starting) stop();
      else start();
    });

    var spotify = document.getElementById('spotify-status-btn');
    var account = document.getElementById('user-btn');
    var anchor = spotify || account;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(button, anchor);
    else document.body.appendChild(button);

    if (!document.getElementById('system-audio-dj-style')) {
      var style = document.createElement('style');
      style.id = 'system-audio-dj-style';
      style.textContent = [
        '#system-audio-dj-btn{position:relative;font-weight:800;letter-spacing:-.04em}',
        '#system-audio-dj-btn::after{content:"";position:absolute;right:5px;bottom:5px;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.28)}',
        '#system-audio-dj-btn.active::after{background:#1ed760;box-shadow:0 0 9px rgba(30,215,96,.8)}',
        '#system-audio-dj-btn.busy{opacity:.72}'
      ].join('');
      document.head.appendChild(style);
    }
  }

  function disconnectNode(node) {
    if (!node) return;
    try { node.disconnect(); } catch (_) {}
  }

  function stopTracks() {
    if (!state.stream) return;
    state.stream.getTracks().forEach(function (track) {
      try { track.stop(); } catch (_) {}
    });
  }

  function restoreMineradioGraph() {
    var previous = state.previous;
    var oursMain = state.analyser;
    var oursBeat = state.beatAnalyser;

    if (previous) {
      try {
        if (safeRead('analyser', null) === oursMain) analyser = previous.analyser || null;
      } catch (_) {}
      try {
        if (safeRead('beatAnalyser', null) === oursBeat) beatAnalyser = previous.beatAnalyser || null;
      } catch (_) {}
      try { audioReady = !!previous.audioReady; } catch (_) {}
    }

    resetRealtimeEngine();
    try {
      if (typeof ensurePlaybackAudioGraph === 'function' && !(window.SpotifyIntegration && window.SpotifyIntegration.isCurrent && window.SpotifyIntegration.isCurrent())) {
        ensurePlaybackAudioGraph('system-audio-dj-stop');
      }
    } catch (_) {}
  }

  async function stop(silent) {
    if (!state.active && !state.starting && !state.stream) return;

    state.starting = false;
    stopTracks();
    disconnectNode(state.source);
    disconnectNode(state.analyser);
    disconnectNode(state.beatAnalyser);
    disconnectNode(state.analyserSink);
    disconnectNode(state.beatSink);

    restoreMineradioGraph();

    if (state.context) {
      try { await state.context.close(); } catch (_) {}
    }

    state.active = false;
    state.stream = null;
    state.context = null;
    state.source = null;
    state.analyser = null;
    state.beatAnalyser = null;
    state.analyserSink = null;
    state.beatSink = null;
    state.previous = null;
    updateButton();
    document.body.classList.remove('system-audio-dj-active');
    if (!silent) toast('系统音频 DJ 分析已关闭');
  }

  async function start() {
    if (state.active || state.starting) return true;
    if (!desktopSupported()) {
      toast('当前环境不支持系统音频分析');
      return false;
    }

    state.starting = true;
    updateButton();

    try {
      var captured = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      var audioTracks = captured.getAudioTracks();
      if (!audioTracks.length) {
        captured.getTracks().forEach(function (track) { try { track.stop(); } catch (_) {} });
        throw new Error('没有获取到系统音频，请确认 Windows 输出设备正在播放声音');
      }

      // The Electron handler needs a display source to grant loopback audio,
      // but Mineradio never consumes or stores the screen video.
      captured.getVideoTracks().forEach(function (track) {
        try { track.stop(); } catch (_) {}
        try { captured.removeTrack(track); } catch (_) {}
      });

      var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error('当前 Chromium 不支持 Web Audio');

      var context = new AudioContextCtor();
      var audioOnly = new MediaStream(audioTracks);
      var sourceNode = context.createMediaStreamSource(audioOnly);
      var mainAnalyser = context.createAnalyser();
      var realtimeBeatAnalyser = context.createAnalyser();
      var analyserSink = context.createGain();
      var beatSink = context.createGain();

      analyserSink.gain.value = 0;
      beatSink.gain.value = 0;
      mainAnalyser.fftSize = Math.max(32, Math.min(32768, Number(safeRead('FFT_SIZE', 2048)) || 2048));
      mainAnalyser.smoothingTimeConstant = 0.58;
      realtimeBeatAnalyser.fftSize = Math.max(32, Math.min(32768, Number(safeRead('BEAT_FFT_SIZE', 1024)) || 1024));
      realtimeBeatAnalyser.smoothingTimeConstant = 0.10;

      // Keep both branches render-active without replaying/echoing captured audio.
      sourceNode.connect(mainAnalyser);
      sourceNode.connect(realtimeBeatAnalyser);
      mainAnalyser.connect(analyserSink);
      realtimeBeatAnalyser.connect(beatSink);
      analyserSink.connect(context.destination);
      beatSink.connect(context.destination);

      state.previous = {
        analyser: safeRead('analyser', null),
        beatAnalyser: safeRead('beatAnalyser', null),
        audioReady: !!safeRead('audioReady', false),
      };
      state.stream = captured;
      state.context = context;
      state.source = sourceNode;
      state.analyser = mainAnalyser;
      state.beatAnalyser = realtimeBeatAnalyser;
      state.analyserSink = analyserSink;
      state.beatSink = beatSink;

      setGlobalAnalyserBindings(mainAnalyser, realtimeBeatAnalyser);
      resetRealtimeEngine();

      audioTracks.forEach(function (track) {
        track.addEventListener('ended', function () {
          if (state.active) stop(true).then(function () {
            toast('系统音频捕获已结束');
          });
        }, { once: true });
      });

      if (context.state === 'suspended') {
        try { await context.resume(); } catch (_) {}
      }

      state.starting = false;
      state.active = true;
      document.body.classList.add('system-audio-dj-active');
      updateButton();
      toast('系统音频已接入 DJ 分析 · 视觉现在跟随正在播放的声音');
      return true;
    } catch (error) {
      state.starting = false;
      updateButton();
      await stop(true);
      var message = error && error.message ? error.message : '系统音频分析启动失败';
      if (/permission|denied|notallowed/i.test(message)) message = '系统音频捕获被取消或没有权限';
      toast(message);
      return false;
    }
  }

  window.SystemAudioDJ = {
    start: start,
    stop: stop,
    toggle: function () { return state.active ? stop() : start(); },
    isActive: function () { return state.active; },
    getAnalyser: function () { return state.analyser; },
    getBeatAnalyser: function () { return state.beatAnalyser; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUi, { once: true });
  } else {
    ensureUi();
  }

  // Spotify inserts its status button after initial page setup. Retry briefly so
  // the DJ control lands beside it instead of falling back to the document body.
  var uiAttempts = 0;
  var uiTimer = setInterval(function () {
    uiAttempts += 1;
    if (!document.getElementById('system-audio-dj-btn')) ensureUi();
    if (document.getElementById('system-audio-dj-btn') || uiAttempts > 20) clearInterval(uiTimer);
  }, 500);

  window.addEventListener('beforeunload', function () { stop(true); }, { once: true });
})();
