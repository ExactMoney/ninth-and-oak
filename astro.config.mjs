import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://ninthandoak.com',
  output: 'static',
  integrations: [sitemap()],
});
