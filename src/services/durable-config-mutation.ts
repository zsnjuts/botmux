import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ConfigActor,
  DurableConfigCoordinator,
  DurableConfigHistory,
  DurableConfigInspection,
  DurableConfigScope,
} from './durable-config-coordinator.js';

let coordinator: DurableConfigCoordinator | undefined;
const activeScope = new AsyncLocalStorage<DurableConfigScope>();
const activeActor = new AsyncLocalStorage<ConfigActor>();

/**
 * Attribute every durable config write made inside `fn` to a person.
 *
 * The actor is folded into the audit `writerId` (see the coordinator), so the
 * attribution survives daemons of older versions that re-append the audit
 * ring without knowing about it.
 */
export function withConfigActor<T>(actor: ConfigActor | undefined, fn: () => T): T {
  return actor ? activeActor.run(actor, fn) : fn();
}

export function setDurableConfigCoordinator(next: DurableConfigCoordinator | undefined): void {
  coordinator = next;
}

function requireCoordinator(): DurableConfigCoordinator {
  if (!coordinator) throw new Error('durable_config_coordinator_unavailable');
  return coordinator;
}

export function inspectDurableConfig(input: {
  scope: DurableConfigScope;
  path: string;
}): Promise<DurableConfigInspection> {
  return requireCoordinator().inspect(input);
}

export function inspectDurableConfigHistory(input: {
  scope: DurableConfigScope;
}): Promise<DurableConfigHistory> {
  return requireCoordinator().history(input);
}

export function reconcileDurableConfig(input: {
  scope: DurableConfigScope;
  path: string;
  expectedCommittedSha256: string;
  expectedFileSha256: string;
}): Promise<DurableConfigInspection> {
  return requireCoordinator().reconcile({ ...input, actor: activeActor.getStore() });
}

export function rebindDurableConfigPath(input: {
  scope: DurableConfigScope;
  path: string;
  expectedRecordRevision: number;
  expectedBoundPathSha256: string;
  expectedCurrentPathSha256: string;
  expectedCommittedSha256: string;
  expectedFileSha256: string;
}): Promise<DurableConfigInspection> {
  return requireCoordinator().rebindPath(input);
}

export function rebindAndReconcileDurableConfig(input: {
  scope: DurableConfigScope;
  path: string;
  expectedRecordRevision: number;
  expectedBoundPathSha256: string;
  expectedCurrentPathSha256: string;
  expectedCommittedSha256: string;
  expectedFileSha256: string;
}): Promise<DurableConfigInspection> {
  return requireCoordinator().rebindPath({ ...input, reconcileContent: true });
}

export async function runDurableConfigMutation<T>(input: {
  scope: DurableConfigScope;
  path: string;
  mutation: () => Promise<T>;
}): Promise<T> {
  if (!coordinator) {
    if (process.env.BOTMUX_COORDINATION_MODE?.trim() === 'primary') {
      throw new Error('durable_config_coordinator_unavailable');
    }
    return input.mutation();
  }
  const actor = activeActor.getStore();
  return activeScope.run(input.scope, () => coordinator!.run({ ...input, actor }));
}

export function assertDurableConfigMutationAllowed(scope: DurableConfigScope): void {
  if (process.env.BOTMUX_COORDINATION_MODE?.trim() === 'primary'
      && activeScope.getStore() !== scope) {
    throw new Error('durable_config_coordinator_required');
  }
}
