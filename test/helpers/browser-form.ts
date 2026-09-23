/**
 * Submits a page's form the way a browser does, `Origin` header included.
 *
 * Written after the admin password reset shipped with both of its forms
 * broken. Their pages sent `Referrer-Policy: no-referrer`; a form inherits its
 * page's policy, and under `no-referrer` a browser posts `Origin: null`.
 * Astro's CSRF check wants the site's own origin exactly, so every real
 * submission got a plain-text 403 — and every test passed, because every POST
 * in the suite set `Origin` by hand to the one value the check wanted.
 *
 * `jsonRequest` still does that, and is right to for a test about what a route
 * does. A test whose claim is "a person on this page can submit this form" has
 * to derive the header from the page instead, which is what this does:
 *
 *   1. GET the page, signed out, without following a redirect.
 *   2. Work out the referrer policy the browser gives the submission: the
 *      `Referrer-Policy` header, overridden by `<meta name="referrer">`,
 *      overridden in turn by `rel="noreferrer"` on the `<form>` itself.
 *   3. Compute the `Origin` a browser sends under that policy — the switch in
 *      the Fetch standard's "append a request `Origin` header", in
 *      `formOrigin` below.
 *   4. POST the form, form-encoded, to its `action`, with that `Origin`.
 *
 * It models the forms this app has — one urlencoded POST form per page, built
 * from `<input>` elements — and throws on anything else rather than
 * approximating it. A helper that quietly sent what no browser would is the
 * very failure it exists to catch.
 *
 * Not modelled: `Referer`, cookies and constraint validation. Astro's check
 * reads only `Origin`, every form this is used on is used signed out, and what
 * a test types into a field is the test's own business.
 */

import { SELF } from 'cloudflare:test';

const FORM_TYPE = 'application/x-www-form-urlencoded';

/** Every token the Referrer Policy standard defines. A browser ignores anything else. */
const POLICIES: ReadonlySet<string> = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'same-origin',
  'origin',
  'strict-origin',
  'origin-when-cross-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);

/**
 * The legacy keywords `<meta name="referrer">` still honours, and what each
 * means now. The header honours none of them.
 */
const LEGACY_META: ReadonlyMap<string, string> = new Map([
  ['never', 'no-referrer'],
  ['default', 'strict-origin-when-cross-origin'],
  ['always', 'unsafe-url'],
  ['origin-when-crossorigin', 'origin-when-cross-origin'],
]);

/** What a browser applies when the page sets no policy at all. */
export const DEFAULT_POLICY = 'strict-origin-when-cross-origin';

export type PolicySource = 'header' | 'meta' | 'form rel' | 'default';

/* ------------------------------------------------------------ the policy */

/**
 * The policy a `Referrer-Policy` header sets, or `''` for none.
 *
 * The header may be a comma-separated list — a fallback list, for browsers
 * that do not know the newer tokens — and the last token the browser
 * recognises wins. Compared case-insensitively, as browsers do in practice;
 * the standard's comparison is exact, but erring this way can only make a
 * `no-referrer` easier to notice, never easier to miss.
 */
export function headerPolicy(value: string | null): string {
  let policy = '';
  for (const token of (value ?? '').split(',')) {
    const candidate = token.trim().toLowerCase();
    if (POLICIES.has(candidate)) policy = candidate;
  }
  return policy;
}

/** The policy one `<meta name="referrer">` sets, or `''` if a browser would ignore it. */
export function metaPolicy(content: string): string {
  const value = content.trim().toLowerCase();
  const policy = LEGACY_META.get(value) ?? value;
  return POLICIES.has(policy) ? policy : '';
}

/**
 * The referrer policy a form submission is made under, and where it came from.
 *
 * `rel="noreferrer"` on the form wins outright: the HTML form submission
 * algorithm hands `no-referrer` straight to the navigation it starts.
 * Otherwise the submission takes the document's policy — the last
 * `<meta name="referrer">` a browser recognises, since each one replaces the
 * policy when it is parsed, else the header, else the browser default.
 */
export function effectivePolicy(
  header: string | null,
  metas: readonly string[],
  formRel: string,
): { policy: string; source: PolicySource } {
  if (formRel.toLowerCase().split(/\s+/).includes('noreferrer')) {
    return { policy: 'no-referrer', source: 'form rel' };
  }

  let fromMeta = '';
  for (const content of metas) fromMeta = metaPolicy(content) || fromMeta;
  if (fromMeta) return { policy: fromMeta, source: 'meta' };

  const fromHeader = headerPolicy(header);
  if (fromHeader) return { policy: fromHeader, source: 'header' };

  return { policy: DEFAULT_POLICY, source: 'default' };
}

