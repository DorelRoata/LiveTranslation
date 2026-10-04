# Changelog

This file is the operator-facing record of Live Translate releases: what changed, and why. Newest first.

## v1.3.29 — Replace a restated phrase instead of doubling it

**Why:** Google sends a phrase and then a correction. The projector kept the first wording and added the correction after it, so the same words appeared twice.

**What changed:** A correction replaces the words it restates. New words are still added. The shared opening of the line stays.

## v1.3.28 — Show the translation phrases Google is sending

**Why:** A live session was connected and receiving audio, and the projector was blank. Google was sending the English and Russian lines in `outputTranscription`, with `text` and `languageCode` only. None of those messages had a finished flag, so v1.3.27 threw every line away.

**What changed:** A caption is shown from that translation text as soon as it arrives. When Google does send `finished` or `final`, that phrase is locked.

## v1.3.27 — Show only the finished phrase

**Why:** v1.3.26 kept the early guess and attached it to the finished phrase. The screens then showed the guess and the correction in the same line. A turn ending could also dump that guess onto the screen.

**What changed:** A caption is shown only when Google marks the phrase finished. The text on screen is that finished phrase alone. The early guess is dropped.

## v1.3.26 — Captions wait for Google's finished wording

**Why:** The early translation was a guess. It reached the dashboard and the house screens while Google was still revising the phrase, so a wrong opening could stay on screen next to the correction.

**What changed:** Translated captions stay off the dashboard, projector, phones, and OBS until Google marks the phrase finished. The finished phrase is then sent once. Spoken translation audio is unchanged. Detected Speech on the dashboard still updates while the preacher is talking.

## v1.3.25 — Activity screen in the terminal

**Why:** The operator needed a terminal view of the running host, the same way a system monitor watches processes it does not own.

**What changed:** `npm run tui` opens an Activity screen. It can watch this Mac or another Mac on the network (`node scripts/dashboard-tui.js 192.168.4.146`). The screen shows whether Gemini is connected, whether an audio sender is streaming, the dashboard, projector, microphone, and OBS links, and the live caption text for both languages. Keys select and copy a link. The host serves this through `GET /api/activity`. Start, stop, and audio stay in the browser. Closing the screen does not stop translation.

## v1.3.24 — Projector QR stays in the corner

**Why:** The projector Share QR control opened a full-screen card over the subtitles, so the house could not read captions while someone scanned the link.

**What changed:** Share on the projector is now an on/off switch. When it is on, a small “Scan for subtitles” QR stays in the bottom-right and the captions keep running. The choice is remembered in that browser. The OBS overlay still hides it.

## v1.3.23 — Protect live sessions and keep dual-language / projectors in sync

Shipped on top of v1.3.22 after a full-app review of v1.3.20. These fixes target failures that can happen during a live sermon: lag dropping audio, a Dock click killing Gemini, Wi-Fi flaps tearing down healthy sockets, language 2 starting late, and projectors skipping phrases after a relay blip.

### Lag spikes no longer silently drop audio the dashboard thought was sent

**Why:** v1.3.20 raised the dashboard WebSocket buffer to 2 MB so internet lag would not skip frames. The local Gemini proxy and remote-microphone page still dropped audio at 256 KB. Because the proxy read the frame and then discarded it, the dashboard showed a healthy send path while Google never got the speech.

**What changed:** The Gemini proxy, local subtitle relay, and remote microphone page now use the same 2 MB ceiling as the dashboard.

### Dock click cannot kill a live session without asking

**Why:** If the dashboard build looked “stale,” clicking the Dock icon posted `/api/shutdown` after a notification only. Finder `.DS_Store` files were included in the build fingerprint, so a stray macOS file could look like a pulled update. `Keep Running` / `Restart and Update` existed in the launcher but was never called. README already described that dialog; the code did not.

**What changed:**
- A stale running server now asks **Keep Running** or **Restart and Update** before stopping.
- If Gemini is connected, the instance API reports `translationActive` and **Keep Running** is the default.
- Dotfiles such as `.DS_Store` are ignored in the dashboard fingerprint.

### Browser `online` events no longer tear down healthy Gemini sockets

**Why:** Any Wi-Fi, VPN, or interface flap fires `online` even when the Gemini WebSocket never dropped. The handler always closed both Live sessions and re-ran setup, leaving a multi-second hole mid-service.

**What changed:** Gemini reconnects on `online` only if a socket is actually down or a reconnect is already in progress. If both enabled languages are still setup-complete, the session stays up.

### Dual-language sessions start together

**Why:** The UI waited for both Gemini sockets, but live audio was forwarded as soon as language 1 finished setup. Language 1 ate the opening speech; language 2 stayed behind until someone reconnected.

**What changed:** No audio is sent to Gemini until every enabled language has `setupComplete`. If one lane is backed up, quiet-frame skipping applies to both, so they stay in lockstep. Remote-microphone intake uses the same gate.

### Projectors and OBS recover skipped phrases after a relay drop

**Why:** While the host relay socket was down, the dashboard kept applying subtitle text locally and did not send it. On reconnect it only sent language/pacing/OBS setup, not the accumulated lanes. House screens missed those finals for the rest of the session while the dashboard still looked correct.

**What changed:** On relay reconnect during an active session, the dashboard sends a `replace` snapshot of `lang1` / `lang2`. The server broadcasts that state to projector and OBS clients instead of appending onto stale text. Subtitle `update` messages are also limited to the `lang1` and `lang2` lanes so they cannot overwrite setup fields.

### Tests and docs

Unit tests cover dual-language gating, `online` reconnect policy, snapshot replace (including a live WebSocket relay test), the 2 MB buffer, and `translationActive` on instance info. README and the operator guide now match the Dock confirmation behavior.

### Not in this release

These review findings are still open and should be treated as follow-up, not as shipped:

- The LAN subtitle WebSocket (`/local-subtitles-ws`, including HTTP port 5174) is still writable without a token. Anyone on the event Wi-Fi can change or inject subtitles and, if Network Audio is selected, inject microphone audio.
- Automatically Ignore Songs can still pause on a weak YAMNet “Singing” score during preaching and refuse to resume until the operator toggles it off.
- Gemini `goAway.timeLeft` is still ignored; both languages reconnect immediately.

GitHub pull request #1 (raise buffers to 2 MB, plus `src/main.js.orig`) is superseded by this release. Do not merge it.

## v1.3.22 — Sample-aligned audio decoder, biblical glossary, latency telemetry, and pre-roll buffer

Keeps decoded PCM aligned to sample boundaries, adds a biblical glossary, records latency telemetry, and buffers a short pre-roll of audio until Gemini is ready to receive it.

## v1.3.21 — Laptop dashboard with Mac audio failsafe

Keeps the Mac as the host (server, API key, and audio capture). A laptop on the same LAN can run the dashboard and Gemini session. The Mac audio window auto-resumes after a server restart, and the launcher keeps the Mac awake while Live Translate is running.

## v1.3.20 — Stay live through internet lag spikes

Dashboard-side buffering and quiet-frame dropping so lag spikes would not queue stale speech. The proxy-side 256 KB drop that undermined this is fixed in v1.3.23.
