// Finds Bible references in live sermon text, in English or Romanian, as the
// words arrive. Measured on the 2026-10-04 sermon, Google writes them like
// "1 Corinthians 1:17", "Galatians 6: 14", "1 John chapter 2 and verse 1",
// "Efeseni 2 cu 16", "1 Corinteni, capitolul 1 de la versetul 17". A reference
// is reported once the words after it show it is complete, so "Romans 8" is
// not shown a moment before ", verse 28" arrives.
import { TO_ORIGINAL, VERSE_COUNTS } from './bible-data.js';

// English name, English forms, Romanian forms. `n` marks a numbered book
// ("1 Corinthians"). `person`: the name is also a common name or word, so it
// counts only with a verse or the word "chapter" ("Mark 5 times" is not one).
export const BOOKS = Object.freeze([
  { name: 'Genesis', en: ['Genesis'], ro: ['Geneza', 'Genesa', 'Facerea'] },
  { name: 'Exodus', en: ['Exodus'], ro: ['Exodul', 'Exod', 'Ieșirea'] },
  { name: 'Leviticus', en: ['Leviticus'], ro: ['Leviticul', 'Levitic'] },
  { name: 'Numbers', en: ['Numbers'], ro: ['Numeri', 'Numerii'], person: true },
  { name: 'Deuteronomy', en: ['Deuteronomy'], ro: ['Deuteronomul', 'Deuteronom'] },
  { name: 'Joshua', en: ['Joshua'], ro: ['Iosua'], person: true },
  { name: 'Judges', en: ['Judges'], ro: ['Judecătorii', 'Judecători'], person: true },
  { name: 'Ruth', en: ['Ruth'], ro: ['Rut'], person: true },
  { name: '1 Samuel', n: 1, en: ['Samuel'], ro: ['Samuel'] },
  { name: '2 Samuel', n: 2, en: ['Samuel'], ro: ['Samuel'] },
  { name: '1 Kings', n: 1, en: ['Kings'], ro: ['Împărați', 'Regi'] },
  { name: '2 Kings', n: 2, en: ['Kings'], ro: ['Împărați', 'Regi'] },
  { name: '1 Chronicles', n: 1, en: ['Chronicles'], ro: ['Cronici'] },
  { name: '2 Chronicles', n: 2, en: ['Chronicles'], ro: ['Cronici'] },
  { name: 'Ezra', en: ['Ezra'], ro: ['Ezra'], person: true },
  { name: 'Nehemiah', en: ['Nehemiah'], ro: ['Neemia'], person: true },
  { name: 'Esther', en: ['Esther'], ro: ['Estera'], person: true },
  { name: 'Job', en: ['Job'], ro: ['Iov'], person: true },
  { name: 'Psalms', en: ['Psalms', 'Psalm'], ro: ['Psalmii', 'Psalmi', 'Psalmul', 'Psalm'] },
  { name: 'Proverbs', en: ['Proverbs'], ro: ['Proverbele', 'Proverbe'] },
  { name: 'Ecclesiastes', en: ['Ecclesiastes'], ro: ['Eclesiastul', 'Ecleziastul'] },
  { name: 'Song of Solomon', en: ['Song of Solomon', 'Song of Songs', 'Songs of Solomon'], ro: ['Cântarea Cântărilor'] },
  { name: 'Isaiah', en: ['Isaiah'], ro: ['Isaia'] },
  { name: 'Jeremiah', en: ['Jeremiah'], ro: ['Ieremia'], person: true },
  { name: 'Lamentations', en: ['Lamentations'], ro: ['Plângerile lui Ieremia', 'Plângerile'] },
  { name: 'Ezekiel', en: ['Ezekiel'], ro: ['Ezechiel'], person: true },
  { name: 'Daniel', en: ['Daniel'], ro: ['Daniel'], person: true },
  { name: 'Hosea', en: ['Hosea'], ro: ['Osea'], person: true },
  { name: 'Joel', en: ['Joel'], ro: ['Ioel'], person: true },
  { name: 'Amos', en: ['Amos'], ro: ['Amos'], person: true },
  { name: 'Obadiah', en: ['Obadiah'], ro: ['Obadia'] },
  { name: 'Jonah', en: ['Jonah'], ro: ['Iona'], person: true },
  { name: 'Micah', en: ['Micah'], ro: ['Mica'], person: true },
  { name: 'Nahum', en: ['Nahum'], ro: ['Naum'], person: true },
  { name: 'Habakkuk', en: ['Habakkuk'], ro: ['Habacuc'] },
  { name: 'Zephaniah', en: ['Zephaniah'], ro: ['Țefania'] },
  { name: 'Haggai', en: ['Haggai'], ro: ['Hagai'] },
  { name: 'Zechariah', en: ['Zechariah'], ro: ['Zaharia'], person: true },
  { name: 'Malachi', en: ['Malachi'], ro: ['Maleahi'] },
  { name: 'Matthew', en: ['Matthew'], ro: ['Matei'], person: true },
  { name: 'Mark', en: ['Mark'], ro: ['Marcu'], person: true },
  { name: 'Luke', en: ['Luke'], ro: ['Luca'], person: true },
  { name: 'John', en: ['John'], ro: ['Ioan'], person: true },
  { name: 'Acts', en: ['Acts of the Apostles', 'Acts'], ro: ['Faptele Apostolilor', 'Faptele', 'Fapte'], person: true },
  { name: 'Romans', en: ['Romans'], ro: ['Romani'] },
  { name: '1 Corinthians', n: 1, en: ['Corinthians'], ro: ['Corinteni'] },
  { name: '2 Corinthians', n: 2, en: ['Corinthians'], ro: ['Corinteni'] },
  { name: 'Galatians', en: ['Galatians'], ro: ['Galateni'] },
  { name: 'Ephesians', en: ['Ephesians'], ro: ['Efeseni'] },
  { name: 'Philippians', en: ['Philippians'], ro: ['Filipeni'] },
  { name: 'Colossians', en: ['Colossians'], ro: ['Coloseni'] },
  { name: '1 Thessalonians', n: 1, en: ['Thessalonians'], ro: ['Tesaloniceni'] },
  { name: '2 Thessalonians', n: 2, en: ['Thessalonians'], ro: ['Tesaloniceni'] },
  { name: '1 Timothy', n: 1, en: ['Timothy'], ro: ['Timotei'] },
  { name: '2 Timothy', n: 2, en: ['Timothy'], ro: ['Timotei'] },
  { name: 'Titus', en: ['Titus'], ro: ['Tit'], person: true },
  { name: 'Philemon', en: ['Philemon'], ro: ['Filimon'] },
  { name: 'Hebrews', en: ['Hebrews'], ro: ['Evrei'] },
  { name: 'James', en: ['James'], ro: ['Iacov'], person: true },
  { name: '1 Peter', n: 1, en: ['Peter'], ro: ['Petru'] },
  { name: '2 Peter', n: 2, en: ['Peter'], ro: ['Petru'] },
  { name: '1 John', n: 1, en: ['John'], ro: ['Ioan'] },
  { name: '2 John', n: 2, en: ['John'], ro: ['Ioan'] },
  { name: '3 John', n: 3, en: ['John'], ro: ['Ioan'] },
  { name: 'Jude', en: ['Jude'], ro: ['Iuda'], person: true },
  { name: 'Revelation', en: ['Revelation', 'Revelations', 'Apocalypse'], ro: ['Apocalipsa'] }
]);

