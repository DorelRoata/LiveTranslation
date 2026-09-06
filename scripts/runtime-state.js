import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyStampPath = path.join(projectRoot, 'node_modules', '.live-translate-lock.json');
const buildStampPath = path.join(projectRoot, 'dist', '.live-translate-build.json');
const generatedWasmPrefix = 'public/mediapipe/wasm/';
const requiredPackages = [
  '@mediapipe/tasks-audio',
  '@vitejs/plugin-basic-ssl',
  'qrcode',
  'vite',
  'ws'
];
const buildInputs = [
  'audio-sender.html',
  'index.html',
  'package-lock.json',
  'package.json',
  'public',
  'scripts/prepare-mediapipe-assets.js',
  'scripts/runtime-state.js',
  'server-support.js',
  'server.js',
  'src',
  'subtitles.html',
  'vite.config.js'
];
const requiredBuildFiles = [
  'index.html',
  'audio-sender.html',
  'subtitles.html',
  'mediapipe/models/yamnet.tflite',
  'mediapipe/wasm/audio_wasm_internal.js',
  'mediapipe/wasm/audio_wasm_internal.wasm',
  'mediapipe/wasm/audio_wasm_module_internal.js',
  'mediapipe/wasm/audio_wasm_module_internal.wasm',
  'mediapipe/wasm/audio_wasm_nosimd_internal.js',
  'mediapipe/wasm/audio_wasm_nosimd_internal.wasm'
];

async function sha256File(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function dependencyFingerprint() {
  return sha256File(path.join(projectRoot, 'package-lock.json'));
}

async function collectFiles(relativePath, files) {
  const normalizedPath = relativePath.split(path.sep).join('/');
  if (normalizedPath === 'public/mediapipe/wasm' || normalizedPath.startsWith(generatedWasmPrefix)) return;
  if (normalizedPath.split('/').some(part => part.startsWith('.'))) return;

  const absolutePath = path.join(projectRoot, relativePath);
  const fileStat = await fs.stat(absolutePath);
  if (fileStat.isFile()) {
    files.push(normalizedPath);
    return;
  }
  if (!fileStat.isDirectory()) return;

  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    await collectFiles(path.join(relativePath, entry.name), files);
  }
}

async function buildFingerprint() {
  const files = [];
  for (const input of buildInputs) await collectFiles(input, files);
  files.sort();

  const hash = createHash('sha256');
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(projectRoot, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function readStamp(stampPath) {
  try {
    return JSON.parse(await fs.readFile(stampPath, 'utf8'));
  } catch {
    return null;
  }
}

async function dependenciesAreReady() {
  const stamp = await readStamp(dependencyStampPath);
  if (stamp?.fingerprint !== await dependencyFingerprint()) return false;

  const require = createRequire(import.meta.url);
  try {
    for (const packageName of requiredPackages) require.resolve(packageName);
  } catch {
    return false;
  }
  return true;
}

async function buildIsReady() {
  const stamp = await readStamp(buildStampPath);
  if (stamp?.fingerprint !== await buildFingerprint()) return false;

  try {
    for (const relativePath of requiredBuildFiles) {
      const fileStat = await fs.stat(path.join(projectRoot, 'dist', relativePath));
      if (!fileStat.isFile() || fileStat.size === 0) return false;
    }
  } catch {
    return false;
  }
  return true;
}

async function writeStamp(stampPath, fingerprint) {
  await fs.mkdir(path.dirname(stampPath), { recursive: true });
  await fs.writeFile(stampPath, `${JSON.stringify({ fingerprint }, null, 2)}\n`, 'utf8');
}

const command = process.argv[2];
switch (command) {
  case 'dependencies-ready':
    process.exit(await dependenciesAreReady() ? 0 : 1);
    break;
  case 'mark-dependencies':
    await writeStamp(dependencyStampPath, await dependencyFingerprint());
    break;
  case 'build-ready':
    process.exit(await buildIsReady() ? 0 : 1);
    break;
  case 'mark-build':
    await writeStamp(buildStampPath, await buildFingerprint());
    break;
  default:
    console.error('Usage: node scripts/runtime-state.js <dependencies-ready|mark-dependencies|build-ready|mark-build>');
    process.exit(2);
}
