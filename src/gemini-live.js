export const GEMINI_LIVE_MODEL = 'models/gemini-3.5-live-translate-preview';
export const GEMINI_AUDIO_MIME = 'audio/pcm;rate=16000';

const GEMINI_LANGUAGE_ALIASES = Object.freeze({
  pt: 'pt-BR',
  'pt-br': 'pt-BR',
  'pt-pt': 'pt-PT',
  'zh-hans': 'zh-Hans',
  'zh-hant': 'zh-Hant',
  no: 'nb'
});

export function toGeminiLanguageCode(code) {
  const value = String(code || '').trim();
  if (!value || value === 'auto' || value === 'none') return '';
  return GEMINI_LANGUAGE_ALIASES[value.toLowerCase()] || value;
}

export function normalizeSourceLanguage(code) {
  return toGeminiLanguageCode(code);
}

export function inputTranscriptionConfig(sourceLanguage) {
  const languageCode = normalizeSourceLanguage(sourceLanguage);
  return languageCode ? { languageCodes: [languageCode] } : {};
}

export function buildGeminiSetupMessage({
  targetLanguage,
  echoTargetLanguage = false,
  sourceLanguage = 'auto'
} = {}) {
  const targetLanguageCode = toGeminiLanguageCode(targetLanguage);
  return {
    setup: {
      model: GEMINI_LIVE_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: {
          targetLanguageCode,
          echoTargetLanguage: Boolean(echoTargetLanguage)
        }
      },
      inputAudioTranscription: inputTranscriptionConfig(sourceLanguage),
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          prefixPaddingMs: 20,
          silenceDurationMs: 800
        },
        activityHandling: 'NO_INTERRUPTION'
      }
    }
  };
}

export function buildGeminiAudioMessage(base64Pcm) {
  return {
    realtimeInput: {
      audio: {
        mimeType: GEMINI_AUDIO_MIME,
        data: base64Pcm
      }
    }
  };
}