const ORDINALS = {
  1: ['1', 'I', '1st', 'First', 'first', 'Întâi', 'întâi', 'Întâia', 'întâia', 'Prima', 'prima'],
  2: ['2', 'II', '2nd', 'Second', 'second', 'Doi', 'doi', 'A doua', 'a doua', 'A II-a', 'a II-a'],
  3: ['3', 'III', '3rd', 'Third', 'third', 'Trei', 'trei', 'A treia', 'a treia', 'A III-a', 'a III-a']
};

// Short forms an operator may type ("Jn 3:16", "1 Cor 13"). Live speech never
// uses these, so they are only accepted by parseReference.
const TYPED_ABBREVIATIONS = {
  Genesis: ['Gen', 'Gn'], Exodus: ['Exod', 'Ex'], Leviticus: ['Lev'], Numbers: ['Num'], Deuteronomy: ['Deut', 'Dt'],
  Joshua: ['Josh'], Judges: ['Judg'], Ruth: ['Rth'], Samuel: ['Sam', 'Sm'], Kings: ['Kgs', 'Kin'], Chronicles: ['Chron', 'Chr'],
  Nehemiah: ['Neh'], Esther: ['Esth', 'Est'], Psalms: ['Psa', 'Ps', 'Pss'], Proverbs: ['Prov', 'Pr'], Ecclesiastes: ['Eccl', 'Ecc'],
  'Song of Solomon': ['Song', 'SoS'], Isaiah: ['Isa'], Jeremiah: ['Jer'], Lamentations: ['Lam'], Ezekiel: ['Ezek', 'Ezk'],
  Daniel: ['Dan'], Hosea: ['Hos'], Obadiah: ['Obad', 'Ob'], Jonah: ['Jon'], Micah: ['Mic'], Nahum: ['Nah'],
  Habakkuk: ['Hab'], Zephaniah: ['Zeph'], Haggai: ['Hag'], Zechariah: ['Zech'], Malachi: ['Mal'], Matthew: ['Matt', 'Mt'],
  Mark: ['Mk', 'Mrk'], Luke: ['Lk'], John: ['Jn', 'Jhn'], Acts: ['Act'], Romans: ['Rom'], Corinthians: ['Cor'],
  Galatians: ['Gal'], Ephesians: ['Eph'], Philippians: ['Phil', 'Php'], Colossians: ['Col'], Thessalonians: ['Thess', 'Th'],
  Timothy: ['Tim'], Titus: ['Tit'], Philemon: ['Philem', 'Phm'], Hebrews: ['Heb'], James: ['Jas'], Peter: ['Pet', 'Pt'],
  Jude: ['Jud'], Revelation: ['Rev']
};

