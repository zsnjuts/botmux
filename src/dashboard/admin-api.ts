/**
 * Public, person-authenticated admin API used by the `infrabuddy` CLI.
 *
 * Mounted ahead of the Dashboard token gate under `/api/admin/v1/`. The caller
 * presents a ByteCloud JWT (`X-Jwt-Token`); this layer verifies it and forwards
 * only the verified identity to the owning daemon over the trusted-host IPC,
 * where admin membership (`allowedUsers`) is decided. Off unless
 * `BOTMUX_ADMIN_API=on` and `BOTMUX_ADMIN_JWKS_URL` names the ByteCloud key
 * set, so deployments opt in explicitly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeResidualIsLocal, parseCloseResidual } from '../core/close-residual.js';
import type { ByteCloudIdentity, JwtVerifyResult } from './bytecloud-jwt.js';

export const ADMIN_API_PREFIX = '/api/admin/v1/';

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const APP_ID = /^cli_[A-Za-z0-9]{4,64}$/;

export interface AdminApiDeps {
  enabled: () => boolean;
  verifyJwt: (token: string) => Promise<JwtVerifyResult>;
  /** larkAppIds of the daemons currently registered with this Dashboard. */
  onlineBots: () => string[];
  callDaemon: (larkAppId: string, path: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}

export function adminApiEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|true|yes)$/i.test(env.BOTMUX_ADMIN_API?.trim() ?? '')
    && /^https:\/\/\S+$/.test(env.BOTMUX_ADMIN_JWKS_URL?.trim() ?? '');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function presentedToken(req: IncomingMessage): string | undefined {
  const header = req.headers['x-jwt-token'];
  const direct = Array.isArray(header) ? header[0] : header;
  if (direct?.trim()) return direct.trim();
  const auth = req.headers.authorization;
  const bearer = auth?.match(/^Bearer\s+(\S+)$/i);
  return bearer?.[1];
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function relay(res: ServerResponse, response: Response): Promise<void> {
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { ok: false, error: 'daemon_bad_response' }; }
  send(res, response.status, body);
}

type Route =
  | { kind: 'op'; op: 'whoami' | 'config-get' | 'config-set' | 'config-unset' | 'config-cas'; method: 'GET' | 'POST' }
  | { kind: 'sessions'; method: 'GET' }
  | { kind: 'session'; method: 'GET'; sessionId: string }
  | { kind: 'session-close'; method: 'POST'; sessionId: string };

function matchRoute(method: string, tail: string): Route | undefined {
  if (method === 'GET' && tail === 'whoami') return { kind: 'op', op: 'whoami', method };
  if (method === 'GET' && tail === 'config') return { kind: 'op', op: 'config-get', method };
  if (method === 'POST' && tail === 'config/set') return { kind: 'op', op: 'config-set', method };
  if (method === 'POST' && tail === 'config/unset') return { kind: 'op', op: 'config-unset', method };
  if (method === 'GET' && tail === 'config/cas') return { kind: 'op', op: 'config-cas', method };
  if (method === 'GET' && tail === 'sessions') return { kind: 'sessions', method };
  const session = tail.match(/^sessions\/([^/]+)(\/close)?$/);
  if (session && SESSION_ID.test(session[1])) {
    if (method === 'GET' && !session[2]) return { kind: 'session', method, sessionId: session[1] };
    if (method === 'POST' && session[2]) return { kind: 'session-close', method, sessionId: session[1] };
  }
  return undefined;
}

function pickBot(url: URL, online: string[]): { ok: true; larkAppId: string } | { ok: false; status: number; error: string; bots?: string[] } {
  const requested = url.searchParams.get('bot');
  if (requested) {
    if (!APP_ID.test(requested)) return { ok: false, status: 400, error: 'invalid_bot' };
    return online.includes(requested)
      ? { ok: true, larkAppId: requested }
      : { ok: false, status: 503, error: 'daemon_offline' };
  }
  if (online.length === 1) return { ok: true, larkAppId: online[0] };
  if (online.length === 0) return { ok: false, status: 503, error: 'daemon_offline' };
  return { ok: false, status: 400, error: 'bot_required', bots: online };
}

function identityBody(identity: ByteCloudIdentity): { email: string; username: string } {
  return { email: identity.email, username: identity.username };
}

/** Handles every request under {@link ADMIN_API_PREFIX}; never falls through to the Dashboard auth gate. */
export async function handleAdminApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: AdminApiDeps): Promise<void> {
  if (!deps.enabled()) return send(res, 404, { ok: false, error: 'admin_api_disabled' });
  const method = (req.method ?? 'GET').toUpperCase();
  const route = matchRoute(method, url.pathname.slice(ADMIN_API_PREFIX.length));
  if (!route) return send(res, 404, { ok: false, error: 'unknown_admin_route' });

  const token = presentedToken(req);
  if (!token) return send(res, 401, { ok: false, error: 'jwt_required' });
  const verified = await deps.verifyJwt(token);
  if (!verified.ok) return send(res, verified.error === 'jwks_unavailable' ? 503 : 401, { ok: false, error: verified.error });
  const identity = identityBody(verified.identity);

  const target = pickBot(url, deps.onlineBots());
  if (!target.ok) {
    const { ok: _ok, status, ...rest } = target;
    return send(res, status, { ok: false, ...rest });
  }

  const body = method === 'POST' ? await readBody(req) : {};
  if (!body) return send(res, 400, { ok: false, error: 'bad_json' });

  const callOp = (op: string, extra: Record<string, unknown>) => deps.callDaemon(target.larkAppId, `/api/admin/v1/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...extra, identity }),
  });

  if (route.kind === 'op') {
    const extra: Record<string, unknown> = route.op === 'config-cas'
      ? { scope: url.searchParams.get('scope') ?? 'bots' }
      : route.op === 'config-set' || route.op === 'config-unset'
        ? { field: body.field, value: body.value, confirm: body.confirm }
        : {};
    deps.log?.(`[admin-api] ${route.op} bot=${target.larkAppId} by=${identity.email}`);
    return relay(res, await callOp(route.op, extra));
  }

  // Session routes reuse the daemon's existing host-control endpoints, gated
  // by the same admin decision the config ops get.
  const authz = await callOp('whoami', {});
  if (!authz.ok) return relay(res, authz);
  await authz.text();
  deps.log?.(`[admin-api] ${route.kind}${'sessionId' in route ? ` ${route.sessionId}` : ''} bot=${target.larkAppId} by=${identity.email}`);
  if (route.kind === 'sessions') {
    return relay(res, await deps.callDaemon(target.larkAppId, '/api/sessions', { method: 'GET' }));
  }
  if (route.kind === 'session') {
    return relay(res, await deps.callDaemon(target.larkAppId, `/api/sessions/${route.sessionId}`, { method: 'GET' }));
  }
  const closed = await deps.callDaemon(target.larkAppId, `/api/sessions/${route.sessionId}/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(typeof body.rootId === 'string' ? { rootId: body.rootId } : {}),
  });
  const text = await closed.text();
  let result: Record<string, unknown>;
  try { result = JSON.parse(text); } catch { return send(res, closed.status, { ok: false, error: 'daemon_bad_response' }); }
  // A closed row with a residual is not a plain success: say what is left and
  // where (a local subtree vs a remote session need opposite follow-ups).
  const residual = parseCloseResidual(result);
  return send(res, closed.status, residual
    ? { ...result, residual: { ...residual, scope: closeResidualIsLocal(residual) ? 'local' : 'remote' } }
    : result);
}
