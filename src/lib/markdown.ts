/**
 * A compact Markdown renderer for post bodies.
 *
 * Hand-rolled rather than `marked` + a sanitiser. Sanitising *after* rendering
 * means trusting a blocklist to undo whatever the parser let through; this
 * renderer inverts that. Every character of the source is HTML-escaped before
 * any tag is produced, so the tags emitted below are the only tags that can
 * ever reach the page. Raw HTML in a post body renders as visible text rather
 * than executing — safe by construction, not by filtering. Ambassadors are
 * trusted people, but a borrowed session should not become stored XSS for
 * every reader, and the same renderer runs in the admin preview island where
 * the input is whatever is currently in the textarea.
 *
 * Supported: ATX headings, bold / italic / strikethrough, inline code, fenced
 * code, links, images (an image alone in a paragraph becomes a <figure>),
 * nested ordered and unordered lists, blockquotes, horizontal rules, hard line
 * breaks, paragraphs.
 *
 * Deliberately unsupported: raw HTML, tables, footnotes, reference-style links.
 * If a post ever needs a table, that is a signal it wants a component, not a
 * bigger Markdown dialect.
 */

import { slugify } from '~/lib/slug';

export interface MarkdownOptions {
  /**
   * Absolute origin used to expand site-relative URLs. The RSS feed needs
   * absolute hrefs because readers render the HTML far from our origin.
   */
  baseUrl?: string;
  /**
   * How far to push `#`. Post pages already own the document's single <h1>,
   * so by default `#` renders as <h2> and the outline stays valid.
   */
  headingOffset?: number;
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

/**
 * Undo `escapeHtml` far enough to hand a URL to `new URL()`. `&amp;` is last
 * on purpose: decoding it first would turn a literal `&amp;lt;` into `<`.
 */
function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Scheme allowlist. Anything not matching — `javascript:`, `data:`,
 * `vbscript:`, protocol-relative `//evil.example` — is refused outright rather
 * than scrubbed, so there is no encoding trick to smuggle past a filter.
 *
 * The backslash in the lookahead is not decoration. WHATWG URL parsing treats
 * `\` as `/` for http(s), so `/\evil.example` resolves to `https://evil.example`
 * exactly like `//evil.example` does — a root-relative link that silently leaves
 * the site. Both slash shapes have to be excluded or the rule only looks closed.
 */
const ALLOWED_URL = /^(?:https?:\/\/|mailto:|tel:|\/(?![/\\])|#|\.{1,2}\/)/i;

/** Returns an escaped, renderable href, or null when the URL is not allowed. */
function safeUrl(escapedUrl: string, baseUrl?: string): string | null {
  const url = escapedUrl.trim();
  if (!url || !ALLOWED_URL.test(url)) return null;

  // Site-relative links only become absolute for consumers that need it (RSS).
  if (baseUrl && !/^(?:https?:|mailto:|tel:)/i.test(url)) {
    try {
      return escapeHtml(new URL(decodeEntities(url), baseUrl).href);
    } catch {
      return null;
    }
  }
  return url;
}

/**
 * External links open in a new tab; `noopener` keeps them off `window.opener`.
 * Judged on the URL as authored, not the resolved one — a site-relative link
 * that `baseUrl` made absolute for the RSS feed is still an internal link.
 */
function linkAttrs(authoredUrl: string): string {
  return /^https?:/i.test(authoredUrl.trim()) ? ' target="_blank" rel="noopener noreferrer"' : '';
}

/**
 * The URL half of `](…)`. One level of balanced parentheses is allowed so
 * `https://en.wikipedia.org/wiki/Pikachu_(disambiguation)` survives instead of
 * being cut at the first `)`.
 */
const URL_PART = String.raw`((?:[^()\s]|\([^()\s]*\))+)`;
const IMAGE_RE = new RegExp(String.raw`!\[([^\]]*)\]\(\s*${URL_PART}(?:\s+&quot;([^)]*?)&quot;)?\s*\)`, 'g');
const LINK_RE = new RegExp(String.raw`\[([^\]]+)\]\(\s*${URL_PART}(?:\s+&quot;([^)]*?)&quot;)?\s*\)`, 'g');

/**
 * Inline span rendering. `text` is already HTML-escaped; every transformation
 * below only ever *adds* tags around escaped content.
 */
function renderInline(text: string, opts: MarkdownOptions): string {
  // Code spans are pulled out first and parked behind placeholders so emphasis
  // and link syntax inside them survives verbatim, then dropped back in last.
  const codes: string[] = [];
  let out = text.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_m, _fence: string, code: string) => {
    codes.push(`<code>${code.trim()}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = out.replace(IMAGE_RE, (whole, alt: string, url: string, title?: string) => {
    const href = safeUrl(url, opts.baseUrl);
    if (!href) return alt || whole;
    const titleAttr = title ? ` title="${title}"` : '';
    return `<img src="${href}" alt="${alt}"${titleAttr} loading="lazy" decoding="async" />`;
  });

  out = out.replace(LINK_RE, (_whole, label: string, url: string, title?: string) => {
    const href = safeUrl(url, opts.baseUrl);
    // A rejected URL still shows its label — dropping the text would silently
    // eat a sentence, which is worse than an unlinked phrase.
    if (!href) return label;
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr}${linkAttrs(url)}>${label}</a>`;
  });

  out = out
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])__(?=\S)([\s\S]*?\S)__(?![\w])/g, '$1<strong>$2</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_(?=\S)([^_]*?\S)_(?![\w])/g, '$1<em>$2</em>');

  // Two trailing spaces is Markdown's hard break; a bare newline inside a
  // paragraph is just a soft wrap in the source. One pass, because replacing
  // newlines afterwards would eat the newline the <br /> just gained.
  out = out.replace(/ *\n/g, (match) => (match.length >= 3 ? '<br />\n' : ' '));

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

