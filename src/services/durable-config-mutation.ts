import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  DurableConfigCoordinator,
  DurableConfigInspection,
  DurableConfigScope,
} from './durable-config-coordinator.js';

let coordinator: DurableConfigCoordinator | undefined;
const activeScope = new AsyncLocalStorage<DurableConfigScope>();

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

export function reconcileDurableConfig(input: {
  scope: DurableConfigScope;
  path: string;
  expectedCommittedSha256: string;
  expectedFileSha256: string;
}): Promise<DurableConfigInspection> {
  return requireCoordinator().reconcile(input);
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
  return activeScope.run(input.scope, () => coordinator!.run(input));
}

export function assertDurableConfigMutationAllowed(scope: DurableConfigScope): void {
  if (process.env.BOTMUX_COORDINATION_MODE?.trim() === 'primary'
      && activeScope.getStore() !== scope) {
    throw new Error('durable_config_coordinator_required');
  }
}