/**
 * The `Origin` a browser puts on a form POST from the page at `from` to the
 * action at `to`, made under `policy`.
 *
 * This is the switch in the Fetch standard's "append a request `Origin`
 * header". It applies to a request whose method is neither GET nor HEAD and
 * whose mode is not `cors`; a form submission is a navigation, whose mode is
 * `navigate`, so for every form it applies. Returns what goes on the wire: a
 * serialised origin, or the literal `null`.
 */
export function formOrigin(policy: string, from: URL, to: URL): string {
  switch (policy) {
    case 'no-referrer':
      return 'null';
    case 'no-referrer-when-downgrade':
    case 'strict-origin':
    case 'strict-origin-when-cross-origin':
      return from.protocol === 'https:' && to.protocol !== 'https:' ? 'null' : from.origin;
    case 'same-origin':
      return from.origin === to.origin ? from.origin : 'null';
    default:
      return from.origin;
  }
}

/* -------------------------------------------------------------- the page */

/** One control the form submits. */
export interface Control {
  name: string;
  value: string;
  /** A person cannot type into it, so a test may not either. */
  hidden: boolean;
}

export interface PageForm {
  /** Decoded; null when the attribute is absent. */
  action: string | null;
  /** Lowercased, and `get` when absent, as in HTML. */
  method: string;
  enctype: string | null;
  rel: string;
  controls: Control[];
  /** Controls inside the form that this helper does not model. */
  unmodelled: string[];
}

export interface ParsedPage {
  /** The content of every `<meta name="referrer">`, in document order. */
  metas: string[];
  forms: PageForm[];
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/**
 * HTMLRewriter hands attribute values over exactly as written, entities and
 * all — `value="a&amp;b"` reads back as `a&amp;b`, checked in workerd — while a
 * browser submits them decoded. Astro's escaper emits `&amp;` `&lt;` `&gt;`
 * `&quot;` and `&#39;`; the other numeric forms are for markup written by hand.
 */
function decode(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (entity, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return NAMED_ENTITIES.get(named!.toLowerCase()) ?? entity;
    },
  );
}

/** Input types that take part only as the submitter, or need an encoding this does not send. */
const UNMODELLED_INPUTS = new Set(['submit', 'image', 'reset', 'button', 'file']);

/**
 * Reads the parts of a page that a form submission depends on.
 *
 * Through workerd's own HTML parser rather than a regular expression, so a
 * `<form>` or a `<meta>` inside a comment or a script string is not mistaken
 * for a real one.
 */
export async function parsePage(html: string): Promise<ParsedPage> {
  const page: ParsedPage = { metas: [], forms: [] };
  let open: PageForm | null = null;

  const unmodelled = (label: string) => ({
    element(el: Element) {
      if (!open) return;
      // An unnamed button is never part of the submission, so it is no concern.
      if (label === 'button' && !el.hasAttribute('name')) return;
      open.unmodelled.push(`<${label}>`);
    },
  });

  await new HTMLRewriter()
    .on('meta', {
      element(el) {
        if ((el.getAttribute('name') ?? '').trim().toLowerCase() !== 'referrer') return;
        const content = el.getAttribute('content');
        if (content !== null) page.metas.push(decode(content));
      },
    })
    .on('form', {
      element(el) {
        const action = el.getAttribute('action');
        const enctype = el.getAttribute('enctype');
        const form: PageForm = {
          action: action === null ? null : decode(action),
          method: (el.getAttribute('method') ?? 'get').trim().toLowerCase(),
          enctype: enctype === null ? null : decode(enctype),
          rel: decode(el.getAttribute('rel') ?? ''),
          controls: [],
          unmodelled: [],
        };
        page.forms.push(form);
        open = form;
        el.onEndTag(() => {
          open = null;
        });
      },
    })
    .on('input', {
      element(el) {
        if (!open) return;
        const rawName = el.getAttribute('name');
        // Unnamed and disabled controls are never submitted, by anyone.
        if (!rawName || el.hasAttribute('disabled')) return;

        const name = decode(rawName);
        const type = (el.getAttribute('type') ?? 'text').trim().toLowerCase();
        if (UNMODELLED_INPUTS.has(type)) {
          open.unmodelled.push(`<input type="${type}" name="${name}">`);
          return;
        }

        const checkable = type === 'checkbox' || type === 'radio';
        if (checkable && !el.hasAttribute('checked')) return;

        const value = el.getAttribute('value');
        open.controls.push({
          name,
          value: value === null ? (checkable ? 'on' : '') : decode(value),
          hidden: type === 'hidden',
        });
      },
    })
    .on('textarea', unmodelled('textarea'))
    .on('select', unmodelled('select'))
    .on('button', unmodelled('button'))
    .transform(new Response(html))
    .arrayBuffer();

  return page;
}

