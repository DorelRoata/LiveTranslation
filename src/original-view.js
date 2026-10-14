// The spoken language as captions ("Română" in the projector's layout
// buttons), for anyone who wants to read along with the preacher, such as
// hard-of-hearing members. It is Google's transcript of what it hears, kept
// apart from the translated subtitles: their word queue and pacing are not
// used or changed here. The relay sends these words only while a screen
// shows them.

const KEEP_CHARS = 700;

// The language's own name for the layout button.
const NATIVE_NAMES = {
  ro: 'Română', en: 'English', ru: 'Русский', uk: 'Українська', es: 'Español', fr: 'Français', de: 'Deutsch',
  pt: 'Português', it: 'Italiano', pl: 'Polski', hu: 'Magyar', bg: 'Български', sr: 'Srpski'
};

export function nativeLanguageName(code, fallback = '') {
  return NATIVE_NAMES[String(code || '').toLowerCase()] || fallback;
}

export function createOriginalView({ section, element, send }) {
  let enabled = false;
  let seq = 0;
  let text = '';

  function trimmed(value) {
    if (value.length <= KEEP_CHARS) return value;
    const cut = value.slice(value.length - KEEP_CHARS);
    const boundary = cut.search(/\s/);
    return boundary === -1 ? cut : cut.slice(boundary + 1);
  }

  function redraw() {
    element.replaceChildren(document.createTextNode(text));
  }

  function appendPiece(piece) {
    text = trimmed(text + piece);
    // Drop text that has scrolled far out of view, then show the new words.
    if (element.textContent.length > KEEP_CHARS * 1.5) redraw();
    else {
      const span = document.createElement('span');
      span.className = 'sub-word';
      span.textContent = piece;
      element.append(span);
    }
  }

  return {
    setEnabled(on) {
      if (enabled === on) return;
      enabled = on;
      section.hidden = !on;
      send({ type: 'source-subscribe', on });
      if (!on) {
        seq = 0;
        text = '';
        element.replaceChildren();
      }
    },
    // After the screen reconnects to the host.
    resubscribe() {
      if (enabled) send({ type: 'source-subscribe', on: true });
    },
    handle(message) {
      if (!enabled) return;
      const full = typeof message.full === 'string' ? message.full : '';
      if (message.seq === seq + 1 && typeof message.text === 'string' && message.text) {
        seq = message.seq;
        appendPiece(seq === 1 ? message.text.trimStart() : message.text);
        return;
      }
      if (message.seq === seq) return;
      seq = Number(message.seq) || 0;
      text = trimmed(full);
      redraw();
    },
    clear() {
      seq = 0;
      text = '';
      element.replaceChildren();
    }
  };
}
