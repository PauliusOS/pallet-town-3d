import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The screenshot harness writes PNGs into `shots/` while the page it is
 * driving is still open. Vite's default watcher treats those writes as source
 * changes and full-reloads the page mid-run, which destroys the game handle
 * and makes a healthy build look broken. Nothing outside `src/`, `public/` and
 * `index.html` can affect the bundle, so the review artefacts are ignored.
 *
 * `ignored` replaces chokidar's defaults rather than extending them, so the
 * usual suspects have to be repeated here or the watcher walks node_modules.
 */
export default defineConfig({
  /**
   * The creature turntable at `/viewer.html` is a second entry point. Vite only
   * builds `index.html` unless the others are named, so without this the
   * turntable works under `npm run dev` and 404s everywhere else.
   */
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        viewer: fileURLToPath(new URL('./viewer.html', import.meta.url)),
      },
    },
  },
  server: {
    watch: {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/shots/**',
      ],
    },
  },
});
