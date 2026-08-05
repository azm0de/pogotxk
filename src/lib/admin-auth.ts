/**
 * Bearer-token guard for the maintenance endpoints.
 *
 * This is a stopgap until Discord OAuth lands, at which point these routes move
 * behind the `admin` role. It exists so the one-off legacy import can run
 * against production without opening an unauthenticated write endpoint.
 */

/** Constant-time comparison so a wrong token cannot be recovered by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Compare lengths without early return, then bytes.
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function requireImportToken(request: Request, env: Env): Response | null {
  const expected = (env as unknown as { IMPORT_TOKEN?: string }).IMPORT_TOKEN;

  if (!expected) {
    return json(
      { error: 'IMPORT_TOKEN is not configured. Set it in .dev.vars or as a Worker secret.' },
      503,
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!supplied || !timingSafeEqual(supplied, expected)) {
    return json({ error: 'Unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer realm="pogotxk-admin"',
    });
  }

  return null;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
