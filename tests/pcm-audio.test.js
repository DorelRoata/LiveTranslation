import assert from 'node:assert/strict';
import test from 'node:test';
import {
  downsampleToRate,
  floatToPcm16,
  GEMINI_FRAME_SAMPLES,
  nextPlaybackTime,
  PcmAccumulator,
  peakAmplitude
} from '../src/pcm-audio.js';

test('leaves 16 kHz audio unchanged', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1]);
  const result = downsampleToRate(samples, 16000);
  assert.equal(result, samples);
});

test('downsamples 48 kHz audio so Gemini receives real-time 16 kHz', () => {
  const samples = new Float32Array(4800);
  for (let index = 0; index < samples.length; index++) samples[index] = index / samples.length;
  const result = downsampleToRate(samples, 48000, 16000);
  assert.equal(result.length, 1600);
  assert.ok(Math.abs(result[0] - samples[0]) < 0.001);
  assert.ok(result[result.length - 1] > 0.9);
});

test('converts float samples to 16-bit PCM', () => {
  const pcm = floatToPcm16(new Float32Array([0, 1, -1]));
  assert.equal(pcm[0], 0);
  assert.equal(pcm[1], 32767);
  assert.equal(pcm[2], -32768);
});

test('drops an oversized playback queue instead of letting delay grow', () => {
  assert.equal(nextPlaybackTime(10, 9), 10);
  assert.equal(nextPlaybackTime(10, 10.2), 10.2);
  assert.equal(nextPlaybackTime(10, 12), 10);
});

test('reports peak amplitude for the input meter', () => {
  assert.ok(Math.abs(peakAmplitude(new Float32Array([0.1, -0.4, 0.2])) - 0.4) < 1e-6);
});

test('accumulates short capture buffers into 100 ms Gemini frames', () => {
  const accumulator = new PcmAccumulator(GEMINI_FRAME_SAMPLES);
  const first = accumulator.push(new Float32Array(700));
  assert.equal(first.length, 0);
  const second = accumulator.push(new Float32Array(700));
  assert.equal(second.length, 0);
  const third = accumulator.push(new Float32Array(700));
  assert.equal(third.length, 1);
  assert.equal(third[0].length, 1600);
});
