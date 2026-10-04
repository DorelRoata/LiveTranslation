import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addedWordCount,
  applyLaneUpdate,
  applyRelaySnapshot,
  appendFinalSubtitle,
  buildSystemSetup,
  emptyLaneState,
  getLanguageName,
  laneDisplayText,
  finishedCaptionText,
  mergeIncomingTranscript,
  wordsToAppend
} from '../src/system-setup.js';

test('only the finished phrase is shown, without the early guess', () => {
  assert.equal(finishedCaptionText({ text: 'the one' }), '');
  assert.equal(finishedCaptionText({ text: 'who calls' }), '');
  assert.equal(finishedCaptionText({ text: 'you can\'t serve two masters', finished: true }), 'you can\'t serve two masters');
  assert.equal(finishedCaptionText({ text: 'you can\'t', final: true }), 'you can\'t');
  assert.equal(finishedCaptionText({ text: 'still guessing' }, true), '');
  assert.equal(finishedCaptionText({ finished: true }), '');
});

test('caption fragments append new words and drop a tail that is already on screen', () => {
  assert.deepEqual(wordsToAppend('the one', 'who calls'), ['who', 'calls']);
  assert.deepEqual(wordsToAppend('the one', 'one who calls'), ['who', 'calls']);
  assert.deepEqual(wordsToAppend('if he loses his soul', 'his soul.'), []);
  assert.deepEqual(wordsToAppend('the one who calls', 'the one who calls us'), ['us']);
  assert.deepEqual(wordsToAppend('', 'My dear ones'), ['My', 'dear', 'ones']);
});

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

test('interim subtitle updates replace the working phrase instead of concatenating', () => {
  let lane = applyLaneUpdate(undefined, 'Hello', false);
  lane = applyLaneUpdate(lane, 'Hello there', false);

  assert.equal(lane.accumulatedText, '');
  assert.equal(lane.interimText, 'Hello there');
  assert.equal(laneDisplayText(lane), 'Hello there');
});

test('counts only newly added words when Gemini repeats a growing snapshot', () => {
  assert.equal(mergeIncomingTranscript('Hello', 'Hello there'), 'Hello there');
  assert.equal(addedWordCount('Hello', 'Hello there'), 1);
  assert.equal(addedWordCount('Hello there', 'Hello there'), 0);
});

test('relay snapshot replaces projector lanes instead of appending to stale text', () => {
  const stale = {
    lang1: applyLaneUpdate(emptyLaneState(), 'Hello', true),
    lang2: emptyLaneState(),
    targetLanguage1: 'en'
  };
  const restored = applyRelaySnapshot(stale, {
    lang1: { accumulatedText: 'Hello there friends', interimText: 'amen' },
    lang2: { accumulatedText: 'Bună ziua', interimText: '' }
  });

  assert.equal(restored.lang1.accumulatedText, 'Hello there friends');
  assert.equal(restored.lang1.interimText, 'amen');
  assert.equal(restored.lang2.accumulatedText, 'Bună ziua');
  assert.equal(restored.targetLanguage1, 'en');
});

test('final subtitle updates append once and clear the interim phrase', () => {
  let lane = applyLaneUpdate(undefined, 'Hello there', false);
  lane = applyLaneUpdate(lane, 'Hello there', true);

  assert.equal(lane.accumulatedText, 'Hello there');
  assert.equal(lane.interimText, '');
  assert.equal(laneDisplayText(lane), 'Hello there');
  assert.equal(appendFinalSubtitle('Hello there', 'friends'), 'Hello there friends');
});