const SINGLE_CHAPTER_BOOKS = new Set([31, 57, 63, 64, 65]);

function foldText(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-\s]+/g, ' ')
    .trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Romanian speech recognition may write ș/ț with a comma or a cedilla, or
// leave the accents off entirely.
const FOLDABLE = { ă: '[ăa]', â: '[âa]', î: '[îi]', ș: '[șşs]', ț: '[țţt]', Î: '[ÎI]', Ș: '[ȘŞS]', Ț: '[ȚŢT]' };
function formPattern(form) {
  return escapeRegExp(form)
    .replace(/[ăâîșțÎȘȚ]/g, letter => FOLDABLE[letter])
    .replace(/ +/g, '\\s+')
    .replace(/\\-/g, '[-\\s]?');
}

function buildBookMatcher({ typed }) {
  const lookup = new Map();
  const forms = [];
  BOOKS.forEach((book, index) => {
    const names = [...book.en, ...book.ro];
    if (typed) {
      const base = book.n ? book.name.replace(/^\d\s+/, '') : book.name;
      names.push(...(TYPED_ABBREVIATIONS[base] || []));
    }
    for (const name of names) {
      const variants = book.n ? ORDINALS[book.n].map(prefix => `${prefix} ${name}`) : [name];
      for (const variant of variants) {
        const key = foldText(variant);
        if (!lookup.has(key)) lookup.set(key, index + 1);
        forms.push(variant);
      }
    }
  });
  forms.sort((a, b) => b.length - a.length);
  const pattern = `(?<![\\p{L}\\p{N}])(?:${[...new Set(forms)].map(formPattern).join('|')})(?![\\p{L}\\p{N}])`;
  return { regex: new RegExp(pattern, typed ? 'giu' : 'gu'), lookup };
}

const LIVE_BOOKS = buildBookMatcher({ typed: false });
const TYPED_BOOKS = buildBookMatcher({ typed: true });

function bookFromMatch(matcher, text) {
  const folded = foldText(text).replace(/\.$/, '');
  return matcher.lookup.get(folded) || 0;
}

// --- Reference grammar after a book name -------------------------------------
const NUM = '(\\d{1,3})';
const SEP = '[\\s,]*';
const CHAPTER = '(?:chapter|chap\\.|capitolul|capitolului|capitol|cap\\.)';
const CHAPTERS = '(?:chapters|capitolele|chapter|capitolul|capitol)';
const VERSE = '(?:verses|verse|vv\\.|v\\.|versetele|versetul|versetului|versete|verset)';
const AND = '(?:and|și|şi|si)';
const BEFORE_VERSE = `(?:${AND}\\s+|from\\s+|de\\s+la\\s+|începând\\s+cu\\s+|incepand\\s+cu\\s+|starting\\s+(?:with|at|from)\\s+|beginning\\s+(?:with|at|from)\\s+|at\\s+|in\\s+|la\\s+)?`;
const TO = '(?:to|through|thru|până\\s+la|pana\\s+la|la|and|și|şi|si)';
const RANGE = `(?:\\s*[-–—]\\s*|\\s+${TO}\\s+(?:${VERSE}\\s*)?)(\\d{1,3})(?![\\d:])`;
const CHAPTER_WORD = `(?:${CHAPTER}\\s*)?`;
const CHAPTER_TO = '(?:\\s*[-–—]\\s*|\\s+(?:to|through|thru|până\\s+la|pana\\s+la|la)\\s+)';
const NOT_MORE = '(?![\\d:]|\\.\\d)';
// A verse range without the word "verse" ("5, 1 through 6"). "and" is left
// out: "Matthew 5, 6 and 7" lists chapters.
const THROUGH = `(?:\\s*[-–—]\\s*|\\s+(?:to|through|thru|până\\s+la|pana\\s+la|la)\\s+(?:${VERSE}\\s*)?)(\\d{1,3})(?![\\d:])`;

