import { describe, expect, it } from 'vitest';

import {
  resolveControllerBoundScheduleAuthorityFromAttestedTurn,
} from '../src/core/controller-bound-schedule-authority.js';

const caller = {
  requestUserOpenId: 'ou_caller',
  requestUserUnionId: 'on_caller',
  requestLarkAppId: 'cli_app',
  senderType: 'user' as const,
};
const controller = {
  requestUserOpenId: 'ou_controller',
  requestUserUnionId: 'on_controller',
  requestLarkAppId: 'cli_app',
  senderType: 'user' as const,
};

function session(): any {
  return {
    session: {
      sessionId: 'session-1',
      status: 'active',
      workerGeneration: 7,
      ownerOpenId: controller.requestUserOpenId,
      ownerUnionId: controller.requestUserUnionId,
    },
    larkAppId: 'cli_app',
    workerGeneration: 7,
    ownerOpenId: controller.requestUserOpenId,
    activeInteractiveTurn: {
      turnId: 'om_current',
      caller: { ...caller },
      controller: { ...controller },
    },
  };
}

function resolve(ds = session(), overrides: Record<string, unknown> = {}) {
  return resolveControllerBoundScheduleAuthorityFromAttestedTurn({
    ds,
    turnId: 'om_current',
    generation: 7,
    callerOpenId: caller.requestUserOpenId,
    ...overrides,
  });
}

describe('controller-bound child schedule authority', () => {
  it('binds an exact interactive caller to the stable session controller', () => {
    expect(resolve()).toEqual({
      ok: true,
      document: {
        schema: 'botmux.controller-bound-schedule-authority.v1',
        status: 'verified',
        authority: {
          sessionId: 'session-1',
          turnId: 'om_current',
          workerGeneration: 7,
          larkAppId: 'cli_app',
          callerOpenId: 'ou_caller',
          controllerOpenId: 'ou_controller',
          controllerUnionId: 'on_controller',
        },
      },
    });
  });

  it.each([
    ['forged caller', (ds: any) => undefined, { callerOpenId: 'ou_other' }],
    ['stale turn', (ds: any) => undefined, { turnId: 'om_stale' }],
    ['generation drift', (ds: any) => { ds.session.workerGeneration = 8; }, {}],
    ['ownerless session', (ds: any) => { delete ds.ownerOpenId; delete ds.session.ownerOpenId; }, {}],
    ['owner without union id', (ds: any) => { delete ds.session.ownerUnionId; }, {}],
    ['cross-app caller', (ds: any) => { ds.activeInteractiveTurn.caller.requestLarkAppId = 'cli_other'; }, {}],
    ['controller differs from stable owner', (ds: any) => { ds.activeInteractiveTurn.controller.requestUserOpenId = 'ou_other'; }, {}],
    ['scheduled caller', (ds: any) => { ds.activeInteractiveTurn.caller.source = 'schedule_creator'; ds.activeInteractiveTurn.caller.taskId = 'abcdef12'; }, {}],
  ])('rejects %s', (_label, mutate, overrides) => {
    const ds = session();
    mutate(ds);
    expect(resolve(ds, overrides)).toEqual({
      ok: false,
      error: 'controller_bound_schedule_authority_unverified',
    });
  });
});
