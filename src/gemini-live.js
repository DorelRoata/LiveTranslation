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
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          prefixPaddingMs: 300,
          silenceDurationMs: 300
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

export function shouldReconnectOnNetworkOnline({
  isRunning = false,
  reconnectPending = false,
  primaryReady = false,
  secondaryEnabled = false,
  secondaryReady = false
} = {}) {
  if (!isRunning) return false;
  if (reconnectPending) return true;
  if (!primaryReady) return true;
  if (secondaryEnabled && !secondaryReady) return true;
  return false;
}

export function transcriptionIsFinished(transcription) {
  return Boolean(transcription && (transcription.finished === true || transcription.final === true));
}

// Ignore a sample once the preacher has been quiet longer than the phrase
// itself. Otherwise a breath makes the on-screen lag climb for several seconds.
export function smoothTranslationLatency(previousMs = 0, lastLoudAt = 0, now = 0, quietHoldMs = 1500) {
  const previous = Number.isFinite(previousMs) ? previousMs : 0;
  if (!lastLoudAt || !now || now <= lastLoudAt) return previous;
  const sample = now - lastLoudAt;
  if (sample <= 80 || sample >= quietHoldMs) return previous;
  if (!previous) return sample;
  return Math.round(previous * 0.7 + sample * 0.3);
}

export function canForwardGeminiAudio({
  primaryReady = false,
  secondaryEnabled = false,
  secondaryReady = false
} = {}) {
  if (!primaryReady) return false;
  if (secondaryEnabled && !secondaryReady) return false;
  return true;
}
