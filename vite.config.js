import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { WebSocketServer } from 'ws';

// In-memory state for subtitles so new connections receive the latest text immediately
const subtitleState = {
  lang1: { accumulatedText: "" },
  lang2: { accumulatedText: "" },
  targetLanguage1: "",
  targetLanguage2: "",
  isDual: false
};

function localSubtitlesPlugin() {
  return {
    name: 'local-subtitles-plugin',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer.on('upgrade', (request, socket, head) => {
        const { pathname } = new URL(request.url, 'http://localhost');
        if (pathname === '/local-subtitles-ws') {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        }
      });

      wss.on('connection', (ws) => {
        // Send current state to newly connected clients
        ws.send(JSON.stringify({ type: 'sync', state: subtitleState }));

        ws.on('message', (message) => {
          try {
            const data = JSON.parse(message.toString());
            
            // Update in-memory state based on messages from Laptop A (parent)
            if (data.type === 'update') {
              const { lane, text } = data;
              const state = subtitleState[lane];
              const trimmedText = text.trim();
              if (trimmedText) {
                const needsSpace = state.accumulatedText.length > 0 && 
                                   !/[\s。？！.?!;；]/.test(state.accumulatedText[state.accumulatedText.length - 1]) && 
                                   !/^[。？！.?!;；\s]/.test(trimmedText);
                state.accumulatedText = state.accumulatedText + (needsSpace ? " " : "") + trimmedText;
              }
              // Limit history length to keep last 800 chars
              if (state.accumulatedText.length > 800) {
                state.accumulatedText = state.accumulatedText.substring(state.accumulatedText.length - 800);
                const spaceIdx = state.accumulatedText.indexOf(" ");
                if (spaceIdx !== -1) {
                  state.accumulatedText = state.accumulatedText.substring(spaceIdx + 1);
                }
              }
            } else if (data.type === 'setup') {
              subtitleState.targetLanguage1 = data.targetLanguage1;
              subtitleState.targetLanguage2 = data.targetLanguage2;
              subtitleState.isDual = data.isDual;
            } else if (data.type === 'clear') {
              subtitleState.lang1 = { accumulatedText: "" };
              subtitleState.lang2 = { accumulatedText: "" };
            }

            // Broadcast the updated state to all connected clients
            const syncMsg = JSON.stringify({ type: 'sync', state: subtitleState });
            wss.clients.forEach((client) => {
              if (client.readyState === 1) { // OPEN
                client.send(syncMsg);
              }
            });
          } catch (e) {
            console.error('Error handling WebSocket message in plugin:', e);
          }
        });
      });
    }
  };
}

export default defineConfig({
  plugins: [
    basicSsl(),
    localSubtitlesPlugin()
  ],
  server: {
    host: true, // Listen on all network interfaces (0.0.0.0)
    port: 5173,
    https: true
  }
});
