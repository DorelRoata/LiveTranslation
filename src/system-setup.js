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
  vi: 'Vietnamese',
  uk: 'Ukrainian',
  hu: 'Hungarian',
  bg: 'Bulgarian',
  sr: 'Serbian'
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

export function replaceLaneState(laneState = {}) {
  return {
    accumulatedText: typeof laneState.accumulatedText === 'string' ? laneState.accumulatedText : '',
    interimText: typeof laneState.interimText === 'string' ? laneState.interimText : ''
  };
}

export function applyRelaySnapshot(subtitleState = {}, snapshot = {}) {
  const next = { ...subtitleState };
  if (snapshot.lang1 && typeof snapshot.lang1 === 'object') {
    next.lang1 = replaceLaneState(snapshot.lang1);
  }
  if (snapshot.lang2 && typeof snapshot.lang2 === 'object') {
    next.lang2 = replaceLaneState(snapshot.lang2);
  }
  return next;
}

export function applyLaneUpdate(laneState = {}, text, isFinal) {
  const next = replaceLaneState(laneState);

  if (isFinal) {
    next.accumulatedText = appendFinalSubtitle(next.accumulatedText, text);
    next.interimText = '';
  } else {
    next.interimText = typeof text === 'string' ? text : '';
  }

  return next;
}

function captionWords(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function bareCaptionWord(word) {
  return String(word || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
}

// Incoming captions are short fragments. Append only words that are not already
// the end of the line, so a repeated or punctuated tail is not shown twice.
export function wordsToAppend(displayedText, incomingText) {
  const incomingWords = captionWords(incomingText);
  if (!incomingWords.length) return [];

  const shownBare = captionWords(displayedText).map(bareCaptionWord).filter(Boolean);
  const incomingBare = incomingWords.map(bareCaptionWord).filter(Boolean);
  if (incomingBare.length && shownBare.length >= incomingBare.length) {
    const tail = shownBare.slice(shownBare.length - incomingBare.length);
    const alreadyShown = tail.every((word, index) => word === incomingBare[index]);
    if (alreadyShown) return [];
  }

  const displayed = captionWords(displayedText).join(' ');
  const incoming = incomingWords.join(' ');
  if (displayed && incoming.startsWith(displayed)) {
    const extra = incoming.slice(displayed.length).trim();
    return extra ? extra.split(/\s+/) : [];
  }

  const shownWords = captionWords(displayedText).map(bareCaptionWord);
  let overlap = 0;
  const max = Math.min(shownWords.length, incomingBare.length);
  for (let size = max; size > 0; size -= 1) {
    const tail = shownWords.slice(shownWords.length - size);
    const head = incomingBare.slice(0, size);
    if (tail.every((word, index) => word && word === head[index])) {
      overlap = size;
      break;
    }
  }
  if (overlap > 0) return incomingWords.slice(overlap);

  return incomingWords;
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

// The unfinished text is Google's early guess. Only the finished phrase is shown,
// and that phrase is not combined with the guess.
export function finishedCaptionText(transcription, isInterim = false) {
  if (isInterim || !transcription || typeof transcription !== 'object') return '';
  if (transcription.finished !== true && transcription.final !== true) return '';
  return typeof transcription.text === 'string' ? transcription.text.trim() : '';
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
