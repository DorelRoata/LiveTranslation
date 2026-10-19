// Runs message notes for the relay: finds Bible references as the sermon is
// heard and shows each verse on the screens for a minute, and keeps Gemini's
// notes (title, summary, points, verses read) up to date. Screens get the
// whole state as { type: 'message-notes', state } whenever it changes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createReferenceTracker, makeReference, parseReference, referenceKey, referenceVerses, verseCount } from './src/bible-references.js';
import { FAR_SCORE, MIN_SCORE, chooseReadingVerse, createReadingFollower, verseAt } from './src/bible-reading.js';
import {
  DEFAULT_NOTES_SETTINGS,
  NOTES_FALLBACK_MODEL,
  NOTES_MODEL,
  buildNotesRequest,
  normalizeNotesResponse,
  normalizeNotesSettings,
  notesForPrompt,
  notesLanguages,
  notesUpdateDue
} from './src/message-notes.js';
import { countWords, getLanguageName } from './src/system-setup.js';
import { bibleForLanguage, createBibleLibrary } from './server-bible.js';
import { createBibleSearch } from './server-bible-search.js';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 45_000;
const FLUSH_AFTER_MS = 1800;
const SAME_VERSE_WINDOW_MS = 20_000;
const NEW_MESSAGE_AFTER_SILENCE_MS = 30 * 60_000;
const RECAP_MS = 120_000;
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_VERSES_LISTED = 24;
const SETTINGS_FILE = 'message-notes.json';
// Any device on the church network can reach the relay, so a manual update
// cannot run Gemini more often than this.
const MANUAL_UPDATE_GAP_MS = 15_000;
// A named book or chapter counts for following a reading this long.
const MENTION_MS = 15 * 60_000;
// A reading continues to the next verses if they are heard within this time.
const READING_GAP_MS = 90_000;
// A passage nobody announced must match twice in a row within this time.
const CONFIRM_MS = 20_000;
const LANGUAGE_VOTES = 20;

function appendCapped(text, addition) {
  const joined = text + addition;
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(joined.length - MAX_TRANSCRIPT_CHARS) : joined;
}

function emptyTranscript() {
  return { source: '', lang1: '', lang2: '', words: { source: 0, lang1: 0, lang2: 0 }, lastTextAt: 0 };
}

function laneLanguage(setup, lane) {
  const code = lane === 'lang1' ? setup.targetLanguage1 : setup.targetLanguage2;
  return code && code !== 'none' ? String(code).toLowerCase() : '';
}

// Google labels the spoken language "ro", "ro-RO", "pt"…
function spokenCode(code) {
  const value = String(code || '').trim().toLowerCase();
  if (!value) return '';
  return value.startsWith('zh') ? value : value.split('-')[0];
}

