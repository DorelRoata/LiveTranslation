// Bible text for verse pop-ups, from the getBible API (api.getbible.net, public
// domain translations), Bolls (bolls.life, NKJV/ESV), and jsDelivr/GitHub (NIV).
// Each chapter or book is kept on disk after the first use so verses already
// read need no network; whole books downloaded for following readings also serve
// individual chapters.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BOOKS, formatReference, referenceInScheme, referenceVerses, verseCount } from './src/bible-references.js';

const API = 'https://api.getbible.net/v2';
const BOLLS_API = 'https://bolls.life';
// Never use bolls.life for NIV: it serves a publisher prohibition message instead of Scripture.
const BOLLS_SLUGS = { nkjv: 'NKJV', esv: 'ESV' };
const NIV_BASES = [
  'https://cdn.jsdelivr.net/gh/aruljohn/Bible-niv@main',
  'https://raw.githubusercontent.com/aruljohn/Bible-niv/main'
];
const FETCH_TIMEOUT_MS = 4000;
const BULK_TIMEOUT_MS = 20_000;
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

const ENGLISH_LABELS = { kjv: 'KJV', nkjv: 'NKJV', niv: 'NIV', esv: 'ESV', web: 'WEB', asv: 'ASV' };

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

function isPublisherNotice(text) {
  return /biblica,\s*inc\.\s*has\s*prohibited/i.test(String(text || ''));
}

// NKJV Psalm superscriptions begin with a balanced <i>...</i> block (often with
// nested <i>A Psalm</i>) immediately followed by a duplicate closing </i> or
// an empty <i> </i> spacer (Psalms 70:1, 92:1).
function stripDoubledItalicPrefix(value) {
  if (!/^<i>/i.test(value)) return value;
  const tagPattern = /<\/?i>/gi;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(value))) {
    depth += match[0].toLowerCase() === '<i>' ? 1 : -1;
    if (depth === 0) {
      const rest = value.slice(tagPattern.lastIndex);
      if (/^\s*(?:<i>\s*)?<\/i>\s*/i.test(rest)) return rest.replace(/^\s*(?:<i>\s*)?<\/i>\s*/i, '');
      return value;
    }
  }
  return value;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    });
}

function stripEditorialNotes(value) {
  return value
    .replace(/\[\s*(?:Some of the earliest|The earliest)\s+manuscripts\s+do\s+not\s+include[^\]]*\]/gi, ' ')
    .replace(/\[\[|\]\]/g, '');
}

export function cleanBollsText(text) {
  if (isPublisherNotice(text)) return '';
  let value = stripDoubledItalicPrefix(String(text || '').trim());
  // ESV embeds mid-verse section headings in <b>...</b>.
  value = value.replace(/<b>[\s\S]*?<\/b>/gi, ' ');
  // NKJV uses <i>...</i> for supplied words, including inside words (e.g. corner<i>stone,</i>).
  value = value.replace(/<\/?i>/gi, '');
  value = value.replace(/<br\s*\/?>/gi, ' ');
  value = value.replace(/<[^>]+>/g, ' ');
  value = stripEditorialNotes(decodeHtmlEntities(value)).replace(/\s+/g, ' ').trim();
  return isPublisherNotice(value) ? '' : value;
}

