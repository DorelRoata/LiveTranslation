// Bible text for verse pop-ups, from the getBible API (api.getbible.net, public
// domain and freely distributed translations). Each chapter is kept on disk
// after the first use, so a verse read before needs no network; so is every
// book downloaded for following readings, which also serves its chapters.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BOOKS, formatReference, referenceInScheme, referenceVerses, verseCount } from './src/bible-references.js';

const API = 'https://api.getbible.net/v2';
const FETCH_TIMEOUT_MS = 4000;
const MAX_VERSES_SHOWN = 6;
const MAX_TEXT_CHARS = 900;

// The Bible shown for each subtitle language. `scheme` is how it numbers
// verses (see referenceInScheme); every chapter is also checked against it.
export const LANGUAGE_BIBLES = Object.freeze({
  en: { id: 'kjv', label: 'KJV', scheme: 'eng' },
  ro: { id: 'cornilescu', label: 'Cornilescu', scheme: 'eng' },
  ru: { id: 'synodal', label: 'Синодальный перевод', scheme: 'rso' },
  uk: { id: 'ukrogienko', label: 'Огієнко', scheme: 'rso' },
  es: { id: 'valera', label: 'Reina-Valera 1909', scheme: 'eng' },
  fr: { id: 'ls1910', label: 'Louis Segond 1910', scheme: 'org-psalms' },
  de: { id: 'elberfelder1905', label: 'Elberfelder 1905', scheme: 'eng' },
  pt: { id: 'almeida', label: 'Almeida Atualizada', scheme: 'eng' },
  it: { id: 'riveduta', label: 'Riveduta 1927', scheme: 'eng' },
  pl: { id: 'polgdanska', label: 'Biblia Gdańska', scheme: 'eng' },
  hu: { id: 'karoli', label: 'Károli', scheme: 'org-psalms' },
  ko: { id: 'korean', label: '한글 성경', scheme: 'eng' },
  'zh-hans': { id: 'cus', label: '和合本', scheme: 'eng' },
  'zh-hant': { id: 'cut', label: '和合本', scheme: 'eng' },
  ja: { id: 'japkougo', label: '口語訳', scheme: 'eng' },
  vi: { id: 'vietnamese', label: 'Kinh Thánh 1934', scheme: 'eng' },
  sr: { id: 'srkdekavski', label: 'Daničić-Karadžić', scheme: 'eng' },
  ar: { id: 'arabicsv', label: 'Van Dyke', scheme: 'eng' },
  tr: { id: 'turkish', label: 'Kutsal Kitap', scheme: 'eng' }
});

const ENGLISH_LABELS = { kjv: 'KJV', web: 'WEB', asv: 'ASV' };

// "Psalms 23" reads as one psalm in most languages.
const ONE_PSALM = { en: 'Psalm', ro: 'Psalmul', ru: 'Псалом', uk: 'Псалом', es: 'Salmo', fr: 'Psaume', de: 'Psalm', pt: 'Salmo', it: 'Salmo', pl: 'Psalm' };

export function bibleForLanguage(language, englishBible = 'kjv') {
  const code = String(language || '').toLowerCase();
  if (code === 'en' || code.startsWith('en-')) {
    const id = ENGLISH_LABELS[englishBible] ? englishBible : 'kjv';
    return { id, label: ENGLISH_LABELS[id], scheme: 'eng', language: 'en' };
  }
  const bible = LANGUAGE_BIBLES[code] || LANGUAGE_BIBLES[code.split('-')[0]];
  return bible ? { ...bible, language: code } : null;
}

// Cornilescu is stored with cedilla letters (ş, ţ); Romanian uses commas.
function cleanVerseText(text, language) {
  let value = String(text || '').replace(/[¶]/g, '').replace(/\s+/g, ' ').trim();
  if (language === 'ro') value = value.replace(/ş/g, 'ș').replace(/ţ/g, 'ț').replace(/Ş/g, 'Ș').replace(/Ţ/g, 'Ț');
  return value;
}