export function createMessageNotes({
  broadcast = () => {},
  readApiKey = async () => '',
  configDir = '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger = console,
  bible = createBibleLibrary({ cacheDir: configDir ? path.join(configDir, 'bible-cache') : '', fetchImpl, logger }),
  search: givenSearch
} = {}) {
  // A search passed in belongs to the caller; one made here is stopped here.
  const search = givenSearch === undefined ? createBibleSearch({ cacheDir: configDir ? path.join(configDir, 'bible-cache') : '', logger }) : givenSearch;
  const ownsSearch = givenSearch === undefined;
  let settings = { ...DEFAULT_NOTES_SETTINGS };
  let setup = { targetLanguage1: 'en', targetLanguage2: 'none' };
  let messageId = 1;
  let transcript = emptyTranscript();
  let notes = null;
  let notesWords = 0;
  let lastAttemptAt = 0;
  let inFlight = false;
  let status = { state: 'waiting', detail: '' };
  let verses = [];
  let verse = null;
  let verseSeq = 0;
  let recapUntil = 0;
  const lastSeen = new Map();
  const timers = { verse: null, recap: null };
  let disposed = false;
  // The spoken language, by majority of Google's labels on recent pieces (a
  // lone "Amém" was once labelled Portuguese).
  let heard = [];
  let spoken = '';
  const follower = createReadingFollower();
  let mentions = [];
  let reading = null;
  let unconfirmed = null;
  let readingItem = null;

  // Screen languages, plus the spoken language ('src') when it differs: its
  // Bible verse and notes are for Romanian on screens.
  function lanes() {
    const result = [{ lane: 'lang1', code: laneLanguage(setup, 'lang1') || 'en' }];
    const second = laneLanguage(setup, 'lang2');
    if (second) result.push({ lane: 'lang2', code: second });
    if (spoken && !result.some(item => item.code === spoken)) result.push({ lane: 'src', code: spoken });
    return result;
  }

  function snapshot() {
    const t = now();
    return {
      settings,
      messageId,
      notes,
      verses: verses.map(({ key, labels, origin }) => ({ key, labels, origin })),
      verse: verse && { ...verse, remainingMs: Math.max(0, verse.until - t) },
      recap: recapUntil > t ? { remainingMs: recapUntil - t } : null,
      source: spoken ? { code: spoken, name: getLanguageName(spoken, spoken.toUpperCase()) } : null,
      status: { ...status, words: transcriptWords(), notesWords }
    };
  }

  function publish() {
    if (!disposed) broadcast({ type: 'message-notes', state: snapshot() });
  }

  function setStatus(state, detail = '') {
    status = { state, detail, at: now() };
  }

  // --- Settings -------------------------------------------------------------
  const settingsPath = configDir ? path.join(configDir, SETTINGS_FILE) : '';
  let settingsChanged = false;
  const loaded = (async () => {
    if (!settingsPath) return;
    try {
      // Read before the server starts listening, so every screen's first
      // sync already carries these.
      const saved = normalizeNotesSettings(JSON.parse(await fs.readFile(settingsPath, 'utf8')));
      if (!settingsChanged) settings = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn?.(`Message notes settings could not be read: ${error.message}`);
    }
  })();

  async function saveSettings() {
    if (!settingsPath) return;
    try {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    } catch (error) {
      logger.warn?.(`Message notes settings could not be saved: ${error.message}`);
    }
  }

  function applySettings(input) {
    settingsChanged = true;
    const previous = settings;
    settings = normalizeNotesSettings(input, settings);
    if ((!settings.verses && previous.verses) || (!settings.follow && previous.follow && verse?.following)) hideVerse(false);
    if (settings.englishBible !== previous.englishBible) refreshLabels();
    void saveSettings();
    publish();
    maybeUpdateNotes();
  }

  // --- Transcript and references ----------------------------------------------
  function transcriptWords() {
    return transcript.words.source || transcript.words.lang1;
  }

  function makeTracker(origin) {
    let flushTimer = null;
    const tracker = createReferenceTracker({
      now,
      onReference: ref => noteReference(ref, origin),
      onMention: ref => rememberMention(ref)
    });
    return {
      push(text) {
        tracker.push(text);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(() => tracker.flush(), FLUSH_AFTER_MS);
        flushTimer.unref?.();
      },
      reset() {
        clearTimeout(flushTimer);
        tracker.reset();
      }
    };
  }

  const trackers = { source: makeTracker('live'), lang1: makeTracker('live'), lang2: makeTracker('live') };

  function startNewMessage(reason) {
    messageId += 1;
    transcript = emptyTranscript();
    notes = null;
    notesWords = 0;
    lastAttemptAt = 0;
    verses = [];
    lastSeen.clear();
    mentions = [];
    reading = null;
    unconfirmed = null;
    readingItem = null;
    follower.reset();
    for (const tracker of Object.values(trackers)) tracker.reset();
    hideVerse(false);
    recapUntil = 0;
    clearTimeout(timers.recap);
    setStatus('waiting', reason === 'auto' ? 'Started a new message after a long pause.' : '');
    publish();
  }

  function noteText(field, text) {
    if (typeof text !== 'string' || !text.trim()) return;
    const t = now();
    if (transcript.lastTextAt && t - transcript.lastTextAt > NEW_MESSAGE_AFTER_SILENCE_MS) startNewMessage('auto');
    transcript[field] = appendCapped(transcript[field], text);
    transcript.words[field] += countWords(text);
    transcript.lastTextAt = t;
  }

  function addSource(text, language = '') {
    noteText('source', text);
    noteSpokenLanguage(language);
    trackers.source.push(text);
    followReading(text);
    maybeUpdateNotes();
  }

  function noteSpokenLanguage(language) {
    const code = spokenCode(language);
    if (!code) return;
    heard = [...heard, code].slice(-LANGUAGE_VOTES);
    const votes = new Map();
    for (const item of heard) votes.set(item, (votes.get(item) || 0) + 1);
    const [leader] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (leader === spoken) return;
    const before = lanes().map(item => item.code).join();
    spoken = leader;
    if (lanes().map(item => item.code).join() === before) return;
    notesWords = 0;
    lastAttemptAt = 0;
    refreshLabels();
    publish();
  }

  // Translated text. Only English and Romanian lanes are read for references;
  // the spoken language is read for every language through addSource.
  function addLane(lane, text) {
    if (lane !== 'lang1' && lane !== 'lang2') return;
    noteText(lane, text);
    const code = laneLanguage(setup, lane) || (lane === 'lang1' ? 'en' : '');
    if (code === 'en' || code === 'ro' || code.startsWith('en-')) trackers[lane].push(text);
    maybeUpdateNotes();
  }

  function setLanguages(nextSetup = {}) {
    const before = lanes().map(item => item.code).join();
    setup = { targetLanguage1: nextSetup.targetLanguage1 || 'en', targetLanguage2: nextSetup.targetLanguage2 || 'none' };
    if (lanes().map(item => item.code).join() === before) return;
    // Notes and labels in the old languages are rewritten soon.
    notesWords = 0;
    lastAttemptAt = 0;
    refreshLabels();
    maybeUpdateNotes();
  }

  async function labelsFor(ref) {
    const entries = await Promise.all(lanes().map(async ({ lane, code }) => [lane, await bible.labelFor(ref, code, settings.englishBible)]));
    return Object.fromEntries(entries);
  }

  function refreshLabels() {
    const current = messageId;
    void Promise.all(verses.map(async item => {
      item.labels = await labelsFor(item.ref);
    })).then(() => {
      if (current === messageId) publish();
    });
  }

  // Already listed: the same passage, or a range read aloud that includes it
  // ("1 Corinthians 11:23" said again during the reading of 11:23–26).
  function listed(ref) {
    const key = referenceKey(ref);
    return verses.some(item => item.key === key || (item.ref.book === ref.book && item.ref.chapter === ref.chapter
      && (ref.verseStart ? referenceVerses(item.ref).includes(ref.verseStart) : !item.ref.verseStart && !ref.chapterEnd)));
  }

  async function addToList(ref, origin) {
    const key = referenceKey(ref);
    if (listed(ref)) return false;
    if (ref.verseStart) {
      const bare = verses.find(item => !item.ref.verseStart && !item.ref.chapterEnd && item.ref.book === ref.book && item.ref.chapter === ref.chapter);
      if (bare) {
        bare.key = key;
        bare.ref = ref;
        bare.origin = origin;
        bare.labels = await labelsFor(ref);
        return true;
      }
    }
    const item = { key, ref, origin, labels: {} };
    verses.push(item);
    if (verses.length > MAX_VERSES_LISTED) verses.shift();
    item.labels = await labelsFor(ref);
    return true;
  }

  function rememberMention(ref) {
    const t = now();
    mentions = [...mentions.filter(item => t - item.at <= MENTION_MS), { ...ref, at: t }].slice(-6);
  }

  function noteReference(ref, origin) {
    rememberMention(ref);
    const key = referenceKey(ref);
    const t = now();
    const seenAt = lastSeen.get(key);
    lastSeen.set(key, t);
    const current = messageId;
    void addToList(ref, origin).then(added => {
      if (added && current === messageId) publish();
    });
    if (!settings.verses || !ref.verseStart) return;
    // The same verse from the other language, or repeated by the preacher:
    // keep the card up instead of showing it again.
    if (verse?.key === key) {
      extendVerse();
      return;
    }
    if (seenAt && t - seenAt < SAME_VERSE_WINDOW_MS) return;
    void showVerse(ref, origin);
  }

  // --- The verse card ---------------------------------------------------------
  function armVerseTimer() {
    clearTimeout(timers.verse);
    if (!verse) return;
    timers.verse = setTimeout(() => hideVerse(true), Math.max(0, verse.until - now()));
    timers.verse.unref?.();
  }

  function extendVerse() {
    if (!verse) return;
    verse.until = now() + settings.verseSeconds * 1000;
    armVerseTimer();
    publish();
  }

  async function showVerse(ref, origin, { following = false } = {}) {
    const id = ++verseSeq;
    const current = messageId;
    const passages = await Promise.all(lanes().map(async ({ lane, code }) => {
      try {
        return [lane, await bible.lookupPassage(ref, code, settings.englishBible)];
      } catch (error) {
        logger.warn?.(`Verse lookup failed: ${error.message}`);
        return [lane, { label: '', version: '', verses: [], truncated: false }];
      }
    }));
    // A newer verse, or a new message, arrived while this one was loading.
    if (id !== verseSeq || current !== messageId || disposed) return;
    const t = now();
    verse = {
      id,
      key: referenceKey(ref),
      ref,
      origin,
      lanes: Object.fromEntries(passages),
      following,
      shownAt: t,
      until: t + settings.verseSeconds * 1000,
      durationMs: settings.verseSeconds * 1000
    };
    armVerseTimer();
    publish();
  }

  // --- Following a reading ---------------------------------------------------
  // The verse heard needs MIN_SCORE when it continues the reading or lies in
  // a chapter just named; FAR_SCORE elsewhere in a book just named (a
  // misheard chapter); FAR_SCORE twice in a row when nothing named its book.
  function readingNeed(index, id) {
    const t = now();
    if (reading && t - reading.at <= READING_GAP_MS && id >= reading.id - 1 && id <= reading.id + 4) return { score: MIN_SCORE, tier: 0 };
    const at = verseAt(index, id);
    let sameBook = false;
    for (const mention of mentions) {
      if (t - mention.at > MENTION_MS || mention.book !== at.book) continue;
      sameBook = true;
      if (at.chapter >= mention.chapter && at.chapter <= (mention.chapterEnd || mention.chapter) + 1) return { score: MIN_SCORE, tier: 0 };
    }
    return sameBook ? { score: FAR_SCORE, tier: 1 } : { score: FAR_SCORE, tier: 2, confirm: true };
  }

  function followReading(text) {
    follower.push(text);
    if (!settings.verses || !settings.follow) return;
    const readingBible = bibleForLanguage(spoken || 'ro', settings.englishBible);
    // Only Bibles numbered like the King James can be followed for now.
    if (!readingBible || readingBible.scheme !== 'eng') return;
    const index = search?.get(readingBible.id);
    if (!index) return;
    const best = chooseReadingVerse(follower.candidates(index), {
      need: id => readingNeed(index, id),
      current: reading ? reading.id : -1
    });
    if (!best) return;
    const t = now();
    if (readingNeed(index, best.id).confirm) {
      const confirmed = unconfirmed && Math.abs(unconfirmed.id - best.id) <= 1 && t - unconfirmed.at <= CONFIRM_MS;
      if (!confirmed) {
        unconfirmed = { id: best.id, at: t };
        return;
      }
    }
    unconfirmed = null;
    const at = verseAt(index, best.id);
    if (reading?.id === best.id && verse?.following) {
      reading.at = t;
      extendVerse();
      return;
    }
    reading = { id: best.id, at: t, ...at };
    rememberMention({ book: at.book, chapter: at.chapter });
    noteReadingInList(at);
    // The verse being read now, and the next one to read along.
    const next = at.verse < verseCount(at.book, at.chapter) ? at.verse + 1 : 0;
    const ref = makeReference(at.book, at.chapter, at.verse, next);
    if (ref) void showVerse(ref, 'reading', { following: true });
  }

  // A reading is listed once, as the range read so far ("Psalms 50:1–23").
  function noteReadingInList(at) {
    const current = messageId;
    const item = readingItem && verses.includes(readingItem) ? readingItem : null;
    if (item && item.ref.book === at.book && item.ref.chapter === at.chapter && item.ref.verseStart
      && at.verse >= item.ref.verseStart && at.verse <= (item.ref.verseEnd || item.ref.verseStart) + 4) {
      const last = Math.max(item.ref.verseEnd || item.ref.verseStart, at.verse);
      const ref = makeReference(at.book, at.chapter, item.ref.verseStart, last);
      if (!ref || referenceKey(ref) === item.key) return;
      item.ref = ref;
      item.key = referenceKey(ref);
      void labelsFor(ref).then(labels => {
        item.labels = labels;
        if (current === messageId) publish();
      });
      return;
    }
    const announced = verses.find(entry => entry.ref.book === at.book && entry.ref.chapter === at.chapter
      && referenceVerses(entry.ref).includes(at.verse));
    if (announced) {
      readingItem = announced;
      return;
    }
    const ref = makeReference(at.book, at.chapter, at.verse);
    if (!ref) return;
    void addToList(ref, 'reading').then(added => {
      if (added && current === messageId) publish();
    });
    readingItem = verses[verses.length - 1];
  }

  function hideVerse(announce = true) {
    verseSeq += 1;
    clearTimeout(timers.verse);
    if (!verse) return;
    verse = null;
    if (announce) publish();
  }

  // --- Recap overlay ----------------------------------------------------------
  function showRecap() {
    recapUntil = now() + RECAP_MS;
    clearTimeout(timers.recap);
    timers.recap = setTimeout(() => {
      recapUntil = 0;
      publish();
    }, RECAP_MS);
    timers.recap.unref?.();
    publish();
  }

  function hideRecap() {
    recapUntil = 0;
    clearTimeout(timers.recap);
    publish();
  }

  // --- Gemini notes ----------------------------------------------------------
  async function callGemini(apiKey, request) {
    let lastError = null;
    for (const model of [NOTES_MODEL, NOTES_FALLBACK_MODEL]) {
      for (const thinking of [{ thinkingLevel: 'low' }, null]) {
        const body = { ...request, generationConfig: { ...request.generationConfig } };
        if (thinking) body.generationConfig.thinkingConfig = thinking;
        const response = await fetchImpl(`${GEMINI_API}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok) {
          const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
          if (!text) throw new Error(data.promptFeedback?.blockReason ? `Gemini declined (${data.promptFeedback.blockReason}).` : 'Gemini returned no notes.');
          return text;
        }
        const message = data.error?.message || `HTTP ${response.status}`;
        lastError = new Error(message);
        // An older model without thinking levels: retry without them.
        if (response.status === 400 && thinking && /thinking/i.test(message)) continue;
        if (response.status === 404) break;
        throw lastError;
      }
    }
    throw lastError || new Error('No Gemini model is available for notes.');
  }

  async function updateNotes(reason = 'scheduled') {
    if (inFlight || disposed) return;
    const words = transcriptWords();
    if (words < 20) {
      setStatus('waiting', 'Notes start after about a minute of preaching.');
      publish();
      return;
    }
    const apiKey = await readApiKey().catch(() => '');
    if (!apiKey) {
      lastAttemptAt = now();
      setStatus('error', 'The Gemini API key is not configured.');
      publish();
      return;
    }
    inFlight = true;
    lastAttemptAt = now();
    const current = messageId;
    const laneList = lanes();
    const codes = notesLanguages(laneList);
    const request = buildNotesRequest({
      transcript: transcript.source,
      translation: transcript.lang1,
      codes,
      previous: notesForPrompt(notes, laneList)
    });
    setStatus('updating', reason === 'manual' ? 'Updating now…' : 'Updating…');
    publish();
    try {
      const text = await callGemini(apiKey, request);
      if (current !== messageId) return;
      const result = normalizeNotesResponse(text, laneList);
      notes = { title: result.title, summary: result.summary, points: result.points, updatedAt: now() };
      notesWords = words;
      let unshown = null;
      for (const ref of result.verses) {
        const checked = makeReference(ref.book, ref.chapter, ref.verseStart, ref.verseEnd);
        if (!checked) continue;
        const wasListed = listed(checked);
        await addToList(checked, 'notes');
        if (checked.verseStart && !wasListed && !lastSeen.has(referenceKey(checked))) {
          unshown = checked;
        }
      }
      if (unshown && settings.verses && !verse) {
        lastSeen.set(referenceKey(unshown), now());
        await showVerse(unshown, 'notes');
      }
      setStatus('ready');
    } catch (error) {
      if (current !== messageId) return;
      logger.warn?.(`Message notes update failed: ${error.message}`);
      setStatus('error', error.name === 'TimeoutError' ? 'Gemini took too long. Retrying soon.' : error.message);
    } finally {
      inFlight = false;
      if (current === messageId) publish();
    }
  }

  function maybeUpdateNotes() {
    if (notesUpdateDue({
      enabled: settings.notes,
      inFlight,
      hasNotes: Boolean(notes),
      words: transcriptWords(),
      notesWords,
      lastAttemptAt,
      lastTextAt: transcript.lastTextAt,
      now: now()
    })) {
      void updateNotes();
    }
  }

  const tick = setInterval(maybeUpdateNotes, 5000);
  tick.unref?.();
  // Index the Romanian Bible soon after the server starts, so it is ready
  // before anyone reads (about 6 s the first time, while downloading).
  const prewarm = ownsSearch ? setTimeout(() => search?.get(bibleForLanguage('ro')?.id), 5000) : null;
  prewarm?.unref?.();

  // --- Operator commands ------------------------------------------------------
  // Returns an error message for the sender, or ''.
  function command(action, payload = {}) {
    switch (action) {
      case 'new-message':
        startNewMessage('operator');
        return '';
      case 'update-now':
        if (inFlight) return '';
        if (lastAttemptAt && now() - lastAttemptAt < MANUAL_UPDATE_GAP_MS) return 'The notes were updated a few seconds ago. Try again shortly.';
        void updateNotes('manual');
        return '';
      case 'show-verse': {
        const listed = typeof payload.key === 'string' ? verses.find(item => item.key === payload.key) : null;
        const ref = listed?.ref || parseReference(payload.reference);
        if (!ref) return 'That is not a Bible reference this app knows. Try "John 3:16" or "Psalm 23".';
        void addToList(ref, 'operator').then(added => added && publish());
        lastSeen.set(referenceKey(ref), now());
        void showVerse(ref, 'operator');
        return '';
      }
      case 'hide-verse':
        hideVerse(true);
        return '';
      case 'show-recap':
        showRecap();
        return '';
      case 'hide-recap':
        hideRecap();
        return '';
      default:
        return 'Unknown message notes command.';
    }
  }

  // "Clear screens" removes the verse and the recap; the summary stays until
  // the operator turns it off or starts a new message.
  function clearScreens() {
    const shown = Boolean(verse) || recapUntil > now();
    hideVerse(false);
    recapUntil = 0;
    clearTimeout(timers.recap);
    if (shown) publish();
  }

  function dispose() {
    disposed = true;
    if (ownsSearch) search?.dispose?.();
    clearTimeout(prewarm);
    clearInterval(tick);
    clearTimeout(timers.verse);
    clearTimeout(timers.recap);
    for (const tracker of Object.values(trackers)) tracker.reset();
  }

  function summary() {
    return {
      notes: settings.notes,
      verses: settings.verses,
      state: status.state,
      detail: status.detail,
      versesRead: verses.length,
      verseOnScreen: verse ? verse.lanes.lang1?.label || '' : '',
      following: Boolean(verse?.following),
      spokenLanguage: spoken
    };
  }

  return { loaded, addSource, addLane, setLanguages, applySettings, command, clearScreens, snapshot, summary, dispose };
}
