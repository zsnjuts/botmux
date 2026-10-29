/**
 * ByteCloud JWT verification for the person-authenticated admin API.
 *
 * ByteCloud signs user JWTs with RS256 and publishes the key set at
 * `<ByteCloud origin>/auth/api/v1/jwks`; the deployment injects that URL
 * (`BOTMUX_ADMIN_JWKS_URL`) because private hostnames stay out of the public
 * source. The tokens carry no
 * `aud`, so a token is a full ByteCloud credential for its lifetime: never log
 * or persist it — only the verified identity leaves this module.
 */
import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';

export const BYTECLOUD_JWT_ISSUER = 'paas.passport.auth_oauth2';

const KEYS_TTL_MS = 60 * 60_000;
const KEYS_REFRESH_COOLDOWN_MS = 5 * 60_000;
const CLOCK_SKEW_S = 60;
const MAX_TOKEN_LENGTH = 8192;

export interface ByteCloudIdentity {
  username: string;
  email: string;
  /** Token expiry, epoch seconds. */
  exp: number;
}

export type JwtVerifyError =
  | 'jwt_malformed'
  | 'jwt_unsupported_alg'
  | 'jwt_bad_signature'
  | 'jwt_expired'
  | 'jwt_not_yet_valid'
  | 'jwt_bad_issuer'
  | 'jwt_not_person'
  | 'jwt_missing_identity'
  | 'jwks_unavailable';

export type JwtVerifyResult = { ok: true; identity: ByteCloudIdentity } | { ok: false; error: JwtVerifyError };

export interface ByteCloudJwtVerifierOptions {
  /** Required unless `fetchJwks` is supplied. */
  jwksUrl?: string;
  issuer?: string;
  /** Returns the parsed JWKS document; defaults to an HTTPS GET of `jwksUrl`. */
  fetchJwks?: () => Promise<unknown>;
  now?: () => number;
}

function base64UrlJson(part: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function rsaKeys(doc: unknown): KeyObject[] {
  const keys = doc && typeof doc === 'object' ? (doc as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys)) throw new Error('jwks_invalid');
  const out: KeyObject[] = [];
  for (const jwk of keys) {
    if (!jwk || typeof jwk !== 'object' || (jwk as JsonWebKey).kty !== 'RSA') continue;
    const alg = (jwk as { alg?: unknown }).alg;
    if (alg !== undefined && alg !== 'RS256') continue;
    try { out.push(createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })); } catch { /* skip unusable key */ }
  }
  if (out.length === 0) throw new Error('jwks_empty');
  return out;
}

export function createByteCloudJwtVerifier(options: ByteCloudJwtVerifierOptions = {}): (token: string) => Promise<JwtVerifyResult> {
  const jwksUrl = options.jwksUrl;
  const issuer = options.issuer ?? BYTECLOUD_JWT_ISSUER;
  const now = options.now ?? Date.now;
  const fetchJwks = options.fetchJwks ?? (async () => {
    if (!jwksUrl) throw new Error('jwks_url_unset');
    const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`jwks_http_${response.status}`);
    return response.json();
  });

  let cached: { keys: KeyObject[]; fetchedAt: number } | undefined;
  let inflight: Promise<KeyObject[]> | undefined;

  async function loadKeys(force: boolean): Promise<KeyObject[]> {
    if (cached && !force && now() - cached.fetchedAt < KEYS_TTL_MS) return cached.keys;
    if (cached && force && now() - cached.fetchedAt < KEYS_REFRESH_COOLDOWN_MS) return cached.keys;
    inflight ??= fetchJwks()
      .then((doc) => {
        const keys = rsaKeys(doc);
        cached = { keys, fetchedAt: now() };
        return keys;
      })
      .finally(() => { inflight = undefined; });
    try {
      return await inflight;
    } catch (error) {
      // Keep serving a previously good key set through a JWKS outage.
      if (cached) return cached.keys;
      throw error;
    }
  }

  return async (token: string): Promise<JwtVerifyResult> => {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { ok: false, error: 'jwt_malformed' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !part)) return { ok: false, error: 'jwt_malformed' };
    const header = base64UrlJson(parts[0]);
    const payload = base64UrlJson(parts[1]);
    if (!header || !payload) return { ok: false, error: 'jwt_malformed' };
    if (header.alg !== 'RS256') return { ok: false, error: 'jwt_unsupported_alg' };

    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    const matches = (keys: KeyObject[]) =>
      keys.some(key => verifySignature('RSA-SHA256', signingInput, key, signature));
    let keys: KeyObject[];
    try { keys = await loadKeys(false); } catch { return { ok: false, error: 'jwks_unavailable' }; }
    if (!matches(keys)) {
      // One forced refresh covers key rotation; the cooldown stops a flood of
      // forged tokens from turning into a flood of JWKS fetches.
      let refreshed: KeyObject[];
      try { refreshed = await loadKeys(true); } catch { return { ok: false, error: 'jwt_bad_signature' }; }
      if (refreshed === keys || !matches(refreshed)) return { ok: false, error: 'jwt_bad_signature' };
    }

    const nowS = Math.floor(now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < nowS) return { ok: false, error: 'jwt_expired' };
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > nowS) return { ok: false, error: 'jwt_not_yet_valid' };
    if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > nowS) return { ok: false, error: 'jwt_not_yet_valid' };
    if (payload.iss !== issuer) return { ok: false, error: 'jwt_bad_issuer' };
    if (payload.type !== 'person_account') return { ok: false, error: 'jwt_not_person' };
    if (typeof payload.username !== 'string' || !payload.username
        || typeof payload.email !== 'string' || !payload.email.includes('@')) {
      return { ok: false, error: 'jwt_missing_identity' };
    }
    return { ok: true, identity: { username: payload.username, email: payload.email.toLowerCase(), exp: payload.exp } };
  };
}
