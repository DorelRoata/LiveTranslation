// The whole Bible of the spoken language, indexed in a worker thread, so a
// passage read aloud is recognized even when its reference was not announced
// or was misheard ("Marcu 13" for Mark 15 on 2026-10-04).
import { Worker } from 'node:worker_threads';

const RETRY_AFTER_MS = 10 * 60_000;

export function createBibleSearch({
  cacheDir = '',
  logger = console,
  offline = false,
  now = Date.now,
  startWorker = workerData => new Worker(new URL('./server-bible-search-worker.js', import.meta.url), { workerData })
} = {}) {
  const bibles = new Map();
  let disposed = false;

  function build(translation) {
    const entry = { index: null, building: true, failedAt: 0, worker: null };
    bibles.set(translation, entry);
    const worker = startWorker({ translation, cacheDir, offline });
    entry.worker = worker;
    worker.unref?.();
    worker.once('message', ({ index, missing }) => {
      entry.building = false;
      entry.worker = null;
      if (disposed) return;
      entry.index = index.count ? index : null;
      // Books that could not be downloaded are tried again later.
      if (missing) entry.failedAt = now();
      if (missing) logger.warn?.(`Reading index for ${translation}: ${missing} of 66 books unavailable; retrying in 10 minutes.`);
    });
    worker.once('error', error => {
      entry.building = false;
      entry.worker = null;
      entry.failedAt = now();
      logger.warn?.(`Reading index for ${translation} failed: ${error.message}`);
    });
  }

  // The index, or null while it is being built (building starts on first use).
  function get(translation) {
    if (disposed || !translation) return null;
    const entry = bibles.get(translation);
    if (!entry) {
      build(translation);
      return null;
    }
    if (!entry.building && entry.failedAt && now() - entry.failedAt > RETRY_AFTER_MS) {
      const previous = entry.index;
      build(translation);
      bibles.get(translation).index = previous;
    }
    return entry.index;
  }

  function dispose() {
    disposed = true;
    for (const entry of bibles.values()) void entry.worker?.terminate();
  }

  return { get, dispose };
}
