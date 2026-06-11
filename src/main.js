import './style.css';

// --- Constants ---
const HOST = "generativelanguage.googleapis.com";
const API_VERSION = "v1alpha";
const PATH = `ws/google.ai.generativelanguage.${API_VERSION}.GenerativeService.BidiGenerateContent`;
const MODEL = "models/gemini-3.5-live-translate-preview";

// --- State Variables ---
let socket = null;
let audioContextInput = null;
let audioContextOutput = null;
let micStream = null;
let scriptProcessor = null;
let nextStartTime = 0;
let activeSources = [];
let isRunning = false;

// Audio Visualizer buffers (last 512 samples)
const micBuffer = new Float32Array(512);
const outBuffer = new Float32Array(512);

// UI Elements
const apiKeyInput = document.getElementById("api-key-input");
const toggleApiKeyBtn = document.getElementById("toggle-api-key");
const targetLanguageSelect = document.getElementById("target-language-select");
const audioSourceSelect = document.getElementById("audio-source-select");
const echoToggle = document.getElementById("echo-toggle");
const startBtn = document.getElementById("start-btn");
const connectionStatus = document.getElementById("connection-status");

const micDb = document.getElementById("mic-db");
const outputDb = document.getElementById("output-db");
const micCanvas = document.getElementById("mic-canvas");
const outputCanvas = document.getElementById("output-canvas");

const inputList = document.getElementById("input-transcript-list");
const outputList = document.getElementById("output-transcript-list");
const inputPlaceholder = document.getElementById("input-placeholder");
const outputPlaceholder = document.getElementById("output-placeholder");

const clearInputBtn = document.getElementById("clear-input-log");
const clearOutputBtn = document.getElementById("clear-output-log");
const debugLogList = document.getElementById("debug-log-list");
const clearDebugBtn = document.getElementById("clear-debug-log");

const micIndicator = document.querySelector(".input-pulse");
const outputIndicator = document.querySelector(".output-pulse");

// --- API Key Local Storage ---
if (localStorage.getItem("gemini_api_key")) {
  apiKeyInput.value = localStorage.getItem("gemini_api_key");
}

apiKeyInput.addEventListener("input", () => {
  localStorage.setItem("gemini_api_key", apiKeyInput.value.trim());
});

// Toggle API Key Visibility
toggleApiKeyBtn.addEventListener("click", () => {
  if (apiKeyInput.type === "password") {
    apiKeyInput.type = "text";
    toggleApiKeyBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>
    `;
  } else {
    apiKeyInput.type = "password";
    toggleApiKeyBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
    `;
  }
});

