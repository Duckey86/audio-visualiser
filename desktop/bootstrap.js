'use strict';

const { app, desktopCapturer, screen, session } = require('electron');

let displayMediaHandlerInstalled = false;

function isTrustedCaptureOrigin(rawOrigin) {
  const value = String(rawOrigin || '').trim();
  if (!value) return false;

  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return true;
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch (_) {
    return false;
  }
}

function selectPrimaryScreenSource(sources) {
  if (!Array.isArray(sources) || !sources.length) return null;

  try {
    const primaryId = String(screen.getPrimaryDisplay().id);
    const primary = sources.find((source) => String(source.display_id || '') === primaryId);
    if (primary) return primary;
  } catch (_) {}

  return sources[0] || null;
}

function installSystemAudioCaptureHandler() {
  if (displayMediaHandlerInstalled) return;
  displayMediaHandlerInstalled = true;

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let completed = false;
    const finish = (streams) => {
      if (completed) return;
      completed = true;
      try { callback(streams || {}); } catch (_) {}
    };

    try {
      // Capture is intentionally limited to Mineradio's local renderer and must
      // originate from a user action. The renderer exposes an explicit DJ button.
      if (!isTrustedCaptureOrigin(request && request.securityOrigin)) {
        finish({});
        return;
      }
      if (request && request.userGesture === false) {
        finish({});
        return;
      }
      if (!request || !request.audioRequested) {
        finish({});
        return;
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      const selected = selectPrimaryScreenSource(sources);
      if (!selected) {
        finish({});
        return;
      }

      // Electron's loopback stream is Windows system output audio. A display
      // video track is required by getDisplayMedia; the renderer stops it as
      // soon as the stream is granted and retains only the audio track.
      finish({
        video: selected,
        audio: 'loopback',
      });
    } catch (error) {
      console.warn('System audio capture request failed:', error && error.message ? error.message : error);
      finish({});
    }
  });
}

// Register before desktop/main.js installs its app.whenReady callback so the
// display-media handler exists before the main BrowserWindow is created.
app.once('ready', installSystemAudioCaptureHandler);

require('./main.js');
