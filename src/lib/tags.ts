import type { CollectionEntry } from 'astro:content';

// Convert a tag name into a URL-safe slug.
export function slugifyTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export interface TagInfo {
  slug: string;
  name: string;
  count: number;
}

// Build the tag archive from published posts only.
// Draft posts and tags that are not used by published articles are excluded.
export function getAllTags(posts: CollectionEntry<'blog'>[]): TagInfo[] {
  const bySlug = new Map<string, TagInfo>();

  for (const post of posts) {
    if (post.data.draft) continue;

    const seen = new Set<string>();

    for (const tag of post.data.tags) {
      const slug = slugifyTag(tag);

      if (!slug || seen.has(slug)) continue;

      seen.add(slug);

      const existing = bySlug.get(slug);

      if (existing) {
        existing.count += 1;
      } else {
        bySlug.set(slug, {
          slug,
          name: tag,
          count: 1,
        });
      }
    }
  }

  return [...bySlug.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}
