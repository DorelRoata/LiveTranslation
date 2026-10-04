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
  captionSync,
  dedupeCaptionLine,
  laneDisplayText,
  resolveCaptionLine,
  emptyCaptionState,
  flushCaption,
  mergeCaptionLine,
  mergeIncomingTranscript,
  outputCaptionUpdate,
  settleCaptionStep,
  wordsToAppend
} from '../src/system-setup.js';

test('output transcription text is shown even when Google omits the finished flag', () => {
  assert.deepEqual(outputCaptionUpdate({ text: ' We know who', languageCode: 'en' }), {
    text: 'We know who',
    isFinal: false
  });
  assert.deepEqual(outputCaptionUpdate({ text: 'very well.', finished: true }), {
    text: 'very well.',
    isFinal: true
  });
  assert.deepEqual(outputCaptionUpdate({ text: 'you can\'t', final: true }), {
    text: 'you can\'t',
    isFinal: true
  });
  assert.equal(outputCaptionUpdate({ text: 'guess' }, true), null);
  assert.equal(outputCaptionUpdate({ languageCode: 'en' }), null);
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

test('a word already on the line cannot be painted again', () => {
  assert.equal(dedupeCaptionLine('very well we know who We know very well'), 'very well we know who');
  assert.equal(dedupeCaptionLine('the the adversaries'), 'the adversaries');
  assert.equal(dedupeCaptionLine('of the enemies of ours'), 'of the enemies of ours');
  const screen = resolveCaptionLine(
    'very well we know who the adversaries',
    'very well we know who the adversaries We know very well'
  );
  assert.equal((screen.match(/\bknow\b/gi) || []).length, 1);
  assert.equal((screen.match(/\bwell\b/gi) || []).length, 1);
  assert.equal((screen.match(/\bvery\b/gi) || []).length, 1);
});

test('live phrases keep the corrected wording and do not drop the next sentence', () => {
  const incoming = [
    'very well.',
    'We know who',
    'the enemy is,',
    'we know who the',
    'adversary is,',
    'the adversaries',
    'and so on, right?',
    'We know very well',
    'with everyone.',
    'But',
    'I liked',
    'something that says',
    'that',
    'Time is one',
    'of the enemies',
    "of ours. It's"
  ];
  let state = emptyCaptionState();
  const lines = [];
  for (const text of incoming) {
    state = settleCaptionStep(state, text);
    if (state.line) lines.push(state.line);
  }
  state = flushCaption(state);
  if (state.line) lines.push(state.line);

  const screen = lines[lines.length - 1];
  assert.equal((screen.match(/\bwell\b/gi) || []).length, 1);
  assert.equal((screen.match(/\bknow\b/gi) || []).length, 1);
  assert.match(screen, /we know who the/);
  assert.match(screen, /adversar/i);
  assert.doesNotMatch(screen, /enemy is/);
  assert.match(screen, /and so on, right\?/);
  assert.match(screen, /something that says/);
  assert.match(screen, /of the enemies/);
  assert.match(screen, /of ours/);
  assert.equal(screen, applyLaneUpdate(undefined, screen, true).accumulatedText);
});

test('a restated phrase replaces the old wording instead of doubling it', () => {
  assert.equal(mergeCaptionLine('We know who', 'we know who the'), 'we know who the');
  assert.equal(mergeCaptionLine('We know who the enemy is', 'adversary is'), 'We know who the adversary is');
  assert.equal(mergeCaptionLine('We know who the enemy is', 'the adversaries'), 'We know who the adversaries');
  assert.equal(mergeCaptionLine('very well.', 'We know who'), 'very well. We know who');
  assert.equal(mergeCaptionLine('if he loses his soul', 'his soul.'), 'if he loses his soul');
  assert.equal(mergeCaptionLine('the one who calls', 'the one who calls us'), 'the one who calls us');

  let state = settleCaptionStep(emptyCaptionState(), 'the enemy is');
  state = settleCaptionStep(state, 'adversary is');
  state = flushCaption(state);
  assert.equal(state.line, 'adversary is');
  assert.equal(applyLaneUpdate(undefined, state.line, true).accumulatedText, 'adversary is');
});

test('the screen keeps the shared opening and replaces only the corrected tail', () => {
  assert.deepEqual(
    captionSync('We know who the enemy is', 'We know who the adversaries'),
    { keep: 4, words: ['adversaries'] }
  );
  assert.deepEqual(
    captionSync('We know who', 'We know who the'),
    { keep: 3, words: ['the'] }
  );
});

test('interim subtitle updates replace the working phrase instead of concatenating', () => {
  let lane = applyLaneUpdate(undefined, 'Hello', false);
  lane = applyLaneUpdate(lane, 'Hello there', false);

  assert.equal(lane.accumulatedText, 'Hello there');
  assert.equal(lane.interimText, '');
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
