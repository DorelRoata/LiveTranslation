// Message notes: the sermon's title, a short summary, its main points, and the
// verses read, written by Gemini from the live transcript and shown on screens
// that display one language. Shared by the server (which writes them) and the
// dashboard (which controls them).
import { getLanguageName } from './system-setup.js';
import { parseReference } from './bible-references.js';

export const NOTES_MODEL = 'gemini-flash-latest';
export const NOTES_FALLBACK_MODEL = 'gemini-2.5-flash';
export const VERSE_SECONDS_OPTIONS = Object.freeze([30, 60, 90, 120, 180]);
export const ENGLISH_BIBLES = Object.freeze([
  { id: 'kjv', label: 'King James Version (KJV)' },
  { id: 'web', label: 'World English Bible (WEB)' },
  { id: 'asv', label: 'American Standard Version (ASV)' }
]);

export const DEFAULT_NOTES_SETTINGS = Object.freeze({
  notes: true,
  verses: true,
  // The verse card follows a passage being read aloud, verse by verse.
  follow: true,
  // One-language screens also show the verse in the spoken language's Bible.
  spokenVerses: true,
  verseSeconds: 60,
  englishBible: 'kjv'
});

export const MAX_POINTS = 6;
const MAX_TITLE_CHARS = 90;
const MAX_SUMMARY_CHARS = 420;
const MAX_POINT_CHARS = 170;
const MAX_TRANSCRIPT_CHARS = 50_000;

export function normalizeNotesSettings(input = {}, base = DEFAULT_NOTES_SETTINGS) {
  const settings = { ...base };
  if (typeof input.notes === 'boolean') settings.notes = input.notes;
  if (typeof input.verses === 'boolean') settings.verses = input.verses;
  if (typeof input.follow === 'boolean') settings.follow = input.follow;
  if (typeof input.spokenVerses === 'boolean') settings.spokenVerses = input.spokenVerses;
  const seconds = Number(input.verseSeconds);
  if (VERSE_SECONDS_OPTIONS.includes(seconds)) settings.verseSeconds = seconds;
  if (ENGLISH_BIBLES.some(bible => bible.id === input.englishBible)) settings.englishBible = input.englishBible;
  return settings;
}

// When the notes should be rewritten. Words are counted in the transcript of
// the current message; times are milliseconds.
export function notesUpdateDue({
  enabled = false,
  inFlight = false,
  hasNotes = false,
  words = 0,
  notesWords = 0,
  lastAttemptAt = 0,
  lastTextAt = 0,
  now = 0
} = {}) {
  if (!enabled || inFlight) return false;
  const fresh = words - notesWords;
  if (words < 120 || fresh <= 0) return false;
  const sinceAttempt = now - lastAttemptAt;
  // First notes after about a minute of preaching; retried every 30 s after an error.
  if (!hasNotes) return sinceAttempt >= 30_000;
  if (fresh >= 60 && sinceAttempt >= 90_000) return true;
  // The preacher paused or finished: catch the last words.
  return fresh >= 15 && now - lastTextAt >= 25_000 && sinceAttempt >= 30_000;
}

function tail(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text.trim();
  const cut = text.slice(text.length - maxChars);
  const boundary = cut.search(/\s/);
  return (boundary === -1 ? cut : cut.slice(boundary + 1)).trim();
}