// Clear Logs
clearInputBtn.addEventListener("click", () => {
  inputList.innerHTML = "";
  inputPlaceholder.style.display = "block";
});
clearOutputBtn.addEventListener("click", () => {
  outputList.innerHTML = "";
  outputPlaceholder.style.display = "block";
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

// --- Debug Logging Utility ---
let chunksSent = 0;

function logDebug(message, type = "info") {
  if (!debugLogList) return;
  const line = document.createElement("div");
  line.className = `debug-line ${type}`;
  let color = "#cbd5e1";
  let prefix = "[System]";
  
  if (type === "error") {
    color = "#f87171";
    prefix = "[Error]";
  } else if (type === "ws-sent") {
    color = "#60a5fa";
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
}

clearDebugBtn.addEventListener("click", () => {
  debugLogList.innerHTML = `<div class="debug-line" style="color: #64748b;">[System] Logs cleared.</div>`;
});

// --- Visualizer Rendering ---
function initVisualizer(canvas, dataBuffer, color) {
  const ctx = canvas.getContext("2d");
  
  // Resize canvas to physical display size
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
    
    // Draw background subtle grid lines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Draw waveform line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    const sliceWidth = width / dataBuffer.length;
    let x = 0;
    
    for (let i = 0; i < dataBuffer.length; i++) {
      // Amplify values slightly for visual effect
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
    
    // Slowly decay buffer to smooth out lines when silence occurs
    for (let i = 0; i < dataBuffer.length; i++) {
      dataBuffer[i] *= 0.92;
    }
  }
  
  draw();
}

// Start visualizer loops
initVisualizer(micCanvas, micBuffer, "#ff4d6d");
initVisualizer(outputCanvas, outBuffer, "#00f5ff");

// --- Audio Playback Pipeline (Gemini Output) ---
function initOutputAudio() {
  if (!audioContextOutput) {
    audioContextOutput = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000 // Gemini returns 24kHz audio
    });
    nextStartTime = 0;
  }
  if (audioContextOutput.state === "suspended") {
    audioContextOutput.resume();
  }
}

function playPCMChunk(base64Data) {
  initOutputAudio();
  
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
  
  // Feed output visualizer buffer
  // Downsample/slice float32 array to fit visualizer buffer
  const step = Math.max(1, Math.floor(float32.length / outBuffer.length));
  for (let i = 0; i < outBuffer.length; i++) {
    const idx = Math.min(float32.length - 1, i * step);
    // Add new values, smoothing with current values
    outBuffer[i] = outBuffer[i] * 0.3 + float32[idx] * 0.7;
  }
  
  // Update UI volume text
  const pct = Math.round(maxVal * 100);
  outputDb.textContent = `${pct}%`;
  
  // 3. Create AudioBuffer
  const audioBuffer = audioContextOutput.createBuffer(1, float32.length, 24000);
  audioBuffer.copyToChannel(float32, 0);
  
  // 4. Schedule source playing
  const sourceNode = audioContextOutput.createBufferSource();
  sourceNode.buffer = audioBuffer;
  
  // Connect to speakers
  sourceNode.connect(audioContextOutput.destination);
  
  const now = audioContextOutput.currentTime;
  if (nextStartTime < now) {
    nextStartTime = now;
  }
  
  sourceNode.start(nextStartTime);
  
  // Track this node in case of interruptions
  activeSources.push(sourceNode);
  
  // Remove node from list when it ends
  sourceNode.onended = () => {
    activeSources = activeSources.filter(s => s !== sourceNode);
    if (activeSources.length === 0) {
      outputIndicator.classList.remove("active");
      outputDb.textContent = "0%";
    }
  };
  
  nextStartTime += audioBuffer.duration;
  outputIndicator.classList.add("active");
}

function stopAllPlayback() {
  activeSources.forEach(source => {
    try {
      source.stop();
    } catch (e) {
      // Ignore if already stopped
    }
  });
  activeSources = [];
  nextStartTime = 0;
  outputIndicator.classList.remove("active");
  outputDb.textContent = "0%";
}

// --- Audio Capture Pipeline (Mic Input) ---
async function startAudioCapture() {
  if (!navigator.mediaDevices) {
    throw new Error("navigator.mediaDevices is not available. Please make sure you are accessing this application via http://localhost:5173/ in your browser URL bar. Browsers block microphone and audio sharing on local file:// files for security.");
  }

  const sourceVal = audioSourceSelect.value;
  logDebug(`Initializing capture context for: ${sourceVal}...`, "info");

  audioContextInput = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 16000 // Gemini expects 16kHz audio input
  });
  
  if (sourceVal === "system") {
    logDebug("Requesting getDisplayMedia for system audio loopback...", "info");
    micStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        systemAudio: "include"
      }
    });
    
    logDebug("getDisplayMedia stream obtained. Discarding video tracks...", "info");
    micStream.getVideoTracks().forEach(track => track.stop());
    
    // Check if user checked "Share system audio"
    if (micStream.getAudioTracks().length === 0) {
      throw new Error("No system audio track shared. When prompted, make sure to check 'Share system audio' or 'Share tab audio' in the sharing dialog.");
    }
    logDebug("System audio loopback track captured successfully.", "info");
  } else {
    logDebug("Requesting getUserMedia for microphone access...", "info");
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    logDebug("Microphone captured successfully.", "info");
  }
  
  if (!audioContextInput) {
    throw new Error("Session disconnected. This usually happens if the connection to Google was closed (please verify your Gemini API key is correct and has access to the Live API).");
  }
  const source = audioContextInput.createMediaStreamSource(micStream);
  
  // ScriptProcessor bufferSize = 2048, 1 input channel, 1 output channel
  scriptProcessor = audioContextInput.createScriptProcessor(2048, 1, 1);
  chunksSent = 0;
  
  scriptProcessor.onaudioprocess = (e) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    
    const float32 = e.inputBuffer.getChannelData(0);
    
    // Calculate volume level for display
    let maxVal = 0;
    const pcm16 = new Int16Array(float32.length);
    
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1.0, Math.min(1.0, float32[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      if (Math.abs(s) > maxVal) {
        maxVal = Math.abs(s);
      }
    }
    
    // Update mic visualizer buffer
    const step = Math.max(1, Math.floor(float32.length / micBuffer.length));
    for (let i = 0; i < micBuffer.length; i++) {
      const idx = Math.min(float32.length - 1, i * step);
      micBuffer[i] = micBuffer[i] * 0.3 + float32[idx] * 0.7;
    }
    
    // Update mic volume level UI
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
    
    socket.send(JSON.stringify(mediaMsg));
    
    chunksSent++;
    if (chunksSent % 25 === 0) {
      logDebug(`Sent ${chunksSent} audio chunks to Google...`, "ws-sent");
    }
  };
  
  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContextInput.destination);
}