// A tail with a verse range is also compiled without it: in "Romans 8:28 and
// 2 Corinthians 5:17" the "and 2" is not a range, and the second book must
// stay unread for the next match.
function tail(source, parts, { range = false, explicit = false, spaced = false } = {}) {
  return {
    re: new RegExp(range ? `${source}(?:${RANGE})?` : source, 'yiu'),
    single: range ? new RegExp(source, 'yiu') : null,
    parts,
    explicit,
    spaced
  };
}

// Tried in order; the first that fits decides what the words mean.
const BOOK_TAILS = [
  tail(`${SEP}${CHAPTER_WORD}${NUM}\\s*:\\s*${NUM}`, 'cv', { range: true }),
  tail(`${SEP}${CHAPTER_WORD}${NUM}\\.${NUM}`, 'cv', { range: true }),
  tail(`${SEP}${CHAPTER_WORD}${NUM}\\s+(?:cu|with|la|at)\\s+${NUM}`, 'cv', { range: true }),
  tail(`${SEP}${CHAPTER_WORD}${NUM}${SEP}(?:from|de\\s+la)\\s+(?:${VERSE}\\s*)?${NUM}\\s+(?:to|through|la|până\\s+la|pana\\s+la)\\s+(?:${VERSE}\\s*)?${NUM}`, 'cv'),
  tail(`${SEP}${CHAPTER_WORD}${NUM}${SEP}${BEFORE_VERSE}${VERSE}\\s*${NUM}`, 'cv', { range: true }),
  // "Psalm 5, 1 through 6": two numbers and a range, no word "verse".
  tail(`${SEP}${CHAPTER_WORD}${NUM}[\\s,]+${NUM}${THROUGH}`, 'cv'),
  // "Psalms 1 through 4", "capitolele 5-7": several chapters.
  tail(`${SEP}(?:${CHAPTERS}\\s*)?${NUM}${CHAPTER_TO}(?:${CHAPTERS}\\s*)?${NUM}${NOT_MORE}`, 'cc'),
  // Google sometimes translates Romanian "6 la 5" ("6 at 5") as "6 to 5".
  tail(`${SEP}${CHAPTER_WORD}${NUM}\\s+to\\s+${NUM}${NOT_MORE}`, 'cv', { range: true }),
  // Spoken "Galateni 2 20" / "Galatians 2 20" without a separator word.
  tail(`${SEP}${CHAPTER_WORD}${NUM}\\s+${NUM}${NOT_MORE}`, 'cv', { range: true, spaced: true }),
  tail(`${SEP}${CHAPTER}\\s*${NUM}(?![\\d:])`, 'c', { explicit: true }),
  tail(`${SEP}${VERSE}\\s*${NUM}`, 'v', { range: true }),
  tail(`[\\s,]*${NUM}${NOT_MORE}`, 'c')
];

// After a reference: more verses ("Romans 8:28, 31 and 38"), more chapters
// ("Psalms 23, 24"), or another place in the same book ("John 3:16 and 4:1").
const LIST_ITEM = new RegExp(`(?:\\s*,\\s*|\\s+${AND}\\s+)(?:${VERSE}\\s*)?(\\d{1,3})${NOT_MORE}`, 'yiu');
const SAME_BOOK = new RegExp(`(?:\\s*[,;]\\s*|\\s+${AND}\\s+)(?:${CHAPTER}\\s*)?${NUM}\\s*:\\s*${NUM}(?:${RANGE})?`, 'yiu');

// "verse 28" or "chapter 2, verse 1" with no book: the book and chapter come
// from the reference the preacher gave just before.
const CONTEXT_START = new RegExp(`(?<![\\p{L}\\p{N}])(?:chapters|capitolele|${CHAPTER}|${VERSE})(?=\\s*\\d)`, 'giu');
const CONTEXT_TAILS = [
  tail(`${CHAPTERS}\\s*${NUM}${CHAPTER_TO}(?:${CHAPTERS}\\s*)?${NUM}${NOT_MORE}`, 'cc', { explicit: true }),
  tail(`${CHAPTER}\\s*${NUM}${SEP}${BEFORE_VERSE}${VERSE}\\s*${NUM}`, 'cv', { range: true }),
  tail(`${CHAPTER}\\s*${NUM}(?![\\d:])`, 'c', { explicit: true }),
  tail(`${VERSE}\\s*${NUM}`, 'v', { range: true })
];

// "capitolul 3 din Ioan", "chapter 3 of the Gospel of John": the book comes
// after the numbers, with at most three words between.
const BOOK_AFTER = /\s*,?\s*(?:din|of|from|in)\s+/yiu;
const BOOK_AFTER_GAP = 40;
const BOOK_AFTER_CHAPTER = /[\s,]*(?:capitolul\s*|chapter\s*)?(\d{1,3})(?![\d:]|\.\d)/yiu;

