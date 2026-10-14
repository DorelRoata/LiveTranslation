// Shows message notes on the projector and phones. Subtitles are not touched:
// with one language on screen the subtitles keep the top half and this fills
// the bottom half; with two languages a verse floats at the top of each
// language's half, and the recap opens over everything when the operator asks.
const MIN_SCALE = 0.62;
const LIST_LIMIT = 8;

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

function restartAnimation(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
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
  const total = Math.max(durationMs || remainingMs, 1);
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.transform = `scaleX(${Math.min(1, remainingMs / total)})`;
  bar.style.animation = `verseTimer ${Math.max(remainingMs, 0)}ms linear forwards`;
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
  let view = { mode: 'lang1', obs: false, enabled: true };
  let verseUntil = 0;
  let recapUntil = 0;
  let expiryTimer = 0;
  let fitFrame = 0;
  const shown = { verseId: null, verseUntil: 0, floatIds: {}, points: {}, title: {}, recapKey: '' };

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
      parts.title.textContent = title;
      if (title) restartAnimation(parts.title, 'mp-fresh');
    }
    parts.title.hidden = !title;
    const summary = notes?.summary?.[lane] || '';
    if (parts.summary.textContent !== summary) {
      parts.summary.textContent = summary;
      if (summary) restartAnimation(parts.summary, 'mp-fresh');
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

  function renderVerseCard(lane) {
    const verse = state.verse;
    const following = Boolean(verse.following);
    const passage = verse.lanes?.[lane] || verse.lanes?.lang1;
    parts.verseRef.textContent = followLabel(passage?.label, following);
    parts.verseVersion.textContent = passage?.version || '';
    fillVerseText(parts.verseText, passage, { following });
    parts.verseText.hidden = !(passage?.verses?.length);

    // The same verse in the spoken language's Bible (Cornilescu under KJV).
    const spoken = lane !== 'src' && state.settings?.spokenVerses ? verse.lanes?.src : null;
    parts.spoken.hidden = !(spoken?.verses?.length);
    if (spoken?.verses?.length) {
      parts.spokenRef.textContent = followLabel(spoken.label, following);
      parts.spokenVersion.textContent = spoken.version || '';
      fillVerseText(parts.spokenText, spoken, { following });
    }

    // While following, the card stays as long as the reading goes on, so its
    // countdown would only jump back with every verse.
    parts.verseTimerTrack.hidden = following;
    const continuing = following && shown.following && shown.verseId !== null;
    if (shown.verseId !== verse.id) restartAnimation(continuing ? parts.verseText : parts.verse, continuing ? 'mp-advance' : 'mp-fresh');
    if (!following && (shown.verseId !== verse.id || shown.verseUntil !== verse.remainingMs)) {
      startTimer(parts.verseTimer, verse.remainingMs, verse.durationMs);
    }
    shown.verseId = verse.id;
    shown.verseUntil = verse.remainingMs;
    shown.following = following;
  }

  function renderList(lane) {
    const items = (state.verses || []).slice(-LIST_LIMIT);
    const current = verseActive() ? state.verse.key : '';
    parts.list.replaceChildren(...items.map(item => {
      const chip = el('li', item.key === current ? 'current' : '', item.labels?.[lane] || item.labels?.lang1 || '');
      chip.dir = 'auto';
      return chip;
    }));
    parts.list.hidden = items.length === 0;
  }

  function renderPanel() {
    const lane = laneFor(view.mode);
    const single = view.mode !== 'both';
    const settings = state?.settings || {};
    const showNotes = Boolean(state && settings.notes && notesHaveContent(state.notes, lane));
    const showVerse = Boolean(state && verseActive());
    const showList = Boolean(state && settings.notes && state.verses?.length);
    const visible = Boolean(state) && view.enabled && !view.obs && single && (showNotes || showVerse || showList);

    panel.hidden = !visible;
    if (!visible) {
      shown.verseId = null;
      return;
    }
    renderNotes(lane);
    parts.notes.hidden = !showNotes;
    parts.verse.hidden = !showVerse;
    if (showVerse) renderVerseCard(lane);
    else shown.verseId = null;
    if (showList) renderList(lane);
    else parts.list.hidden = true;
    parts.scripture.hidden = !showVerse && !showList;
    panel.dataset.columns = showNotes && (showVerse || showList) ? 'both' : showNotes ? 'notes' : 'scripture';
    scheduleFit();
  }

  // --- Two languages: a verse at the top of each half -------------------------
  function renderFloats() {
    const show = Boolean(state) && view.enabled && !view.obs && view.mode === 'both' && verseActive();
    for (const [lane, float] of Object.entries(floats)) {
      const passage = show ? (state.verse.lanes?.[lane]) : null;
      float.hidden = !passage;
      if (!passage) {
        shown.floatIds[lane] = null;
        continue;
      }
      const following = Boolean(state.verse.following);
      float.querySelector('[data-part="ref"]').textContent = followLabel(passage.label, following);
      const text = float.querySelector('[data-part="text"]');
      fillVerseText(text, passage, { following, limit: following ? 1 : 0 });
      text.hidden = !passage.verses?.length;
      const bar = float.querySelector('[data-part="timer"]');
      bar.parentElement.hidden = following;
      if (shown.floatIds[lane] !== `${state.verse.id}:${state.verse.remainingMs}`) {
        if (shown.floatIds[lane]?.split(':')[0] !== String(state.verse.id)) restartAnimation(following ? text : float, following ? 'mp-advance' : 'mp-fresh');
        if (!following) startTimer(bar, state.verse.remainingMs, state.verse.durationMs);
        shown.floatIds[lane] = `${state.verse.id}:${state.verse.remainingMs}`;
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
    const show = Boolean(state) && view.enabled && !view.obs && recapActive() && lanes.length > 0;
    recapOverlay.hidden = !show;
    if (!show) {
      shown.recapKey = '';
      return;
    }
    const key = JSON.stringify([lanes, state.notes, state.verses?.map(item => item.labels)]);
    if (key !== shown.recapKey) {
      recapCard.replaceChildren(...lanes.map(recapColumn));
      recapCard.style.setProperty('--recap-scale', '1');
      if (!shown.recapKey) restartAnimation(recapOverlay, 'mp-fresh');
      shown.recapKey = key;
      scheduleFit();
    }
  }

  // --- Fitting long notes into the space they have ---------------------------
  // Wrapped text does not shrink in proportion, so the size is found by a
  // binary search on an invisible copy; the real panel changes once, with no
  // flicker. Each try waits two frames: Chrome does not always apply a size
  // change to a synchronous read on this page.
  function nextFrames() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function fitElement(node, property) {
    const token = {};
    node.fitToken = token;
    // Phones scroll the notes instead of shrinking them.
    if (getComputedStyle(node).overflowY === 'auto') {
      node.style.setProperty(property, '1');
      return;
    }
    const style = getComputedStyle(node);
    const available = style.maxHeight !== 'none' ? Number.parseFloat(style.maxHeight) : node.clientHeight;
    const width = node.offsetWidth;
    if (!available || !width) return;

    const probe = node.cloneNode(true);
    probe.removeAttribute('id');
    probe.removeAttribute('aria-live');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `${node.style.cssText};position:absolute;top:0;left:0;width:${width}px;height:auto;max-height:none;visibility:hidden;pointer-events:none;`;
    node.parentNode.append(probe);

    const fitsAt = async scale => {
      probe.style.setProperty(property, scale.toFixed(3));
      await nextFrames();
      return probe.offsetHeight <= available + 1;
    };

    try {
      let best = 1;
      if (!(await fitsAt(1))) {
        let low = MIN_SCALE;
        let high = 1;
        for (let step = 0; step < 6 && node.fitToken === token; step++) {
          const middle = (low + high) / 2;
          if (await fitsAt(middle)) low = middle;
          else high = middle;
        }
        best = low;
      }
      if (node.fitToken === token) node.style.setProperty(property, best.toFixed(3));
    } finally {
      probe.remove();
    }
  }

  function scheduleFit() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      if (!panel.hidden) void fitElement(panel, '--mp-scale');
      if (!recapOverlay.hidden) void fitElement(recapCard, '--recap-scale');
    });
  }

  function render() {
    renderPanel();
    renderFloats();
    renderRecap();
    scheduleExpiry();
  }

  window.addEventListener('resize', scheduleFit, { passive: true });
  document.fonts?.ready.then(scheduleFit);

  return { update, setView };
}
