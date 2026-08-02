# Live Translate

Live Translate is a low-latency, real-time voice translation application powered by the Google Gemini Multimodal Live WebSocket API (`v1alpha`). It can translate one audio source into one or two target languages, play translated speech, and distribute rolling subtitles and audio to projectors, phones, and OBS across a local network.

The current application version is `v1.2.0`.

## Screenshots

### Translation dashboard

![Main Translation Dashboard](./screenshots/dashboard.png)

### Projector subtitles

![Projector Subtitles Screen](./screenshots/projector.png)

## Highlights

- Microphone, system-audio, or remote network-audio input at 16 kHz PCM.
- One or two concurrent Gemini translation sessions.
- Low-latency translated speech playback at 24 kHz.
- Independent Voice 1 and Voice 2 output controls.
- A safety-oriented **Local Speaker** control that defaults to off.
- **Echo Target Language** defaults to off.
- Remembered operator settings with a **Reset Settings to Defaults** button.
- Selectable **Smooth** subtitle pacing with a 200 ms buffer, plus the original **Live** pacing mode.
- An optional live **Automatically Ignore Songs** filter that keeps Gemini connected while pausing song audio.
- A projector/phone subtitle page with wake lock and automatic reconnection.
- A certificate-free OBS Browser Source endpoint on local HTTP port `5174`.
- A remote microphone page for another computer or phone.
- Connection health, diagnostics, manual recovery controls, and safe Mac updates.
- A gunmetal-gray dashboard with coral, amber, and green status accents.

## Network addresses and ports

| Purpose | Protocol and port | Typical address |
| --- | --- | --- |
| Local dashboard | HTTPS `5173` | `https://localhost:5173/` |
| Projector/phone subtitles | HTTPS `5173` | `https://192.168.1.67:5173/subtitles.html` |
| Remote microphone | HTTPS `5173` | `https://192.168.1.67:5173/audio-sender.html` |
| OBS Browser Source | HTTP `5174` | `http://192.168.1.67:5174/?obs=true` |

Use `localhost` only on the Mac that is running Live Translate. Other computers must use the network address displayed by the dashboard.

The dashboard, API-key configuration, projector page, and microphone page remain on HTTPS. The OBS-only listener uses HTTP because OBS can silently reject the application's self-signed HTTPS certificate. Port `5174` exposes only the subtitle overlay, its compiled assets, and the subtitle WebSocket; it does not expose the dashboard or configuration API.

## Requirements

- Node.js `20.19` or newer in the Node 20 line, or Node.js `22.12` or newer.
- npm and Git.
- A Gemini API key.
- Chrome, Edge, or Safari for the dashboard and shared browser pages.
- Both computers on the same local network for projector, remote microphone, or remote OBS use.

## Quick start

```bash
git clone https://github.com/DorelRoata/LiveTranslation.git
cd LiveTranslation
npm ci
npm run start:app
```

Open `https://localhost:5173/` on the host Mac. Enter the Gemini API key once; later launches load it automatically.

For source development with hot reload:

```bash
npm run dev
```

## macOS Dock app

After cloning the repository and running `npm ci`, double-click:

```text
install-mac-app.command
```

The installer places `Live Translate.app` in `~/Applications` and links it to the current repository. You can drag that app to the Dock.

The Dock app:

- Finds a compatible Node.js installation.
- Checks dependency integrity and installs missing dependencies when necessary.
- Builds the production dashboard when required.
- Starts the HTTPS dashboard on port `5173` and the OBS overlay on port `5174`.
- Waits for the dashboard to become ready before opening it.
- Writes startup output to `~/Library/Logs/LiveTranslate.log`.
- Protects local or diverged Git work from automatic updates.

If Live Translate is already running, clicking the Dock icon does not start another server or reload the active dashboard. It displays an **Already Running** dialog. Choose **OK** to leave the session untouched or **Open Dashboard** to navigate to it deliberately.

While translation is active, the dashboard also asks for confirmation before a browser reload, tab close, or navigation can destroy the live Gemini session. This browser guard is a second layer of protection if someone clicks through the launcher or tries to refresh the page during an event.

Do not delete or move the linked repository. If it moves, run `install-mac-app.command` again from the new location. This is one of the few cases that requires reinstalling the Dock app.

## Updating the Mac app

Normal code updates do **not** require reinstalling `Live Translate.app`.

To install an update:

1. Stop the running translation session and quit Live Translate.
2. Reopen the Dock app.
3. Choose **Update and Start** when prompted.

The update check runs only when no Live Translate server is already running. When an update is approved, the launcher performs a fast-forward-only pull of `origin/main`, installs locked dependencies with `npm ci`, builds the dashboard, and starts it. Interrupted updates use transaction markers and backups so the previous revision can be recovered safely.

The **Check Updates** control in Connection Health reports whether a newer commit is available. If it finds one, quit and reopen the Dock app to install it.

## Saved settings and safety defaults

The Gemini API key is stored in the current user's private application configuration at:

```text
~/Library/Application Support/LiveTranslation/config.json
```

The file is created with user-only permissions. API-key configuration is available only from the host computer.

