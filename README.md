# Gemini Live Translate - Real-time Voice Interpreter

A sleek, low-latency, real-time voice-to-voice translation web application powered by the Google Gemini Multimodal Live WebSocket API (`v1alpha`). 

This application supports dual-language concurrent translations, visual waveform analytics, audio play/mute controls, and a dedicated local network projector screen for sharing rolling subtitles on another laptop in real-time.

---

## 📸 Screenshots

### 1. Main Translation Dashboard
![Main Translation Dashboard](./screenshots/dashboard.png)

### 2. Standalone Subtitles Projector Screen
![Projector Subtitles Screen](./screenshots/projector.png)

---

## ⚡ Features

* **High-Fidelity Audio capture:** Captures microphone input or system audio loopback (from YouTube, video calls, etc.) at 16kHz PCM.
* **Low-Latency Spoken Responses:** Streams translated audio playback back at 24kHz using a jitter-free Float32 buffer queue.
* **Concurrent Dual-Language Translation:** Connects to two parallel Gemini Live WebSocket sessions to translate speech into two languages at the same time.
* **Visual Waveform Analysis:** Live HTML5 canvas waveforms showing microphone input volume and translation audio output.
* **Independent Mute Controls:** Toggle spoken translation audio for Language 1 and Language 2 independently.
* **Natural-Flow Subtitles:** Continuous text wrapping and automatic scroll-to-bottom subtitles, showing up to 3 lines max of active rolling history.
* **Multi-Laptop Screen Sharing (Projector Support):** Expose a local network server over HTTPS and stream live subtitles to a second laptop connected to a projector.

---

## 🚀 Quick Start (Local Network & Projector Mode)

To run the application on **Laptop A** (capturing audio) and display subtitles on **Laptop B** (connected to the projector):

```bash
# 1. Clone the repository
git clone https://github.com/DorelRoata/LiveTranslation.git
cd LiveTranslation

# 2. Install dependencies
npm install

# 3. Start the local server
npm run dev
```

### Setup Instructions:
1. In the terminal, copy the network IP printed under the `Network` heading (e.g., `https://192.168.1.67:5173/`).
2. Open that network URL on **Laptop A**.
3. In the configuration panel, copy the exact link shown under **Projector Screen Sharing** (e.g., `https://192.168.1.67:5173/subtitles.html`).
4. On **Laptop B** (the projector laptop), open that subtitles URL in Chrome, Edge, or Safari.
   * *Note: Because Vite uses a local self-signed SSL certificate, your browser will display a certificate warning. Click **Advanced** and then click **Proceed to ... (unsafe)** to open the subtitles page safely.*
5. Once Laptop B displays a green status dot in the top-right corner (meaning it is connected to the host), start translating on Laptop A. The subtitles will stream to Laptop B's projector screen in real-time!

---

## 🔒 Recommended Browsers & macOS Settings

Modern web browsers restrict microphone access and display capture (`getDisplayMedia`) to **secure contexts** (`localhost` or `https`). Because Projector Mode runs over a local IP network, the server runs over HTTPS using a self-signed certificate.

For best compatibility, we recommend using **Google Chrome** or **Microsoft Edge**:
* **Microphone Permissions:** Allow microphone access in the browser prompt. On macOS, you may also need to check Google Chrome under **System Settings ➜ Privacy & Security ➜ Microphone**.
* **System Audio Capture (macOS):** To capture audio playing from another app or tab on macOS, toggle Google Chrome ON under **System Settings ➜ Privacy & Security ➜ Screen & System Audio Recording**.
