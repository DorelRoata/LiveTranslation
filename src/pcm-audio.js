export const TARGET_CAPTURE_RATE = 16000;
export const TARGET_PLAYBACK_RATE = 24000;
export const MAX_PLAYBACK_AHEAD_SEC = 0.85;
export const QUIET_FRAME_PEAK = 0.025;
export const GEMINI_FRAME_SAMPLES = 1600;

export class PcmAccumulator {
  constructor(targetSamples = GEMINI_FRAME_SAMPLES) {
    this.targetSamples = targetSamples;
    this.pending = [];
    this.pendingLength = 0;
  }

  push(samples) {
    if (!samples?.length) return [];
    const copy = samples instanceof Float32Array ? samples.slice() : Float32Array.from(samples);
    this.pending.push(copy);
    this.pendingLength += copy.length;
    const frames = [];
    while (this.pendingLength >= this.targetSamples) {
      frames.push(this.#take(this.targetSamples));
    }
    return frames;
  }

  reset() {
    this.pending = [];
    this.pendingLength = 0;
  }

  #take(count) {
    const out = new Float32Array(count);
    let filled = 0;
    while (filled < count && this.pending.length) {
      const next = this.pending[0];
      const need = count - filled;
      if (next.length <= need) {
        out.set(next, filled);
        filled += next.length;
        this.pending.shift();
      } else {
        out.set(next.subarray(0, need), filled);
        this.pending[0] = next.subarray(need);
        filled += need;
      }
    }
    this.pendingLength -= filled;
    return filled === count ? out : out.subarray(0, filled);
  }
}

export function downsampleToRate(float32, inputRate, outputRate = TARGET_CAPTURE_RATE) {
  if (!float32?.length) return float32 || new Float32Array(0);
  const sourceRate = Number(inputRate);
  if (!sourceRate || Math.abs(sourceRate - outputRate) < 1) return float32;

  const ratio = sourceRate / outputRate;
  const outLength = Math.max(1, Math.floor(float32.length / ratio));
  const out = new Float32Array(outLength);
  for (let index = 0; index < outLength; index++) {
    const sourceIndex = index * ratio;
    const left = Math.min(float32.length - 1, Math.floor(sourceIndex));
    const right = Math.min(float32.length - 1, left + 1);
    const fraction = sourceIndex - left;
    out[index] = float32[left] + ((float32[right] - float32[left]) * fraction);
  }
  return out;
}

export function floatToPcm16(float32) {
  const pcm16 = new Int16Array(float32.length);
  for (let index = 0; index < float32.length; index++) {
    const sample = Math.max(-1, Math.min(1, float32[index]));
    pcm16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
  }
  return pcm16;
}

export function peakAmplitude(float32) {
  let maxVal = 0;
  for (let index = 0; index < float32.length; index++) {
    const magnitude = Math.abs(float32[index]);
    if (magnitude > maxVal) maxVal = magnitude;
  }
  return maxVal;
}

export function nextPlaybackTime(now, queuedStart, maxAhead = MAX_PLAYBACK_AHEAD_SEC) {
  return schedulePlayback(now, queuedStart, 0, maxAhead).start;
}

export function schedulePlayback(now, queuedStart, duration = 0, maxAhead = MAX_PLAYBACK_AHEAD_SEC) {
  if (!Number.isFinite(now)) {
    return { play: false, start: 0, nextQueued: 0 };
  }
  const start = Number.isFinite(queuedStart) && queuedStart > now ? queuedStart : now;
  if (start - now > maxAhead) {
    return { play: false, start: now, nextQueued: now };
  }
  if (duration > 0 && start + duration - now > maxAhead) {
    return { play: false, start, nextQueued: start };
  }
  return { play: true, start, nextQueued: start + Math.max(0, duration) };
}

export function decodePcm16Base64(base64Data, remainder = new Uint8Array(0)) {
  const binary = typeof atob === 'function'
    ? atob(base64Data)
    : Buffer.from(base64Data, 'base64').toString('binary');
  const incoming = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    incoming[index] = binary.charCodeAt(index);
  }
  const combined = new Uint8Array(remainder.length + incoming.length);
  combined.set(remainder);
  combined.set(incoming, remainder.length);

  const evenLength = combined.length & ~1;
  const nextRemainder = combined.slice(evenLength);
  const sampleCount = evenLength / 2;
  const float32 = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) {
    const low = combined[index * 2];
    const high = combined[index * 2 + 1];
    let value = low | (high << 8);
    if (value >= 0x8000) value -= 0x10000;
    float32[index] = value / 32768;
  }
  return { float32, remainder: nextRemainder };
}

export class PreRollAudioBuffer {
  constructor(maxDurationSec = 1.5, sampleRate = TARGET_CAPTURE_RATE) {
    this.maxSamples = Math.round(maxDurationSec * sampleRate);
    this.buffer = [];
    this.totalSamples = 0;
  }

  push(samples) {
    if (!samples?.length) return;
    const copy = samples instanceof Float32Array ? samples.slice() : Float32Array.from(samples);
    this.buffer.push(copy);
    this.totalSamples += copy.length;

    while (this.buffer.length > 1 && this.totalSamples > this.maxSamples) {
      this.totalSamples -= this.buffer[0].length;
      this.buffer.shift();
    }
  }

  flush() {
    if (this.totalSamples === 0) return new Float32Array(0);
    const out = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.buffer) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.clear();
    return out;
  }

  clear() {
    this.buffer = [];
    this.totalSamples = 0;
  }
}
