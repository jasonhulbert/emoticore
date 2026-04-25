import { defineConfig } from 'vite';

// Repo name — assets need to resolve at /emoticore/ on GitHub Pages.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/emoticore/' : '/',
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
