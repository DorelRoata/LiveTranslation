import './style.css';
import { createScreenWakeLock } from './wake-lock.js';
import { downsampleToRate, floatToPcm16, peakAmplitude, TARGET_CAPTURE_RATE } from './pcm-audio.js';

const MAX_BUFFERED_AUDIO_BYTES = 256 * 1024;
const HOST_MODE = new URLSearchParams(window.location.search).get('host') === '1';
const PREFS_KEY = HOST_MODE ? 'live_translate_host_audio_v1' : 'live_translate_sender_v1';
const micDeviceSelect = document.getElementById("mic-device-select");
const toggleStreamBtn = document.getElementById("toggle-stream-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const micBar = document.getElementById("mic-bar");
const micDb = document.getElementById("mic-db");
const btnText = toggleStreamBtn.querySelector(".btn-text");
const wakeLockStatus = document.getElementById('wake-lock-status');
const autoStreamToggle = document.getElementById('auto-stream-toggle');
const pageTitle = document.getElementById('sender-title');
const pageCopy = document.getElementById('sender-copy');

let ws = null;
let isStreaming = false;
let isStarting = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let source = null;
let captureKeepAlive = null;
let autoStartAttempted = false;

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      deviceId: micDeviceSelect.value,
      autoStream: Boolean(autoStreamToggle?.checked)
    }));
  } catch (error) {
    console.warn('Unable to save microphone sender preferences:', error);
  }
}

function shouldAutoStream() {
  if (autoStreamToggle) return autoStreamToggle.checked;
  return HOST_MODE;
}

function applyHostMode() {
  document.title = HOST_MODE ? 'Mac audio - Live Translate' : 'Remote microphone - Live Translate';
  if (pageTitle) pageTitle.textContent = HOST_MODE ? 'Mac audio' : 'Remote microphone';
  if (pageCopy) {
    pageCopy.textContent = HOST_MODE
      ? 'This Mac keeps capturing audio for the dashboard, including when you operate Live Translate from a laptop on the same network.'
      : 'Capture microphone audio on this device and stream it to the Live Translate dashboard.';
  }
  if (autoStreamToggle && loadPrefs().autoStream !== false) autoStreamToggle.checked = true;
}

const wakeLock = createScreenWakeLock(({ status, supported, desired, active }) => {
  if (!supported) {
    wakeLockStatus.dataset.state = 'warning';
    wakeLockStatus.textContent = 'This browser cannot prevent screen dimming. Keep the Mac connected to power if needed.';
  } else if (active) {
    wakeLockStatus.dataset.state = 'active';
    wakeLockStatus.textContent = HOST_MODE
      ? 'Screen will stay awake while Mac audio is streaming.'
      : 'Screen will stay awake while microphone streaming is active.';
  } else if (desired && (status === 'blocked' || status === 'released')) {
    wakeLockStatus.dataset.state = 'warning';
    wakeLockStatus.textContent = 'Screen wake lock was blocked. Disable Low Power Mode and tap Start Streaming again.';
  } else if (desired) {
    wakeLockStatus.dataset.state = 'idle';
    wakeLockStatus.textContent = 'Waiting to keep the screen awake...';
  } else {
    wakeLockStatus.dataset.state = 'idle';
    wakeLockStatus.textContent = HOST_MODE
      ? 'Keep this window open. It reconnects automatically if the dashboard restarts.'
      : 'Screen wake lock activates while streaming.';
  }
});

function sendStreamingStatus() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'audio-sender-streaming', streaming: isStreaming }));
}

function updateIdleStatus() {
  if (isStreaming) {
    statusText.textContent = ws?.readyState === WebSocket.OPEN
      ? (HOST_MODE ? 'Streaming this Mac to the dashboard' : 'Streaming to Dashboard')
      : 'Reconnecting - microphone remains active';
    return;
  }
  if (ws?.readyState === WebSocket.OPEN) {
    statusText.textContent = HOST_MODE ? 'Connected (Mac audio idle)' : 'Connected to Dashboard (Idle)';
    return;
  }
  statusText.textContent = 'Disconnected - retrying...';
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/local-subtitles-ws`;
  const socket = new WebSocket(wsUrl);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    clearTimeout(reconnectTimer);
    reconnectAttempt = 0;
    statusDot.classList.add("active");
    socket.send(JSON.stringify({ type: 'audio-sender-hello' }));
    sendStreamingStatus();
    updateIdleStatus();
    if (shouldAutoStream() && !isStreaming && !isStarting) startStreaming();
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    statusDot.classList.remove("active");
    const delay = Math.min(1000 * (2 ** reconnectAttempt), 8000);
    reconnectAttempt++;
    statusText.textContent = isStreaming
      ? `Reconnecting - microphone remains active`
      : `Disconnected - retrying in ${Math.round(delay / 1000)}s`;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, delay);
  };

  socket.onerror = (err) => {
    if (ws !== socket) return;
    console.error("WebSocket error:", err);
    socket.close();
  };
}

async function populateMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const previous = micDeviceSelect.value || loadPrefs().deviceId || 'default';
    micDeviceSelect.innerHTML = "";
    
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "default";
    defaultOpt.textContent = "Default System Microphone";
    micDeviceSelect.appendChild(defaultOpt);
    
    devices.forEach(device => {
      if (device.kind === "audioinput" && device.deviceId !== "default" && device.deviceId !== "communications") {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${micDeviceSelect.length}`;
        micDeviceSelect.appendChild(option);
      }
    });
    if (previous && Array.from(micDeviceSelect.options).some(option => option.value === previous)) {
      micDeviceSelect.value = previous;
    }
  } catch (err) {
    console.error("Error enumerating devices:", err);
  }
}

