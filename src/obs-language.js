const OBS_LANGUAGE_ALIASES = Object.freeze({
  both: 'both',
  '1': 'lang1',
  lang1: 'lang1',
  '2': 'lang2',
  lang2: 'lang2'
});

export function normalizeObsLanguage(value) {
  return OBS_LANGUAGE_ALIASES[String(value || '').toLowerCase()] || 'both';
}

export function obsLanguageToViewMode(value) {
  return normalizeObsLanguage(value);
}

export function buildObsUrl(baseUrl, language) {
  const url = new URL(baseUrl);
  const normalizedLanguage = normalizeObsLanguage(language);
  const languageQuery = normalizedLanguage === 'lang1'
    ? '1'
    : normalizedLanguage === 'lang2'
      ? '2'
      : 'both';

  url.searchParams.set('obs', 'true');
  url.searchParams.set('lang', languageQuery);
  return url.toString();
}
