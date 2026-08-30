export const TARGET_CAPTURE_RATE = 16000;
export const TARGET_PLAYBACK_RATE = 24000;
export const MAX_PLAYBACK_AHEAD_SEC = 0.35;
export const GEMINI_FRAME_SAMPLES = 1600;

export class PcmAccumulator {
  constructor(targetSamples = GEMINI_FRAME_SAMPLES) {
    this.targetSamples = targetSamples;
    this.pending = [];
    this.pendingLength = 0;
  }

  push(samples) {
    if (!samples?.length) return [];
    this.pending.push(samples);
    this.pendingLength += samples.length;
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
  if (!Number.isFinite(now)) return 0;
  if (!Number.isFinite(queuedStart) || queuedStart < now) return now;
  if (queuedStart - now > maxAhead) return now;
  return queuedStart;
}
