import { normalizeObsLanguage } from './obs-language.js';
import { normalizePacingMode } from './subtitle-pacing.js';

export const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  ru: 'Russian',
  ro: 'Romanian',
  es: 'Spanish',
  fr: 'French',
  ja: 'Japanese',
  de: 'German',
  'zh-hans': 'Chinese (Simplified)',
  'zh-hant': 'Chinese (Traditional)',
  pt: 'Portuguese',
  it: 'Italian',
  ko: 'Korean',
  pl: 'Polish',
  hi: 'Hindi',
  ar: 'Arabic',
  tr: 'Turkish',
  vi: 'Vietnamese'
});

export function getLanguageName(code, fallback = '') {
  if (!code || code === 'none') return fallback;
  return LANGUAGE_NAMES[String(code).toLowerCase()] || String(code).toUpperCase();
}

export function trimSubtitleHistory(text, maxLength = 800) {
  if (!text || text.length <= maxLength) return text || '';
  let next = text.substring(text.length - maxLength);
  const spaceIndex = next.indexOf(' ');
  if (spaceIndex !== -1) next = next.substring(spaceIndex + 1);
  return next;
}

export function appendFinalSubtitle(accumulatedText, text) {
  const trimmedText = typeof text === 'string' ? text.trim() : '';
  if (!trimmedText) return accumulatedText || '';

  let next = accumulatedText || '';
  const needsSpace = next.length > 0 &&
    !/[\s。？！.?!;；]/.test(next[next.length - 1]) &&
    !/^[。？！.?!;；\s]/.test(trimmedText);
  next = `${next}${needsSpace ? ' ' : ''}${trimmedText}`;
  return trimSubtitleHistory(next);
}

export function applyLaneUpdate(laneState = {}, text, isFinal) {
  const next = {
    accumulatedText: typeof laneState.accumulatedText === 'string' ? laneState.accumulatedText : '',
    interimText: typeof laneState.interimText === 'string' ? laneState.interimText : ''
  };

  if (isFinal) {
    next.accumulatedText = appendFinalSubtitle(next.accumulatedText, text);
    next.interimText = '';
  } else {
    next.interimText = typeof text === 'string' ? text : '';
  }

  return next;
}

export function laneDisplayText(laneState = {}) {
  const accumulated = typeof laneState.accumulatedText === 'string' ? laneState.accumulatedText : '';
  const interim = typeof laneState.interimText === 'string' ? laneState.interimText.trim() : '';
  if (!interim) return accumulated;
  if (!accumulated) return interim;
  const needsSpace = !/[\s。？！.?!;；]/.test(accumulated[accumulated.length - 1]);
  return `${accumulated}${needsSpace ? ' ' : ''}${interim}`;
}

export function emptyLaneState() {
  return { accumulatedText: '', interimText: '' };
}

export function countWords(text) {
  return typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

export function mergeIncomingTranscript(previous, incoming) {
  const prev = typeof previous === 'string' ? previous.trim() : '';
  const next = typeof incoming === 'string' ? incoming.trim() : '';
  if (!next) return prev;
  if (!prev) return next;
  if (next.startsWith(prev)) return next;
  if (prev.startsWith(next)) return prev;
  const needsSpace = !/[\s。？！.?!;；]$/.test(prev) && !/^[。？！.?!;；]/.test(next);
  return `${prev}${needsSpace ? ' ' : ''}${next}`;
}

export function addedWordCount(previous, next) {
  return Math.max(0, countWords(next) - countWords(previous));
}

export function buildSystemSetup(input = {}) {
  const targetLanguage1 = typeof input.targetLanguage1 === 'string' ? input.targetLanguage1 : '';
  const rawLanguage2 = typeof input.targetLanguage2 === 'string' ? input.targetLanguage2 : 'none';
  const isDual = rawLanguage2 !== '' && rawLanguage2 !== 'none';
  const targetLanguage2 = isDual ? rawLanguage2 : 'none';

  return {
    targetLanguage1,
    targetLanguage2,
    targetLanguageName1: getLanguageName(targetLanguage1, 'Language 1'),
    targetLanguageName2: isDual ? getLanguageName(targetLanguage2, 'Language 2') : '',
    subtitlePacing: normalizePacingMode(input.subtitlePacing),
    isDual,
    obsLanguage: normalizeObsLanguage(input.obsLanguage)
  };
}
