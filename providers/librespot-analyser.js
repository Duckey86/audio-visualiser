'use strict';

const { spawn } = require('child_process');
const path = require('path');

let librespot = null;
let ffplay = null;

let levels = {
    bass: 0,
    mid: 0,
    treble: 0,
    volume: 0,
    beat: 0,
    updatedAt: 0
};

function analysePcmS16Stereo(chunk) {
    // 44.1kHz, stereo, signed 16-bit little endian.
    // Frame = 4 bytes: left int16 + right int16.
    let sum = 0;
    let lowSum = 0;
    let highSum = 0;
    let count = 0;

    let prev = 0;
    let zeroCross = 0;

    for (let i = 0; i + 3 < chunk.length; i += 4) {
        const l = chunk.readInt16LE(i) / 32768;
        const r = chunk.readInt16LE(i + 2) / 32768;
        const mono = (l + r) * 0.5;

        sum += mono * mono;

        // Cheap fake band split:
        // low energy = smoothed body
        // high energy = difference/edge movement
        lowSum += Math.abs(mono);
        highSum += Math.abs(mono - prev);

        if ((mono >= 0 && prev < 0) || (mono < 0 && prev >= 0)) zeroCross++;
        prev = mono;
        count++;
    }

    if (!count) return;

    const rms = Math.sqrt(sum / count);
    const low = lowSum / count;
    const high = highSum / count;
    const zcr = zeroCross / count;

    const bassTarget = Math.min(1, low * 3.2);
    const midTarget = Math.min(1, rms * 4.0);
    const trebleTarget = Math.min(1, high * 18 + zcr * 2.0);

    // Smooth values so visuals do not flicker like crazy.
    levels.bass += (bassTarget - levels.bass) * 0.18;
    levels.mid += (midTarget - levels.mid) * 0.18;
    levels.treble += (trebleTarget - levels.treble) * 0.18;
    levels.volume += (Math.min(1, rms * 5) - levels.volume) * 0.18;

    // Simple beat hit from bass spikes.
    const beatTarget = bassTarget > 0.48 && bassTarget > levels.bass + 0.08 ? 1 : 0;
    levels.beat += (beatTarget - levels.beat) * 0.35;

    levels.updatedAt = Date.now();
}

function startLibrespot() {
    if (librespot) return { ok: true, running: true };

    const cacheDir = path.join(process.cwd(), '.librespot-cache');

    librespot = spawn('librespot', [
        '-n', 'Mineradio Analyzer',
        '-b', '160',
        '--enable-oauth',
        '--disable-audio-cache',
        '--cache', cacheDir,
        '--backend', 'pipe',
        '--format', 'S16'
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    // Optional audio output through ffplay.
    const ffplayPath = process.env.FFPLAY_PATH || 'ffplay';

    try {
        ffplay = spawn(ffplayPath, [
            '-f', 's16le',
            '-ar', '44100',
            '-ac', '2',
            '-nodisp',
            '-loglevel', 'quiet',
            '-i', 'pipe:0'
        ], {
            stdio: ['pipe', 'ignore', 'ignore'],
            windowsHide: true
        });

        ffplay.on('error', function (err) {
            console.warn('[ffplay] failed to start:', ffplayPath, err.message);
            ffplay = null;
        });

        ffplay.on('exit', function () {
            ffplay = null;
        });
    } catch (err) {
        console.warn('[ffplay] spawn failed:', ffplayPath, err.message);
        ffplay = null;
    }

    librespot.stdout.on('data', function (chunk) {
        analysePcmS16Stereo(chunk);

        if (ffplay && ffplay.stdin && !ffplay.stdin.destroyed) {
            ffplay.stdin.write(chunk);
        }
    });

    librespot.stderr.on('data', function (chunk) {
        console.log('[librespot]', String(chunk).trim());
    });

    librespot.on('exit', function () {
        librespot = null;
        if (ffplay) {
            try { ffplay.kill(); } catch (_) { }
            ffplay = null;
        }
    });

    return { ok: true, running: true };
}

function stopLibrespot() {
    if (librespot) {
        try { librespot.kill(); } catch (_) { }
        librespot = null;
    }

    if (ffplay) {
        try { ffplay.kill(); } catch (_) { }
        ffplay = null;
    }

    return { ok: true, running: false };
}

function getLevels() {
    return levels;
}

module.exports = {
    startLibrespot,
    stopLibrespot,
    getLevels
};