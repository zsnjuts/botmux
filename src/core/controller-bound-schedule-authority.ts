import type { TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';
import { sameTrustedPrincipal } from './active-turn-authority.js';
import {
  attestCurrentTurnLoopbackPeer,
  type CurrentTurnPeerAttestationInput,
} from './current-actor-attestation.js';
import { trustedSessionController } from './trusted-session-controller.js';

export const CONTROLLER_BOUND_SCHEDULE_AUTHORITY_SCHEMA =
  'botmux.controller-bound-schedule-authority.v1' as const;
export const CONTROLLER_BOUND_SCHEDULE_AUTHORITY_ROUTE =
  '/api/controller-bound-schedule-authority';

export interface ControllerBoundScheduleAuthorityDocument {
  schema: typeof CONTROLLER_BOUND_SCHEDULE_AUTHORITY_SCHEMA;
  status: 'verified';
  authority: {
    sessionId: string;
    turnId: string;
    workerGeneration: number;
    larkAppId: string;
    callerOpenId: string;
    controllerOpenId: string;
    controllerUnionId: string;
  };
}

export type ControllerBoundScheduleAuthorityResult =
  | { ok: true; document: ControllerBoundScheduleAuthorityDocument }
  | { ok: false; error: 'controller_bound_schedule_authority_unverified' };

function ordinaryHuman(principal: TrustedCaller | undefined, larkAppId: string): boolean {
  return !!principal
    && principal.senderType === 'user'
    && principal.source === undefined
    && principal.taskId === undefined
    && principal.requestLarkAppId === larkAppId;
}

export function resolveControllerBoundScheduleAuthorityFromAttestedTurn(input: {
  ds: DaemonSession;
  turnId: string;
  generation: number;
  callerOpenId: string;
}): ControllerBoundScheduleAuthorityResult {
  const { ds } = input;
  if (!input.turnId.startsWith('om_')
    || !Number.isSafeInteger(input.generation)
    || input.generation <= 0) {
    return { ok: false, error: 'controller_bound_schedule_authority_unverified' };
  }
  const active = ds.activeInteractiveTurn;
  const stableController = trustedSessionController(ds);
  const liveCaller: TrustedCaller = {
    requestUserOpenId: input.callerOpenId,
    requestLarkAppId: ds.larkAppId,
    senderType: 'user',
  };
  if (!active
    || active.turnId !== input.turnId
    || ds.workerGeneration !== input.generation
    || ds.session.workerGeneration !== input.generation
    || !ordinaryHuman(active.caller, ds.larkAppId)
    || !ordinaryHuman(active.controller, ds.larkAppId)
    || !ordinaryHuman(stableController, ds.larkAppId)
    || !sameTrustedPrincipal(active.caller, liveCaller)
    || !sameTrustedPrincipal(active.controller, stableController)
    || active.controller?.requestUserOpenId !== stableController?.requestUserOpenId
    || active.controller?.requestUserUnionId !== stableController?.requestUserUnionId
    || !stableController?.requestUserOpenId?.startsWith('ou_')
    || !stableController.requestUserUnionId?.startsWith('on_')) {
    return { ok: false, error: 'controller_bound_schedule_authority_unverified' };
  }
  return {
    ok: true,
    document: {
      schema: CONTROLLER_BOUND_SCHEDULE_AUTHORITY_SCHEMA,
      status: 'verified',
      authority: {
        sessionId: ds.session.sessionId,
        turnId: input.turnId,
        workerGeneration: input.generation,
        larkAppId: ds.larkAppId,
        callerOpenId: input.callerOpenId,
        controllerOpenId: stableController.requestUserOpenId,
        controllerUnionId: stableController.requestUserUnionId,
      },
    },
  };
}

/**
 * Resolve the one narrow authority needed by an interactive worker that must
 * create a child schedule owned by the stable session controller. The current
 * human caller authorizes the operation; they never become the scheduled task
 * owner and cannot nominate an owner.
 */
export function resolveDaemonControllerBoundScheduleAuthority(
  input: CurrentTurnPeerAttestationInput,
): ControllerBoundScheduleAuthorityResult {
  const frozen = attestCurrentTurnLoopbackPeer(input);
  if (!frozen) {
    return { ok: false, error: 'controller_bound_schedule_authority_unverified' };
  }
  return resolveControllerBoundScheduleAuthorityFromAttestedTurn({
    ds: frozen.ds,
    turnId: frozen.turnId,
    generation: frozen.generation,
    callerOpenId: frozen.callerOpenId,
  });
}
