import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGeminiAudioMessage,
  buildGeminiSetupMessage,
  GEMINI_LIVE_MODEL,
  inputTranscriptionConfig
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
  assert.equal('systemInstruction' in message.setup, false);
  assert.equal('inputAudioTranscription' in message.setup.generationConfig, false);
  assert.equal('outputAudioTranscription' in message.setup.generationConfig, false);
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
