import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBiblicalGlossary } from '../src/glossary.js';

test('corrects secular mistranslations like the romanians to Romans', () => {
  const input = 'Paul writes in the book of the romanians chapter 8.';
  const output = applyBiblicalGlossary(input, 'en');
  assert.equal(output, 'Paul writes in the book of Romans chapter 8.');
});

test('corrects Romanian theological terms to English church equivalents', () => {
  const input = 'Domnul Isus Hristos ne dă mântuire și neprihănire prin Duhul Sfânt.';
  const output = applyBiblicalGlossary(input, 'en');
  assert.ok(output.includes('Lord Jesus Christ'));
  assert.ok(output.includes('salvation'));
  assert.ok(output.includes('righteousness'));
  assert.ok(output.includes('Holy Spirit'));
});

test('maps Romanian book names followed by chapters to English books', () => {
  const input = 'Citim din Romani 8 și 1 Corinteni 13.';
  const output = applyBiblicalGlossary(input, 'en');
  assert.equal(output, 'Citim din Romans 8 și 1 Corinthians 13.');
});

test('applies custom operator glossary replacements', () => {
  const input = 'Fratele Dorel preaching today.';
  const custom = { 'Fratele Dorel': 'Brother Dorel' };
  const output = applyBiblicalGlossary(input, 'en', custom);
  assert.equal(output, 'Brother Dorel preaching today.');
});

test('ignores glossary if target language is not English and no custom glossary', () => {
  const input = 'Domnul Isus';
  const output = applyBiblicalGlossary(input, 'ro');
  assert.equal(output, 'Domnul Isus');
});