interface ListMarker {
  indent: number;
  ordered: boolean;
  /** Column the item's content starts at, used to dedent continuation lines. */
  contentCol: number;
  start: number;
  text: string;
}

function matchListItem(line: string): ListMarker | null {
  const bullet = /^(\s*)([-*+])(\s+)(.*)$/.exec(line);
  if (bullet) {
    const [, pad = '', marker = '', gap = '', text = ''] = bullet;
    return {
      indent: pad.length,
      ordered: false,
      contentCol: pad.length + marker.length + gap.length,
      start: 1,
      text,
    };
  }
  const ordered = /^(\s*)(\d{1,9})[.)](\s+)(.*)$/.exec(line);
  if (ordered) {
    const [, pad = '', num = '1', gap = '', text = ''] = ordered;
    return {
      indent: pad.length,
      ordered: true,
      contentCol: pad.length + num.length + 1 + gap.length,
      start: Number(num),
      text,
    };
  }
  return null;
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Consumes one list and everything nested inside it. Each item's lines are fed
 * back through `renderBlocks`, which is what makes nested lists, code blocks
 * and quotes inside list items work without any special cases here.
 */
function renderList(lines: string[], from: number, opts: MarkdownOptions): [string, number] {
  const first = matchListItem(lines[from] ?? '');
  if (!first) return ['', from + 1];

  const { indent, ordered } = first;
  const items: string[][] = [];
  let loose = false;
  let i = from;

  while (i < lines.length) {
    const marker = matchListItem(lines[i] ?? '');
    if (!marker || marker.indent < indent || marker.indent > indent + 3) break;
    if (marker.ordered !== ordered) break;

    const body = [marker.text];
    i++;

    // Continuation: anything indented past the marker, plus blank lines that
    // are followed by more of this item (a blank line makes the list loose).
    let pendingBlank = false;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (line.trim() === '') {
        pendingBlank = true;
        i++;
        continue;
      }
      if (leadingSpaces(line) < marker.contentCol && matchListItem(line) === null) break;
      if (matchListItem(line) && leadingSpaces(line) <= indent) break;
      if (pendingBlank) {
        body.push('');
        loose = true;
        pendingBlank = false;
      }
      body.push(line.slice(marker.contentCol));
      i++;
    }
    if (pendingBlank && i < lines.length && matchListItem(lines[i] ?? '')) loose = true;

    items.push(body);
  }

  const rendered = items.map((body) => {
    let html = renderBlocks(body, opts);
    // Tight lists read better without the paragraph wrapper. Unwrap only when
    // the paragraph is the whole item or is followed directly by a sub-list.
    if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>(?=(?:<[uo]l>|$))/, '$1');
    return `<li>${html}</li>`;
  });

  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && first.start !== 1 ? ` start="${first.start}"` : '';
  return [`<${tag}${startAttr}>${rendered.join('')}</${tag}>`, i];
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
/** A paragraph holding nothing but one image is a figure, not a run of text. */
const LONE_IMAGE_RE = /^<img [^>]*\/>$/;

