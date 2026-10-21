import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Same opt-in used for the router's basename (see src/utils/publicPath.js),
  // without a trailing slash there (e.g. "/web") -- normalized to Vite's
  // expected trailing-slash form here. Defaults to '/', which is what every
  // build has actually always produced: this `base` option previously lived
  // nested inside `build: {}` (not a real Vite build option, so it was a
  // silent no-op) rather than at the top level where Vite reads it -- moving
  // it here doesn't change existing output, since '/' was the real default
  // all along regardless of that dead `'./'.` value's intent.
  const basename = env.VITE_APP_BASENAME || '';
  // Capacitor loads index.html via file:// and needs relative asset paths
  // ('./assets/...'); `npm run cap:sync`/`cap:build` pass --mode capacitor
  // for that. Web builds keep absolute paths: '/' (Vercel at the site root)
  // or '<basename>/' when served under a sub-path such as /web.
  const base = mode === 'capacitor' ? './' : (basename ? `${basename}/` : '/');

  return {
    plugins: [react()],
    base,
    build: {
      outDir: 'dist',
      rollupOptions: {
        output: {
          // React/router and socket.io (needed on every start) in their own
          // long-cached chunks: an app update doesn't make returning users
          // download them again. Every other library stays with the (lazy)
          // pages that use it, so the first load doesn't pull them in.
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
            if (/node_modules[\\/](socket\.io-client|engine\.io-client|socket\.io-parser|engine\.io-parser)[\\/]/.test(id)) return 'socket-vendor';
            return undefined;
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api':       { target: 'https://sniffrweb.onrender.com', changeOrigin: true },
        '/uploads':   { target: 'https://sniffrweb.onrender.com', changeOrigin: true },
        '/socket.io': { target: 'https://sniffrweb.onrender.com', ws: true },
      }
    }
  };
});
