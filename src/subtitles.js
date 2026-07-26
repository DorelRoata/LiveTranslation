import QRCode from 'qrcode';
import { createScreenWakeLock } from './wake-lock.js';

// Error Handler
window.onerror = function (msg, url, line) {
  const errDiv = document.getElementById('debug-error-log') || document.createElement('div');
  errDiv.id = 'debug-error-log';
  errDiv.style.position = 'absolute';
  errDiv.style.bottom = '1rem';
  errDiv.style.left = '1rem';
  errDiv.style.background = 'rgba(239, 68, 68, 0.9)';
  errDiv.style.color = '#fff';
  errDiv.style.padding = '0.5rem 1rem';
  errDiv.style.borderRadius = '8px';
  errDiv.style.fontSize = '0.8rem';
  errDiv.style.zIndex = '9999';
  errDiv.style.fontFamily = 'monospace';
  errDiv.textContent = `JS Error: ${msg} at line ${line}`;
  document.body.appendChild(errDiv);
  return false;
};

let subtitleState = {
  lang1: { accumulatedText: "" },
  lang2: { accumulatedText: "" },
  targetLanguage1: "",
  targetLanguage2: "",
  isDual: false
};

// Client-side display state to store immutable locked lines
let displayState = {
  lang1: {
    lines: [],
    activeLine: "",
    lastText: ""
  },
  lang2: {
    lines: [],
    activeLine: "",
    lastText: ""
  }
};

// Queues to store incoming words for smooth streaming
let wordQueue = {
  lang1: [],
  lang2: []
};

// DOM Elements
const statusIndicator = document.getElementById('status-indicator');
const controlBar = document.getElementById('control-bar');
const btnViewBoth = document.getElementById('btn-view-both');
const btnViewLang1 = document.getElementById('btn-view-lang1');
const btnViewLang2 = document.getElementById('btn-view-lang2');
const btnAudioToggle = document.getElementById('btn-audio-toggle');
const btnWakeLock = document.getElementById('btn-wake-lock');
const secLang1 = document.getElementById('sec-lang1');
const secLang2 = document.getElementById('sec-lang2');

// QR DOM Elements
const btnQrToggle = document.getElementById('btn-qr-toggle');
const qrOverlay = document.getElementById('qr-overlay');
const btnQrClose = document.getElementById('btn-qr-close');
const qrCanvasProjector = document.getElementById('qr-canvas-projector');
const qrUrlText = document.getElementById('qr-url-text');

// UI state configurations
let viewMode = 'both'; // 'both', 'lang1', 'lang2'
let audioEnabled = false;

const wakeLock = createScreenWakeLock(({ status, supported, desired, active }) => {
  btnWakeLock.classList.toggle('audio-active', active);
  btnWakeLock.disabled = !supported;
  btnWakeLock.setAttribute('aria-pressed', String(desired));

  if (!supported) {
    btnWakeLock.textContent = 'Unavailable';
    btnWakeLock.title = 'This browser does not support keeping the screen awake.';
  } else if (active) {
    btnWakeLock.textContent = 'Awake';
    btnWakeLock.title = 'Tap to allow normal screen dimming.';
  } else if (desired && (status === 'blocked' || status === 'released')) {
    btnWakeLock.textContent = 'Tap to Keep Awake';
    btnWakeLock.title = 'Tap to retry. Low Power Mode may prevent this feature.';
  } else if (desired) {
    btnWakeLock.textContent = 'Keep Awake';
    btnWakeLock.title = 'The screen will stay awake after browser permission is granted.';
  } else {
    btnWakeLock.textContent = 'Keep Awake';
    btnWakeLock.title = 'Tap to prevent the screen from dimming.';
  }
});

const savedWakePreference = localStorage.getItem('subtitles_keep_awake');
wakeLock.setEnabled(savedWakePreference !== 'false');

btnWakeLock.addEventListener('click', async () => {
  if (!wakeLock.isSupported()) return;
  if (wakeLock.isDesired() && !wakeLock.isActive()) {
    await wakeLock.request();
    return;
  }
  const enabled = !wakeLock.isDesired();
  localStorage.setItem('subtitles_keep_awake', String(enabled));
  await wakeLock.setEnabled(enabled);
});

window.addEventListener('pointerdown', () => {
  if (wakeLock.isDesired() && !wakeLock.isActive()) wakeLock.request();
}, { capture: true, once: true });

