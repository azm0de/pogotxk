/**
 * The device-grant cookie's payload: everything a pending sign-in needs to
 * survive between the page's polls, in one HttpOnly base64url blob.
 *
 * Lives in its own module, free of `cloudflare:workers` imports, for the same
 * reason `next.ts` does — both endpoints use it and a plain tsx test can
 * import it. Same encoding as /auth/login's state payload.
 */

export interface DevicePayload {
  /** The polling credential. Stays server-side; the page never sees it. */
  deviceCode: string;
  /** Echoed so a refresh can re-show the same pending code. */
  userCode: string;
  /** discord.com/activate link, ditto. */
  uri: string;
  /** Where to land after sign-in. Re-validated by `safeNext` on the way out. */
  next: string;
  /** Epoch seconds when Discord expires the code. */
  exp: number;
  /** Discord's polling interval, seconds. */
  interval: number;
}

export function encodeDevicePayload(payload: DevicePayload): string {
  return btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeDevicePayload(raw: string | undefined): DevicePayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))) as DevicePayload;
    if (
      typeof parsed.deviceCode !== 'string' ||
      !parsed.deviceCode ||
      typeof parsed.userCode !== 'string' ||
      typeof parsed.uri !== 'string' ||
      typeof parsed.next !== 'string' ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.interval !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
