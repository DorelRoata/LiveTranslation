import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyBiblicalGlossary } from '../src/glossary.js';

test('fixes a Bible book Google left as "the Romanians"', () => {
  assert.equal(applyBiblicalGlossary('Paul writes in the book of the romanians chapter 8.', 'en'), 'Paul writes in the book of Romans chapter 8.');
  assert.equal(applyBiblicalGlossary('We read the Romanians 8:28.', 'en'), 'We read Romans 8:28.');
  assert.equal(applyBiblicalGlossary('the book of facts, chapter 2', 'en'), 'the Book of Acts, chapter 2');
});

test('never changes ordinary English that contains a trigger word', () => {
  const ordinary = [
    'And we, the Romanians, came to this country.',
    'The Romanians in our church pray together.',
    'They were stuck in a rut.',
    'A blue tit sat on the branch.',
    'A sheet of mica.',
    'Amos and Daniel spoke.'
  ];
  for (const sentence of ordinary) assert.equal(applyBiblicalGlossary(sentence, 'en'), sentence);
});

test('maps untranslated Romanian book names only when a chapter follows', () => {
  assert.equal(applyBiblicalGlossary('Citim din Romani 8 și 1 Corinteni 13.', 'en'), 'Citim din Romans 8 și 1 Corinthians 13.');
  assert.equal(applyBiblicalGlossary('Matei capitolul 5', 'en'), 'Matthew capitolul 5');
  assert.equal(applyBiblicalGlossary('Țefania 1', 'en'), 'Zephaniah 1');
  assert.equal(applyBiblicalGlossary('the Romani people', 'en'), 'the Romani people');
});

test('corrects untranslated Romanian church terms, including accented ones', () => {
  const output = applyBiblicalGlossary('Domnul Isus Hristos ne dă mântuire și neprihănire prin Duhul Sfânt.', 'en');
  assert.ok(output.includes('Lord Jesus Christ'));
  assert.ok(output.includes('salvation'));
  assert.ok(output.includes('righteousness'));
  assert.ok(output.includes('Holy Spirit'));
  assert.equal(applyBiblicalGlossary('a call to pocăință', 'en'), 'a call to repentance');
  assert.equal(applyBiblicalGlossary('Împărăția lui Dumnezeu', 'en'), 'The Kingdom of God');
});

test('applies custom operator glossary replacements as whole words', () => {
  assert.equal(applyBiblicalGlossary('Fratele Dorel preaching today.', 'en', { 'Fratele Dorel': 'Brother Dorel' }), 'Brother Dorel preaching today.');
  assert.equal(applyBiblicalGlossary('Dorelia came.', 'en', { Dorel: 'Brother Dorel' }), 'Dorelia came.');
});

test('leaves other target languages alone', () => {
  assert.equal(applyBiblicalGlossary('Domnul Isus', 'ro'), 'Domnul Isus');
  assert.equal(applyBiblicalGlossary('Романи 8', 'ru'), 'Романи 8');
});

test('changes nothing in a real translated sermon', () => {
  const sermon = JSON.parse(readFileSync(new URL('./fixtures/sermon-2026-10-04-en.json', import.meta.url), 'utf8'));
  const changed = sermon.pieces.filter(piece => applyBiblicalGlossary(piece.text, 'en') !== piece.text);
  assert.deepEqual(changed, []);
});
