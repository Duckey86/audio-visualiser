# System Audio DJ Analyser

The desktop build can optionally feed Windows system output audio into Mineradio's existing real-time FFT and beat analyser.

This is useful when playback happens outside Mineradio's local `<audio>` element, including Spotify Connect playback in the Spotify desktop app.

## How it works

1. Mineradio asks Electron for a Windows loopback audio stream after the user presses the **DJ** button.
2. Electron grants the primary display with `audio: 'loopback'` only to the local Mineradio renderer.
3. The renderer immediately stops and discards the display video track. No screen video is analysed or stored.
4. The remaining audio track is connected to two Web Audio `AnalyserNode`s configured like Mineradio's normal analyser and real-time beat analyser.
5. While the feature is active, those analyser nodes temporarily back the existing visual FFT / kick / beat path.
6. The captured signal is routed only through zero-gain sinks so it is not replayed and does not create an echo. Spotify or the original application remains responsible for audible playback.
7. Turning the feature off stops all capture tracks, closes its `AudioContext`, restores Mineradio's previous analyser nodes, and resets the real-time beat engine.

## Usage

1. Run the Electron desktop build on Windows.
2. Start Spotify Desktop (or another audio application) and play a track.
3. In Mineradio click the **DJ** button near the account / Spotify controls.
4. The green status dot means system-audio analysis is active.
5. Click **DJ** again to stop capture and return to Mineradio's normal analyser.

Capture is never started automatically and is not enabled in the browser build.

## Files

- `desktop/bootstrap.js` — installs the Electron display-media handler for Windows loopback audio before the main window starts.
- `desktop/preload.js` — loads the system-audio analyser only in the Electron renderer.
- `public/system-audio-dj.js` — owns the explicit DJ toggle, loopback stream, Web Audio analysers, and clean restore path.

## Spotify note

Spotify Connect still handles playback and playback controls. This feature does not request, download, proxy, or decode a Spotify audio URL; it analyses the user's local Windows output after playback has already reached the computer.
