import { describe, expect, it, vi } from 'vitest';

import {
  ControllerBoundScheduleAuthorityError,
  resolveControllerBoundScheduleAuthority,
} from '../src/cli/controller-bound-schedule-authority.js';

const authority = {
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
};

describe('controller-bound child schedule authority client', () => {
  it('accepts only the exact daemon document shape', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(authority), { status: 200 }));
    await expect(resolveControllerBoundScheduleAuthority({
      ipcPort: 7951, sessionId: 'session-1', fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual(authority);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:7951/api/controller-bound-schedule-authority',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it.each([
    ['extra authority field', { ...authority, authority: { ...authority.authority, nominatedOwner: 'ou_other' } }],
    ['missing generation', { ...authority, authority: { ...authority.authority, workerGeneration: undefined } }],
    ['scheduled turn', { ...authority, authority: { ...authority.authority, turnId: 'schedule:abcdef12:id' } }],
    ['invalid controller union id', { ...authority, authority: { ...authority.authority, controllerUnionId: 'ou_wrong' } }],
  ])('rejects %s', async (_label, payload) => {
    await expect(resolveControllerBoundScheduleAuthority({
      ipcPort: 7951,
      sessionId: 'session-1',
      fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    })).rejects.toBeInstanceOf(ControllerBoundScheduleAuthorityError);
  });
});
