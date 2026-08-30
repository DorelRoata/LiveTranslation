import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyLaneUpdate,
  appendFinalSubtitle,
  buildSystemSetup,
  getLanguageName,
  laneDisplayText
} from '../src/system-setup.js';

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

test('final subtitle updates append once and clear the interim phrase', () => {
  let lane = applyLaneUpdate(undefined, 'Hello there', false);
  lane = applyLaneUpdate(lane, 'Hello there', true);

  assert.equal(lane.accumulatedText, 'Hello there');
  assert.equal(lane.interimText, '');
  assert.equal(laneDisplayText(lane), 'Hello there');
  assert.equal(appendFinalSubtitle('Hello there', 'friends'), 'Hello there friends');
});
