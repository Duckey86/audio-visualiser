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
    prevBeatSpectrum: null,
    fluxPrimed: false,
    lastFrameAt: 0,
    lastHudAt: 0,
    analysisGain: 1.10,

    bassPeak: 0.22,
    midPeak: 0.20,
    highPeak: 0.16,
    prevBassRaw: 0,
    fastBass: 0,
    slowBass: 0,
    fluxMean: 0.010,
    fluxDev: 0.006,
    smoothBass: 0,
    smoothMid: 0,
    smoothTreble: 0,
    smoothEnergy: 0,
    meterBass: 0,
    meterMid: 0,
    meterHigh: 0,
    albumBass: 0,
    beatPulse: 0,
    lastBeatAt: 0,
    beatIntervals: [],
    bpm: 0,
    bpmConfidence: 0,
    beatCount: 0,

    particleBaseScale: 1,
    bloomBaseScale: 1,
    uniformGuards: [],
    uniformGuardsInstalled: false,

    frame: {
      rawBass: 0,
      rawMid: 0,
      rawTreble: 0,
      bassFlux: 0,
      bassTransient: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      meterBass: 0,
      meterMid: 0,
      meterHigh: 0,
      albumBass: 0,
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
      var w = 0.90 + Math.sin(p * Math.PI) * 0.10;
      total += (data[i] / 255) * w;
      weight += w;
    }
    return weight > 0 ? total / weight : 0;
  }

  function lowBandFlux(data, analyserNode, minHz, maxHz) {
    if (!data || !data.length || !analyserNode || !state.context) return 0;

    if (!state.prevBeatSpectrum || state.prevBeatSpectrum.length !== data.length) {
      state.prevBeatSpectrum = new Uint8Array(data.length);
      state.prevBeatSpectrum.set(data);
      state.fluxPrimed = false;
      return 0;
    }

    var nyquist = state.context.sampleRate * 0.5;
    var binHz = nyquist / data.length;
    var start = Math.max(0, Math.floor(minHz / binHz));
    var end = Math.min(data.length - 1, Math.ceil(maxHz / binHz));
    var total = 0;
    var weight = 0;

    for (var i = start; i <= end; i++) {
      var current = data[i] / 255;
      var previous = state.prevBeatSpectrum[i] / 255;
      var positive = Math.max(0, current - previous);
      var p = end === start ? 0.5 : (i - start) / (end - start);
      var w = 0.92 + Math.sin(p * Math.PI) * 0.08;
      total += positive * w;
      weight += w;
      state.prevBeatSpectrum[i] = data[i];
    }

    if (!state.fluxPrimed) {
      state.fluxPrimed = true;
      return 0;
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
    if (gap < 90 || gap > 1500) return;

    // Fast repeated kicks can be 1/8 or 1/16 notes. Fold very short gaps up to
    // a musically useful beat interval instead of throwing them away.
    var normalizedGap = gap;
    while (normalizedGap < 280) normalizedGap *= 2;
    while (normalizedGap > 900) normalizedGap *= 0.5;

    state.beatIntervals.push(normalizedGap);
    if (state.beatIntervals.length > 12) state.beatIntervals.shift();
    if (state.beatIntervals.length < 3) return;

    var center = median(state.beatIntervals);
    var bpm = center > 0 ? 60000 / center : 0;
    while (bpm > 190) bpm *= 0.5;
    while (bpm > 0 && bpm < 68) bpm *= 2;
    var spread = center > 0 ? standardDeviation(state.beatIntervals, center) / center : 1;
    state.bpm = Math.round(bpm);
    state.bpmConfidence = clamp01((state.beatIntervals.length / 7) * (1 - Math.min(0.85, spread * 2.8)));
  }

  function currentPreset() {
    try {
      if (typeof fx !== 'undefined' && fx && Number.isFinite(Number(fx.preset))) return Number(fx.preset);
    } catch (_) {}
    return 0;
  }

  function isAlbumPreset() {
    var preset = currentPreset();
    return preset < 0.5 || (preset > 3.5 && preset < 4.5);
  }

  function currentVisualIntensity() {
    var intensity = 0.85;
    try {
      if (typeof fx !== 'undefined' && fx && Number.isFinite(Number(fx.intensity))) intensity = Number(fx.intensity);
    } catch (_) {}
    return clamp(intensity, 0.35, 1.20);
  }

  function resetLiveAnalysis() {
    state.bassPeak = 0.22;
    state.midPeak = 0.20;
    state.highPeak = 0.16;
    state.prevBassRaw = 0;
    state.fastBass = 0;
    state.slowBass = 0;
    state.fluxMean = 0.010;
    state.fluxDev = 0.006;
    state.smoothBass = 0;
    state.smoothMid = 0;
    state.smoothTreble = 0;
    state.smoothEnergy = 0;
    state.meterBass = 0;
    state.meterMid = 0;
    state.meterHigh = 0;
    state.albumBass = 0;
    state.beatPulse = 0;
    state.lastBeatAt = 0;
    state.beatIntervals = [];
    state.bpm = 0;
    state.bpmConfidence = 0;
    state.beatCount = 0;
    state.prevBeatSpectrum = null;
    state.fluxPrimed = false;
    state.lastFrameAt = 0;
    state.lastHudAt = 0;
    state.frame = {
      rawBass: 0,
      rawMid: 0,
      rawTreble: 0,
      bassFlux: 0,
      bassTransient: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      meterBass: 0,
      meterMid: 0,
      meterHigh: 0,
      albumBass: 0,
      beat: 0,
      beatDetected: false,
      bpm: 0,
      bpmConfidence: 0,
      rawEnergy: 0,
      timestamp: 0,
    };
  }

  function readLiveFrame(now, dt) {
    if (!state.analyser || !state.beatAnalyser || !state.freqData || !state.beatData) return null;

    state.beatAnalyser.getByteFrequencyData(state.beatData);
    state.analyser.getByteFrequencyData(state.freqData);

    // Slightly wider than the previous 38-128 Hz window so repeated kick thumps
    // around 120-145 Hz still register, while staying out of most lower mids.
    var rawBass = bandAverage(state.beatData, state.beatAnalyser, 38, 145);
    var bassFlux = lowBandFlux(state.beatData, state.beatAnalyser, 38, 160);
    var rawMid = bandAverage(state.freqData, state.analyser, 260, 1650);
    var rawTreble = bandAverage(state.freqData, state.analyser, 2800, 10500);
    var rawEnergy = spectrumEnergy(state.freqData);

    state.bassPeak = Math.max(rawBass, state.bassPeak * Math.exp(-dt * 0.55), 0.18);
    state.midPeak = Math.max(rawMid, state.midPeak * Math.exp(-dt * 0.28), 0.18);
    state.highPeak = Math.max(rawTreble, state.highPeak * Math.exp(-dt * 0.30), 0.15);

    var bassLevel = dynamicLevel(rawBass, state.bassPeak, 0.034);
    var midLevel = dynamicLevel(rawMid, state.midPeak, 0.030);
    var highLevel = dynamicLevel(rawTreble, state.highPeak, 0.024);
    var energyLevel = clamp01((rawEnergy - 0.028) / 0.40);

    state.smoothBass = follow(state.smoothBass, bassLevel, dt, 34, 10.0);
    state.smoothMid = follow(state.smoothMid, midLevel, dt, 13, 4.5);
    state.smoothTreble = follow(state.smoothTreble, highLevel, dt, 17, 5.5);
    state.smoothEnergy = follow(state.smoothEnergy, energyLevel, dt, 14, 4.5);

    state.meterBass = follow(state.meterBass, bassLevel, dt, 11, 4.8);
    state.meterMid = follow(state.meterMid, Math.pow(midLevel, 1.45) * 0.74, dt, 7, 3.0);
    state.meterHigh = follow(state.meterHigh, Math.pow(highLevel, 1.35) * 0.74, dt, 8, 3.2);

    // Separate fast/slow envelopes make each repeated bass onset visible even
    // when the overall bass level stays high for the whole pattern.
    state.fastBass = follow(state.fastBass, bassLevel, dt, 92, 28);
    state.slowBass = follow(state.slowBass, bassLevel, dt, 7.0, 6.0);
    var bassTransient = Math.max(0, state.fastBass - state.slowBass);

    // Faster release than before, so a 1/8 or 1/16 pattern can visibly contract
    // between hits instead of looking like one long swollen album.
    state.albumBass = follow(state.albumBass, bassLevel, dt, 72, 14.5);

    var rise = Math.max(0, rawBass - state.prevBassRaw);
    state.prevBassRaw = rawBass;

    // Adaptive spectral-flux floor. Continuous bass sits near the floor; each
    // fresh low-frequency onset produces a positive spike, which is much better
    // for repeated kicks than a long 285 ms lockout.
    var fluxDelta = bassFlux - state.fluxMean;
    var fluxBlend = fluxDelta > 0 ? 0.012 : 0.055;
    state.fluxMean += fluxDelta * fluxBlend;
    var fluxAbs = Math.abs(bassFlux - state.fluxMean);
    state.fluxDev += (fluxAbs - state.fluxDev) * 0.040;
    var fluxZ = (bassFlux - state.fluxMean) / Math.max(0.0035, state.fluxDev);

    state.beatPulse *= Math.exp(-dt * 28.0);
    if (state.beatPulse < 0.002) state.beatPulse = 0;

    var transientScore = clamp01(bassTransient * 3.8);
    var fluxScore = clamp01(Math.max(0, fluxZ - 0.45) * 0.60 + bassFlux * 4.2);
    var riseScore = clamp01(rise * 5.0);
    var strongScore = clamp01(fluxScore * 0.55 + transientScore * 0.32 + riseScore * 0.13);

    var beatDetected = false;
    var minGap = 95;
    var fluxFloor = state.fluxMean + Math.max(0.0045, state.fluxDev * 0.82);
    var onsetEvidence = (
      (bassFlux > fluxFloor && fluxZ > 0.72)
      || (bassTransient > 0.115 && rise > 0.006)
    );

    if (
      bassLevel > 0.34
      && rawBass > 0.100
      && onsetEvidence
      && strongScore > 0.48
      && (!state.lastBeatAt || now - state.lastBeatAt >= minGap)
    ) {
      updateBpm(now);
      state.lastBeatAt = now;
      state.beatCount++;
      state.beatPulse = Math.max(state.beatPulse, 0.72 + strongScore * 0.28);
      beatDetected = true;
    }

    var intensity = currentVisualIntensity();
    var bass = clamp01(state.smoothBass * 0.70 * intensity);
    var mid = clamp01(state.smoothMid * 0.48 * intensity);
    var treble = clamp01(state.smoothTreble * 0.48 * intensity);
    var energy = clamp01(state.smoothEnergy * 0.60);

    state.frame = {
      rawBass: rawBass,
      rawMid: rawMid,
      rawTreble: rawTreble,
      bassFlux: bassFlux,
      bassTransient: bassTransient,
      bass: bass,
      mid: mid,
      treble: treble,
      energy: energy,
      meterBass: clamp01(state.meterBass * 0.88),
      meterMid: clamp01(state.meterMid),
      meterHigh: clamp01(state.meterHigh),
      albumBass: clamp01(state.albumBass),
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

  function installUniformGuard(name, albumValue) {
    try {
      if (typeof uniforms === 'undefined' || !uniforms || !uniforms[name]) return false;
      var slot = uniforms[name];
      var descriptor = Object.getOwnPropertyDescriptor(slot, 'value');
      if (descriptor && descriptor.configurable === false) return false;
      var stored = slot.value;

      Object.defineProperty(slot, 'value', {
        configurable: true,
        enumerable: true,
        get: function () { return stored; },
        set: function (next) {
          stored = state.active && isAlbumPreset() ? albumValue : next;
        },
      });

      if (state.active && isAlbumPreset()) slot.value = albumValue;

      state.uniformGuards.push({
        slot: slot,
        descriptor: descriptor,
        getStored: function () { return stored; },
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function ensureUniformGuards() {
    if (state.uniformGuardsInstalled) return;
    try {
      if (typeof uniforms === 'undefined' || !uniforms) return;
      var bassOk = installUniformGuard('uBass', 0);
      var beatOk = installUniformGuard('uBeat', 0);
      var burstOk = installUniformGuard('uBurstAmt', 0);
      state.uniformGuardsInstalled = !!(bassOk || beatOk || burstOk);
    } catch (_) {}
  }

  function restoreUniformGuards() {
    for (var i = state.uniformGuards.length - 1; i >= 0; i--) {
      var guard = state.uniformGuards[i];
      try {
        var value = guard.getStored();
        if (guard.descriptor) {
          var restored = Object.assign({}, guard.descriptor);
          if (Object.prototype.hasOwnProperty.call(restored, 'value')) restored.value = value;
          Object.defineProperty(guard.slot, 'value', restored);
        } else {
          delete guard.slot.value;
          guard.slot.value = value;
        }
      } catch (_) {}
    }
    state.uniformGuards = [];
    state.uniformGuardsInstalled = false;
  }

  function bridgeFrameIntoMineradio(frame) {
    if (!frame) return;
    ensureUniformGuards();

    if (isAlbumPreset()) {
      // Album mode uses whole-object scale pulses only. Keep the original
      // shader's travelling bass/beat/burst ripples suppressed.
      try { smoothBass = 0; } catch (_) { window.__mineradioSystemBass = 0; }
      try { smoothMid = frame.mid; } catch (_) { window.__mineradioSystemMid = frame.mid; }
      try { smoothTreb = frame.treble; } catch (_) { window.__mineradioSystemTreble = frame.treble; }
      try { smoothEnergy = frame.energy; } catch (_) { window.__mineradioSystemEnergy = frame.energy; }
      try { beatPulse = 0; } catch (_) { window.__mineradioSystemBeat = 0; }
      try { beatOnsetFlag = false; } catch (_) {}

      setUniformValue('uBass', 0, false);
      setUniformValue('uMid', frame.mid, false);
      setUniformValue('uTreble', frame.treble, false);
      setUniformValue('uEnergy', frame.energy, false);
      setUniformValue('uBeat', 0, false);
      setUniformValue('uBurstAmt', 0, false);
    } else {
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
      if (frame.beatDetected) setUniformValue('uBurstAmt', 0.34 + frame.beat * 0.10, true);
    }

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
    if (!frame || !isAlbumPreset()) return;

    // Keep continuous bass breathing subtle. Repeated onsets are represented by
    // the short beat envelope so separate hits read as separate punches.
    var albumDrive = clamp01((frame.albumBass - 0.34) / 0.66);
    albumDrive = Math.pow(albumDrive, 1.45);
    var scale = 1 + albumDrive * 0.012 + frame.beat * 0.055;

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
      glow.style.opacity = String(Math.min(0.065, frame.beat * 0.058));
      glow.style.transform = 'translate(-50%,-50%) scale(' + (0.96 + frame.beat * 0.050).toFixed(3) + ')';
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
      glow.style.transform = 'translate(-50%,-50%) scale(.96)';
    }
  }

  function updateHud(frame, now) {
    if (!frame) return;
    var hud = document.getElementById('system-audio-dj-hud');
    var button = document.getElementById('system-audio-dj-btn');
    if (!hud) return;

    if (button) button.style.setProperty('--system-dj-beat', frame.beat.toFixed(3));
    if (now - state.lastHudAt < 42 && !frame.beatDetected) return;
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
      beatLamp.style.transform = 'scale(' + (1 + frame.beat * 0.38).toFixed(3) + ')';
      beatLamp.style.opacity = String(0.30 + frame.beat * 0.48);
    }

    var audible = frame.rawEnergy > 0.022;
    var locked = audible && state.beatCount >= 2;
    if (status) {
      status.textContent = !audible ? 'NO AUDIO' : (locked ? 'SYNC' : 'LISTENING');
      status.classList.toggle('locked', locked);
    }
    if (bpm) bpm.textContent = state.bpm && state.bpmConfidence > 0.18 ? state.bpm + ' BPM' : '-- BPM';

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
        '#system-audio-dj-btn{position:relative;font-weight:800;letter-spacing:-.04em;--system-dj-beat:0;transform:scale(calc(1 + var(--system-dj-beat)*.035));transition:opacity .15s ease}',
        '#system-audio-dj-btn::after{content:"";position:absolute;right:5px;bottom:5px;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.28)}',
        '#system-audio-dj-btn.active::after{background:#1ed760;box-shadow:0 0 calc(7px + var(--system-dj-beat)*6px) rgba(30,215,96,.62)}',
        '#system-audio-dj-btn.busy{opacity:.72}',
        '#system-audio-dj-hud{position:fixed;top:64px;left:50%;z-index:2147483000;width:260px;transform:translateX(-50%) scale(.98);padding:10px 12px 9px;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:rgba(5,7,10,.72);backdrop-filter:blur(14px);box-shadow:0 10px 28px rgba(0,0,0,.32);color:#fff;font:700 10px/1.1 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.08em;pointer-events:none;opacity:0;transition:opacity .18s ease,transform .18s ease}',
        'body.system-audio-dj-active #system-audio-dj-hud{opacity:.90;transform:translateX(-50%) scale(1)}',
        '#system-audio-dj-hud.hit{animation:systemDjHudHit 105ms ease-out}',
        '.system-dj-title{display:flex;align-items:center;gap:7px;margin-bottom:8px}',
        '#system-audio-dj-beat-lamp{display:block;width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 7px rgba(255,255,255,.48);transform-origin:center}',
        '#system-audio-dj-sync-status{margin-left:auto;color:rgba(255,255,255,.52);font-size:9px}',
        '#system-audio-dj-sync-status.locked{color:#74ffae;text-shadow:0 0 8px rgba(80,255,145,.28)}',
        '.system-dj-meter{display:grid;grid-template-columns:38px 1fr;align-items:center;gap:7px;margin:4px 0;color:rgba(255,255,255,.55);font-size:8px}',
        '.system-dj-meter i{display:block;height:4px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.10)}',
        '.system-dj-meter b{display:block;width:100%;height:100%;transform:scaleX(0);transform-origin:left center;background:rgba(255,255,255,.80);border-radius:inherit;will-change:transform}',
        '.system-dj-bpm{margin-top:7px;text-align:right;color:rgba(255,255,255,.68);font-variant-numeric:tabular-nums;font-size:9px}',
        '#system-audio-dj-album-glow{position:fixed;z-index:1;left:50%;top:50%;width:min(40vw,40vh);height:min(40vw,40vh);border-radius:50%;pointer-events:none;opacity:0;transform:translate(-50%,-50%) scale(.96);background:radial-gradient(circle,rgba(255,255,255,.08) 0%,rgba(255,255,255,.025) 32%,rgba(255,255,255,0) 72%);filter:blur(14px);mix-blend-mode:screen;will-change:opacity,transform;transition:opacity 32ms linear}',
        '@keyframes systemDjHudHit{0%{filter:brightness(1.12);transform:translateX(-50%) scale(1.005)}100%{filter:brightness(1);transform:translateX(-50%) scale(1)}}'
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
    restoreUniformGuards();

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

      mainAnalyser.fftSize = Math.max(2048, Math.min(4096, Number(safeRead('FFT_SIZE', 2048)) || 2048));
      mainAnalyser.smoothingTimeConstant = 0.035;
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
      ensureUniformGuards();
      updateButton();
      startVisualLoop();
      toast('V2.1 LIVE · repeated bass tracking enabled');
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
