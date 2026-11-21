import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/*
 * The service worker (public/sw.js) loads these two classic scripts with importScripts(), and
 * the page imports the very same files as modules. They live once, in src/core, and are served
 * (dev) or emitted (build) at assets/<name> for the worker, unhashed.
 */
const WORKER_SCRIPTS = ['stream-core.js', 'zip-core.js'];
const coreFile = (name) => readFileSync(new URL(`./src/core/${name}`, import.meta.url), 'utf8');

function serviceWorkerScripts() {
  return {
    name: 'secure-box:service-worker-scripts',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = /^\/assets\/([a-z-]+\.js)(?:\?|$)/.exec(req.url || '')?.[1];
        if (!name || !WORKER_SCRIPTS.includes(name)) return next();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(coreFile(name));
      });
    },
    generateBundle() {
      for (const name of WORKER_SCRIPTS) this.emitFile({ type: 'asset', fileName: `assets/${name}`, source: coreFile(name) });
    },
  };
}

/*
 * PDF.js reads its standard fonts and character maps from Secure Box's own address, only when a
 * PDF needs them: served from node_modules in development, copied to assets/pdfjs/ in the build.
 */
const PDF_DIRS = ['standard_fonts', 'cmaps'];
const pdfDir = (dir) => fileURLToPath(new URL(`./node_modules/pdfjs-dist/${dir}/`, import.meta.url));

function pdfAssets() {
  return {
    name: 'secure-box:pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/assets\/pdfjs\/([a-z_]+)\/([\w.-]+)$/.exec((req.url || '').split('?')[0]);
        if (!match || !PDF_DIRS.includes(match[1])) return next();
        const file = join(pdfDir(match[1]), match[2]);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return undefined;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(readFileSync(file));
        return undefined;
      });
    },
    generateBundle() {
      for (const dir of PDF_DIRS) {
        for (const name of readdirSync(pdfDir(dir))) this.emitFile({ type: 'asset', fileName: `assets/pdfjs/${dir}/${name}`, source: readFileSync(join(pdfDir(dir), name)) });
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [serviceWorkerScripts(), pdfAssets()],
  // React's automatic JSX runtime through Vite's own transform: no Babel, and no inline
  // scripts in development, so the page keeps its strict CSP in dev too.
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  // Bundled once when the dev server starts, so a first visit never loads two copies of React.
  optimizeDeps: { include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'] },
  server: {
    port: 8080,
    strictPort: true,
    // The error overlay writes innerHTML, which this page's Trusted Types policy forbids.
    hmr: { overlay: false },
  },
  preview: { port: 8081, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0, // never data: URLs for scripts or styles
    chunkSizeWarningLimit: 1500,
  },
});