window.addEventListener('pagehide', () => wakeLock.dispose(), { once: true });

// Audio contexts & playback state
let audioContext = null;
let nextStartTime1 = 0;
let nextStartTime2 = 0;
let subtitleSocket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;

// Language code to full names mappings for buttons
const LANG_NAMES = {
  'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
  'it': 'Italian', 'ro': 'Romanian', 'ja': 'Japanese', 'ru': 'Russian',
  'zh-Hans': 'Chinese (Simp)', 'zh-Hant': 'Chinese (Trad)', 'pt': 'Portuguese',
  'ko': 'Korean', 'pl': 'Polish', 'hi': 'Hindi', 'ar': 'Arabic',
  'tr': 'Turkish', 'vi': 'Vietnamese'
};

function getLanguageName(code, fallback) {
  if (!code) return fallback;
  return LANG_NAMES[code.toLowerCase()] || code.toUpperCase();
}

// Auto-hide app chrome after inactivity on both pointer and touch devices.
let controlsTimeout;
function setControlsHidden(hidden) {
  controlBar.classList.toggle('hidden', hidden);
  statusIndicator.classList.toggle('chrome-hidden', hidden);
}

function resetControlsTimer() {
  setControlsHidden(false);
  clearTimeout(controlsTimeout);
  controlsTimeout = setTimeout(() => {
    if (!controlBar.matches(':hover') && !controlBar.matches(':focus-within')) {
      setControlsHidden(true);
    }
  }, 3000);
}
window.addEventListener('pointermove', resetControlsTimer, { passive: true });
window.addEventListener('pointerdown', resetControlsTimer, { passive: true });
window.addEventListener('touchmove', resetControlsTimer, { passive: true });
window.addEventListener('keydown', resetControlsTimer);
window.addEventListener('focusin', resetControlsTimer);
resetControlsTimer();

function refreshVisibleLanes() {
  if (viewMode !== 'lang2') rebuildSubtitleDOM('lang1');
  if (viewMode !== 'lang1') rebuildSubtitleDOM('lang2');
}

// View toggling logic
btnViewBoth.addEventListener('click', () => {
  viewMode = 'both';
  updateUIElements();
  refreshVisibleLanes();
});
btnViewLang1.addEventListener('click', () => {
  viewMode = 'lang1';
  updateUIElements();
  refreshVisibleLanes();
});
btnViewLang2.addEventListener('click', () => {
  viewMode = 'lang2';
  updateUIElements();
  refreshVisibleLanes();
});

// Audio Playback context initialisation and toggling
btnAudioToggle.addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  if (audioEnabled) {
    initAudioContext();
    btnAudioToggle.classList.add('audio-active');
    btnAudioToggle.textContent = 'Enabled';
    btnAudioToggle.setAttribute('aria-pressed', 'true');
  } else {
    btnAudioToggle.classList.remove('audio-active');
    btnAudioToggle.textContent = 'Disabled';
    btnAudioToggle.setAttribute('aria-pressed', 'false');
  }
});

function initAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000
    });
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Robust overlapping suffix checker to find newly appended characters (handles left-truncated strings)
function getAppendedText(oldStr, newStr) {
  if (!newStr) return "";
  if (!oldStr) return newStr;

  // 1. Check if newStr starts with a substring of oldStr starting at index k (handles left-truncated history)
  for (let k = 0; k < oldStr.length; k++) {
    const sub = oldStr.substring(k);
    if (newStr.startsWith(sub)) {
      return newStr.substring(sub.length);
    }
  }

  // 2. Check if a suffix of oldStr matches a prefix of newStr
  for (let i = Math.min(oldStr.length, newStr.length); i > 0; i--) {
    const suffix = oldStr.substring(oldStr.length - i);
    if (newStr.startsWith(suffix)) {
      return newStr.substring(i);
    }
  }

  return newStr;
}

// Tracks the active-line DOM element per lane so we can append words incrementally
const activeDOMLine = { lang1: null, lang2: null };

