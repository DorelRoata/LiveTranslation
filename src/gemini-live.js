export const GEMINI_LIVE_MODEL = 'models/gemini-3.5-live-translate-preview';
export const GEMINI_AUDIO_MIME = 'audio/pcm;rate=16000';

export function normalizeSourceLanguage(code) {
  const value = String(code || '').trim();
  if (!value || value === 'auto' || value === 'none') return '';
  return value;
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
  return {
    setup: {
      model: GEMINI_LIVE_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: {
          targetLanguageCode: targetLanguage,
          echoTargetLanguage: Boolean(echoTargetLanguage)
        }
      },
      inputAudioTranscription: inputTranscriptionConfig(sourceLanguage),
      outputAudioTranscription: {}
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
