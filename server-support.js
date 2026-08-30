import { execFile } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { applyLaneUpdate, buildSystemSetup, emptyLaneState } from './src/system-setup.js';

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024;
const GEMINI_LIVE_WS_PATH = '/gemini-live-ws';
const GEMINI_UPSTREAM_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const execFileAsync = promisify(execFile);

async function runGit(args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=5'
    }
  });
  return stdout.trim();
}

async function getUpdateStatus() {
  const insideWorktree = await runGit(['rev-parse', '--is-inside-work-tree']);
  if (insideWorktree !== 'true') throw new Error('Not inside a Git worktree.');

  let branch = 'detached';
  try {
    branch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch (error) {
    branch = 'detached';
  }

  await runGit(['fetch', '--quiet', 'origin', 'main']);
  const [currentCommit, remoteCommit, worktreeStatus] = await Promise.all([
    runGit(['rev-parse', 'HEAD']),
    runGit(['rev-parse', 'origin/main']),
    runGit(['status', '--porcelain'])
  ]);

  let canFastForward = false;
  const supportedBranch = branch === 'main';
  if (supportedBranch && currentCommit !== remoteCommit) {
    try {
      await runGit(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
      canFastForward = true;
    } catch (error) {
      canFastForward = false;
    }
  }

  return {
    branch,
    supportedBranch,
    currentCommit: currentCommit.slice(0, 7),
    remoteCommit: remoteCommit.slice(0, 7),
    dirty: Boolean(worktreeStatus),
    updateAvailable: supportedBranch && currentCommit !== remoteCommit && canFastForward,
    diverged: supportedBranch && currentCommit !== remoteCommit && !canFastForward
  };
}

export function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const iface of addresses ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;

      const virtualAdapter = /docker|bridge|veth|vmnet|virtualbox|utun|tailscale|vethernet|wsl/i.test(name);
      const physicalAdapter = /^(en\d+|eth\d+|wlan\d+)$|wi-?fi|ethernet/i.test(name);
      let score = 0;
      if (iface.address.startsWith('192.168.')) score += 100;
      else if (iface.address.startsWith('10.')) score += 60;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(iface.address)) score += 30;
      if (physicalAdapter) score += 40;
      if (virtualAdapter) score -= 100;
      candidates.push({ address: iface.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || 'localhost';
}

export function getConfigDir() {
  if (process.env.LIVE_TRANSLATION_CONFIG_DIR) {
    return path.resolve(process.env.LIVE_TRANSLATION_CONFIG_DIR);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'LiveTranslation');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'LiveTranslation');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'LiveTranslation');
}

export function isLoopback(address = '') {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1';
}

export function normalizeIp(address = '') {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export function isLocalClient(address = '') {
  if (isLoopback(address)) return true;
  const ip = normalizeIp(address);
  if (!ip || isLoopback(ip)) return true;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const iface of addresses ?? []) {
      if (iface.address === ip) return true;
    }
  }
  return false;
}

export function publicApiKeyStatus(apiKey, warning) {
  const body = { configured: Boolean(apiKey) };
  if (warning) body.warning = warning;
  return body;
}

export function isObsAllowedPath(requestedPath, distDir) {
  const filePath = path.resolve(distDir, requestedPath);
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) return false;
  const relative = path.relative(distDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const normalized = relative.split(path.sep).join('/');
  return normalized === 'subtitles.html' ||
    normalized === 'favicon.svg' ||
    normalized === 'icons.svg' ||
    normalized.startsWith('assets/');
}

export function buildGeminiUpstreamUrl(apiKey) {
  return `${GEMINI_UPSTREAM_URL}?key=${encodeURIComponent(apiKey)}`;
}

export function geminiProxyAllowed(remoteAddress, apiKey) {
  if (!isLocalClient(remoteAddress)) {
    return { ok: false, reason: 'Gemini translation is only available on this computer. Open https://localhost:5173/ on the host Mac.' };
  }
  if (!apiKey) {
    return { ok: false, reason: 'API key is not configured.' };
  }
  return { ok: true };
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readRequestJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new Error('Request is too large.');
    }
  }
  return body ? JSON.parse(body) : {};
}

