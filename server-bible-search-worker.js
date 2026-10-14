// Builds the reading index for one Bible in a worker thread, so loading and
// indexing 31,000 verses never delays the subtitle relay. Books come from the
// same disk cache as verse pop-ups (downloaded once).
import { parentPort, workerData } from 'node:worker_threads';
import { createBibleLibrary } from './server-bible.js';
import { buildReadingIndex, readingIndexBuffers } from './src/bible-reading.js';

const { translation, cacheDir, offline = false } = workerData;
const library = createBibleLibrary({
  cacheDir,
  logger: { warn() {} },
  fetchImpl: offline ? async () => { throw new Error('offline'); } : globalThis.fetch
});

const pending = Array.from({ length: 66 }, (_, i) => i + 1);
const books = new Array(66).fill(null);
await Promise.all(Array.from({ length: 4 }, async () => {
  while (pending.length) {
    const book = pending.shift();
    books[book - 1] = await library.getBook(translation, book);
  }
}));

const entries = [];
let missing = 0;
books.forEach((data, i) => {
  if (!data) {
    missing += 1;
    return;
  }
  for (const chapter of Object.keys(data.chapters).map(Number).sort((a, b) => a - b)) {
    const verses = data.chapters[chapter];
    for (const verse of Object.keys(verses).map(Number).sort((a, b) => a - b)) {
      entries.push({ book: i + 1, chapter, verse, text: verses[verse] });
    }
  }
});

const index = buildReadingIndex(entries);
parentPort.postMessage({ index, missing }, readingIndexBuffers(index));
