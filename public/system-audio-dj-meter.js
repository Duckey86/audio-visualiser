(function () {
  'use strict';

  var state = {
    raf: 0,
    floatData: null,
    byteData: null,
    analyser: null,
    display: 0,
    rawBassDb: -100,
  };

  function clamp(value, min, max) {
    value = Number(value);
    if (!Number.isFinite(value)) value = min;
    return Math.max(min, Math.min(max, value));
  }

  function analyserBassDb(analyser) {
    if (!analyser) return -100;

    var context = analyser.context;
    var sampleRate = context && context.sampleRate ? context.sampleRate : 48000;
    var binCount = analyser.frequencyBinCount || 0;
    if (!binCount) return -100;

    var nyquist = sampleRate * 0.5;
    var binHz = nyquist / binCount;
    var start = Math.max(0, Math.floor(35 / binHz));
    var end = Math.min(binCount - 1, Math.ceil(180 / binHz));
    if (end < start) return -100;

    if (typeof analyser.getFloatFrequencyData === 'function') {
      if (!state.floatData || state.floatData.length !== binCount) {
        state.floatData = new Float32Array(binCount);
      }
      analyser.getFloatFrequencyData(state.floatData);

      // Average in linear power, then convert back to dB. This gives a much
      // more useful diagnostic meter than the already-amplified visual bass.
      var power = 0;
      var count = 0;
      for (var i = start; i <= end; i++) {
        var db = state.floatData[i];
        if (!Number.isFinite(db)) continue;
        power += Math.pow(10, db / 10);
        count++;
      }
      if (!count || power <= 0) return -100;
      return 10 * Math.log10(power / count);
    }

    if (!state.byteData || state.byteData.length !== binCount) {
      state.byteData = new Uint8Array(binCount);
    }
    analyser.getByteFrequencyData(state.byteData);
    var total = 0;
    var n = 0;
    for (var j = start; j <= end; j++) {
      total += state.byteData[j] / 255;
      n++;
    }
    var normalized = n ? total / n : 0;
    return -80 + normalized * 68;
  }

  function dbToMeter(db) {
    // -72 dB is effectively quiet for this diagnostic; around -13 dB reaches
    // the end of the bar. Loud kicks can hit 100%, but normal passages should
    // visibly move throughout the range instead of sitting permanently full.
    var normalized = (db + 72) / 59;
    normalized = clamp(normalized, 0, 1);
    // Slight curve preserves detail in quieter sections.
    return Math.pow(normalized, 1.18);
  }

  function tick() {
    state.raf = requestAnimationFrame(tick);

    var api = window.SystemAudioDJ;
    var bar = document.getElementById('system-audio-dj-bass');
    if (!api || typeof api.isActive !== 'function' || !api.isActive() || !bar) {
      state.display += (0 - state.display) * 0.18;
      if (bar) bar.style.transform = 'scaleX(' + state.display.toFixed(3) + ')';
      return;
    }

    var analyser = typeof api.getAnalyser === 'function' ? api.getAnalyser() : null;
    if (!analyser) return;
    state.analyser = analyser;

    var db = analyserBassDb(analyser);
    state.rawBassDb = db;
    var target = dbToMeter(db);

    // Fast attack, slower release so individual bass hits are readable.
    var blend = target > state.display ? 0.38 : 0.12;
    state.display += (target - state.display) * blend;
    state.display = clamp(state.display, 0, 1);

    bar.style.transform = 'scaleX(' + state.display.toFixed(3) + ')';
    bar.title = 'Raw 35–180 Hz: ' + db.toFixed(1) + ' dB';
  }

  window.SystemAudioDJMeter = {
    getRawBassDb: function () { return state.rawBassDb; },
    getDisplayValue: function () { return state.display; },
  };

  state.raf = requestAnimationFrame(tick);
})();
