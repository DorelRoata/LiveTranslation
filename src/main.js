import './style.css';
import QRCode from 'qrcode';
import {
  RollingAudioWindow,
  SONG_DETECTION_SAMPLE_RATE,
  createSongGateState,
  getSongEvidence,
  updateSongGateState
} from './song-detection.js';
import { buildObsUrl } from './obs-language.js';
import { buildSystemSetup, countWords, getLanguageName } from './system-setup.js';
import { appendLaneText, emptyLaneState, endsSentence, pieceToAppend } from './caption-stream.js';
import { buildGeminiAudioMessage, buildGeminiSetupMessage, canForwardGeminiAudio, normalizeSourceLanguage, shouldReconnectOnNetworkOnline, smoothTranslationLatency } from './gemini-live.js';
import { applyBiblicalGlossary } from './glossary.js';
import {
  AudioDeliveryMonitor,
  decodePcm16Base64,
  downsampleToRate,
  floatToPcm16,
  GEMINI_FRAME_SAMPLES,
  PcmAccumulator,
  peakAmplitude,
  PreRollAudioBuffer,
  QUIET_FRAME_PEAK,
  schedulePlayback,
  TARGET_CAPTURE_RATE
} from './pcm-audio.js';

// --- Constants ---
const GEMINI_LIVE_WS_PATH = '/gemini-live-ws';
const MAX_BUFFERED_AUDIO_BYTES = 2 * 1024 * 1024;
const SETUP_TIMEOUT_MS = 15_000;
// After a goAway rotation the old connection still delivers the translation of
// audio it already received. New-session captions wait until it has been quiet
// this long (or ROTATION_DRAIN_MAX_MS passes) so text stays in spoken order.
const ROTATION_QUIET_MS = 1500;
const ROTATION_DRAIN_MAX_MS = 8000;
const TRANSCRIPT_BUBBLE_MAX_CHARS = 320;
const OPERATOR_SETTINGS_KEY = 'live_translate_operator_settings_v1';
const APP_VERSION = '1.3.36';
const SONG_DETECTOR_WASM_ROOT = '/mediapipe/wasm';
const SONG_DETECTOR_MODEL_URL = '/mediapipe/models/yamnet.tflite';
const LEGACY_DEFAULT_SYSTEM_INSTRUCTION = 'You are a professional church sermon interpreter. The speaker is preaching in Romanian. Translate their sermon accurately, maintain a respectful and formal religious/church tone, and translate into the target language.';
const DEFAULT_SYSTEM_INSTRUCTION = `${LEGACY_DEFAULT_SYSTEM_INSTRUCTION} Translate continuously in short, complete phrases with a natural cadence. Do not repeat or revise text already emitted, and avoid long pauses before responding.`;
const DEFAULT_OPERATOR_SETTINGS = Object.freeze({
  audioSource: 'mic',
  microphoneDevice: 'default',
  sourceLanguage: 'auto',
  targetLanguage1: 'en',
  targetLanguage2: 'none',
  obsLanguage: 'both',
  playVoice1: true,
  playVoice2: true,
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
  echoTargetLanguage: false,
  localSpeaker: false,
  localVolume: 1,
  subtitlePacing: 'smooth',
  ignoreSongs: false,
  transcriptFontSize: 'md'
});

// --- State Variables ---
let socket1 = null;
let socket2 = null;
let audioContextInput = null;
let audioContextOutput = null;
let micStream = null;
let scriptProcessor = null;
let captureKeepAlive = null;
let audioCaptureGeneration = 0;
const geminiPcmAccumulator = new PcmAccumulator(GEMINI_FRAME_SAMPLES);
const mainPcmRemainder = { 1: new Uint8Array(0), 2: new Uint8Array(0) };
const preRollBuffer = new PreRollAudioBuffer(1.5, TARGET_CAPTURE_RATE);
let lastSpeechSentTimestamp = 0;
let smoothedLatencyMs = 0;
let lastHeardInputLanguage = '';

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
let startToken = 0;
let sessionConfig = null;
let apiKeyConfigured = false;
const socketSetupReady = { 1: false, 2: false };
// goAway rotation: Google warns ~50 s before closing a connection. A pending
// replacement resumes the same session; the old socket then drains.
const resumeHandle = { 1: '', 2: '' };
const pendingSocket = { 1: null, 2: null };
const drainingSocket = { 1: null, 2: null };
const drainQueue = { 1: [], 2: [] };
const drainTimers = { 1: { quiet: null, max: null }, 2: { quiet: null, max: null } };
let subtitleWindow = null;
let localSubtitlesWS = null;
let localReconnectTimeout = null;
let localReconnectAttempt = 0;
let remoteAudioStreaming = false;
let refreshObsSharingUrl = () => {};

// New Features State
let isMicMuted = false;
let sessionTimerInterval = null;
let sessionStartTime = 0;
let totalWordsCount = 0;
let songClassifier = null;
let songClassifierLoadPromise = null;
let songDetectionFailed = false;
let songGateState = createSongGateState();
let isSongSuppressed = false;
const songAudioWindow = new RollingAudioWindow();

const subtitleState = {
  lang1: emptyLaneState(),
  lang2: emptyLaneState()
};

// Audio Visualizer buffers (last 512 samples)
const micBuffer = new Float32Array(512);
const outBuffer = new Float32Array(512);

// UI Elements
const apiKeyInput = document.getElementById("api-key-input");
const toggleApiKeyBtn = document.getElementById("toggle-api-key");
const apiKeyStatus = document.getElementById("api-key-status");
const apiKeyGroup = document.getElementById('api-key-group');
const replaceApiKeyBtn = document.getElementById('replace-api-key-btn');
const saveApiKeyBtn = document.getElementById('save-api-key-btn');
const cancelReplaceApiKeyBtn = document.getElementById('cancel-replace-api-key-btn');
const audioSourceSelect = document.getElementById("audio-source-select");
const micDeviceGroup = document.getElementById("mic-device-group");
const micDeviceSelect = document.getElementById("mic-device-select");
const systemInstructionInput = document.getElementById("system-instruction-input");
const subtitlePacingSelect = document.getElementById('subtitle-pacing-select');
const ignoreSongsToggle = document.getElementById('ignore-songs-toggle');
const songFilterStatus = document.getElementById('song-filter-status');

const sourceLanguageSelect = document.getElementById("source-language-select");
const targetLanguageSelect1 = document.getElementById("target-language-select-1");
const detectedSpeechHeader = document.getElementById("header-detected-speech");
const playVoiceCheckbox1 = document.getElementById("play-voice-1");
const targetLanguageSelect2 = document.getElementById("target-language-select-2");
const playVoiceCheckbox2 = document.getElementById("play-voice-2");
const obsLanguageSelect = document.getElementById('obs-language-select');

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
const chunkStatsEl = document.getElementById("chunk-stats");
const telemetryLatencyEl = document.getElementById("telemetry-latency");
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
function isRemoteOperator() {
  const host = window.location.hostname;
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]';
}

function applyRemoteOperatorMode() {
  if (!isRemoteOperator()) return;
  document.body.dataset.operator = 'remote';
  const banner = document.getElementById('remote-operator-banner');
  if (banner) banner.hidden = false;
  if (streamerBtn) streamerBtn.hidden = true;
  if (checkUpdatesBtn) checkUpdatesBtn.hidden = true;
  const hint = document.getElementById('audio-source-hint');
  if (hint) {
    hint.textContent = 'This laptop is the operator. Choose Host Mac audio so the mixer or microphone on the Mac is used.';
  }
  if (replaceApiKeyBtn) replaceApiKeyBtn.hidden = true;
}

function networkAudioHealthDetail(active) {
  if (isRemoteOperator()) {
    return active ? 'Mac audio active' : 'Waiting for Mac audio';
  }
  return active ? 'Remote microphone active' : 'Waiting for remote sender';
}

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
  setSelectValue(sourceLanguageSelect, settings.sourceLanguage, DEFAULT_OPERATOR_SETTINGS.sourceLanguage);
  setSelectValue(targetLanguageSelect1, settings.targetLanguage1, DEFAULT_OPERATOR_SETTINGS.targetLanguage1);
  setSelectValue(targetLanguageSelect2, settings.targetLanguage2, DEFAULT_OPERATOR_SETTINGS.targetLanguage2);
  setSelectValue(obsLanguageSelect, settings.obsLanguage, DEFAULT_OPERATOR_SETTINGS.obsLanguage);
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
  setSelectValue(subtitlePacingSelect, settings.subtitlePacing, DEFAULT_OPERATOR_SETTINGS.subtitlePacing);
  ignoreSongsToggle.checked = typeof settings.ignoreSongs === 'boolean'
    ? settings.ignoreSongs
    : DEFAULT_OPERATOR_SETTINGS.ignoreSongs;
  setTranscriptFontSize(settings.transcriptFontSize);
  micDeviceGroup.style.display = audioSourceSelect.value === 'mic' ? 'block' : 'none';
  applyDashboardLanguageLayout();
  syncLocalSubtitlesSetup();
}