function renderBlocks(lines: string[], opts: MarkdownOptions): string {
  const out: string[] = [];
  const headingOffset = opts.headingOffset ?? 1;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const close = fence[1] ?? '```';
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(close)) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // step over the closing fence (or past the end, if unterminated)
      const langAttr = lang ? ` class="language-${lang.toLowerCase()}"` : '';
      out.push(`<pre><code${langAttr}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? '#').length + headingOffset, 6);
      const inner = renderInline(escapeHtml(heading[2] ?? ''), opts);
      // Stable ids let the "on this page" anchors and deep links work.
      const id = slugify(decodeEntities(inner.replace(/<[^>]*>/g, '')));
      out.push(`<h${level} id="${id}">${inner}</h${level}>`);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() !== '') {
        const quoted = QUOTE_RE.exec(lines[i] ?? '');
        // Lazy continuation: a wrapped line inside a quote needs no `>`.
        inner.push(quoted ? (quoted[1] ?? '') : (lines[i] ?? ''));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(inner, opts)}</blockquote>`);
      continue;
    }

    if (matchListItem(line)) {
      const [html, next] = renderList(lines, i, opts);
      out.push(html);
      i = next;
      continue;
    }

    // Paragraph: run to the next blank line or block-level opener.
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        current.trim() === '' ||
        FENCE_RE.test(current) ||
        HR_RE.test(current) ||
        HEADING_RE.test(current) ||
        QUOTE_RE.test(current) ||
        matchListItem(current)
      ) {
        break;
      }
      para.push(current);
      i++;
    }

    const html = renderInline(escapeHtml(para.join('\n')), opts);
    if (LONE_IMAGE_RE.test(html)) {
      const title = /title="([^"]*)"/.exec(html)?.[1];
      const img = html.replace(/ title="[^"]*"/, '');
      out.push(`<figure>${img}${title ? `<figcaption>${title}</figcaption>` : ''}</figure>`);
    } else {
      out.push(`<p>${html}</p>`);
    }
  }

  return out.join('');
}

/** Markdown source to safe HTML. */
export function renderMarkdown(source: string, opts: MarkdownOptions = {}): string {
  if (!source) return '';
  // NUL is the inline placeholder sentinel, so it must not survive from input.
  const normalized = source.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').replace(/\t/g, '    ');
  return renderBlocks(normalized.split('\n'), opts);
}

/**
 * Markdown to a single line of plain text, for meta descriptions, RSS
 * summaries and the excerpt fallback. Never HTML-escaped — callers put it in
 * attributes or XML, which have different escaping rules.
 */
export function markdownToText(source: string, limit = 200): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d{1,9}[.)])\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  // Cut on a word boundary — a description ending mid-word looks broken.
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Rounded-up minutes at 220 wpm, the usual figure for casual reading. */
export function readingMinutes(source: string): number {
  const words = markdownToText(source, Number.MAX_SAFE_INTEGER).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}
