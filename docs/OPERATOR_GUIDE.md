# Live Translate Operator Guide

This guide covers the normal operating workflow and the recovery steps most likely to be needed during a live event.

## 1. Know which computer is the host

The host is the Mac or PC running the Live Translate server. Only the host can use:

```text
https://localhost:5173/
```

`localhost` always means the computer on which the address is opened. A projector, remote microphone, or OBS computer must use the host's network IP shown in the dashboard.

## 2. Ports and protocols

| Port | Protocol | Purpose |
| --- | --- | --- |
| `5173` | HTTPS/WSS | Dashboard, projector, remote microphone, configuration, and primary subtitle relay |
| `5174` | HTTP/WS | OBS-only transparent overlay and shared subtitle relay |

Port `5174` intentionally avoids TLS because OBS's embedded browser may fail silently on a self-signed HTTPS certificate. The listener is restricted to the overlay HTML, compiled assets, and subtitle WebSocket. Requests for configuration endpoints return `404`.

## 3. Starting Live Translate on macOS

Open `Live Translate.app` from `~/Applications` or the Dock.

On a normal cold start, the launcher:

1. Resolves the linked repository.
2. Finds a supported Node.js installation.
3. Recovers any interrupted update transaction.
4. Checks GitHub for a safe fast-forward update.
5. Verifies or installs dependencies.
6. Builds the dashboard when required.
7. Starts both application ports.
8. Opens the dashboard after its health endpoint responds.

If the app is already running, a dialog says that nothing new will be started. **OK** leaves the current dashboard and session untouched. **Open Dashboard** navigates to the existing instance and may affect the current browser tab, so use it only when needed.

The dashboard adds a second safety layer while translation is active: the browser must confirm any reload, tab close, or navigation that would destroy the page-held Gemini session. If this warning appears during an event, choose the option that stays on the page.

## 4. Updating without reinstalling

Feature updates do not require reinstalling the Dock app because the installed wrapper invokes the launcher from the linked repository.

1. Stop translation.
2. Quit the running Live Translate process/server.
3. Open the Dock app.
4. Choose **Update and Start**.

If a server is already running, the launcher prioritizes protecting that active session and does not perform an update check.

Reinstall only when:

- Setting up a new Mac.
- The linked repository was moved or renamed.
- The installed app bundle was deleted or damaged.
- The installer itself changed in a way that explicitly requires replacement.

## 5. Recommended pre-event workflow

1. Start the host at least several minutes before the event.
2. Confirm Connection Health shows the local relay as connected.
3. Confirm the correct audio source and microphone.
4. Confirm the target languages.
5. Review the system instructions and terminology hints.
6. Decide whether Voice 1 and Voice 2 should be distributed.
7. Leave **Local Speaker** off unless host playback is intentional.
8. Leave **Echo Target Language** off unless the source-language behavior requires it.
9. Open the projector and/or OBS destination.
10. Speak a short test sentence and verify translated words at every destination.
11. Clear the projector screen before the live program begins.

## 6. What is saved

### Gemini API key

The API key is stored on the host at:

```text
~/Library/Application Support/LiveTranslation/config.json
```

It is stored outside the repository with user-only permissions, survives application updates, and is not included in Vite bundles. The configuration API rejects non-loopback clients.

### Operator settings

The following values are saved immediately in browser storage:

- Audio source.
- Preferred microphone device.
- Language 1 and Language 2.
- Voice 1 and Voice 2 output switches.
- System instructions and translation hints.
- Echo Target Language.
- Local Speaker.
- Local playback volume.
- Transcript font size.

Browser storage belongs to the exact origin and browser profile. For predictable restoration, always operate the host dashboard at `https://localhost:5173/` in the same browser profile. Private browsing, clearing site data, changing profiles, or opening the dashboard by network IP creates or uses a different settings store.

### Reset behavior

**Reset Settings to Defaults** asks for confirmation and restores:

| Setting | Default |
| --- | --- |
| Audio source | Default microphone |
| Microphone device | System default |
| Language 1 | English |
| Language 2 | Disabled |
| Voice 1 output | On |
| Voice 2 output | On |
| Echo Target Language | Off |
| Local Speaker | Off |
| Local volume | 100% |
| Transcript size | Medium |
| System instructions | Built-in church-sermon interpreter prompt |

Reset does not delete the Gemini API key.

## 7. Local Speaker and distributed audio

Voice 1 and Voice 2 determine whether the relevant translated audio is active and distributed to subtitle clients. **Local Speaker** controls only playback through the host computer's speakers.

Keep Local Speaker off when host playback could feed back into the microphone or leak into a broadcast mix. Turning it off does not stop translated audio packets from reaching supported remote/projector clients.

