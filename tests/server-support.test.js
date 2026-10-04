import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import {
  attachLocalRelay,
  buildGeminiUpstreamUrl,
  geminiProxyAllowed,
  getActivityInfo,
  getInstanceInfo,
  isLocalClient,
  isObsAllowedPath,
  isOperatorClient,
  isPrivateLan,
  isTranslationSessionActive,
  publicApiKeyStatus,
  setActiveRelay,
  trimPreview
} from '../server-support.js';

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function nextJson(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      socket.off('error', onError);
      resolve(JSON.parse(raw.toString()));
    };
    const onError = error => {
      socket.off('message', onMessage);
      reject(error);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

// Runs `body` against a real relay on a random local port. `connect()` opens a
// screen/dashboard socket and resolves with it and the relay's first message.
async function withRelay(body) {
  const server = http.createServer();
  const relay = attachLocalRelay(server);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve());
  });
  const url = `ws://127.0.0.1:${server.address().port}/local-subtitles-ws`;
  const sockets = [];
  const connect = async () => {
    const socket = new WebSocket(url);
    socket.on('error', () => {});
    sockets.push(socket);
    const hello = nextJson(socket);
    await onceOpen(socket);
    return { socket, hello: await hello };
  };
  try {
    await body({ connect });
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const client of relay.wss.clients) client.terminate();
    await new Promise(resolve => relay.wss.close(() => resolve()));
    await new Promise(resolve => server.close(() => resolve()));
    setActiveRelay(null);
  }
}

test('instance info reports version and commit without secrets', async () => {
  const info = await getInstanceInfo();
  const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  assert.equal(info.application, 'live-translate');
  assert.equal(info.version, packageVersion);
  assert.match(info.commit, /^[0-9a-f]{7,40}$/);
  assert.equal(info.translationActive, false);
  assert.equal(isTranslationSessionActive(), false);
  assert.equal('apiKey' in info, false);
  assert.equal('geminiApiKey' in info, false);
});

test('API key status never includes the secret', () => {
  const configured = publicApiKeyStatus('A'.repeat(40));
  assert.deepEqual(configured, { configured: true });
  assert.equal('apiKey' in configured, false);

  const missing = publicApiKeyStatus('');
  assert.deepEqual(missing, { configured: false });
  assert.equal('apiKey' in missing, false);

  const warning = publicApiKeyStatus('', 'Enter the key again.');
  assert.equal(warning.configured, false);
  assert.equal(warning.warning, 'Enter the key again.');
  assert.equal('apiKey' in warning, false);
});

test('OBS overlay cannot traverse into the dashboard', () => {
  const distDir = path.resolve('/tmp/live-translate-dist');
  assert.equal(isObsAllowedPath('subtitles.html', distDir), true);
  assert.equal(isObsAllowedPath('assets/main.js', distDir), true);
  assert.equal(isObsAllowedPath('favicon.svg', distDir), true);
  assert.equal(isObsAllowedPath('index.html', distDir), false);
  assert.equal(isObsAllowedPath('assets/../index.html', distDir), false);
  assert.equal(isObsAllowedPath('../index.html', distDir), false);
  assert.equal(isObsAllowedPath('audio-sender.html', distDir), false);
});

test('the relay sends screens each piece with its sequence and the full recent text', async () => {
  await withRelay(async ({ connect }) => {
    const { socket: viewer, hello } = await connect();
    const { socket: dashboard } = await connect();
    assert.equal(hello.type, 'sync');
    assert.deepEqual(hello.state.lang1, { text: '', seq: 0 });

    dashboard.send(JSON.stringify({ type: 'append', lane: 'lang1', text: 'Amen.' }));
    assert.deepEqual(await nextJson(viewer), { type: 'append', lane: 'lang1', text: 'Amen.', seq: 1, full: 'Amen.' });

    dashboard.send(JSON.stringify({ type: 'append', lane: 'lang1', text: ' I would like to read' }));
    const second = await nextJson(viewer);
    assert.equal(second.seq, 2);
    assert.equal(second.full, 'Amen. I would like to read');

    // A dashboard tab still running the previous release sends 'update'.
    dashboard.send(JSON.stringify({ type: 'update', lane: 'lang1', text: ' the word of God.', isFinal: false }));
    const legacy = await nextJson(viewer);
    assert.equal(legacy.type, 'append');
    assert.equal(legacy.full, 'Amen. I would like to read the word of God.');

    // Bad lanes and oversized text are ignored, not stored.
    dashboard.send(JSON.stringify({ type: 'append', lane: 'targetLanguage1', text: 'x' }));
    dashboard.send(JSON.stringify({ type: 'append', lane: 'lang1', text: 'x'.repeat(5000) }));
    dashboard.send(JSON.stringify({ type: 'append', lane: 'lang2', text: 'Bună ziua' }));
    const next = await nextJson(viewer);
    assert.equal(next.lane, 'lang2');
    assert.equal(next.seq, 1);
  });
});

test('a screen that connects mid-sermon receives the recent text at once', async () => {
  await withRelay(async ({ connect }) => {
    const { socket: dashboard } = await connect();
    const { socket: watcher } = await connect();
    for (const text of ['Amen.', ' Please be seated.']) {
      dashboard.send(JSON.stringify({ type: 'append', lane: 'lang1', text }));
      await nextJson(watcher);
    }
    const { hello } = await connect();
    assert.equal(hello.type, 'sync');
    assert.deepEqual(hello.state.lang1, { text: 'Amen. Please be seated.', seq: 2 });
  });
});

