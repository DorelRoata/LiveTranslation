import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  appendLaneText,
  emptyLaneState,
  endsSentence,
  laneUpdatePlan,
  MAX_LANE_CHARS,
  pieceToAppend,
  splitWords
} from '../src/caption-stream.js';

const sermon = JSON.parse(readFileSync(new URL('./fixtures/sermon-2026-10-04-en.json', import.meta.url), 'utf8'));

// The dashboard side of src/main.js: each Google piece becomes one addition.
function dashboardAdditions(pieces) {
  let lane = emptyLaneState();
  let lastSession = 0;
  const additions = [];
  const skipped = [];
  for (const piece of pieces) {
    const sessionStart = piece.session !== lastSession;
    const resumed = sessionStart && lastSession !== 0;
    lastSession = piece.session;
    const addition = pieceToAppend(lane.text, piece.text, { sessionStart, resumed });
    if (!addition) {
      skipped.push(piece);
      continue;
    }
    lane = appendLaneText(lane, addition);
    additions.push(addition);
  }
  return { lane, additions, skipped };
}

// The relay and a projector that is watching live.
function relayAndProjector(additions) {
  let relayLane = emptyLaneState();
  let shownSeq = 0;
  const painted = [];
  const modes = new Set();
  for (const addition of additions) {
    relayLane = appendLaneText(relayLane, addition);
    const plan = laneUpdatePlan(shownSeq, relayLane, addition);
    modes.add(plan.mode);
    painted.push(...plan.words);
    shownSeq = plan.seq;
  }
  return { relayLane, painted, modes };
}

test('a recorded 15-minute sermon reaches the projector word for word', () => {
  const { lane, additions, skipped } = dashboardAdditions(sermon.pieces);
  const { relayLane, painted, modes } = relayAndProjector(additions);

  // Google's own text, with only the one word the resumed session repeated.
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].text, 'sighed.');
  assert.equal(skipped[0].session, 2);
  const expected = sermon.pieces.filter(piece => piece !== skipped[0]).flatMap(piece => splitWords(piece.text));
  assert.equal(expected.length, 2280);
  assert.deepEqual(painted, expected);

  // Every piece animated in order; nothing needed a redraw or was dropped.
  assert.deepEqual([...modes], ['append']);
  assert.equal(relayLane.seq, additions.length);
  assert.equal(relayLane.text, lane.text);
});

test('the preacher repeating himself is shown exactly as Google translated it', () => {
  const pieces = [' He speaks a lot,', ' but what he speaks with', ' sense,', ' he speaks with', ' meaning,', ' as we say,', ' with meaning,']
    .map(text => ({ session: 1, text }));
  const { painted } = relayAndProjector(dashboardAdditions(pieces).additions);
  assert.equal(painted.join(' '), 'He speaks a lot, but what he speaks with sense, he speaks with meaning, as we say, with meaning,');
});

test('a screen that connects or refreshes mid-sermon redraws the recent text at once', () => {
  const { additions } = dashboardAdditions(sermon.pieces);
  const { relayLane, painted } = relayAndProjector(additions);

  const plan = laneUpdatePlan(0, relayLane);
  assert.equal(plan.mode, 'redraw');
  assert.equal(plan.seq, relayLane.seq);
  assert.ok(relayLane.text.length <= MAX_LANE_CHARS);
  assert.deepEqual(plan.words, painted.slice(-plan.words.length));
  assert.ok(plan.words.length > 100);
});

test('a missed piece redraws from the relay text instead of guessing', () => {
  const lane = { text: 'one two three four', seq: 7 };
  assert.deepEqual(laneUpdatePlan(6, lane, ' four'), { mode: 'append', seq: 7, words: ['four'] });
  assert.deepEqual(laneUpdatePlan(5, lane, ' four'), { mode: 'redraw', seq: 7, words: ['one', 'two', 'three', 'four'] });
  assert.deepEqual(laneUpdatePlan(7, lane), { mode: 'none', seq: 7, words: [] });
  assert.equal(laneUpdatePlan(9, lane).mode, 'redraw');
});

test('pieces are joined exactly as Google sends them', () => {
  assert.equal(pieceToAppend('', ' Amen.'), 'Amen.');
  assert.equal(pieceToAppend('Amen.', ' I would like'), ' I would like');
  assert.equal(pieceToAppend('verse 17,', ' just one verse,'), ' just one verse,');
  assert.equal(pieceToAppend('anything', '   '), '');
  // Unspaced scripts are never given extra spaces.
  assert.equal(pieceToAppend('我们', '知道'), '知道');
});

test('the first piece of a new session gets the space Google leaves off', () => {
  assert.equal(pieceToAppend('I haven\'t slept', 'It\'s like', { sessionStart: true }), ' It\'s like');
  assert.equal(pieceToAppend('the cross', ', and', { sessionStart: true }), ', and');
  assert.equal(pieceToAppend('我们知道', '他是', { sessionStart: true }), '他是');
});

test('only a resumed session drops a word the old session already sent', () => {
  const screen = 'who was telling the story sighed and said: I haven\'t slept';
  assert.equal(pieceToAppend(screen, 'sighed.', { sessionStart: true, resumed: true }), '');
  assert.equal(pieceToAppend(screen, 'sighed and said: rest', { sessionStart: true, resumed: true }), ' rest');
  // Not resumed, or a short common word: always kept.
  assert.equal(pieceToAppend(screen, 'sighed.', { sessionStart: true }), ' sighed.');
  assert.equal(pieceToAppend(screen, 'the end', { sessionStart: true, resumed: true }), ' the end');
  assert.equal(pieceToAppend(screen, 'Jesus said', { sessionStart: true, resumed: true }), ' Jesus said');
});

test('lane history keeps whole words and counts every piece', () => {
  let lane = emptyLaneState();
  lane = appendLaneText(lane, ' Amen.');
  assert.deepEqual(lane, { text: 'Amen.', seq: 1 });
  lane = appendLaneText(lane, '');
  assert.equal(lane.seq, 1);

  for (let index = 0; index < 400; index++) lane = appendLaneText(lane, ' word');
  assert.equal(lane.seq, 401);
  assert.ok(lane.text.length <= MAX_LANE_CHARS);
  assert.ok(lane.text.startsWith('word'));
});

test('transcript bubbles close at the end of a sentence', () => {
  assert.equal(endsSentence('Please be seated.'), true);
  assert.equal(endsSentence('Is it true?"'), true);
  assert.equal(endsSentence('he speaks with'), false);
  assert.equal(endsSentence('verse 17,'), false);
});
