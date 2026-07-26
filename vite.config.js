import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { attachLocalRelay, handleRuntimeApi } from './server-support.js';

function localSubtitlesPlugin() {
  return {
    name: 'local-subtitles-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (await handleRuntimeApi(req, res)) return;
        next();
      });
      attachLocalRelay(server.httpServer);
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
    strictPort: true,
    https: true
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        subtitles: 'subtitles.html',
        'audio-sender': 'audio-sender.html'
      }
    }
  }
});
