import { randomBytes } from 'node:crypto';

/**
 * Private, per-spawn identity shared only between the fleet supervisor and the
 * Dashboard child. It lets the supervisor reuse the Dashboard's existing
 * `/__selfcheck` route without mistaking a stale Dashboard (or daemon IPC
 * server) for the exact child it just spawned.
 *
 * This is deliberately not part of the persisted daemon env allowlist: every
 * Dashboard generation receives a fresh value immediately before spawn.
 */
export const DASHBOARD_STARTUP_NONCE_ENV = 'BOTMUX_INTERNAL_DASHBOARD_STARTUP_NONCE';

const DASHBOARD_STARTUP_NONCE_PATTERN = /^[0-9a-f]{32}$/;

export function createDashboardStartupNonce(): string {
  return randomBytes(16).toString('hex');
}

export function dashboardStartupNonce(env: NodeJS.ProcessEnv): string | undefined {
  const nonce = env[DASHBOARD_STARTUP_NONCE_ENV]?.trim();
  return nonce && DASHBOARD_STARTUP_NONCE_PATTERN.test(nonce) ? nonce : undefined;
}

export function resolveDashboardSelfNonce(env: NodeJS.ProcessEnv): string {
  return dashboardStartupNonce(env) ?? createDashboardStartupNonce();
}
