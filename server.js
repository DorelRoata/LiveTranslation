import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCertificate } from '@vitejs/plugin-basic-ssl';
import { attachLocalRelay, getConfigDir, getNetworkIP, handleRuntimeApi } from './server-support.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(rootDir, 'dist');
const port = Number.parseInt(process.env.PORT || '5173', 10);
const obsPort = Number.parseInt(process.env.OBS_PORT || '5174', 10);
const host = process.env.HOST || '0.0.0.0';
process.env.LIVE_TRANSLATE_OBS_PORT = String(obsPort);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error('The production build is missing. Run "npm run build" before starting LiveTranslation.');
  process.exit(1);
}

const certificate = await getCertificate(
  path.join(getConfigDir(), 'certificate'),
  'LiveTranslation',
  ['localhost', getNetworkIP()],
  365
);

async function serveStaticFile(req, res, requestedPath) {
  const filePath = path.resolve(distDir, requestedPath);
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
  res.statusCode = 200;
  res.setHeader('Content-Type', contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function sendRequestError(error, res) {
  if (error.code !== 'ENOENT') console.error('Request failed:', error.message);
  if (!res.headersSent) res.writeHead(404);
  res.end('Not found');
}

const server = https.createServer({ key: certificate, cert: certificate }, async (req, res) => {
  try {
    if (await handleRuntimeApi(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }

    const url = new URL(req.url, 'https://localhost');
    const requestedPath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    await serveStaticFile(req, res, requestedPath);
  } catch (error) {
    sendRequestError(error, res);
  }
});

// OBS's embedded browser may silently reject the self-signed HTTPS certificate.
// This HTTP listener exposes only the overlay and its compiled assets, while the
// dashboard, API key, and microphone streamer remain protected by HTTPS.
const obsServer = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const requestedPath = url.pathname === '/' ? 'subtitles.html' : decodeURIComponent(url.pathname.slice(1));
    const allowed = requestedPath === 'subtitles.html' ||
      requestedPath === 'favicon.svg' ||
      requestedPath === 'icons.svg' ||
      requestedPath.startsWith('assets/');
    if (!allowed) {
      res.writeHead(404).end('Not found');
      return;
    }
    await serveStaticFile(req, res, requestedPath);
  } catch (error) {
    sendRequestError(error, res);
  }
});

const relay = attachLocalRelay(server);
attachLocalRelay(obsServer, relay);

function handleServerError(label, listenPort) {
  return error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`${label} port ${listenPort} is already in use. Stop the other service, then try again.`);
    } else {
      console.error(`${label} failed:`, error.message);
    }
    process.exit(1);
  };
}

server.on('error', handleServerError('LiveTranslation server', port));
obsServer.on('error', handleServerError('OBS overlay server', obsPort));
server.listen(port, host, () => {
  const networkIP = getNetworkIP();
  console.log(`LiveTranslation is running at https://localhost:${port}`);
  if (networkIP !== 'localhost') console.log(`Projector access: https://${networkIP}:${port}/subtitles.html`);
});
obsServer.listen(obsPort, host, () => {
  const networkIP = getNetworkIP();
  console.log(`OBS overlay: http://${networkIP}:${obsPort}/?obs=true`);
});