Operator preferences are stored in browser storage for the dashboard origin. They are saved as soon as they change and restored on the next dashboard load. This includes the audio source and microphone, languages, voice-output switches, system instructions, subtitle pacing, automatic song filtering, Echo Target Language, Local Speaker, local volume, and transcript font size.

Important defaults include:

- Local Speaker: off.
- Echo Target Language: off.
- Audio source: system default microphone.
- Language 1: English.
- Language 2: disabled.
- Voice 1 and Voice 2 output: on.
- Local volume: 100%, but silent while Local Speaker is off.
- Subtitle Pace: Smooth with a 200 ms start buffer.
- Automatically Ignore Songs: off.
- Transcript size: medium.

**Reset Settings to Defaults** restores operator preferences but deliberately keeps the saved Gemini API key.

Browser storage is scoped to the exact address. Use `https://localhost:5173/` consistently on the host Mac; a different browser profile or a network-IP dashboard address has separate browser settings.

## Projector and phone subtitles

Copy the **Projector Screen URL** from the dashboard. On the projector computer or phone:

1. Open the exact HTTPS URL.
2. Accept the self-signed certificate warning by choosing **Advanced** and proceeding.
3. Wait for the green connection indicator.
4. Start translation on the dashboard.

Subtitle viewers automatically reconnect after network or server interruptions and receive the current subtitle history after reconnecting. Wake lock can keep supported phone screens awake.

## Remote microphone

1. Select **Network Audio (Stream from another PC)** as the dashboard audio source.
2. Copy or scan the **Network Audio Sender URL**.
3. Open it on the remote computer or phone and accept the certificate warning.
4. Grant microphone access and select **Start Streaming**.
5. Start translation on the host dashboard.

The dashboard warns the operator if the remote sender disconnects and clears the warning when it reconnects.

## OBS live-stream overlay

1. In OBS, add a **Browser** source.
2. Copy the dashboard's dedicated **OBS Overlay URL**. It resembles `http://192.168.1.67:5174/?obs=true`.
3. Set the Browser Source width and height to `1920 × 1080`, or match the OBS canvas.
4. Keep **Control audio via OBS** disabled for text-only output. Enable it only when translated speech should enter the OBS mix.

OBS mode hides controls and the connection indicator and makes the page background transparent. A completely blank overlay is expected before translated words arrive.

If the projector displays words but OBS does not, verify the `http://...:5174/?obs=true` address, confirm the source eye is enabled and above the video source, and use **Refresh cache of current page** in the Browser Source properties.

## Automatic song filtering

**Automatically Ignore Songs** is a saved dashboard switch that defaults to off and remains available while translation is running. When enabled, the browser loads Google's MediaPipe/YAMNet audio classifier and analyzes the existing 16 kHz audio locally for speech, singing, and music-related events.

- Two consecutive song-like windows are required before pausing, preventing a brief musical sound from stopping a speaker.
- Three consecutive speech-dominant windows are required before resuming.
- While paused, new audio is not sent to Gemini, pending translated playback is stopped, and new translation output is discarded. The Gemini session stays connected.
- Turning the switch off resumes translation immediately.
- If the classifier cannot load or fails, the filter fails open: the dashboard shows an error and translation continues normally.

The first activation downloads the MediaPipe WebAssembly runtime and YAMNet model from their official distribution locations, after which normal browser caching applies. Detection is probabilistic. Speech over loud music and unusual vocal sounds can cause false results, so the dashboard status and live switch remain the operator override.

## Subtitle pacing

The saved **Subtitle Pace** setting offers two modes:

- **Smooth (default):** waits 200 ms after an idle period, displays short one-to-three-word phrases, eases continuously from about `185 ms` toward `45 ms` as backlog grows, and targets a maximum oldest-word delay of 1.5 seconds. Commas and sentence endings receive natural pauses that shrink during catch-up.
- **Live (Legacy / Lowest Delay):** preserves the original immediate word-by-word thresholds of `160`, `110`, `70`, and `30 ms`, with the original line-break pauses.

Both modes use sentence punctuation (`.`, `?`, `!`) and a 60-character fallback for line locking. The built-in Gemini instruction also requests continuous short phrases, natural cadence, no repetition of emitted text, and no long response gaps. Prompt guidance can improve phrase structure but cannot guarantee API timing; the client-side queue provides the deterministic smoothing. There is no separate speed control for Gemini's spoken translation.

## Browser and macOS permissions

Microphone and system-audio capture require a secure context, so the dashboard and shared capture pages use HTTPS with a locally generated certificate.

- Allow microphone access in the browser prompt.
- On macOS, enable the browser under **System Settings → Privacy & Security → Microphone** when necessary.
- For system audio, enable the browser under **System Settings → Privacy & Security → Screen & System Audio Recording**.
- If a remote browser displays a privacy warning for port `5173`, proceed only when the address matches the trusted Live Translate host on your local network.

## Troubleshooting and detailed operations

See [Operator Guide](./docs/OPERATOR_GUIDE.md) for the complete operating workflow, diagnostics, update recovery, OBS checks, saved-setting behavior, and common failure cases.
