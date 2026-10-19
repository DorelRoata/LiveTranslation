import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_NOTES_SETTINGS,
  buildNotesRequest,
  normalizeNotesResponse,
  normalizeNotesSettings,
  notesUpdateDue
} from '../src/message-notes.js';
import { createBibleLibrary } from '../server-bible.js';
import { createMessageNotes } from '../server-message-notes.js';
import { parseReference } from '../src/bible-references.js';

const LANES = [{ lane: 'lang1', code: 'en' }, { lane: 'lang2', code: 'ru' }];

test('settings keep only known values', () => {
  assert.deepEqual(normalizeNotesSettings({}), DEFAULT_NOTES_SETTINGS);
  assert.deepEqual(
    normalizeNotesSettings({ notes: false, verses: false, follow: false, spokenVerses: false, verseSeconds: 120, englishBible: 'web' }),
    { notes: false, verses: false, follow: false, spokenVerses: false, verseSeconds: 120, englishBible: 'web' }
  );
  const kept = normalizeNotesSettings({ verseSeconds: 7, englishBible: 'niv', notes: 'yes' });
  assert.deepEqual(kept, DEFAULT_NOTES_SETTINGS);
});

test('notes start after about a minute of preaching and then every minute and a half', () => {
  const base = { enabled: true, words: 130, notesWords: 0, lastAttemptAt: 0, lastTextAt: 100_000, now: 100_000 };
  assert.equal(notesUpdateDue({ ...base, words: 100 }), false, 'not before 120 words');
  assert.equal(notesUpdateDue(base), true, 'first notes');
  assert.equal(notesUpdateDue({ ...base, enabled: false }), false);
  assert.equal(notesUpdateDue({ ...base, inFlight: true }), false);
  assert.equal(notesUpdateDue({ ...base, lastAttemptAt: 90_000 }), false, 'retry waits 30 s after an error');

  const later = { ...base, hasNotes: true, words: 400, notesWords: 330, lastAttemptAt: 0, now: 95_000, lastTextAt: 95_000 };
  assert.equal(notesUpdateDue(later), true, '70 new words after 95 s');
  assert.equal(notesUpdateDue({ ...later, lastAttemptAt: 10_000 }), false, 'too soon');
  assert.equal(notesUpdateDue({ ...later, words: 350 }), false, 'only 20 new words while still preaching');
  assert.equal(notesUpdateDue({ ...later, words: 350, lastTextAt: 60_000, lastAttemptAt: 50_000 }), true, 'a pause catches the last words');
});

test('the request asks for every screen language and carries the notes already shown', () => {
  const request = buildNotesRequest({
    transcript: 'Mesajul intitulat este crucea lui Iisus Hristos.',
    translation: 'The message is titled the cross of Jesus Christ.',
    codes: ['en', 'ru'],
    previous: { title: { en: 'The Cross', ru: 'Крест' }, summary: { en: '', ru: '' }, points: [] }
  });
  const text = request.contents[0].parts[0].text;
  assert.match(text, /en = English, ru = Russian/);
  assert.match(text, /crucea lui Iisus/);
  assert.match(text, /Notes on screen now/);
  assert.deepEqual(request.generationConfig.responseSchema.properties.title.required, ['en', 'ru']);
  assert.equal(request.generationConfig.responseMimeType, 'application/json');
});

test("Gemini's notes are mapped to screen lanes, trimmed, and checked", () => {
  const notes = normalizeNotesResponse(JSON.stringify({
    title: { en: '  The Cross  of Jesus Christ ', ru: 'Крест Иисуса Христа' },
    summary: { en: 'x'.repeat(600), ru: 'Кратко.' },
    points: [
      { en: 'One', ru: 'Один' }, { en: '', ru: '' }, { en: 'Two', ru: 'Два' }, { en: '3', ru: '3' },
      { en: '4', ru: '4' }, { en: '5', ru: '5' }, { en: '6', ru: '6' }, { en: '7', ru: '7' }
    ],
    verses: [
      { book: 'Ephesians', chapter: 2, verseStart: 16 },
      { book: '1 Corinthians', chapter: 1, verseStart: 17, verseEnd: 18 },
      { book: 'Hezekiah', chapter: 1 },
      { book: 'John', chapter: 99 }
    ]
  }), LANES);
  assert.equal(notes.title.lang1, 'The Cross of Jesus Christ');
  assert.equal(notes.title.lang2, 'Крест Иисуса Христа');
  assert.ok(notes.summary.lang1.length <= 421 && notes.summary.lang1.endsWith('…'));
  assert.deepEqual(notes.points.map(point => point.lang1), ['One', 'Two', '3', '4', '5', '6']);
  assert.deepEqual(notes.verses, [
    { book: 49, chapter: 2, verseStart: 16, verseEnd: 0 },
    { book: 46, chapter: 1, verseStart: 17, verseEnd: 18 }
  ]);
});

