import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemSetup, countWords, getLanguageName } from '../src/system-setup.js';

test('maps language codes to operator-facing names', () => {
  assert.equal(getLanguageName('en'), 'English');
  assert.equal(getLanguageName('zh-Hans'), 'Chinese (Simplified)');
  assert.equal(getLanguageName('none', 'Disabled'), 'Disabled');
});

test('setup payload is the source of truth for projector, OBS, and dashboard', () => {
  const setup = buildSystemSetup({
    targetLanguage1: 'en',
    targetLanguage2: 'ro',
    subtitlePacing: 'live',
    obsLanguage: 'lang1'
  });

  assert.equal(setup.isDual, true);
  assert.equal(setup.targetLanguageName1, 'English');
  assert.equal(setup.targetLanguageName2, 'Romanian');
  assert.equal(setup.subtitlePacing, 'live');
  assert.equal(setup.obsLanguage, 'lang1');
});

test('disabling language 2 clears dual layout for every client', () => {
  const setup = buildSystemSetup({
    targetLanguage1: 'en',
    targetLanguage2: 'none',
    isDual: true,
    obsLanguage: '2'
  });

  assert.equal(setup.isDual, false);
  assert.equal(setup.targetLanguage2, 'none');
  assert.equal(setup.targetLanguageName2, '');
  assert.equal(setup.obsLanguage, 'lang2');
});

test('counts words for the dashboard word counter', () => {
  assert.equal(countWords(' frați și surori.'), 3);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});