async function readStoredApiKey() {
  const environmentKey = process.env.GEMINI_API_KEY?.trim();
  if (environmentKey) return environmentKey;

  try {
    const contents = await fs.readFile(path.join(getConfigDir(), 'config.json'), 'utf8');
    const config = JSON.parse(contents);
    return typeof config.geminiApiKey === 'string' ? config.geminiApiKey.trim() : '';
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function storeApiKey(apiKey) {
  const configDir = getConfigDir();
  const configPath = path.join(configDir, 'config.json');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, `${JSON.stringify({ geminiApiKey: apiKey }, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600).catch(() => {});
  process.env.GEMINI_API_KEY = apiKey;
}

export async function getInstanceInfo() {
  let commit = '';
  try {
    commit = await runGit(['rev-parse', 'HEAD']);
  } catch (error) {
    commit = '';
  }
  return {
    application: 'live-translate',
    repositoryPath: await fs.realpath(process.cwd()).catch(() => path.resolve(process.cwd())),
    version: packageVersion,
    commit
  };
}

export async function handleRuntimeApi(req, res) {
  const url = new URL(req.url, 'https://localhost');

  if (url.pathname === '/api/network-ip' && req.method === 'GET') {
    const obsPort = Number.parseInt(process.env.LIVE_TRANSLATE_OBS_PORT || '', 10);
    sendJson(res, 200, {
      ip: getNetworkIP(),
      obsPort: Number.isInteger(obsPort) && obsPort > 0 ? obsPort : null
    });
    return true;
  }

  if (url.pathname === '/api/instance' && req.method === 'GET') {
    if (!isLocalClient(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'Instance details are only available on this computer.' });
      return true;
    }
    sendJson(res, 200, await getInstanceInfo());
    return true;
  }

  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    if (!isLocalClient(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'The server can only be stopped from this computer.' });
      return true;
    }
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 50);
    return true;
  }

  if (url.pathname === '/api/update/status') {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'Update checks are only available on this computer.' });
      return true;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    try {
      sendJson(res, 200, await getUpdateStatus());
    } catch (error) {
      console.error('Unable to check for Live Translate updates:', error.message);
      sendJson(res, 503, { error: 'Could not reach the Git repository. Try again when the network is available.' });
    }
    return true;
  }

  if (url.pathname !== '/api/config/api-key') return false;

  if (!isLocalClient(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: 'API key configuration is only available on this computer. Open https://localhost:5173/ on the host Mac.' });
    return true;
  }

  if (req.method === 'GET') {
    try {
      const apiKey = await readStoredApiKey();
      sendJson(res, 200, publicApiKeyStatus(apiKey));
    } catch (error) {
      console.error('Unable to read LiveTranslation configuration:', error.message);
      sendJson(res, 200, publicApiKeyStatus('', 'The saved API key settings could not be read. Enter the key again to replace them.'));
    }
    return true;
  }

  if (req.method === 'POST') {
    try {
      const body = await readRequestJson(req);
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (apiKey.length < 20 || apiKey.length > 500) {
        sendJson(res, 400, { error: 'Enter a valid Gemini API key.' });
        return true;
      }
      await storeApiKey(apiKey);
      sendJson(res, 200, { configured: true });
    } catch (error) {
      console.error('Unable to save LiveTranslation configuration:', error.message);
      sendJson(res, 400, { error: error.message || 'Unable to save the API key.' });
    }
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
  return true;
}

export function attachLocalRelay(httpServer, existingRelay = null) {
  if (existingRelay) {
    existingRelay.attach(httpServer);
    return existingRelay;
  }

  const subtitleState = {
    lang1: emptyLaneState(),
    lang2: emptyLaneState(),
    ...buildSystemSetup(),
    audioSenderStreaming: false
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES, perMessageDeflate: false });
  const attachedServers = new Set();

  function send(client, message, lossy = false) {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (lossy) return;
      client.terminate();
      return;
    }
    client.send(message);
  }

  function broadcast(message, excludedClient = null, lossy = false) {
    for (const client of wss.clients) {
      if (client !== excludedClient) send(client, message, lossy);
    }
  }

  function updateAudioSenderStatus() {
    subtitleState.audioSenderStreaming = Array.from(wss.clients).some(client =>
      client.readyState === WebSocket.OPEN && client.isAudioSender && client.isStreaming
    );
    broadcast(JSON.stringify({
      type: 'audio-sender-status',
      streaming: subtitleState.audioSenderStreaming
    }));
  }

  function attach(server) {
    if (attachedServers.has(server)) return;
    attachedServers.add(server);
    server.on('upgrade', (request, socket, head) => {
      const { pathname } = new URL(request.url, 'https://localhost');
      if (pathname !== '/local-subtitles-ws') return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
    server.on('close', () => {
      attachedServers.delete(server);
      if (attachedServers.size === 0) clearInterval(heartbeat);
    });
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    send(ws, JSON.stringify({ type: 'sync', state: subtitleState }));

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'update') {
          if (!subtitleState[data.lane] || typeof data.text !== 'string') return;
          subtitleState[data.lane] = applyLaneUpdate(subtitleState[data.lane], data.text, Boolean(data.isFinal));
          broadcast(JSON.stringify({ type: 'sync', state: subtitleState }), ws);
        } else if (data.type === 'setup') {
          Object.assign(subtitleState, buildSystemSetup(data));
          broadcast(JSON.stringify({ type: 'sync', state: subtitleState }));
        } else if (data.type === 'clear') {
          subtitleState.lang1 = emptyLaneState();
          subtitleState.lang2 = emptyLaneState();
          broadcast(JSON.stringify({ type: 'clear' }));
        } else if (data.type === 'audio' || data.type === 'input-audio') {
          broadcast(message.toString(), ws, true);
        } else if (data.type === 'audio-sender-hello') {
          ws.isAudioSender = true;
          updateAudioSenderStatus();
        } else if (data.type === 'audio-sender-streaming' && ws.isAudioSender) {
          ws.isStreaming = Boolean(data.streaming);
          updateAudioSenderStatus();
        }
      } catch (error) {
        console.error('Error handling local WebSocket message:', error.message);
      }
    });

    ws.on('close', () => {
      if (ws.isAudioSender) {
        updateAudioSenderStatus();
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.isAlive) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 15_000);

  const relay = { attach, wss };
  attach(httpServer);
  return relay;
}

function safeCloseSocket(socket, code, reason) {
  if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) return;
  const valid = code === 1000 || (code >= 3000 && code <= 4999);
  try {
    socket.close(valid ? code : 1011, String(reason || '').slice(0, 120));
  } catch (error) {
    socket.terminate();
  }
}

function toTextPayload(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
}

function sendOrDrop(socket, data, isBinary) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
  if (isBinary) {
    socket.send(data, { binary: true });
    return;
  }
  socket.send(toTextPayload(data), { binary: false });
}

function sendAlways(socket, data, isBinary) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (isBinary) {
    socket.send(data, { binary: true });
    return;
  }
  socket.send(toTextPayload(data), { binary: false });
}

function inspectGeminiLanguage(data, last = inspectGeminiLanguage.last || (inspectGeminiLanguage.last = { in: '', out: '', setup: false })) {
  try {
    const msg = JSON.parse(toTextPayload(data));
    if (msg.setup && !last.setup) {
      last.setup = true;
      const source = msg.setup.inputAudioTranscription?.languageCodes || [];
      const target = msg.setup.generationConfig?.translationConfig?.targetLanguageCode || '';
      console.log(`[live-translate] Gemini setup source=${source.join(',') || 'auto'} target=${target || 'none'}`);
    }
    const sc = msg.serverContent || {};
    const inTx = msg.inputTranscription || sc.inputTranscription || sc.interimInputTranscription;
    const outTx = msg.outputTranscription || sc.outputTranscription;
    if (inTx?.languageCode && inTx.languageCode !== last.in) {
      last.in = inTx.languageCode;
      console.log(`[live-translate] Gemini heard ${inTx.languageCode}`);
    }
    if (outTx?.languageCode && outTx.languageCode !== last.out) {
      last.out = outTx.languageCode;
      console.log(`[live-translate] Gemini translated to ${outTx.languageCode}`);
    }
  } catch (error) {}
}

function forwardSocket(from, to) {
  from.on('message', (data, isBinary) => {
    inspectGeminiLanguage(data);
    sendAlways(to, data, isBinary);
  });
  from.on('close', (code, reason) => {
    safeCloseSocket(to, code, reason);
  });
  from.on('error', () => {
    safeCloseSocket(to, 1011, 'Connection error');
  });
}

export function attachGeminiProxy(httpServer) {
  if (!httpServer || httpServer.__liveTranslateGeminiProxy) return;
  httpServer.__liveTranslateGeminiProxy = true;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES, perMessageDeflate: false });

  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, 'https://localhost');
    if (pathname !== GEMINI_LIVE_WS_PATH) return;

    if (!isLocalClient(request.socket.remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, client => {
      wss.emit('connection', client, request);
    });
  });

  wss.on('connection', (client, request) => {
    inspectGeminiLanguage.last = { in: '', out: '', setup: false };
    const pending = [];
    const session = { upstream: null, ready: false };

    const sendUpstream = (data, isBinary) => {
      sendAlways(session.upstream, data, false);
    };

    client.on('message', (data, isBinary) => {
      inspectGeminiLanguage(data);
      if (session.ready) {
        sendUpstream(data, isBinary);
        return;
      }
      if (pending.length < 8) pending.push([data, isBinary]);
    });
    client.on('close', () => safeCloseSocket(session.upstream, 1000, ''));
    client.on('error', () => safeCloseSocket(session.upstream, 1011, 'Client error'));

    void connectGeminiUpstream(client, request, session, pending, sendUpstream);
  });
}

async function connectGeminiUpstream(client, request, session, pending, sendUpstream) {
  let apiKey = '';
  try {
    apiKey = await readStoredApiKey();
  } catch (error) {
    console.error('Gemini proxy could not read the saved API key:', error.message);
    safeCloseSocket(client, 1011, 'Unable to read API key');
    return;
  }

  const allowed = geminiProxyAllowed(request.socket.remoteAddress, apiKey);
  if (!allowed.ok) {
    console.error('Gemini proxy rejected a connection:', allowed.reason);
    safeCloseSocket(client, 1008, allowed.reason);
    return;
  }

  const upstream = new WebSocket(buildGeminiUpstreamUrl(apiKey), { perMessageDeflate: false });
  session.upstream = upstream;

  upstream.on('open', () => {
    session.ready = true;
    for (const [data, isBinary] of pending) sendUpstream(data, isBinary);
    pending.length = 0;
  });
  upstream.on('error', error => {
    console.error('Gemini proxy upstream error:', error.message);
  });
  forwardSocket(upstream, client);
}