// --- Bible text ---------------------------------------------------------------

function fakeBibleApi(chapters) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const match = /v2\/(\w+)\/(\d+)\/(\d+)\.json$/.exec(url) || /v2\/(\w+)\/books\.json$/.exec(url);
    const key = match && match[2] ? `${match[1]}/${match[2]}/${match[3]}` : `${match?.[1]}/books`;
    if (!(key in chapters)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => chapters[key] };
  };
  return { calls, fetchImpl };
}

function chapter(bookName, count, text = n => `Verse ${n}.`) {
  return { book_name: bookName, verses: Array.from({ length: count }, (_, i) => ({ verse: i + 1, text: ` ${text(i + 1)} ` })) };
}

test('verse text comes from the right Bible and chapter, and is cached', async () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'lt-bible-'));
  try {
    const api = fakeBibleApi({
      'kjv/19/23': chapter('Psalms', 6, n => (n === 1 ? 'The LORD is my shepherd; I shall not want.' : `Psalm 23 verse ${n}.`)),
      'synodal/19/22': chapter('Псалтирь', 6, n => (n === 1 ? 'Господь — Пастырь мой; я ни в чем не буду нуждаться:' : `Стих ${n}.`)),
      'synodal/books': { 19: { name: 'Псалтирь' } },
      'cornilescu/45/8': chapter('Romani', 39, n => `Versetul ${n} cu ş şi ţ.`),
      'cornilescu/books': { 45: { name: 'Romani' } }
    });
    const bible = createBibleLibrary({ cacheDir, fetchImpl: api.fetchImpl, logger: { warn() {} } });

    const english = await bible.lookupPassage(parseReference('Psalm 23:1'), 'en', 'kjv');
    assert.equal(english.label, 'Psalm 23:1');
    assert.equal(english.version, 'KJV');
    assert.deepEqual(english.verses, [{ n: 1, text: 'The LORD is my shepherd; I shall not want.' }]);

    const russian = await bible.lookupPassage(parseReference('Psalm 23:1'), 'ru');
    assert.equal(russian.label, 'Псалом 22:1');
    assert.match(russian.verses[0].text, /^Господь — Пастырь мой/);

    const romanian = await bible.lookupPassage(parseReference('Romans 8:28-29'), 'ro');
    assert.equal(romanian.label, 'Romani 8:28–29');
    assert.equal(romanian.verses[0].text, 'Versetul 28 cu ș și ț.', 'Romanian letters use commas, not cedillas');

    const callsBefore = api.calls.length;
    await bible.lookupPassage(parseReference('Psalm 23:2'), 'en', 'kjv');
    assert.equal(api.calls.length, callsBefore, 'second verse of a chapter needs no download');

    // A new library (next service) reads the chapter from disk.
    const offline = createBibleLibrary({ cacheDir, fetchImpl: async () => { throw new Error('offline'); }, logger: { warn() {} } });
    const cached = await offline.lookupPassage(parseReference('Psalm 23:1'), 'en', 'kjv');
    assert.equal(cached.verses.length, 1);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a chapter numbered differently, or no network, shows the reference without text', async () => {
  const api = fakeBibleApi({ 'kjv/19/51': chapter('Psalms', 21) });
  const bible = createBibleLibrary({ fetchImpl: api.fetchImpl, logger: { warn() {} } });
  const mismatch = await bible.lookupPassage(parseReference('Psalm 51:10'), 'en', 'kjv');
  assert.equal(mismatch.label, 'Psalm 51:10');
  assert.deepEqual(mismatch.verses, [], 'KJV Psalm 51 has 19 verses; a 21-verse chapter is another numbering');

  const missing = await bible.lookupPassage(parseReference('John 3:16'), 'en', 'kjv');
  assert.equal(missing.label, 'John 3:16');
  assert.deepEqual(missing.verses, []);

  const unknownLanguage = await bible.lookupPassage(parseReference('John 3:16'), 'hi');
  assert.equal(unknownLanguage.label, 'John 3:16');
  assert.deepEqual(unknownLanguage.verses, []);
});

