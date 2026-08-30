(function () {
  'use strict';

  // Mineradio system-audio DJ bridge.
  // The live response mapping intentionally mirrors Mineradio v2.1.0's
  // bass / mid / treble / beat / energy model so external Spotify Connect
  // playback can drive the same style of visual reaction in this fork.
  var state = {
    active: false,
    starting: false,
    stream: null,
    context: null,
    source: null,
    boost: null,
    analyser: null,
    beatAnalyser: null,
    analyserSink: null,
    beatSink: null,
    previous: null,
    raf: 0,
    freqData: null,
    beatData: null,
    lastFrameAt: 0,
    lastHudAt: 0,
    prevLow: 0,
    lowMean: 0.08,
    lowDeviation: 0.03,
    smoothBass: 0,
    smoothMid: 0,
    smoothTreble: 0,
    smoothEnergy: 0,
    beatPulse: 0,
    lastBeatAt: 0,
    beatIntervals: [],
    bpm: 0,
    bpmConfidence: 0,
    beatCount: 0,
    analysisGain: 1.65,
    frame: {
      subBass: 0,
      bass: 0,
      lowMid: 0,
      mid: 0,
      highMid: 0,
      presence: 0,
      brilliance: 0,
      air: 0,
      treble: 0,
      energy: 0,
      beat: 0,
      beatDetected: false,
      bpm: 0,
      bpmConfidence: 0,
      rawEnergy: 0,
      timestamp: 0,
    },
  };

  function clamp(value, min, max) {
    value = Number(value);
    if (!Number.isFinite(value)) value = min;
    return Math.max(min, Math.min(max, value));
  }

  function clamp01(value) {
    return clamp(value, 0, 1);
  }

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

  function resetLiveAnalysis() {
    state.prevLow = 0;
    state.lowMean = 0.08;
    state.lowDeviation = 0.03;
    state.smoothBass = 0;
    state.smoothMid = 0;
    state.smoothTreble = 0;
    state.smoothEnergy = 0;
    state.beatPulse = 0;
    state.lastBeatAt = 0;
    state.beatIntervals = [];
    state.bpm = 0;
    state.bpmConfidence = 0;
    state.beatCount = 0;
    state.lastFrameAt = 0;
    state.lastHudAt = 0;
    state.frame = {
      subBass: 0,
      bass: 0,
      lowMid: 0,
      mid: 0,
      highMid: 0,
      presence: 0,
      brilliance: 0,
      air: 0,
      treble: 0,
      energy: 0,
      beat: 0,
      beatDetected: false,
      bpm: 0,
      bpmConfidence: 0,
      rawEnergy: 0,
      timestamp: 0,
    };
  }

  function currentVisualIntensity() {
    var intensity = 0.85;
    try {
      if (typeof fx !== 'undefined' && fx && Number.isFinite(Number(fx.intensity))) {
        intensity = Number(fx.intensity);
      }
    } catch (_) {}
    // Slightly stronger than stock so the system-audio route is visibly synced.
    return clamp(intensity * 1.18, 0.35, 1.30);
  }

  function follow(current, target, dt, attack, release) {
    var rate = target > current ? attack : release;
    var blend = 1 - Math.exp(-Math.max(0.001, dt) * rate);
    return current + (target - current) * blend;
  }

  function bandAverage(data, analyserNode, minHz, maxHz) {
    if (!data || !data.length || !analyserNode || !state.context) return 0;
    var nyquist = state.context.sampleRate * 0.5;
    var binHz = nyquist / data.length;
    var start = Math.max(0, Math.floor(minHz / binHz));
    var end = Math.min(data.length - 1, Math.ceil(maxHz / binHz));
    if (end < start) return 0;

    var total = 0;
    var weight = 0;
    for (var i = start; i <= end; i++) {
      // Slight center weighting stops one noisy edge-bin dominating a band.
      var p = end === start ? 0.5 : (i - start) / (end - start);
      var w = 0.82 + Math.sin(p * Math.PI) * 0.18;
      var v = data[i] / 255;
      total += v * w;
      weight += w;
    }
    return weight > 0 ? total / weight : 0;
  }

  function spectrumEnergy(data) {
    if (!data || !data.length) return 0;
    var sum = 0;
    var count = 0;
    for (var i = 0; i < data.length; i += 2) {
      var v = data[i] / 255;
      sum += v * v;
      count++;
    }
    return count ? Math.sqrt(sum / count) : 0;
  }

  function shapeBand(value, floor, gain, gamma) {
    var shaped = Math.max(0, Number(value) - floor) * gain;
    return clamp01(Math.pow(clamp01(shaped), gamma));
  }

  function median(values) {
    if (!values || !values.length) return 0;
    var copy = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(copy.length / 2);
    return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) * 0.5;
  }

  function standardDeviation(values, center) {
    if (!values || values.length < 2) return 0;
    var sum = 0;
    for (var i = 0; i < values.length; i++) {
      var d = values[i] - center;
      sum += d * d;
    }
    return Math.sqrt(sum / values.length);
  }

  function updateBpm(now) {
    if (!state.lastBeatAt) return;

    var gap = now - state.lastBeatAt;
    if (gap >= 250 && gap <= 1500) {
      state.beatIntervals.push(gap);
      if (state.beatIntervals.length > 12) state.beatIntervals.shift();
    }

    if (state.beatIntervals.length >= 2) {
      var center = median(state.beatIntervals);
      var bpm = center > 0 ? 60000 / center : 0;
      while (bpm > 185) bpm *= 0.5;
      while (bpm > 0 && bpm < 68) bpm *= 2;
      var spread = center > 0 ? standardDeviation(state.beatIntervals, center) / center : 1;
      state.bpm = Math.round(bpm);
      state.bpmConfidence = clamp01((state.beatIntervals.length / 7) * (1 - Math.min(0.8, spread * 2.4)));
    }
  }

  function readLiveFrame(now, dt) {
    if (!state.analyser || !state.freqData) return null;
    state.analyser.getByteFrequencyData(state.freqData);

    var subBassRaw = bandAverage(state.freqData, state.analyser, 35, 90);
    var bassRaw = bandAverage(state.freqData, state.analyser, 90, 180);
    var lowMidRaw = bandAverage(state.freqData, state.analyser, 180, 420);
    var midRaw = bandAverage(state.freqData, state.analyser, 420, 1400);
    var highMidRaw = bandAverage(state.freqData, state.analyser, 1400, 3000);
    var presenceRaw = bandAverage(state.freqData, state.analyser, 3000, 6000);
    var brillianceRaw = bandAverage(state.freqData, state.analyser, 6000, 12000);
    var airRaw = bandAverage(state.freqData, state.analyser, 12000, 19000);
    var rawEnergy = spectrumEnergy(state.freqData);

    var subBass = shapeBand(subBassRaw, 0.025, 2.75, 0.72);
    var bassBand = shapeBand(bassRaw, 0.025, 2.55, 0.74);
    var lowMid = shapeBand(lowMidRaw, 0.020, 2.20, 0.78);
    var midBand = shapeBand(midRaw, 0.018, 2.00, 0.80);
    var highMid = shapeBand(highMidRaw, 0.015, 1.90, 0.82);
    var presence = shapeBand(presenceRaw, 0.012, 1.85, 0.84);
    var brilliance = shapeBand(brillianceRaw, 0.010, 1.80, 0.86);
    var air = shapeBand(airRaw, 0.008, 1.75, 0.88);

    var lowDrive = clamp01(subBass * 0.68 + bassBand * 0.32);
    var midDrive = clamp01(lowMid * 0.32 + midBand * 0.68);
    var highDrive = clamp01(highMid * 0.20 + presence * 0.32 + brilliance * 0.34 + air * 0.14);
    var energyDrive = shapeBand(rawEnergy, 0.020, 2.20, 0.78);

    // Adaptive low-frequency onset detector. It intentionally favors a
    // conspicuous kick pulse over subtlety because this mode is a visualizer.
    var meanBlend = lowDrive > state.lowMean ? 0.012 : 0.040;
    state.lowMean += (lowDrive - state.lowMean) * meanBlend;
    var absDelta = Math.abs(lowDrive - state.lowMean);
    state.lowDeviation += (absDelta - state.lowDeviation) * 0.035;

    var lowRise = Math.max(0, lowDrive - state.prevLow);
    state.prevLow = lowDrive;
    var ratio = lowDrive / Math.max(0.055, state.lowMean);
    var beatScore = clamp01(
      Math.max(0, ratio - 1.03) * 1.45
      + lowRise * 3.20
      + Math.max(0, lowDrive - state.lowMean - state.lowDeviation * 0.55) * 1.55
    );

    var cooldown = 175;
    var beatDetected = false;
    if (
      lowDrive > 0.13
      && beatScore > 0.31
      && (!state.lastBeatAt || now - state.lastBeatAt >= cooldown)
    ) {
      updateBpm(now);
      state.lastBeatAt = now;
      state.beatCount++;
      state.beatPulse = Math.max(state.beatPulse, 0.58 + beatScore * 0.42);
      beatDetected = true;
    }

    // Punchy attack, slower release. This is the same role as the 2.1.0
    // smoothBass/smoothMid/smoothTreb/smoothEnergy path.
    state.smoothBass = follow(state.smoothBass, lowDrive, dt, 17, 5.2);
    state.smoothMid = follow(state.smoothMid, midDrive, dt, 14, 4.5);
    state.smoothTreble = follow(state.smoothTreble, highDrive, dt, 18, 6.5);
    state.smoothEnergy = follow(state.smoothEnergy, energyDrive, dt, 11, 3.6);

    // Short visual kick envelope. The full 2.1.0 renderer also merges this
    // pulse into bass/energy and shader uniforms.
    state.beatPulse *= Math.pow(0.055, dt);
    if (state.beatPulse < 0.001) state.beatPulse = 0;

    var intensity = currentVisualIntensity();
    var mappedEnergy = clamp01(Math.max(state.smoothEnergy, state.beatPulse * 0.30) * 1.14);
    var mappedBass = clamp01(Math.min(0.90, state.smoothBass * 1.05 + state.beatPulse * 0.18) * intensity * 1.15);
    var mappedMid = clamp01(Math.min(0.72, state.smoothMid * 1.12) * intensity * 1.10);
    var mappedTreble = clamp01(Math.min(0.62, state.smoothTreble * 1.20) * intensity * 1.14);
    var mappedBeat = clamp01(state.beatPulse * 1.22);

    state.frame = {
      subBass: subBass,
      bass: mappedBass,
      lowMid: lowMid,
      mid: mappedMid,
      highMid: highMid,
      presence: presence,
      brilliance: brilliance,
      air: air,
      treble: mappedTreble,
      energy: mappedEnergy,
      beat: mappedBeat,
      beatDetected: beatDetected,
      bpm: state.bpm,
      bpmConfidence: state.bpmConfidence,
      rawEnergy: rawEnergy,
      timestamp: now,
    };
    return state.frame;
  }

  function setUniformValue(name, value, useMax) {
    try {
      if (typeof uniforms === 'undefined' || !uniforms || !uniforms[name]) return;
      var slot = uniforms[name];
      var current = Number(slot.value) || 0;
      slot.value = useMax ? Math.max(current, value) : value;
    } catch (_) {}
  }

  function bridgeFrameIntoMineradio(frame) {
    if (!frame) return;

    // Feed the same live values into the old fork's global visual state when
    // those globals exist. This makes the existing particles use real audio
    // even if some of the older idle/hard-coded motion is still present.
    try { smoothBass = frame.bass; } catch (_) { window.__mineradioSystemBass = frame.bass; }
    try { smoothMid = frame.mid; } catch (_) { window.__mineradioSystemMid = frame.mid; }
    try { smoothTreb = frame.treble; } catch (_) { window.__mineradioSystemTreble = frame.treble; }
    try { smoothEnergy = frame.energy; } catch (_) { window.__mineradioSystemEnergy = frame.energy; }
    try {
      beatPulse = Math.max(Number(beatPulse) || 0, frame.beat);
    } catch (_) {
      window.__mineradioSystemBeat = frame.beat;
    }
    try {
      if (frame.beatDetected) beatOnsetFlag = true;
    } catch (_) {}

    // v2.1.0's core particle shader consumes these five uniforms directly.
    setUniformValue('uBass', frame.bass, false);
    setUniformValue('uMid', frame.mid, false);
    setUniformValue('uTreble', frame.treble, false);
    setUniformValue('uEnergy', frame.energy, false);
    setUniformValue('uBeat', frame.beat, true);

    // Make individual kicks very obvious in older presets that expose the
    // transition/burst uniform. The normal renderer will decay it afterward.
    if (frame.beatDetected) {
      setUniformValue('uBurstAmt', Math.max(0.42, frame.beat * 0.72), true);
    }

    window.__mineradioSystemAudioFrame = frame;
  }

  function updateHud(frame, now) {
    if (!frame) return;
    var hud = document.getElementById('system-audio-dj-hud');
    var flash = document.getElementById('system-audio-dj-beat-flash');
    var button = document.getElementById('system-audio-dj-btn');
    if (!hud) return;

    var beat = clamp01(frame.beat);
    if (flash) {
      flash.style.opacity = String(Math.min(0.55, beat * 0.48));
      flash.style.transform = 'scale(' + (1 + beat * 0.012).toFixed(4) + ')';
    }
    if (button) {
      button.style.setProperty('--system-dj-beat', beat.toFixed(3));
    }

    // DOM text/bars do not need to run at display refresh rate.
    if (now - state.lastHudAt < 33 && !frame.beatDetected) return;
    state.lastHudAt = now;

    var bassBar = document.getElementById('system-audio-dj-bass');
    var midBar = document.getElementById('system-audio-dj-mid');
    var highBar = document.getElementById('system-audio-dj-high');
    var beatLamp = document.getElementById('system-audio-dj-beat-lamp');
    var status = document.getElementById('system-audio-dj-sync-status');
    var bpm = document.getElementById('system-audio-dj-bpm');

    if (bassBar) bassBar.style.transform = 'scaleX(' + clamp01(frame.bass).toFixed(3) + ')';
    if (midBar) midBar.style.transform = 'scaleX(' + clamp01(frame.mid).toFixed(3) + ')';
    if (highBar) highBar.style.transform = 'scaleX(' + clamp01(frame.treble).toFixed(3) + ')';
    if (beatLamp) {
      beatLamp.style.transform = 'scale(' + (1 + beat * 0.72).toFixed(3) + ')';
      beatLamp.style.opacity = String(0.34 + beat * 0.66);
    }

    var audible = frame.rawEnergy > 0.025;
    var locked = audible && (state.beatCount >= 2 || frame.beat > 0.10);
    if (status) {
      status.textContent = !audible ? 'NO AUDIO' : (locked ? 'SYNC LOCKED' : 'LISTENING');
      status.classList.toggle('locked', locked);
    }
    if (bpm) {
      bpm.textContent = state.bpm && state.bpmConfidence > 0.16
        ? (state.bpm + ' BPM')
        : '-- BPM';
    }

    if (frame.beatDetected) {
      hud.classList.remove('hit');
      void hud.offsetWidth;
      hud.classList.add('hit');
      document.body.classList.remove('system-audio-dj-beat-hit');
      void document.body.offsetWidth;
      document.body.classList.add('system-audio-dj-beat-hit');
    }
  }

  function runVisualLoop(now) {
    if (!state.active) {
      state.raf = 0;
      return;
    }

    var last = state.lastFrameAt || now;
    var dt = clamp((now - last) / 1000, 1 / 240, 0.10);
    state.lastFrameAt = now;

    var frame = readLiveFrame(now, dt);
    bridgeFrameIntoMineradio(frame);
    updateHud(frame, now);

    state.raf = requestAnimationFrame(runVisualLoop);
  }

  function startVisualLoop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.lastFrameAt = performance.now();
    state.raf = requestAnimationFrame(runVisualLoop);
  }

  function stopVisualLoop() {
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    state.lastFrameAt = 0;
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
    if (!desktopSupported()) return;

    var button = document.getElementById('system-audio-dj-btn');
    if (!button) {
      button = document.createElement('button');
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
    }

    if (!document.getElementById('system-audio-dj-hud')) {
      var hud = document.createElement('div');
      hud.id = 'system-audio-dj-hud';
      hud.setAttribute('aria-hidden', 'true');
      hud.innerHTML = [
        '<div class="system-dj-title"><span id="system-audio-dj-beat-lamp"></span><strong>V2.1 LIVE</strong><span id="system-audio-dj-sync-status">LISTENING</span></div>',
        '<div class="system-dj-meter"><span>BASS</span><i><b id="system-audio-dj-bass"></b></i></div>',
        '<div class="system-dj-meter"><span>MID</span><i><b id="system-audio-dj-mid"></b></i></div>',
        '<div class="system-dj-meter"><span>HIGH</span><i><b id="system-audio-dj-high"></b></i></div>',
        '<div class="system-dj-bpm" id="system-audio-dj-bpm">-- BPM</div>'
      ].join('');
      document.body.appendChild(hud);

      var flash = document.createElement('div');
      flash.id = 'system-audio-dj-beat-flash';
      flash.setAttribute('aria-hidden', 'true');
      document.body.appendChild(flash);
    }

    if (!document.getElementById('system-audio-dj-style')) {
      var style = document.createElement('style');
      style.id = 'system-audio-dj-style';
      style.textContent = [
        '#system-audio-dj-btn{position:relative;font-weight:800;letter-spacing:-.04em;--system-dj-beat:0;transform:scale(calc(1 + var(--system-dj-beat)*.10));transition:opacity .15s ease}',
        '#system-audio-dj-btn::after{content:"";position:absolute;right:5px;bottom:5px;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.28)}',
        '#system-audio-dj-btn.active::after{background:#1ed760;box-shadow:0 0 calc(9px + var(--system-dj-beat)*14px) rgba(30,215,96,.88)}',
        '#system-audio-dj-btn.busy{opacity:.72}',
        '#system-audio-dj-hud{position:fixed;top:64px;left:50%;z-index:2147483000;width:260px;transform:translateX(-50%) scale(.98);padding:10px 12px 9px;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:rgba(5,7,10,.72);backdrop-filter:blur(14px);box-shadow:0 10px 28px rgba(0,0,0,.32);color:#fff;font:700 10px/1.1 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.08em;pointer-events:none;opacity:0;transition:opacity .18s ease,transform .18s ease}',
        'body.system-audio-dj-active #system-audio-dj-hud{opacity:.94;transform:translateX(-50%) scale(1)}',
        '#system-audio-dj-hud.hit{animation:systemDjHudHit 160ms ease-out}',
        '.system-dj-title{display:flex;align-items:center;gap:7px;margin-bottom:8px}',
        '#system-audio-dj-beat-lamp{display:block;width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 10px rgba(255,255,255,.75);transform-origin:center}',
        '#system-audio-dj-sync-status{margin-left:auto;color:rgba(255,255,255,.52);font-size:9px}',
        '#system-audio-dj-sync-status.locked{color:#74ffae;text-shadow:0 0 10px rgba(80,255,145,.38)}',
        '.system-dj-meter{display:grid;grid-template-columns:38px 1fr;align-items:center;gap:7px;margin:4px 0;color:rgba(255,255,255,.55);font-size:8px}',
        '.system-dj-meter i{display:block;height:4px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.10)}',
        '.system-dj-meter b{display:block;width:100%;height:100%;transform:scaleX(0);transform-origin:left center;background:rgba(255,255,255,.88);border-radius:inherit;will-change:transform}',
        '.system-dj-bpm{margin-top:7px;text-align:right;color:rgba(255,255,255,.72);font-variant-numeric:tabular-nums;font-size:9px}',
        '#system-audio-dj-beat-flash{position:fixed;z-index:2147482000;inset:13px;border:2px solid rgba(255,255,255,.95);border-radius:22px;box-shadow:inset 0 0 34px rgba(255,255,255,.16),0 0 30px rgba(255,255,255,.12);pointer-events:none;opacity:0;transform:scale(1);transform-origin:center;will-change:opacity,transform}',
        '@keyframes systemDjHudHit{0%{filter:brightness(1.65);transform:translateX(-50%) scale(1.035)}100%{filter:brightness(1);transform:translateX(-50%) scale(1)}}'
      ].join('');
      document.head.appendChild(style);
    }

    updateButton();
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
      if (
        typeof ensurePlaybackAudioGraph === 'function'
        && !(window.SpotifyIntegration && window.SpotifyIntegration.isCurrent && window.SpotifyIntegration.isCurrent())
      ) {
        ensurePlaybackAudioGraph('system-audio-dj-stop');
      }
    } catch (_) {}
  }

  async function stop(silent) {
    if (!state.active && !state.starting && !state.stream) return;

    state.starting = false;
    state.active = false;
    stopVisualLoop();
    stopTracks();
    disconnectNode(state.source);
    disconnectNode(state.boost);
    disconnectNode(state.analyser);
    disconnectNode(state.beatAnalyser);
    disconnectNode(state.analyserSink);
    disconnectNode(state.beatSink);

    restoreMineradioGraph();

    if (state.context) {
      try { await state.context.close(); } catch (_) {}
    }

    state.stream = null;
    state.context = null;
    state.source = null;
    state.boost = null;
    state.analyser = null;
    state.beatAnalyser = null;
    state.analyserSink = null;
    state.beatSink = null;
    state.freqData = null;
    state.beatData = null;
    state.previous = null;
    resetLiveAnalysis();
    updateButton();
    document.body.classList.remove('system-audio-dj-active', 'system-audio-dj-beat-hit');

    var flash = document.getElementById('system-audio-dj-beat-flash');
    if (flash) {
      flash.style.opacity = '0';
      flash.style.transform = 'scale(1)';
    }

    if (!silent) toast('系统音频 DJ 分析已关闭');
  }

  async function start() {
    if (state.active || state.starting) return true;
    if (!desktopSupported()) {
      toast('当前环境不支持系统音频分析');
      return false;
    }

    ensureUi();
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

      // Electron needs a display source to grant Windows loopback audio.
      // Mineradio stops the video track immediately and never analyses/stores it.
      captured.getVideoTracks().forEach(function (track) {
        try { track.stop(); } catch (_) {}
        try { captured.removeTrack(track); } catch (_) {}
      });

      var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error('当前 Chromium 不支持 Web Audio');

      var context = new AudioContextCtor();
      var audioOnly = new MediaStream(audioTracks);
      var sourceNode = context.createMediaStreamSource(audioOnly);
      var boostNode = context.createGain();
      var mainAnalyser = context.createAnalyser();
      var realtimeBeatAnalyser = context.createAnalyser();
      var analyserSink = context.createGain();
      var beatSink = context.createGain();

      // This gain only exists inside the silent analysis graph. It does NOT
      // change Spotify/Windows playback volume.
      boostNode.gain.value = state.analysisGain;
      analyserSink.gain.value = 0;
      beatSink.gain.value = 0;

      mainAnalyser.fftSize = Math.max(32, Math.min(32768, Number(safeRead('FFT_SIZE', 2048)) || 2048));
      mainAnalyser.smoothingTimeConstant = 0.34;
      mainAnalyser.minDecibels = -96;
      mainAnalyser.maxDecibels = -8;

      realtimeBeatAnalyser.fftSize = Math.max(32, Math.min(32768, Number(safeRead('BEAT_FFT_SIZE', 1024)) || 1024));
      realtimeBeatAnalyser.smoothingTimeConstant = 0.04;
      realtimeBeatAnalyser.minDecibels = -96;
      realtimeBeatAnalyser.maxDecibels = -8;

      // Keep both branches render-active without replaying/echoing captured audio.
      sourceNode.connect(boostNode);
      boostNode.connect(mainAnalyser);
      boostNode.connect(realtimeBeatAnalyser);
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
      state.boost = boostNode;
      state.analyser = mainAnalyser;
      state.beatAnalyser = realtimeBeatAnalyser;
      state.analyserSink = analyserSink;
      state.beatSink = beatSink;
      state.freqData = new Uint8Array(mainAnalyser.frequencyBinCount);
      state.beatData = new Uint8Array(realtimeBeatAnalyser.frequencyBinCount);

      setGlobalAnalyserBindings(mainAnalyser, realtimeBeatAnalyser);
      resetRealtimeEngine();
      resetLiveAnalysis();

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
      startVisualLoop();
      toast('V2.1 LIVE 已启用 · 白色边框闪烁就是检测到的真实节拍');
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
    getFrame: function () { return Object.assign({}, state.frame); },
    getBpm: function () {
      return {
        bpm: state.bpm,
        confidence: state.bpmConfidence,
        intervals: state.beatIntervals.slice(),
      };
    },
    setAnalysisGain: function (value) {
      state.analysisGain = clamp(value, 0.5, 4.0);
      if (state.boost && state.context) {
        try {
          state.boost.gain.setTargetAtTime(state.analysisGain, state.context.currentTime, 0.035);
        } catch (_) {
          state.boost.gain.value = state.analysisGain;
        }
      }
      return state.analysisGain;
    },
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
    ensureUi();
    if (document.getElementById('system-audio-dj-btn') || uiAttempts > 20) clearInterval(uiTimer);
  }, 500);

  window.addEventListener('beforeunload', function () { stop(true); }, { once: true });
})();
