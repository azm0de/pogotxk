/**
 * The one fetch helper every admin island uses.
 *
 * There used to be five of them — `MapEditor`, `PostEditor`, `MeetupEditor`,
 * `MediaLibrary` and `ImportPanel` each carried its own — and they had drifted:
 * two printed zod's `detail`, one dropped it, one threw on a 204, and none of
 * them could tell "your session ran out" from any other failure. An expired
 * session showed a bare red "Forbidden" with no way forward (admin audit,
 * 2026-10, C-11). This is the single place that knows the API's error shape.
 *
 * Browser-only by use, but safe to import during SSR: nothing here touches
 * `window` until a request is actually made.
 */

/** One zod issue as the API reports it (`src/lib/api.ts` → `readJson`). */
export interface FieldIssue {
  path: string;
  message: string;
}

/** Any non-2xx answer. `status` and the parsed body ride along for callers
 *  that branch on them (the importer's 409, a 404 on a deleted row). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: { error?: string; detail?: unknown } & Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The session is gone (401). A distinct type because the islands answer it
 * differently from every other failure: no automatic redirect — the draft on
 * screen is still the only copy of the work — just a sign-in link that comes
 * back here.
 */
export class SignedOutError extends ApiError {
  constructor(body: ApiError['body']) {
    super('You were signed out.', 401, body);
    this.name = 'SignedOutError';
  }
}

/**
 * Plain names for the request fields the editors send, so a validation failure
 * reads "Title — String must contain at most 200 character(s)" rather than
 * "title: …". Anything not listed falls back to the raw path.
 */
const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  name: 'Name',
  slug: 'Slug',
  excerpt: 'Excerpt',
  bodyMd: 'Body',
  status: 'Status',
  pinned: 'Placement',
  tags: 'Tags',
  heroMediaId: 'Hero image',
  publishedAtLocal: 'Publish time',
  tz: 'Time zone',
  announce: 'Discord announcement',
  descriptionMd: 'Details',
  description: 'Description',
  startsAtLocal: 'Starts',
  endsAtLocal: 'Ends',
  poiId: 'Location',
  locationText: 'Location (free text)',
  campfireUrl: 'Campfire link',
  type: 'Type',
  lat: 'Latitude',
  lng: 'Longitude',
  sponsor: 'Sponsor',
  isCampsite: 'Campsite',
  isMeetupSpot: 'Meetup spot',
  isExEligible: 'EX eligible',
  alt: 'Alt text',
  caption: 'Caption',
  credit: 'Credit',
  sourceTitle: 'Source title',
  sourceDate: 'Source date',
  sourceUrl: 'Source URL',
  kind: 'Kind',
  file: 'File',
};

function fieldLabel(path: string): string {
  // `tags.3` is still the Tags field; the index means nothing to a person.
  const head = path.split('.')[0] ?? path;
  return FIELD_LABELS[head] ?? (path || 'Request');
}

/** "Validation failed: Title — too long; Starts — Expected YYYY-MM-DDTHH:MM". */
export function describeError(body: ApiError['body'], fallback: string): string {
  const base = typeof body.error === 'string' && body.error ? body.error : fallback;
  if (!Array.isArray(body.detail) || body.detail.length === 0) return base;
  const parts = (body.detail as FieldIssue[])
    .filter((d) => d && typeof d.message === 'string')
    .map((d) => `${fieldLabel(String(d.path ?? ''))} — ${d.message}`);
  return parts.length ? `${base}: ${parts.join('; ')}` : base;
}

/**
 * `fetch` for `/api/admin/*`.
 *
 * - A JSON content type on every non-multipart request. Astro's CSRF check
 *   refuses a form-shaped cross-site POST, and the type is what marks this as
 *   an API call; it costs nothing on a GET or a DELETE.
 * - No content type at all for a `FormData` body: the browser has to write the
 *   multipart boundary itself, and a hand-set header would lose it.
 * - 204 resolves to `undefined` (archive and delete answer with no body).
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const multipart = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const headers = new Headers(init.headers);
  if (!multipart && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(path, { credentials: 'same-origin', ...init, headers });

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const body = (await res.json().catch(() => ({}))) as ApiError['body'];
  if (res.status === 401) throw new SignedOutError(body);
  if (res.status === 403) {
    // "Requires admin" is the useful one; a bare "Forbidden" gets a sentence.
    const msg =
      body.error && body.error !== 'Forbidden'
        ? body.error
        : 'You do not have permission to do that.';
    throw new ApiError(msg, 403, body);
  }
  throw new ApiError(describeError(body, res.statusText || `Request failed (${res.status})`), res.status, body);
}

/** Where "Sign in again" goes: the login page, coming back to this exact view. */
export function signInHref(): string {
  if (typeof window === 'undefined') return '/admin/login';
  const here = `${window.location.pathname}${window.location.search}`;
  return `/admin/login?next=${encodeURIComponent(here)}`;
}

/** The message to show for anything thrown by `api()`. */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
