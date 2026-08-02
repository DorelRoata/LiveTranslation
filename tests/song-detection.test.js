import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RollingAudioWindow,
  createSongGateState,
  getSongEvidence,
  updateSongGateState
} from '../src/song-detection.js';

function result(categories) {
  return [{ classifications: [{ categories }] }];
}

test('recognizes singing and music without treating dominant speech as a song', () => {
  const singing = getSongEvidence(result([
    { categoryName: 'Singing', score: 0.72 },
    { categoryName: 'Music', score: 0.68 }
  ]));
  assert.equal(singing.songLike, true);

  const speechOverMusic = getSongEvidence(result([
    { categoryName: 'Speech', score: 0.48 },
    { categoryName: 'Music', score: 0.52 }
  ]));
  assert.equal(speechOverMusic.songLike, false);
  assert.equal(speechOverMusic.speechLike, true);

  const unrelatedPopSound = getSongEvidence(result([
    { categoryName: 'Popping', score: 0.9 }
  ]));
  assert.equal(unrelatedPopSound.songLike, false);
});

test('requires sustained song evidence before pausing', () => {
  let state = createSongGateState();
  state = updateSongGateState(state, { songLike: true, speechLike: false });
  assert.equal(state.suppressed, false);
  state = updateSongGateState(state, { songLike: true, speechLike: false });
  assert.equal(state.suppressed, true);
});

test('requires sustained speech before resuming', () => {
  let state = { ...createSongGateState(), suppressed: true };
  for (let index = 0; index < 2; index++) {
    state = updateSongGateState(state, { songLike: false, speechLike: true });
    assert.equal(state.suppressed, true);
  }
  state = updateSongGateState(state, { songLike: false, speechLike: true });
  assert.equal(state.suppressed, false);
});

test('rolling window emits chronological overlapping audio windows', () => {
  const buffer = new RollingAudioWindow(6, 3);
  assert.equal(buffer.append(Float32Array.from([1, 2, 3])), null);
  assert.deepEqual(Array.from(buffer.append(Float32Array.from([4, 5, 6]))), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(buffer.append(Float32Array.from([7, 8, 9]))), [4, 5, 6, 7, 8, 9]);
});
