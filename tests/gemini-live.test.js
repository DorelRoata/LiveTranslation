import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGeminiAudioMessage,
  buildGeminiSetupMessage,
  canForwardGeminiAudio,
  GEMINI_LIVE_MODEL,
  inputTranscriptionConfig,
  shouldReconnectOnNetworkOnline,
  smoothTranslationLatency,
  transcriptionIsFinished
} from '../src/gemini-live.js';

test('Live Translate setup omits instructions and keeps transcription at setup top-level', () => {
  const message = buildGeminiSetupMessage({ targetLanguage: 'en', echoTargetLanguage: true });

  assert.equal(message.setup.model, GEMINI_LIVE_MODEL);
  assert.deepEqual(message.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.deepEqual(message.setup.generationConfig.translationConfig, {
    targetLanguageCode: 'en',
    echoTargetLanguage: true
  });
  assert.deepEqual(message.setup.inputAudioTranscription, {});
  assert.deepEqual(message.setup.outputAudioTranscription, {});
  assert.equal(message.setup.realtimeInputConfig.activityHandling, 'NO_INTERRUPTION');
  assert.equal(message.setup.realtimeInputConfig.automaticActivityDetection.disabled, false);
  assert.equal(message.setup.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity, 'START_SENSITIVITY_HIGH');
  assert.equal(message.setup.realtimeInputConfig.automaticActivityDetection.prefixPaddingMs, 300);
  assert.equal(message.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 300);
  assert.equal('systemInstruction' in message.setup, false);
  assert.equal('inputAudioTranscription' in message.setup.generationConfig, false);
  assert.equal('outputAudioTranscription' in message.setup.generationConfig, false);
});

test('a finished transcription closes the phrase, and quiet time does not raise the lag number', () => {
  assert.equal(transcriptionIsFinished({ finished: true }), true);
  assert.equal(transcriptionIsFinished({ final: true }), true);
  assert.equal(transcriptionIsFinished({ text: 'still speaking' }), false);
  assert.equal(transcriptionIsFinished(null), false);

  assert.equal(smoothTranslationLatency(0, 1000, 1600), 600);
  assert.equal(smoothTranslationLatency(600, 1000, 4500), 600);
  assert.equal(smoothTranslationLatency(600, 1000, 1050), 600);
});

test('Spoken language is sent as an input transcription hint, not a system instruction', () => {
  assert.deepEqual(inputTranscriptionConfig('ro'), { languageCodes: ['ro'] });
  assert.deepEqual(inputTranscriptionConfig('auto'), {});

  const message = buildGeminiSetupMessage({
    targetLanguage: 'en',
    sourceLanguage: 'ro',
    echoTargetLanguage: false
  });
  assert.deepEqual(message.setup.inputAudioTranscription, { languageCodes: ['ro'] });
  assert.equal(message.setup.generationConfig.translationConfig.targetLanguageCode, 'en');
});

test('maps short language codes to Live Translate BCP-47 values', () => {
  const portuguese = buildGeminiSetupMessage({ targetLanguage: 'pt', sourceLanguage: 'pt' });
  assert.equal(portuguese.setup.generationConfig.translationConfig.targetLanguageCode, 'pt-BR');
  assert.deepEqual(portuguese.setup.inputAudioTranscription, { languageCodes: ['pt-BR'] });
});

test('network online does not tear down healthy Gemini sockets', () => {
  assert.equal(shouldReconnectOnNetworkOnline({
    isRunning: true,
    reconnectPending: false,
    primaryReady: true,
    secondaryEnabled: true,
    secondaryReady: true
  }), false);
  assert.equal(shouldReconnectOnNetworkOnline({
    isRunning: true,
    reconnectPending: false,
    primaryReady: true,
    secondaryEnabled: false,
    secondaryReady: false
  }), false);
  assert.equal(shouldReconnectOnNetworkOnline({ isRunning: false, primaryReady: false }), false);
});

test('network online reconnects only when a Gemini socket is down or already recovering', () => {
  assert.equal(shouldReconnectOnNetworkOnline({
    isRunning: true,
    reconnectPending: true,
    primaryReady: true,
    secondaryEnabled: false,
    secondaryReady: false
  }), true);
  assert.equal(shouldReconnectOnNetworkOnline({
    isRunning: true,
    reconnectPending: false,
    primaryReady: false,
    secondaryEnabled: false,
    secondaryReady: false
  }), true);
  assert.equal(shouldReconnectOnNetworkOnline({
    isRunning: true,
    reconnectPending: false,
    primaryReady: true,
    secondaryEnabled: true,
    secondaryReady: false
  }), true);
});

test('dual-language audio waits until every enabled Gemini socket is ready', () => {
  assert.equal(canForwardGeminiAudio({
    primaryReady: true,
    secondaryEnabled: true,
    secondaryReady: false
  }), false);
  assert.equal(canForwardGeminiAudio({
    primaryReady: true,
    secondaryEnabled: true,
    secondaryReady: true
  }), true);
  assert.equal(canForwardGeminiAudio({
    primaryReady: true,
    secondaryEnabled: false,
    secondaryReady: false
  }), true);
  assert.equal(canForwardGeminiAudio({
    primaryReady: false,
    secondaryEnabled: false,
    secondaryReady: false
  }), false);
});

test('Live Translate audio uses realtimeInput.audio instead of deprecated mediaChunks', () => {
  const message = buildGeminiAudioMessage('abc123');
  assert.deepEqual(message, {
    realtimeInput: {
      audio: {
        mimeType: 'audio/pcm;rate=16000',
        data: 'abc123'
      }
    }
  });
  assert.equal('mediaChunks' in message.realtimeInput, false);
});
