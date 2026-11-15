// Shows message notes on the projector and phones. Subtitles are not touched:
// with one language on screen the subtitles keep the top half and this fills
// the bottom half; with two languages a verse sits cleanly at the top of each
// language's half, and the recap opens over everything when the operator asks.
// Each screen can hide the summary (with the recap) or the verses for itself.
// Bible verse typography is fixed strictly by `data-bible-size` so every
// passage renders at the exact same font size without dynamic shrinking.
const MIN_SCALE = 0.56;
const LIST_LIMIT = 8;

const reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false };

// Same rule as message-notes.js; kept here so screens do not load the Bible
// reference tables.
function notesHaveContent(notes, lane) {
  return Boolean(notes && (notes.title?.[lane] || notes.summary?.[lane] || notes.points?.some(point => point[lane])));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function animateSmooth(node, keyframes, duration = 220) {
  if (!node || reducedMotion.matches || typeof node.animate !== 'function') return;
  node.getAnimations?.().forEach(animation => animation.cancel());
  node.animate(keyframes, {
    duration,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
  });
}

// Verse text with small verse numbers when more than one verse is shown.
// While a reading is followed, the verse being read comes first and the
// next one is dimmed; `limit` shows only the first.
function fillVerseText(node, passage, { following = false, limit = 0 } = {}) {
  node.replaceChildren();
  const verses = (passage?.verses || []).slice(0, limit || undefined);
  verses.forEach((verse, index) => {
    const part = following && index > 0 ? el('span', 'verse-next') : node;
    if (verses.length > 1) part.append(el('sup', 'verse-num', String(verse.n)));
    part.append(document.createTextNode(verse.text + (index < verses.length - 1 ? ' ' : '')));
    if (part !== node) node.append(part);
  });
  if (passage?.truncated && !following) node.append(document.createTextNode(' …'));
}

// "Psalm 50:7–8" reads "Psalm 50:7" while verse 8 is only the next one.
function followLabel(label, following) {
  return following ? String(label || '').replace(/[–-]\d+$/, '') : label || '';
}

function laneFor(mode) {
  if (mode === 'lang2') return 'lang2';
  if (mode === 'src') return 'src';
  return 'lang1';
}

function startTimer(bar, remainingMs, durationMs) {
  if (!bar) return;
  const total = Math.max(durationMs || remainingMs, 1);
  const ratio = Math.max(0, Math.min(1, remainingMs / total));
  bar.getAnimations?.().forEach(animation => animation.cancel());
  bar.style.transform = `scaleX(${ratio})`;
  if (!reducedMotion.matches && typeof bar.animate === 'function' && remainingMs > 0) {
    bar.animate(
      [{ transform: `scaleX(${ratio})` }, { transform: 'scaleX(0)' }],
      { duration: Math.max(remainingMs, 0), easing: 'linear', fill: 'forwards' }
    );
  }
}

function shouldRestartTimer(previous, verseId, remainingMs) {
  const nextDeadline = performance.now() + Math.max(0, remainingMs || 0);
  if (!previous || previous.id !== verseId) return { restart: true, next: { id: verseId, deadline: nextDeadline } };
  if (Math.abs(nextDeadline - previous.deadline) > 1000) {
    return { restart: true, next: { id: verseId, deadline: nextDeadline } };
  }
  return { restart: false, next: previous };
}

export function createMessageNotesView({ panel, floats, recapOverlay }) {
  const parts = {
    notes: panel.querySelector('[data-part="notes"]'),
    title: panel.querySelector('[data-part="title"]'),
    summary: panel.querySelector('[data-part="summary"]'),
    points: panel.querySelector('[data-part="points"]'),
    scripture: panel.querySelector('[data-part="scripture"]'),
    verse: panel.querySelector('[data-part="verse"]'),
    verseRef: panel.querySelector('[data-part="verse-ref"]'),
    verseVersion: panel.querySelector('[data-part="verse-version"]'),
    verseText: panel.querySelector('[data-part="verse-text"]'),
    verseTimer: panel.querySelector('[data-part="verse-timer"]'),
    verseTimerTrack: panel.querySelector('[data-part="verse-timer-track"]'),
    spoken: panel.querySelector('[data-part="spoken"]'),
    spokenRef: panel.querySelector('[data-part="spoken-ref"]'),
    spokenVersion: panel.querySelector('[data-part="spoken-version"]'),
    spokenText: panel.querySelector('[data-part="spoken-text"]'),
    list: panel.querySelector('[data-part="list"]')
  };
  const recapCard = recapOverlay.querySelector('[data-part="recap"]');

  let state = null;
  let view = { mode: 'lang1', obs: false, summary: true, verses: true };
  let verseUntil = 0;
  let recapUntil = 0;
  let expiryTimer = 0;
  let fitFrame = 0;
  const shown = {
    verseContentKey: '',
    versePrimaryKey: '',
    verseTimer: null,
    floatContentKeys: {},
    floatPrimaryKeys: {},
    floatTimers: {},
    listKey: '',
    notesFitKey: '',
    points: {},
    recapKey: ''
  };

  function verseActive() {
    return Boolean(state?.verse) && performance.now() < verseUntil;
  }

  function recapActive() {
    return Boolean(state?.recap) && performance.now() < recapUntil;
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const nowMs = performance.now();
    const next = [verseUntil, recapUntil].filter(at => at > nowMs).sort((a, b) => a - b)[0];
    // The host hides these itself; this only covers a lost connection.
    if (next) expiryTimer = setTimeout(render, next - nowMs + 50);
  }

  function update(nextState) {
    state = nextState || null;
    const nowMs = performance.now();
    verseUntil = state?.verse ? nowMs + state.verse.remainingMs + 1500 : 0;
    recapUntil = state?.recap ? nowMs + state.recap.remainingMs + 1500 : 0;
    scheduleExpiry();
    render();
  }

  function setView(nextView) {
    view = { ...view, ...nextView };
    render();
  }

  // --- Single language: bottom half ------------------------------------------
  function renderNotes(lane) {
    const notes = state.notes;
    const title = notes?.title?.[lane] || '';
    if (parts.title.textContent !== title) {
      const hadTitle = Boolean(parts.title.textContent);
      parts.title.textContent = title;
      if (title && !hadTitle) {
        animateSmooth(parts.title, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], 240);
      }
    }
    parts.title.hidden = !title;

    const summary = notes?.summary?.[lane] || '';
    if (parts.summary.textContent !== summary) {
      const hadSummary = Boolean(parts.summary.textContent);
      parts.summary.textContent = summary;
      if (summary && !hadSummary) {
        animateSmooth(parts.summary, [{ opacity: 0 }, { opacity: 1 }], 220);
      }
    }
    parts.summary.hidden = !summary;

    const points = (notes?.points || []).map(point => point[lane]).filter(Boolean);
    const before = shown.points[lane] || [];
    if (points.join('\n') !== before.join('\n')) {
      parts.points.replaceChildren(...points.map(text => {
        const item = el('li', before.includes(text) ? '' : 'mp-new', text);
        item.dir = 'auto';
        return item;
      }));
      shown.points[lane] = points;
    }
    parts.points.hidden = points.length === 0;
  }

  function renderVerseCard(lane, wasVisible) {
    const verse = state.verse;
    const following = Boolean(verse.following);
    const passage = verse.lanes?.[lane] || verse.lanes?.lang1;
    // The same verse in the spoken language's Bible (Cornilescu under KJV).
    const spoken = lane !== 'src' && state.settings?.spokenVerses ? verse.lanes?.src : null;
    const refLabel = followLabel(passage?.label, following);
    const primaryFirstText = passage?.verses?.[0]?.text || '';
    const primaryKey = `${lane}|${refLabel}|${passage?.version || ''}|${primaryFirstText}`;
    const contentKey = JSON.stringify([
      lane,
      following,
      refLabel,
      passage?.version || '',
      passage?.verses || [],
      Boolean(passage?.truncated),
      spoken ? followLabel(spoken.label, following) : '',
      spoken?.version || '',
      spoken?.verses || [],
      Boolean(spoken?.truncated)
    ]);

    if (contentKey !== shown.verseContentKey) {
      parts.verseRef.textContent = refLabel;
      parts.verseVersion.textContent = passage?.version || '';
      fillVerseText(parts.verseText, passage, { following });
      parts.verseText.hidden = !(passage?.verses?.length);

      parts.spoken.hidden = !(spoken?.verses?.length);
      if (spoken?.verses?.length) {
        parts.spokenRef.textContent = followLabel(spoken.label, following);
        parts.spokenVersion.textContent = spoken.version || '';
        fillVerseText(parts.spokenText, spoken, { following });
      }

      if (!wasVisible) {
        animateSmooth(parts.verse, [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'translateY(0)' }
        ], 240);
      } else if (primaryKey !== shown.versePrimaryKey) {
        animateSmooth(parts.verseText, [{ opacity: 0.72 }, { opacity: 1 }], 180);
        if (!parts.spoken.hidden) {
          animateSmooth(parts.spokenText, [{ opacity: 0.72 }, { opacity: 1 }], 180);
        }
      }

      shown.verseContentKey = contentKey;
      shown.versePrimaryKey = primaryKey;
    }

    // While following, the card stays as long as the reading goes on, so its
    // countdown would only jump back with every verse.
    parts.verseTimerTrack.hidden = following;
    if (following) {
      shown.verseTimer = null;
    } else {
      const check = shouldRestartTimer(shown.verseTimer, verse.id, verse.remainingMs);
      shown.verseTimer = check.next;
      if (check.restart) {
        startTimer(parts.verseTimer, verse.remainingMs, verse.durationMs);
      }
    }
  }

  function renderList(lane) {
    const items = (state.verses || []).slice(-LIST_LIMIT);
    const current = view.verses && verseActive() ? state.verse.key : '';
    const listKey = JSON.stringify([lane, current, items.map(item => [item.key, item.labels?.[lane] || item.labels?.lang1 || ''])]);
    if (listKey !== shown.listKey) {
      parts.list.replaceChildren(...items.map(item => {
        const chip = el('li', item.key === current ? 'current' : '', item.labels?.[lane] || item.labels?.lang1 || '');
        chip.dir = 'auto';
        return chip;
      }));
      shown.listKey = listKey;
    }
    parts.list.hidden = items.length === 0;
  }

  function renderPanel() {
    const lane = laneFor(view.mode);
    const single = view.mode !== 'both';
    const settings = state?.settings || {};
    const summary = view.summary && settings.notes;
    const showNotes = Boolean(state && summary && notesHaveContent(state.notes, lane));
    const showVerse = Boolean(state && view.verses && verseActive());
    // "Verses read" belongs to the notes, as in the recap.
    const showList = Boolean(state && summary && state.verses?.length);
    const visible = Boolean(state) && !view.obs && single && (showNotes || showVerse || showList);
    const bibleSize = settings.bibleSize || 'lg';
    panel.dataset.bibleSize = bibleSize;

    const wasVerseVisible = !panel.hidden && !parts.verse.hidden;
    panel.hidden = !visible;
    if (!visible) {
      shown.verseContentKey = '';
      shown.versePrimaryKey = '';
      shown.verseTimer = null;
      return;
    }
    if (showNotes) renderNotes(lane);
    parts.notes.hidden = !showNotes;
    parts.verse.hidden = !showVerse;
    if (showVerse) {
      renderVerseCard(lane, wasVerseVisible);
    } else {
      shown.verseContentKey = '';
      shown.versePrimaryKey = '';
      shown.verseTimer = null;
    }
    if (showList) renderList(lane);
    else parts.list.hidden = true;
    parts.scripture.hidden = !showVerse && !showList;
    const columns = showNotes && (showVerse || showList) ? 'both' : showNotes ? 'notes' : 'scripture';
    panel.dataset.columns = columns;

    // Only fit optional sermon summary notes; Bible text size is always fixed.
    if (showNotes) {
      const nextNotesFitKey = `${window.innerWidth}x${window.innerHeight}|${columns}|${parts.title.textContent}|${parts.summary.textContent}|${(shown.points[lane] || []).join('\n')}`;
      if (nextNotesFitKey !== shown.notesFitKey) {
        shown.notesFitKey = nextNotesFitKey;
        scheduleFit();
      }
    } else {
      shown.notesFitKey = '';
      panel.style.setProperty('--notes-scale', '1');
    }
  }

  // --- Two languages: a verse at the top of each half -------------------------
  function renderFloats() {
    const show = Boolean(state) && view.verses && !view.obs && view.mode === 'both' && verseActive();
    const bibleSize = state?.settings?.bibleSize || 'lg';
    for (const [lane, float] of Object.entries(floats)) {
      float.dataset.bibleSize = bibleSize;
      const passage = show ? (state.verse.lanes?.[lane]) : null;
      const wasVisible = !float.hidden;
      float.hidden = !passage;
      if (!passage) {
        shown.floatContentKeys[lane] = '';
        shown.floatPrimaryKeys[lane] = '';
        shown.floatTimers[lane] = null;
        continue;
      }
      const following = Boolean(state.verse.following);
      const refLabel = followLabel(passage.label, following);
      const limit = following ? 1 : 0;
      const shownVerses = (passage.verses || []).slice(0, limit || undefined);
      const primaryKey = `${lane}|${refLabel}|${shownVerses[0]?.text || ''}`;
      const contentKey = JSON.stringify([lane, following, refLabel, shownVerses, Boolean(passage.truncated)]);
      const text = float.querySelector('[data-part="text"]');

      if (contentKey !== shown.floatContentKeys[lane]) {
        float.querySelector('[data-part="ref"]').textContent = refLabel;
        fillVerseText(text, passage, { following, limit });
        text.hidden = !passage.verses?.length;

        if (!wasVisible) {
          animateSmooth(float, [
            { opacity: 0, transform: 'translateY(-4px)' },
            { opacity: 1, transform: 'translateY(0)' }
          ], 220);
        } else if (primaryKey !== shown.floatPrimaryKeys[lane]) {
          animateSmooth(text, [{ opacity: 0.72 }, { opacity: 1 }], 180);
        }

        shown.floatContentKeys[lane] = contentKey;
        shown.floatPrimaryKeys[lane] = primaryKey;
      }

      const bar = float.querySelector('[data-part="timer"]');
      bar.parentElement.hidden = following;
      if (following) {
        shown.floatTimers[lane] = null;
      } else {
        const check = shouldRestartTimer(shown.floatTimers[lane], state.verse.id, state.verse.remainingMs);
        shown.floatTimers[lane] = check.next;
        if (check.restart) {
          startTimer(bar, state.verse.remainingMs, state.verse.durationMs);
        }
      }
    }
  }

  // --- Recap over everything --------------------------------------------------
  function recapColumn(lane) {
    const notes = state.notes;
    const column = el('section', 'recap-column');
    column.dir = 'auto';
    if (notes?.title?.[lane]) column.append(el('h2', 'mp-title', notes.title[lane]));
    if (notes?.summary?.[lane]) column.append(el('p', 'mp-summary', notes.summary[lane]));
    const points = (notes?.points || []).map(point => point[lane]).filter(Boolean);
    if (points.length) {
      const list = el('ol', 'mp-points');
      list.append(...points.map(text => el('li', '', text)));
      column.append(list);
    }
    if (state.verses?.length) {
      const chips = el('ul', 'mp-verse-list');
      chips.append(...state.verses.slice(-LIST_LIMIT).map(item => el('li', '', item.labels?.[lane] || item.labels?.lang1 || '')));
      column.append(chips);
    }
    return column;
  }

  function renderRecap() {
    const lanes = view.mode === 'both'
      ? ['lang1', 'lang2'].filter(lane => notesHaveContent(state?.notes, lane))
      : [laneFor(view.mode)].filter(lane => notesHaveContent(state?.notes, lane));
    const show = Boolean(state) && view.summary && !view.obs && recapActive() && lanes.length > 0;
    const wasVisible = !recapOverlay.hidden;
    recapOverlay.hidden = !show;
    if (!show) {
      shown.recapKey = '';
      return;
    }
    const key = JSON.stringify([lanes, state.notes, state.verses?.map(item => item.labels)]);
    if (key !== shown.recapKey) {
      recapCard.replaceChildren(...lanes.map(recapColumn));
      recapCard.style.setProperty('--recap-scale', '1');
      if (!wasVisible) {
        animateSmooth(recapOverlay, [{ opacity: 0 }, { opacity: 1 }], 240);
      }
      shown.recapKey = key;
      scheduleFit();
    }
  }

  // --- Fitting long summary/recap notes into their box ------------------------
  // Never touches Bible verse font size; only scales optional summary notes or
  // the full-screen recap card when needed.
  function fitNotesContainer(container, target, property) {
    if (getComputedStyle(container).overflowY === 'auto') {
      target.style.setProperty(property, '1');
      return;
    }
    const style = getComputedStyle(container);
    const available = style.maxHeight !== 'none' ? Number.parseFloat(style.maxHeight) : container.clientHeight;
    if (!available || !container.offsetWidth) return;

    target.style.setProperty(property, '1');
    if (container.scrollHeight <= available + 1) return;

    let low = MIN_SCALE;
    let high = 1;
    for (let step = 0; step < 6; step++) {
      const middle = (low + high) / 2;
      target.style.setProperty(property, middle.toFixed(3));
      if (container.scrollHeight <= available + 1) low = middle;
      else high = middle;
    }
    target.style.setProperty(property, low.toFixed(3));
  }

  function scheduleFit() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      if (!panel.hidden && !parts.notes.hidden) fitNotesContainer(panel, panel, '--notes-scale');
      if (!recapOverlay.hidden) fitNotesContainer(recapCard, recapCard, '--recap-scale');
    });
  }

  function render() {
    renderPanel();
    renderFloats();
    renderRecap();
    scheduleExpiry();
  }

  window.addEventListener('resize', () => {
    shown.notesFitKey = '';
    if ((!panel.hidden && !parts.notes.hidden) || !recapOverlay.hidden) scheduleFit();
  }, { passive: true });

  return { update, setView };
}