// Runs one tail at `position`. Returns { numbers, end } or null.
function readTail(spec, text, position) {
  spec.re.lastIndex = position;
  const found = spec.re.exec(text);
  if (!found) return null;
  if (spec.spaced && spec.single) {
    spec.single.lastIndex = position;
    spec.single.exec(text);
    if (bookStartsAt(text, spec.single.lastIndex - String(found[2]).length)) return null;
  }
  const numbers = found.slice(1).map(value => (value === undefined ? 0 : Number(value)));
  if (spec.single) {
    const verse = spec.parts === 'v' ? numbers[0] : numbers[1];
    const last = numbers[spec.parts === 'v' ? 1 : 2];
    if (last && last <= verse) {
      spec.single.lastIndex = position;
      spec.single.exec(text);
      return { numbers: numbers.slice(0, spec.parts === 'v' ? 1 : 2), end: spec.single.lastIndex };
    }
  }
  return { numbers, end: spec.re.lastIndex };
}

export function chapterCount(book) {
  return VERSE_COUNTS.eng[book - 1]?.length || 0;
}

export function verseCount(book, chapter, scheme = 'eng') {
  const counts = scheme === 'org-psalms' ? (book === 19 ? VERSE_COUNTS.org : VERSE_COUNTS.eng) : VERSE_COUNTS[scheme];
  return counts?.[book - 1]?.[chapter - 1] || 0;
}

// Builds a checked reference in King James numbering, or null.
//   chapterEnd: several whole chapters ("Psalms 1–4").
//   list: verses that are not all in a row ("Romans 8:28, 31, 38"); the range
//     verseStart–verseEnd then spans them.
export function makeReference(book, chapter, verseStart = 0, verseEnd = 0, { chapterEnd = 0, list = null } = {}) {
  book = Number(book);
  chapter = Number(chapter);
  verseStart = Number(verseStart) || 0;
  verseEnd = Number(verseEnd) || 0;
  if (!Number.isInteger(book) || book < 1 || book > 66) return null;
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > chapterCount(book)) return null;
  const ref = { book, chapter, verseStart: 0, verseEnd: 0 };
  const max = verseCount(book, chapter);
  if (Array.isArray(list) && list.length > 1) {
    const verses = [...new Set(list.map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= max).sort((a, b) => a - b);
    if (!verses.length) return null;
    ref.verseStart = verses[0];
    if (verses.length > 1) ref.verseEnd = verses[verses.length - 1];
    if (verses.length !== ref.verseEnd - ref.verseStart + 1 && verses.length > 1) ref.list = verses;
    return ref;
  }
  if (!verseStart) {
    const lastChapter = Number(chapterEnd) || 0;
    if (lastChapter > chapter && lastChapter <= chapterCount(book) && lastChapter - chapter <= 10) ref.chapterEnd = lastChapter;
    return ref;
  }
  if (verseStart < 1 || verseStart > max) return null;
  ref.verseStart = verseStart;
  if (verseEnd > verseStart) ref.verseEnd = Math.min(verseEnd, max);
  return ref;
}

// The verse numbers a reference names, in order (empty for whole chapters).
export function referenceVerses(ref) {
  if (!ref?.verseStart) return [];
  if (ref.list) return [...ref.list];
  const verses = [];
  for (let n = ref.verseStart; n <= (ref.verseEnd || ref.verseStart); n++) verses.push(n);
  return verses;
}

function referenceFromParts(book, parts, numbers, explicit) {
  const [first = 0, second = 0, third = 0] = numbers;
  if (parts === 'v') {
    // Only one-chapter books take a bare verse ("Jude verse 24").
    return SINGLE_CHAPTER_BOOKS.has(book) ? makeReference(book, 1, first, second) : null;
  }
  if (parts === 'c') {
    if (SINGLE_CHAPTER_BOOKS.has(book) && !explicit) return makeReference(book, 1, first);
    if (BOOKS[book - 1].person && !explicit) return null;
    return makeReference(book, first);
  }
  if (parts === 'cc') {
    if (BOOKS[book - 1].person && !explicit) return null;
    if (!(second > first)) return null;
    const ref = makeReference(book, first, 0, 0, { chapterEnd: second });
    return ref?.chapterEnd ? ref : null;
  }
  return makeReference(book, first, second, third);
}

export function referenceKey(ref) {
  if (ref.chapterEnd) return `${ref.book}.${ref.chapter}-${ref.chapterEnd}`;
  if (ref.list) return `${ref.book}.${ref.chapter}.${ref.list.join(',')}`;
  return `${ref.book}.${ref.chapter}.${ref.verseStart || 0}.${ref.verseEnd || 0}`;
}

