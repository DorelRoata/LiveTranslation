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

export function applyLaneUpdate(laneState = {}, text) {
  const next = replaceLaneState(laneState);
  const merged = mergeCaptionLine(laneDisplayText(next), text);
  next.accumulatedText = trimSubtitleHistory(merged);
  next.interimText = '';
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

const CAPTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'or', 'to', 'in', 'on', 'is', 'it', 'its',
  'that', 'this', 'we', 'who', 'our', 'ours', 'for', 'with'
]);

function sameCaptionWord(left, right) {
  return Boolean(left) && left === right;
}

function captionStem(word) {
  if (!word || word.length < 6 || CAPTION_STOP_WORDS.has(word)) return '';
  return word.slice(0, 5);
}

// Google restates a phrase instead of extending it. Keep the line and replace
// the restated words so the correction does not sit beside the old wording.
export function mergeCaptionLine(previous, incoming) {
  const prev = typeof previous === 'string' ? previous.trim() : '';
  const next = typeof incoming === 'string' ? incoming.trim() : '';
  if (!next) return prev;
  if (!prev) return next;

  const prevWords = captionWords(prev);
  const nextWords = captionWords(next);
  const prevBare = prevWords.map(bareCaptionWord);
  const nextBare = nextWords.map(bareCaptionWord);
  const prevJoined = prevBare.join(' ');
  const nextJoined = nextBare.join(' ');

  if (prevBare.length >= nextBare.length) {
    const tail = prevBare.slice(-nextBare.length);
    if (nextBare.every((word, index) => sameCaptionWord(word, tail[index]))) return prev;
  }

  if (nextJoined.startsWith(prevJoined)) return nextWords.join(' ');

  let overlap = 0;
  const maxOverlap = Math.min(prevBare.length, nextBare.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const tail = prevBare.slice(-size);
    const head = nextBare.slice(0, size);
    if (tail.every((word, index) => sameCaptionWord(word, head[index]))) {
      overlap = size;
      break;
    }
  }
  if (overlap > 0) {
    return [...prevWords.slice(0, prevWords.length - overlap), ...nextWords].join(' ');
  }

  const windowStart = Math.max(0, prevBare.length - Math.max(nextBare.length + 3, 8));
  let best = null;
  for (let index = windowStart; index < prevBare.length; index += 1) {
    for (let incomingIndex = 0; incomingIndex < nextBare.length; incomingIndex += 1) {
      if (!sameCaptionWord(prevBare[index], nextBare[incomingIndex])) continue;
      let length = 0;
      while (
        index + length < prevBare.length &&
        incomingIndex + length < nextBare.length &&
        sameCaptionWord(prevBare[index + length], nextBare[incomingIndex + length])
      ) {
        length += 1;
      }
      const contentMatches = nextBare
        .slice(incomingIndex, incomingIndex + length)
        .filter(word => word && !CAPTION_STOP_WORDS.has(word)).length;
      if (length >= 2 || contentMatches >= 1) {
        if (!best || length > best.length || (length === best.length && index > best.index)) {
          best = { index, length };
        }
      }
    }
  }

  if (!best) {
    for (let incomingIndex = 0; incomingIndex < nextBare.length; incomingIndex += 1) {
      const stem = captionStem(nextBare[incomingIndex]);
      if (!stem) continue;
      for (let index = windowStart; index < prevBare.length; index += 1) {
        if (captionStem(prevBare[index]) === stem) {
          best = { index, length: 1 };
          break;
        }
      }
      if (best) break;
    }
  }

  if (best) return [...prevWords.slice(0, best.index), ...nextWords].join(' ');

  const span = Math.min(prevWords.length, Math.max(nextWords.length, 1) + 1);
  const region = prevBare.slice(-span);
  const shareFirst = sameCaptionWord(region[0], nextBare[0]);
  const shareLast = sameCaptionWord(prevBare[prevBare.length - 1], nextBare[nextBare.length - 1]);
  const shareContent = nextBare.some(word => word && !CAPTION_STOP_WORDS.has(word) && region.includes(word));
  const shareStem = nextBare.some(word => {
    const stem = captionStem(word);
    return stem && region.some(other => captionStem(other) === stem);
  });
  if (nextWords.length <= 8 && (shareFirst || shareLast || shareContent || shareStem)) {
    const cutLength = shareLast && !shareFirst && !shareContent && !shareStem
      ? nextWords.length
      : span;
    return [...prevWords.slice(0, Math.max(0, prevWords.length - cutLength)), ...nextWords].join(' ');
  }

  const needsSpace = !/\s$/.test(prev);
  return `${prev}${needsSpace ? ' ' : ''}${nextWords.join(' ')}`;
}

export function captionSync(currentText, targetText) {
  const current = captionWords(currentText);
  const target = captionWords(targetText);
  const currentBare = current.map(bareCaptionWord);
  const targetBare = target.map(bareCaptionWord);
  let keep = 0;
  const limit = Math.min(currentBare.length, targetBare.length);
  while (keep < limit && sameCaptionWord(currentBare[keep], targetBare[keep])) keep += 1;
  return { keep, words: target.slice(keep) };
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

// Live Translate sends outputTranscription with text and languageCode only.
// A finished flag is not included on those phrases, so the text itself is the caption.
export function outputCaptionUpdate(transcription, isInterim = false) {
  if (isInterim || !transcription || typeof transcription !== 'object') return null;
  const text = typeof transcription.text === 'string' ? transcription.text.trim() : '';
  if (!text) return null;
  return {
    text,
    isFinal: transcription.finished === true || transcription.final === true
  };
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