function rebuildSubtitleDOM(lane, populateActive = true) {
  if (viewMode === 'lang1' && lane !== 'lang1') return;
  if (viewMode === 'lang2' && lane !== 'lang2') return;

  const element = document.getElementById(`sub-${lane}`);
  if (!element) return;

  // Full rebuild: history lines + fresh active line element
  const historyLines = displayState[lane].lines.slice(-2);
  let html = historyLines
    .map(line => `<div class="sub-line">${escapeHtml(line)}</div>`)
    .join("");

  // Create an empty active line container
  html += `<div class="sub-line-active"></div>`;

  element.innerHTML = html;

  // Cache reference to the active line element for incremental appends
  activeDOMLine[lane] = element.querySelector('.sub-line-active');

  if (populateActive) {
    // Re-populate active line words that already exist in state (after a line break)
    const activeWords = displayState[lane].activeLine.split(/\s+/).filter(Boolean);
    activeWords.forEach(word => {
      appendWordSpan(lane, word, false); // no animation for already-visible words
    });
  }
}

function appendWordSpan(lane, word, animate = true) {
  if (viewMode === 'lang1' && lane !== 'lang1') return;
  if (viewMode === 'lang2' && lane !== 'lang2') return;

  const container = activeDOMLine[lane];
  if (!container) {
    // Fallback: if no cached container, do a full rebuild
    rebuildSubtitleDOM(lane);
    return;
  }

  // Add a space before the word if there are already children
  if (container.childNodes.length > 0) {
    container.appendChild(document.createTextNode(' '));
  }

  const span = document.createElement('span');
  span.textContent = word;
  if (animate) {
    span.className = 'sub-word';
  }
  container.appendChild(span);
}

function appendWordToDisplayState(lane, word) {
  let active = displayState[lane].activeLine;
  const fallbackMaxChars = 60;
  let didBreakLine = false;

  if (active) {
    // Check if the current active line ends with sentence punctuation (. ? !)
    const endsWithPunctuation = /[.?!]$/.test(active);

    // Check if adding the new word would exceed the character limit
    const wouldExceedLimit = (active.length + 1 + word.length) > fallbackMaxChars;

    if (endsWithPunctuation || wouldExceedLimit) {
      displayState[lane].lines.push(active);
      active = "";
      didBreakLine = true;
    }
  }

  // Append the new word
  active = active ? active + " " + word : word;
  displayState[lane].activeLine = active;

  while (displayState[lane].lines.length > 10) {
    displayState[lane].lines.shift();
  }

  return didBreakLine;
}

// rAF-based ticker state: last word timestamp per lane
const lastTickTime = { lang1: 0, lang2: 0 };

function getTickDelay(lane) {
  const qLen = wordQueue[lane].length;
  if (qLen > 10) return 30;   // High speed catch-up
  if (qLen > 5)  return 70;   // Medium speed catch-up
  if (qLen > 2)  return 110;  // Low speed catch-up
  if (qLen > 0)  return 160;  // Natural pacing (~370 wpm)
  return 0; // Nothing to do
}

function tickLane(lane, now) {
  if (wordQueue[lane].length === 0) return;

  const delay = getTickDelay(lane);
  if (now - lastTickTime[lane] < delay) return;

  lastTickTime[lane] = now;

  const nextWord = wordQueue[lane].shift();
  const didBreak = appendWordToDisplayState(lane, nextWord);

  if (didBreak) {
    // Line was finalized → full DOM rebuild (history changed)
    rebuildSubtitleDOM(lane, false);
    appendWordSpan(lane, nextWord, true);

    // Add an extra pause after a line break so the user can read the completed line
    const qLen = wordQueue[lane].length;
    const breakPause = qLen > 10 ? 150 : 350;
    lastTickTime[lane] += breakPause;
  } else {
    // Just append a single word span (no layout thrashing)
    appendWordSpan(lane, nextWord);
  }
}

function rafLoop(timestamp) {
  tickLane('lang1', timestamp);
  tickLane('lang2', timestamp);
  requestAnimationFrame(rafLoop);
}

// Start the vsync-locked render loop
requestAnimationFrame(rafLoop);