export function formatReference(ref, bookName = BOOKS[ref.book - 1]?.name || '') {
  let label = `${bookName} ${ref.chapter}`;
  if (ref.chapterEnd) return `${label}–${ref.chapterEnd}`;
  if (ref.list) return `${label}:${ref.list.join(', ')}`;
  if (ref.verseStart) label += `:${ref.verseStart}`;
  if (ref.verseEnd) label += `–${ref.verseEnd}`;
  return label;
}

// True when a numbered book name ("2 Corinthians") starts at `position`, so
// its number is not read as another verse or chapter.
function bookStartsAt(text, position) {
  const start = text.slice(position).search(/\S/);
  if (start < 0) return false;
  LIVE_BOOKS.regex.lastIndex = position + start;
  const match = LIVE_BOOKS.regex.exec(text);
  return Boolean(match && match.index === position + start);
}

function readList(text, position, last, max) {
  const items = [];
  let end = position;
  while (items.length < 12) {
    LIST_ITEM.lastIndex = end;
    const found = LIST_ITEM.exec(text);
    if (!found) break;
    const number = Number(found[1]);
    if (bookStartsAt(text, found.index + found[0].length - found[1].length) || number <= last || number > max) break;
    items.push(number);
    last = number;
    end = LIST_ITEM.lastIndex;
  }
  return { items, end };
}

// Reads the words after a book name. Returns { refs, end, context } or null
// when nothing there is a reference. `typed`: an operator typed it, so names
// like John need no "chapter".
function readAfterBook(book, text, position, { typed = false } = {}) {
  for (const spec of BOOK_TAILS) {
    const read = readTail(spec, text, position);
    if (!read) continue;
    const explicit = typed || spec.explicit || (spec.parts === 'cc' && /chap|capit/i.test(text.slice(position, read.end)));
    let ref = referenceFromParts(book, spec.parts, read.numbers, explicit);
    let end = read.end;
    if (!ref) {
      if (spec.parts === 'cc') continue;
      const context = spec.parts === 'c' ? makeReference(book, read.numbers[0]) : null;
      return { refs: [], end, context };
    }
    if (ref.verseStart) {
      const more = readList(text, end, ref.verseEnd || ref.verseStart, verseCount(book, ref.chapter));
      if (more.items.length) {
        ref = makeReference(book, ref.chapter, 0, 0, { list: [...referenceVerses(ref), ...more.items] });
        end = more.end;
      }
    } else if (!ref.chapterEnd && spec.parts === 'c' && !SINGLE_CHAPTER_BOOKS.has(book)) {
      // "Psalms 23, 24": chapters in a row become one range.
      const more = readList(text, end, ref.chapter, chapterCount(book));
      let lastChapter = ref.chapter;
      for (const chapter of more.items) {
        if (chapter !== lastChapter + 1) break;
        lastChapter = chapter;
      }
      if (lastChapter > ref.chapter) {
        ref = makeReference(book, ref.chapter, 0, 0, { chapterEnd: lastChapter });
        end = more.end;
      }
    }
    const refs = [ref];
    // "John 3:16 and 3:17", "John 3:16 and 4:1".
    while (refs.length < 6) {
      SAME_BOOK.lastIndex = end;
      const found = SAME_BOOK.exec(text);
      if (!found) break;
      const [chapter, start, finish] = found.slice(1).map(value => Number(value) || 0);
      const next = makeReference(book, chapter, start, finish);
      if (!next) break;
      const previous = refs[refs.length - 1];
      if (next.chapter === previous.chapter && previous.verseStart) {
        refs[refs.length - 1] = makeReference(book, chapter, 0, 0, { list: [...referenceVerses(previous), ...referenceVerses(next)] }) || previous;
      } else {
        refs.push(next);
      }
      end = SAME_BOOK.lastIndex;
    }
    return { refs, end };
  }
  return null;
}

// One reference typed by the operator, e.g. "jn 3:16", "Romans 8 28-30",
// "Psalmul 23". Returns null when it is not a valid reference.
export function parseReference(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  TYPED_BOOKS.regex.lastIndex = 0;
  const match = TYPED_BOOKS.regex.exec(text);
  if (!match || match.index > 0) return null;
  const book = bookFromMatch(TYPED_BOOKS, match[0]);
  if (!book) return null;
  let rest = text.slice(match.index + match[0].length).replace(/^\.\s*/, ' ');
  // Typed "8 28" means chapter 8, verse 28.
  rest = rest.replace(/^(\s*\d{1,3})\s+(\d{1,3})(?=\s*(?:[-–—]\s*\d{1,3})?\s*$)/, '$1:$2');
  const read = readAfterBook(book, rest, 0, { typed: true });
  if (!read || read.refs.length !== 1 || rest.slice(read.end).trim()) return null;
  return read.refs[0];
}

