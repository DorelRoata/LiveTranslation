import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTranslationInstruction,
  shouldEchoTargetLanguage
} from '../src/translation-instructions.js';

test('preserves the operator instruction when no input language is ignored', () => {
  assert.equal(buildTranslationInstruction('Translate accurately.', 'none'), 'Translate accurately.');
});

test('adds a strict silence instruction for the selected input language', () => {
  const instruction = buildTranslationInstruction('Translate accurately.', 'en');
  assert.match(instruction, /^Translate accurately\./);
  assert.match(instruction, /English \(en\)/);
  assert.match(instruction, /produce no translated audio and no output translation/i);
  assert.match(instruction, /Resume translation only when.*different language/i);
});

test('can apply the language filter without a custom operator instruction', () => {
  const instruction = buildTranslationInstruction('', 'ro');
  assert.match(instruction, /^LANGUAGE FILTER/);
  assert.match(instruction, /Romanian \(ro\)/);
});

test('an ignored target language always overrides target-language echo', () => {
  assert.equal(shouldEchoTargetLanguage(true, 'en', 'en'), false);
  assert.equal(shouldEchoTargetLanguage(true, 'ru', 'en'), true);
  assert.equal(shouldEchoTargetLanguage(false, 'ru', 'en'), false);
});
