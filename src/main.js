import './style.css';
import QRCode from 'qrcode';

// --- Constants ---
const HOST = "generativelanguage.googleapis.com";
const API_VERSION = "v1alpha";
const PATH = `ws/google.ai.generativelanguage.${API_VERSION}.GenerativeService.BidiGenerateContent`;
const MODEL = "models/gemini-3.5-live-translate-preview";
const MAX_BUFFERED_AUDIO_BYTES = 256 * 1024;
const SETUP_TIMEOUT_MS = 15_000;
const OPERATOR_SETTINGS_KEY = 'live_translate_operator_settings_v1';
const DEFAULT_SYSTEM_INSTRUCTION = 'You are a professional church sermon interpreter. The speaker is preaching in Romanian. Translate their sermon accurately, maintain a respectful and formal religious/church tone, and translate into the target language.';
const DEFAULT_OPERATOR_SETTINGS = Object.freeze({
  audioSource: 'mic',
  microphoneDevice: 'default',
  targetLanguage1: 'en',
  targetLanguage2: 'none',
  playVoice1: true,
  playVoice2: true,
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
  echoTargetLanguage: false,
  localSpeaker: false,
  localVolume: 1,
  transcriptFontSize: 'md'
});

// --- State Variables ---
let socket1 = null;
let socket2 = null;
let audioContextInput = null;
let audioContextOutput = null;
let micStream = null;
let scriptProcessor = null;
let audioCaptureGeneration = 0;

let nextStartTime1 = 0;
let nextStartTime2 = 0;
let activeSources1 = [];
let activeSources2 = [];
let isRunning = false;
let isStarting = false;
let reconnectTimeout = null;
let reconnectAttempt = 0;
let setupTimeout = null;
let sessionGeneration = 0;
let sessionApiKey = '';
let sessionConfig = null;
const socketSetupReady = { 1: false, 2: false };
let subtitleWindow = null;
let localSubtitlesWS = null;
let localReconnectTimeout = null;
let localReconnectAttempt = 0;
let remoteAudioStreaming = false;

// New Features State
let isMicMuted = false;
let sessionTimerInterval = null;
let sessionStartTime = 0;
let totalWordsCount = 0;

const subtitleState = {
  lang1: { accumulatedText: "" },
  lang2: { accumulatedText: "" }
};

// Audio Visualizer buffers (last 512 samples)
const micBuffer = new Float32Array(512);
const outBuffer = new Float32Array(512);

// UI Elements
const apiKeyInput = document.getElementById("api-key-input");
const toggleApiKeyBtn = document.getElementById("toggle-api-key");
const apiKeyStatus = document.getElementById("api-key-status");
const audioSourceSelect = document.getElementById("audio-source-select");
const micDeviceGroup = document.getElementById("mic-device-group");
const micDeviceSelect = document.getElementById("mic-device-select");
const systemInstructionInput = document.getElementById("system-instruction-input");

const targetLanguageSelect1 = document.getElementById("target-language-select-1");
const playVoiceCheckbox1 = document.getElementById("play-voice-1");
const targetLanguageSelect2 = document.getElementById("target-language-select-2");
const playVoiceCheckbox2 = document.getElementById("play-voice-2");

const echoToggle = document.getElementById("echo-toggle");
const startBtn = document.getElementById("start-btn");
const subtitlesBtn = document.getElementById("subtitles-btn");
const streamerBtn = document.getElementById("streamer-btn");
const connectionStatus = document.getElementById("connection-status");
const networkDisconnectWarning = document.getElementById("network-disconnect-warning");

const muteMicBtn = document.getElementById("mute-mic-btn");
const muteMicLabel = document.getElementById("mute-mic-label");
const sessionTimerEl = document.getElementById("session-timer");
const wordCounterEl = document.getElementById("word-counter");
const transcriptGridEl = document.getElementById("transcript-grid");

const micDb = document.getElementById("mic-db");
const outputDb = document.getElementById("output-db");
const micCanvas = document.getElementById("mic-canvas");
const outputCanvas = document.getElementById("output-canvas");

const inputList = document.getElementById("input-transcript-list");
const inputPlaceholder = document.getElementById("input-placeholder");

const outputList1 = document.getElementById("output-transcript-list-1");
const outputPlaceholder1 = document.getElementById("output-placeholder-1");
const outputList2 = document.getElementById("output-transcript-list-2");
const outputPlaceholder2 = document.getElementById("output-placeholder-2");

const clearInputBtn = document.getElementById("clear-input-log");
const clearOutputBtn1 = document.getElementById("clear-output-log-1");
const clearOutputBtn2 = document.getElementById("clear-output-log-2");
const debugLogList = document.getElementById("debug-log-list");
const clearDebugBtn = document.getElementById("clear-debug-log");
const reconnectNowBtn = document.getElementById('reconnect-now-btn');
const restartAudioBtn = document.getElementById('restart-audio-btn');
const checkUpdatesBtn = document.getElementById('check-updates-btn');
const copyDiagnosticsBtn = document.getElementById('copy-diagnostics-btn');
const resetSettingsBtn = document.getElementById('reset-settings-btn');
const diagnosticBanner = document.getElementById('diagnostic-banner');
const diagnosticMessage = document.getElementById('diagnostic-message');
const connectionRecoveryBanner = document.getElementById('connection-recovery-banner');
const connectionRecoveryDetail = document.getElementById('connection-recovery-detail');
const healthItems = {
  local: document.getElementById('health-local'),
  gemini1: document.getElementById('health-gemini-1'),
  gemini2: document.getElementById('health-gemini-2'),
  audio: document.getElementById('health-audio')
};
const healthSnapshot = {
  local: { state: 'connecting', detail: 'Connecting...' },
  gemini1: { state: 'idle', detail: 'Not started' },
  gemini2: { state: 'idle', detail: 'Not enabled' },
  audio: { state: 'idle', detail: 'Not started' }
};
const mediaSupported = Boolean(navigator.mediaDevices?.getUserMedia);
const localPlaybackToggle = document.getElementById('local-playback-toggle');
const hostVolumeSlider = document.getElementById('host-volume-slider');
let preferredMicDeviceId = DEFAULT_OPERATOR_SETTINGS.microphoneDevice;

const micIndicator = document.querySelector(".input-pulse");
const outputIndicator1 = document.querySelector(".output-pulse-1");
const outputIndicator2 = document.querySelector(".output-pulse-2");

// --- Remembered Operator Settings ---
function selectHasValue(select, value) {
  return Array.from(select.options).some(option => option.value === value);
}

function setSelectValue(select, value, fallback) {
  select.value = selectHasValue(select, value) ? value : fallback;
}