function getOperatorSettings() {
  const activeFontButton = document.querySelector('.font-size-btn.active');
  return {
    audioSource: audioSourceSelect.value,
    microphoneDevice: preferredMicDeviceId,
    sourceLanguage: sourceLanguageSelect.value,
    targetLanguage1: targetLanguageSelect1.value,
    targetLanguage2: targetLanguageSelect2.value,
    obsLanguage: obsLanguageSelect.value,
    playVoice1: playVoiceCheckbox1.checked,
    playVoice2: playVoiceCheckbox2.checked,
    systemInstruction: systemInstructionInput.value,
    echoTargetLanguage: echoToggle.checked,
    localSpeaker: localPlaybackToggle.checked,
    localVolume: Number(hostVolumeSlider.value),
    subtitlePacing: subtitlePacingSelect.value,
    ignoreSongs: ignoreSongsToggle.checked,
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
    if (savedSettings.systemInstruction === LEGACY_DEFAULT_SYSTEM_INSTRUCTION) {
      savedSettings.systemInstruction = DEFAULT_SYSTEM_INSTRUCTION;
    }
  } catch (error) {
    console.warn('Unable to load operator settings:', error);
  }
  const defaults = { ...DEFAULT_OPERATOR_SETTINGS };
  if (isRemoteOperator()) defaults.audioSource = 'network';
  applyOperatorSettings({ ...defaults, ...savedSettings });
  applyRemoteOperatorMode();
  saveOperatorSettings();
}

loadOperatorSettings();
syncSongDetectorPreference();

// Gemini sessions live in this browser page. Protect an active translation
// from accidental reloads, tab closes, or a launcher/browser navigation.
window.addEventListener('beforeunload', event => {
  saveOperatorSettings();
  if (!isRunning && !isStarting) return;
  event.preventDefault();
  event.returnValue = '';
});

// --- API Key Runtime Configuration ---
function isReplacingApiKey() {
  return apiKeyGroup?.dataset.replacing === 'true';
}

function setApiKeyConfigured(configured, replacing = false) {
  apiKeyConfigured = Boolean(configured);
  if (apiKeyGroup) {
    apiKeyGroup.dataset.configured = apiKeyConfigured ? 'true' : 'false';
    apiKeyGroup.dataset.replacing = replacing ? 'true' : 'false';
  }
  if (!replacing) apiKeyInput.value = '';
  apiKeyInput.placeholder = replacing
    ? 'Enter the new Gemini API Key'
    : 'Enter your Gemini API Key';
}

function refreshStartEnabled() {
  if (isRunning || isStarting) {
    startBtn.disabled = false;
    return;
  }
  const needsFirstKey = !apiKeyConfigured && !apiKeyInput.value.trim();
  const needsLocalCapture = audioSourceSelect.value !== 'network';
  startBtn.disabled = (needsLocalCapture && !mediaSupported) || needsFirstKey;
}

