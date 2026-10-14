// Follows the preacher (or anyone at the pulpit) reading the Bible aloud. The
// words heard, Google's transcript of the spoken language, are compared three
// words at a time with that language's Bible, so the screens can show the
// verse being read now. On the 2026-10-04 service the readers followed
// Cornilescu nearly word for word, and the follower tracked 1 Corinthians
// 11:23-29, Mark 15:22-26 and Psalms 50:1-51:19 verse by verse.

const WINDOW_WORDS = 8;
// Three-word groups a verse must share with the last eight words heard:
// 3 of 6 is about five words read exactly.
export const MIN_SCORE = 3;
// Away from what was announced (or nothing announced), nearly all of them.
export const FAR_SCORE = 5;

// Spellings that differ between Google's transcript and the Bible edition.
const SAME_WORD = new Map([
  ['iisus', 'isus'],
  ['sint', 'sunt'],
  ['sintem', 'suntem'],
  ['sinteti', 'sunteti']
]);

// Lowercase words without accents. Romanian â and î are the same sound, and
// Cornilescu 1924 writes "cînd" where Google writes "când".
export function matchWords(text) {
  return String(text || '')
    .replace(/â/g, 'î')
    .replace(/Â/g, 'Î')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(word => SAME_WORD.get(word) || word);
}

// 32-bit FNV-1a of three words. A rare collision only adds one false hit.
function hashGram(a, b, c) {
  const text = `${a} ${b} ${c}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function gramHashes(words) {
  const hashes = [];
  for (let i = 0; i + 2 < words.length; i++) hashes.push(hashGram(words[i], words[i + 1], words[i + 2]));
  return hashes;
}

// A compact index of verses ({ book, chapter, verse, text }, in Bible order),
// grouped by the top 16 bits of each hash. The whole Romanian Bible is about
// 6 MB this way. Built off the main thread for the full Bible.
export function buildReadingIndex(entries) {
  const count = entries.length;
  const books = new Uint8Array(count);
  const chapters = new Uint8Array(count);
  const verses = new Uint8Array(count);
  const pairHashes = [];
  const pairIds = [];
  entries.forEach((entry, id) => {
    books[id] = entry.book;
    chapters[id] = entry.chapter;
    verses[id] = entry.verse;
    for (const hash of new Set(gramHashes(matchWords(entry.text)))) {
      pairHashes.push(hash);
      pairIds.push(id);
    }
  });
  const offsets = new Uint32Array(65537);
  for (const hash of pairHashes) offsets[(hash >>> 16) + 1]++;
  for (let i = 1; i < offsets.length; i++) offsets[i] += offsets[i - 1];
  const fill = offsets.slice(0, 65536);
  const hashes = new Uint32Array(pairHashes.length);
  const ids = new Uint32Array(pairHashes.length);
  pairHashes.forEach((hash, i) => {
    const slot = fill[hash >>> 16]++;
    hashes[slot] = hash;
    ids[slot] = pairIds[i];
  });
  return { count, books, chapters, verses, offsets, hashes, ids };
}

export function readingIndexBuffers(index) {
  return [index.books, index.chapters, index.verses, index.offsets, index.hashes, index.ids].map(array => array.buffer);
}

export function verseAt(index, id) {
  return { book: index.books[id], chapter: index.chapters[id], verse: index.verses[id] };
}

// Keeps the last few words heard and scores the verses they could come from.
export function createReadingFollower() {
  let recent = [];

  return {
    push(text) {
      recent = recent.concat(matchWords(text)).slice(-WINDOW_WORDS);
    },
    reset() {
      recent = [];
    },
    // Verses sharing at least MIN_SCORE groups with the words just heard,
    // best first: [{ id, score }].
    candidates(index) {
      const scores = new Map();
      for (const hash of new Set(gramHashes(recent))) {
        const bucket = hash >>> 16;
        for (let i = index.offsets[bucket]; i < index.offsets[bucket + 1]; i++) {
          if (index.hashes[i] === hash) scores.set(index.ids[i], (scores.get(index.ids[i]) || 0) + 1);
        }
      }
      const result = [];
      for (const [id, score] of scores) if (score >= MIN_SCORE) result.push({ id, score });
      return result.sort((a, b) => b.score - a.score || a.id - b.id);
    }
  };
}

// Picks the verse being read. need(id) gives { score, tier }: the score that
// verse needs, and how expected it is (0 continues the reading or lies in a
// chapter just named, 1 is elsewhere in a book just named, 2 is anywhere).
// A more expected verse wins over a better-scoring one: the Gospels and
// 1 Corinthians 11 tell the Lord's Supper in nearly the same words, and the
// passage announced is the one being read. On a tie the reader has most
// likely moved on to the next verse.
export function chooseReadingVerse(candidates, { need = () => ({ score: MIN_SCORE, tier: 0 }), current = -1 } = {}) {
  let best = null;
  for (const candidate of candidates) {
    const { score, tier } = need(candidate.id);
    if (candidate.score < score) continue;
    const entry = { ...candidate, tier };
    if (!best || entry.tier < best.tier || (entry.tier === best.tier && (entry.score > best.score
      || (entry.score === best.score && rank(entry.id, current) < rank(best.id, current))))) {
      best = entry;
    }
  }
  return best;
}

function rank(id, current) {
  if (current < 0) return id;
  if (id === current + 1) return -2;
  if (id === current) return -1;
  return Math.abs(id - current);
}
