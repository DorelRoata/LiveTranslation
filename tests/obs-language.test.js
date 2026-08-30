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

test('builds a stable OBS URL that does not change with language', () => {
  assert.equal(
    buildObsUrl('http://192.168.1.67:5174/'),
    'http://192.168.1.67:5174/?obs=true'
  );
  assert.equal(
    buildObsUrl('http://192.168.1.67:5174/?obs=true&lang=1'),
    'http://192.168.1.67:5174/?obs=true'
  );
});

test('keeps unrelated OBS URL parameters and still omits language', () => {
  assert.equal(
    buildObsUrl('http://localhost:5174/?source=browser'),
    'http://localhost:5174/?source=browser&obs=true'
  );
});
