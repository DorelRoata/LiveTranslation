import './style.css';

// --- Constants ---
const HOST = "generativelanguage.googleapis.com";
const API_VERSION = "v1alpha";
const PATH = `ws/google.ai.generativelanguage.${API_VERSION}.GenerativeService.BidiGenerateContent`;
const MODEL = "models/gemini-3.5-live-translate-preview";

// --- State Variables ---
let socket1 = null;
let socket2 = null;
let audioContextInput = null;
let audioContextOutput = null;
let micStream = null;
let scriptProcessor = null;

let nextStartTime1 = 0;
let nextStartTime2 = 0;
let activeSources1 = [];
let activeSources2 = [];
let isRunning = false;
let subtitleWindow = null;
let localSubtitlesWS = null;

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
const audioSourceSelect = document.getElementById("audio-source-select");

const targetLanguageSelect1 = document.getElementById("target-language-select-1");
const playVoiceCheckbox1 = document.getElementById("play-voice-1");
const targetLanguageSelect2 = document.getElementById("target-language-select-2");
const playVoiceCheckbox2 = document.getElementById("play-voice-2");

const echoToggle = document.getElementById("echo-toggle");
const startBtn = document.getElementById("start-btn");
const subtitlesBtn = document.getElementById("subtitles-btn");
const connectionStatus = document.getElementById("connection-status");

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