function stopAudioCapture() {
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
}

// --- UI Transcript Renderers ---
function addInputTranscript(text) {
  inputPlaceholder.style.display = "none";
  
  // Check if the last item is a streaming item, or create new bubble
  const lastBubble = inputList.lastElementChild;
  const bubble = document.createElement("div");
  bubble.className = "transcript-bubble";
  bubble.textContent = text;
  
  const ts = document.createElement("span");
  ts.className = "timestamp";
  ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  bubble.appendChild(ts);
  
  inputList.appendChild(bubble);
  document.getElementById("input-transcript-scroll").scrollTop = document.getElementById("input-transcript-scroll").scrollHeight;
}

let currentStreamingBubble = null;

function updateOutputTranscript(text, isFinal = false) {
  outputPlaceholder.style.display = "none";
  
  if (!currentStreamingBubble) {
    currentStreamingBubble = document.createElement("div");
    currentStreamingBubble.className = "transcript-bubble";
    outputList.appendChild(currentStreamingBubble);
  }
  
  if (isFinal) {
    currentStreamingBubble.textContent = text;
    currentStreamingBubble.classList.remove("streaming-text");
    
    const ts = document.createElement("span");
    ts.className = "timestamp";
    ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    currentStreamingBubble.appendChild(ts);
    
    currentStreamingBubble = null;
  } else {
    currentStreamingBubble.textContent = text + "...";
    currentStreamingBubble.classList.add("streaming-text");
  }
  
  document.getElementById("output-transcript-scroll").scrollTop = document.getElementById("output-transcript-scroll").scrollHeight;
}

