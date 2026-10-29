/**
 * Daemon side of the person-authenticated admin API (`infrabuddy`).
 *
 * The Dashboard verifies the caller's ByteCloud JWT and forwards only the
 * verified corporate email over the trusted-host IPC. Everything here re-derives
 * the authority from this bot's own state: the email is resolved to an open_id
 * with this bot's Lark app (open_id is app-scoped) and must be in the bot's
 * resolved `allowedUsers` — the same rule `/botconfig` applies in IM.
 *
 * Writes reuse the `/botconfig` store functions, so validation, the
 * self-lockout guard and the durable config CAS are identical; they only add
 * the actor attribution recorded in the CAS audit.
 */
import {
  applyConfigField,
  coerceConfigValue,
  findConfigField,
  getConfigSnapshot,
  setBotAllowedUsers,
  settableFieldKeys,
  type ConfigSnapshotRow,
} from './bot-config-store.js';
import {
  inspectDurableConfig,
  inspectDurableConfigHistory,
  withConfigActor,
} from './durable-config-mutation.js';
import {
  DURABLE_CONFIG_SCOPES,
  type DurableConfigHistory,
  type DurableConfigInspection,
  type DurableConfigScope,
} from './durable-config-coordinator.js';

export const ADMIN_ACTOR_VIA = 'infrabuddy';

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 60_000;

export interface AdminIdentity {
  email: string;
  username?: string;
}

export type AdminAuthz =
  | { ok: true; openId: string }
  | { ok: false; status: number; error: 'invalid_identity' | 'no_admins' | 'identity_unresolved' | 'not_admin' };

export interface AdminBotView {
  larkAppId: string;
  resolvedAllowedUsers: readonly string[];
}

export type ResolveEmailOpenId = (larkAppId: string, email: string) => Promise<string | undefined>;

export function parseAdminIdentity(raw: unknown): AdminIdentity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { email, username } = raw as Record<string, unknown>;
  if (typeof email !== 'string' || !EMAIL.test(email)) return undefined;
  return {
    email: email.toLowerCase(),
    ...(typeof username === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(username) ? { username } : {}),
  };
}

/**
 * email → open_id for this bot's app, cached briefly. Only the identity mapping
 * is cached; admin membership is re-checked against live config on every call,
 * so removing someone from `allowedUsers` takes effect immediately.
 */
