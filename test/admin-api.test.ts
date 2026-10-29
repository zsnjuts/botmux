import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_API_PREFIX, adminApiEnabledFromEnv, handleAdminApi, type AdminApiDeps } from '../src/dashboard/admin-api.js';
import type { JwtVerifyResult } from '../src/dashboard/admin-jwt.js';
import {
  authorizeAdmin,
  createEmailOpenIdCache,
  parseAdminIdentity,
  parseConfigScope,
} from '../src/services/admin-api.js';

const APP = 'cli_aaaa1111bbbb2222';
const OTHER_APP = 'cli_cccc3333dddd4444';
const VALID: JwtVerifyResult = { ok: true, identity: { username: 'alice', email: 'alice@example.com', exp: 0 } };

interface DaemonCall { larkAppId: string; path: string; method: string; body?: unknown }

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function start(overrides: Partial<AdminApiDeps> & { daemon?: (call: DaemonCall) => { status: number; body: unknown } } = {}) {
  const calls: DaemonCall[] = [];
  const daemon = overrides.daemon ?? (() => ({ status: 200, body: { ok: true } }));
  const deps: AdminApiDeps = {
    enabled: () => true,
    verifyJwt: async () => VALID,
    onlineBots: () => [APP],
    callDaemon: async (larkAppId, path, init) => {
      const call: DaemonCall = {
        larkAppId,
        path,
        method: String(init.method ?? 'GET'),
        ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      };
      calls.push(call);
      const reply = daemon(call);
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    },
    ...overrides,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleAdminApi(req, res, url, deps);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ADMIN_API_PREFIX}`;
  const request = async (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token !== null) headers.set('x-jwt-token', init.token ?? 'header.payload.signature');
    const response = await fetch(`${base}${path}`, { ...init, headers });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { request, calls };
}

describe('admin API (dashboard layer)', () => {
  it('needs both the opt-in flag and a configured verifier from the deployment', () => {
    const verifier = { BOTMUX_ADMIN_JWKS_URL: 'https://keys.example/jwks', BOTMUX_ADMIN_JWT_ISSUER: 'https://sso.example' };
    expect(adminApiEnabledFromEnv({ BOTMUX_ADMIN_API: 'on' })).toBe(false);
    expect(adminApiEnabledFromEnv({ BOTMUX_ADMIN_API: 'on', BOTMUX_ADMIN_JWKS_URL: verifier.BOTMUX_ADMIN_JWKS_URL })).toBe(false);
    expect(adminApiEnabledFromEnv({ BOTMUX_ADMIN_API: 'on', ...verifier })).toBe(true);
    expect(adminApiEnabledFromEnv(verifier)).toBe(false);
  });

  it('is invisible until the deployment opts in', async () => {
    const { request, calls } = await start({ enabled: () => false });
    await expect(request('whoami')).resolves.toEqual({ status: 404, body: { ok: false, error: 'admin_api_disabled' } });
    expect(calls).toEqual([]);
  });

  it('requires a verified JWT before touching any daemon', async () => {
    const { request, calls } = await start({ verifyJwt: async () => ({ ok: false, error: 'jwt_expired' }) });
    await expect(request('whoami', { token: null })).resolves.toMatchObject({ status: 401, body: { error: 'jwt_required' } });
    await expect(request('whoami')).resolves.toMatchObject({ status: 401, body: { error: 'jwt_expired' } });
    expect(calls).toEqual([]);
  });

  it('accepts the token as a bearer credential too', async () => {
    const { request, calls } = await start();
    const response = await request('whoami', { token: null, headers: { authorization: 'Bearer a.b.c' } });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('forwards only the verified identity, never the token, with the config write', async () => {
    const { request, calls } = await start();
    await request('config/set', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'maxLiveWorkers', value: '4', identity: { email: 'mallory@example.com' } }),
    });
    expect(calls).toEqual([{
      larkAppId: APP,
      path: '/api/admin/v1/config-set',
      method: 'POST',
      body: { field: 'maxLiveWorkers', value: '4', identity: { email: 'alice@example.com', username: 'alice' } },
    }]);
    expect(JSON.stringify(calls)).not.toContain('header.payload.signature');
  });

  it('asks for the bot when several daemons are online and rejects unknown ones', async () => {
    const { request } = await start({ onlineBots: () => [APP, OTHER_APP] });
    await expect(request('config')).resolves.toMatchObject({ status: 400, body: { error: 'bot_required', bots: [APP, OTHER_APP] } });
    await expect(request(`config?bot=${OTHER_APP}`)).resolves.toMatchObject({ status: 200 });
    await expect(request('config?bot=cli_ffff0000ffff0000')).resolves.toMatchObject({ status: 503, body: { error: 'daemon_offline' } });
    await expect(request('config?bot=../etc')).resolves.toMatchObject({ status: 400, body: { error: 'invalid_bot' } });
  });

  it('gates session operations on the daemon admin decision', async () => {
    const { request, calls } = await start({
      daemon: call => call.path === '/api/admin/v1/whoami'
        ? { status: 403, body: { ok: false, error: 'not_admin' } }
        : { status: 200, body: { ok: true } },
    });
    await expect(request('sessions/s_1/close', { method: 'POST', body: '{}' })).resolves.toEqual({
      status: 403,
      body: { ok: false, error: 'not_admin' },
    });
    expect(calls.map(call => call.path)).toEqual(['/api/admin/v1/whoami']);
  });

  it('closes a session through the daemon host-control route for an admin', async () => {
    const { request, calls } = await start();
    await request('sessions/s_1/close', { method: 'POST', body: JSON.stringify({ rootId: 'om_root' }) });
    expect(calls.map(call => [call.path, call.body])).toEqual([
      ['/api/admin/v1/whoami', { identity: { email: 'alice@example.com', username: 'alice' } }],
      ['/api/sessions/s_1/close', { rootId: 'om_root' }],
    ]);
  });

  it('surfaces a close residual instead of a plain success', async () => {
    const { request } = await start({
      daemon: call => call.path.endsWith('/close')
        ? { status: 200, body: { ok: true, outcome: 'closed_with_residual', residual: { reason: 'remote_cancel_unconfirmed', taskId: 't-1' } } }
        : { status: 200, body: { ok: true } },
    });
    await expect(request('sessions/s_1/close', { method: 'POST', body: '{}' })).resolves.toMatchObject({
      status: 200,
      body: { outcome: 'closed_with_residual', residual: { reason: 'remote_cancel_unconfirmed', taskId: 't-1', scope: 'remote' } },
    });
  });

  it('rejects unknown routes and malformed session ids', async () => {
    const { request, calls } = await start();
    await expect(request('config/delete', { method: 'POST' })).resolves.toMatchObject({ status: 404 });
    await expect(request('sessions/a%2Fb')).resolves.toMatchObject({ status: 404 });
    expect(calls).toEqual([]);
  });
});

describe('admin API (daemon authorization)', () => {
  const bot = { larkAppId: APP, resolvedAllowedUsers: ['ou_admin'] };

  it('admits only identities that resolve to an allowedUsers member of this bot', async () => {
    const resolve = async (_app: string, email: string) => ({ 'alice@example.com': 'ou_admin', 'bob@example.com': 'ou_bob' } as Record<string, string>)[email];
    await expect(authorizeAdmin(bot, { email: 'alice@example.com' }, resolve)).resolves.toEqual({ ok: true, openId: 'ou_admin' });
    await expect(authorizeAdmin(bot, { email: 'bob@example.com' }, resolve)).resolves.toMatchObject({ ok: false, status: 403, error: 'not_admin' });
    await expect(authorizeAdmin(bot, { email: 'eve@example.com' }, resolve)).resolves.toMatchObject({ ok: false, error: 'identity_unresolved' });
    await expect(authorizeAdmin({ ...bot, resolvedAllowedUsers: [] }, { email: 'alice@example.com' }, resolve))
      .resolves.toMatchObject({ ok: false, error: 'no_admins' });
    await expect(authorizeAdmin(bot, undefined, resolve)).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it('validates the forwarded identity shape', () => {
    expect(parseAdminIdentity({ email: 'Alice@Example.com', username: 'alice' })).toEqual({ email: 'alice@example.com', username: 'alice' });
    expect(parseAdminIdentity({ email: 'not-an-email' })).toBeUndefined();
    expect(parseAdminIdentity('alice@example.com')).toBeUndefined();
  });

  it('caches the email → open_id mapping but retries misses sooner', async () => {
    let now = 0;
    let lookups = 0;
    let answer: string | undefined;
    const cached = createEmailOpenIdCache(async () => { lookups += 1; return answer; }, () => now);
    await cached(APP, 'a@example.com');
    now += 30_000;
    await cached(APP, 'a@example.com');
    expect(lookups).toBe(1);
    now += 31_000;
    answer = 'ou_a';
    await expect(cached(APP, 'a@example.com')).resolves.toBe('ou_a');
    now += 5 * 60_000;
    await cached(APP, 'a@example.com');
    expect(lookups).toBe(2);
    await cached(OTHER_APP, 'a@example.com');
    expect(lookups).toBe(3);
  });

  it('accepts only the known durable config scopes', () => {
    expect(parseConfigScope(undefined)).toBe('bots');
    expect(parseConfigScope('global')).toBe('global');
    expect(parseConfigScope('../bots')).toBeUndefined();
  });
});
