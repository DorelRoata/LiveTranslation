import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildReadingIndex, createReadingFollower, matchWords, verseAt } from '../src/bible-reading.js';
import { createMessageNotes } from '../server-message-notes.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/readings-2026-10-04.json', import.meta.url), 'utf8'));
const index = buildReadingIndex(fixture.bible);

test('words are compared without accents, punctuation or spelling differences', () => {
  assert.deepEqual(matchWords('Hristos m-a trimis, nu să botez'), ['hristos', 'm', 'a', 'trimis', 'nu', 'sa', 'botez']);
  assert.deepEqual(matchWords('păşuni când cînd ţie ție'), ['pasuni', 'cind', 'cind', 'tie', 'tie']);
  assert.deepEqual(matchWords('Iisus'), matchWords('Isus'));
});

test('the index finds the verse a few words come from', () => {
  const follower = createReadingFollower();
  follower.push('Zidește în mine o inimă curată, Dumnezeule');
  const [best] = follower.candidates(index);
  assert.deepEqual(verseAt(index, best.id), { book: 19, chapter: 51, verse: 10 });
});

// Runs the recorded pieces through the real notes engine and returns the
// verses the screens showed while following, in order.
async function replay(t, reading) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 1_000_000;
  const shown = [];
  const engine = createMessageNotes({
    now: () => clock,
    search: { get: () => index, dispose() {} },
    bible: {
      async labelFor(ref) {
        return `${ref.chapter}:${ref.verseStart}`;
      },
      async lookupPassage(ref) {
        return { label: `${ref.chapter}:${ref.verseStart}`, version: 'TEST', verses: [], truncated: false };
      }
    },
    broadcast: ({ state }) => {
      const label = state.verse?.following ? `${state.verse.ref.chapter}:${state.verse.ref.verseStart}` : '';
      if (label && shown[shown.length - 1] !== label) shown.push(label);
    },
    logger: { warn() {} }
  });
  t.after(() => engine.dispose());
  engine.setLanguages({ targetLanguage1: 'en', targetLanguage2: 'none' });
  let last = fixture.readings[0].pieces[0].t;
  for (const piece of reading.pieces) {
    clock += piece.t - last;
    t.mock.timers.tick(Math.max(0, piece.t - last));
    last = piece.t;
    engine.addSource(piece.text, piece.language);
    await new Promise(resolve => setImmediate(resolve));
  }
  return shown;
}

test('a reading announced by name is followed verse by verse (1 Corinthians 11:23-29)', async t => {
  const reading = fixture.readings.find(item => item.name.startsWith('1 Corinthians'));
  assert.deepEqual(await replay(t, reading), reading.expected);
});

test('a reading whose chapter was misheard is still followed (Mark 15 heard as "Marcu 13")', async t => {
  const reading = fixture.readings.find(item => item.name.startsWith('Mark'));
  assert.deepEqual(await replay(t, reading), reading.expected);
});

test('an unannounced reading is followed after it is confirmed, in order, across chapters (Psalms 50-51)', async t => {
  const reading = fixture.readings.find(item => item.name.startsWith('Psalms'));
  const shown = await replay(t, reading);
  const order = shown.map(label => {
    const [chapter, verse] = label.split(':').map(Number);
    return chapter * 1000 + verse;
  });
  assert.ok(shown.length >= 35, `followed ${shown.length} verses`);
  assert.ok(order.every((value, i) => i === 0 || value > order[i - 1]), `never went back: ${shown.join(' ')}`);
  assert.ok(order[0] <= 50_003, `started at ${shown[0]}`);
  assert.equal(shown[shown.length - 1], '51:19');
});

test('preaching that only mentions these chapters does not start a reading', async t => {
  const sermon = JSON.parse(readFileSync(new URL('./fixtures/sermon-2026-10-04-ro.json', import.meta.url), 'utf8'));
  const shown = await replay(t, { pieces: sermon.pieces.map(piece => ({ ...piece, language: 'ro' })) });
  assert.deepEqual(shown, []);
});