/* ------------------------------------------------------------ submitting */

export interface FormSubmission {
  /** The page as it was served. Its body has been read into `html`. */
  page: Response;
  html: string;
  /** The policy the submission was made under, after every override. */
  referrerPolicy: string;
  policySource: PolicySource;
  /** What the `Origin` header carried: a serialised origin, or `null`. */
  origin: string;
  /** Where the form posted, absolute. */
  action: string;
  /** The route's answer, unfollowed. */
  response: Response;
  /**
   * One line for an assertion message, so a failure names its own cause. A
   * refusal reads "… under no-referrer (from the Referrer-Policy header), so
   * its form posted … with Origin: null".
   */
  trace: string;
}

const SOURCE_LABEL: Readonly<Record<PolicySource, string>> = {
  header: 'from the Referrer-Policy header',
  meta: 'from a <meta name="referrer">',
  'form rel': 'from rel="noreferrer" on the form',
  default: 'the browser default; the page sets none',
};

/**
 * GETs `pageUrl` and submits its one POST form with `typed` filled in.
 *
 * `typed` is what a person enters, by field name. Every other control goes as
 * the page rendered it — which is how a hidden token or `next` travels — and a
 * name the form does not have, or a hidden one, is refused, because a browser
 * could send neither.
 */
export async function submitForm(
  pageUrl: string,
  typed: Readonly<Record<string, string>> = {},
): Promise<FormSubmission> {
  function refuse(why: string): never {
    throw new Error(`submitForm: ${pageUrl} ${why}`);
  }

  const page = await SELF.fetch(pageUrl, { redirect: 'manual' });
  const html = await page.text();
  if (page.status !== 200) refuse(`answered ${page.status}, so there is no form to submit`);

  const { metas, forms } = await parsePage(html);
  const posting = forms.filter((candidate) => candidate.method === 'post');
  const form = posting[0];
  if (!form || posting.length > 1) refuse(`has ${posting.length} POST forms, not one`);
  if (form.enctype !== null && form.enctype.trim().toLowerCase() !== FORM_TYPE) {
    refuse(`has a form that sends ${form.enctype}; only ${FORM_TYPE} is modelled`);
  }
  if (form.unmodelled.length > 0) {
    refuse(`has controls this does not model: ${form.unmodelled.join(', ')}`);
  }

  const entered = new Map(Object.entries(typed));
  for (const name of entered.keys()) {
    const control = form.controls.find((c) => c.name === name);
    if (!control) refuse(`has no field named "${name}" in its form`);
    if (control.hidden) refuse(`has "${name}" as a hidden field, and nobody can type into one`);
  }

  const body = new URLSearchParams();
  for (const control of form.controls) {
    body.append(control.name, entered.get(control.name) ?? control.value);
  }

  const from = new URL(pageUrl);
  // An absent or empty `action` posts back to the page's own URL, as in HTML.
  const to = new URL(form.action || from.href, from);
  const { policy, source } = effectivePolicy(page.headers.get('referrer-policy'), metas, form.rel);
  const origin = formOrigin(policy, from, to);

  const response = await SELF.fetch(
    new Request(to, {
      method: 'POST',
      headers: { 'content-type': FORM_TYPE, origin },
      body: body.toString(),
    }),
    { redirect: 'manual' },
  );

  return {
    page,
    html,
    referrerPolicy: policy,
    policySource: source,
    origin,
    action: to.href,
    response,
    trace:
      `${from.pathname}${from.search} submits under ${policy} (${SOURCE_LABEL[source]}), ` +
      `so its form posted to ${to.pathname} with Origin: ${origin}`,
  };
}