function renderSubtitleLane(lane) {
  const state = subtitleState[lane];
  
  if (!state.accumulatedText || state.accumulatedText === "-" || state.accumulatedText === "") {
    displayState[lane] = {
      lines: [],
      activeLine: "",
      lastText: ""
    };
    wordQueue[lane] = [];
    rebuildSubtitleDOM(lane);
  } else {
    const oldText = displayState[lane].lastText;
    const newText = state.accumulatedText;
    displayState[lane].lastText = newText;
    
    // If this is an initial sync (page refresh / first connect), populate the
    // display state directly so the text appears instantly instead of fast-
    // forwarding hundreds of words through the animation queue.
    if (!oldText && newText.length > 0) {
      const allWords = newText.split(/\s+/).filter(Boolean);
      displayState[lane].lines = [];
      displayState[lane].activeLine = "";
      
      for (const word of allWords) {
        appendWordToDisplayState(lane, word);
      }
      
      rebuildSubtitleDOM(lane);
      return;
    }
    
    const appended = getAppendedText(oldText, newText);
    if (appended) {
      const newWords = appended.split(/\s+/).filter(Boolean);
      wordQueue[lane].push(...newWords);
    }
  }
}

function renderInterimSubtitle(lane, text) {
  renderSubtitleLane(lane);
}

function updateUIElements() {
  // 1. Language buttons text
  btnViewLang1.textContent = getLanguageName(subtitleState.targetLanguage1, 'Language 1');
  
  const isDualAvailable = subtitleState.isDual && subtitleState.targetLanguage2 !== 'none';
  if (isDualAvailable) {
    btnViewLang2.style.display = 'inline-block';
    btnViewLang2.textContent = getLanguageName(subtitleState.targetLanguage2, 'Language 2');
    btnViewBoth.style.display = 'inline-block';
  } else {
    btnViewLang2.style.display = 'none';
    btnViewBoth.style.display = 'none';
    if (viewMode === 'both' || viewMode === 'lang2') {
      viewMode = 'lang1';
    }
  }

  // 2. Active buttons selection styling
  btnViewBoth.classList.toggle('active', viewMode === 'both');
  btnViewLang1.classList.toggle('active', viewMode === 'lang1');
  btnViewLang2.classList.toggle('active', viewMode === 'lang2');
  btnViewBoth.setAttribute('aria-pressed', String(viewMode === 'both'));
  btnViewLang1.setAttribute('aria-pressed', String(viewMode === 'lang1'));
  btnViewLang2.setAttribute('aria-pressed', String(viewMode === 'lang2'));

  // 3. Grid Columns Visibility
  if (viewMode === 'both') {
    secLang1.classList.remove('hidden');
    secLang1.style.display = 'flex';
    secLang2.classList.remove('hidden');
    secLang2.style.display = 'flex';
  } else if (viewMode === 'lang1') {
    secLang1.classList.remove('hidden');
    secLang1.style.display = 'flex';
    secLang2.classList.add('hidden');
  } else if (viewMode === 'lang2') {
    secLang1.classList.add('hidden');
    secLang2.classList.remove('hidden');
    secLang2.style.display = 'flex';
  }
}

// Audio Playback Engine
function playPCMChunk(base64Data, channelId) {
  if (!audioEnabled || !audioContext) return;

  // Drop audio playback if that language is currently hidden by View Mode
  if (viewMode === 'lang1' && channelId !== 1) return;
  if (viewMode === 'lang2' && channelId !== 2) return;

  try {
    initAudioContext();

    // 1. Decode base64
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 2. Convert raw little-endian 16-bit PCM bytes to Float32
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }

    // 3. Create AudioBuffer
    const audioBuffer = audioContext.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);

    // 4. Connect source node
    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(audioContext.destination);

    const now = audioContext.currentTime;
    let nextStart = channelId === 1 ? nextStartTime1 : nextStartTime2;
    if (nextStart < now) {
      nextStart = now;
    }

    sourceNode.start(nextStart);

    if (channelId === 1) {
      nextStartTime1 = nextStart + audioBuffer.duration;
    } else {
      nextStartTime2 = nextStart + audioBuffer.duration;
    }
  } catch (err) {
    console.error("Subtitles player failed to play PCM audio:", err);
  }
}

