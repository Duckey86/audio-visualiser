'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSpotifyProvider } = require('../providers/spotify-provider');

function response(payload, status) {
  return {
    ok: !status || status < 400,
    status: status || 200,
    headers: { get: function () { return ''; } },
    json: async function () { return payload; },
  };
}

function makeProvider() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-spotify-'));
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({
    clientId: '1234567890abcdef',
    accessToken: 'test-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 600000,
  }));
  let result = null;
  const provider = createSpotifyProvider({
    authFile: authFile,
    port: 3000,
    readBody: async function () { return {}; },
    sendJSON: function (_res, payload, status) { result = { payload: payload, status: status || 200 }; },
  });
  return { provider: provider, result: function () { return result; }, cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('liked tracks paginate to the requested limit', async function (t) {
  const fixture = makeProvider();
  t.after(fixture.cleanup);
  const originalFetch = global.fetch;
  t.after(function () { global.fetch = originalFetch; });
  let page = 0;
  global.fetch = async function () {
    page += 1;
    const start = (page - 1) * 50;
    const count = page === 1 ? 50 : 10;
    return response({
      total: 60,
      next: page === 1 ? 'https://api.spotify.com/v1/me/tracks?offset=50&limit=50' : null,
      items: Array.from({ length: count }, function (_, index) {
        const id = String(start + index + 1);
        return { track: { id: id, name: 'Track ' + id, uri: 'spotify:track:' + id, artists: [], album: { images: [] }, duration_ms: 1000 } };
      }),
    });
  };
  await fixture.provider.handle({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/spotify/library/tracks?limit=60'));
  assert.equal(fixture.result().status, 200);
  assert.equal(fixture.result().payload.songs.length, 60);
  assert.equal(page, 2);
});

test('playlist library excludes inaccessible followed playlists', async function (t) {
  const fixture = makeProvider();
  t.after(fixture.cleanup);
  const originalFetch = global.fetch;
  t.after(function () { global.fetch = originalFetch; });
  global.fetch = async function (url) {
    if (String(url).endsWith('/me')) return response({ id: 'owner' });
    return response({ items: [
      { id: 'mine', name: 'Mine', owner: { id: 'owner' }, items: { total: 2 }, images: [] },
      { id: 'shared', name: 'Shared', owner: { id: 'friend' }, collaborative: true, items: { total: 3 }, images: [] },
      { id: 'followed', name: 'Followed', owner: { id: 'artist' }, items: { total: 4 }, images: [] },
    ], next: null, total: 3 });
  };
  await fixture.provider.handle({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/spotify/library/playlists'));
  assert.deepEqual(fixture.result().payload.playlists.map(function (item) { return item.id; }), ['mine', 'shared']);
});
