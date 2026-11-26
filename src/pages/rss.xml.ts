import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import { SITE_NAME } from '../lib/site';
import { postSlug } from '../lib/posts';

export async function GET(context: APIContext) {
  const posts = (await getCollection('blog'))
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());

  return rss({
    title: `${SITE_NAME} — Free and Open-Source Software`,
    description:
      'Free and open-source software, done right. GetFOSS picks the best FOSS apps — private, secure, and community-driven — for every platform.',
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: `/blog/${postSlug(post)}/`,
    })),
    customData: '<language>en-us</language>',
  });
}
