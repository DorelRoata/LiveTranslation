import './style.css';

const MAX_BUFFERED_AUDIO_BYTES = 256 * 1024;
const micDeviceSelect = document.getElementById("mic-device-select");
const toggleStreamBtn = document.getElementById("toggle-stream-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const micBar = document.getElementById("mic-bar");
const micDb = document.getElementById("mic-db");
const btnText = toggleStreamBtn.querySelector(".btn-text");

let ws = null;
let isStreaming = false;
let isStarting = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let source = null;

function sendStreamingStatus() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'audio-sender-streaming', streaming: isStreaming }));
}

// Connect WebSocket
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
    statusText.textContent = isStreaming ? "Streaming to Dashboard" : "Connected to Dashboard (Idle)";
    socket.send(JSON.stringify({ type: 'audio-sender-hello' }));
    sendStreamingStatus();
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

// Populate Microphones
async function populateMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
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
  } catch (err) {
    console.error("Error enumerating devices:", err);
  }
}

// Float32 to 16-bit PCM Base64
function floatTo16BitPCMBase64(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const uint8 = new Uint8Array(output.buffer);
  let binary = '';
  for (let i = 0; i < uint8.byteLength; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary);
}

// Start Capture
async function startStreaming() {
  if (isStarting || isStreaming) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("Not connected to the dashboard. Please wait.");
    return;
  }

  isStarting = true;
  toggleStreamBtn.disabled = true;
  btnText.textContent = "Starting...";
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
    pendingProcessor = pendingContext.createScriptProcessor(2048, 1, 1);

    mediaStream = pendingStream;
    audioContext = pendingContext;
    source = pendingSource;
    scriptProcessor = pendingProcessor;
    isStreaming = true;
    
    scriptProcessor.onaudioprocess = (e) => {
      if (!isStreaming || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) return;
      
      const inputData = e.inputBuffer.getChannelData(0);
      const base64Audio = floatTo16BitPCMBase64(inputData);
      
      ws.send(JSON.stringify({
        type: 'input-audio',
        audioData: base64Audio
      }));
      
      // Update visualizer
      let maxVal = 0;
      for (let i = 0; i < inputData.length; i++) {
        if (Math.abs(inputData[i]) > maxVal) maxVal = Math.abs(inputData[i]);
      }
      const pct = Math.round(maxVal * 100);
      micBar.style.height = `${pct}%`;
      micDb.textContent = `${pct}%`;
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    mediaStream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', stopStreaming, { once: true });
    });
    toggleStreamBtn.style.background = "#ef4444";
    toggleStreamBtn.style.boxShadow = "0 0 15px rgba(239, 68, 68, 0.4)";
    btnText.textContent = "Stop Streaming";
    statusText.textContent = "Streaming to Dashboard";
    sendStreamingStatus();
  } catch (err) {
    isStreaming = false;
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
    alert("Could not access microphone: " + err.message);
  } finally {
    isStarting = false;
    toggleStreamBtn.disabled = false;
    if (!isStreaming) btnText.textContent = "Start Streaming";
  }
}

// Stop Capture
function stopStreaming() {
  if (!isStreaming && !isStarting) return;
  isStreaming = false;
  isStarting = false;
  sendStreamingStatus();
  
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
  statusText.textContent = ws?.readyState === WebSocket.OPEN
    ? "Connected to Dashboard (Idle)"
    : "Disconnected - Retrying...";
}

// Event Listeners
toggleStreamBtn.addEventListener("click", () => {
  if (isStarting) return;
  if (isStreaming) {
    stopStreaming();
  } else {
    startStreaming();
  }
});

if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', populateMicDevices);
} else {
  toggleStreamBtn.disabled = true;
  statusText.textContent = 'Microphone access is unavailable in this browser.';
}

// Initialize
if (navigator.mediaDevices) populateMicDevices();
connectWebSocket();
