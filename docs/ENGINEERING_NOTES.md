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
* **Lesson & Rule:** Set `activityHandling: 'NO_INTERRUPTION'` in `realtimeInputConfig`. Keep automatic detection on, with high start sensitivity, `prefixPaddingMs: 300` so the first syllable is not clipped, and `silenceDurationMs: 300` so a phrase is released without waiting through a breath. The on-screen lag number holds once the preacher has been quiet for 1.5 seconds.

---

### ✅ Verified: What Google Actually Sends for Captions (Oct 2026)
* **How it was measured:** 15 minutes of a real sermon (livestream of 2026-10-04, 28:00–43:00, Romanian → English) streamed through the app's exact setup message, every server message recorded. The pieces are kept in `tests/fixtures/sermon-2026-10-04-en.json`.
* **Findings:**
  * `outputTranscription` and `inputTranscription` arrive as short pieces (840 in 15 minutes) containing **only the new words**, each with its own leading space and punctuation. Joined as sent, they are the full translation.
  * Google **never revised or restated** a piece. Every piece is final when it arrives.
  * Google sent **no** `finished`, `final`, `turnComplete`, `generationComplete`, or `interrupted` — not even after 10 seconds of silence. Never wait for them: v1.3.26/27 did, and the screens went blank.
  * The preacher repeats phrases for emphasis ("he speaks with sense, he speaks with meaning"), and Google translates the repetition faithfully. Repeated words on screen are usually real speech.
  * The only piece without a leading space is the first one of each session.
* **❌ Failed: guessing, merging, or removing words.** v1.3.29–v1.3.34 tried to detect "corrections" and duplicates (`settleCaptionStep`, `dedupeCaptionLine`, `getAppendedWords`, a "content word already in the last 20 words is removed" rule). Replayed against the recorded sermon, v1.3.33 removed 462 of 2,280 words (20%) and v1.3.34 dropped 39. Those corrections did not exist; the rules deleted real translation.
* **Rule:** `src/caption-stream.js` appends each piece exactly as Google sends it. The dashboard sends the relay `{ type: 'append', lane, text }`; the relay re-broadcasts it with `seq` and the lane's full recent text; a screen animates the piece only if `seq` follows what it shows, otherwise it redraws instantly from the full text. Interim transcription fields are ignored. `tests/caption-stream.test.js` replays the recorded sermon and requires every word to reach the projector, in order. **Do not add word-level deduplication.**

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
* **What happened:** Google sends `goAway` (measured: exactly 9:00 into a connection, with `timeLeft: "50s"`). The app closed the socket immediately, waited, and started a brand-new session.
* **Failure mode:** Speech during the reconnect was lost (all of it for the Mac-audio/network source, which skipped the pre-roll), the old connection's in-flight translation was thrown away, and the new session had no context.
* **Lesson & Rule:** Google sends `sessionResumptionUpdate` handles about once a second, unrequested. On `goAway`, open a replacement socket whose setup carries `sessionResumption: { handle }`, keep sending audio to the old socket until the replacement's `setupComplete` (measured: 0.4 s), then switch. The old socket keeps delivering what it already heard; the new session's captions wait until it has been quiet for 1.5 s (max 8 s) so text stays in order. A resumed session may restate the old session's last word once ("sighed."); `pieceToAppend` drops that, and only at the seam. The initial setup message is unchanged.
* **Pre-roll:** the 1.5-second **`PreRollAudioBuffer`** still bridges unexpected drops, for both the microphone and the network source. It is cleared after every successful send, so audio held during an earlier backlog can never reach Gemini later, out of context.

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

## 6. Accuracy Measurements (Oct 2026)

All on real sermon audio from the 2026-10-04 livestream, through the real dashboard or the app's exact Gemini setup.

### ❌ Failed: A Glossary That Matched Bare Words
* **What happened:** `applyBiblicalGlossary` replaced "the Romanians" with "Romans" anywhere, and Romanian book names at the end of any piece (`$` lookahead).
* **Failure mode:** Ordinary English became wrong: "we, the Romanians, came…" → "we, Romans, came…", "stuck in a rut" → "Ruth", "tit" → "Titus", "mica" → "Micah". Its `\b` boundaries never matched words starting or ending in ă, â, î, ș, ț. On 15 minutes of real Google output it changed nothing, because Google already translates book names and church terms correctly.
* **Rule:** Replacements only in an unambiguous context: a book name followed by a chapter number, "the Romanians" only inside a Bible reference. Use Unicode letter boundaries (`(?<![\p{L}\p{N}])`). `tests/glossary.test.js` requires zero changes to the recorded sermon and to ordinary sentences.

### ✅ Verified: Settings That Do Not Need Changing
* **Browser audio processing** (echo cancellation, noise suppression, auto-gain): same 3 minutes with it on vs off — 467 vs 469 Romanian words heard, 473 vs 458 English words, both within run-to-run variation. Left on; echo cancellation also protects a room microphone if "Play on this Mac" is used.
* **Spoken language** auto-detect vs Romanian hint: both heard Romanian on every piece (169/169 and 171/171) with equivalent translations.
* **Mac-audio page as a background tab** (how the launcher opens it): Chrome still delivered 10.00 of 10 audio frames per second. Safari was not measured; the delivery check below catches it if it falls behind.

### ✅ Rule: No Audio Is Lost Silently
* The dashboard checks that audio reaches Google at real-time speed (10 frames of 100 ms per second, measured over 10 s). Below 9 frames per second it warns the operator and logs it.
* Every place audio can be lost is counted and shown in Copy Status: quiet frames skipped while Google is backed up, reconnect-buffer overflow beyond 1.5 s, stale audio discarded after a backlog, and frames the host proxy could not pass to Google (`/api/activity` `audioDroppedByHost`, also logged by the server).

### Known Google Wording Variations (left as sent)
* Verse references are always split across pieces ("Galatians 6:" + " 14"), so the joined text shows "6: 14". It reads correctly; fixing it would mean editing words already on screen.
* Romanian "2 cu 16" (chapter 2, verse 16) is sometimes translated literally as "2 with 16" (2 of 13 references across three runs).

---

## 7. Model Selection

* **Current Model:** `models/gemini-3.5-live-translate-preview`.
* **Why not `gemini-2.0-flash`?** General Gemini models require conversational turn orchestration and do not support `translationConfig` for continuous direct audio-to-audio/text translation. `gemini-3.5-live-translate-preview` is specifically Google's low-latency speech-to-speech translation model.
