import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageWasmDir = path.join(projectRoot, 'node_modules', '@mediapipe', 'tasks-audio', 'wasm');
const publicWasmDir = path.join(projectRoot, 'public', 'mediapipe', 'wasm');
const modelPath = path.join(projectRoot, 'public', 'mediapipe', 'models', 'yamnet.tflite');

const wasmFiles = [
  'audio_wasm_internal.js',
  'audio_wasm_internal.wasm',
  'audio_wasm_module_internal.js',
  'audio_wasm_module_internal.wasm',
  'audio_wasm_nosimd_internal.js',
  'audio_wasm_nosimd_internal.wasm'
];

const expectedModel = {
  bytes: 4_126_810,
  sha256: '4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf'
};

async function verifyModel() {
  let modelStat;
  try {
    modelStat = await stat(modelPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('The bundled YAMNet model is missing. Restore public/mediapipe/models/yamnet.tflite from Git.');
    }
    throw error;
  }

  if (modelStat.size !== expectedModel.bytes) {
    throw new Error(`The bundled YAMNet model has the wrong size (${modelStat.size} bytes). Restore it from Git.`);
  }

  const digest = createHash('sha256').update(await readFile(modelPath)).digest('hex');
  if (digest !== expectedModel.sha256) {
    throw new Error('The bundled YAMNet model failed its integrity check. Restore it from Git.');
  }
}

await verifyModel();
await rm(publicWasmDir, { recursive: true, force: true });
await mkdir(publicWasmDir, { recursive: true });

for (const fileName of wasmFiles) {
  const source = path.join(packageWasmDir, fileName);
  const destination = path.join(publicWasmDir, fileName);
  try {
    await copyFile(source, destination);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`MediaPipe runtime file ${fileName} is missing. Run npm ci, then build again.`);
    }
    throw error;
  }
}

console.log('Prepared local MediaPipe song-detection assets.');