test('replace and clear reach every screen', async () => {
  await withRelay(async ({ connect }) => {
    const { socket: viewer } = await connect();
    const { socket: dashboard } = await connect();

    dashboard.send(JSON.stringify({
      type: 'replace',
      lang1: { text: 'Hello there friends', seq: 7 },
      lang2: { text: 'Bună ziua', seq: 2 }
    }));
    const snapshot = await nextJson(viewer);
    assert.equal(snapshot.type, 'sync');
    assert.deepEqual(snapshot.state.lang1, { text: 'Hello there friends', seq: 7 });
    assert.deepEqual(snapshot.state.lang2, { text: 'Bună ziua', seq: 2 });

    dashboard.send(JSON.stringify({ type: 'clear' }));
    assert.equal((await nextJson(viewer)).type, 'clear');
    const { hello } = await connect();
    assert.deepEqual(hello.state.lang1, { text: '', seq: 0 });
    assert.deepEqual(hello.state.lang2, { text: '', seq: 0 });
  });
});

test('an oversized message from one device does not stop the server', async () => {
  await withRelay(async ({ connect }) => {
    const { socket: viewer } = await connect();
    const { socket: attacker } = await connect();
    const closed = new Promise(resolve => attacker.once('close', code => resolve(code)));
    attacker.send('x'.repeat(3 * 1024 * 1024));
    assert.equal(await closed, 1009);

    // The relay is still serving the other screens.
    const { socket: dashboard } = await connect();
    const update = nextJson(viewer);
    dashboard.send(JSON.stringify({ type: 'append', lane: 'lang1', text: 'Still live.' }));
    assert.equal((await update).full, 'Still live.');
  });
});

test('Gemini proxy allows this computer and private LAN clients, and hides the key from the dashboard URL', () => {
  const url = buildGeminiUpstreamUrl('secret-key');
  assert.match(url, /^wss:\/\/generativelanguage\.googleapis\.com\//);
  assert.match(url, /v1beta/);
  assert.equal(url.includes('v1alpha'), false);
  assert.match(url, /key=secret-key/);

  assert.equal(isLocalClient('127.0.0.1'), true);
  assert.equal(isLocalClient('::1'), true);
  assert.equal(isLocalClient('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateLan('192.168.1.50'), true);
  assert.equal(isPrivateLan('10.0.0.12'), true);
  assert.equal(isPrivateLan('172.16.0.8'), true);
  assert.equal(isPrivateLan('::ffff:192.168.0.20'), true);
  assert.equal(isPrivateLan('169.254.1.1'), true);
  assert.equal(isPrivateLan('172.15.0.1'), false);
  assert.equal(isPrivateLan('8.8.8.8'), false);
  assert.equal(isOperatorClient('127.0.0.1'), true);
  assert.equal(isOperatorClient('192.168.1.50'), true);
  assert.equal(isOperatorClient('8.8.8.8'), false);
  assert.equal(geminiProxyAllowed('127.0.0.1', 'secret-key').ok, true);
  assert.equal(geminiProxyAllowed('::1', 'secret-key').ok, true);
  assert.equal(geminiProxyAllowed('192.168.1.50', 'secret-key').ok, true);
  assert.equal(geminiProxyAllowed('10.8.0.2', 'secret-key').ok, true);
  assert.equal(geminiProxyAllowed('8.8.8.8', 'secret-key').ok, false);
  assert.equal(geminiProxyAllowed('127.0.0.1', '').ok, false);
});

test('trimPreview preserves short text and keeps the last 240 characters of long text', () => {
  assert.equal(trimPreview(''), '');
  assert.equal(trimPreview(null), '');
  assert.equal(trimPreview('Live sermon captions'), 'Live sermon captions');
  const longText = 'x'.repeat(300);
  const trimmed = trimPreview(longText);
  assert.equal(trimmed.length, 240);
  assert.equal(trimmed, 'x'.repeat(240));

  const textWithMarker = 'OLD_PREFIX_' + 'y'.repeat(230) + '_NEW_SUFFIX';
  const trimmedMarker = trimPreview(textWithMarker);
  assert.equal(trimmedMarker.length, 240);
  assert.equal(trimmedMarker.endsWith('_NEW_SUFFIX'), true);
  assert.equal(trimmedMarker.includes('OLD_PREFIX_'), false);
});

test('getActivityInfo returns zeros and empty previews without listening on a port', async () => {
  const info = await getActivityInfo(null);
  assert.equal(info.application, 'live-translate');
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof info.commit, 'string');
  assert.equal(info.commit.length <= 7, true);
  assert.equal(info.translationActive, false);
  assert.equal(typeof info.geminiConnections, 'number');
  assert.equal(typeof info.apiKeyConfigured, 'boolean');
  assert.deepEqual(info.relay, { clients: 0, audioSenders: 0, audioStreaming: false });
  assert.deepEqual(info.previews, { lang1: '', lang2: '' });
  assert.equal(info.setup.subtitlePacing, 'smooth');
  assert.equal(info.setup.obsLanguage, 'both');
  assert.equal('apiKey' in info, false);
  assert.equal('geminiApiKey' in info, false);

  const dummyServer = http.createServer();
  const relay = attachLocalRelay(dummyServer);
  try {
    const snapshot = relay.getSnapshot();
    assert.deepEqual(snapshot.relay, { clients: 0, audioSenders: 0, audioStreaming: false });
    assert.deepEqual(snapshot.previews, { lang1: '', lang2: '' });
    assert.equal(snapshot.setup.subtitlePacing, 'smooth');
  } finally {
    relay.wss.close();
    dummyServer.close();
    setActiveRelay(null);
  }
});

