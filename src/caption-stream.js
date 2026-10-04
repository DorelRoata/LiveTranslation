// Google's Live Translate model streams each translated piece once, in order,
// and never revises it. Each piece carries its own leading space and
// punctuation, and no "finished" or turnComplete signal is ever sent. This was
// verified against a recorded 15-minute sermon (Oct 2026): 840 pieces, none
// restated or corrected. So the screen text is the pieces joined exactly as
// sent. Nothing here guesses, merges, or removes words.

export const MAX_LANE_CHARS = 1500;

// A resumed session (after Google's goAway rotation) can restate the last word
// the old session already sent. Only that seam is checked, against this tail.
const SEAM_TAIL_WORDS = 8;

// Scripts written without spaces between words.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const CLOSING_PUNCTUATION = /^[,.;:!?…)\]}"'”’»。、，！？；：]/u;
const SENTENCE_END = /[.?!…。？！]["'”’»)\]]*\s*$/u;

export function emptyLaneState() {
  return { text: '', seq: 0 };
}

export function normalizeLaneState(lane) {
  return {
    text: typeof lane?.text === 'string' ? lane.text : '',
    seq: Number.isInteger(lane?.seq) && lane.seq >= 0 ? lane.seq : 0
  };
}

export function laneDisplayText(lane) {
  return normalizeLaneState(lane).text;
}

export function trimLaneText(text, maxChars = MAX_LANE_CHARS) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(text.length - maxChars);
  const boundary = cut.search(/\s/);
  return boundary === -1 ? cut : cut.slice(boundary + 1);
}

// Adds an already-prepared piece to a lane. The relay and every screen apply
// the same pieces in the same order, so their text and seq stay identical.
export function appendLaneText(lane, addition, maxChars = MAX_LANE_CHARS) {
  const current = normalizeLaneState(lane);
  if (typeof addition !== 'string' || !addition.trim()) return current;
  const joined = current.text ? current.text + addition : addition.trimStart();
  return { text: trimLaneText(joined, maxChars), seq: current.seq + 1 };
}

export function applyRelaySnapshot(subtitleState = {}, snapshot = {}) {
  const next = { ...subtitleState };
  if (snapshot.lang1 && typeof snapshot.lang1 === 'object') next.lang1 = normalizeLaneState(snapshot.lang1);
  if (snapshot.lang2 && typeof snapshot.lang2 === 'object') next.lang2 = normalizeLaneState(snapshot.lang2);
  return next;
}

function bareWord(word) {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function needsJoinSpace(text, next) {
  if (!text || /\s$/.test(text) || !next) return false;
  if (CLOSING_PUNCTUATION.test(next)) return false;
  if (UNSPACED_SCRIPT.test(text[text.length - 1]) || UNSPACED_SCRIPT.test(next[0])) return false;
  return true;
}

// Number of leading words of `words` that repeat a run inside `tail`. A single
// short word ("the", "God", "it's") is never treated as a repeat.
function seamOverlap(tail, words) {
  let best = 0;
  for (let start = 0; start < tail.length; start++) {
    let length = 0;
    while (length < words.length && start + length < tail.length && tail[start + length] === words[length] && words[length]) {
      length++;
    }
    if (length > best) best = length;
  }
  if (best === 1 && words[0].length < 5) return 0;
  return best;
}

// Returns the exact string to add for one Google piece ('' adds nothing).
//   sessionStart: first piece from a new or resumed Gemini session. Google
//     sends that piece without its leading space, so one is added if needed.
//   resumed: the session continued from a resumption handle. Its first piece
//     can restate the old session's last word, which is dropped here only.
export function pieceToAppend(currentText, piece, { sessionStart = false, resumed = false } = {}) {
  if (typeof piece !== 'string' || !piece.trim()) return '';
  const text = typeof currentText === 'string' ? currentText : '';
  if (!text.trim()) return piece.trimStart();
  if (!sessionStart) return piece;

  let body = piece.trim();
  if (resumed) {
    const tail = text.trim().split(/\s+/).slice(-SEAM_TAIL_WORDS).map(bareWord);
    const words = body.split(/\s+/);
    const overlap = seamOverlap(tail, words.map(bareWord));
    body = words.slice(overlap).join(' ');
    if (!body) return '';
  }
  const leadingSpace = /^\s/.test(piece) || needsJoinSpace(text, body);
  return `${leadingSpace ? ' ' : ''}${body}`;
}

export function endsSentence(text) {
  return SENTENCE_END.test(text);
}

export function splitWords(text) {
  return typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean) : [];
}

// How a screen shows a lane update. A piece that directly follows what the
// screen already shows animates in; anything else (first connect, reconnect,
// a missed message) redraws instantly from the relay's full text.
export function laneUpdatePlan(shownSeq, lane, addition) {
  const next = normalizeLaneState(lane);
  if (typeof addition === 'string' && next.seq === shownSeq + 1) {
    return { mode: 'append', seq: next.seq, words: splitWords(addition) };
  }
  if (next.seq === shownSeq) return { mode: 'none', seq: next.seq, words: [] };
  return { mode: 'redraw', seq: next.seq, words: splitWords(next.text) };
}
