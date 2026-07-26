import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_WS_PAYLOAD_BYTES = 512 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024;

export function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
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

function isLoopback(address = '') {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1';
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

export async function handleRuntimeApi(req, res) {
  const url = new URL(req.url, 'https://localhost');

  if (url.pathname === '/api/network-ip' && req.method === 'GET') {
    sendJson(res, 200, { ip: getNetworkIP() });
    return true;
  }

  if (url.pathname !== '/api/config/api-key') return false;

  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: 'API key configuration is only available on this computer.' });
    return true;
  }

  if (req.method === 'GET') {
    try {
      const apiKey = await readStoredApiKey();
      sendJson(res, 200, { configured: Boolean(apiKey), apiKey });
    } catch (error) {
      console.error('Unable to read LiveTranslation configuration:', error.message);
      sendJson(res, 200, {
        configured: false,
        apiKey: '',
        warning: 'The saved API key settings could not be read. Enter the key again to replace them.'
      });
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

export function attachLocalRelay(httpServer) {
  const subtitleState = {
    lang1: { accumulatedText: '' },
    lang2: { accumulatedText: '' },
    targetLanguage1: '',
    targetLanguage2: '',
    isDual: false,
    audioSenderStreaming: false
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

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

  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, 'https://localhost');
    if (pathname !== '/local-subtitles-ws') return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

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
          const state = subtitleState[data.lane];
          if (!state || typeof data.text !== 'string') return;
          const trimmedText = data.text.trim();
          if (trimmedText) {
            const needsSpace = state.accumulatedText.length > 0 &&
              !/[\s。？！.?!;；]/.test(state.accumulatedText[state.accumulatedText.length - 1]) &&
              !/^[。？！.?!;；\s]/.test(trimmedText);
            state.accumulatedText += `${needsSpace ? ' ' : ''}${trimmedText}`;
          }
          if (state.accumulatedText.length > 800) {
            state.accumulatedText = state.accumulatedText.substring(state.accumulatedText.length - 800);
            const spaceIndex = state.accumulatedText.indexOf(' ');
            if (spaceIndex !== -1) state.accumulatedText = state.accumulatedText.substring(spaceIndex + 1);
          }
          broadcast(JSON.stringify({ type: 'sync', state: subtitleState }), ws);
        } else if (data.type === 'setup') {
          subtitleState.targetLanguage1 = data.targetLanguage1;
          subtitleState.targetLanguage2 = data.targetLanguage2;
          subtitleState.isDual = data.isDual;
          broadcast(JSON.stringify({ type: 'sync', state: subtitleState }));
        } else if (data.type === 'clear') {
          subtitleState.lang1 = { accumulatedText: '' };
          subtitleState.lang2 = { accumulatedText: '' };
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

  httpServer.on('close', () => clearInterval(heartbeat));
  return wss;
}
