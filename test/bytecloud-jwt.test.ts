import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BYTECLOUD_JWT_ISSUER, createByteCloudJwtVerifier } from '../src/dashboard/bytecloud-jwt.js';

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
    iss: BYTECLOUD_JWT_ISSUER,
    type: 'person_account',
    username: 'alice',
    email: 'Alice@Example.com',
    iat: NOW_S - 60,
    exp: NOW_S + 3600,
    ...overrides,
  };
}

describe('ByteCloud JWT verifier', () => {
  it('accepts a person token signed by the published key and normalizes the email', async () => {
    const { privateKey, jwk } = keyPair();
    const verify = createByteCloudJwtVerifier({ fetchJwks: async () => ({ keys: [jwk] }), now: () => NOW_MS });
    await expect(verify(token(privateKey, personClaims()))).resolves.toEqual({
      ok: true,
      identity: { username: 'alice', email: 'alice@example.com', exp: NOW_S + 3600 },
    });
  });

  it.each([
    ['expired', personClaims({ exp: NOW_S - 3600 }), 'jwt_expired'],
    ['issued in the future', personClaims({ iat: NOW_S + 3600 }), 'jwt_not_yet_valid'],
    ['foreign issuer', personClaims({ iss: 'someone.else' }), 'jwt_bad_issuer'],
    ['service account', personClaims({ type: 'service_account' }), 'jwt_not_person'],
    ['no email', personClaims({ email: undefined }), 'jwt_missing_identity'],
  ])('rejects a %s token', async (_label, claims, error) => {
    const { privateKey, jwk } = keyPair();
    const verify = createByteCloudJwtVerifier({ fetchJwks: async () => ({ keys: [jwk] }), now: () => NOW_MS });
    await expect(verify(token(privateKey, claims))).resolves.toEqual({ ok: false, error });
  });

  it('rejects tokens signed by another key and unsigned algorithms', async () => {
    const published = keyPair();
    const attacker = keyPair();
    const verify = createByteCloudJwtVerifier({ fetchJwks: async () => ({ keys: [published.jwk] }), now: () => NOW_MS });
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
    const verify = createByteCloudJwtVerifier({
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
    const verify = createByteCloudJwtVerifier({
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
    const verify = createByteCloudJwtVerifier({ fetchJwks: async () => { throw new Error('down'); }, now: () => NOW_MS });
    await expect(verify(token(privateKey, personClaims()))).resolves.toEqual({ ok: false, error: 'jwks_unavailable' });
  });
});
