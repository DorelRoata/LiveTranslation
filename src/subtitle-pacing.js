export const SUBTITLE_PACING_MODES = Object.freeze({
  SMOOTH: 'smooth',
  LIVE: 'live'
});

export const SMOOTH_START_BUFFER_MS = 200;
export const SMOOTH_MAX_LATENCY_MS = 1500;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizePacingMode(value) {
  return value === SUBTITLE_PACING_MODES.LIVE
    ? SUBTITLE_PACING_MODES.LIVE
    : SUBTITLE_PACING_MODES.SMOOTH;
}

// This is intentionally identical to the pre-Smooth pacing algorithm.
export function getLiveTickDelay(queueLength) {
  if (queueLength > 10) return 30;
  if (queueLength > 5) return 70;
  if (queueLength > 2) return 110;
  if (queueLength > 0) return 160;
  return 0;
}

export function getSmoothTargetDelay(queueLength, oldestWordAgeMs) {
  if (queueLength <= 0) return 0;
  if (oldestWordAgeMs >= SMOOTH_MAX_LATENCY_MS) return 45;

  const backlogPressure = Math.max(0, queueLength - 2) * 13;
  const agePressure = oldestWordAgeMs > 800
    ? ((oldestWordAgeMs - 800) / (SMOOTH_MAX_LATENCY_MS - 800)) * 60
    : 0;
  return clamp(185 - backlogPressure - agePressure, 45, 185);
}

export function easeTickDelay(previousDelay, targetDelay) {
  if (!previousDelay) return targetDelay;
  return previousDelay + ((targetDelay - previousDelay) * 0.25);
}

export function getSmoothBatchSize(queueLength) {
  if (queueLength >= 10) return 3;
  if (queueLength >= 5) return 2;
  return 1;
}

export function shouldEndSmoothBatch(word) {
  return /[,.?!;:]$/.test(word);
}

export function getPunctuationPause(lastWord, remainingQueueLength) {
  if (/[.?!]$/.test(lastWord)) return remainingQueueLength > 8 ? 100 : 280;
  if (/[,;:]$/.test(lastWord)) return remainingQueueLength > 8 ? 40 : 100;
  return 0;
}
