import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSystemSetup,
  countWords,
  getLanguageName,
  normalizeSubtitleFont,
  normalizeSubtitleLineCount,
  normalizeSubtitleTextSize
} from '../src/system-setup.js';

test('maps language codes to operator-facing names', () => {
  assert.equal(getLanguageName('en'), 'English');
  assert.equal(getLanguageName('zh-Hans'), 'Chinese (Simplified)');
  assert.equal(getLanguageName('none', 'Disabled'), 'Disabled');
});

test('setup payload is the source of truth for projector, OBS, and dashboard', () => {
  const setup = buildSystemSetup({
    targetLanguage1: 'en',
    targetLanguage2: 'ro',
    subtitlePacing: 'live',
    obsLanguage: 'lang1'
  });

  assert.equal(setup.isDual, true);
  assert.equal(setup.targetLanguageName1, 'English');
  assert.equal(setup.targetLanguageName2, 'Romanian');
  assert.equal(setup.subtitlePacing, 'live');
  assert.equal(setup.obsLanguage, 'lang1');
  assert.equal(setup.subtitleLineCount, 3);
  assert.equal(setup.subtitleTextSize, 'lg');
  assert.equal(setup.subtitleFont, 'outfit');
});

test('subtitle line count, text size, and font keep valid values and normalize invalid ones', () => {
  for (const lines of [2, 3, 4, 5]) {
    assert.equal(normalizeSubtitleLineCount(lines), lines);
    assert.equal(buildSystemSetup({ subtitleLineCount: lines }).subtitleLineCount, lines);
  }
  for (const invalid of [1, 6, 0, null, 'abc']) {
    assert.equal(normalizeSubtitleLineCount(invalid), 3);
  }

  for (const size of ['sm', 'md', 'lg', 'xl', '2xl']) {
    assert.equal(normalizeSubtitleTextSize(size), size);
    assert.equal(buildSystemSetup({ subtitleTextSize: size }).subtitleTextSize, size);
  }
  for (const invalid of ['xs', '3xl', 'xxl', '', null]) {
    assert.equal(normalizeSubtitleTextSize(invalid), 'lg');
  }

  for (const font of ['outfit', 'arial', 'hyperlegible', 'condensed', 'sans', 'serif']) {
    assert.equal(normalizeSubtitleFont(font), font);
    assert.equal(buildSystemSetup({ subtitleFont: font }).subtitleFont, font);
  }
  for (const invalid of ['comic', '', null]) {
    assert.equal(normalizeSubtitleFont(invalid), 'outfit');
  }
});

test('disabling language 2 clears dual layout for every client', () => {
  const setup = buildSystemSetup({
    targetLanguage1: 'en',
    targetLanguage2: 'none',
    isDual: true,
    obsLanguage: '2'
  });

  assert.equal(setup.isDual, false);
  assert.equal(setup.targetLanguage2, 'none');
  assert.equal(setup.targetLanguageName2, '');
  assert.equal(setup.obsLanguage, 'lang2');
});

test('counts words for the dashboard word counter', () => {
  assert.equal(countWords(' frați și surori.'), 3);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});

test('dashboard and projector markup/CSS wire S-2XL text range, Arial font, and dual-language Bible sizing', async () => {
  const { readFileSync } = await import('node:fs');
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const subtitlesHtml = readFileSync(new URL('../subtitles.html', import.meta.url), 'utf8');

  for (const size of ['sm', 'md', 'lg', 'xl', '2xl']) {
    assert.match(indexHtml, new RegExp(`projector-size-btn[^>]*data-size="${size}"`));
    assert.match(indexHtml, new RegExp(`font-size-btn[^>]*data-size="${size}"`));
    assert.match(indexHtml, new RegExp(`<option value="${size}"`));
    assert.match(subtitlesHtml, new RegExp(`subtitle-size-btn[^>]*data-size="${size}"`));
    assert.match(subtitlesHtml, new RegExp(`body\\[data-subtitle-size="${size}"\\]`));
    assert.match(subtitlesHtml, new RegExp(`\\.message-panel\\[data-bible-size="${size}"\\],\\s*\\.verse-float\\[data-bible-size="${size}"\\]`));
  }

  // .verse-float must not reset --bible-scale after [data-bible-size] rules.
  const verseFloatBlock = subtitlesHtml.match(/\.verse-float\s*\{[^}]*\}/)?.[0] || '';
  assert.ok(verseFloatBlock.length > 0, '.verse-float rule exists');
  assert.doesNotMatch(verseFloatBlock, /--bible-scale\s*:/, '.verse-float must not override --bible-scale');

  assert.match(indexHtml, /<option value="arial">Arial<\/option>/);
  assert.match(subtitlesHtml, /<option value="arial">Arial<\/option>/);
  assert.match(subtitlesHtml, /body\[data-subtitle-font="arial"\]\s*\{[^}]*Arial/);
});
