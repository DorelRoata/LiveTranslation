import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCertificate } from '@vitejs/plugin-basic-ssl';
import { attachLocalRelay, getConfigDir, getNetworkIP, handleRuntimeApi } from './server-support.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(rootDir, 'dist');
const port = Number.parseInt(process.env.PORT || '5173', 10);
const host = process.env.HOST || '0.0.0.0';

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

const server = https.createServer({ key: certificate, cert: certificate }, async (req, res) => {
  try {
    if (await handleRuntimeApi(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }

    const url = new URL(req.url, 'https://localhost');
    const requestedPath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
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
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Request failed:', error.message);
    if (!res.headersSent) res.writeHead(404);
    res.end('Not found');
  }
});

attachLocalRelay(server);
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Close the other LiveTranslation window or server, then try again.`);
  } else {
    console.error('LiveTranslation server failed:', error.message);
  }
  process.exit(1);
});
server.listen(port, host, () => {
  const networkIP = getNetworkIP();
  console.log(`LiveTranslation is running at https://localhost:${port}`);
  if (networkIP !== 'localhost') console.log(`Projector access: https://${networkIP}:${port}/subtitles.html`);
});
