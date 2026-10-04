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

function bareWords(text) {
  return captionWords(text).map(bareCaptionWord).filter(Boolean);
}

// A settled caption is either the whole line, or the next phrase to add.
// It does not rewrite earlier words because they share one common word.
export function resolveCaptionLine(currentText, incomingText) {
  const current = typeof currentText === 'string' ? currentText.trim() : '';
  const incoming = typeof incomingText === 'string' ? incomingText.trim() : '';
  if (!incoming) return current;
  if (!current) return incoming;

  const currentWords = bareWords(current);
  const incomingWords = bareWords(incoming);
  const currentJoined = currentWords.join(' ');
  const incomingJoined = incomingWords.join(' ');
  if (incomingJoined.startsWith(currentJoined) || incomingJoined.includes(currentJoined)) return incoming;
  if (currentJoined.startsWith(incomingJoined)) return current;

  let keep = 0;
  const limit = Math.min(currentWords.length, incomingWords.length);
  while (keep < limit && currentWords[keep] === incomingWords[keep]) keep += 1;
  if (keep >= 3 && incomingWords.length >= currentWords.length - 4) return incoming;

  if (currentWords.length >= incomingWords.length) {
    const tail = currentWords.slice(-incomingWords.length);
    if (incomingWords.every((word, index) => word === tail[index])) return current;
  }

  const phrase = captionWords(incoming).join(' ');
  return `${current} ${phrase}`;
}

export function applyLaneUpdate(laneState = {}, text) {
  const next = replaceLaneState(laneState);
  next.accumulatedText = trimSubtitleHistory(resolveCaptionLine(laneDisplayText(next), text));
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

function phraseWords(text) {
  return captionWords(text).map(bareCaptionWord).filter(Boolean);
}

function revisesPhrase(current, incoming) {
  const currentWords = phraseWords(current);
  const incomingWords = phraseWords(incoming);
  if (!currentWords.length || !incomingWords.length) return false;
  const currentJoined = currentWords.join(' ');
  const incomingJoined = incomingWords.join(' ');
  if (incomingJoined.startsWith(currentJoined) || currentJoined.startsWith(incomingJoined)) return true;
  if (incomingWords.every(word => currentWords.includes(word))) return true;

  const incomingContent = incomingWords.filter(word => word && !CAPTION_STOP_WORDS.has(word));
  if (incomingContent.length && incomingContent.every(word => currentWords.includes(word))) return true;

  if (incomingWords.some(word => {
    const stem = captionStem(word);
    return stem && currentWords.some(other => captionStem(other) === stem);
  })) return true;

  const max = Math.min(currentWords.length, incomingWords.length);
  for (let size = max; size >= 2; size -= 1) {
    const tail = currentWords.slice(-size);
    const head = incomingWords.slice(0, size);
    if (tail.every((word, index) => word === head[index])) return true;
  }

  return currentWords.length <= 5
    && incomingWords.length <= 5
    && currentWords[currentWords.length - 1] === incomingWords[incomingWords.length - 1];
}

function revisedPhrase(current, incoming) {
  const currentWords = phraseWords(current);
  const incomingWords = phraseWords(incoming);
  const currentJoined = currentWords.join(' ');
  const incomingJoined = incomingWords.join(' ');
  if (currentJoined.startsWith(incomingJoined)) return captionWords(current).join(' ');
  if (incomingWords.every(word => currentWords.includes(word))) return captionWords(current).join(' ');
  if (incomingJoined.startsWith(currentJoined)) return captionWords(incoming).join(' ');

  const currentTokens = captionWords(current);
  const incomingTokens = captionWords(incoming);
  const max = Math.min(currentWords.length, incomingWords.length);
  for (let size = max; size >= 2; size -= 1) {
    const tail = currentWords.slice(-size);
    const head = incomingWords.slice(0, size);
    if (tail.every((word, index) => word === head[index])) {
      return [...currentTokens.slice(0, currentTokens.length - size), ...incomingTokens].join(' ');
    }
  }
  return incomingTokens.join(' ');
}

function appendPhrase(current, phrase) {
  const line = typeof current === 'string' ? current.trim() : '';
  const next = captionWords(phrase).join(' ');
  if (!next) return line;
  if (!line) return next;
  const lineWords = captionWords(line);
  const nextWords = captionWords(next);
  const lineBare = lineWords.map(bareCaptionWord);
  const nextBare = nextWords.map(bareCaptionWord);
  if (lineBare.length >= nextBare.length) {
    const tail = lineBare.slice(-nextBare.length);
    if (nextBare.every((word, index) => word === tail[index])) return line;
  }
  if (lineBare.length && nextBare.length && lineBare[lineBare.length - 1] === nextBare[0]
    && CAPTION_STOP_WORDS.has(nextBare[0])) {
    return [...lineWords, ...nextWords.slice(1)].join(' ');
  }
  return `${line} ${next}`;
}

function replaceLastPhrase(line, lastPhrase, revised) {
  const current = typeof line === 'string' ? line.trim() : '';
  const lastWords = phraseWords(lastPhrase);
  const lineWords = captionWords(current);
  const lineBare = lineWords.map(bareCaptionWord);
  if (lastWords.length && lineBare.length >= lastWords.length) {
    const tail = lineBare.slice(-lastWords.length);
    if (lastWords.every((word, index) => word === tail[index])) {
      const kept = lineWords.slice(0, lineWords.length - lastWords.length);
      return [...kept, captionWords(revised).join(' ')].join(' ').replace(/\s+/g, ' ').trim();
    }
  }
  return appendPhrase(current, revised);
}

export function emptyCaptionState() {
  return { committed: '', lastPhrase: '', open: '' };
}

// Hold the latest wording. A correction replaces that wording. A different
// phrase publishes the held one. The first guess is not published beside it.
export function settleCaptionStep(state = {}, incomingText) {
  const committed = state.committed || '';
  const lastPhrase = state.lastPhrase || '';
  const open = typeof state.open === 'string' ? state.open : '';
  const incoming = typeof incomingText === 'string' ? incomingText.trim() : '';
  const quiet = { committed, lastPhrase, open, line: null, phrase: null, replaced: false };
  if (!incoming) return quiet;
  if (!open) return { ...quiet, open: incoming };

  if (revisesPhrase(open, incoming)) {
    return { ...quiet, open: revisedPhrase(open, incoming) };
  }

  if (lastPhrase && revisesPhrase(lastPhrase, incoming)) {
    const phrase = revisedPhrase(lastPhrase, incoming);
    const line = replaceLastPhrase(committed, lastPhrase, phrase);
    return { committed: line, lastPhrase: phrase, open, line, phrase, replaced: true };
  }

  const line = appendPhrase(committed, open);
  return { committed: line, lastPhrase: open, open: incoming, line, phrase: open, replaced: false };
}

export function flushCaption(state = {}) {
  const open = typeof state.open === 'string' ? state.open.trim() : '';
  if (!open) {
    return {
      committed: state.committed || '',
      lastPhrase: state.lastPhrase || '',
      open: '',
      line: null,
      phrase: null,
      replaced: false
    };
  }
  const line = appendPhrase(state.committed || '', open);
  return { committed: line, lastPhrase: open, open: '', line, phrase: open, replaced: false };
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