// Cornilescu is stored with cedilla letters (ş, ţ); Romanian uses commas.
// NIV source data stores apostrophes and closing single quotes as backticks (`).
export function cleanVerseText(text, language) {
  if (isPublisherNotice(text)) return '';
  let value = stripEditorialNotes(String(text || ''))
    .replace(/`/g, '’')
    .replace(/[¶]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (language === 'ro') value = value.replace(/ş/g, 'ș').replace(/ţ/g, 'ț').replace(/Ş/g, 'Ș').replace(/Ţ/g, 'Ț');
  return value;
}

function nivBookFile(book) {
  if (book === 22) return 'Song Of Solomon';
  return BOOKS[book - 1]?.name || '';
}

export function createBibleLibrary({ cacheDir, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const chapters = new Map();
  const books = new Map();
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

  async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function once(key, load) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = load().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  function rememberBook(key, value) {
    books.set(key, value);
    if (books.size > 140) books.delete(books.keys().next().value);
  }

  async function loadNivBook(book) {
    const filename = nivBookFile(book);
    if (!filename) return null;
    let data = null;
    let lastError = null;
    for (const base of NIV_BASES) {
      try {
        data = await fetchJson(`${base}/${encodeURIComponent(filename)}.json`, BULK_TIMEOUT_MS);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!data) throw lastError || new Error('NIV book download failed');
    const value = { chapters: {} };
    for (const chapter of data.chapters || []) {
      const chNum = Number(chapter.chapter);
      if (!chNum) continue;
      const verses = {};
      for (const verse of chapter.verses || []) {
        const vNum = Number(verse.verse);
        const text = cleanVerseText(verse.text, 'en');
        if (vNum && text) verses[vNum] = text;
      }
      if (Object.keys(verses).length) value.chapters[chNum] = verses;
    }
    if (!Object.keys(value.chapters).length) return null;
    rememberBook(`niv/${book}`, value);
    await writeCache(`niv/book-${book}.json`, value);
    return value;
  }

  async function loadBollsBulk(translation) {
    const slug = BOLLS_SLUGS[translation];
    return once(`bulk/${translation}`, async () => {
      const rows = await fetchJson(`${BOLLS_API}/static/translations/${slug}.json`, BULK_TIMEOUT_MS);
      if (!Array.isArray(rows)) throw new Error(`Unexpected bulk payload for ${slug}`);
      const grouped = new Map();
      for (const row of rows) {
        const bookNum = Number(row.book);
        const chNum = Number(row.chapter);
        const vNum = Number(row.verse);
        if (!bookNum || !chNum || !vNum) continue;
        const text = cleanBollsText(row.text);
        if (!text) continue;
        let bookEntry = grouped.get(bookNum);
        if (!bookEntry) {
          bookEntry = { chapters: {} };
          grouped.set(bookNum, bookEntry);
        }
        if (!bookEntry.chapters[chNum]) bookEntry.chapters[chNum] = {};
        bookEntry.chapters[chNum][vNum] = text;
      }
      const writes = [];
      for (const [bookNum, value] of grouped.entries()) {
        rememberBook(`${translation}/${bookNum}`, value);
        writes.push(writeCache(`${translation}/book-${bookNum}.json`, value));
      }
      await Promise.all(writes);
      return grouped;
    });
  }

  // { bookName, verses: { [n]: text } } or null when it cannot be loaded.
  async function getChapter(translation, book, chapter) {
    const key = `${translation}/${book}/${chapter}`;
    if (chapters.has(key)) return chapters.get(key);
    return once(key, async () => {
      const file = `${translation}/${book}-${chapter}.json`;
      let value = await readCache(file);
      if (!value) {
        const bookData = books.get(`${translation}/${book}`) || await readCache(`${translation}/book-${book}.json`);
        const verses = bookData?.chapters?.[chapter];
        if (verses && Object.keys(verses).length) value = { bookName: BOOKS[book - 1]?.name || '', verses };
      }
      if (!value) {
        try {
          if (translation === 'niv') {
            const bookData = await getBook('niv', book);
            const verses = bookData?.chapters?.[chapter];
            if (!verses || !Object.keys(verses).length) return null;
            value = { bookName: BOOKS[book - 1]?.name || '', verses };
          } else if (BOLLS_SLUGS[translation]) {
            const rows = await fetchJson(`${BOLLS_API}/get-text/${BOLLS_SLUGS[translation]}/${book}/${chapter}/`);
            const verses = {};
            for (const row of Array.isArray(rows) ? rows : []) {
              const vNum = Number(row.verse);
              const text = cleanBollsText(row.text);
              if (vNum && text) verses[vNum] = text;
            }
            if (!Object.keys(verses).length) return null;
            value = { bookName: BOOKS[book - 1]?.name || '', verses };
            void writeCache(file, value);
          } else {
            const data = await fetchJson(`${API}/${translation}/${book}/${chapter}.json`);
            const verses = {};
            for (const verse of data.verses || []) verses[verse.verse] = verse.text;
            value = { bookName: String(data.book_name || '').trim(), verses };
            if (!Object.keys(verses).length) return null;
            void writeCache(file, value);
          }
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
      const mem = books.get(`${translation}/${book}`);
      if (mem) return mem;
      const file = `${translation}/book-${book}.json`;
      const cached = await readCache(file);
      if (cached) {
        rememberBook(`${translation}/${book}`, cached);
        return cached;
      }
      try {
        if (translation === 'niv') {
          return await loadNivBook(book);
        }
        if (BOLLS_SLUGS[translation]) {
          const grouped = await loadBollsBulk(translation);
          return grouped.get(Number(book)) || books.get(`${translation}/${book}`) || null;
        }
        const data = await fetchJson(`${API}/${translation}/${book}.json`);
        const value = { chapters: {} };
        for (const chapter of data.chapters || []) {
          const verses = {};
          for (const verse of chapter.verses || []) verses[verse.verse] = verse.text;
          value.chapters[chapter.chapter] = verses;
        }
        if (!Object.keys(value.chapters).length) return null;
        rememberBook(`${translation}/${book}`, value);
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
    const keys = Object.keys(chapter.verses).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!keys.length) return passage;
    const actual = keys.length;
    const maxVerse = Math.max(...keys);
    if (expected) {
      const valid = mapped.book < 40
        ? actual === expected && maxVerse === expected
        : Math.abs(maxVerse - expected) <= 1 && Math.abs(actual - expected) <= 3;
      if (!valid) return passage;
    }

    let chars = 0;
    for (const n of referenceVerses(mapped)) {
      const rawVerse = chapter.verses[n];
      const text = BOLLS_SLUGS[bible.id] ? cleanBollsText(rawVerse) : cleanVerseText(rawVerse, bible.language);
      if (!text) continue;
      if (passage.verses.length >= MAX_VERSES_SHOWN || (passage.verses.length && chars + text.length > MAX_TEXT_CHARS)) {
        passage.truncated = true;
        break;
      }
      passage.verses.push({ n, text });
      chars += text.length;
    }
    if (!passage.verses.length && bible.language === 'en' && bible.id !== 'kjv') {
      const fallback = await lookupPassage(ref, 'en', 'kjv');
      if (fallback.verses.length) return fallback;
    }
    return passage;
  }

  return { getChapter, getBook, getBookNames, labelFor, lookupPassage };
}
