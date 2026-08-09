export const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  ru: 'Russian',
  ro: 'Romanian',
  es: 'Spanish',
  fr: 'French',
  ja: 'Japanese',
  de: 'German',
  'zh-Hans': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese',
  pt: 'Portuguese',
  it: 'Italian',
  ko: 'Korean',
  pl: 'Polish',
  hi: 'Hindi',
  ar: 'Arabic',
  tr: 'Turkish',
  vi: 'Vietnamese'
});

export function buildTranslationInstruction(baseInstruction, ignoredInputLanguage) {
  const base = typeof baseInstruction === 'string' ? baseInstruction.trim() : '';
  if (!ignoredInputLanguage || ignoredInputLanguage === 'none') return base;

  const languageName = LANGUAGE_NAMES[ignoredInputLanguage] || ignoredInputLanguage;
  const filterInstruction = [
    'LANGUAGE FILTER — IMPORTANT:',
    `When the input speaker is speaking ${languageName} (${ignoredInputLanguage}), produce no translated audio and no output translation for that speech.`,
    'Remain silent; do not echo, paraphrase, summarize, or announce that the speech was skipped.',
    'Resume translation only when the input speech changes to a different language.'
  ].join(' ');

  return base ? `${base}\n\n${filterInstruction}` : filterInstruction;
}

export function shouldEchoTargetLanguage(requestedEcho, targetLanguage, ignoredInputLanguage) {
  return Boolean(requestedEcho) && targetLanguage !== ignoredInputLanguage;
}
