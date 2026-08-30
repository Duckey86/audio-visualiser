(function () {
  'use strict';

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
    analysisGain: 1.15,

    bassMean: 0.075,
    bassDev: 0.025,
    bassPeak: 0.22,
    midPeak: 0.20,
    highPeak: 0.16,
    prevBassRaw: 0,
    smoothBass: 0,
    smoothMid: 0,
    smoothTreble: 0,
    smoothEnergy: 0,
    meterBass: 0,
    meterMid: 0,
    meterHigh: 0,
    beatPulse: 0,
    lastBeatAt: 0,
    beatIntervals: [],
    bpm: 0,
    bpmConfidence: 0,
    beatCount: 0,

    particleBaseScale: 1,
    bloomBaseScale: 1,

    frame: {
      rawBass: 0,
      rawMid: 0,
      rawTreble: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      meterBass: 0,
      meterMid: 0,
      meterHigh: 0,
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
      var p = end === start ? 0.5 : (i - start) / (end - start);
      var w = 0.88 + Math.sin(p * Math.PI) * 0.12;
      total += (data[i] / 255) * w;
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

  function dynamicLevel(raw, peak, floor) {
    var top = Math.max(floor + 0.08, peak);
    return clamp01((raw - floor) / Math.max(0.08, top - floor));
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
    if (gap >= 260 && gap <= 1400) {
      state.beatIntervals.push(gap);
      if (state.beatIntervals.length > 10) state.beatIntervals.shift();
    }
    if (state.beatIntervals.length < 3) return;

    var center = median(state.beatIntervals);
    var bpm = center > 0 ? 60000 / center : 0;
    while (bpm > 185) bpm *= 0.5;
    while (bpm > 0 && bpm < 68) bpm *= 2;
    var spread = center > 0 ? standardDeviation(state.beatIntervals, center) / center : 1;
    state.bpm = Math.round(bpm);
    state.bpmConfidence = clamp01((state.beatIntervals.length / 7) * (1 - Math.min(0.85, spread * 2.7)));
  }

  function resetLiveAnalysis() {
    state.bassMean = 0.075;
    state.bassDev = 0.025;
    state.bassPeak = 0.22;
    state.midPeak = 0.20;
    state.highPeak = 0.16;
    state.prevBassRaw = 0;
    state.smoothBass = 0;
    state.smoothMid = 0;
    state.smoothTreble = 0;
    state.smoothEnergy = 0;
    state.meterBass = 0;
    state.meterMid = 0;
    state.meterHigh = 0;
    state.beatPulse = 0;
    state.lastBeatAt = 0;
    state.beatIntervals = [];
    state.bpm = 0;
    state.bpmConfidence = 0;
    state.beatCount = 0;
    state.lastFrameAt = 0;
    state.lastHudAt = 0;
    state.frame = {
      rawBass: 0,
      rawMid: 0,
      rawTreble: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      meterBass: 0,
      meterMid: 0,
      meterHigh: 0,
      beat: 0,
      beatDetected: false,
      bpm: 0,
      bpmConfidence: 0,
      rawEnergy: 0,
      timestamp: 0,
    };
  }

  function currentPreset() {
    try {
      if (typeof fx !== 'undefined' && fx && Number.isFinite(Number(fx.preset))) return Number(fx.preset);
    } catch (_) {}
    return 0;
  }

  function currentVisualIntensity() {
    var intensity = 0.85;
    try {
      if (typeof fx !== 'undefined' && fx && Number.isFinite(Number(fx.intensity))) intensity = Number(fx.intensity);
    } catch (_) {}
    return clamp(intensity, 0.35, 1.20);
  }

  function readLiveFrame(now, dt) {
    if (!state.analyser || !state.beatAnalyser || !state.freqData || !state.beatData) return null;

    // The 1024 FFT beat analyser has essentially no analyser smoothing and is
    // used for the kick envelope. The larger analyser remains available to the
    // rest of Mineradio for detailed visuals.
    state.beatAnalyser.getByteFrequencyData(state.beatData);
    state.analyser.getByteFrequencyData(state.freqData);

    var rawBass = bandAverage(state.beatData, state.beatAnalyser, 38, 175);
    var rawMid = bandAverage(state.freqData, state.analyser, 240, 1600);
    var rawTreble = bandAverage(state.freqData, state.analyser, 2600, 10500);
    var rawEnergy = spectrumEnergy(state.freqData);

    // Track song loudness slowly so loud masters do not pin every bar at 100%.
    state.bassPeak = Math.max(rawBass, state.bassPeak * Math.exp(-dt * 0.52), 0.18);
    state.midPeak = Math.max(rawMid, state.midPeak * Math.exp(-dt * 0.34), 0.17);
    state.highPeak = Math.max(rawTreble, state.highPeak * Math.exp(-dt * 0.34), 0.14);

    var bassLevel = dynamicLevel(rawBass, state.bassPeak, 0.030);
    var midLevel = dynamicLevel(rawMid, state.midPeak, 0.025);
    var highLevel = dynamicLevel(rawTreble, state.highPeak, 0.020);
    var energyLevel = clamp01((rawEnergy - 0.025) / 0.38);

    // Less jitter than the previous mapping: quick enough to feel live, but
    // with a controlled release rather than changing size every tiny FFT tick.
    state.smoothBass = follow(state.smoothBass, bassLevel, dt, 30, 8.0);
    state.smoothMid = follow(state.smoothMid, midLevel, dt, 16, 5.2);
    state.smoothTreble = follow(state.smoothTreble, highLevel, dt, 19, 6.0);
    state.smoothEnergy = follow(state.smoothEnergy, energyLevel, dt, 15, 5.0);

    state.meterBass = follow(state.meterBass, bassLevel, dt, 11, 4.0);
    state.meterMid = follow(state.meterMid, midLevel, dt, 8, 3.2);
    state.meterHigh = follow(state.meterHigh, highLevel, dt, 9, 3.5);

    // Adaptive STRONG-kick detector. A hit has to be clearly above the recent
    // low-frequency baseline, rising, and separated from the previous hit.
    // This intentionally ignores small bass movement so only real kicks pulse.
    var meanBlend = rawBass > state.bassMean ? 0.010 : 0.034;
    state.bassMean += (rawBass - state.bassMean) * meanBlend;
    var deviation = Math.abs(rawBass - state.bassMean);
    state.bassDev += (deviation - state.bassDev) * 0.030;

    var rise = Math.max(0, rawBass - state.prevBassRaw);
    state.prevBassRaw = rawBass;
    var ratio = rawBass / Math.max(0.055, state.bassMean);
    var z = (rawBass - state.bassMean) / Math.max(0.018, state.bassDev);
    var strongScore = clamp01(
      Math.max(0, ratio - 1.12) * 1.25
      + rise * 3.6
      + Math.max(0, z - 0.95) * 0.18
    );

    var beatDetected = false;
    var cooldown = 245;
    if (
      rawBass > 0.115
      && ratio > 1.10
      && rise > 0.010
      && strongScore > 0.56
      && (!state.lastBeatAt || now - state.lastBeatAt >= cooldown)
    ) {
      updateBpm(now);
      state.lastBeatAt = now;
      state.beatCount++;
      state.beatPulse = Math.max(state.beatPulse, 0.78 + strongScore * 0.22);
      beatDetected = true;
    }

    // Very short pulse so the visual hit lines up with the audible kick instead
    // of glowing for several frames after it.
    state.beatPulse *= Math.exp(-dt * 18.5);
    if (state.beatPulse < 0.002) state.beatPulse = 0;

    var intensity = currentVisualIntensity();
    var bass = clamp01((state.smoothBass * 0.78 + state.beatPulse * 0.18) * intensity);
    var mid = clamp01(state.smoothMid * 0.56 * intensity);
    var treble = clamp01(state.smoothTreble * 0.52 * intensity);
    var energy = clamp01(state.smoothEnergy * 0.68 + state.beatPulse * 0.16);

    state.frame = {
      rawBass: rawBass,
      rawMid: rawMid,
      rawTreble: rawTreble,
      bass: bass,
      mid: mid,
      treble: treble,
      energy: energy,
      meterBass: clamp01(state.meterBass * 0.92),
      meterMid: clamp01(state.meterMid * 0.78),
      meterHigh: clamp01(state.meterHigh * 0.78),
      beat: clamp01(state.beatPulse),
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

    try { smoothBass = frame.bass; } catch (_) { window.__mineradioSystemBass = frame.bass; }
    try { smoothMid = frame.mid; } catch (_) { window.__mineradioSystemMid = frame.mid; }
    try { smoothTreb = frame.treble; } catch (_) { window.__mineradioSystemTreble = frame.treble; }
    try { smoothEnergy = frame.energy; } catch (_) { window.__mineradioSystemEnergy = frame.energy; }
    try { beatPulse = frame.beat; } catch (_) { window.__mineradioSystemBeat = frame.beat; }
    try { beatOnsetFlag = !!frame.beatDetected; } catch (_) {}

    setUniformValue('uBass', frame.bass, false);
    setUniformValue('uMid', frame.mid, false);
    setUniformValue('uTreble', frame.treble, false);
    setUniformValue('uEnergy', frame.energy, false);
    setUniformValue('uBeat', frame.beat, false);

    // Only a strong kick is allowed to trigger the burst/glow path now.
    if (frame.beatDetected) setUniformValue('uBurstAmt', 0.42 + frame.beat * 0.20, true);

    window.__mineradioSystemAudioFrame = frame;
  }

  function rememberParticleScales() {
    try {
      if (typeof particles !== 'undefined' && particles && particles.scale) state.particleBaseScale = particles.scale.x || 1;
    } catch (_) {}
    try {
      if (typeof bloomParticles !== 'undefined' && bloomParticles && bloomParticles.scale) state.bloomBaseScale = bloomParticles.scale.x || 1;
    } catch (_) {}
  }

  function applyAlbumPulse(frame) {
    if (!frame) return;
    var preset = currentPreset();
    var isAlbumPreset = preset < 0.5 || (preset > 3.5 && preset < 4.5);
    if (!isAlbumPreset) return;

    // Continuous album breathing follows the stable bass envelope. Strong kicks
    // add a short extra expansion. This is intentionally spatial instead of a
    // full-screen white flash.
    var scale = 1 + frame.meterBass * 0.040 + frame.beat * 0.036;
    try {
      if (typeof particles !== 'undefined' && particles && particles.scale) {
        particles.scale.setScalar(state.particleBaseScale * scale);
      }
    } catch (_) {}
    try {
      if (typeof bloomParticles !== 'undefined' && bloomParticles && bloomParticles.scale) {
        bloomParticles.scale.setScalar(state.bloomBaseScale * scale);
      }
    } catch (_) {}

    var glow = document.getElementById('system-audio-dj-album-glow');
    if (glow) {
      var strong = frame.beat;
      glow.style.opacity = String(Math.min(0.18, strong * 0.16));
      glow.style.transform = 'translate(-50%,-50%) scale(' + (0.94 + strong * 0.10).toFixed(3) + ')';
    }
  }

  function restoreParticleScales() {
    try {
      if (typeof particles !== 'undefined' && particles && particles.scale) particles.scale.setScalar(state.particleBaseScale || 1);
    } catch (_) {}
    try {
      if (typeof bloomParticles !== 'undefined' && bloomParticles && bloomParticles.scale) bloomParticles.scale.setScalar(state.bloomBaseScale || 1);
    } catch (_) {}
    var glow = document.getElementById('system-audio-dj-album-glow');
    if (glow) {
      glow.style.opacity = '0';
      glow.style.transform = 'translate(-50%,-50%) scale(.94)';
    }
  }

  function updateHud(frame, now) {
    if (!frame) return;
    var hud = document.getElementById('system-audio-dj-hud');
    var button = document.getElementById('system-audio-dj-btn');
    if (!hud) return;

    if (button) button.style.setProperty('--system-dj-beat', frame.beat.toFixed(3));

    if (now - state.lastHudAt < 40 && !frame.beatDetected) return;
    state.lastHudAt = now;

    var bassBar = document.getElementById('system-audio-dj-bass');
    var midBar = document.getElementById('system-audio-dj-mid');
    var highBar = document.getElementById('system-audio-dj-high');
    var beatLamp = document.getElementById('system-audio-dj-beat-lamp');
    var status = document.getElementById('system-audio-dj-sync-status');
    var bpm = document.getElementById('system-audio-dj-bpm');

    if (bassBar) bassBar.style.transform = 'scaleX(' + frame.meterBass.toFixed(3) + ')';
    if (midBar) midBar.style.transform = 'scaleX(' + frame.meterMid.toFixed(3) + ')';
    if (highBar) highBar.style.transform = 'scaleX(' + frame.meterHigh.toFixed(3) + ')';

    if (beatLamp) {
      beatLamp.style.transform = 'scale(' + (1 + frame.beat * 0.50).toFixed(3) + ')';
      beatLamp.style.opacity = String(0.34 + frame.beat * 0.60);
    }

    var audible = frame.rawEnergy > 0.022;
    var locked = audible && state.beatCount >= 2;
    if (status) {
      status.textContent = !audible ? 'NO AUDIO' : (locked ? 'SYNC' : 'LISTENING');
      status.classList.toggle('locked', locked);
    }
    if (bpm) {
      bpm.textContent = state.bpm && state.bpmConfidence > 0.18 ? state.bpm + ' BPM' : '-- BPM';
    }

    if (frame.beatDetected) {
      hud.classList.remove('hit');
      void hud.offsetWidth;
      hud.classList.add('hit');
    }
  }

  function runVisualLoop(now) {
    if (!state.active) {
      state.raf = 0;
      return;
    }

    var last = state.lastFrameAt || now;
    var dt = clamp((now - last) / 1000, 1 / 240, 0.08);
    state.lastFrameAt = now;

    var frame = readLiveFrame(now, dt);
    bridgeFrameIntoMineradio(frame);
    applyAlbumPulse(frame);
    updateHud(frame, now);

    state.raf = requestAnimationFrame(runVisualLoop);
  }

  function startVisualLoop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.lastFrameAt = performance.now();
    state.raf = requestAnimationFrame(runVisualLoop);
  }

  function stopVisualLoop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.lastFrameAt = 0;
  }

  function updateButton() {
    var button = document.getElementById('system-audio-dj-btn');
    if (!button) return;
    button.classList.toggle('active', state.active);
    button.classList.toggle('busy', state.starting);
    button.setAttribute('aria-pressed', state.active ? 'true' : 'false');
    button.title = state.starting ? 'Connecting system audio…' : (state.active ? 'Disable system audio DJ analyser' : 'System audio DJ analyser');
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
      button.title = 'System audio DJ analyser';
      button.setAttribute('aria-label', 'System audio DJ analyser');
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
    }

    // Remove the old full-screen border flash if an older version left it in
    // the DOM. The replacement glow stays around the album only.
    var oldFlash = document.getElementById('system-audio-dj-beat-flash');
    if (oldFlash && oldFlash.parentNode) oldFlash.parentNode.removeChild(oldFlash);

    if (!document.getElementById('system-audio-dj-album-glow')) {
      var glow = document.createElement('div');
      glow.id = 'system-audio-dj-album-glow';
      glow.setAttribute('aria-hidden', 'true');
      document.body.appendChild(glow);
    }

    if (!document.getElementById('system-audio-dj-style')) {
      var style = document.createElement('style');
      style.id = 'system-audio-dj-style';
      style.textContent = [
        '#system-audio-dj-btn{position:relative;font-weight:800;letter-spacing:-.04em;--system-dj-beat:0;transform:scale(calc(1 + var(--system-dj-beat)*.055));transition:opacity .15s ease}',
        '#system-audio-dj-btn::after{content:"";position:absolute;right:5px;bottom:5px;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.28)}',
        '#system-audio-dj-btn.active::after{background:#1ed760;box-shadow:0 0 calc(7px + var(--system-dj-beat)*8px) rgba(30,215,96,.70)}',
        '#system-audio-dj-btn.busy{opacity:.72}',
        '#system-audio-dj-hud{position:fixed;top:64px;left:50%;z-index:2147483000;width:260px;transform:translateX(-50%) scale(.98);padding:10px 12px 9px;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:rgba(5,7,10,.72);backdrop-filter:blur(14px);box-shadow:0 10px 28px rgba(0,0,0,.32);color:#fff;font:700 10px/1.1 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.08em;pointer-events:none;opacity:0;transition:opacity .18s ease,transform .18s ease}',
        'body.system-audio-dj-active #system-audio-dj-hud{opacity:.92;transform:translateX(-50%) scale(1)}',
        '#system-audio-dj-hud.hit{animation:systemDjHudHit 130ms ease-out}',
        '.system-dj-title{display:flex;align-items:center;gap:7px;margin-bottom:8px}',
        '#system-audio-dj-beat-lamp{display:block;width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 8px rgba(255,255,255,.58);transform-origin:center}',
        '#system-audio-dj-sync-status{margin-left:auto;color:rgba(255,255,255,.52);font-size:9px}',
        '#system-audio-dj-sync-status.locked{color:#74ffae;text-shadow:0 0 8px rgba(80,255,145,.30)}',
        '.system-dj-meter{display:grid;grid-template-columns:38px 1fr;align-items:center;gap:7px;margin:4px 0;color:rgba(255,255,255,.55);font-size:8px}',
        '.system-dj-meter i{display:block;height:4px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.10)}',
        '.system-dj-meter b{display:block;width:100%;height:100%;transform:scaleX(0);transform-origin:left center;background:rgba(255,255,255,.82);border-radius:inherit;will-change:transform}',
        '.system-dj-bpm{margin-top:7px;text-align:right;color:rgba(255,255,255,.68);font-variant-numeric:tabular-nums;font-size:9px}',
        '#system-audio-dj-album-glow{position:fixed;z-index:1;left:50%;top:50%;width:min(42vw,42vh);height:min(42vw,42vh);border-radius:50%;pointer-events:none;opacity:0;transform:translate(-50%,-50%) scale(.94);background:radial-gradient(circle,rgba(255,255,255,.12) 0%,rgba(255,255,255,.055) 27%,rgba(255,255,255,0) 70%);filter:blur(12px);mix-blend-mode:screen;will-change:opacity,transform;transition:opacity 42ms linear}',
        '@keyframes systemDjHudHit{0%{filter:brightness(1.24);transform:translateX(-50%) scale(1.012)}100%{filter:brightness(1);transform:translateX(-50%) scale(1)}}'
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
      try { if (safeRead('analyser', null) === oursMain) analyser = previous.analyser || null; } catch (_) {}
      try { if (safeRead('beatAnalyser', null) === oursBeat) beatAnalyser = previous.beatAnalyser || null; } catch (_) {}
      try { audioReady = !!previous.audioReady; } catch (_) {}
    }

    resetRealtimeEngine();
    try {
      if (
        typeof ensurePlaybackAudioGraph === 'function'
        && !(window.SpotifyIntegration && window.SpotifyIntegration.isCurrent && window.SpotifyIntegration.isCurrent())
      ) ensurePlaybackAudioGraph('system-audio-dj-stop');
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
    restoreParticleScales();

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
    document.body.classList.remove('system-audio-dj-active');

    if (!silent) toast('System audio DJ analyser off');
  }

  async function start() {
    if (state.active || state.starting) return true;
    if (!desktopSupported()) {
      toast('System audio analysis is only available in the desktop app');
      return false;
    }

    ensureUi();
    state.starting = true;
    updateButton();

    try {
      var captured = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      var audioTracks = captured.getAudioTracks();
      if (!audioTracks.length) {
        captured.getTracks().forEach(function (track) { try { track.stop(); } catch (_) {} });
        throw new Error('No system audio was captured');
      }

      captured.getVideoTracks().forEach(function (track) {
        try { track.stop(); } catch (_) {}
        try { captured.removeTrack(track); } catch (_) {}
      });

      var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error('Web Audio is not supported');

      var context = new AudioContextCtor({ latencyHint: 'interactive' });
      var audioOnly = new MediaStream(audioTracks);
      var sourceNode = context.createMediaStreamSource(audioOnly);
      var boostNode = context.createGain();
      var mainAnalyser = context.createAnalyser();
      var realtimeBeatAnalyser = context.createAnalyser();
      var analyserSink = context.createGain();
      var beatSink = context.createGain();

      boostNode.gain.value = state.analysisGain;
      analyserSink.gain.value = 0;
      beatSink.gain.value = 0;

      // Keep the main graph compatible with Mineradio's existing FFT buffers,
      // but use a smaller zero-smoothing analyser for the visual kick detector.
      mainAnalyser.fftSize = Math.max(2048, Math.min(4096, Number(safeRead('FFT_SIZE', 2048)) || 2048));
      mainAnalyser.smoothingTimeConstant = 0.08;
      mainAnalyser.minDecibels = -96;
      mainAnalyser.maxDecibels = -8;

      realtimeBeatAnalyser.fftSize = 1024;
      realtimeBeatAnalyser.smoothingTimeConstant = 0.0;
      realtimeBeatAnalyser.minDecibels = -96;
      realtimeBeatAnalyser.maxDecibels = -8;

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
      rememberParticleScales();

      audioTracks.forEach(function (track) {
        track.addEventListener('ended', function () {
          if (state.active) stop(true).then(function () { toast('System audio capture ended'); });
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
      toast('V2.1 LIVE · album pulse uses bass · only strong kicks glow');
      return true;
    } catch (error) {
      state.starting = false;
      updateButton();
      await stop(true);
      var message = error && error.message ? error.message : 'System audio analyser failed to start';
      if (/permission|denied|notallowed/i.test(message)) message = 'System audio capture was cancelled or denied';
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
      return { bpm: state.bpm, confidence: state.bpmConfidence, intervals: state.beatIntervals.slice() };
    },
    setAnalysisGain: function (value) {
      state.analysisGain = clamp(value, 0.6, 2.5);
      if (state.boost && state.context) {
        try { state.boost.gain.setTargetAtTime(state.analysisGain, state.context.currentTime, 0.025); }
        catch (_) { state.boost.gain.value = state.analysisGain; }
      }
      return state.analysisGain;
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureUi, { once: true });
  else ensureUi();

  var uiAttempts = 0;
  var uiTimer = setInterval(function () {
    uiAttempts += 1;
    ensureUi();
    if (document.getElementById('system-audio-dj-btn') || uiAttempts > 20) clearInterval(uiTimer);
  }, 500);

  window.addEventListener('beforeunload', function () { stop(true); }, { once: true });
})();
