const micDeviceSelect = document.getElementById("mic-device-select");
const toggleStreamBtn = document.getElementById("toggle-stream-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const micBar = document.getElementById("mic-bar");
const micDb = document.getElementById("mic-db");
const btnText = toggleStreamBtn.querySelector(".btn-text");

let ws = null;
let isStreaming = false;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let source = null;

// Connect WebSocket
function connectWebSocket() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/local-subtitles-ws`;
  
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    statusDot.classList.add("active");
    statusText.textContent = "Connected to Dashboard";
    ws.send(JSON.stringify({ type: 'audio-sender-hello' }));
  };

  ws.onclose = () => {
    statusDot.classList.remove("active");
    statusText.textContent = "Disconnected - Retrying...";
    if (isStreaming) {
      stopStreaming();
    }
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
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
  if (ws.readyState !== WebSocket.OPEN) {
    alert("Not connected to the dashboard. Please wait.");
    return;
  }

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

    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    source = audioContext.createMediaStreamSource(mediaStream);
    scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);
    
    scriptProcessor.onaudioprocess = (e) => {
      if (!isStreaming || ws.readyState !== WebSocket.OPEN) return;
      
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

    isStreaming = true;
    toggleStreamBtn.style.background = "#ef4444";
    toggleStreamBtn.style.boxShadow = "0 0 15px rgba(239, 68, 68, 0.4)";
    btnText.textContent = "Stop Streaming";
    statusText.textContent = "Streaming to Dashboard";
    
  } catch (err) {
    console.error("Error accessing microphone:", err);
    alert("Could not access microphone: " + err.message);
  }
}

// Stop Capture
function stopStreaming() {
  isStreaming = false;
  
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
  statusText.textContent = "Connected to Dashboard (Idle)";
}

// Event Listeners
toggleStreamBtn.addEventListener("click", () => {
  if (isStreaming) {
    stopStreaming();
  } else {
    startStreaming();
  }
});

navigator.mediaDevices.addEventListener('devicechange', populateMicDevices);

// Initialize
populateMicDevices();
connectWebSocket();
