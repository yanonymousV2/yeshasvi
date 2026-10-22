import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/** Published posts, newest first. Drafts are included only in `npm run dev`. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }: Post) => import.meta.env.DEV || !data.draft);
  return posts.sort((a: Post, b: Post) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export const formatDate = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const readingTime = (body = '') => {
  const words = body.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
};
