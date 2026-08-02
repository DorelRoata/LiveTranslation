import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SMOOTH_START_BUFFER_MS,
  easeTickDelay,
  getLiveTickDelay,
  getPunctuationPause,
  getSmoothBatchSize,
  getSmoothTargetDelay,
  normalizePacingMode,
  shouldEndSmoothBatch
} from '../src/subtitle-pacing.js';

test('preserves the legacy Live pacing thresholds', () => {
  assert.equal(getLiveTickDelay(1), 160);
  assert.equal(getLiveTickDelay(3), 110);
  assert.equal(getLiveTickDelay(6), 70);
  assert.equal(getLiveTickDelay(11), 30);
});

test('uses a conservative 200 ms Smooth start buffer', () => {
  assert.equal(SMOOTH_START_BUFFER_MS, 200);
});

test('Smooth pacing accelerates continuously with backlog and age', () => {
  const light = getSmoothTargetDelay(2, 200);
  const backlog = getSmoothTargetDelay(7, 200);
  const aging = getSmoothTargetDelay(7, 1200);
  assert.ok(light > backlog);
  assert.ok(backlog > aging);
  assert.equal(getSmoothTargetDelay(3, 1500), 45);
  assert.ok(easeTickDelay(185, 45) < 185);
  assert.ok(easeTickDelay(185, 45) > 45);
});

test('Smooth pacing groups words only when a queue is available', () => {
  assert.equal(getSmoothBatchSize(2), 1);
  assert.equal(getSmoothBatchSize(5), 2);
  assert.equal(getSmoothBatchSize(10), 3);
});

test('Smooth batches stop at phrase punctuation', () => {
  assert.equal(shouldEndSmoothBatch('together.'), true);
  assert.equal(shouldEndSmoothBatch('however,'), true);
  assert.equal(shouldEndSmoothBatch('word'), false);
});

test('punctuation pauses shrink while catching up', () => {
  assert.equal(getPunctuationPause('together.', 2), 280);
  assert.equal(getPunctuationPause('together.', 12), 100);
  assert.equal(getPunctuationPause('however,', 2), 100);
  assert.equal(getPunctuationPause('word', 2), 0);
});

test('unknown pacing settings safely fall back to Smooth', () => {
  assert.equal(normalizePacingMode('live'), 'live');
  assert.equal(normalizePacingMode('unexpected'), 'smooth');
});