export function createBibleLibrary({ cacheDir, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const chapters = new Map();
  const bookNames = new Map();
  const inFlight = new Map();

  async function readCache(file) {
    if (!cacheDir) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(cacheDir, file), 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeCache(file, value) {
    if (!cacheDir) return;
    try {
      const target = path.join(cacheDir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(value));
    } catch (error) {
      logger.warn?.(`Bible cache write failed (${file}): ${error.message}`);
    }
  }

  async function fetchJson(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function once(key, load) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = load().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  // { bookName, verses: { [n]: text } } or null when it cannot be loaded.
  async function getChapter(translation, book, chapter) {
    const key = `${translation}/${book}/${chapter}`;
    if (chapters.has(key)) return chapters.get(key);
    return once(key, async () => {
      const file = `${translation}/${book}-${chapter}.json`;
      let value = await readCache(file);
      if (!value) {
        const verses = (await readCache(`${translation}/book-${book}.json`))?.chapters?.[chapter];
        if (verses && Object.keys(verses).length) value = { bookName: '', verses };
      }
      if (!value) {
        try {
          const data = await fetchJson(`${API}/${translation}/${book}/${chapter}.json`);
          const verses = {};
          for (const verse of data.verses || []) verses[verse.verse] = verse.text;
          value = { bookName: String(data.book_name || '').trim(), verses };
          if (!Object.keys(verses).length) return null;
          void writeCache(file, value);
        } catch (error) {
          logger.warn?.(`Bible text unavailable (${key}): ${error.message}`);
          return null;
        }
      }
      chapters.set(key, value);
      if (chapters.size > 300) chapters.delete(chapters.keys().next().value);
      return value;
    });
  }

  // A whole book, { chapters: { [chapter]: { [verse]: text } } }, for the
  // reading index. Kept on disk like chapters.
  async function getBook(translation, book) {
    return once(`book/${translation}/${book}`, async () => {
      const file = `${translation}/book-${book}.json`;
      const cached = await readCache(file);
      if (cached) return cached;
      try {
        const data = await fetchJson(`${API}/${translation}/${book}.json`);
        const value = { chapters: {} };
        for (const chapter of data.chapters || []) {
          const verses = {};
          for (const verse of chapter.verses || []) verses[verse.verse] = verse.text;
          value.chapters[chapter.chapter] = verses;
        }
        if (!Object.keys(value.chapters).length) return null;
        await writeCache(file, value);
        return value;
      } catch (error) {
        logger.warn?.(`Bible book unavailable (${translation}/${book}): ${error.message}`);
        return null;
      }
    });
  }

  async function getBookNames(translation) {
    if (bookNames.has(translation)) return bookNames.get(translation);
    return once(`books/${translation}`, async () => {
      const file = `${translation}/books.json`;
      let names = await readCache(file);
      if (!names) {
        try {
          const data = await fetchJson(`${API}/${translation}/books.json`);
          names = {};
          for (const [nr, info] of Object.entries(data)) names[nr] = String(info?.name || '').trim();
          void writeCache(file, names);
        } catch (error) {
          logger.warn?.(`Bible book names unavailable (${translation}): ${error.message}`);
          return null;
        }
      }
      bookNames.set(translation, names);
      return names;
    });
  }

  function bookLabel(bible, ref, names) {
    const language = bible?.language || 'en';
    if (ref.book === 19 && ONE_PSALM[language]) return ONE_PSALM[language];
    if (language === 'en' || !bible) return BOOKS[ref.book - 1].name;
    return names?.[ref.book] || BOOKS[ref.book - 1].name;
  }

  // The reference as written in that language's Bible ("Псалом 22:1").
  async function labelFor(ref, language, englishBible) {
    const bible = bibleForLanguage(language, englishBible);
    if (!bible) return formatReference(ref);
    const names = bible.language === 'en' ? null : await getBookNames(bible.id);
    return formatReference(referenceInScheme(ref, bible.scheme), bookLabel(bible, ref, names));
  }

  // The verses to show for `ref` in `language`. Text is left out (verses: [])
  // when the Bible is unavailable or numbers that chapter differently.
  async function lookupPassage(ref, language, englishBible) {
    const bible = bibleForLanguage(language, englishBible);
    if (!bible) return { label: formatReference(ref), version: '', verses: [], truncated: false };
    const mapped = referenceInScheme(ref, bible.scheme);
    const [chapter, names] = await Promise.all([
      getChapter(bible.id, mapped.book, mapped.chapter),
      bible.language === 'en' ? null : getBookNames(bible.id)
    ]);
    const label = formatReference(mapped, bookLabel(bible, ref, names || (chapter?.bookName ? { [ref.book]: chapter.bookName } : null)));
    const passage = { label, version: bible.label, verses: [], truncated: false };
    if (!chapter || !mapped.verseStart || mapped.chapterEnd) return passage;

    const expected = verseCount(mapped.book, mapped.chapter, bible.scheme);
    if (expected && Object.keys(chapter.verses).length !== expected) return passage;

    let chars = 0;
    for (const n of referenceVerses(mapped)) {
      const text = cleanVerseText(chapter.verses[n], bible.language);
      if (!text) continue;
      if (passage.verses.length >= MAX_VERSES_SHOWN || (passage.verses.length && chars + text.length > MAX_TEXT_CHARS)) {
        passage.truncated = true;
        break;
      }
      passage.verses.push({ n, text });
      chars += text.length;
    }
    return passage;
  }

  return { getChapter, getBook, getBookNames, labelFor, lookupPassage };
}