async function loadStoredApiKey() {
  try {
    const response = await fetch('/api/config/api-key', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to read API key configuration.');

    const legacyKey = localStorage.getItem('gemini_api_key')?.trim();
    if (!data.configured && legacyKey) {
      if (legacyKey.length >= 20 && legacyKey.length <= 500) {
        try {
          await saveApiKey(legacyKey);
          data.configured = true;
        } catch (error) {
          data.warning = 'The old browser key could not be migrated. Enter a new key to replace it.';
        }
      } else {
        data.warning = 'The old browser key appears incomplete. Enter a valid Gemini API key.';
      }
    }
    localStorage.removeItem('gemini_api_key');

    setApiKeyConfigured(data.configured);
    if (isRemoteOperator()) {
      apiKeyStatus.textContent = data.warning || (data.configured
        ? 'The Mac already has a saved key. This laptop uses it without showing it.'
        : 'Save the Gemini API key on the Mac first. This laptop cannot store it.');
      apiKeyInput.disabled = true;
    } else {
      apiKeyStatus.textContent = data.warning || (data.configured
        ? 'The saved key is used automatically and is not shown.'
        : 'Enter once. After it is saved, this field is hidden.');
      apiKeyInput.disabled = false;
    }
    apiKeyStatus.classList.toggle('error', Boolean(data.warning));
    if (data.warning) setDiagnostic(data.warning, 'warning');
    refreshStartEnabled();
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
  setApiKeyConfigured(true);
  apiKeyStatus.textContent = 'The saved key is used automatically and is not shown.';
  apiKeyStatus.classList.remove('error');
}

apiKeyInput.disabled = true;
startBtn.disabled = true;

apiKeyInput.addEventListener('input', () => {
  apiKeyStatus.textContent = isReplacingApiKey()
    ? 'The new key is saved only if you click Save key.'
    : 'The key will be saved on this computer when translation starts.';
  apiKeyStatus.classList.remove('error');
  refreshStartEnabled();
});

replaceApiKeyBtn?.addEventListener('click', () => {
  if (!window.confirm('Replace the saved Gemini API key? The current key stays in place until you click Save key.')) return;
  setApiKeyConfigured(true, true);
  apiKeyInput.disabled = false;
  apiKeyInput.focus();
  apiKeyStatus.textContent = 'Enter the new key, then click Save key. Start Translation will not overwrite the saved key.';
  apiKeyStatus.classList.remove('error');
});

cancelReplaceApiKeyBtn?.addEventListener('click', () => {
  setApiKeyConfigured(true);
  apiKeyStatus.textContent = 'The saved key is used automatically and is not shown.';
  apiKeyStatus.classList.remove('error');
  refreshStartEnabled();
});

saveApiKeyBtn?.addEventListener('click', async () => {
  const nextKey = apiKeyInput.value.trim();
  if (!nextKey) {
    apiKeyStatus.textContent = 'Enter a valid Gemini API key before saving.';
    apiKeyStatus.classList.add('error');
    return;
  }
  try {
    saveApiKeyBtn.disabled = true;
    await saveApiKey(nextKey);
    refreshStartEnabled();
  } catch (error) {
    apiKeyStatus.textContent = error.message;
    apiKeyStatus.classList.add('error');
  } finally {
    saveApiKeyBtn.disabled = false;
  }
});

loadStoredApiKey();

function persistAndSyncSetup() {
  saveOperatorSettings();
  applyDashboardLanguageLayout();
  syncLocalSubtitlesSetup();
}

systemInstructionInput.addEventListener('input', saveOperatorSettings);
sourceLanguageSelect.addEventListener('change', persistAndSyncSetup);
targetLanguageSelect1.addEventListener('change', persistAndSyncSetup);
targetLanguageSelect2.addEventListener('change', persistAndSyncSetup);
obsLanguageSelect.addEventListener('change', persistAndSyncSetup);
playVoiceCheckbox1.addEventListener('change', saveOperatorSettings);
playVoiceCheckbox2.addEventListener('change', saveOperatorSettings);
echoToggle.addEventListener('change', saveOperatorSettings);
localPlaybackToggle.addEventListener('change', saveOperatorSettings);
hostVolumeSlider.addEventListener('input', saveOperatorSettings);
subtitlePacingSelect.addEventListener('change', persistAndSyncSetup);
ignoreSongsToggle.addEventListener('change', () => {
  saveOperatorSettings();
  syncSongDetectorPreference();
});
micDeviceSelect.addEventListener('change', () => {
  preferredMicDeviceId = micDeviceSelect.value || DEFAULT_OPERATOR_SETTINGS.microphoneDevice;
  saveOperatorSettings();
});

resetSettingsBtn.addEventListener('click', () => {
  if (!window.confirm('Reset operator settings to their defaults? The saved Gemini API key will not be removed.')) return;
  applyOperatorSettings(DEFAULT_OPERATOR_SETTINGS);
  saveOperatorSettings();
  syncSongDetectorPreference();
  setDiagnostic('Operator settings restored to defaults. Play on this Mac, target-language repeat, and automatic song filtering are off.', 'good');
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
    const qrDetails = document.getElementById('share-details') || document.querySelector(".qr-details");
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
clearInputBtn.addEventListener("click", () => clearTranscriptStream(inputStream));
clearOutputBtn1.addEventListener("click", () => clearTranscriptStream(outputStreams[1]));
clearOutputBtn2.addEventListener("click", () => clearTranscriptStream(outputStreams[2]));

const clearProjectorBtn = document.getElementById("btn-clear-projector");
clearProjectorBtn?.addEventListener("click", () => {
  if (!window.confirm('Clear the projector, OBS overlay, and transcript screens?')) return;
  clearTranscriptStream(inputStream);
  clearTranscriptStream(outputStreams[1]);
  clearTranscriptStream(outputStreams[2]);

  // Clear local subtitle state
  subtitleState.lang1 = emptyLaneState();
  subtitleState.lang2 = emptyLaneState();

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

function pcm16ToBase64(pcm16) {
  return base64ArrayBuffer(pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength));
}

function secondLanguageEnabled() {
  return Boolean(sessionConfig && sessionConfig.targetLanguage2 !== 'none');
}

function translationSocketsReady() {
  return canForwardGeminiAudio({
    primaryReady: socketSetupReady[1],
    secondaryEnabled: secondLanguageEnabled(),
    secondaryReady: socketSetupReady[2]
  });
}

function sendGeminiPcmFrames(float32, logLabel = 'audio') {
  const frames = geminiPcmAccumulator.push(float32);
  if (!frames.length) return;

  const dual = secondLanguageEnabled();
  const socket1Ready = canSendAudio(socket1, true, 1);
  const socket2Ready = !dual || canSendAudio(socket2, true, 2);
  if (!canForwardGeminiAudio({
    primaryReady: socket1Ready,
    secondaryEnabled: dual,
    secondaryReady: socket2Ready
  })) {
    preRollBuffer.push(float32);
    if (isRunning && translationSocketsReady() && !audioLoss.backlogWarned) {
      audioLoss.backlogWarned = true;
      logDebug('Gemini is backed up. Live audio is being held briefly; anything older than 1.5 s is lost and counted in Copy Status.', 'warning');
      setHealthItem('gemini1', 'warning', 'Catching up — holding audio');
    }
    return;
  }

  const geminiBackedUp = socket1.bufferedAmount > 64 * 1024 ||
    (dual && socket2.bufferedAmount > 64 * 1024);

  let sent = 0;
  for (const frame of frames) {
    const amplitude = peakAmplitude(frame);
    if (geminiBackedUp && amplitude < QUIET_FRAME_PEAK) {
      audioLoss.quietFramesSkipped++;
      continue;
    }
    if (amplitude > 0.04) {
      lastSpeechSentTimestamp = Date.now();
    }
    const msgStr = JSON.stringify(buildGeminiAudioMessage(pcm16ToBase64(floatToPcm16(frame))));
    socket1.send(msgStr);
    if (dual) socket2.send(msgStr);
    sent++;
    chunksSent++;
    updateChunkStats();
    if (chunksSent === 1 || chunksSent % 25 === 0) {
      logDebug(`Sent ${chunksSent} ${logLabel} chunks to Google.`, 'ws-sent');
    }
  }
  deliveryMonitor.record(sent, Date.now());
  audioLoss.backlogWarned = false;
  // Pre-roll only bridges the outage that is ending now. Audio held during an
  // earlier backlog must never reach Google minutes later, out of context.
  audioLoss.staleSamples += preRollBuffer.totalSamples;
  preRollBuffer.clear();
}

// --- Audio delivery check ---
// Live audio reaches Google at 10 frames per second. Anything less, while
// translation is running and the source is live, means speech is being lost
// before Google hears it. The operator is told, and Copy Status shows totals.
const audioLoss = { quietFramesSkipped: 0, staleSamples: 0, backlogWarned: false };
const deliveryMonitor = new AudioDeliveryMonitor();
let deliveryWatchSince = 0;
let deliveryShortfall = false;
let lastDeliveryRate = null;

function resetAudioLossCounters() {
  audioLoss.quietFramesSkipped = 0;
  audioLoss.staleSamples = 0;
  audioLoss.backlogWarned = false;
  preRollBuffer.droppedSamples = 0;
}

function audioShouldBeFlowing() {
  if (!isRunning || !translationSocketsReady() || isMicMuted || isSongSuppressed) return false;
  if (audioSourceSelect.value === 'network') return remoteAudioStreaming;
  return Boolean(scriptProcessor);
}

function checkAudioDelivery() {
  const now = Date.now();
  if (!audioShouldBeFlowing()) {
    deliveryWatchSince = 0;
    deliveryMonitor.reset();
    lastDeliveryRate = null;
    return;
  }
  if (!deliveryWatchSince) {
    deliveryWatchSince = now;
    deliveryMonitor.reset();
    return;
  }
  const rate = deliveryMonitor.rate(now, deliveryWatchSince);
  if (rate === null) return;
  lastDeliveryRate = rate;
  const short = deliveryMonitor.isShort(rate);
  if (short && !deliveryShortfall) {
    deliveryShortfall = true;
    const message = `Only ${rate.toFixed(1)} of 10 audio frames per second are reaching Google. Speech is being lost — check the audio source and that its window is open and awake.`;
    setHealthItem('audio', 'warning', `${rate.toFixed(1)} of 10 frames/s`);
    setDiagnostic(message, 'warning');
    logDebug(message, 'warning');
  } else if (!short && deliveryShortfall) {
    deliveryShortfall = false;
    setHealthItem('audio', 'good', audioSourceSelect.value === 'network' ? networkAudioHealthDetail(true) : 'Audio reaching Google');
    logDebug(`Audio is reaching Google at full rate again (${rate.toFixed(1)} frames/s).`, 'info');
  }
}

setInterval(checkAudioDelivery, 2000);

function audioLossSummary() {
  const seconds = samples => (samples / TARGET_CAPTURE_RATE).toFixed(1);
  const rate = lastDeliveryRate === null ? 'measuring' : `${lastDeliveryRate.toFixed(1)} frames/s (expected 10)`;
  return [
    `Audio reaching Google: ${rate}`,
    `Audio not sent: ${(audioLoss.quietFramesSkipped / 10).toFixed(1)} s of quiet skipped during backlog, ` +
      `${seconds(preRollBuffer.droppedSamples)} s lost in long outages, ${seconds(audioLoss.staleSamples)} s discarded as stale`
  ];
}

function isSocketOpen(ws, requireSetup = false, channelId = 0) {
  return Boolean(
    ws &&
    ws.readyState === WebSocket.OPEN &&
    (!requireSetup || socketSetupReady[channelId])
  );
}

function geminiSessionNeedsReconnect() {
  return shouldReconnectOnNetworkOnline({
    isRunning,
    reconnectPending: Boolean(reconnectTimeout),
    primaryReady: isSocketOpen(socket1, true, 1),
    secondaryEnabled: Boolean(sessionConfig && sessionConfig.targetLanguage2 !== 'none'),
    secondaryReady: isSocketOpen(socket2, true, 2)
  });
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
  if (replaceApiKeyBtn) replaceApiKeyBtn.disabled = disabled;
  if (saveApiKeyBtn) saveApiKeyBtn.disabled = disabled;
  if (cancelReplaceApiKeyBtn) cancelReplaceApiKeyBtn.disabled = disabled;
  sourceLanguageSelect.disabled = disabled;
  targetLanguageSelect1.disabled = disabled;
  targetLanguageSelect2.disabled = disabled;
  echoToggle.disabled = disabled;
  systemInstructionInput.disabled = disabled;
  subtitlePacingSelect.disabled = disabled;
  resetSettingsBtn.disabled = disabled;
}

function setLiveMode(live) {
  document.body.classList.toggle('is-live', live);
  const setupDetails = document.getElementById('setup-details');
  if (setupDetails) setupDetails.open = !live;
}

function applyDashboardLanguageLayout() {
  const lang1 = sessionConfig?.targetLanguage1 ?? targetLanguageSelect1.value;
  const lang2 = sessionConfig?.targetLanguage2 ?? targetLanguageSelect2.value;
  const isDual = lang2 !== 'none';
  const colLang2 = document.getElementById('col-lang-2');
  const header1 = document.getElementById('header-lang-1');
  const header2 = document.getElementById('header-lang-2');
  if (colLang2) colLang2.hidden = !isDual;
  if (header1) {
    header1.textContent = isDual
      ? getLanguageName(lang1, 'Language 1')
      : getLanguageName(lang1, 'Translation');
  }
  if (header2) header2.textContent = getLanguageName(lang2, 'Language 2');
  if (!isRunning && healthItems.gemini2) {
    healthItems.gemini2.hidden = !isDual;
    if (!isDual) setHealthItem('gemini2', 'idle', 'Not enabled');
    else if (healthSnapshot.gemini2.state === 'idle') setHealthItem('gemini2', 'idle', 'Not started');
  }
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
  let proxyLine = 'Host audio drops: unavailable';
  try {
    const activity = await (await fetch('/api/activity', { cache: 'no-store' })).json();
    proxyLine = `Host audio drops: ${activity.audioDroppedByHost ?? 0} frames (Google connection backed up)`;
  } catch (error) {
    // Laptop operators may not reach the activity API; the rest still applies.
  }
  const report = [
    `Live Translate v${APP_VERSION} diagnostics`,
    `Time: ${new Date().toISOString()}`,
    `Operator: ${isRemoteOperator() ? 'laptop' : 'host'} (${window.location.host})`,
    `Browser online: ${navigator.onLine}`,
    `Audio source: ${audioSourceSelect.value}`,
    `Spoken language: ${sourceLanguageSelect.value}`,
    `Last heard language: ${lastHeardInputLanguage || 'none'}`,
    `OBS language: ${obsLanguageSelect.selectedOptions[0]?.textContent || 'Both Languages'}`,
    `Automatic song filter: ${ignoreSongsToggle.checked ? songFilterStatus.textContent : 'Off'}`,
    ...statusLines,
    ...audioLossSummary(),
    proxyLine,
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
let chunksReceived = 0;

function updateChunkStats() {
  if (chunkStatsEl) {
    chunkStatsEl.textContent = `${chunksSent} mic / ${chunksReceived} translated`;
  }
}

function updateTelemetryLatency(ms) {
  if (!telemetryLatencyEl) return;
  if (!Number.isFinite(ms) || ms <= 0) {
    telemetryLatencyEl.textContent = '⚡ -- ms';
    telemetryLatencyEl.style.color = '';
    return;
  }
  telemetryLatencyEl.textContent = `⚡ ${ms} ms`;
  if (ms < 800) {
    telemetryLatencyEl.style.color = '#34d399';
  } else if (ms < 1500) {
    telemetryLatencyEl.style.color = '#fbbf24';
  } else {
    telemetryLatencyEl.style.color = '#f87171';
  }
}

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
initVisualizer(micCanvas, micBuffer, "#4dbb83");
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
  if (isSongSuppressed) return;
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
  
  const playbackLatency = smoothTranslationLatency(smoothedLatencyMs, lastSpeechSentTimestamp, Date.now());
  if (playbackLatency !== smoothedLatencyMs) {
    smoothedLatencyMs = playbackLatency;
    updateTelemetryLatency(smoothedLatencyMs);
  }

  // 1. Decode base64 16-bit PCM bytes to Float32 with remainder reassembly
  const decoded = decodePcm16Base64(base64Data, mainPcmRemainder[channelId] || new Uint8Array(0));
  mainPcmRemainder[channelId] = decoded.remainder;
  const float32 = decoded.float32;
  if (float32.length === 0) return;

  let maxVal = 0;
  for (let i = 0; i < float32.length; i++) {
    const mag = Math.abs(float32[i]);
    if (mag > maxVal) maxVal = mag;
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

  const isLocalMuted = localPlaybackToggle ? !localPlaybackToggle.checked : false;
  const hostVolume = isLocalMuted ? 0 : parseFloat(hostVolumeSlider?.value ?? 1);
  if (isLocalMuted || hostVolume <= 0) {
    return;
  }

  const audioBuffer = audioContextOutput.createBuffer(1, float32.length, 24000);
  audioBuffer.copyToChannel(float32, 0);

  const sourceNode = audioContextOutput.createBufferSource();
  sourceNode.buffer = audioBuffer;
  const gainNode = audioContextOutput.createGain();
  gainNode.gain.value = hostVolume;
  sourceNode.connect(gainNode);
  gainNode.connect(audioContextOutput.destination);
  
  const now = audioContextOutput.currentTime;
  const queuedStart = channelId === 1 ? nextStartTime1 : nextStartTime2;
  const scheduled = schedulePlayback(now, queuedStart, audioBuffer.duration);
  if (channelId === 1) nextStartTime1 = scheduled.nextQueued;
  else nextStartTime2 = scheduled.nextQueued;
  if (!scheduled.play) return;

  sourceNode.start(scheduled.start);
  
  if (channelId === 1) {
    activeSources1.push(sourceNode);
    outputIndicator1.classList.add("active");
    sourceNode.onended = () => {
      activeSources1 = activeSources1.filter(s => s !== sourceNode);
      if (activeSources1.length === 0) {
        outputIndicator1.classList.remove("active");
      }
    };
  } else {
    activeSources2.push(sourceNode);
    outputIndicator2.classList.add("active");
    sourceNode.onended = () => {
      activeSources2 = activeSources2.filter(s => s !== sourceNode);
      if (activeSources2.length === 0) {
        outputIndicator2.classList.remove("active");
      }
    };
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

function setSongFilterStatus(state, message) {
  songFilterStatus.dataset.state = state;
  songFilterStatus.textContent = message;
}

function discardStreamingOutput() {
  finishTranscriptBubble(outputStreams[1]);
  finishTranscriptBubble(outputStreams[2]);
}

function updateReadySongFilterStatus() {
  if (!ignoreSongsToggle.checked) {
    setSongFilterStatus('off', 'Off — songs may be translated.');
  } else if (songDetectionFailed) {
    setSongFilterStatus('error', 'Detector unavailable — translation is continuing.');
  } else if (!songClassifier) {
    setSongFilterStatus('ready', 'Loading on-device song detector...');
  } else if (isRunning) {
    setSongFilterStatus('ready', 'On — listening for songs.');
  } else {
    setSongFilterStatus('ready', 'On — ready when translation starts.');
  }
}

function setSongSuppressed(suppressed, announceResume = true) {
  if (isSongSuppressed === suppressed) return;
  isSongSuppressed = suppressed;

  if (suppressed) {
    stopAllPlayback();
    discardStreamingOutput();
    setSongFilterStatus('paused', 'Song detected — translation paused.');
    setDiagnostic('Song detected. Audio to Gemini is paused while the session stays connected.', 'warning');
    logDebug('Song detected. Automatic song filter paused translation audio.', 'warning');
    return;
  }

  updateReadySongFilterStatus();
  if (isRunning && announceResume) {
    setDiagnostic('Speech detected. Translation audio resumed automatically.', 'good');
    logDebug('Speech detected. Automatic song filter resumed translation audio.', 'info');
  }
}

function resetSongDetectionGate() {
  songAudioWindow.reset();
  songGateState = createSongGateState();
  setSongSuppressed(false, false);
}

async function ensureSongClassifier() {
  if (songClassifier) return songClassifier;
  if (songClassifierLoadPromise) return songClassifierLoadPromise;

  songDetectionFailed = false;
  songClassifierLoadPromise = (async () => {
    const { AudioClassifier, FilesetResolver } = await import('@mediapipe/tasks-audio');
    const fileset = await FilesetResolver.forAudioTasks(SONG_DETECTOR_WASM_ROOT);
    const classifier = await AudioClassifier.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SONG_DETECTOR_MODEL_URL },
      maxResults: 30,
      scoreThreshold: 0.05
    });
    classifier.setDefaultSampleRate(SONG_DETECTION_SAMPLE_RATE);
    songClassifier = classifier;
    return classifier;
  })().catch(error => {
    songDetectionFailed = true;
    logDebug(`Automatic song detector could not load: ${error.message}`, 'error');
    if (ignoreSongsToggle.checked) {
      setSongFilterStatus('error', 'Detector unavailable — translation is continuing.');
      setDiagnostic('Automatic song detection could not load. Translation is continuing normally.', 'warning');
    }
    return null;
  }).finally(() => {
    songClassifierLoadPromise = null;
  });

  return songClassifierLoadPromise;
}

async function syncSongDetectorPreference() {
  const wasSuppressed = isSongSuppressed;
  resetSongDetectionGate();
  if (!ignoreSongsToggle.checked) {
    songDetectionFailed = false;
    setSongFilterStatus('off', 'Off — songs may be translated.');
    if (wasSuppressed && isRunning) {
      setDiagnostic('Automatic song filtering was disabled. Translation resumed immediately.', 'good');
      logDebug('Automatic song filtering disabled. Translation audio resumed.', 'info');
    }
    return;
  }

  setSongFilterStatus('ready', songClassifier ? 'On — ready when translation starts.' : 'Loading on-device song detector...');
  const classifier = await ensureSongClassifier();
  if (!ignoreSongsToggle.checked || !classifier) return;
  updateReadySongFilterStatus();
}

function failOpenSongDetection(error) {
  songDetectionFailed = true;
  try {
    songClassifier?.close();
  } catch (closeError) {
    console.warn('Unable to close the failed song detector:', closeError);
  }
  songClassifier = null;
  resetSongDetectionGate();
  setSongFilterStatus('error', 'Detector unavailable — translation is continuing.');
  setDiagnostic('Automatic song detection stopped unexpectedly. Translation is continuing normally.', 'warning');
  logDebug(`Automatic song detection stopped: ${error.message}`, 'error');
}

function analyzeAudioForSongs(samples) {
  if (!ignoreSongsToggle.checked || !songClassifier || songDetectionFailed) return;
  const window = songAudioWindow.append(samples);
  if (!window) return;

  try {
    const evidence = getSongEvidence(songClassifier.classify(window, SONG_DETECTION_SAMPLE_RATE));
    const nextState = updateSongGateState(songGateState, evidence);
    const suppressionChanged = nextState.suppressed !== songGateState.suppressed;
    songGateState = nextState;
    if (suppressionChanged) setSongSuppressed(nextState.suppressed);
  } catch (error) {
    failOpenSongDetection(error);
  }
}

function decodeBase64Pcm16(base64Data) {
  return decodePcm16Base64(base64Data).float32;
}

// --- Audio Capture Pipeline (Mic Input) ---
async function startAudioCapture() {
  const captureGeneration = ++audioCaptureGeneration;
  const sourceVal = audioSourceSelect.value;
  setHealthItem('audio', 'connecting', sourceVal === 'network' ? networkAudioHealthDetail(false) : 'Requesting audio access');
  if (sourceVal === "network") {
    logDebug("Network audio source selected. Ready to receive audio stream from another PC...", "info");
    setHealthItem('audio', remoteAudioStreaming ? 'good' : 'warning', networkAudioHealthDetail(remoteAudioStreaming));
    return;
  }
  
  if (!navigator.mediaDevices) {
    throw new Error("navigator.mediaDevices is not available. Make sure you are accessing the dashboard through https://localhost:5173/. Browsers block microphone and audio sharing on insecure or local file:// pages.");
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

      logDebug("getDisplayMedia stream obtained. Isolating the audio track...", "info");
      const systemAudioTracks = captureStream.getAudioTracks();
      if (systemAudioTracks.length === 0) {
        captureStream.getTracks().forEach(track => track.stop());
        throw new Error("No system audio track shared. When prompted, make sure to check 'Share system audio' or 'Share tab audio' in the sharing dialog.");
      }
      captureStream.getVideoTracks().forEach(track => track.stop());
      captureStream = new MediaStream(systemAudioTracks);
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
    geminiPcmAccumulator.reset();
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

  const captureSampleRate = captureContext.sampleRate || TARGET_CAPTURE_RATE;
  if (Math.abs(captureSampleRate - TARGET_CAPTURE_RATE) >= 1) {
    logDebug(`Audio context is ${Math.round(captureSampleRate)} Hz; resampling to 16 kHz so Gemini stays in real time.`, 'warning');
  }

  scriptProcessor.onaudioprocess = (e) => {
    const float32 = downsampleToRate(e.inputBuffer.getChannelData(0), captureSampleRate);
    analyzeAudioForSongs(float32);

    const maxVal = peakAmplitude(float32);
    const step = Math.max(1, Math.floor(float32.length / micBuffer.length));
    for (let i = 0; i < micBuffer.length; i++) {
      const idx = Math.min(float32.length - 1, i * step);
      micBuffer[i] = micBuffer[i] * 0.3 + float32[idx] * 0.7;
    }

    if (isMicMuted) {
      geminiPcmAccumulator.reset();
      micDb.textContent = "Muted";
      micIndicator.classList.remove("active");
      return;
    }

    const pct = Math.round(maxVal * 100);
    micDb.textContent = `${pct}%`;
    if (pct > 5) {
      micIndicator.classList.add("active");
    } else {
      micIndicator.classList.remove("active");
    }

    if (isSongSuppressed) {
      geminiPcmAccumulator.reset();
      return;
    }

    sendGeminiPcmFrames(float32);
  };
  
  captureSource.connect(scriptProcessor);
  const captureSink = captureContext.createMediaStreamDestination();
  scriptProcessor.connect(captureSink);
  captureKeepAlive = new Audio();
  captureKeepAlive.muted = true;
  captureKeepAlive.srcObject = captureSink.stream;
  const keepAlivePlay = captureKeepAlive.play();
  if (keepAlivePlay && typeof keepAlivePlay.catch === 'function') keepAlivePlay.catch(() => {});

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
  if (captureKeepAlive) {
    try {
      captureKeepAlive.pause();
      captureKeepAlive.srcObject = null;
    } catch (error) {}
    captureKeepAlive = null;
  }
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
  geminiPcmAccumulator.reset();
  
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
  chunksSent = 0;
  chunksReceived = 0;
  updateWordCounterUI();
  updateChunkStats();

  sessionTimerInterval = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
    const hrs = String(Math.floor(elapsedSeconds / 3600)).padStart(2, '0');
    const mins = String(Math.floor((elapsedSeconds % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsedSeconds % 60).padStart(2, '0');
    if (sessionTimerEl) {
      sessionTimerEl.textContent = `${hrs}:${mins}:${secs}`;
    }
  }, 1000);
}

function stopSessionTimer() {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
}

function incrementWordCountBy(count) {
  if (count > 0) {
    totalWordsCount += count;
    updateWordCounterUI();
  }
}

function updateWordCounterUI() {
  if (wordCounterEl) {
    wordCounterEl.textContent = `${totalWordsCount.toLocaleString()} words`;
  }
}

// 2. Live Mic Mute Toggle
if (muteMicBtn) {
  muteMicBtn.addEventListener("click", () => {
    isMicMuted = !isMicMuted;
    if (isMicMuted) {
      muteMicBtn.classList.add("is-muted");
      muteMicBtn.setAttribute('aria-pressed', 'true');
      if (muteMicLabel) muteMicLabel.textContent = "Input paused";
      micDb.textContent = "Muted";
      micIndicator.classList.remove("active");
      logDebug("Microphone paused (muted). Gemini session remains connected.", "warning");
    } else {
      muteMicBtn.classList.remove("is-muted");
      muteMicBtn.setAttribute('aria-pressed', 'false');
      if (muteMicLabel) muteMicLabel.textContent = "Pause input";
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

// --- Transcript panels ---
// Google's pieces are final as sent, so a bubble is just those pieces joined,
// closed at the end of a sentence (or when it gets long).
function createTranscriptStream(list, placeholder, scrollId) {
  return { list, placeholder, scrollId, bubble: null, text: '' };
}

const inputStream = createTranscriptStream(inputList, inputPlaceholder, 'input-transcript-scroll');
const outputStreams = {
  1: createTranscriptStream(outputList1, outputPlaceholder1, 'output-transcript-scroll-1'),
  2: createTranscriptStream(outputList2, outputPlaceholder2, 'output-transcript-scroll-2')
};

function scrollTranscript(stream) {
  const container = document.getElementById(stream.scrollId);
  if (container) container.scrollTop = container.scrollHeight;
}

function appendTranscriptPiece(stream, piece) {
  if (!stream.bubble?.isConnected) {
    stream.bubble = null;
    stream.text = '';
  }
  const addition = pieceToAppend(stream.text, piece);
  if (!addition) return;

  stream.placeholder.style.display = 'none';
  if (!stream.bubble) {
    stream.bubble = document.createElement('div');
    stream.bubble.className = 'transcript-bubble streaming-text';
    stream.list.appendChild(stream.bubble);
    while (stream.list.children.length > 100) {
      stream.list.removeChild(stream.list.firstChild);
    }
  }
  stream.text += addition;
  stream.bubble.textContent = stream.text;
  incrementWordCountBy(countWords(addition));

  if (endsSentence(stream.text) || stream.text.length > TRANSCRIPT_BUBBLE_MAX_CHARS) {
    finishTranscriptBubble(stream);
  } else {
    scrollTranscript(stream);
  }
}

function finishTranscriptBubble(stream) {
  const bubble = stream.bubble;
  stream.bubble = null;
  stream.text = '';
  if (!bubble?.isConnected) return;
  bubble.classList.remove('streaming-text');
  const ts = document.createElement('span');
  ts.className = 'timestamp';
  ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  bubble.appendChild(ts);
  scrollTranscript(stream);
}

function clearTranscriptStream(stream) {
  stream.list.innerHTML = '';
  stream.placeholder.style.display = 'block';
  stream.bubble = null;
  stream.text = '';
}


// --- Subtitle Presentation Window ---
function openSubtitleWindow() {
  if (subtitleWindow && !subtitleWindow.closed) {
    subtitleWindow.focus();
    return;
  }
  
  subtitleWindow = window.open(`/subtitles.html?v=${Date.now()}`, "GeminiLiveSubtitles", "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no");
  
  if (!subtitleWindow) {
    alert("Popup blocker is active. Please allow popups for this site to open the subtitle window.");
  }
}

// Adds one translated piece from Google to the screens, exactly as Google sent
// it. `session` marks the first piece of a new or resumed Gemini session.
function deliverOutputPiece(channelId, text, session = {}) {
  const lane = `lang${channelId}`;
  const addition = pieceToAppend(subtitleState[lane].text, text, session);
  if (!addition) {
    logDebug(`Channel ${channelId}: skipped "${text.trim()}" — the resumed session repeated a word already on screen.`, 'info');
    return;
  }
  subtitleState[lane] = appendLaneText(subtitleState[lane], addition);
  appendTranscriptPiece(outputStreams[channelId], addition);

  if (isSocketOpen(localSubtitlesWS)) {
    localSubtitlesWS.send(JSON.stringify({ type: 'append', lane, text: addition }));
  }
}

function deliverInputPiece(text, session = {}) {
  const addition = pieceToAppend(inputStream.text, text, session);
  if (addition) appendTranscriptPiece(inputStream, addition);
}

// --- WebSocket Handlers ---
async function startSession() {
  if (isStarting || isRunning) return;
  const firstTimeKey = apiKeyConfigured ? '' : apiKeyInput.value.trim();
  if (!apiKeyConfigured && !firstTimeKey) {
    alert("Please enter a valid Gemini API Key.");
    return;
  }

  const pendingSessionConfig = {
    sourceLanguage: sourceLanguageSelect.value,
    targetLanguage1: targetLanguageSelect1.value,
    targetLanguage2: targetLanguageSelect2.value,
    echoTargetLanguage: echoToggle.checked,
    subtitlePacing: subtitlePacingSelect.value,
    systemInstructionText: systemInstructionInput.value.trim()
  };
  sessionConfig = pendingSessionConfig;

  const thisStart = ++startToken;
  isStarting = true;
  setLiveMode(true);
  setSessionSettingsDisabled(true);
  audioSourceSelect.disabled = true;
  micDeviceSelect.disabled = true;
  startBtn.disabled = false;
  startBtn.querySelector(".btn-text").textContent = "Cancel Start";

  // Start capture before network work so system-audio selection retains user activation.
  const captureResult = startAudioCapture().then(
    () => ({ ok: true }),
    error => ({ ok: false, error })
  );

  try {
    if (firstTimeKey) await saveApiKey(firstTimeKey);
  } catch (error) {
    stopAudioCapture();
    if (thisStart !== startToken) return;
    isStarting = false;
    sessionConfig = null;
    setLiveMode(false);
    setSessionSettingsDisabled(false);
    audioSourceSelect.disabled = false;
    micDeviceSelect.disabled = false;
    refreshStartEnabled();
    startBtn.querySelector(".btn-text").textContent = "Start Translation";
    apiKeyStatus.textContent = error.message;
    apiKeyStatus.classList.add('error');
    alert(error.message);
    return;
  }

  subtitleState.lang1 = emptyLaneState();
  subtitleState.lang2 = emptyLaneState();
  if (isSocketOpen(localSubtitlesWS)) {
    localSubtitlesWS.send(JSON.stringify({ type: 'clear' }));
    syncLocalSubtitlesSetup();
  }
  applyDashboardLanguageLayout();

  const capture = await captureResult;
  if (thisStart !== startToken) return;
  if (!capture.ok) {
    const err = capture.error;
    stopAudioCapture();
    isStarting = false;
    sessionConfig = null;
    setLiveMode(false);
    setSessionSettingsDisabled(false);
    audioSourceSelect.disabled = false;
    micDeviceSelect.disabled = false;
    if (err.name !== 'AbortError') {
      console.error("Failed to capture audio:", err);
      logDebug(`Failed to capture audio: ${err.message}`, "error");
      alert("Failed to capture audio: " + err.message);
    }
    refreshStartEnabled();
    startBtn.querySelector(".btn-text").textContent = "Start Translation";
    return;
  }

  isStarting = false;
  isRunning = true;
  updateReadySongFilterStatus();
  audioSourceSelect.disabled = false;
  micDeviceSelect.disabled = false;
  restartAudioBtn.disabled = audioSourceSelect.value === 'network';
  reconnectNowBtn.disabled = false;
  startBtn.disabled = false;
  startBtn.classList.add("recording");
  startBtn.querySelector(".btn-text").textContent = "Stop Interpreter";
  updateConnectionStatus("connecting", "Connecting...");
  logDebug(`Connecting to Gemini Live API...`, "info");
  connectGeminiSockets();
}

function activeSocketFor(channelId) {
  return channelId === 1 ? socket1 : socket2;
}

// Which connection a message came from: the live one, a goAway replacement
// still completing setup, or the old one finishing what it already heard.
function socketRole(ws, channelId, generation) {
  if (!isRunning || generation !== sessionGeneration) return null;
  if (ws === activeSocketFor(channelId)) return 'active';
  if (ws === pendingSocket[channelId]) return 'pending';
  if (ws === drainingSocket[channelId]) return 'draining';
  return null;
}

function isCurrentSocket(ws, channelId, generation) {
  return socketRole(ws, channelId, generation) === 'active';
}

function detachSocket(ws) {
  if (!ws) return;
  clearTimeout(ws.rotationTimer);
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try { ws.close(); } catch (error) {}
  }
}

function geminiProxyUrl() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${window.location.host}${GEMINI_LIVE_WS_PATH}`;
}

function armDrainQuietTimer(channelId) {
  clearTimeout(drainTimers[channelId].quiet);
  drainTimers[channelId].quiet = setTimeout(() => finishDrain(channelId), ROTATION_QUIET_MS);
}

// Ends a rotation drain: closes the old connection, then delivers the new
// session's captions that waited for it, in the order they arrived.
function finishDrain(channelId) {
  clearTimeout(drainTimers[channelId].quiet);
  clearTimeout(drainTimers[channelId].max);
  drainTimers[channelId].quiet = null;
  drainTimers[channelId].max = null;
  const old = drainingSocket[channelId];
  drainingSocket[channelId] = null;
  detachSocket(old);
  const queued = drainQueue[channelId];
  drainQueue[channelId] = [];
  for (const deliver of queued) deliver();
}

function abandonRotation(channelId, ws, reason) {
  if (pendingSocket[channelId] !== ws) return;
  pendingSocket[channelId] = null;
  detachSocket(ws);
  logDebug(`Channel ${channelId}: the replacement connection failed (${reason}). The current connection keeps translating and reconnects when Google closes it.`, 'warning');
}

// Google sends goAway about 50 s before it closes a connection. Open a
// replacement that resumes the same session while this one keeps translating.
function beginRotation(channelId, generation, timing) {
  if (pendingSocket[channelId] || drainingSocket[channelId] || !sessionConfig) return;
  const handle = resumeHandle[channelId];
  if (!handle) {
    logDebug(`Channel ${channelId}: Google will close this connection${timing} and sent no resumption handle. Translation continues until it closes, then reconnects.`, 'warning');
    return;
  }
  const { sourceLanguage, targetLanguage1, targetLanguage2, echoTargetLanguage } = sessionConfig;
  const ws = new WebSocket(geminiProxyUrl());
  ws.resumeHandle = handle;
  pendingSocket[channelId] = ws;
  ws.rotationTimer = setTimeout(() => abandonRotation(channelId, ws, 'setup timed out'), SETUP_TIMEOUT_MS);
  setupSocket(ws, channelId, channelId === 1 ? targetLanguage1 : targetLanguage2, echoTargetLanguage, sourceLanguage, generation);
  logDebug(`Channel ${channelId}: Google asked to rotate the connection${timing}. Opening a replacement that resumes the same session; the current one keeps translating meanwhile.`, 'info');
}

function promoteRotation(channelId, ws) {
  clearTimeout(ws.rotationTimer);
  pendingSocket[channelId] = null;
  const old = activeSocketFor(channelId);
  if (channelId === 1) socket1 = ws;
  else socket2 = ws;
  socketSetupReady[channelId] = true;
  ws.resumed = true;
  drainingSocket[channelId] = old;
  armDrainQuietTimer(channelId);
  drainTimers[channelId].max = setTimeout(() => finishDrain(channelId), ROTATION_DRAIN_MAX_MS);
  setHealthItem(`gemini${channelId}`, 'good', 'Ready');
  logDebug(`Channel ${channelId}: replacement connection ready. Live audio now goes to it with no gap.`, 'info');
}

function closeGeminiSockets() {
  for (const channelId of [1, 2]) {
    if (!isRunning) drainQueue[channelId] = [];
    finishDrain(channelId);
    detachSocket(pendingSocket[channelId]);
    pendingSocket[channelId] = null;
  }
  detachSocket(socket1);
  detachSocket(socket2);
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
  const { sourceLanguage, targetLanguage1, targetLanguage2, echoTargetLanguage } = sessionConfig;
  const url = geminiProxyUrl();
  // A fresh connection starts a new Gemini session; old handles do not apply.
  resumeHandle[1] = '';
  resumeHandle[2] = '';
  setDiagnostic('Connecting to Gemini and verifying the session configuration...', 'warning');
  geminiPcmAccumulator.reset();

  socket1 = new WebSocket(url);
  setHealthItem('gemini1', 'connecting', 'Opening connection');
  setupSocket(socket1, 1, targetLanguage1, echoTargetLanguage, sourceLanguage, generation);
  if (targetLanguage2 !== "none") {
    healthItems.gemini2.hidden = false;
    socket2 = new WebSocket(url);
    setHealthItem('gemini2', 'connecting', 'Opening connection');
    setupSocket(socket2, 2, targetLanguage2, echoTargetLanguage, sourceLanguage, generation);
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
  const sessionStarting = !sessionTimerInterval;
  if (sessionStarting) startSessionTimer();
  startBtn.disabled = false;
  startBtn.classList.add("recording");
  startBtn.querySelector(".btn-text").textContent = "Stop Interpreter";
  reconnectNowBtn.disabled = false;
  hideRecoveryBanner();
  setDiagnostic('Translation services are connected and ready.', 'good');

  const preRoll = preRollBuffer.flush();
  if (preRoll.length > 0) {
    logDebug(`Flushing ${preRoll.length} samples of pre-roll audio into reconnected session.`, 'info');
    sendGeminiPcmFrames(preRoll, 'reconnect pre-roll');
  }
  // Audio captured while the first connection was being set up is not speech
  // that was lost; count losses from the moment translation is live.
  if (sessionStarting) resetAudioLossCounters();
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

function maybeWarnTargetLanguageMatch(heardLanguage) {
  if (!sessionConfig || sessionConfig.echoTargetLanguage) return;
  if (chunksReceived > 0 || chunksSent < 25) return;
  const heard = String(heardLanguage).split('-')[0].toLowerCase();
  const target = String(sessionConfig.targetLanguage1 || '').split('-')[0].toLowerCase();
  if (!heard || !target || heard !== target) return;
  setDiagnostic(
    `Gemini heard ${getLanguageName(heardLanguage, heardLanguage)}, which is already Language 1. Turn on “Repeat words already in the target language”, or set Translate To to a different language.`,
    'warning'
  );
}

function noteHeardLanguage(languageCode) {
  if (!languageCode) return;
  const heard = String(languageCode);
  const heardName = getLanguageName(heard, heard);
  if (detectedSpeechHeader) detectedSpeechHeader.textContent = `Detected Speech (${heardName})`;
  if (heard === lastHeardInputLanguage) return;
  lastHeardInputLanguage = heard;
  const expected = normalizeSourceLanguage(sessionConfig?.sourceLanguage);
  const expectedBase = expected.split('-')[0].toLowerCase();
  const heardBase = heard.split('-')[0].toLowerCase();
  const mismatch = Boolean(expected) && expectedBase !== heardBase;
  logDebug(
    mismatch
      ? `Gemini heard ${heardName} (${heard}), not ${getLanguageName(expected, expected)}. Check Spoken language.`
      : `Gemini heard ${heardName} (${heard}).`,
    mismatch ? 'warning' : 'ws-recv'
  );
}

function setupSocket(ws, channelId, targetLanguage, echoTargetLanguage, sourceLanguage, generation) {
  ws.onopen = () => {
    const role = socketRole(ws, channelId, generation);
    if (role !== 'active' && role !== 'pending') return;
    logDebug(`WebSocket ${channelId} opened successfully.`, "info");
    if (role === 'active') setHealthItem(`gemini${channelId}`, 'connecting', 'Completing setup');

    const setupMsg = buildGeminiSetupMessage({
      targetLanguage,
      echoTargetLanguage,
      sourceLanguage,
      resumeHandle: ws.resumeHandle || ''
    });
    const sourceHint = normalizeSourceLanguage(sourceLanguage) || 'auto-detect';
    const resumeNote = ws.resumeHandle ? ', resuming the current session' : '';
    logDebug(`WebSocket ${channelId}: Sending Live Translate setup ${sourceHint} → ${targetLanguage} (no written instructions${resumeNote})...`, "ws-sent");
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

      const role = socketRole(ws, channelId, generation);
      if (!role) return;
      const data = JSON.parse(text);

      const resumption = data.sessionResumptionUpdate;
      if (resumption?.newHandle && resumption.resumable !== false && role !== 'draining') {
        resumeHandle[channelId] = resumption.newHandle;
      }

      if (data.goAway) {
        if (role !== 'active') return;
        const timeLeft = typeof data.goAway.timeLeft === 'string' ? data.goAway.timeLeft : '';
        const timing = timeLeft ? ` (${timeLeft} remaining)` : '';
        beginRotation(channelId, generation, timing);
        return;
      }

      if (data.error) {
        const errorMessage = data.error.message || data.error.status || 'Unknown Gemini error';
        if (role === 'pending') {
          abandonRotation(channelId, ws, errorMessage);
          return;
        }
        if (role === 'draining') {
          logDebug(`Channel ${channelId}: the previous connection reported "${errorMessage}" while finishing; the new one is already live.`, 'info');
          finishDrain(channelId);
          return;
        }
        if (/goaway|go away/i.test(errorMessage) || data.error.status === 'UNAVAILABLE') {
          logDebug(`Temporary Gemini service response: ${errorMessage}`, 'warning');
          scheduleReconnect('Gemini is temporarily rotating or unavailable.', generation);
          return;
        }
        stopForGeminiError(errorMessage);
        return;
      }
      
      if (data.setupComplete) {
        if (role === 'pending') {
          promoteRotation(channelId, ws);
          return;
        }
        logDebug(`Received: WebSocket ${channelId} setupComplete acknowledgment.`, "ws-recv");
        markSocketReady(channelId, generation);
        return;
      }
      if (role === 'pending') return;

      if (isSongSuppressed) return;

      if (data.serverContent) {
        const sc = data.serverContent;

        if (sc.interrupted) {
          logDebug(`WebSocket ${channelId} received an activity signal; keeping translated audio playing.`, "audio");
        }
        if (sc.modelTurn && sc.modelTurn.parts) {
          sc.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.data) {
              chunksReceived++;
              updateChunkStats();
              if (chunksReceived === 1 || chunksReceived % 25 === 0) {
                logDebug(`Received ${chunksReceived} translated audio chunks from Google.`, "ws-recv");
              }
              setHealthItem(`gemini${channelId}`, 'good', `Receiving (${chunksReceived})`);
              playPCMChunk(part.inlineData.data, channelId);
            }
          });
        }
      }
      
      // Transcripts. Only the final transcription fields are used: Google sends
      // each piece once and never revises it. Interim fields, if Google ever
      // sends them, are guesses by definition and never reach the screens.
      const inputTx = data.serverContent?.inputTranscription || data.inputTranscription;
      const outputTx = data.serverContent?.outputTranscription || data.outputTranscription;
      const hasText = Boolean(inputTx?.text || outputTx?.text);
      if (role === 'draining' && hasText) armDrainQuietTimer(channelId);

      const handleTranscripts = () => {
        if (channelId === 1 && inputTx) {
          if (inputTx.languageCode) {
            noteHeardLanguage(inputTx.languageCode);
            maybeWarnTargetLanguageMatch(inputTx.languageCode);
          }
          if (inputTx.text) {
            const session = { sessionStart: ws.firstInputPending !== false, resumed: Boolean(ws.resumed) };
            ws.firstInputPending = false;
            deliverInputPiece(inputTx.text, session);
          }
        }

        if (outputTx?.text) {
          const captionLatency = smoothTranslationLatency(smoothedLatencyMs, lastSpeechSentTimestamp, Date.now());
          if (captionLatency !== smoothedLatencyMs) {
            smoothedLatencyMs = captionLatency;
            updateTelemetryLatency(smoothedLatencyMs);
          }
          if (chunksReceived === 0) {
            logDebug(`Received translation text on channel ${channelId} before any audio chunks.`, "ws-recv");
          }
          const targetLang = channelId === 1 ? sessionConfig?.targetLanguage1 : sessionConfig?.targetLanguage2;
          const text = applyBiblicalGlossary(outputTx.text, targetLang || 'en');
          const session = { sessionStart: ws.firstOutputPending !== false, resumed: Boolean(ws.resumed) };
          ws.firstOutputPending = false;
          deliverOutputPiece(channelId, text, session);
        }

        if (data.serverContent?.turnComplete) {
          logDebug(`WebSocket ${channelId} turnComplete received.`, "ws-recv");
          finishTranscriptBubble(outputStreams[channelId]);
          if (channelId === 1) finishTranscriptBubble(inputStream);
        }
      };

      // While the previous connection is still delivering the end of what it
      // heard, the new session's captions wait so the screen stays in order.
      if (role === 'active' && drainingSocket[channelId]) drainQueue[channelId].push(handleTranscripts);
      else handleTranscripts();

    } catch (err) {
      console.error(`Error parsing WebSocket ${channelId} message:`, err);
      logDebug(`Error parsing server message on channel ${channelId}: ${err.message}`, "error");
    }
  };
  
  ws.onclose = (event) => {
    const role = socketRole(ws, channelId, generation);
    if (!role) return;
    if (role === 'pending') {
      abandonRotation(channelId, ws, `closed with code ${event.code}`);
      return;
    }
    if (role === 'draining') {
      finishDrain(channelId);
      return;
    }
    console.log(`WebSocket ${channelId} connection closed:`, event);
    logDebug(`WebSocket ${channelId} connection closed. Code: ${event.code} | Reason: ${event.reason || 'None provided'}`, "info");
    if (event.code === 1008 || event.code === 1011) {
      setDiagnostic(event.reason || 'Gemini connection was rejected by the host app.', 'error');
    }
    if ([1002, 1003, 1007, 1008].includes(event.code)) {
      stopForGeminiError(event.reason || `WebSocket closed with code ${event.code}`);
      return;
    }
    scheduleReconnect(`Connection dropped on channel ${channelId}.`, generation);
  };
  
  ws.onerror = (err) => {
    const role = socketRole(ws, channelId, generation);
    if (!role) return;
    if (role === 'pending') {
      abandonRotation(channelId, ws, 'connection error');
      return;
    }
    if (role === 'draining') return;
    console.error(`WebSocket ${channelId} error:`, err);
    logDebug(`WebSocket ${channelId} error: ${err.message || 'Unknown network error'}`, "error");
    scheduleReconnect(`Connection error on channel ${channelId}.`, generation);
  };
}

function disconnectSession(clearSubtitles = true) {
  startToken++;
  isRunning = false;
  isStarting = false;
  sessionConfig = null;
  setLiveMode(false);
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
  startBtn.classList.remove("recording");
  startBtn.querySelector(".btn-text").textContent = "Start Translation";
  refreshStartEnabled();
  
  updateConnectionStatus("disconnected", "Disconnected");
  
  logDebug("Disconnecting session...", "info");
  updateTelemetryLatency(0);
  smoothedLatencyMs = 0;
  lastSpeechSentTimestamp = 0;
  preRollBuffer.clear();
  mainPcmRemainder[1] = new Uint8Array(0);
  mainPcmRemainder[2] = new Uint8Array(0);
  stopAudioCapture();
  stopAllPlayback();
  resetSongDetectionGate();
  updateReadySongFilterStatus();
  finishTranscriptBubble(inputStream);
  finishTranscriptBubble(outputStreams[1]);
  finishTranscriptBubble(outputStreams[2]);

  if (clearSubtitles) {
    subtitleState.lang1 = emptyLaneState();
    subtitleState.lang2 = emptyLaneState();
    if (isSocketOpen(localSubtitlesWS)) {
      localSubtitlesWS.send(JSON.stringify({ type: 'clear' }));
    }
  }
  closeGeminiSockets();
  setHealthItem('gemini1', 'idle', 'Not started');
  setHealthItem('gemini2', 'idle', 'Not enabled');
  lastHeardInputLanguage = '';
  if (detectedSpeechHeader) detectedSpeechHeader.textContent = 'Detected Speech';
  applyDashboardLanguageLayout();
  setDiagnostic('Translation stopped. Settings and saved API key are ready for the next session.', 'idle');
}

function updateConnectionStatus(statusClass, statusText) {
  connectionStatus.className = `status-badge ${statusClass}`;
  connectionStatus.querySelector(".status-text").textContent = statusText;
}

// Start Button Handler
startBtn.addEventListener("click", () => {
  if (isRunning || isStarting) {
    disconnectSession();
  } else {
    startSession();
  }
});

// Subtitles Button Handler
subtitlesBtn.addEventListener("click", () => {
  openSubtitleWindow();
});

if (streamerBtn) {
  streamerBtn.addEventListener("click", () => {
    window.open(isRemoteOperator() ? '/audio-sender.html' : '/audio-sender.html?host=1', 'AudioSenderWindow', 'width=800,height=850');
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
    if (isRunning && translationSocketsReady()) {
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
          setHealthItem('audio', remoteAudioStreaming ? 'good' : 'warning', networkAudioHealthDetail(remoteAudioStreaming));
        }
      } else if (data.type === 'input-audio') {
        remoteAudioStreaming = true;
        if (audioSourceSelect.value === 'network') setHealthItem('audio', 'good', networkAudioHealthDetail(true));
        handleIncomingNetworkAudio(data.audioData);
      } else if (data.type === 'audio-sender-status') {
        remoteAudioStreaming = Boolean(data.streaming);
        if (audioSourceSelect.value === 'network') {
          setHealthItem('audio', remoteAudioStreaming ? 'good' : 'warning', networkAudioHealthDetail(remoteAudioStreaming));
        }
        if (remoteAudioStreaming && networkDisconnectWarning && networkDisconnectWarning.style.display !== "none") {
          networkDisconnectWarning.style.display = "none";
          logDebug("Remote audio stream reconnected.", "info");
          setDiagnostic(isRemoteOperator()
            ? 'Mac audio reconnected. Translation can continue.'
            : 'Remote microphone reconnected. Translation can continue.', 'good');
        } else if (!remoteAudioStreaming) {
          const isNetworkSource = audioSourceSelect.value === 'network';
          const isTranslating = translationSocketsReady();
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
  // While Gemini reconnects, sendGeminiPcmFrames keeps this audio in the
  // pre-roll buffer, the same as the local microphone path.
  if (audioSourceSelect.value !== 'network' || !isRunning) return;

  const incomingSamples = decodeBase64Pcm16(base64Data);

  if (ignoreSongsToggle.checked && songClassifier && !songDetectionFailed) {
    try {
      analyzeAudioForSongs(incomingSamples);
    } catch (error) {
      failOpenSongDetection(error);
    }
  }

  const maxVal = peakAmplitude(incomingSamples);
  const step = Math.max(1, Math.floor(incomingSamples.length / micBuffer.length));
  for (let i = 0; i < micBuffer.length; i++) {
    const idx = Math.min(incomingSamples.length - 1, i * step);
    micBuffer[i] = micBuffer[i] * 0.3 + incomingSamples[idx] * 0.7;
  }

  if (isMicMuted) {
    geminiPcmAccumulator.reset();
    micDb.textContent = "Muted";
    micIndicator.classList.remove("active");
    return;
  }

  const pct = Math.round(maxVal * 100);
  micDb.textContent = `${pct}%`;
  if (pct > 5) micIndicator.classList.add("active");
  else micIndicator.classList.remove("active");

  if (isSongSuppressed) {
    geminiPcmAccumulator.reset();
    return;
  }

  sendGeminiPcmFrames(incomingSamples, 'network audio');
}

function syncLocalSubtitleSnapshot() {
  if (!isSocketOpen(localSubtitlesWS) || !isRunning) return;
  localSubtitlesWS.send(JSON.stringify({
    type: 'replace',
    lang1: subtitleState.lang1,
    lang2: subtitleState.lang2
  }));
}

function syncLocalSubtitlesSetup() {
  if (!isSocketOpen(localSubtitlesWS)) return;
  const setup = buildSystemSetup({
    targetLanguage1: sessionConfig?.targetLanguage1 ?? targetLanguageSelect1.value,
    targetLanguage2: sessionConfig?.targetLanguage2 ?? targetLanguageSelect2.value,
    subtitlePacing: sessionConfig?.subtitlePacing ?? subtitlePacingSelect.value,
    obsLanguage: obsLanguageSelect.value
  });
  localSubtitlesWS.send(JSON.stringify({
    type: 'setup',
    ...setup
  }));
  syncLocalSubtitleSnapshot();
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
  if (!isRunning) return;
  if (!geminiSessionNeedsReconnect()) {
    hideRecoveryBanner();
    setDiagnostic('Network restored. Translation services stayed connected.', 'good');
    return;
  }
  clearTimeout(reconnectTimeout);
  reconnectTimeout = null;
  reconnectAttempt = 0;
  showRecoveryBanner('Network restored. Reconnecting now while preserving your subtitles.');
  setDiagnostic('Network restored. Reconnecting translation services now...', 'warning');
  connectGeminiSockets();
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
  const streamerUrl = `${window.location.protocol}//${networkIP}${port}/audio-sender.html?host=1`;
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

  const laptopDashboardUrl = `${window.location.protocol}//${networkIP}${port}/`;
  const laptopTip = document.getElementById('laptop-dashboard-url-tip');
  const laptopQrCanvas = document.getElementById('laptop-dashboard-qr-canvas');
  if (laptopTip) laptopTip.textContent = laptopDashboardUrl;
  if (laptopQrCanvas) {
    QRCode.toCanvas(laptopQrCanvas, laptopDashboardUrl, {
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
    if (copyButton) {
      copyButton.dataset.shareUrl = url;
      if (!copyButton.dataset.shareBound) {
        copyButton.dataset.shareBound = 'true';
        copyButton.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(copyButton.dataset.shareUrl);
            copyButton.textContent = 'Copied';
            setTimeout(() => { copyButton.textContent = 'Copy URL'; }, 1500);
          } catch (error) {
            logDebug(`Could not copy sharing URL: ${error.message}`, 'error');
          }
        });
      }
    }
    if (openButton) {
      openButton.dataset.shareUrl = url;
      if (!openButton.dataset.shareBound) {
        openButton.dataset.shareBound = 'true';
        openButton.addEventListener('click', () => {
          window.open(openButton.dataset.shareUrl, '_blank', 'noopener');
        });
      }
    }
  }

  bindShareActions('copy-projector-url', 'open-projector-url', subtitlesUrl);
  bindShareActions('copy-streamer-url', 'open-streamer-url', streamerUrl);
  bindShareActions('copy-laptop-dashboard-url', 'open-laptop-dashboard-url', laptopDashboardUrl);
  const obsBaseUrl = obsPort
    ? `http://${networkIP}:${obsPort}/`
    : subtitlesUrl;
  const obsTip = document.getElementById('obs-url-tip');
  refreshObsSharingUrl = () => {
    const obsUrl = buildObsUrl(obsBaseUrl);
    if (obsTip) obsTip.textContent = obsUrl;
    bindShareActions('copy-obs-url', 'open-obs-url', obsUrl);
  };
  refreshObsSharingUrl();
}

initProjectorSharingQR();
