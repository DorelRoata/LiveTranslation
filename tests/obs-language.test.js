import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildObsUrl,
  normalizeObsLanguage,
  obsLanguageToViewMode
} from '../src/obs-language.js';

test('normalizes OBS language choices and safe defaults', () => {
  assert.equal(normalizeObsLanguage('1'), 'lang1');
  assert.equal(normalizeObsLanguage('lang2'), 'lang2');
  assert.equal(normalizeObsLanguage('unexpected'), 'both');
  assert.equal(obsLanguageToViewMode('2'), 'lang2');
});

test('builds an OBS URL for both languages', () => {
  assert.equal(
    buildObsUrl('http://192.168.1.67:5174/', 'both'),
    'http://192.168.1.67:5174/?obs=true&lang=both'
  );
});

test('builds single-language OBS URLs without discarding existing parameters', () => {
  assert.equal(
    buildObsUrl('http://localhost:5174/?source=browser', 'lang1'),
    'http://localhost:5174/?source=browser&obs=true&lang=1'
  );
  assert.equal(
    buildObsUrl('http://localhost:5174/', 'lang2'),
    'http://localhost:5174/?obs=true&lang=2'
  );
});