const micIndicator = document.querySelector(".input-pulse");
const outputIndicator1 = document.querySelector(".output-pulse-1");
const outputIndicator2 = document.querySelector(".output-pulse-2");

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
clearOutputBtn1.addEventListener("click", () => {
  outputList1.innerHTML = "";
  outputPlaceholder1.style.display = "block";
});
clearOutputBtn2.addEventListener("click", () => {
  outputList2.innerHTML = "";
  outputPlaceholder2.style.display = "block";
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
initVisualizer(micCanvas, micBuffer, "#ff4d6d");
initVisualizer(outputCanvas, outBuffer, "#00f5ff");

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
  if (isPlayChecked && localSubtitlesWS && localSubtitlesWS.readyState === WebSocket.OPEN) {
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
  
  sourceNode.connect(audioContextOutput.destination);
  
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
  if (!navigator.mediaDevices) {
    throw new Error("navigator.mediaDevices is not available. Please make sure you are accessing this application via http://localhost:5173/ in your browser URL bar. Browsers block microphone and audio sharing on local file:// files for security.");
  }

  const sourceVal = audioSourceSelect.value;
  logDebug(`Initializing capture context for: ${sourceVal}...`, "info");

  audioContextInput = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 16000
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
  
  scriptProcessor = audioContextInput.createScriptProcessor(2048, 1, 1);
  chunksSent = 0;
  
  scriptProcessor.onaudioprocess = (e) => {
    const socket1Ready = socket1 && socket1.readyState === WebSocket.OPEN;
    const socket2Ready = socket2 && socket2.readyState === WebSocket.OPEN;
    if (!socket1Ready && !socket2Ready) return;
    
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

function addInputTranscript(text) {
  inputPlaceholder.style.display = "none";
  
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
    if (channelId === 1) {
      currentStreamingBubble1 = currentBubble;
    } else {
      currentStreamingBubble2 = currentBubble;
    }
  }
  
  if (isFinal) {
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
  
  subtitleWindow = window.open("/subtitles.html", "GeminiLiveSubtitles", "width=900,height=600,menubar=no,toolbar=no,location=no,status=no");
  
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
  if (localSubtitlesWS && localSubtitlesWS.readyState === WebSocket.OPEN) {
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
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    alert("Please enter a valid Gemini API Key.");
    return;
  }
  
  const targetLanguage1 = targetLanguageSelect1.value;
  const targetLanguage2 = targetLanguageSelect2.value;
  const echoTargetLanguage = echoToggle.checked;
  
  const isDual = targetLanguage2 !== "none";
  
  // Clear and sync local subtitles WS
  if (localSubtitlesWS && localSubtitlesWS.readyState === WebSocket.OPEN) {
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
  
  // Disable button and update UI state immediately
  startBtn.disabled = true;
  startBtn.querySelector(".btn-text").textContent = "Starting...";
  
  // Capture audio immediately from user gesture before WebSocket async calls
  try {
    await startAudioCapture();
  } catch (err) {
    console.error("Failed to capture audio:", err);
    logDebug(`Failed to capture audio: ${err.message}`, "error");
    alert("Failed to capture audio: " + err.message);
    startBtn.disabled = false;
    startBtn.querySelector(".btn-text").textContent = "Start Translation";
    return;
  }
  
  updateConnectionStatus("connecting", "Connecting...");
  logDebug(`Connecting to Gemini Live API...`, "info");
  
  const url = `wss://${HOST}/${PATH}?key=${apiKey}`;
  
  // Create Connection 1
  socket1 = new WebSocket(url);
  setupSocket(socket1, 1, targetLanguage1, echoTargetLanguage);
  
  // Create Connection 2 if dual
  if (isDual) {
    socket2 = new WebSocket(url);
    setupSocket(socket2, 2, targetLanguage2, echoTargetLanguage);
  }
}

function setupSocket(ws, channelId, targetLanguage, echoTargetLanguage) {
  ws.onopen = async () => {
    logDebug(`WebSocket ${channelId} opened successfully.`, "info");
    
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
    
    logDebug(`WebSocket ${channelId}: Sending setup for ${targetLanguage}...`, "ws-sent");
    ws.send(JSON.stringify(setupMsg));
    
    // Start session when all active sockets are OPEN
    const isDual = targetLanguageSelect2.value !== "none";
    const socket1Ready = socket1 && socket1.readyState === WebSocket.OPEN;
    const socket2Ready = socket2 && socket2.readyState === WebSocket.OPEN;
    
    if (socket1Ready && (!isDual || socket2Ready)) {
      updateConnectionStatus("connected", "Connected");
      logDebug("All connections active. Ready.", "info");
      
      isRunning = true;
      startBtn.disabled = false;
      startBtn.classList.add("recording");
      startBtn.querySelector(".btn-text").textContent = "Stop Interpreter";
    }
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
      
      const data = JSON.parse(text);
      
      if (data.setupComplete) {
        logDebug(`Received: WebSocket ${channelId} setupComplete acknowledgment.`, "ws-recv");
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
          console.log("[Gemini OutputTx]", "channel:", channelId, "final:", outputTx.final, "keys:", Object.keys(outputTx), "text:", text);
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
    console.log(`WebSocket ${channelId} connection closed:`, event);
    logDebug(`WebSocket ${channelId} connection closed. Code: ${event.code} | Reason: ${event.reason || 'None provided'}`, "info");
    disconnectSession();
  };
  
  ws.onerror = (err) => {
    console.error(`WebSocket ${channelId} error:`, err);
    logDebug(`WebSocket ${channelId} error: ${err.message || 'Unknown network error'}`, "error");
    disconnectSession();
  };
}

function disconnectSession() {
  isRunning = false;
  startBtn.disabled = false;
  startBtn.classList.remove("recording");
  startBtn.querySelector(".btn-text").textContent = "Start Translation";
  
  updateConnectionStatus("disconnected", "Disconnected");
  
  logDebug("Disconnecting session...", "info");
  stopAudioCapture();
  stopAllPlayback();
  currentStreamingBubble1 = null;
  currentStreamingBubble2 = null;
  
  // Reset subtitle presentation state
  ['lang1', 'lang2'].forEach(lane => {
    subtitleState[lane].accumulatedText = "";
  });
  
  // Re-render empty subtitles (or default placeholders)
  renderSubtitleLane("lang1");
  renderSubtitleLane("lang2");
  
  if (localSubtitlesWS && localSubtitlesWS.readyState === WebSocket.OPEN) {
    localSubtitlesWS.send(JSON.stringify({ type: 'clear' }));
  }
  
  if (socket1) {
    if (socket1.readyState === WebSocket.OPEN || socket1.readyState === WebSocket.CONNECTING) {
      socket1.close();
    }
    socket1 = null;
  }
  
  if (socket2) {
    if (socket2.readyState === WebSocket.OPEN || socket2.readyState === WebSocket.CONNECTING) {
      socket2.close();
    }
    socket2 = null;
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

// Subtitles Button Handler
subtitlesBtn.addEventListener("click", () => {
  openSubtitleWindow();
});

// --- Local Subtitles WebSocket Broadcasting ---
function initLocalSubtitlesWS() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/local-subtitles-ws`;
  
  localSubtitlesWS = new WebSocket(wsUrl);

  localSubtitlesWS.onopen = () => {
    logDebug("Connected to local subtitles broadcast server.", "info");
    syncLocalSubtitlesSetup();
  };

  localSubtitlesWS.onclose = () => {
    logDebug("Disconnected from local subtitles server. Reconnecting in 3s...", "info");
    setTimeout(initLocalSubtitlesWS, 3000);
  };

  localSubtitlesWS.onerror = (err) => {
    console.error("Local subtitles WebSocket error:", err);
  };
}

function syncLocalSubtitlesSetup() {
  if (localSubtitlesWS && localSubtitlesWS.readyState === WebSocket.OPEN) {
    localSubtitlesWS.send(JSON.stringify({
      type: 'setup',
      targetLanguage1: targetLanguageSelect1.value,
      targetLanguage2: targetLanguageSelect2.value,
      isDual: targetLanguageSelect2.value !== "none"
    }));
  }
}

// Initialize local WebSocket connection on page load
initLocalSubtitlesWS();

// Update Projector Sharing URL Tip
const projectorTip = document.getElementById("projector-url-tip");
if (projectorTip) {
  projectorTip.textContent = `${window.location.protocol}//${window.location.host}/subtitles.html`;
}
