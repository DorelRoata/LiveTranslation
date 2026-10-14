// Dashboard card for message notes: the switches and buttons the operator
// uses, and a preview of what the screens show. The host keeps the settings,
// so the Mac and a laptop dashboard always agree.
import { parseReference, formatReference } from './bible-references.js';
import { DEFAULT_NOTES_SETTINGS, notesHaveContent } from './message-notes.js';

function formatAgo(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

function formatLeft(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`;
}

export function createNotesConsole({ send, log = () => {} }) {
  const $ = id => document.getElementById(id);
  const ui = {
    status: $('notes-status'),
    summaryToggle: $('notes-summary-toggle'),
    versesToggle: $('notes-verses-toggle'),
    followToggle: $('notes-follow-toggle'),
    spokenToggle: $('notes-spoken-toggle'),
    spokenLabel: $('notes-spoken-label'),
    onscreenLabel: document.querySelector('.notes-onscreen-label'),
    verseSeconds: $('notes-verse-seconds'),
    englishBible: $('notes-english-bible'),
    newMessage: $('notes-new-message-btn'),
    update: $('notes-update-btn'),
    recap: $('notes-recap-btn'),
    empty: $('notes-empty'),
    title: $('notes-preview-title'),
    summary: $('notes-preview-summary'),
    points: $('notes-preview-points'),
    onscreen: $('notes-onscreen'),
    onscreenRef: $('notes-onscreen-ref'),
    onscreenText: $('notes-onscreen-text'),
    onscreenLeft: $('notes-onscreen-left'),
    hideVerse: $('notes-hide-verse-btn'),
    form: $('notes-show-verse-form'),
    input: $('notes-verse-input'),
    hint: $('notes-verse-hint'),
    chips: $('notes-verse-chips'),
    chipsEmpty: $('notes-verses-empty')
  };

  let state = null;
  let receivedAt = 0;
  let connected = false;

  function remaining(item) {
    return item ? item.remainingMs - (performance.now() - receivedAt) : 0;
  }

  function command(action, extra = {}) {
    if (!send({ type: 'notes-command', action, ...extra })) {
      setHint('The screens relay is reconnecting. Try again in a moment.', true);
      return false;
    }
    return true;
  }

  function sendSettings(changes) {
    if (!send({ type: 'notes-settings', settings: changes })) {
      setHint('The screens relay is reconnecting. The change was not saved.', true);
      if (state) renderSettings(state.settings);
    }
  }

  function setHint(text, isError = false) {
    ui.hint.textContent = text;
    ui.hint.classList.toggle('error', isError);
  }

  function renderSettings(settings = DEFAULT_NOTES_SETTINGS) {
    ui.summaryToggle.checked = Boolean(settings.notes);
    ui.versesToggle.checked = Boolean(settings.verses);
    ui.followToggle.checked = settings.follow !== false;
    ui.spokenToggle.checked = settings.spokenVerses !== false;
    ui.followToggle.disabled = !settings.verses;
    ui.verseSeconds.value = String(settings.verseSeconds);
    ui.englishBible.value = settings.englishBible;
  }

  function renderStatus() {
    const status = state?.status || { state: 'waiting' };
    let text = '';
    let tone = status.state;
    if (!state?.settings?.notes) {
      text = 'Summary off — verses only';
      tone = 'off';
    } else if (status.state === 'updating') {
      text = 'Updating…';
    } else if (status.state === 'error') {
      text = status.detail || 'Notes could not be updated.';
    } else if (state?.notes?.updatedAt) {
      text = `Updated ${formatAgo(Date.now() - state.notes.updatedAt)}`;
      tone = 'ready';
    } else {
      text = status.detail || 'Waiting for about a minute of preaching';
      tone = 'waiting';
    }
    if (!connected) {
      text = 'Screens relay disconnected';
      tone = 'error';
    }
    ui.status.textContent = text;
    ui.status.dataset.state = tone;
  }

  function renderPreview() {
    const notes = state?.notes;
    const has = notesHaveContent(notes, 'lang1');
    ui.empty.hidden = has;
    ui.title.textContent = notes?.title?.lang1 || '';
    ui.title.hidden = !ui.title.textContent;
    ui.summary.textContent = notes?.summary?.lang1 || '';
    ui.summary.hidden = !ui.summary.textContent;
    const points = (notes?.points || []).map(point => point.lang1).filter(Boolean);
    ui.points.replaceChildren(...points.map(text => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
    ui.points.hidden = points.length === 0;
    ui.update.disabled = !state?.settings?.notes || state?.status?.state === 'updating';
  }

  function renderVerse() {
    const verse = state?.verse;
    const left = remaining(verse);
    const active = Boolean(verse) && left > 0;
    ui.onscreen.hidden = !active;
    if (!active) return;
    const passage = verse.lanes?.lang1;
    const following = Boolean(verse.following);
    ui.onscreenLabel.textContent = following ? 'Reading now' : 'Verse on screens';
    ui.onscreenRef.textContent = following
      ? String(passage?.label || formatReference(verse.ref)).replace(/[–-]\d+$/, '')
      : passage?.label || formatReference(verse.ref);
    const shownVerses = following ? (passage?.verses || []).slice(0, 1) : passage?.verses || [];
    ui.onscreenText.textContent = shownVerses.length
      ? shownVerses.map(item => item.text).join(' ') + (passage.truncated && !following ? ' …' : '')
      : 'Reference only — no verse text for this Bible.';
    ui.onscreenLeft.textContent = formatLeft(left);
  }

  function renderChips() {
    const items = state?.verses || [];
    const current = state?.verse && remaining(state.verse) > 0 ? state.verse.key : '';
    ui.chips.replaceChildren(...items.map(item => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `notes-chip${item.key === current ? ' current' : ''}`;
      button.textContent = item.labels?.lang1 || item.key;
      button.title = item.key === current ? 'On the screens now' : 'Show this verse on the screens again';
      button.addEventListener('click', () => command('show-verse', { key: item.key }));
      li.append(button);
      return li;
    }));
    ui.chipsEmpty.hidden = items.length > 0;
  }

  function renderRecap() {
    const open = Boolean(state?.recap) && remaining(state.recap) > 0;
    ui.recap.setAttribute('aria-pressed', String(open));
    ui.recap.textContent = open ? 'Hide recap' : 'Show recap';
    ui.recap.disabled = !open && !notesHaveContent(state?.notes, 'lang1');
  }

  function render() {
    renderStatus();
    renderPreview();
    renderVerse();
    renderChips();
    renderRecap();
  }

  function update(nextState) {
    if (!nextState) return;
    const firstState = !state;
    state = nextState;
    receivedAt = performance.now();
    if (firstState || document.activeElement?.closest?.('.notes-controls') == null) renderSettings(state.settings);
    if (state.source?.name) ui.spokenLabel.textContent = `Verses also in ${state.source.name}`;
    render();
  }

  function setConnected(value) {
    connected = Boolean(value);
    renderStatus();
  }

  function showError(message) {
    setHint(message, true);
    log(`Message notes: ${message}`, 'error');
  }

  // A one-line summary for Copy Status.
  function describe() {
    if (!state) return 'not connected';
    const settings = state.settings || {};
    const parts = [
      `summary ${settings.notes ? 'on' : 'off'}`,
      `verse pop-ups ${settings.verses ? `on (${settings.verseSeconds}s)` : 'off'}`,
      `follow reading ${settings.follow ? 'on' : 'off'}`,
      `spoken-language verses ${settings.spokenVerses ? 'on' : 'off'}${state.source?.name ? ` (${state.source.name})` : ''}`,
      `status ${state.status?.state || 'unknown'}${state.status?.detail ? ` (${state.status.detail})` : ''}`,
      `${state.verses?.length || 0} verse(s) read`
    ];
    return parts.join(', ');
  }

  ui.summaryToggle.addEventListener('change', () => sendSettings({ notes: ui.summaryToggle.checked }));
  ui.versesToggle.addEventListener('change', () => sendSettings({ verses: ui.versesToggle.checked }));
  ui.followToggle.addEventListener('change', () => sendSettings({ follow: ui.followToggle.checked }));
  ui.spokenToggle.addEventListener('change', () => sendSettings({ spokenVerses: ui.spokenToggle.checked }));
  ui.verseSeconds.addEventListener('change', () => sendSettings({ verseSeconds: Number(ui.verseSeconds.value) }));
  ui.englishBible.addEventListener('change', () => sendSettings({ englishBible: ui.englishBible.value }));

  ui.newMessage.addEventListener('click', () => {
    const hasContent = notesHaveContent(state?.notes, 'lang1') || state?.verses?.length;
    if (hasContent && !window.confirm('Start notes for a new message? The current summary and verses list will be cleared from the screens.')) return;
    if (command('new-message')) setHint('Notes cleared for the next message.');
  });
  ui.update.addEventListener('click', () => command('update-now'));
  ui.recap.addEventListener('click', () => {
    command(ui.recap.getAttribute('aria-pressed') === 'true' ? 'hide-recap' : 'show-recap');
  });
  ui.hideVerse.addEventListener('click', () => command('hide-verse'));

  ui.form.addEventListener('submit', event => {
    event.preventDefault();
    const text = ui.input.value.trim();
    if (!text) return;
    const ref = parseReference(text);
    if (!ref) {
      setHint(`"${text}" is not a reference I recognise. Try "John 3:16", "Romans 8:28-30" or "Psalm 23".`, true);
      return;
    }
    if (command('show-verse', { reference: text })) {
      setHint(`${formatReference(ref)} is on the screens.`);
      ui.input.value = '';
    }
  });

  // Countdown and "updated … ago" stay current between host messages.
  setInterval(() => {
    if (!state) return;
    renderStatus();
    renderVerse();
    renderRecap();
  }, 1000);

  renderSettings();
  render();
  return { update, setConnected, showError, describe };
}