## 8. Projector and phone setup

Use the HTTPS Projector Screen URL displayed by the dashboard.

1. Open it on the destination device.
2. Accept the certificate warning.
3. Confirm the connection dot becomes green.
4. Choose one-language or two-language layout as needed.
5. Enable translated audio on the viewer only if required.
6. Use wake lock on supported phones and tablets.

Subtitle state is retained by the local relay. A newly opened or reconnected viewer receives the current accumulated text immediately.

## 9. Remote microphone setup

Use the HTTPS Network Audio Sender URL displayed by the dashboard.

1. Select Network Audio on the host.
2. Open the sender URL remotely and accept the certificate warning.
3. Grant microphone permission.
4. Start streaming on the sender.
5. Verify the host input meter moves.
6. Start translation.

If the sender disconnects, the host displays a warning. Live audio is not retained for later replay; reconnect as soon as practical.

## 10. OBS setup

Use the dedicated HTTP OBS Overlay URL, not the HTTPS projector URL:

```text
http://HOST-IP:5174/?obs=true
```

Recommended Browser Source settings:

- Width: `1920`.
- Height: `1080`.
- Source visible and positioned above the camera/video source.
- **Control audio via OBS** off for text only.
- **Control audio via OBS** on only when translated speech should enter OBS.

The OBS page is intentionally transparent, hides all controls, and remains blank until translation text arrives.

### OBS diagnostic sequence

1. Start translation and speak a complete test sentence.
2. Check the dashboard translation transcript.
3. Check the normal projector page.
4. Check the OBS source.

Interpret the result:

- Dashboard blank: investigate Gemini or audio input.
- Dashboard has words, projector blank: investigate the local subtitle relay.
- Projector has words, OBS blank: verify port `5174`, the source URL, OBS visibility/layer order, and refresh the Browser Source cache.
- OBS URL unavailable in a normal browser: verify both computers are on the same network and allow the host application through the firewall.

## 11. Subtitle pacing

The shared subtitle engine buffers incoming words and adjusts display timing to queue depth:

| Queue condition | Delay per word |
| --- | --- |
| Light | `160 ms` |
| Small backlog | `110 ms` |
| Medium backlog | `70 ms` |
| Large backlog | `30 ms` |

It pauses `350 ms` after a normal line break or `150 ms` when catching up. Sentence punctuation triggers a semantic line break; a 60-character fallback prevents excessively long active lines.

Pacing applies to displayed subtitles only. There is no user-selectable pacing preset and no spoken-translation speed control at this time.

## 12. Recovery and diagnostics

The dashboard provides:

- Local relay, Gemini session, and audio-source health states.
- Automatic Gemini reconnection with exponential delays up to eight seconds.
- Automatic local subtitle relay reconnection with exponential delays up to eight seconds.
- **Reconnect Now** for translation connections.
- **Restart Audio** for the current capture source.
- **Copy Diagnostics** for an operator-readable status report.
- **Check Updates** for the repository state.

Live audio is not queued while connections are unavailable. This prevents stale speech from being translated after a recovery.

## 13. Logs

The macOS launcher writes to:

```text
~/Library/Logs/LiveTranslate.log
```

To view recent entries:

```bash
tail -100 "$HOME/Library/Logs/LiveTranslate.log"
```

The browser dashboard also includes System Status Logs and a Copy Diagnostics control.

## 14. Common problems

### Clicking the Dock app resets the dashboard

Update to the latest `main` revision. A second launch now displays an Already Running dialog and leaves the current dashboard untouched when **OK** is selected. If a navigation still reaches the dashboard, the active-session browser guard requires another explicit confirmation before the translation can be destroyed.

### Changes are not visible after an update

Stop the existing server before reopening the Dock app. A running server causes the launcher to protect the active session and skip the update check. Choose **Update and Start** on the next cold launch.

### Settings do not appear to persist

Use the same browser profile and exact `https://localhost:5173/` address. Check whether private browsing or automatic site-data deletion is enabled. The Gemini API key uses host configuration, but operator preferences use browser storage.

### The OBS page is blank

Blank is normal before translated words arrive. If the projector shows translated words and OBS remains blank, refresh the OBS Browser Source cache and verify the HTTP port `5174` address.

### The projector shows a certificate warning

This is expected for the local self-signed certificate. Confirm that the IP belongs to the trusted Live Translate host before proceeding.

### The Dock app reports that Node.js is missing

Install Node.js 22 LTS or another version allowed by `package.json`: Node 20.19+ or Node 22.12+.

### Port already in use

Port `5173` is reserved for the HTTPS application and `5174` for OBS. Stop the conflicting service or the old Live Translate server before starting again.