test('with the verse service down, a chapter comes from a whole book kept on disk', async () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'lt-bible-'));
  try {
    const verses = Object.fromEntries(Array.from({ length: 39 }, (_, i) => [i + 1, `Versetul ${i + 1}.`]));
    mkdirSync(path.join(cacheDir, 'cornilescu'), { recursive: true });
    writeFileSync(path.join(cacheDir, 'cornilescu', 'book-45.json'), JSON.stringify({ chapters: { 8: verses } }));
    const calls = [];
    const bible = createBibleLibrary({ cacheDir, fetchImpl: async url => { calls.push(url); throw new Error('timeout'); }, logger: { warn() {} } });
    const passage = await bible.lookupPassage(parseReference('Romans 8:28'), 'ro');
    assert.deepEqual(passage.verses, [{ n: 28, text: 'Versetul 28.' }]);
    assert.ok(!calls.some(url => /\/45\/8\.json$/.test(url)), 'the chapter is not downloaded');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('long passages are shortened and marked', async () => {
  const api = fakeBibleApi({ 'kjv/42/15': chapter('Luke', 32, n => `${'word '.repeat(30)}${n}`) });
  const bible = createBibleLibrary({ fetchImpl: api.fetchImpl, logger: { warn() {} } });
  const passage = await bible.lookupPassage(parseReference('Luke 15:11-32'), 'en', 'kjv');
  assert.ok(passage.verses.length < 22);
  assert.equal(passage.truncated, true);
  assert.equal(passage.verses[0].n, 11);
});

// --- The engine -----------------------------------------------------------------

function fakeBible() {
  const lookups = [];
  return {
    lookups,
    async labelFor(ref, language) {
      return `${language}:${ref.book}.${ref.chapter}.${ref.verseStart}`;
    },
    async lookupPassage(ref, language) {
      lookups.push(`${language}:${ref.book}.${ref.chapter}.${ref.verseStart}`);
      return { label: `${language}:${ref.book}.${ref.chapter}.${ref.verseStart}`, version: 'TEST', verses: [{ n: ref.verseStart, text: 'Text.' }], truncated: false };
    }
  };
}

function geminiReply(json, { status = 200 } = {}) {
  return {
    ok: status === 200,
    status,
    json: async () => (status === 200 ? { candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] } : { error: { message: json } })
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function createEngine(t, options = {}) {
  let clock = 1_000_000;
  const messages = [];
  const bible = options.bible || fakeBible();
  const engine = createMessageNotes({
    broadcast: message => messages.push(message.state),
    readApiKey: async () => 'test-key',
    now: () => clock,
    bible,
    search: null,
    logger: { warn() {} },
    ...options
  });
  t.after(() => engine.dispose());
  engine.setLanguages({ targetLanguage1: 'en', targetLanguage2: 'ru' });
  return {
    engine,
    bible,
    messages,
    last: () => messages[messages.length - 1],
    advance(ms) {
      clock += ms;
      t.mock.timers.tick(ms);
    }
  };
}

test('a reference in the sermon puts the verse on every screen language for the set time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const run = createEngine(t);
  run.engine.addSource(' Și dacă ne vom uita la Efeseni 2 cu 16, spune crucea');
  await flush();
  await flush();
  const shown = run.last();
  assert.equal(shown.verse.key, '49.2.16.0');
  assert.equal(shown.verse.lanes.lang1.label, 'en:49.2.16');
  assert.equal(shown.verse.lanes.lang2.label, 'ru:49.2.16');
  assert.equal(shown.verse.remainingMs, 60_000);
  assert.deepEqual(shown.verses.map(item => item.key), ['49.2.16.0']);

  // The English translation of the same words a moment later keeps the card,
  // it does not show it again.
  run.advance(400);
  const before = run.bible.lookups.length;
  run.engine.addLane('lang1', ' look at Ephesians 2:16, it says the cross');
  await flush();
  assert.equal(run.bible.lookups.length, before);
  assert.equal(run.last().verse.remainingMs, 60_000, 'the timer restarts');

  run.advance(60_000);
  await flush();
  assert.equal(run.last().verse, null, 'hidden after a minute');
  assert.equal(run.last().verses.length, 1, 'still listed as read');
});

test('with verse pop-ups off, references are only listed; the operator can still show one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const run = createEngine(t);
  run.engine.applySettings({ verses: false });
  run.engine.addSource(' găsim de la Coloseni 1 cu 20 spune în felul următor');
  await flush();
  await flush();
  assert.equal(run.last().verse, null);
  assert.deepEqual(run.last().verses.map(item => item.key), ['51.1.20.0']);

  assert.equal(run.engine.command('show-verse', { reference: 'nonsense 99' }).length > 0, true);
  assert.equal(run.engine.command('show-verse', { reference: 'John 3:16' }), '');
  await flush();
  await flush();
  assert.equal(run.last().verse.key, '43.3.16.0');
  assert.equal(run.last().verse.origin, 'operator');

  run.engine.command('hide-verse');
  assert.equal(run.last().verse, null);
});