// A reference is final once a word after it cannot be part of it ("Romans 8"
// waits through ", verse" for "28"; "Ephesians 2:16 and reconciled" is done).
const CONTINUES = /^(?:and|și|şi|si|verse|verses|versetul|versetele|versete|verset|chapter|chapters|capitolul|capitolele|capitol|de|la|from|to|through|thru|până|pana|cu|with|at|in|începând|incepand|starting|beginning)$/iu;
function tailIsSettled(trailing) {
  if (/[.?!;]/.test(trailing)) return true;
  const words = trailing.split(/\s+/).map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  return words.some(word => !CONTINUES.test(word) && !/^\d+$/.test(word));
}

function startOfLastWords(text, count) {
  let index = text.length;
  for (let found = 0; found < count && index > 0; found++) {
    index = text.lastIndexOf(' ', index - 1);
    if (index < 0) return 0;
  }
  return index;
}

// Streams text (pieces as Google sends them) and calls onReference with each
// complete reference, once. flush() treats the end of the text as complete;
// call it after a short pause in speech.
// onMention gets a book and chapter that were named but are not shown
// ("Marcu 13": Mark is also a name), so a reading from that book can be followed.
export function createReferenceTracker({ onReference = () => {}, onMention = () => {}, now = Date.now, contextMs = 180_000 } = {}) {
  let buffer = '';
  let consumed = 0;
  let context = null;

  function nextCandidate() {
    LIVE_BOOKS.regex.lastIndex = consumed;
    const bookMatch = LIVE_BOOKS.regex.exec(buffer);
    CONTEXT_START.lastIndex = consumed;
    const contextMatch = CONTEXT_START.exec(buffer);
    if (bookMatch && (!contextMatch || bookMatch.index <= contextMatch.index)) {
      const book = bookFromMatch(LIVE_BOOKS, bookMatch[0]);
      return book ? { kind: 'book', index: bookMatch.index, end: bookMatch.index + bookMatch[0].length, book } : { kind: 'skip', end: bookMatch.index + bookMatch[0].length };
    }
    if (contextMatch) return { kind: 'context', index: contextMatch.index, end: contextMatch.index };
    return null;
  }

  function parseAt(candidate) {
    // "Ioan 3" alone is not shown (Ioan, John, Mark are also names), but it
    // is kept as context so a following "versetul 16" means John 3:16.
    if (candidate.kind === 'book') return readAfterBook(candidate.book, buffer, candidate.end);
    for (const spec of CONTEXT_TAILS) {
      const read = readTail(spec, buffer, candidate.end);
      if (!read) continue;
      const named = bookNamedAfter(read.end);
      if (named?.pending) return { refs: [], end: buffer.length, pending: true };
      let ref = null;
      let end = read.end;
      if (named) {
        end = named.end;
        if (spec.parts === 'v') {
          // "versetul 16 din Ioan 3"
          if (named.chapter) ref = makeReference(named.book, named.chapter, read.numbers[0], read.numbers[1]);
        } else {
          ref = referenceFromParts(named.book, spec.parts, read.numbers, true);
        }
      } else if (context && now() - context.at <= contextMs) {
        ref = spec.parts === 'v'
          ? makeReference(context.book, context.chapter, read.numbers[0], read.numbers[1])
          : referenceFromParts(context.book, spec.parts, read.numbers, true);
      }
      return { refs: ref ? [ref] : [], end };
    }
    return null;
  }

  // The book named after "capitolul 3 din …"; { pending } while the words
  // after "din" have not all arrived.
  function bookNamedAfter(position) {
    BOOK_AFTER.lastIndex = position;
    if (!BOOK_AFTER.exec(buffer)) return null;
    const from = BOOK_AFTER.lastIndex;
    LIVE_BOOKS.regex.lastIndex = from;
    const match = LIVE_BOOKS.regex.exec(buffer);
    const between = match ? buffer.slice(from, match.index) : buffer.slice(from);
    const gapWords = between.trim() ? between.trim().split(/\s+/).length : 0;
    if (!match || match.index - from > BOOK_AFTER_GAP || gapWords > 3) {
      const mayStillCome = buffer.length - from < BOOK_AFTER_GAP && gapWords <= 3 && !/[.?!]/.test(between);
      return mayStillCome ? { pending: true } : null;
    }
    const book = bookFromMatch(LIVE_BOOKS, match[0]);
    if (!book) return null;
    let end = match.index + match[0].length;
    BOOK_AFTER_CHAPTER.lastIndex = end;
    const chapter = BOOK_AFTER_CHAPTER.exec(buffer);
    if (chapter) end = BOOK_AFTER_CHAPTER.lastIndex;
    return { book, chapter: chapter ? Number(chapter[1]) : 0, end };
  }

  function emit(ref, raw) {
    context = { book: ref.book, chapter: ref.chapter, at: now() };
    onReference({ ...ref, raw: raw.trim() });
  }

  function scan(flushing) {
    while (consumed < buffer.length) {
      const candidate = nextCandidate();
      if (!candidate) {
        // A book name can arrive split across pieces ("găsim de la 1" + " Corinteni").
        consumed = Math.max(consumed, startOfLastWords(buffer, 3));
        break;
      }
      if (candidate.kind === 'skip') {
        consumed = candidate.end;
        continue;
      }
      const parsed = parseAt(candidate);
      if (parsed?.pending && !flushing) break;
      const end = parsed ? parsed.end : candidate.end;
      if (!flushing && !tailIsSettled(buffer.slice(end))) break;
      if (parsed?.refs.length) for (const ref of parsed.refs) emit(ref, buffer.slice(candidate.index, end));
      else if (parsed?.context) {
        context = { book: parsed.context.book, chapter: parsed.context.chapter, at: now() };
        onMention(parsed.context);
      }
      consumed = Math.max(end, candidate.end, consumed + 1);
    }
    if (consumed > 400) {
      buffer = buffer.slice(consumed);
      consumed = 0;
    }
  }

  return {
    push(text) {
      if (typeof text !== 'string' || !text) return;
      buffer += text;
      scan(false);
    },
    flush() {
      scan(true);
    },
    reset() {
      buffer = '';
      consumed = 0;
      context = null;
    }
  };
}

