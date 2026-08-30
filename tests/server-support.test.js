import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildGeminiUpstreamUrl,
  geminiProxyAllowed,
  isObsAllowedPath,
  publicApiKeyStatus
} from '../server-support.js';

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

test('Gemini proxy stays on this computer and hides the key from the dashboard URL', () => {
  const url = buildGeminiUpstreamUrl('secret-key');
  assert.match(url, /^wss:\/\/generativelanguage\.googleapis\.com\//);
  assert.match(url, /key=secret-key/);

  assert.equal(geminiProxyAllowed('127.0.0.1', 'secret-key').ok, true);
  assert.equal(geminiProxyAllowed('::1', 'secret-key').ok, true);
  assert.equal(geminiProxyAllowed('192.168.1.20', 'secret-key').ok, false);
  assert.equal(geminiProxyAllowed('127.0.0.1', '').ok, false);
});