// --- WebSocket Handlers ---
function startSession() {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    alert("Please enter a valid Gemini API Key.");
    return;
  }
  
  const targetLanguage = targetLanguageSelect.value;
  const echoTargetLanguage = echoToggle.checked;
  
  updateConnectionStatus("connecting", "Connecting...");
  logDebug(`Connecting to Gemini Live API WebSocket (v1alpha) using key prefix: ${apiKey.substring(0, 5)}...`, "info");
  
  const url = `wss://${HOST}/${PATH}?key=${apiKey}`;
  socket = new WebSocket(url);
  
  socket.onopen = async () => {
    updateConnectionStatus("connected", "Connected");
    logDebug("WebSocket connection opened successfully.", "info");
    
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
    
    logDebug(`Sending setup configuration for model: ${MODEL} | Target Language: ${targetLanguage}`, "ws-sent");
    socket.send(JSON.stringify(setupMsg));
    
    // Start capturing mic once websocket is open
    try {
      await startAudioCapture();
      isRunning = true;
      startBtn.classList.add("recording");
      startBtn.querySelector(".btn-text").textContent = "Stop Interpreter";
    } catch (err) {
      console.error("Failed to capture audio:", err);
      logDebug(`Failed to capture audio: ${err.message}`, "error");
      alert("Failed to capture audio: " + err.message);
      disconnectSession();
    }
  };
  
  socket.onmessage = async (event) => {
    try {
      let text;
      if (event.data instanceof Blob) {
        text = await event.data.text();
      } else if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(event.data);
      } else {
        text = event.data;
      }
      
      const data = JSON.parse(text);
      
      // Log received message type
      if (data.setupComplete) {
        logDebug("Received: setupComplete acknowledgment.", "ws-recv");
        console.log("Gemini setup complete");
        return;
      }
      
      if (data.serverContent) {
        const sc = data.serverContent;
        
        if (sc.interrupted) {
          logDebug("Received: model interrupted event.", "audio");
          console.log("Model interrupted!");
          stopAllPlayback();
          currentStreamingBubble = null;
          return;
        }
        
        if (sc.modelTurn && sc.modelTurn.parts) {
          logDebug(`Received: serverContent modelTurn with ${sc.modelTurn.parts.length} parts. Playing audio...`, "ws-recv");
          sc.modelTurn.parts.forEach(part => {
            if (part.inlineData && part.inlineData.data) {
              playPCMChunk(part.inlineData.data);
            }
          });
        }
      }
      
      // Handle Transcripts
      const inputTx = data.inputTranscription || (data.serverContent && data.serverContent.inputTranscription);
      if (inputTx) {
        const text = inputTx.text;
        if (text) {
          logDebug(`Detected input speech: "${text}"`, "audio");
          addInputTranscript(text);
        }
      }
      
      const outputTx = data.outputTranscription || (data.serverContent && data.serverContent.outputTranscription);
      if (outputTx) {
        const text = outputTx.text;
        if (text) {
          logDebug(`Translated output text: "${text}"`, "audio");
          updateOutputTranscript(text, outputTx.final);
        }
      }
      
    } catch (err) {
      console.error("Error parsing socket message:", err);
      logDebug(`Error parsing server message: ${err.message}`, "error");
    }
  };
  
  socket.onclose = (event) => {
    console.log("WebSocket connection closed:", event);
    logDebug(`WebSocket connection closed. Code: ${event.code} | Reason: ${event.reason || 'None provided'}`, "info");
    disconnectSession();
  };
  
  socket.onerror = (err) => {
    console.error("WebSocket error:", err);
    logDebug(`WebSocket error: ${err.message || 'Unknown network error'}`, "error");
    disconnectSession();
  };
}

function disconnectSession() {
  isRunning = false;
  startBtn.classList.remove("recording");
  startBtn.querySelector(".btn-text").textContent = "Start Translation";
  
  updateConnectionStatus("disconnected", "Disconnected");
  
  logDebug("Disconnecting session...", "info");
  stopAudioCapture();
  stopAllPlayback();
  currentStreamingBubble = null;
  
  if (socket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    socket = null;
  }
}

function updateConnectionStatus(statusClass, statusText) {
  connectionStatus.className = `status-badge ${statusClass}`;
  connectionStatus.querySelector(".status-text").textContent = statusText;
}

// Start Button Handler
startBtn.addEventListener("click", () => {
  if (isRunning) {
    disconnectSession();
  } else {
    startSession();
  }
});