// All complete references in a finished text (tests, and the AI notes check).
export function findReferences(text, options = {}) {
  const found = [];
  const tracker = createReferenceTracker({ ...options, onReference: ref => found.push(ref) });
  tracker.push(text);
  tracker.flush();
  return found;
}

// --- Verse numbering in other Bibles -----------------------------------------
// References are kept in King James numbering. A Bible that numbers verses
// differently (the Russian Synodal shifts most Psalms by one) gets the same
// words through the original-language numbering.
function bestEntry(entries, matches, size) {
  let best = null;
  for (const entry of entries) {
    if (!matches(entry)) continue;
    if (!best || size(entry) > size(best)) best = entry;
  }
  return best;
}

function englishToOriginal(book, chapter, verse) {
  const entry = bestEntry(
    TO_ORIGINAL.eng,
    e => e[0] === book && e[1] === chapter && verse >= e[2] && verse <= e[3],
    e => e[3] - e[2]
  );
  if (!entry) return [book, chapter, verse];
  return [entry[4], entry[5], Math.min(entry[6] + (verse - entry[2]), entry[7])];
}

function originalToSynodal(book, chapter, verse) {
  const entry = bestEntry(
    TO_ORIGINAL.rso,
    e => e[4] === book && e[5] === chapter && verse >= e[6] && verse <= e[7],
    e => (e[7] - e[6]) * 1000 + (e[3] - e[2])
  );
  if (!entry) return [book, chapter, verse];
  return [entry[0], entry[1], Math.max(1, Math.min(entry[2] + (verse - entry[6]), entry[3]))];
}

function mapVerse(book, chapter, verse, scheme) {
  if (scheme === 'eng') return [book, chapter, verse];
  if (scheme === 'org-psalms' && book !== 19) return [book, chapter, verse];
  const original = englishToOriginal(book, chapter, verse);
  return scheme === 'rso' ? originalToSynodal(...original) : original;
}

// The same passage in another numbering scheme: 'eng', 'rso' (Russian
// Synodal) or 'org-psalms' (Hebrew Psalm numbering, King James elsewhere).
export function referenceInScheme(ref, scheme = 'eng') {
  if (!ref || scheme === 'eng') return ref && { ...ref };
  const [, chapter, verseStart] = mapVerse(ref.book, ref.chapter, ref.verseStart || 1, scheme);
  const mapped = { book: ref.book, chapter, verseStart: ref.verseStart ? verseStart : 0, verseEnd: 0 };
  if (ref.chapterEnd) {
    const [, chapterEnd] = mapVerse(ref.book, ref.chapterEnd, 1, scheme);
    if (chapterEnd > chapter) mapped.chapterEnd = chapterEnd;
    return mapped;
  }
  if (ref.list) {
    const list = ref.list.map(verse => mapVerse(ref.book, ref.chapter, verse, scheme)).filter(([, c]) => c === chapter).map(([, , v]) => v);
    if (list.length > 1) {
      mapped.list = list;
      mapped.verseEnd = list[list.length - 1];
    }
    return mapped;
  }
  if (ref.verseStart && ref.verseEnd) {
    const [, endChapter, verseEnd] = mapVerse(ref.book, ref.chapter, ref.verseEnd, scheme);
    mapped.verseEnd = endChapter === chapter ? verseEnd : verseCount(ref.book, chapter, scheme);
    if (mapped.verseEnd <= mapped.verseStart) mapped.verseEnd = 0;
  }
  return mapped;
}
