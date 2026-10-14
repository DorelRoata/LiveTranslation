import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createReferenceTracker,
  findReferences,
  formatReference,
  makeReference,
  parseReference,
  referenceInScheme
} from '../src/bible-references.js';

function loadPieces(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).pieces;
}

const labels = text => findReferences(text).map(ref => formatReference(ref));

// Every reference the preacher gave in the recorded 15 minutes, in order.
const SERMON_REFERENCES = [
  '1 Corinthians 1:17', '1 Corinthians 1:17', 'Galatians 6:14', '1 John 2:1', '1 John 2:1',
  'Ephesians 2:16', 'Ephesians 2:16', 'Philippians 3:18', 'Colossians 1:20'
];

for (const [name, language] of [['sermon-2026-10-04-ro.json', 'Romanian'], ['sermon-2026-10-04-en.json', 'English']]) {
  test(`finds every reference in the recorded sermon (${language}), within a second or two, and nothing else`, () => {
    const pieces = loadPieces(name);
    let now = 0;
    const found = [];
    const tracker = createReferenceTracker({ now: () => now, onReference: ref => found.push({ label: formatReference(ref), at: now }) });
    let lastPush = 0;
    for (const piece of pieces) {
      // The server flushes 1.8 s after the last piece, as in a pause.
      if (lastPush && piece.t - lastPush >= 1800) {
        now = lastPush + 1800;
        tracker.flush();
      }
      now = piece.t;
      tracker.push(piece.text);
      lastPush = piece.t;
    }
    tracker.flush();
    assert.deepEqual(found.map(item => item.label), SERMON_REFERENCES);

    // Reported within about two seconds of the verse number ("2:16" + " and" waits for the next word).
    for (const item of found) {
      const verse = item.label.split(':')[1];
      const number = new RegExp(`(^|\\D)${verse}(\\D|$)`);
      const said = pieces.filter(piece => piece.t <= item.at && number.test(piece.text)).pop();
      assert.ok(said, `${item.label} was reported before its verse number was heard`);
      assert.ok(item.at - said.t <= 2500, `${item.label} took ${item.at - said.t} ms`);
    }
  });
}

test('reads the ways a preacher and Google say a reference', () => {
  assert.deepEqual(labels('Ioan 3 cu 16, Dumnezeu a iubit'), ['John 3:16']);
  assert.deepEqual(labels('Galateni 2 cu 20 și'), ['Galatians 2:20']);
  assert.deepEqual(labels('1 Corinteni, capitolul 1 de la versetul 17, doar'), ['1 Corinthians 1:17']);
  assert.deepEqual(labels('1 Ioan capitolul 2 și versetul 1.'), ['1 John 2:1']);
  assert.deepEqual(labels('John chapter 3, verse 16 says'), ['John 3:16']);
  assert.deepEqual(labels('Matthew 5 verses 3 to 12 the'), ['Matthew 5:3–12']);
  assert.deepEqual(labels('Luke 15:11-32 is'), ['Luke 15:11–32']);
  assert.deepEqual(labels('Fapte 2 de la 1 la 4 spune'), ['Acts 2:1–4']);
  assert.deepEqual(labels('Acts 2 from verse 1 to 4.'), ['Acts 2:1–4']);
  assert.deepEqual(labels('Psalmul 23 este'), ['Psalms 23']);
  assert.deepEqual(labels('Psalm 119:105 says'), ['Psalms 119:105']);
  assert.deepEqual(labels('Evrei 11 ne spune'), ['Hebrews 11']);
  assert.deepEqual(labels('First Corinthians 13 is the love chapter.'), ['1 Corinthians 13']);
  assert.deepEqual(labels('Întâi Corinteni 13 este'), ['1 Corinthians 13']);
  assert.deepEqual(labels('in Ţefania 3:17 spune'), ['Zephaniah 3:17']);
  assert.deepEqual(labels('in Tefania 3:17 spune'), ['Zephaniah 3:17']);
  assert.deepEqual(labels('Jude 24 and'), ['Jude 1:24']);
  // Google's occasional literal "2 with 16".
  assert.deepEqual(labels('Ephesians 2 with 16 tells us'), ['Ephesians 2:16']);
});

test('two references joined by "and" stay two references', () => {
  assert.deepEqual(labels('Romans 8:28 and 2 Corinthians 5:17 say'), ['Romans 8:28', '2 Corinthians 5:17']);
  assert.deepEqual(labels('Romans 8:28 and 29 say'), ['Romans 8:28–29']);
});

test('ordinary words and names are not references', () => {
  assert.deepEqual(labels('Mark 5 times we said it'), []);
  assert.deepEqual(labels('The apostle John said that'), []);
  assert.deepEqual(labels('we, the Romanians, came 3 times'), []);
  assert.deepEqual(labels('stuck in a rut for 2 years'), []);
  assert.deepEqual(labels('my job 3 days a week'), []);
  assert.deepEqual(labels('John 25 people came'), []);
  assert.deepEqual(labels('Romans 8 with 100 people'), []);
});

