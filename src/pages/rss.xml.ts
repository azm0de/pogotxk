/**
 * RSS 2.0 feed for the blog.
 *
 * Built by hand rather than with @astrojs/rss: the payload is a dozen lines of
 * XML and this way the feed shares the exact `listPostsForFeed` visibility
 * predicate the site uses, so a scheduled post cannot leak early through the
 * feed while still being hidden on the page.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { listPostsForFeed } from '~/lib/db/posts';
import { markdownToText, renderMarkdown } from '~/lib/markdown';

export const prerender = false;

const FEED_TITLE = 'PoGo TXK — Community News';
const FEED_DESCRIPTION =
  'Meetup recaps, raid plans, event guides and Spring Lake Park Campsite updates for Pokémon GO trainers in Texarkana.';

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wrap HTML in CDATA. The split re-opens the section around any literal `]]>`,
 * which is the only sequence that can terminate one early.
 */
function cdata(html: string): string {
  return `<![CDATA[${html.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** RFC-822, which is what RSS readers parse. */
function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

export async function GET(ctx: APIContext): Promise<Response> {
  const origin = (ctx.site ?? new URL(ctx.request.url)).origin;
  const posts = await listPostsForFeed(env.DB, 20);

  const items = posts.map((post) => {
    const url = `${origin}/blog/${post.slug}`;
    const published = post.publishedAt ?? post.createdAt;

    // Readers render this HTML far from our origin, so every URL inside it has
    // to be absolute — hence `baseUrl`. It is the post's own URL rather than the
    // bare origin so that an in-post anchor (`[jump](#lineup)`) resolves back to
    // this post; against the origin it would silently point at the home page.
    // Root-relative URLs like /media/… are unaffected, since resolution ignores
    // the base's path for those.
    const hero = post.hero
      ? `<figure><img src="${origin}/media/${post.hero.key}" alt="${xml(post.hero.alt ?? '')}" /></figure>`
      : '';
    const body = renderMarkdown(post.bodyMd, { baseUrl: url });

    return `    <item>
      <title>${xml(post.title)}</title>
      <link>${xml(url)}</link>
      <guid isPermaLink="true">${xml(url)}</guid>
      <pubDate>${rfc822(published)}</pubDate>
      <description>${xml(post.excerpt || markdownToText(post.bodyMd, 300))}</description>
${post.author ? `      <dc:creator>${xml(post.author.name)}</dc:creator>\n` : ''}${post.tags
      .map((tag) => `      <category>${xml(tag)}</category>\n`)
      .join('')}      <content:encoded>${cdata(hero + body)}</content:encoded>
    </item>`;
  });

  const lastBuild = posts[0]?.publishedAt ?? posts[0]?.createdAt ?? new Date().toISOString();

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xml(FEED_TITLE)}</title>
    <link>${xml(`${origin}/blog`)}</link>
    <description>${xml(FEED_DESCRIPTION)}</description>
    <language>en-us</language>
    <lastBuildDate>${rfc822(lastBuild)}</lastBuildDate>
    <atom:link href="${xml(`${origin}/rss.xml`)}" rel="self" type="application/rss+xml" />
${items.join('\n')}
  </channel>
</rss>
`;

  return new Response(feed, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      // Short, because a scheduled post becomes public on a clock this feed has
      // to notice without anyone deploying anything.
      'cache-control': 'public, max-age=60, stale-while-revalidate=600',
    },
  });
}
