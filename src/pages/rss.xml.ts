import { url } from '../lib/url';
import type { APIContext } from 'astro';
import { getPosts } from '../lib/blog';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Links become absolute once `site` is set in astro.config.mjs (feed readers need that).
export async function GET(context: APIContext) {
  const posts = await getPosts();
  const abs = (p: string) => (context.site ? new URL(url(p), context.site).href : url(p));
  const items = posts.map((post) => `
    <item>
      <title>${esc(post.data.title)}</title>
      <link>${abs(`/blog/${post.id}/`)}</link>
      <guid>${abs(`/blog/${post.id}/`)}</guid>
      <description>${esc(post.data.description)}</description>
      <pubDate>${post.data.pubDate.toUTCString()}</pubDate>
    </item>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Yeshasvi — blog</title>
    <link>${abs('/blog/')}</link>
    <description>Notes on backend systems: the things I build and the trade-offs behind them.</description>
    <language>en</language>${items}
  </channel>
</rss>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
