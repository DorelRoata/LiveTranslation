import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePcm16Base64,
  downsampleToRate,
  floatToPcm16,
  GEMINI_FRAME_SAMPLES,
  nextPlaybackTime,
  PcmAccumulator,
  peakAmplitude,
  PreRollAudioBuffer,
  schedulePlayback
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
  assert.equal(schedulePlayback(10, 12, 0.02).play, false);
  assert.equal(schedulePlayback(10, 12, 0.02).nextQueued, 10);
});

test('does not overlap already-scheduled audio when a lag burst would exceed the live window', () => {
  const first = schedulePlayback(10, 10, 0.4);
  assert.equal(first.play, true);
  assert.equal(first.nextQueued, 10.4);
  const rest = schedulePlayback(10, first.nextQueued, 0.4);
  assert.equal(rest.play, true);
  const overflow = schedulePlayback(10, rest.nextQueued, 0.2);
  assert.equal(overflow.play, false);
  assert.equal(overflow.nextQueued, rest.nextQueued);
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

test('copies capture buffers so ScriptProcessor reuse cannot corrupt Gemini audio', () => {
  const accumulator = new PcmAccumulator(4);
  const reused = new Float32Array([1, 2, 3]);
  accumulator.push(reused);
  reused[0] = 9;
  reused[1] = 9;
  reused[2] = 9;
  const frames = accumulator.push(new Float32Array([4]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], 1);
  assert.equal(frames[0][3], 4);
});

test('reassembles 16-bit PCM when a base64 chunk splits a sample on an odd byte', () => {
  // Sample 1: 0x1234 (little-endian: 0x34, 0x12)
  // Sample 2: 0x5678 (little-endian: 0x78, 0x56)
  // Chunk 1 has 3 bytes: [0x34, 0x12, 0x78] -> odd byte remainder [0x78]
  // Chunk 2 has 1 byte:  [0x56]             -> combined with remainder -> [0x78, 0x56]
  const chunk1Base64 = Buffer.from([0x34, 0x12, 0x78]).toString('base64');
  const chunk2Base64 = Buffer.from([0x56]).toString('base64');

  const first = decodePcm16Base64(chunk1Base64);
  assert.equal(first.float32.length, 1);
  assert.equal(first.remainder.length, 1);
  assert.equal(first.remainder[0], 0x78);
  assert.ok(Math.abs(first.float32[0] - (0x1234 / 32768)) < 1e-4);

  const second = decodePcm16Base64(chunk2Base64, first.remainder);
  assert.equal(second.float32.length, 1);
  assert.equal(second.remainder.length, 0);
  assert.ok(Math.abs(second.float32[0] - (0x5678 / 32768)) < 1e-4);
});

test('PreRollAudioBuffer retains up to target duration and flushes on demand', () => {
  const preRoll = new PreRollAudioBuffer(0.1, 1000); // 100 samples max
  preRoll.push(new Float32Array([1, 2, 3]));
  preRoll.push(new Float32Array([4, 5, 6]));
  assert.equal(preRoll.totalSamples, 6);

  const flushed = preRoll.flush();
  assert.deepEqual(Array.from(flushed), [1, 2, 3, 4, 5, 6]);
  assert.equal(preRoll.totalSamples, 0);

  // Test buffer capping
  const large1 = new Float32Array(60).fill(1);
  const large2 = new Float32Array(60).fill(2);
  preRoll.push(large1);
  preRoll.push(large2); // 120 samples total, exceeds 100 -> large1 is shifted out
  assert.equal(preRoll.totalSamples, 60);
  const flushed2 = preRoll.flush();
  assert.equal(flushed2.length, 60);
  assert.equal(flushed2[0], 2);
});
