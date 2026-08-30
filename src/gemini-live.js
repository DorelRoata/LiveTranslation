export const GEMINI_LIVE_MODEL = 'models/gemini-3.5-live-translate-preview';
export const GEMINI_AUDIO_MIME = 'audio/pcm;rate=16000';

export function buildGeminiSetupMessage({ targetLanguage, echoTargetLanguage = false } = {}) {
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
      inputAudioTranscription: {},
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
