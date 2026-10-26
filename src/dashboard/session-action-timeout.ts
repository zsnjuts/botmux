export type DashboardSessionAction = 'close' | 'locate' | 'resume' | 'restart' | 'start';

const DEFAULT_SESSION_ACTION_TIMEOUT_MS = 15_000;
// Durable lifecycle actions may wait for the remote runtime to reach its
// committed state before the daemon replies. Close can spend up to 23s
// preparing remote cancellation before commit and has a separate 29s SIGKILL
// backstop; resume may wait for a paused runtime to become ready. Keep the
// dashboard proxy above both bounds so it does not report a 504 while the
// lifecycle transition continues successfully in the background.
const DURABLE_SESSION_ACTION_TIMEOUT_MS = 60_000;

export function dashboardSessionActionTimeoutMs(action: DashboardSessionAction): number {
  return action === 'close' || action === 'resume'
    ? DURABLE_SESSION_ACTION_TIMEOUT_MS
    : DEFAULT_SESSION_ACTION_TIMEOUT_MS;
}
