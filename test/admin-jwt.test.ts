import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminJwtOptionsFromEnv, createAdminJwtVerifier, parseRequiredClaims, type AdminJwtVerifierOptions } from '../src/dashboard/admin-jwt.js';

const ISSUER = 'https://sso.example.com';
const SITE: Pick<AdminJwtVerifierOptions, 'issuer' | 'requiredClaims' | 'usernameClaim'> = {
  issuer: ISSUER,
  requiredClaims: { type: 'person' },
  usernameClaim: 'username',
};
const createVerifier = (options: Omit<AdminJwtVerifierOptions, 'issuer'>) => createAdminJwtVerifier({ ...SITE, ...options });

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid: '' } };
}

function token(privateKey: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${enc(header)}.${enc(claims)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

function personClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    type: 'person',
    username: 'alice',
    email: 'Alice@Example.com',
    iat: NOW_S - 60,
    exp: NOW_S + 3600,
    ...overrides,
  };
}

describe('admin JWT verifier', () => {
  it('accepts a person token signed by the published key and normalizes the email', async () => {
    const { privateKey, jwk } = keyPair();
    const verify = createVerifier({ fetchJwks: async () => ({ keys: [jwk] }), now: () => NOW_MS });
    await expect(verify(token(privateKey, personClaims()))).resolves.toEqual({
      ok: true,
      identity: { username: 'alice', email: 'alice@example.com', exp: NOW_S + 3600 },
    });
  });

  it.each([
    ['expired', personClaims({ exp: NOW_S - 3600 }), 'jwt_expired'],
    ['issued in the future', personClaims({ iat: NOW_S + 3600 }), 'jwt_not_yet_valid'],
    ['foreign issuer', personClaims({ iss: 'someone.else' }), 'jwt_bad_issuer'],
    ['non-person account', personClaims({ type: 'service' }), 'jwt_claim_mismatch'],
    ['no email', personClaims({ email: undefined }), 'jwt_missing_identity'],
  ])('rejects a %s token', async (_label, claims, error) => {
    const { privateKey, jwk } = keyPair();
    const verify = createVerifier({ fetchJwks: async () => ({ keys: [jwk] }), now: () => NOW_MS });
    await expect(verify(token(privateKey, claims))).resolves.toEqual({ ok: false, error });
  });

  it('rejects tokens signed by another key and unsigned algorithms', async () => {
    const published = keyPair();
    const attacker = keyPair();
    const verify = createVerifier({ fetchJwks: async () => ({ keys: [published.jwk] }), now: () => NOW_MS });
    await expect(verify(token(attacker.privateKey, personClaims()))).resolves.toEqual({ ok: false, error: 'jwt_bad_signature' });
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(personClaims())).toString('base64url')}.x`;
    await expect(verify(unsigned)).resolves.toEqual({ ok: false, error: 'jwt_unsupported_alg' });
    await expect(verify('not-a-jwt')).resolves.toEqual({ ok: false, error: 'jwt_malformed' });
  });

  it('refreshes the key set once when the signer rotated, but not on every forged token', async () => {
    const oldKey = keyPair();
    const newKey = keyPair();
    let now = NOW_MS;
    let published = [oldKey.jwk];
    let fetches = 0;
    const verify = createVerifier({
      fetchJwks: async () => { fetches += 1; return { keys: published }; },
      now: () => now,
    });
    await expect(verify(token(oldKey.privateKey, personClaims()))).resolves.toMatchObject({ ok: true });
    expect(fetches).toBe(1);

    published = [newKey.jwk];
    now += 10 * 60_000;
    await expect(verify(token(newKey.privateKey, personClaims({ exp: now / 1000 + 3600 })))).resolves.toMatchObject({ ok: true });
    expect(fetches).toBe(2);

    const forger = keyPair();
    await verify(token(forger.privateKey, personClaims({ exp: now / 1000 + 3600 })));
    await verify(token(forger.privateKey, personClaims({ exp: now / 1000 + 3600 })));
    expect(fetches).toBe(2);
  });

  it('keeps verifying with the last good keys through a JWKS outage', async () => {
    const { privateKey, jwk } = keyPair();
    let now = NOW_MS;
    let up = true;
    const verify = createVerifier({
      fetchJwks: async () => { if (!up) throw new Error('down'); return { keys: [jwk] }; },
      now: () => now,
    });
    await expect(verify(token(privateKey, personClaims()))).resolves.toMatchObject({ ok: true });
    up = false;
    now += 2 * 60 * 60_000;
    await expect(verify(token(privateKey, personClaims({ exp: now / 1000 + 600 })))).resolves.toMatchObject({ ok: true });
  });

  it('reports an unavailable key set when it never loaded', async () => {
    const { privateKey } = keyPair();
    const verify = createVerifier({ fetchJwks: async () => { throw new Error('down'); }, now: () => NOW_MS });
    await expect(verify(token(privateKey, personClaims()))).resolves.toEqual({ ok: false, error: 'jwks_unavailable' });
  });

  it('falls back to the email local part when the username claim is absent', async () => {
    const { privateKey, jwk } = keyPair();
    const verify = createAdminJwtVerifier({ issuer: ISSUER, fetchJwks: async () => ({ keys: [jwk] }), now: () => NOW_MS });
    await expect(verify(token(privateKey, personClaims({ username: undefined })))).resolves.toMatchObject({
      ok: true,
      identity: { email: 'alice@example.com', username: 'alice' },
    });
  });
});

describe('admin JWT configuration', () => {
  it('needs an https key set and an issuer from the deployment', () => {
    expect(adminJwtOptionsFromEnv({ BOTMUX_ADMIN_JWKS_URL: 'https://sso.example.com/jwks' })).toBeUndefined();
    expect(adminJwtOptionsFromEnv({ BOTMUX_ADMIN_JWT_ISSUER: ISSUER })).toBeUndefined();
    expect(adminJwtOptionsFromEnv({ BOTMUX_ADMIN_JWKS_URL: 'http://sso.example.com/jwks', BOTMUX_ADMIN_JWT_ISSUER: ISSUER })).toBeUndefined();
    expect(adminJwtOptionsFromEnv({
      BOTMUX_ADMIN_JWKS_URL: 'https://sso.example.com/jwks',
      BOTMUX_ADMIN_JWT_ISSUER: ISSUER,
      BOTMUX_ADMIN_JWT_REQUIRED_CLAIMS: 'type=person, tenant = acme ',
      BOTMUX_ADMIN_JWT_USERNAME_CLAIM: 'username',
    })).toEqual({
      jwksUrl: 'https://sso.example.com/jwks',
      issuer: ISSUER,
      requiredClaims: { type: 'person', tenant: 'acme' },
      emailClaim: undefined,
      usernameClaim: 'username',
    });
  });

  it('parses required claims and ignores malformed pairs', () => {
    expect(parseRequiredClaims('a=1,,=x,b,c=d=e')).toEqual({ a: '1', c: 'd=e' });
    expect(parseRequiredClaims(undefined)).toEqual({});
  });
});