function connect() {
  if (subtitleSocket && (subtitleSocket.readyState === WebSocket.OPEN || subtitleSocket.readyState === WebSocket.CONNECTING)) return;
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/local-subtitles-ws`;
  
  statusIndicator.style.backgroundColor = "#f59e0b"; // Yellow (Connecting)
  statusIndicator.style.boxShadow = "0 0 8px #f59e0b";
  statusIndicator.title = "Connecting to Host...";
  statusIndicator.setAttribute('aria-label', 'Connecting to host');
  
  const socket = new WebSocket(wsUrl);
  subtitleSocket = socket;

  let totalMsgs = 0;

  socket.onopen = () => {
    if (subtitleSocket !== socket) return;
    clearTimeout(reconnectTimer);
    reconnectAttempt = 0;
    statusIndicator.style.backgroundColor = "#10b981"; // Green (Connected)
    statusIndicator.style.boxShadow = "0 0 8px #10b981";
    statusIndicator.title = "Connected to Host";
    statusIndicator.setAttribute('aria-label', 'Connected to host');
  };

  socket.onmessage = (event) => {
    if (subtitleSocket !== socket) return;
    totalMsgs++;

    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'sync') {
        subtitleState = data.state;
        
        updateUIElements();
        renderSubtitleLane("lang1");
        renderSubtitleLane("lang2");
      } else if (data.type === 'update') {
        renderInterimSubtitle(data.lane, data.text);
      } else if (data.type === 'audio') {
        playPCMChunk(data.audioData, data.channelId);
      } else if (data.type === 'clear') {
        if (subtitleState && subtitleState.lang1) {
          subtitleState.lang1.accumulatedText = "";
        }
        if (subtitleState && subtitleState.lang2) {
          subtitleState.lang2.accumulatedText = "";
        }
        displayState.lang1 = { lines: [], activeLine: "", lastText: "" };
        displayState.lang2 = { lines: [], activeLine: "", lastText: "" };
        wordQueue.lang1 = [];
        wordQueue.lang2 = [];
        activeDOMLine.lang1 = null;
        activeDOMLine.lang2 = null;
        
        const sec1 = document.getElementById("sub-lang1");
        if (sec1) sec1.innerHTML = "-";
        const sec2 = document.getElementById("sub-lang2");
        if (sec2) sec2.innerHTML = "-";
      }
    } catch (err) {
      console.error("Error parsing WebSocket message:", err);
    }
  };

  socket.onclose = () => {
    if (subtitleSocket !== socket) return;
    subtitleSocket = null;
    statusIndicator.style.backgroundColor = "#ef4444"; // Red (Disconnected)
    statusIndicator.style.boxShadow = "0 0 8px #ef4444";
    statusIndicator.title = "Disconnected (Retrying...)";
    statusIndicator.setAttribute('aria-label', 'Disconnected. Retrying connection');
    const delay = Math.min(1000 * (2 ** reconnectAttempt), 8000);
    reconnectAttempt++;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  };

  socket.onerror = () => {
    if (subtitleSocket !== socket) return;
    socket.close();
  };
}

// --- QR Code Toggle and Render Code ---
let subtitlesUrl = `${window.location.protocol}//${window.location.host}/subtitles.html`;
qrUrlText.textContent = subtitlesUrl;

// Fetch network IP to use for QR codes instead of localhost
async function initProjectorSharingQR() {
  try {
    const res = await fetch('/api/network-ip');
    const data = await res.json();
    const port = window.location.port ? `:${window.location.port}` : '';
    subtitlesUrl = `${window.location.protocol}//${data.ip}${port}/subtitles.html`;
    qrUrlText.textContent = subtitlesUrl;
  } catch (err) {
    console.error("Could not fetch network IP for QR code:", err);
  }
}
initProjectorSharingQR();

btnQrToggle.addEventListener('click', () => {
  qrOverlay.classList.remove('hidden');
  qrOverlay.setAttribute('aria-hidden', 'false');
  btnQrClose.focus();
  
  // Render QR Code
  QRCode.toCanvas(qrCanvasProjector, subtitlesUrl, {
    width: 250,
    margin: 1,
    color: {
      dark: '#000000',
      light: '#ffffff'
    },
    errorCorrectionLevel: 'M'
  }, function (error) {
    if (error) console.error("Projector QR Code error:", error);
  });
});

function closeQrOverlay() {
  qrOverlay.classList.add('hidden');
  qrOverlay.setAttribute('aria-hidden', 'true');
  btnQrToggle.focus();
}

// Close when Close button clicked
btnQrClose.addEventListener('click', closeQrOverlay);

// Close when clicking anywhere on background overlay
qrOverlay.addEventListener('click', (event) => {
  if (event.target === qrOverlay) {
    closeQrOverlay();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !qrOverlay.classList.contains('hidden')) {
    closeQrOverlay();
  }
});

// --- OBS Broadcast Mode ---
// If the URL contains ?obs=true, enable transparent backgrounds and hide controls
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('obs') === 'true') {
  document.body.classList.add('obs-mode');
}

connect();
