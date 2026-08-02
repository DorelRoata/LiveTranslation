export const SONG_DETECTION_SAMPLE_RATE = 16000;
export const SONG_DETECTION_WINDOW_SAMPLES = 15600;
export const SONG_DETECTION_HOP_SAMPLES = 8000;
export const SONG_WINDOWS_TO_PAUSE = 2;
export const SPEECH_WINDOWS_TO_RESUME = 3;

const VOCAL_MUSIC_LABEL = /\b(?:singing|choir|vocal music|chant|mantra|humming|yodeling|rapping)\b/i;
const MUSIC_LABEL = /\b(?:music|musical instrument|orchestra|guitar|piano|organ|keyboard|drum|violin|saxophone|flute|trumpet|harp|accordion|rock|pop|jazz|classical|folk|country|hip hop|reggae|blues)\b/i;
const SPEECH_LABEL = /\b(?:speech|conversation|narration|monologue|preaching|public speaking)\b/i;

function highestMatchingScore(categories, matcher) {
  let highest = 0;
  for (const category of categories) {
    const name = category.categoryName || category.displayName || '';
    if (matcher.test(name)) highest = Math.max(highest, Number(category.score) || 0);
  }
  return highest;
}

export function getSongEvidence(results) {
  const categories = (results || []).flatMap(result =>
    (result.classifications || []).flatMap(classification => classification.categories || [])
  );
  const vocalScore = highestMatchingScore(categories, VOCAL_MUSIC_LABEL);
  const musicScore = Math.max(vocalScore, highestMatchingScore(categories, MUSIC_LABEL));
  const speechScore = highestMatchingScore(categories, SPEECH_LABEL);
  const speechDominant = speechScore >= 0.35 && speechScore >= musicScore - 0.1;
  const songLike = vocalScore >= 0.18 || (musicScore >= 0.35 && !speechDominant);
  const speechLike = speechDominant || (speechScore >= 0.45 && musicScore < 0.25);

  return { musicScore, speechScore, vocalScore, songLike, speechLike };
}

export function createSongGateState() {
  return {
    suppressed: false,
    songWindows: 0,
    speechWindows: 0
  };
}

export function updateSongGateState(state, evidence) {
  const next = { ...state };

  if (!next.suppressed) {
    next.songWindows = evidence.songLike ? next.songWindows + 1 : 0;
    next.speechWindows = 0;
    if (next.songWindows >= SONG_WINDOWS_TO_PAUSE) {
      next.suppressed = true;
      next.songWindows = 0;
    }
    return next;
  }

  next.speechWindows = evidence.speechLike && !evidence.songLike
    ? next.speechWindows + 1
    : 0;
  next.songWindows = 0;
  if (next.speechWindows >= SPEECH_WINDOWS_TO_RESUME) {
    next.suppressed = false;
    next.speechWindows = 0;
  }
  return next;
}

export class RollingAudioWindow {
  constructor(windowSize = SONG_DETECTION_WINDOW_SAMPLES, hopSize = SONG_DETECTION_HOP_SAMPLES) {
    this.windowSize = windowSize;
    this.hopSize = hopSize;
    this.buffer = new Float32Array(windowSize);
    this.writeIndex = 0;
    this.sampleCount = 0;
    this.samplesSinceResult = 0;
  }

  reset() {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.sampleCount = 0;
    this.samplesSinceResult = 0;
  }

  append(samples) {
    let sourceOffset = 0;
    while (sourceOffset < samples.length) {
      const writable = Math.min(samples.length - sourceOffset, this.windowSize - this.writeIndex);
      this.buffer.set(samples.subarray(sourceOffset, sourceOffset + writable), this.writeIndex);
      this.writeIndex = (this.writeIndex + writable) % this.windowSize;
      sourceOffset += writable;
    }

    this.sampleCount = Math.min(this.windowSize, this.sampleCount + samples.length);
    this.samplesSinceResult += samples.length;
    if (this.sampleCount < this.windowSize || this.samplesSinceResult < this.hopSize) return null;
    this.samplesSinceResult = 0;

    const window = new Float32Array(this.windowSize);
    const tailLength = this.windowSize - this.writeIndex;
    window.set(this.buffer.subarray(this.writeIndex), 0);
    window.set(this.buffer.subarray(0, this.writeIndex), tailLength);
    return window;
  }
}
