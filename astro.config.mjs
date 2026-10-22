// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  // Live on GitHub Pages at https://yanonymousv2.github.io/yeshasvi/
  // With a custom domain later: set `site` to it and change `base` to '/'.
  site: 'https://yanonymousv2.github.io',
  base: '/yeshasvi',
  markdown: {
    shikiConfig: {
      // Code blocks read their colors from CSS variables, so they follow every visual style.
      theme: 'css-variables',
      wrap: true,
    },
  },
});