async function startStreaming() {
  if (isStarting || isStreaming) return;

  isStarting = true;
  toggleStreamBtn.disabled = true;
  btnText.textContent = "Starting...";
  wakeLock.setEnabled(true);
  let pendingStream = null;
  let pendingContext = null;
  let pendingSource = null;
  let pendingProcessor = null;

  try {
    const constraints = {
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    };
    
    if (micDeviceSelect.value !== 'default') {
      constraints.audio.deviceId = { exact: micDeviceSelect.value };
    }

    pendingStream = await navigator.mediaDevices.getUserMedia(constraints);
    pendingContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    if (pendingContext.state === 'suspended') await pendingContext.resume();
    pendingSource = pendingContext.createMediaStreamSource(pendingStream);
    pendingProcessor = pendingContext.createScriptProcessor(1024, 1, 1);

    mediaStream = pendingStream;
    audioContext = pendingContext;
    source = pendingSource;
    scriptProcessor = pendingProcessor;
    isStreaming = true;
    const captureSampleRate = pendingContext.sampleRate || TARGET_CAPTURE_RATE;

    scriptProcessor.onaudioprocess = (e) => {
      if (!isStreaming || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) return;

      const inputData = downsampleToRate(e.inputBuffer.getChannelData(0), captureSampleRate);
      const pcm16 = floatToPcm16(inputData);
      const uint8 = new Uint8Array(pcm16.buffer);
      let binary = '';
      for (let i = 0; i < uint8.byteLength; i++) binary += String.fromCharCode(uint8[i]);
      const base64Audio = btoa(binary);

      ws.send(JSON.stringify({
        type: 'input-audio',
        audioData: base64Audio
      }));

      const pct = Math.round(peakAmplitude(inputData) * 100);
      micBar.style.height = `${pct}%`;
      micDb.textContent = `${pct}%`;
    };

    source.connect(scriptProcessor);
    const captureSink = audioContext.createMediaStreamDestination();
    scriptProcessor.connect(captureSink);
    captureKeepAlive = new Audio();
    captureKeepAlive.muted = true;
    captureKeepAlive.srcObject = captureSink.stream;
    const keepAlivePlay = captureKeepAlive.play();
    if (keepAlivePlay && typeof keepAlivePlay.catch === 'function') keepAlivePlay.catch(() => {});

    mediaStream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', stopStreaming, { once: true });
    });
    toggleStreamBtn.style.background = "#ef4444";
    toggleStreamBtn.style.boxShadow = "0 0 15px rgba(239, 68, 68, 0.4)";
    btnText.textContent = "Stop Streaming";
    sendStreamingStatus();
    updateIdleStatus();
    savePrefs();
    populateMicDevices();
  } catch (err) {
    isStreaming = false;
    wakeLock.setEnabled(false);
    pendingProcessor?.disconnect();
    pendingSource?.disconnect();
    pendingStream?.getTracks().forEach(track => track.stop());
    if (pendingContext && pendingContext.state !== 'closed') {
      await pendingContext.close().catch(() => {});
    }
    mediaStream = null;
    audioContext = null;
    source = null;
    scriptProcessor = null;
    console.error("Error accessing microphone:", err);
    statusText.textContent = err.name === 'NotAllowedError'
      ? 'Microphone permission is required. Click Start Streaming once.'
      : `Could not access microphone: ${err.message}`;
  } finally {
    isStarting = false;
    toggleStreamBtn.disabled = false;
    if (!isStreaming) btnText.textContent = "Start Streaming";
  }
}

function stopStreaming() {
  if (!isStreaming && !isStarting) return;
  isStreaming = false;
  isStarting = false;
  wakeLock.setEnabled(false);
  sendStreamingStatus();
  
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
  if (source) {
    source.disconnect();
    source = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  micBar.style.height = "0%";
  micDb.textContent = "0%";
  toggleStreamBtn.style.background = "";
  toggleStreamBtn.style.boxShadow = "";
  btnText.textContent = "Start Streaming";
  updateIdleStatus();
}

toggleStreamBtn.addEventListener("click", () => {
  if (isStarting) return;
  if (isStreaming) {
    if (autoStreamToggle) autoStreamToggle.checked = false;
    savePrefs();
    stopStreaming();
  } else {
    if (autoStreamToggle) autoStreamToggle.checked = true;
    savePrefs();
    startStreaming();
  }
});

autoStreamToggle?.addEventListener('change', () => {
  savePrefs();
  if (autoStreamToggle.checked && !isStreaming && !isStarting) startStreaming();
});

micDeviceSelect.addEventListener('change', savePrefs);

if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', populateMicDevices);
} else {
  toggleStreamBtn.disabled = true;
  statusText.textContent = 'Microphone access is unavailable in this browser.';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') connectWebSocket();
});

applyHostMode();
if (navigator.mediaDevices) {
  populateMicDevices().then(() => {
    if (shouldAutoStream() && !autoStartAttempted) {
      autoStartAttempted = true;
      startStreaming();
    }
  });
}
connectWebSocket();