test('a reference split across pieces is reported once, complete', () => {
  const found = [];
  const tracker = createReferenceTracker({ onReference: ref => found.push(formatReference(ref)) });
  for (const piece of [' we read Romans 8', ',', ' verse', ' 28', ' says that', ' all things']) tracker.push(piece);
  assert.deepEqual(found, ['Romans 8:28']);

  const split = [];
  const another = createReferenceTracker({ onReference: ref => split.push(formatReference(ref)) });
  for (const piece of [' găsim de la 1', ' Corinteni 1 cu', ' 17. Vă rog']) another.push(piece);
  assert.deepEqual(split, ['1 Corinthians 1:17']);
});

test('"verse 28" after a chapter uses the book and chapter the preacher just gave', () => {
  assert.deepEqual(labels('Romans chapter 8. And in verse 28 he says'), ['Romans 8', 'Romans 8:28']);
  // "Ioan 3" alone is not shown (also a name), but it still sets the chapter.
  assert.deepEqual(labels('Ioan 3. Iar versetul 16 spune'), ['John 3:16']);
  let now = 0;
  const found = [];
  const tracker = createReferenceTracker({ now: () => now, onReference: ref => found.push(formatReference(ref)) });
  tracker.push('Romans chapter 8. Many things later. ');
  now = 10 * 60_000;
  tracker.push('In verse 28 of the song we sing');
  tracker.flush();
  assert.deepEqual(found, ['Romans 8'], 'context expires after a few minutes');
});

test('a reference at the very end waits for the next words, or a flush', () => {
  const found = [];
  const tracker = createReferenceTracker({ onReference: ref => found.push(formatReference(ref)) });
  tracker.push('the word in Galatians 6:');
  assert.deepEqual(found, []);
  tracker.push(' 14');
  assert.deepEqual(found, []);
  tracker.flush();
  assert.deepEqual(found, ['Galatians 6:14']);
});

test('typed references accept short forms and reject anything else', () => {
  const typed = input => (parseReference(input) ? formatReference(parseReference(input)) : null);
  assert.equal(typed('jn 3:16'), 'John 3:16');
  assert.equal(typed('Romans 8 28-30'), 'Romans 8:28–30');
  assert.equal(typed('psalmul 23'), 'Psalms 23');
  assert.equal(typed('1 cor 13'), '1 Corinthians 13');
  assert.equal(typed('Ps 23:1'), 'Psalms 23:1');
  assert.equal(typed('Rev 22'), 'Revelation 22');
  assert.equal(typed('Romani 8:28'), 'Romans 8:28');
  assert.equal(typed('John 25'), null);
  assert.equal(typed('Jude 1:26'), null);
  assert.equal(typed('hello'), null);
  assert.equal(typed('John 3:16 and more words'), null);
});

test('references are checked against the real chapter and verse counts', () => {
  assert.equal(makeReference(43, 22), null);
  assert.equal(makeReference(43, 3, 37), null);
  assert.deepEqual(makeReference(43, 3, 16, 99), { book: 43, chapter: 3, verseStart: 16, verseEnd: 36 });
  assert.deepEqual(makeReference(43, 3, 16, 10), { book: 43, chapter: 3, verseStart: 16, verseEnd: 0 });
});

test('Russian Synodal numbering finds the same words (Psalms shift, Romans 16 ending)', () => {
  const synodal = input => formatReference(referenceInScheme(parseReference(input), 'rso'));
  assert.equal(synodal('Psalm 23:1'), 'Psalms 22:1');
  assert.equal(synodal('Psalm 51:10'), 'Psalms 50:12');
  assert.equal(synodal('Psalm 90:1'), 'Psalms 89:2');
  assert.equal(synodal('Psalm 90:12'), 'Psalms 89:12');
  assert.equal(synodal('Psalm 91:1'), 'Psalms 90:1');
  assert.equal(synodal('Psalm 46:1'), 'Psalms 45:2');
  assert.equal(synodal('Psalm 10:1'), 'Psalms 9:22');
  assert.equal(synodal('Psalm 116:12'), 'Psalms 115:3');
  assert.equal(synodal('Psalm 147:12'), 'Psalms 147:1');
  assert.equal(synodal('Psalm 23'), 'Psalms 22');
  assert.equal(synodal('Psalm 51:10-12'), 'Psalms 50:12–14');
  assert.equal(synodal('Romans 16:25'), 'Romans 14:24');
  assert.equal(synodal('Joel 2:28'), 'Joel 2:28');
  assert.equal(synodal('Malachi 4:2'), 'Malachi 4:2');
  assert.equal(synodal('John 3:16'), 'John 3:16');

  const hebrewPsalms = input => formatReference(referenceInScheme(parseReference(input), 'org-psalms'));
  assert.equal(hebrewPsalms('Psalm 51:10'), 'Psalms 51:12');
  assert.equal(hebrewPsalms('Romans 8:28'), 'Romans 8:28');
});