test('notes are written by Gemini for each screen language and the verses it names are listed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const requests = [];
  const run = createEngine(t, {
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return geminiReply({
        title: { en: 'The Cross of Jesus Christ', ru: 'Крест Иисуса Христа' },
        summary: { en: 'The cross reconciles us to God.', ru: 'Крест примиряет нас с Богом.' },
        points: [{ en: 'Boast only in the cross.', ru: 'Хвалиться только крестом.' }],
        verses: [{ book: 'Galatians', chapter: 6, verseStart: 14 }]
      });
    }
  });
  const sermon = 'Crucea lui Hristos ne împacă cu Dumnezeu și ne dă pace. '.repeat(14);
  run.engine.addSource(sermon);
  for (let i = 0; i < 6; i++) await flush();

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /models\/gemini-flash-latest:generateContent$/);
  assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  const state = run.last();
  assert.equal(state.status.state, 'ready');
  assert.equal(state.notes.title.lang1, 'The Cross of Jesus Christ');
  assert.equal(state.notes.title.lang2, 'Крест Иисуса Христа');
  assert.deepEqual(state.verses.map(item => item.key), ['48.6.14.0']);
  assert.equal(state.verse.key, '48.6.14.0', 'an unshown verse found by AI notes is also displayed on the verse card');

  // No new words: no new request.
  run.advance(120_000);
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(requests.length, 1);

  // A new preacher.
  run.engine.command('new-message');
  assert.equal(run.last().notes, null);
  assert.deepEqual(run.last().verses, []);
});

test('an older model without thinking levels, or a missing model, still produces notes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tried = [];
  const run = createEngine(t, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      tried.push(`${url.match(/models\/([^:]+)/)[1]}${body.generationConfig.thinkingConfig ? '+thinking' : ''}`);
      if (url.includes('gemini-flash-latest')) return geminiReply('models/gemini-flash-latest is not found', { status: 404 });
      if (body.generationConfig.thinkingConfig) return geminiReply('Thinking level is not supported for this model.', { status: 400 });
      return geminiReply({ title: { en: 'Grace', ru: 'Благодать' }, summary: { en: '', ru: '' }, points: [], verses: [] });
    }
  });
  run.engine.addSource('Harul lui Dumnezeu este de ajuns pentru noi toți. '.repeat(16));
  for (let i = 0; i < 8; i++) await flush();
  assert.deepEqual(tried, ['gemini-flash-latest+thinking', 'gemini-2.5-flash+thinking', 'gemini-2.5-flash']);
  assert.equal(run.last().notes.title.lang1, 'Grace');
});

test('a Gemini error is shown to the operator and retried later, not every second', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  const run = createEngine(t, {
    fetchImpl: async () => {
      calls += 1;
      return geminiReply('Quota exceeded', { status: 429 });
    }
  });
  run.engine.addSource('Cuvântul lui Dumnezeu este viu și lucrător în noi. '.repeat(16));
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(calls, 1);
  assert.equal(run.last().status.state, 'error');
  assert.match(run.last().status.detail, /Quota exceeded/);

  run.engine.addSource(' Amin.');
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(calls, 1, 'no retry within 30 s');
  assert.match(run.engine.command('update-now'), /a few seconds ago/);
});

test('settings are saved on the host and survive a restart', async t => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'lt-notes-'));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const first = createMessageNotes({ configDir, bible: fakeBible(), search: null, logger: { warn() {} } });
  await first.loaded;
  first.applySettings({ verseSeconds: 120, englishBible: 'web' });
  first.dispose();
  for (let i = 0; i < 20 && !readFileSync(path.join(configDir, 'message-notes.json'), { encoding: 'utf8', flag: 'a+' }).includes('web'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const second = createMessageNotes({ configDir, bible: fakeBible(), search: null, logger: { warn() {} } });
  await second.loaded;
  assert.equal(second.snapshot().settings.verseSeconds, 120);
  assert.equal(second.snapshot().settings.englishBible, 'web');
  second.dispose();
});

test('the spoken language is taken from most recent pieces, and adds Romanian verses and notes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const run = createEngine(t);
  // Google once labelled a lone "Amém" Portuguese.
  run.engine.addSource('Amém.', 'pt');
  for (let i = 0; i < 4; i++) run.engine.addSource(' Vă rog să ne ridicăm.', 'ro-RO');
  await flush();
  assert.deepEqual(run.last().source, { code: 'ro', name: 'Romanian' });

  run.engine.addSource(' Să citim din Efeseni 2 cu 16, spune', 'ro');
  await flush();
  await flush();
  const verse = run.last().verse;
  assert.equal(verse.lanes.src.label, 'ro:49.2.16', 'the Romanian Bible verse comes with every card');
  assert.equal(verse.lanes.lang1.label, 'en:49.2.16');
});

test('a verse said again during a reading of its range is not listed twice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const run = createEngine(t);
  run.engine.command('show-verse', { reference: '1 Corinthians 11:23-26' });
  await flush();
  await flush();
  run.engine.addSource(' 1 Corinteni 11 versetul 23, Apostolul Pavel spune', 'ro');
  await flush();
  await flush();
  assert.deepEqual(run.last().verses.map(item => item.key), ['46.11.23.26']);
});
