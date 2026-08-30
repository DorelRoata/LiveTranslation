import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  buildGeminiUpstreamUrl,
  geminiProxyAllowed,
  getInstanceInfo,
  isLocalClient,
  isObsAllowedPath,
  isOperatorClient,
  isPrivateLan,
  publicApiKeyStatus
} from '../server-support.js';

test('instance info reports version and commit without secrets', async () => {
  const info = await getInstanceInfo();
  const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  assert.equal(info.application, 'live-translate');
  assert.equal(info.version, packageVersion);
  assert.match(info.commit, /^[0-9a-f]{7,40}$/);
  assert.equal('apiKey' in info, false);
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
