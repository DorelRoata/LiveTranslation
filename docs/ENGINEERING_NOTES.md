# Live Translation — Engineering Notes & Lessons Learned

This document records architectural decisions, critical constraints, and failed approaches discovered during development and live church sermon trials. **Review this document before proposing changes to the translation pipeline, audio streaming, or Gemini API parameters.**

---

## 1. Gemini Live Translate API Architecture

### ❌ Failed: System Instructions (`systemInstruction`)
* **What happened:** In `v1.3.14`, system instructions (e.g. *"You are a church interpreter..."*) were sent in the `setup` message.
* **Failure mode:** Gemini Live Translate behaves like a turn-based conversational bot rather than a continuous streaming interpreter. It translated exactly one phrase, waited for a conversational turn response, and went completely silent while the input meter kept moving.
* **Lesson & Rule:** **Do not send `systemInstruction` to `models/gemini-3.5-live-translate-preview`.** The model is fine-tuned strictly for real-time speech translation via `translationConfig`.
* **Solution for Terminology:** Use client/server post-processing glossary filters (`src/glossary.js`) rather than system prompts.

---

### ❌ Failed: Default Activity Interruption (Barge-In)
* **What happened:** The Gemini Multimodal Live API defaults to conversational barge-in: when new user audio arrives, Gemini interrupts and truncates its own audio output.
* **Failure mode:** In a sermon, the preacher speaks continuously without pausing. As soon as the preacher began the next sentence, Gemini instantly killed the playback of the previous translated sentence. Translation sounded choppy or stopped entirely.
* **Lesson & Rule:** Set `activityHandling: 'NO_INTERRUPTION'` in `realtimeInputConfig`. Keep automatic detection on, with high start sensitivity, `prefixPaddingMs: 300` so the first syllable is not clipped, and `silenceDurationMs: 300` so a phrase is released without waiting through a breath. `outputTranscription` on the live translate model has `text` and `languageCode` only. `settleCaptionStep` holds a phrase until Google either corrects that same phrase or moves to the next one. The correction replaces the phrase. A new sentence is appended. Earlier sermon text is not rewritten because it shares one word. The on-screen lag number holds once the preacher has been quiet for 1.5 seconds.

---

### ❌ Failed: Deprecated `mediaChunks` Format
* **What happened:** Earlier versions sent audio as `{ realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data }] } }`.
* **Failure mode:** The current Live Translate API expects `{ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data } } }`.
* **Lesson & Rule:** Always use `realtimeInput.audio` as standardized in `src/gemini-live.js`.

---

### ❌ Failed: Large or Irregular Audio Buffers
* **What happened:** Streaming large variable chunks (>2048 samples or irregular timer intervals) caused Google's backend to buffer, resulting in sudden bursts of translation followed by 5–10 second silences.
* **Lesson & Rule:** Resample all audio to 16 kHz Float32 and accumulate into uniform **100 ms (1,600 samples)** frames via `PcmAccumulator` before encoding to Base64 PCM16.

---

## 2. Audio Decoding & Viewer Buzzing Fix

### ❌ Failed: Truncating Odd-Length PCM Chunks (`Math.floor(len / 2)`)
* **What happened:** Remote viewers (phones and projectors) decoded base64 PCM audio by converting bytes directly: `pcm16 = new Int16Array(bytes.buffer, 0, Math.floor(len / 2))`.
* **Failure mode:** 16-bit PCM uses 2 bytes per sample (little-endian: `[LowByte, HighByte]`). If a WebSocket packet arrived with an odd number of bytes (e.g. 513 bytes), `Math.floor` dropped the 513th byte. On the next packet, every single 2-byte sample was shifted by 1 byte, swapping the high and low bytes.
* **Result:** Audio was instantly corrupted into deafening white noise/digital buzz until another odd packet accidentally realigned it.
* **Lesson & Rule:** Always use `decodePcm16Base64(base64Data, remainder)` from `src/pcm-audio.js`. It preserves trailing odd bytes across packet boundaries so sample alignment is never broken.

---

## 3. Session Resiliency & Reconnection

### ❌ Failed: Dropping Audio During Gemini Connection Rotation (`goAway`)
* **What happened:** Google's Live API forces connection rotation via `goAway` every ~15–30 minutes. The app closed the socket and took 1–2 seconds to reconnect.
* **Failure mode:** Any sentence spoken by the preacher during that 2-second setup window was dropped.
* **Lesson & Rule:** Maintain a circular **`PreRollAudioBuffer`** (1.5 seconds) in `src/pcm-audio.js`. While sockets are reconnecting or waiting for `setupComplete`, incoming audio is buffered. The moment `setupComplete` arrives, the pre-roll audio is flushed to Gemini, preserving speech continuity.

---

## 4. Networking, Security & OBS CEF

### ❌ Failed: Using HTTPS / WSS for OBS Overlay
* **What happened:** Pointing OBS Browser Source to `https://HOST:5173/?obs=true`.
* **Failure mode:** OBS uses an embedded Chromium browser (CEF) that silently drops or blocks self-signed certificates without showing an interactive warning, leaving the overlay black.
* **Lesson & Rule:** Keep port `5174` on unencrypted HTTP specifically for OBS (`http://HOST:5174/?obs=true`), restricted only to overlay assets and the local subtitle WebSocket. Keep port `5173` on HTTPS for microphone security.

---

### ❌ Failed: Strict Loopback-Only Restrictions on Proxy
* **What happened:** Checking `isLoopback` for `/gemini-live-ws` and configuration APIs.
* **Failure mode:** The church AV operator often uses a laptop on the church Wi-Fi (`192.168.1.x`) to control the Mac in the AV booth. Loopback checks caused `403 Forbidden` on the laptop dashboard.
* **Lesson & Rule:** Use `isOperatorClient(address)`, which permits both loopback (`127.0.0.1`, `::1`) and RFC 1918 private LAN addresses (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`), while preventing external WAN access and never returning the raw API key to the client browser.

---

## 5. Song & Worship Detection

### ❌ Failed: Cloud CDN for MediaPipe WebAssembly Assets
* **What happened:** Loading MediaPipe YAMNet runtime and model from `cdn.jsdelivr.net` or Google Cloud Storage.
* **Failure mode:** If the venue internet hiccups during service start, the classifier fails to load and song filtering disables.
* **Lesson & Rule:** Bundle `@mediapipe/tasks-audio` wasm and `yamnet.tflite` locally in `public/mediapipe/`. `scripts/prepare-mediapipe-assets.js` copies these during `npm run build`.

---

## 6. Model Selection

* **Current Model:** `models/gemini-3.5-live-translate-preview`.
* **Why not `gemini-2.0-flash`?** General Gemini models require conversational turn orchestration and do not support `translationConfig` for continuous direct audio-to-audio/text translation. `gemini-3.5-live-translate-preview` is specifically Google's low-latency speech-to-speech translation model.
