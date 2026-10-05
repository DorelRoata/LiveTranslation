// Biblical & Theological Glossary Filter for Live Translation
// Corrects common church sermon phonetic misinterpretations and book name translations

export const BIBLICAL_BOOKS_EN = Object.freeze({
  // Old Testament
  'geneza': 'Genesis',
  'facerea': 'Genesis',
  'exod': 'Exodus',
  'ieșirea': 'Exodus',
  'levitic': 'Leviticus',
  'numeri': 'Numbers',
  'deuteronom': 'Deuteronomy',
  'iosua': 'Joshua',
  'judecători': 'Judges',
  'judecatori': 'Judges',
  'rut': 'Ruth',
  '1 samuel': '1 Samuel',
  '2 samuel': '2 Samuel',
  '1 regi': '1 Kings',
  '2 regi': '2 Kings',
  '1 împărați': '1 Kings',
  '2 împărați': '2 Kings',
  '1 cronici': '1 Chronicles',
  '2 cronici': '2 Chronicles',
  'ezra': 'Ezra',
  'neemia': 'Nehemiah',
  'estera': 'Esther',
  'iov': 'Job',
  'psalmi': 'Psalms',
  'psalmii': 'Psalms',
  'psalmul': 'Psalm',
  'proverbe': 'Proverbs',
  'proverbele': 'Proverbs',
  'eclesiastul': 'Ecclesiastes',
  'cântarea cântărilor': 'Song of Solomon',
  'cantarea cantarilor': 'Song of Solomon',
  'isaia': 'Isaiah',
  'ieremia': 'Jeremiah',
  'plângerile lui ieremia': 'Lamentations',
  'plangerile': 'Lamentations',
  'ezechiel': 'Ezekiel',
  'daniel': 'Daniel',
  'osea': 'Hosea',
  'ioel': 'Joel',
  'amos': 'Amos',
  'obadia': 'Obadiah',
  'iona': 'Jonah',
  'mica': 'Micah',
  'naum': 'Nahum',
  'habacuc': 'Habakkuk',
  'țefania': 'Zephaniah',
  'tefania': 'Zephaniah',
  'hagai': 'Haggai',
  'zaharia': 'Zechariah',
  'maleahi': 'Malachi',

  // New Testament
  'matei': 'Matthew',
  'marcu': 'Mark',
  'luca': 'Luke',
  'ioan': 'John',
  'faptele apostolilor': 'Acts',
  'faptele': 'Acts',
  'fapte': 'Acts',
  'romani': 'Romans',
  '1 corinteni': '1 Corinthians',
  '2 corinteni': '2 Corinthians',
  'galateni': 'Galatians',
  'efeseni': 'Ephesians',
  'filipeni': 'Philippians',
  'coloseni': 'Colossians',
  '1 tesaloniceni': '1 Thessalonians',
  '2 tesaloniceni': '2 Thessalonians',
  '1 timotei': '1 Timothy',
  '2 timotei': '2 Timothy',
  'tit': 'Titus',
  'filimon': 'Philemon',
  'evrei': 'Hebrews',
  'iacov': 'James',
  '1 petru': '1 Peter',
  '2 petru': '2 Peter',
  '1 ioan': '1 John',
  '2 ioan': '2 John',
  '3 ioan': '3 John',
  'iuda': 'Jude',
  'apocalipsa': 'Revelation'
});

export const THEOLOGICAL_TERMS_EN = Object.freeze({
  'duhul sfânt': 'the Holy Spirit',
  'duhul sfant': 'the Holy Spirit',
  'sfântul duh': 'the Holy Spirit',
  'sfantul duh': 'the Holy Spirit',
  'domnul isus hristos': 'the Lord Jesus Christ',
  'domnul isus': 'the Lord Jesus',
  'isus hristos': 'Jesus Christ',
  'mântuitorul': 'the Savior',
  'mantuitorul': 'the Savior',
  'cuvântul domnului': 'the Word of the Lord',
  'cuvantul domnului': 'the Word of the Lord',
  'neprihănire': 'righteousness',
  'neprihanire': 'righteousness',
  'sfințenie': 'holiness',
  'sfintenie': 'holiness',
  'pocăință': 'repentance',
  'pocainta': 'repentance',
  'mântuire': 'salvation',
  'mantuire': 'salvation',
  'harul domnului': 'the grace of the Lord',
  'împărăția lui dumnezeu': 'the Kingdom of God',
  'imparatia lui dumnezeu': 'the Kingdom of God',
  'evanghelia': 'the Gospel'
});

// English phrases that are only wrong inside a Bible reference. "The Romanians"
// is ordinary English in a Romanian church, so it changes only as a book name.
export const ENGLISH_CORRECTIONS = Object.freeze([
  { pattern: /(?<![\p{L}\p{N}])book of the romanians(?![\p{L}\p{N}])/giu, replacement: 'book of Romans' },
  { pattern: /(?<![\p{L}\p{N}])the romanians(?=,?\s+(?:chapter\s+)?\d)/giu, replacement: 'Romans' },
  { pattern: /(?<![\p{L}\p{N}])book of (?:facts|deeds)(?![\p{L}\p{N}])/giu, replacement: 'Book of Acts' }
]);

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole words only. \b treats Romanian letters (ă, â, î, ș, ț) as word
// boundaries, so these use Unicode letter classes instead.
function wholeWord(term, lookahead = '') {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])${lookahead}`, 'giu');
}

function keepLeadingCapital(match, replacement) {
  return match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()
    ? replacement[0].toUpperCase() + replacement.slice(1)
    : replacement;
}

// Google already translates book names and church terms correctly; on a
// recorded 15-minute sermon this changed nothing. It is a safety net for a
// Romanian word left untranslated, and it must never alter ordinary English.
export function applyBiblicalGlossary(text, targetLanguage = 'en', customGlossary = {}) {
  if (!text || typeof text !== 'string') return text || '';
  let result = text;

  const lang = String(targetLanguage || '').toLowerCase();
  if (lang.startsWith('en')) {
    for (const { pattern, replacement } of ENGLISH_CORRECTIONS) {
      result = result.replace(pattern, match => keepLeadingCapital(match, replacement));
    }

    for (const [roTerm, enTerm] of Object.entries(THEOLOGICAL_TERMS_EN)) {
      result = result.replace(wholeWord(roTerm), match => keepLeadingCapital(match, enTerm));
    }

    // Book names only as references ("Romani 8", "Matei capitolul 5"). Several
    // are also English words (rut, tit, mica), so a bare word never changes.
    for (const [roBook, enBook] of Object.entries(BIBLICAL_BOOKS_EN)) {
      result = result.replace(wholeWord(roBook, '(?=\\s+(?:\\d|capitolul))'), enBook);
    }
  }

  if (customGlossary && typeof customGlossary === 'object') {
    for (const [sourceWord, targetWord] of Object.entries(customGlossary)) {
      if (!sourceWord || !targetWord) continue;
      result = result.replace(wholeWord(sourceWord.trim()), targetWord.trim());
    }
  }

  return result;
}
