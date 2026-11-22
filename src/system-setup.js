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

export const SUBTITLE_LINE_COUNTS = Object.freeze([2, 3, 4, 5]);
export const SUBTITLE_TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl', '2xl']);
export const SUBTITLE_FONTS = Object.freeze(['outfit', 'arial', 'hyperlegible', 'condensed', 'sans', 'serif']);

export function normalizeSubtitleLineCount(value) {
  const count = Number(value);
  return SUBTITLE_LINE_COUNTS.includes(count) ? count : 3;
}

export function normalizeSubtitleTextSize(value) {
  return SUBTITLE_TEXT_SIZES.includes(value) ? value : 'lg';
}

export function normalizeSubtitleFont(value) {
  return SUBTITLE_FONTS.includes(value) ? value : 'outfit';
}

export function getLanguageName(code, fallback = '') {
  if (!code || code === 'none') return fallback;
  return LANGUAGE_NAMES[String(code).toLowerCase()] || String(code).toUpperCase();
}

export function countWords(text) {
  return typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean).length : 0;
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
    subtitleLineCount: normalizeSubtitleLineCount(input.subtitleLineCount),
    subtitleTextSize: normalizeSubtitleTextSize(input.subtitleTextSize),
    subtitleFont: normalizeSubtitleFont(input.subtitleFont),
    isDual,
    obsLanguage: normalizeObsLanguage(input.obsLanguage)
  };
}