// lanes: [{ lane: 'lang1', code: 'en' }, ...]. The model writes one entry per
// distinct language; the result is mapped back to lanes.
export function notesLanguages(lanes) {
  const codes = [];
  for (const { code } of lanes) {
    if (code && code !== 'none' && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function languageObjectSchema(codes) {
  return {
    type: 'object',
    properties: Object.fromEntries(codes.map(code => [code, { type: 'string' }])),
    required: codes
  };
}

const SYSTEM_INSTRUCTION = `You write live notes for a church sermon. They are shown on the projector while the preacher speaks, so the congregation can follow the message.
You receive the sermon so far as automatic speech recognition in the preacher's language (it can contain recognition errors) and a machine translation of it.
Write the notes in every requested language, the same content in each, in simple natural wording:
- title: the message's theme in at most 7 words. If the preacher announces a title, use it.
- summary: what the message teaches so far, in 2 short sentences, at most 45 words.
- points: the main points in the order they were preached, at most ${MAX_POINTS}, each at most 14 words. State the teaching itself ("The cross reconciles us to God"), never "The preacher says".
- verses: the Bible passages the preacher cited by reference, in order, with standard English book names. Only explicit references, never allusions.
Ignore songs, announcements, greetings and prayers. If there is no sermon yet, return an empty title, summary, points and verses.
Use only what is in the transcript. Do not add doctrine, stories or verses the preacher did not say.
When notes already on screen are given, keep their wording unless it is wrong, so the screen does not change for no reason. Add points as the sermon goes on; once there are ${MAX_POINTS}, merge related points instead of adding more.`;

export function buildNotesRequest({ transcript = '', translation = '', codes = [], previous = null } = {}) {
  const languageList = codes.map(code => `${code} = ${getLanguageName(code, code)}`).join(', ');
  const langSchema = languageObjectSchema(codes);
  const sections = [`Languages to write: ${languageList}.`];
  const source = tail(transcript, MAX_TRANSCRIPT_CHARS);
  const translated = tail(translation, MAX_TRANSCRIPT_CHARS);
  if (source) sections.push(`Sermon transcript (preacher's language):\n${source}`);
  if (translated) sections.push(`Machine translation:\n${translated}`);
  if (previous) sections.push(`Notes on screen now:\n${JSON.stringify(previous)}`);
  return {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: sections.join('\n\n') }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
      responseSchema: {
        type: 'object',
        properties: {
          title: langSchema,
          summary: langSchema,
          points: { type: 'array', items: langSchema },
          verses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                book: { type: 'string' },
                chapter: { type: 'integer' },
                verseStart: { type: 'integer' },
                verseEnd: { type: 'integer' }
              },
              required: ['book', 'chapter']
            }
          }
        },
        required: ['title', 'summary', 'points', 'verses']
      }
    }
  };
}

function clean(value, maxChars) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut).replace(/[,;:\s]+$/, '')}…`;
}

function byLane(value, lanes, maxChars) {
  const result = {};
  for (const { lane, code } of lanes) result[lane] = clean(value?.[code], maxChars);
  return result;
}

function verseFromModel(item) {
  if (!item || typeof item.book !== 'string') return null;
  const start = Number(item.verseStart) || 0;
  const end = Number(item.verseEnd) || 0;
  let text = `${item.book.trim()} ${Number(item.chapter)}`;
  if (start) text += `:${start}`;
  if (start && end > start) text += `-${end}`;
  return parseReference(text);
}

// Turns Gemini's JSON into notes keyed by lane, dropping anything malformed.
export function normalizeNotesResponse(raw, lanes) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const notes = {
    title: byLane(data?.title, lanes, MAX_TITLE_CHARS),
    summary: byLane(data?.summary, lanes, MAX_SUMMARY_CHARS),
    points: [],
    verses: []
  };
  for (const point of Array.isArray(data?.points) ? data.points : []) {
    const entry = byLane(point, lanes, MAX_POINT_CHARS);
    if (Object.values(entry).some(Boolean)) notes.points.push(entry);
    if (notes.points.length >= MAX_POINTS) break;
  }
  for (const item of Array.isArray(data?.verses) ? data.verses : []) {
    const ref = verseFromModel(item);
    if (ref) notes.verses.push(ref);
  }
  return notes;
}

// The notes in the model's own shape, so the next update can keep wording.
export function notesForPrompt(notes, lanes) {
  if (!notes) return null;
  const pick = value => Object.fromEntries(lanes.map(({ lane, code }) => [code, value?.[lane] || '']));
  return {
    title: pick(notes.title),
    summary: pick(notes.summary),
    points: (notes.points || []).map(pick)
  };
}

export function notesHaveContent(notes, lane = 'lang1') {
  return Boolean(notes && (notes.title?.[lane] || notes.summary?.[lane] || notes.points?.some(point => point[lane])));
}