function setTranscriptFontSize(size) {
  const safeSize = ['sm', 'md', 'lg', 'xl'].includes(size) ? size : DEFAULT_OPERATOR_SETTINGS.transcriptFontSize;
  document.querySelectorAll('.font-size-btn').forEach(btn => {
    const isActive = btn.dataset.size === safeSize;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  if (transcriptGridEl) transcriptGridEl.className = `transcript-grid font-${safeSize}`;
  return safeSize;
}

function applyOperatorSettings(settings) {
  setSelectValue(audioSourceSelect, settings.audioSource, DEFAULT_OPERATOR_SETTINGS.audioSource);
  setSelectValue(targetLanguageSelect1, settings.targetLanguage1, DEFAULT_OPERATOR_SETTINGS.targetLanguage1);
  setSelectValue(targetLanguageSelect2, settings.targetLanguage2, DEFAULT_OPERATOR_SETTINGS.targetLanguage2);
  preferredMicDeviceId = typeof settings.microphoneDevice === 'string'
    ? settings.microphoneDevice
    : DEFAULT_OPERATOR_SETTINGS.microphoneDevice;
  playVoiceCheckbox1.checked = typeof settings.playVoice1 === 'boolean' ? settings.playVoice1 : DEFAULT_OPERATOR_SETTINGS.playVoice1;
  playVoiceCheckbox2.checked = typeof settings.playVoice2 === 'boolean' ? settings.playVoice2 : DEFAULT_OPERATOR_SETTINGS.playVoice2;
  systemInstructionInput.value = typeof settings.systemInstruction === 'string'
    ? settings.systemInstruction
    : DEFAULT_OPERATOR_SETTINGS.systemInstruction;
  echoToggle.checked = typeof settings.echoTargetLanguage === 'boolean'
    ? settings.echoTargetLanguage
    : DEFAULT_OPERATOR_SETTINGS.echoTargetLanguage;
  localPlaybackToggle.checked = typeof settings.localSpeaker === 'boolean'
    ? settings.localSpeaker
    : DEFAULT_OPERATOR_SETTINGS.localSpeaker;
  const volume = Number(settings.localVolume);
  hostVolumeSlider.value = String(Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_OPERATOR_SETTINGS.localVolume);
  setTranscriptFontSize(settings.transcriptFontSize);
  micDeviceGroup.style.display = audioSourceSelect.value === 'mic' ? 'block' : 'none';
}

function getOperatorSettings() {
  const activeFontButton = document.querySelector('.font-size-btn.active');
  return {
    audioSource: audioSourceSelect.value,
    microphoneDevice: preferredMicDeviceId,
    targetLanguage1: targetLanguageSelect1.value,
    targetLanguage2: targetLanguageSelect2.value,
    playVoice1: playVoiceCheckbox1.checked,
    playVoice2: playVoiceCheckbox2.checked,
    systemInstruction: systemInstructionInput.value,
    echoTargetLanguage: echoToggle.checked,
    localSpeaker: localPlaybackToggle.checked,
    localVolume: Number(hostVolumeSlider.value),
    transcriptFontSize: activeFontButton?.dataset.size || DEFAULT_OPERATOR_SETTINGS.transcriptFontSize
  };
}

function saveOperatorSettings() {
  try {
    localStorage.setItem(OPERATOR_SETTINGS_KEY, JSON.stringify(getOperatorSettings()));
    localStorage.removeItem('gemini_system_instruction');
    localStorage.removeItem('transcript_font_size');
  } catch (error) {
    console.warn('Unable to save operator settings:', error);
  }
}

function loadOperatorSettings() {
  let savedSettings = {};
  try {
    savedSettings = JSON.parse(localStorage.getItem(OPERATOR_SETTINGS_KEY) || '{}');
    if (!savedSettings || typeof savedSettings !== 'object' || Array.isArray(savedSettings)) savedSettings = {};
    const legacyInstruction = localStorage.getItem('gemini_system_instruction');
    const legacyFontSize = localStorage.getItem('transcript_font_size');
    if (typeof savedSettings.systemInstruction !== 'string' && legacyInstruction !== null) {
      savedSettings.systemInstruction = legacyInstruction;
    }
    if (!savedSettings.transcriptFontSize && legacyFontSize) savedSettings.transcriptFontSize = legacyFontSize;
  } catch (error) {
    console.warn('Unable to load operator settings:', error);
  }
  applyOperatorSettings({ ...DEFAULT_OPERATOR_SETTINGS, ...savedSettings });
  saveOperatorSettings();
}

loadOperatorSettings();

// --- API Key Runtime Configuration ---
async function loadStoredApiKey() {
  try {
    const response = await fetch('/api/config/api-key', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to read API key configuration.');

    const legacyKey = localStorage.getItem('gemini_api_key')?.trim();
    if (!data.configured && legacyKey) {
      data.apiKey = legacyKey;
      if (legacyKey.length >= 20 && legacyKey.length <= 500) {
        try {
          await saveApiKey(legacyKey);
          data.configured = true;
        } catch (error) {
          data.warning = 'The old browser key could not be migrated. Review it and save again by starting translation.';
        }
      } else {
        data.warning = 'The old browser key appears incomplete. Enter a valid Gemini API key.';
      }
      localStorage.removeItem('gemini_api_key');
    }
    if (data.configured) localStorage.removeItem('gemini_api_key');

    apiKeyInput.value = data.apiKey || '';
    apiKeyStatus.textContent = data.warning || (data.configured
      ? 'Saved in this computer\'s private LiveTranslation settings.'
      : 'Enter once. The key will be saved outside the repository on this computer.');
    apiKeyStatus.classList.toggle('error', Boolean(data.warning));
    if (data.warning) setDiagnostic(data.warning, 'warning');
    apiKeyInput.disabled = false;
    startBtn.disabled = !mediaSupported;
  } catch (error) {
    apiKeyInput.disabled = true;
    startBtn.disabled = true;
    apiKeyStatus.textContent = error.message;
    apiKeyStatus.classList.add('error');
    setDiagnostic(`API key settings could not be loaded: ${error.message}`, 'error');
  }
}

async function saveApiKey(apiKey) {
  const response = await fetch('/api/config/api-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to save the API key.');
  apiKeyStatus.textContent = 'Saved in this computer\'s private LiveTranslation settings.';
  apiKeyStatus.classList.remove('error');
}

apiKeyInput.disabled = true;
startBtn.disabled = true;

apiKeyInput.addEventListener('input', () => {
  apiKeyStatus.textContent = 'The key will be saved when translation starts.';
  apiKeyStatus.classList.remove('error');
});

loadStoredApiKey();

systemInstructionInput.addEventListener('input', saveOperatorSettings);
targetLanguageSelect1.addEventListener('change', saveOperatorSettings);
targetLanguageSelect2.addEventListener('change', saveOperatorSettings);
playVoiceCheckbox1.addEventListener('change', saveOperatorSettings);
playVoiceCheckbox2.addEventListener('change', saveOperatorSettings);
echoToggle.addEventListener('change', saveOperatorSettings);
localPlaybackToggle.addEventListener('change', saveOperatorSettings);
hostVolumeSlider.addEventListener('input', saveOperatorSettings);
micDeviceSelect.addEventListener('change', () => {
  preferredMicDeviceId = micDeviceSelect.value || DEFAULT_OPERATOR_SETTINGS.microphoneDevice;
  saveOperatorSettings();
});

resetSettingsBtn.addEventListener('click', () => {
  if (!window.confirm('Reset operator settings to their defaults? The saved Gemini API key will not be removed.')) return;
  applyOperatorSettings(DEFAULT_OPERATOR_SETTINGS);
  saveOperatorSettings();
  setDiagnostic('Operator settings restored to defaults. Local Speaker and Echo Target Language are off.', 'good');
});

// Toggle API Key Visibility
toggleApiKeyBtn.addEventListener("click", () => {
  if (apiKeyInput.type === "password") {
    apiKeyInput.type = "text";
    toggleApiKeyBtn.setAttribute('aria-label', 'Hide API Key');
    toggleApiKeyBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>
    `;
  } else {
    apiKeyInput.type = "password";
    toggleApiKeyBtn.setAttribute('aria-label', 'Show API Key');
    toggleApiKeyBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
    `;
  }
});

// --- Microphone Input Device Selector ---
audioSourceSelect.addEventListener("change", async () => {
  saveOperatorSettings();
  if (audioSourceSelect.value === "mic") {
    micDeviceGroup.style.display = "block";
  } else {
    micDeviceGroup.style.display = "none";
  }
  
  if (audioSourceSelect.value === "network") {
    const qrDetails = document.querySelector(".qr-details");
    if (qrDetails) qrDetails.open = true;
  } else if (networkDisconnectWarning) {
    networkDisconnectWarning.style.display = 'none';
  }

  if (isRunning) {
    audioSourceSelect.disabled = true;
    logDebug(`Switching audio source to ${audioSourceSelect.value}...`, "info");
    stopAudioCapture();
    try {
      await startAudioCapture();
    } catch (err) {
      if (err.name !== 'AbortError') logDebug(`Failed to switch audio source: ${err.message}`, "error");
    } finally {
      audioSourceSelect.disabled = false;
      restartAudioBtn.disabled = !isRunning || audioSourceSelect.value === 'network';
    }
  }
});

async function populateMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    micDeviceSelect.innerHTML = "";
    
    // Add default option
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "default";
    defaultOpt.textContent = "Default System Microphone";
    micDeviceSelect.appendChild(defaultOpt);
    
    devices.forEach(device => {
      if (device.kind === 'audioinput') {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone (${device.deviceId.substring(0, 5)})`;
        if (device.deviceId !== 'default' && device.deviceId !== '') {
          micDeviceSelect.appendChild(option);
        }
      }
    });
    micDeviceSelect.value = selectHasValue(micDeviceSelect, preferredMicDeviceId)
      ? preferredMicDeviceId
      : DEFAULT_OPERATOR_SETTINGS.microphoneDevice;
    preferredMicDeviceId = micDeviceSelect.value;
  } catch (err) {
    console.warn("Unable to list microphone devices:", err);
  }
}

// Request permissions on first load to populate labels, otherwise fallback to enumerate
if (mediaSupported) {
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      populateMicDevices();
      stream.getTracks().forEach(t => t.stop());
    })
    .catch(() => populateMicDevices());
} else {
  setHealthItem('audio', 'error', 'Browser media support unavailable');
  setDiagnostic('This browser cannot access microphones. Open LiveTranslation in a current version of Chrome, Edge, or Safari.', 'error');
  startBtn.disabled = true;
}

// Clear Logs
clearInputBtn.addEventListener("click", () => {
  inputList.innerHTML = "";
  inputPlaceholder.style.display = "block";
});
clearOutputBtn1.addEventListener("click", () => {
  outputList1.innerHTML = "";
  outputPlaceholder1.style.display = "block";
});
clearOutputBtn2.addEventListener("click", () => {
  outputList2.innerHTML = "";
  outputPlaceholder2.style.display = "block";
});

const clearProjectorBtn = document.getElementById("btn-clear-projector");
clearProjectorBtn?.addEventListener("click", () => {
  // Clear local host UI
  inputList.innerHTML = "";
  inputPlaceholder.style.display = "block";
  outputList1.innerHTML = "";
  outputPlaceholder1.style.display = "block";
  outputList2.innerHTML = "";
  outputPlaceholder2.style.display = "block";
  
  // Clear local subtitle state
  subtitleState.lang1.accumulatedText = "";
  subtitleState.lang2.accumulatedText = "";
  
  // Broadcast clear command
  if (isSocketOpen(localSubtitlesWS)) {
    localSubtitlesWS.send(JSON.stringify({ type: 'clear' }));
  }
});

// --- Helper: Convert Int16Array to Base64 ---
function base64ArrayBuffer(arrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function isSocketOpen(ws, requireSetup = false, channelId = 0) {
  return Boolean(
    ws &&
    ws.readyState === WebSocket.OPEN &&
    (!requireSetup || socketSetupReady[channelId])
  );
}

function canSendAudio(ws, requireSetup = false, channelId = 0) {
  return isSocketOpen(ws, requireSetup, channelId) && ws.bufferedAmount <= MAX_BUFFERED_AUDIO_BYTES;
}

function setHealthItem(name, state, detail) {
  const item = healthItems[name];
  if (!item) return;
  item.dataset.state = state;
  item.querySelector('.health-detail').textContent = detail;
  healthSnapshot[name] = { state, detail };
}

function setDiagnostic(message, state = 'idle') {
  diagnosticBanner.dataset.state = state;
  diagnosticMessage.textContent = message;
}

function showRecoveryBanner(detail) {
  connectionRecoveryDetail.textContent = detail;
  connectionRecoveryBanner.hidden = false;
}

function hideRecoveryBanner() {
  connectionRecoveryBanner.hidden = true;
}

function setSessionSettingsDisabled(disabled) {
  apiKeyInput.disabled = disabled;
  targetLanguageSelect1.disabled = disabled;
  targetLanguageSelect2.disabled = disabled;
  echoToggle.disabled = disabled;
  systemInstructionInput.disabled = disabled;
  resetSettingsBtn.disabled = disabled;
}

async function copyDiagnostics() {
  const labels = {
    local: 'Local Relay',
    gemini1: 'Gemini 1',
    gemini2: 'Gemini 2',
    audio: 'Audio Input'
  };
  const statusLines = Object.entries(healthSnapshot)
    .filter(([name]) => name !== 'gemini2' || !healthItems.gemini2.hidden)
    .map(([name, value]) => `${labels[name]}: ${value.state} - ${value.detail}`);
  const recentLogs = Array.from(debugLogList.children).slice(-8).map(line => line.textContent);
  const report = [
    'Live Translate v1.2.0 diagnostics',
    `Time: ${new Date().toISOString()}`,
    `Browser online: ${navigator.onLine}`,
    `Audio source: ${audioSourceSelect.value}`,
    ...statusLines,
    `Operator message: ${diagnosticMessage.textContent}`,
    '',
    'Recent status log:',
    ...recentLogs
  ].join('\n');

  try {
    await navigator.clipboard.writeText(report);
    const previousText = copyDiagnosticsBtn.textContent;
    copyDiagnosticsBtn.textContent = 'Copied';
    setTimeout(() => { copyDiagnosticsBtn.textContent = previousText; }, 1500);
  } catch (error) {
    logDebug('Could not copy diagnostics. Browser clipboard permission was denied.', 'error');
  }
}

copyDiagnosticsBtn.addEventListener('click', copyDiagnostics);
checkUpdatesBtn.addEventListener('click', async () => {
  checkUpdatesBtn.disabled = true;
  checkUpdatesBtn.textContent = 'Checking...';
  try {
    const response = await fetch('/api/update/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Update check failed.');

    if (!data.supportedBranch) {
      setDiagnostic(`Automatic updates require the main branch. This checkout is on ${data.branch}.`, 'warning');
    } else if (data.updateAvailable) {
      const localChanges = data.dirty ? ' Local changes must be committed or stashed first.' : '';
      setDiagnostic(`Update available: ${data.currentCommit} to ${data.remoteCommit}. Quit and reopen the Dock app to install it.${localChanges}`, 'warning');
    } else if (data.diverged) {
      setDiagnostic('This checkout differs from GitHub and cannot be updated automatically. Review it in Git before updating.', 'warning');
    } else {
      setDiagnostic(`Live Translate is up to date (${data.currentCommit}).`, 'good');
    }
  } catch (error) {
    setDiagnostic(error.message, 'error');
  } finally {
    checkUpdatesBtn.disabled = false;
    checkUpdatesBtn.textContent = 'Check Updates';
  }
});

reconnectNowBtn.addEventListener('click', () => {
  if (!isRunning) return;
  clearTimeout(reconnectTimeout);
  reconnectTimeout = null;
  reconnectAttempt = 0;
  updateConnectionStatus('connecting', 'Reconnecting...');
  showRecoveryBanner('Manual reconnect started. Your subtitles are preserved and live audio is paused instead of being queued.');
  setDiagnostic('Manual reconnect started. Audio capture and subtitles are being preserved.', 'warning');
  logDebug('Operator requested an immediate Gemini reconnect.', 'warning');
  connectGeminiSockets();
});

restartAudioBtn.addEventListener('click', async () => {
  if (!isRunning) return;
  restartAudioBtn.disabled = true;
  setDiagnostic('Restarting the selected audio source. Gemini connections will stay open.', 'warning');
  stopAudioCapture();
  try {
    await startAudioCapture();
    setDiagnostic('Audio input restarted successfully.', 'good');
    logDebug('Audio input restarted successfully.', 'info');
  } catch (error) {
    if (error.name !== 'AbortError') {
      setHealthItem('audio', 'error', 'Restart failed');
      logDebug(`Audio restart failed: ${error.message}`, 'error');
    }
  } finally {
    restartAudioBtn.disabled = !isRunning || audioSourceSelect.value === 'network';
  }
});

// --- Debug Logging Utility ---
let chunksSent = 0;

function logDebug(message, type = "info") {
  if (!debugLogList) return;
  const line = document.createElement("div");
  line.className = `debug-line ${type}`;
  let color = "#d6d2ca";
  let prefix = "[System]";
  
  if (type === "error") {
    color = "#f87171";
    prefix = "[Error]";
  } else if (type === "ws-sent") {
    color = "#f0a08d";
    prefix = "[Sent]";
  } else if (type === "ws-recv") {
    color = "#34d399";
    prefix = "[Recv]";
  } else if (type === "audio") {
    color = "#fbbf24";
    prefix = "[Audio]";
  }
  
  line.style.color = color;
  line.textContent = `${prefix} ${new Date().toLocaleTimeString()} - ${message}`;
  debugLogList.appendChild(line);
  debugLogList.scrollTop = debugLogList.scrollHeight;
  
  while (debugLogList.children.length > 100) {
    debugLogList.removeChild(debugLogList.firstChild);
  }

  if (type === 'error') setDiagnostic(message, 'error');
}

clearDebugBtn.addEventListener("click", () => {
  debugLogList.innerHTML = `<div class="debug-line" style="color: #71808a;">[System] Logs cleared.</div>`;
});

// --- Visualizer Rendering ---
function initVisualizer(canvas, dataBuffer, color) {
  const ctx = canvas.getContext("2d");
  
  const resizeCanvas = () => {
    canvas.width = canvas.clientWidth * window.devicePixelRatio;
    canvas.height = canvas.clientHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  };
  
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  function draw() {
    requestAnimationFrame(draw);
    
    const width = canvas.width / window.devicePixelRatio;
    const height = canvas.height / window.devicePixelRatio;
    
    ctx.clearRect(0, 0, width, height);
    
    ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    const sliceWidth = width / dataBuffer.length;
    let x = 0;
    
    for (let i = 0; i < dataBuffer.length; i++) {
      const v = dataBuffer[i] * 2;
      const y = (v + 1) * (height / 2);
      
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      
      x += sliceWidth;
    }
    
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    
    for (let i = 0; i < dataBuffer.length; i++) {
      dataBuffer[i] *= 0.92;
    }
  }
  
  draw();
}

// Start visualizer loops
initVisualizer(micCanvas, micBuffer, "#df6178");
initVisualizer(outputCanvas, outBuffer, "#5bc0a4");

// --- Audio Playback Pipeline (Gemini Output) ---
function initOutputAudio() {
  if (!audioContextOutput) {
    audioContextOutput = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000
    });
    nextStartTime1 = 0;
    nextStartTime2 = 0;
  }
  if (audioContextOutput.state === "suspended") {
    audioContextOutput.resume();
  }
}

function playPCMChunk(base64Data, channelId) {
  initOutputAudio();
  
  const isPlayChecked = channelId === 1 ? playVoiceCheckbox1.checked : playVoiceCheckbox2.checked;
  
  // Stream to subtitles screen if enabled on main page
  if (isPlayChecked && canSendAudio(localSubtitlesWS)) {
    localSubtitlesWS.send(JSON.stringify({
      type: 'audio',
      channelId: channelId,
      audioData: base64Data
    }));
  }
  
  // 1. Convert base64 back to raw binary data
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  // 2. Decode raw little-endian 16-bit PCM bytes to Float32
  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  
  let maxVal = 0;
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768.0;
    if (Math.abs(float32[i]) > maxVal) {
      maxVal = Math.abs(float32[i]);
    }
  }
  
  // Feed output visualizer buffer (mix channels if both playing)
  const step = Math.max(1, Math.floor(float32.length / outBuffer.length));
  for (let i = 0; i < outBuffer.length; i++) {
    const idx = Math.min(float32.length - 1, i * step);
    outBuffer[i] = outBuffer[i] * 0.3 + float32[idx] * 0.7;
  }
  
  // Update UI volume text
  const pct = Math.round(maxVal * 100);
  outputDb.textContent = `${pct}%`;
  
  // If mute is active for this channel, do not schedule playing
  if (!isPlayChecked) {
    return;
  }
  
  // 3. Create AudioBuffer
  const audioBuffer = audioContextOutput.createBuffer(1, float32.length, 24000);
  audioBuffer.copyToChannel(float32, 0);
  
  // 4. Schedule source playing
  const sourceNode = audioContextOutput.createBufferSource();
  sourceNode.buffer = audioBuffer;
  
  const isLocalMuted = localPlaybackToggle ? !localPlaybackToggle.checked : false;

  const hostVolume = isLocalMuted ? 0 : parseFloat(hostVolumeSlider?.value ?? 1);
  const gainNode = audioContextOutput.createGain();
  gainNode.gain.value = hostVolume;
  sourceNode.connect(gainNode);
  gainNode.connect(audioContextOutput.destination);
  
  const now = audioContextOutput.currentTime;
  let nextStart = channelId === 1 ? nextStartTime1 : nextStartTime2;
  if (nextStart < now) {
    nextStart = now;
  }
  
  sourceNode.start(nextStart);
  
  if (channelId === 1) {
    activeSources1.push(sourceNode);
    outputIndicator1.classList.add("active");
    sourceNode.onended = () => {
      activeSources1 = activeSources1.filter(s => s !== sourceNode);
      if (activeSources1.length === 0) {
        outputIndicator1.classList.remove("active");
      }
    };
    nextStartTime1 = nextStart + audioBuffer.duration;
  } else {
    activeSources2.push(sourceNode);
    outputIndicator2.classList.add("active");
    sourceNode.onended = () => {
      activeSources2 = activeSources2.filter(s => s !== sourceNode);
      if (activeSources2.length === 0) {
        outputIndicator2.classList.remove("active");
      }
    };
    nextStartTime2 = nextStart + audioBuffer.duration;
  }
}

function stopAllPlayback() {
  activeSources1.forEach(source => { try { source.stop(); } catch (e) {} });
  activeSources2.forEach(source => { try { source.stop(); } catch (e) {} });
  activeSources1 = [];
  activeSources2 = [];
  nextStartTime1 = 0;
  nextStartTime2 = 0;
  outputIndicator1.classList.remove("active");
  outputIndicator2.classList.remove("active");
  outputDb.textContent = "0%";
}

// --- Audio Capture Pipeline (Mic Input) ---
async function startAudioCapture() {
  const captureGeneration = ++audioCaptureGeneration;
  const sourceVal = audioSourceSelect.value;
  setHealthItem('audio', 'connecting', sourceVal === 'network' ? 'Waiting for remote sender' : 'Requesting audio access');
  if (sourceVal === "network") {
    logDebug("Network audio source selected. Ready to receive audio stream from another PC...", "info");
    setHealthItem('audio', remoteAudioStreaming ? 'good' : 'warning', remoteAudioStreaming ? 'Remote microphone active' : 'Waiting for remote sender');
    return;
  }
  
  if (!navigator.mediaDevices) {
    throw new Error("navigator.mediaDevices is not available. Please make sure you are accessing this application via http://localhost:5173/ in your browser URL bar. Browsers block microphone and audio sharing on local file:// files for security.");
  }

  logDebug(`Initializing capture context for: ${sourceVal}...`, "info");

  const captureContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 16000
  });
  let captureStream = null;
  let captureProcessor = null;
  let captureSource = null;

  try {
    if (sourceVal === "system") {
      logDebug("Requesting getDisplayMedia for system audio loopback...", "info");
      captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { systemAudio: "include" }
      });

      logDebug("getDisplayMedia stream obtained. Discarding video tracks...", "info");
      captureStream.getVideoTracks().forEach(track => track.stop());
      if (captureStream.getAudioTracks().length === 0) {
        throw new Error("No system audio track shared. When prompted, make sure to check 'Share system audio' or 'Share tab audio' in the sharing dialog.");
      }
      logDebug("System audio loopback track captured successfully.", "info");
    } else {
      logDebug("Requesting getUserMedia for microphone access...", "info");
      const micConstraints = {
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        }
      };
      if (micDeviceSelect.value && micDeviceSelect.value !== 'default') {
        micConstraints.audio.deviceId = { exact: micDeviceSelect.value };
      }
      captureStream = await navigator.mediaDevices.getUserMedia(micConstraints);
      logDebug("Microphone captured successfully.", "info");
    }

    if (captureContext.state === 'suspended') await captureContext.resume();
    if (captureGeneration !== audioCaptureGeneration) {
      const cancelledError = new Error('Audio capture was cancelled.');
      cancelledError.name = 'AbortError';
      throw cancelledError;
    }
    captureSource = captureContext.createMediaStreamSource(captureStream);
    captureProcessor = captureContext.createScriptProcessor(2048, 1, 1);
    chunksSent = 0;
  } catch (error) {
    captureProcessor?.disconnect();
    captureSource?.disconnect();
    captureStream?.getTracks().forEach(track => track.stop());
    await captureContext.close().catch(() => {});
    if (captureGeneration === audioCaptureGeneration && error.name !== 'AbortError') {
      setHealthItem('audio', 'error', error.message);
    }
    throw error;
  }

  audioContextInput = captureContext;
  micStream = captureStream;
  scriptProcessor = captureProcessor;
  setHealthItem('audio', 'good', sourceVal === 'system' ? 'System audio active' : 'Microphone active');

  scriptProcessor.onaudioprocess = (e) => {
    const socket1Ready = canSendAudio(socket1, true, 1);
    const socket2Ready = canSendAudio(socket2, true, 2);
    if (!socket1Ready && !socket2Ready) return;
    
    if (isMicMuted) {
      micDb.textContent = "Muted";
      micIndicator.classList.remove("active");
      return;
    }
    
    const float32 = e.inputBuffer.getChannelData(0);
    
    let maxVal = 0;
    const pcm16 = new Int16Array(float32.length);
    
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1.0, Math.min(1.0, float32[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      if (Math.abs(s) > maxVal) {
        maxVal = Math.abs(s);
      }
    }
    
    const step = Math.max(1, Math.floor(float32.length / micBuffer.length));
    for (let i = 0; i < micBuffer.length; i++) {
      const idx = Math.min(float32.length - 1, i * step);
      micBuffer[i] = micBuffer[i] * 0.3 + float32[idx] * 0.7;
    }
    
    const pct = Math.round(maxVal * 100);
    micDb.textContent = `${pct}%`;
    if (pct > 5) {
      micIndicator.classList.add("active");
    } else {
      micIndicator.classList.remove("active");
    }
    
    // Send PCM chunk
    const base64Data = base64ArrayBuffer(pcm16.buffer);
    const mediaMsg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: base64Data
          }
        ]
      }
    };
    
    const msgStr = JSON.stringify(mediaMsg);
    if (socket1Ready) {
      socket1.send(msgStr);
    }
    if (socket2Ready) {
      socket2.send(msgStr);
    }
    
    chunksSent++;
    if (chunksSent % 25 === 0) {
      logDebug(`Sent ${chunksSent} audio chunks to Google...`, "ws-sent");
    }
  };
  
  captureSource.connect(scriptProcessor);
  scriptProcessor.connect(audioContextInput.destination);

  for (const track of micStream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (!isRunning) return;
      logDebug('The selected audio source ended. Translation is still connected.', 'error');
      setHealthItem('audio', 'error', 'Audio source ended');
      micIndicator.classList.remove('active');
      micDb.textContent = 'Ended';
    }, { once: true });
  }
}

function stopAudioCapture() {
  audioCaptureGeneration++;
  if (audioSourceSelect.value === "network") {
    logDebug("Stopped listening for network audio stream.", "info");
  }
  
  // Unconditionally destroy local mic resources to prevent stream overlap and Gemini errors
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
  if (audioContextInput) {
    audioContextInput.close();
    audioContextInput = null;
  }
  
  micIndicator.classList.remove("active");
  micDb.textContent = "0%";
  setHealthItem('audio', 'idle', 'Not started');
}

// --- New Dashboard Features Helpers ---

// 1. Session Timer & Word Counter
function startSessionTimer() {
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  sessionStartTime = Date.now();
  totalWordsCount = 0;
  updateWordCounterUI();

  sessionTimerInterval = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
    const hrs = String(Math.floor(elapsedSeconds / 3600)).padStart(2, '0');
    const mins = String(Math.floor((elapsedSeconds % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsedSeconds % 60).padStart(2, '0');
    if (sessionTimerEl) {
      sessionTimerEl.textContent = `⏱️ ${hrs}:${mins}:${secs}`;
    }
  }, 1000);
}

function stopSessionTimer() {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
}

function incrementWordCount(text) {
  if (!text) return;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > 0) {
    totalWordsCount += words;
    updateWordCounterUI();
  }
}

function updateWordCounterUI() {
  if (wordCounterEl) {
    wordCounterEl.textContent = `📝 ${totalWordsCount.toLocaleString()} words`;
  }
}

// 2. Live Mic Mute Toggle
if (muteMicBtn) {
  muteMicBtn.addEventListener("click", () => {
    isMicMuted = !isMicMuted;
    if (isMicMuted) {
      muteMicBtn.classList.add("is-muted");
      muteMicBtn.setAttribute('aria-pressed', 'true');
      if (muteMicLabel) muteMicLabel.textContent = "Mic Muted";
      micDb.textContent = "Muted";
      micIndicator.classList.remove("active");
      logDebug("Microphone paused (muted). Gemini session remains connected.", "warning");
    } else {
      muteMicBtn.classList.remove("is-muted");
      muteMicBtn.setAttribute('aria-pressed', 'false');
      if (muteMicLabel) muteMicLabel.textContent = "Mute Mic";
      micDb.textContent = "0%";
      logDebug("Microphone unmuted. Resuming live audio capture.", "info");
    }
  });
}

// 3. Dynamic Font Size Picker
function initFontSizePicker() {
  const fontBtns = document.querySelectorAll(".font-size-btn");

  fontBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const size = btn.getAttribute("data-size");
      setTranscriptFontSize(size);
      saveOperatorSettings();
    });
  });
}

initFontSizePicker();

function addInputTranscript(text) {
  inputPlaceholder.style.display = "none";
  incrementWordCount(text);
  
  const bubble = document.createElement("div");
  bubble.className = "transcript-bubble";
  bubble.textContent = text;
  
  const ts = document.createElement("span");
  ts.className = "timestamp";
  ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  bubble.appendChild(ts);
  
  inputList.appendChild(bubble);
  
  // Cap input transcript list to max 100 items to prevent memory leaks
  while (inputList.children.length > 100) {
    inputList.removeChild(inputList.firstChild);
  }
  
  document.getElementById("input-transcript-scroll").scrollTop = document.getElementById("input-transcript-scroll").scrollHeight;
}

let currentStreamingBubble1 = null;
let currentStreamingBubble2 = null;

function updateOutputTranscript(text, channelId, isFinal = false) {
  const placeholder = channelId === 1 ? outputPlaceholder1 : outputPlaceholder2;
  const list = channelId === 1 ? outputList1 : outputList2;
  let currentBubble = channelId === 1 ? currentStreamingBubble1 : currentStreamingBubble2;
  const scrollContainer = document.getElementById(`output-transcript-scroll-${channelId}`);
  
  placeholder.style.display = "none";
  
  if (!currentBubble) {
    currentBubble = document.createElement("div");
    currentBubble.className = "transcript-bubble";
    list.appendChild(currentBubble);
    
    // Cap output transcript list to max 100 items to prevent memory leaks
    while (list.children.length > 100) {
      list.removeChild(list.firstChild);
    }
    
    if (channelId === 1) {
      currentStreamingBubble1 = currentBubble;
    } else {
      currentStreamingBubble2 = currentBubble;
    }
  }
  
  if (isFinal) {
    currentBubble.textContent = text;
    currentBubble.classList.remove("streaming-text");
    incrementWordCount(text);
    
    const ts = document.createElement("span");
    ts.className = "timestamp";
    ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    currentBubble.appendChild(ts);
    if (channelId === 1) {
      currentStreamingBubble1 = null;
    } else {
      currentStreamingBubble2 = null;
    }
  } else {
    currentBubble.textContent = text + "...";
    currentBubble.classList.add("streaming-text");
  }
  
  scrollContainer.scrollTop = scrollContainer.scrollHeight;
}

function finalizeOutputTranscript(channelId) {
  let currentBubble = channelId === 1 ? currentStreamingBubble1 : currentStreamingBubble2;
  if (currentBubble) {
    const text = currentBubble.textContent.endsWith("...") ? 
                 currentBubble.textContent.slice(0, -3) : 
                 currentBubble.textContent;
    
    currentBubble.textContent = text;
    currentBubble.classList.remove("streaming-text");
    
    const ts = document.createElement("span");
    ts.className = "timestamp";
    ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    currentBubble.appendChild(ts);
    
    if (channelId === 1) {
      currentStreamingBubble1 = null;
    } else {
      currentStreamingBubble2 = null;
    }
    
    updateSubtitleLane(`lang${channelId}`, text, true);
  }
}

// --- Subtitle Presentation Window ---
function openSubtitleWindow() {
  if (subtitleWindow && !subtitleWindow.closed) {
    subtitleWindow.focus();
    return;
  }
  
  subtitleWindow = window.open(`/subtitles.html?v=${Date.now()}`, "GeminiLiveSubtitles", "width=900,height=600,menubar=no,toolbar=no,location=no,status=no");
  
  if (!subtitleWindow) {
    alert("Popup blocker is active. Please allow popups for this site to open the subtitle window.");
  }
}

function updateSubtitleLane(lane, text, isFinal = false) {
  const state = subtitleState[lane];
  
  const trimmedText = text.trim();
  if (isFinal) {
    if (trimmedText) {
      const needsSpace = state.accumulatedText.length > 0 && 
                         !/[\s。？！.?!;；]/.test(state.accumulatedText[state.accumulatedText.length - 1]) && 
                         !/^[。？！.?!;；\s]/.test(trimmedText);
      state.accumulatedText = state.accumulatedText + (needsSpace ? " " : "") + trimmedText;
    }
    
    // Limit history length to prevent excessive growth (keep last 800 chars)
    if (state.accumulatedText.length > 800) {
      state.accumulatedText = state.accumulatedText.substring(state.accumulatedText.length - 800);
      const spaceIdx = state.accumulatedText.indexOf(" ");
      if (spaceIdx !== -1) {
        state.accumulatedText = state.accumulatedText.substring(spaceIdx + 1);
      }
    }
  }
  
  // Send update to local subtitles broadcast server
  if (isSocketOpen(localSubtitlesWS)) {
    localSubtitlesWS.send(JSON.stringify({
      type: 'update',
      lane: lane,
      text: text,
      isFinal: isFinal
    }));
  }
}

// --- WebSocket Handlers ---
async function startSession() {
  if (isStarting || isRunning) return;
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    alert("Please enter a valid Gemini API Key.");
    return;
  }

  const pendingSessionConfig = {
    targetLanguage1: targetLanguageSelect1.value,
    targetLanguage2: targetLanguageSelect2.value,
    echoTargetLanguage: echoToggle.checked,
    systemInstructionText: systemInstructionInput.value.trim()
  };
  sessionConfig = pendingSessionConfig;

  isStarting = true;
  setSessionSettingsDisabled(true);
  audioSourceSelect.disabled = true;
  micDeviceSelect.disabled = true;
  startBtn.disabled = true;
  startBtn.querySelector(".btn-text").textContent = "Starting...";

  // Start capture before network work so system-audio selection retains user activation.
  const captureResult = startAudioCapture().then(
    () => ({ ok: true }),
    error => ({ ok: false, error })
  );

  try {
    await saveApiKey(apiKey);
    sessionApiKey = apiKey;
  } catch (error) {
    stopAudioCapture();
    isStarting = false;
    sessionConfig = null;
    setSessionSettingsDisabled(false);
    audioSourceSelect.disabled = false;
    micDeviceSelect.disabled = false;
    startBtn.disabled = false;
    startBtn.querySelector(".btn-text").textContent = "Start Translation";
    apiKeyStatus.textContent = error.message;
    apiKeyStatus.classList.add('error');
    alert(error.message);
    return;
  }
  
  const { targetLanguage1, targetLanguage2 } = pendingSessionConfig;
  
  const isDual = targetLanguage2 !== "none";
  
  // Clear and sync local subtitles WS
  if (isSocketOpen(localSubtitlesWS)) {
    localSubtitlesWS.send(JSON.stringify({ type: 'clear' }));
    syncLocalSubtitlesSetup();
  }
  
  // Show or hide Language 2 main column
  const colLang2 = document.getElementById("col-lang-2");
  if (isDual) {
    colLang2.style.display = "flex";
    document.getElementById("header-lang-1").textContent = `Translation 1 (${targetLanguage1.toUpperCase()})`;
    document.getElementById("header-lang-2").textContent = `Translation 2 (${targetLanguage2.toUpperCase()})`;
  } else {
    colLang2.style.display = "none";
    document.getElementById("header-lang-1").textContent = `Translation (${targetLanguage1.toUpperCase()})`;
  }
  
  const capture = await captureResult;
  if (!capture.ok) {
    const err = capture.error;
    stopAudioCapture();
    isStarting = false;
    sessionConfig = null;
    setSessionSettingsDisabled(false);
    audioSourceSelect.disabled = false;
    micDeviceSelect.disabled = false;
    if (err.name !== 'AbortError') {
      console.error("Failed to capture audio:", err);
      logDebug(`Failed to capture audio: ${err.message}`, "error");
      alert("Failed to capture audio: " + err.message);
    }
    startBtn.disabled = false;
    startBtn.querySelector(".btn-text").textContent = "Start Translation";
    return;
  }

  isStarting = false;
  isRunning = true;
  audioSourceSelect.disabled = false;
  micDeviceSelect.disabled = false;
  restartAudioBtn.disabled = audioSourceSelect.value === 'network';
  reconnectNowBtn.disabled = false;
  startBtn.disabled = false;
  startBtn.classList.add("recording");
  startBtn.querySelector(".btn-text").textContent = "Cancel Start";
  updateConnectionStatus("connecting", "Connecting...");
  logDebug(`Connecting to Gemini Live API...`, "info");
  connectGeminiSockets();
}

function isCurrentSocket(ws, channelId, generation) {
  const activeSocket = channelId === 1 ? socket1 : socket2;
  return isRunning && generation === sessionGeneration && ws === activeSocket;
}

function closeGeminiSockets() {
  for (const ws of [socket1, socket2]) {
    if (!ws) continue;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(); } catch (error) {}
    }
  }
  socket1 = null;
  socket2 = null;
  socketSetupReady[1] = false;
  socketSetupReady[2] = false;
}

function connectGeminiSockets() {
  if (!isRunning || !sessionConfig) return;
  clearTimeout(setupTimeout);
  closeGeminiSockets();
  sessionGeneration++;
  const generation = sessionGeneration;
  const apiKey = sessionApiKey;
  const { targetLanguage1, targetLanguage2, echoTargetLanguage, systemInstructionText } = sessionConfig;
  const url = `wss://${HOST}/${PATH}?key=${apiKey}`;
  setDiagnostic('Connecting to Gemini and verifying the session configuration...', 'warning');

  socket1 = new WebSocket(url);
  setHealthItem('gemini1', 'connecting', 'Opening connection');
  setupSocket(socket1, 1, targetLanguage1, echoTargetLanguage, systemInstructionText, generation);
  if (targetLanguage2 !== "none") {
    healthItems.gemini2.hidden = false;
    socket2 = new WebSocket(url);
    setHealthItem('gemini2', 'connecting', 'Opening connection');
    setupSocket(socket2, 2, targetLanguage2, echoTargetLanguage, systemInstructionText, generation);
  } else {
    healthItems.gemini2.hidden = true;
    setHealthItem('gemini2', 'idle', 'Not enabled');
  }

  setupTimeout = setTimeout(() => {
    scheduleReconnect('Gemini setup timed out.', generation);
  }, SETUP_TIMEOUT_MS);
}

function markSocketReady(channelId, generation) {
  if (generation !== sessionGeneration || !isRunning) return;
  socketSetupReady[channelId] = true;
  setHealthItem(`gemini${channelId}`, 'good', 'Ready');
  if (!socketSetupReady[1] || (socket2 && !socketSetupReady[2])) return;

  clearTimeout(setupTimeout);
  setupTimeout = null;
  reconnectAttempt = 0;
  updateConnectionStatus("connected", "Connected");
  logDebug("All Gemini connections completed setup. Ready.", "info");
  if (!sessionTimerInterval) startSessionTimer();
  startBtn.disabled = false;
  startBtn.classList.add("recording");
  startBtn.querySelector(".btn-text").textContent = "Stop Interpreter";
  reconnectNowBtn.disabled = false;
  hideRecoveryBanner();
  setDiagnostic('Translation services are connected and ready.', 'good');
}

function scheduleReconnect(reason, generation = sessionGeneration) {
  if (!isRunning || generation !== sessionGeneration || reconnectTimeout) return;
  clearTimeout(setupTimeout);
  setupTimeout = null;
  closeGeminiSockets();
  setHealthItem('gemini1', 'warning', 'Reconnecting');
  if (!healthItems.gemini2.hidden) setHealthItem('gemini2', 'warning', 'Reconnecting');

  const delay = Math.min(1000 * (2 ** reconnectAttempt), 8000);
  reconnectAttempt++;
  updateConnectionStatus("connecting", "Reconnecting...");
  startBtn.querySelector(".btn-text").textContent = "Stop Interpreter";
  logDebug(`${reason} Reconnecting in ${Math.round(delay / 1000)}s...`, "warning");
  showRecoveryBanner(`${reason} Retrying in ${Math.round(delay / 1000)}s. Your subtitles are preserved and live audio is not being queued.`);
  setDiagnostic(`${reason} Automatic recovery is in progress.`, 'warning');
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connectGeminiSockets();
  }, delay);
}

function stopForGeminiError(message) {
  if (!isRunning) return;
  const hadSecondChannel = !healthItems.gemini2.hidden;
  hideRecoveryBanner();
  logDebug(`Gemini rejected the session: ${message}`, 'error');
  disconnectSession(false);
  setHealthItem('gemini1', 'error', 'Configuration rejected');
  if (hadSecondChannel) {
    healthItems.gemini2.hidden = false;
    setHealthItem('gemini2', 'error', 'Configuration rejected');
  }
  setDiagnostic(`Gemini rejected the connection: ${message}. Check the API key and settings, then start again.`, 'error');
  updateConnectionStatus('disconnected', 'Configuration Error');
  alert(`Gemini could not start this session: ${message}`);
}

function setupSocket(ws, channelId, targetLanguage, echoTargetLanguage, systemInstructionText, generation) {
  ws.onopen = () => {
    if (!isCurrentSocket(ws, channelId, generation)) return;
    logDebug(`WebSocket ${channelId} opened successfully.`, "info");
    setHealthItem(`gemini${channelId}`, 'connecting', 'Completing setup');
    
    // Send Setup Message
    const setupMsg = {
      setup: {
        model: MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: {
            targetLanguageCode: targetLanguage,
            echoTargetLanguage: echoTargetLanguage
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };

    if (systemInstructionText) {
      setupMsg.setup.systemInstruction = {
        parts: [{ text: systemInstructionText }]
      };
    }
    
    logDebug(`WebSocket ${channelId}: Sending setup for ${targetLanguage}...`, "ws-sent");
    ws.send(JSON.stringify(setupMsg));
  };
  
  ws.onmessage = async (event) => {
    try {
      let text;
      if (event.data instanceof Blob) {
        text = await event.data.text();
      } else if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(event.data);
      } else {
        text = event.data;
      }

      if (!isCurrentSocket(ws, channelId, generation)) return;
      const data = JSON.parse(text);

      if (data.goAway) {
        const timeLeft = typeof data.goAway.timeLeft === 'string' ? data.goAway.timeLeft : '';
        const timing = timeLeft ? ` (${timeLeft} remaining)` : '';
        logDebug(`Gemini requested connection rotation${timing}.`, 'warning');
        setHealthItem(`gemini${channelId}`, 'warning', 'Server requested reconnect');
        scheduleReconnect('Gemini requested a routine connection rotation.', generation);
        return;
      }

      if (data.error) {
        const errorMessage = data.error.message || data.error.status || 'Unknown Gemini error';
        if (/goaway|go away/i.test(errorMessage) || data.error.status === 'UNAVAILABLE') {
          logDebug(`Temporary Gemini service response: ${errorMessage}`, 'warning');
          scheduleReconnect('Gemini is temporarily rotating or unavailable.', generation);
          return;
        }
        stopForGeminiError(errorMessage);
        return;
      }
      
      if (data.setupComplete) {
        logDebug(`Received: WebSocket ${channelId} setupComplete acknowledgment.`, "ws-recv");
        markSocketReady(channelId, generation);
        return;
      }
      
      if (data.serverContent) {
        const sc = data.serverContent;
        
        if (sc.interrupted) {
          logDebug(`WebSocket ${channelId} received interruption.`, "audio");
          stopAllPlayback();
          currentStreamingBubble1 = null;
          currentStreamingBubble2 = null;
          return;
        }
        if (sc.turnComplete) {
          logDebug(`WebSocket ${channelId} turnComplete received. Finalizing transcription.`, "ws-recv");
          finalizeOutputTranscript(channelId);
        }
        if (sc.modelTurn && sc.modelTurn.parts) {
          sc.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.data) {
              playPCMChunk(part.inlineData.data, channelId);
            }
          });
        }
      }
      
      // Handle Transcripts
      const inputTx = data.inputTranscription || (data.serverContent && data.serverContent.inputTranscription);
      if (inputTx) {
        const text = inputTx.text;
        if (text) {
          addInputTranscript(text);
        }
      }
      
      const outputTx = data.outputTranscription || (data.serverContent && data.serverContent.outputTranscription);
      if (outputTx) {
        const text = outputTx.text;
        if (text) {
          updateOutputTranscript(text, channelId, outputTx.final);
          updateSubtitleLane(`lang${channelId}`, text, outputTx.final);
        }
      }
      
    } catch (err) {
      console.error(`Error parsing WebSocket ${channelId} message:`, err);
      logDebug(`Error parsing server message on channel ${channelId}: ${err.message}`, "error");
    }
  };
  
  ws.onclose = (event) => {
    if (!isCurrentSocket(ws, channelId, generation)) return;
    console.log(`WebSocket ${channelId} connection closed:`, event);
    logDebug(`WebSocket ${channelId} connection closed. Code: ${event.code} | Reason: ${event.reason || 'None provided'}`, "info");
    if ([1002, 1003, 1007, 1008].includes(event.code)) {
      stopForGeminiError(event.reason || `WebSocket closed with code ${event.code}`);
      return;
    }
    scheduleReconnect(`Connection dropped on channel ${channelId}.`, generation);
  };
  
  ws.onerror = (err) => {
    if (!isCurrentSocket(ws, channelId, generation)) return;
    console.error(`WebSocket ${channelId} error:`, err);
    logDebug(`WebSocket ${channelId} error: ${err.message || 'Unknown network error'}`, "error");
    scheduleReconnect(`Connection error on channel ${channelId}.`, generation);
  };
}

function disconnectSession(clearSubtitles = true) {
  isRunning = false;
  isStarting = false;
  sessionApiKey = '';
  sessionConfig = null;
  setSessionSettingsDisabled(false);
  audioSourceSelect.disabled = false;
  micDeviceSelect.disabled = false;
  sessionGeneration++;
  stopSessionTimer();
  clearTimeout(reconnectTimeout);
  clearTimeout(setupTimeout);
  reconnectTimeout = null;
  setupTimeout = null;
  reconnectAttempt = 0;
  hideRecoveryBanner();
  reconnectNowBtn.disabled = true;
  restartAudioBtn.disabled = true;
  startBtn.disabled = false;
  startBtn.classList.remove("recording");
  startBtn.querySelector(".btn-text").textContent = "Start Translation";
  
  updateConnectionStatus("disconnected", "Disconnected");
  
  logDebug("Disconnecting session...", "info");
  stopAudioCapture();
  stopAllPlayback();
  currentStreamingBubble1 = null;
  currentStreamingBubble2 = null;
  
  if (clearSubtitles) {
    ['lang1', 'lang2'].forEach(lane => {
      subtitleState[lane].accumulatedText = "";
    });
    if (isSocketOpen(localSubtitlesWS)) {
      localSubtitlesWS.send(JSON.stringify({ type: 'clear' }));
    }
  }
  closeGeminiSockets();
  setHealthItem('gemini1', 'idle', 'Not started');
  setHealthItem('gemini2', 'idle', 'Not enabled');
  healthItems.gemini2.hidden = true;
  setDiagnostic('Translation stopped. Settings and saved API key are ready for the next session.', 'idle');
}

function updateConnectionStatus(statusClass, statusText) {
  connectionStatus.className = `status-badge ${statusClass}`;
  connectionStatus.querySelector(".status-text").textContent = statusText;
}

// Start Button Handler
startBtn.addEventListener("click", () => {
  if (isRunning) {
    disconnectSession();
  } else if (!isStarting) {
    startSession();
  }
});

// Subtitles Button Handler
subtitlesBtn.addEventListener("click", () => {
  openSubtitleWindow();
});

if (streamerBtn) {
  streamerBtn.addEventListener("click", () => {
    window.open('/audio-sender.html', 'AudioSenderWindow', 'width=800,height=850');
  });
}

// --- Local Subtitles WebSocket Broadcasting ---
function initLocalSubtitlesWS() {
  clearTimeout(localReconnectTimeout);
  setHealthItem('local', 'connecting', 'Connecting');
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/local-subtitles-ws`;
  const ws = new WebSocket(wsUrl);
  localSubtitlesWS = ws;

  ws.onopen = () => {
    if (localSubtitlesWS !== ws) return;
    localReconnectAttempt = 0;
    setHealthItem('local', 'good', 'Connected');
    logDebug("Connected to local subtitles broadcast server.", "info");
    syncLocalSubtitlesSetup();
    if (isRunning && socketSetupReady[1] && (!socket2 || socketSetupReady[2])) {
      setDiagnostic('Local projector relay restored. Translation services are ready.', 'good');
    }
  };

  ws.onclose = () => {
    if (localSubtitlesWS !== ws) return;
    localSubtitlesWS = null;
    const delay = Math.min(1000 * (2 ** localReconnectAttempt), 8000);
    localReconnectAttempt++;
    logDebug(`Disconnected from local subtitles server. Reconnecting in ${Math.round(delay / 1000)}s...`, "info");
    setHealthItem('local', 'warning', `Retrying in ${Math.round(delay / 1000)}s`);
    if (isRunning) setDiagnostic('The local projector relay disconnected. Automatic recovery is in progress.', 'warning');
    localReconnectTimeout = setTimeout(initLocalSubtitlesWS, delay);
  };

  ws.onerror = (err) => {
    if (localSubtitlesWS !== ws) return;
    console.error("Local subtitles WebSocket error:", err);
    ws.close();
  };
  
  ws.onmessage = (event) => {
    if (localSubtitlesWS !== ws) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'sync') {
        remoteAudioStreaming = Boolean(data.state?.audioSenderStreaming);
        if (audioSourceSelect.value === 'network') {
          setHealthItem('audio', remoteAudioStreaming ? 'good' : 'warning', remoteAudioStreaming ? 'Remote microphone active' : 'Waiting for remote sender');
        }
      } else if (data.type === 'input-audio') {
        remoteAudioStreaming = true;
        if (audioSourceSelect.value === 'network') setHealthItem('audio', 'good', 'Remote microphone active');
        handleIncomingNetworkAudio(data.audioData);
      } else if (data.type === 'audio-sender-status') {
        remoteAudioStreaming = Boolean(data.streaming);
        if (audioSourceSelect.value === 'network') {
          setHealthItem('audio', remoteAudioStreaming ? 'good' : 'warning', remoteAudioStreaming ? 'Remote microphone active' : 'Waiting for remote sender');
        }
        if (remoteAudioStreaming && networkDisconnectWarning && networkDisconnectWarning.style.display !== "none") {
          networkDisconnectWarning.style.display = "none";
          logDebug("Remote audio stream reconnected.", "info");
          setDiagnostic('Remote microphone reconnected. Translation can continue.', 'good');
        } else if (!remoteAudioStreaming) {
          const isNetworkSource = audioSourceSelect.value === 'network';
          const isTranslating = socketSetupReady[1] || socketSetupReady[2];
          if (isNetworkSource && isTranslating) {
            if (networkDisconnectWarning) networkDisconnectWarning.style.display = "flex";
            logDebug("Remote audio stream disconnected!", "error");
            micIndicator.classList.remove("active");
            micDb.textContent = "0%";
          }
        }
      }
    } catch (err) {
      // ignore non-json messages
    }
  };
}

function handleIncomingNetworkAudio(base64Data) {
  const isNetworkSource = audioSourceSelect.value === 'network';
  const isTranslating = socketSetupReady[1] || socketSetupReady[2];
  if (!isNetworkSource || !isTranslating) return;

  if (isMicMuted) {
    micDb.textContent = "Muted";
    micIndicator.classList.remove("active");
    return;
  }

  const mediaMsg = {
    realtimeInput: {
      mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Data }]
    }
  };
  const msgStr = JSON.stringify(mediaMsg);
  
  if (canSendAudio(socket1, true, 1)) socket1.send(msgStr);
  if (canSendAudio(socket2, true, 2)) socket2.send(msgStr);
  
  chunksSent++;
  if (chunksSent % 25 === 0) {
    logDebug(`Sent ${chunksSent} network audio chunks to Google...`, "ws-sent");
  }

  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  const int16Array = new Int16Array(bytes.buffer);
  
  const float32 = new Float32Array(int16Array.length);
  let maxVal = 0;
  for (let i = 0; i < int16Array.length; i++) {
    const s = int16Array[i] / 32768.0;
    float32[i] = s;
    if (Math.abs(s) > maxVal) maxVal = Math.abs(s);
  }

  const step = Math.max(1, Math.floor(float32.length / micBuffer.length));
  for (let i = 0; i < micBuffer.length; i++) {
    const idx = Math.min(float32.length - 1, i * step);
    micBuffer[i] = micBuffer[i] * 0.3 + float32[idx] * 0.7;
  }

  const pct = Math.round(maxVal * 100);
  micDb.textContent = `${pct}%`;
  if (pct > 5) micIndicator.classList.add("active");
  else micIndicator.classList.remove("active");
}

function syncLocalSubtitlesSetup() {
  if (isSocketOpen(localSubtitlesWS)) {
    const targetLanguage1 = sessionConfig?.targetLanguage1 ?? targetLanguageSelect1.value;
    const targetLanguage2 = sessionConfig?.targetLanguage2 ?? targetLanguageSelect2.value;
    localSubtitlesWS.send(JSON.stringify({
      type: 'setup',
      targetLanguage1,
      targetLanguage2,
      isDual: targetLanguage2 !== "none"
    }));
  }
}

// Initialize local WebSocket connection on page load
initLocalSubtitlesWS();

window.addEventListener('offline', () => {
  if (isRunning) {
    showRecoveryBanner('Network connection lost. Waiting for the network to return; subtitles are preserved and live audio is not being queued.');
  }
  setDiagnostic('This computer is offline. Audio will not be queued; connections will resume when the network returns.', 'warning');
});

window.addEventListener('online', () => {
  if (!localSubtitlesWS) {
    clearTimeout(localReconnectTimeout);
    initLocalSubtitlesWS();
  }
  if (isRunning) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    reconnectAttempt = 0;
    showRecoveryBanner('Network restored. Reconnecting now while preserving your subtitles.');
    setDiagnostic('Network restored. Reconnecting translation services now...', 'warning');
    connectGeminiSockets();
  }
});

// Update Projector Sharing URL Tip & QR Code
async function initProjectorSharingQR() {
  const projectorTip = document.getElementById("projector-url-tip");
  const qrCanvas = document.getElementById("projector-qr-canvas");
  if (!projectorTip) return;

  let networkIP = window.location.hostname; // Fallback to current browser host (e.g. 192.168.x.x)
  let obsPort = null;
  const port = window.location.port ? `:${window.location.port}` : '';

  try {
    const res = await fetch('/api/network-ip');
    const data = await res.json();
    if (data.ip && data.ip !== 'localhost') {
      networkIP = data.ip;
    }
    if (Number.isInteger(data.obsPort) && data.obsPort > 0) obsPort = data.obsPort;
  } catch (err) {
    console.warn("Failed to fetch local network IP from server API:", err);
  }

  const subtitlesUrl = `${window.location.protocol}//${networkIP}${port}/subtitles.html`;
  projectorTip.textContent = subtitlesUrl;

  if (qrCanvas) {
    QRCode.toCanvas(qrCanvas, subtitlesUrl, {
      width: 116,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M'
    }, function (error) {
      if (error) console.error("QR Code generation error:", error);
    });
  }

  const streamerTip = document.getElementById("streamer-url-tip");
  const streamerQrCanvas = document.getElementById("streamer-qr-canvas");
  const streamerUrl = `${window.location.protocol}//${networkIP}${port}/audio-sender.html`;
  if (streamerTip) streamerTip.textContent = streamerUrl;
  
  if (streamerQrCanvas) {
    QRCode.toCanvas(streamerQrCanvas, streamerUrl, {
      width: 116,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M'
    }, function (error) {
      if (error) console.error("QR Code generation error:", error);
    });
  }

  function bindShareActions(copyButtonId, openButtonId, url) {
    const copyButton = document.getElementById(copyButtonId);
    const openButton = document.getElementById(openButtonId);
    copyButton?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copyButton.textContent = 'Copied';
        setTimeout(() => { copyButton.textContent = 'Copy URL'; }, 1500);
      } catch (error) {
        logDebug(`Could not copy sharing URL: ${error.message}`, 'error');
      }
    });
    openButton?.addEventListener('click', () => {
      window.open(url, '_blank', 'noopener');
    });
  }

  bindShareActions('copy-projector-url', 'open-projector-url', subtitlesUrl);
  bindShareActions('copy-streamer-url', 'open-streamer-url', streamerUrl);
  const obsUrl = obsPort
    ? `http://${networkIP}:${obsPort}/?obs=true`
    : `${subtitlesUrl}?obs=true`;
  const obsTip = document.getElementById('obs-url-tip');
  if (obsTip) obsTip.textContent = obsUrl;
  bindShareActions('copy-obs-url', 'open-obs-url', obsUrl);
}

initProjectorSharingQR();