export function createEmailOpenIdCache(resolve: ResolveEmailOpenId, now: () => number = Date.now): ResolveEmailOpenId {
  const cache = new Map<string, { openId?: string; until: number }>();
  return async (larkAppId, email) => {
    const key = `${larkAppId}\u0000${email}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.openId;
    const openId = await resolve(larkAppId, email);
    cache.set(key, { openId, until: now() + (openId ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return openId;
  };
}

export async function authorizeAdmin(
  bot: AdminBotView,
  identity: AdminIdentity | undefined,
  resolveOpenId: ResolveEmailOpenId,
): Promise<AdminAuthz> {
  if (!identity) return { ok: false, status: 400, error: 'invalid_identity' };
  if (bot.resolvedAllowedUsers.length === 0) return { ok: false, status: 403, error: 'no_admins' };
  const openId = await resolveOpenId(bot.larkAppId, identity.email);
  if (!openId) return { ok: false, status: 403, error: 'identity_unresolved' };
  if (!bot.resolvedAllowedUsers.includes(openId)) return { ok: false, status: 403, error: 'not_admin' };
  return { ok: true, openId };
}

export function adminConfigSnapshot(larkAppId: string):
  | { ok: true; rows: ConfigSnapshotRow[]; info: Record<string, unknown> }
  | { ok: false; error: string } {
  const snapshot = getConfigSnapshot(larkAppId);
  return snapshot.ok ? { ok: true, rows: snapshot.rows, info: snapshot.info } : { ok: false, error: 'bot_not_registered' };
}

export type AdminConfigWriteResult =
  | { ok: true; field: string; old?: string; new?: string; effect?: string; resolved?: number; warnings?: Record<string, unknown> }
  | { ok: false; status: number; error: string; detail?: unknown };

/**
 * `value` uses the same text forms as `/botconfig set` (JSON fields as JSON
 * text); `allowedUsers` takes the complete replacement list and requires
 * `confirm`, exactly like the IM command.
 */
export async function adminConfigSet(input: {
  larkAppId: string;
  actorOpenId: string;
  identity: AdminIdentity;
  field: unknown;
  value: unknown;
  confirm: unknown;
}): Promise<AdminConfigWriteResult> {
  if (typeof input.field !== 'string') return { ok: false, status: 400, error: 'field_required' };
  const spec = findConfigField(input.field);
  if (!spec) return { ok: false, status: 400, error: 'unknown_field', detail: settableFieldKeys() };
  const actor = { via: ADMIN_ACTOR_VIA, id: input.identity.email };

  if (spec.kind === 'allowedUsers') {
    if (!Array.isArray(input.value) || input.value.length === 0
        || input.value.some(entry => typeof entry !== 'string' || !entry.trim())) {
      return { ok: false, status: 400, error: 'allowed_users_list_required' };
    }
    if (input.confirm !== true) return { ok: false, status: 409, error: 'confirm_required' };
    const entries = [...new Set((input.value as string[]).map(entry => entry.trim()))];
    const result = await withConfigActor(actor, () =>
      setBotAllowedUsers(input.larkAppId, entries, input.actorOpenId));
    if (!result.ok) {
      const { ok: _ok, reason, ...detail } = result as { ok: false; reason: string } & Record<string, unknown>;
      return { ok: false, status: reason === 'bot_not_registered' ? 404 : 409, error: reason, detail };
    }
    const { ok: _ok, raw: _raw, resolved, ...warnings } = result;
    return {
      ok: true,
      field: spec.key,
      resolved: resolved.length,
      ...(Object.keys(warnings).length ? { warnings } : {}),
    };
  }

  if (typeof input.value !== 'string' || !input.value.trim()) {
    return { ok: false, status: 400, error: 'value_required' };
  }
  const coerced = coerceConfigValue(spec, input.value);
  if (!coerced.ok) return { ok: false, status: 400, error: coerced.reason };
  const applied = await withConfigActor(actor, () => applyConfigField(input.larkAppId, spec, coerced.value));
  if (!applied.ok) return { ok: false, status: 409, error: applied.reason };
  return { ok: true, field: spec.key, old: applied.oldText, new: applied.newText, effect: applied.effect };
}

export async function adminConfigUnset(input: {
  larkAppId: string;
  identity: AdminIdentity;
  field: unknown;
}): Promise<AdminConfigWriteResult> {
  if (typeof input.field !== 'string') return { ok: false, status: 400, error: 'field_required' };
  const spec = findConfigField(input.field);
  if (!spec) return { ok: false, status: 400, error: 'unknown_field', detail: settableFieldKeys() };
  if (!spec.clearable) return { ok: false, status: 400, error: 'not_clearable' };
  const applied = await withConfigActor(
    { via: ADMIN_ACTOR_VIA, id: input.identity.email },
    () => applyConfigField(input.larkAppId, spec, null),
  );
  if (!applied.ok) return { ok: false, status: 409, error: applied.reason };
  return { ok: true, field: spec.key, old: applied.oldText, effect: applied.effect };
}

export function parseConfigScope(raw: unknown): DurableConfigScope | undefined {
  const scope = raw === undefined || raw === null || raw === '' ? 'bots' : raw;
  return (DURABLE_CONFIG_SCOPES as readonly unknown[]).includes(scope) ? scope as DurableConfigScope : undefined;
}

export async function adminConfigCas(scope: DurableConfigScope, path: string): Promise<{
  inspection: DurableConfigInspection;
  history: DurableConfigHistory;
}> {
  const [inspection, history] = await Promise.all([
    inspectDurableConfig({ scope, path }),
    inspectDurableConfigHistory({ scope }),
  ]);
  return { inspection, history };
}
