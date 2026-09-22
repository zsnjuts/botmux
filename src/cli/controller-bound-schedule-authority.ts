import { loopbackFetchImpl } from '../core/loopback-fetch.js';
import {
  CONTROLLER_BOUND_SCHEDULE_AUTHORITY_ROUTE,
  CONTROLLER_BOUND_SCHEDULE_AUTHORITY_SCHEMA,
  type ControllerBoundScheduleAuthorityDocument,
} from '../core/controller-bound-schedule-authority.js';

export class ControllerBoundScheduleAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControllerBoundScheduleAuthorityError';
  }
}

function validDocument(value: unknown): value is ControllerBoundScheduleAuthorityDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  if (document.schema !== CONTROLLER_BOUND_SCHEDULE_AUTHORITY_SCHEMA
    || document.status !== 'verified'
    || !document.authority || typeof document.authority !== 'object'
    || Array.isArray(document.authority)) return false;
  const authority = document.authority as Record<string, unknown>;
  return Object.keys(authority).length === 7
    && typeof authority.sessionId === 'string' && authority.sessionId.length > 0
    && typeof authority.turnId === 'string' && authority.turnId.startsWith('om_')
    && typeof authority.workerGeneration === 'number'
    && Number.isSafeInteger(authority.workerGeneration) && authority.workerGeneration > 0
    && typeof authority.larkAppId === 'string' && authority.larkAppId.length > 0
    && typeof authority.callerOpenId === 'string' && /^ou_[A-Za-z0-9]+$/.test(authority.callerOpenId)
    && typeof authority.controllerOpenId === 'string' && /^ou_[A-Za-z0-9]+$/.test(authority.controllerOpenId)
    && typeof authority.controllerUnionId === 'string' && /^on_[A-Za-z0-9]+$/.test(authority.controllerUnionId);
}

/** Ask the owning daemon to bind this exact live tool process and turn to its
 * frozen interactive caller + stable session controller authority tuple. */
export async function resolveControllerBoundScheduleAuthority(input: {
  ipcPort: number;
  sessionId: string;
  fetchImpl?: typeof fetch;
}): Promise<ControllerBoundScheduleAuthorityDocument> {
  if (!Number.isSafeInteger(input.ipcPort) || input.ipcPort <= 0 || input.ipcPort > 65_535
    || !input.sessionId || input.sessionId.length > 256) {
    throw new ControllerBoundScheduleAuthorityError(
      'controller-bound child schedule context is unavailable',
    );
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? loopbackFetchImpl)(
      `http://127.0.0.1:${input.ipcPort}${CONTROLLER_BOUND_SCHEDULE_AUTHORITY_ROUTE}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: input.sessionId }),
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch (error) {
    throw new ControllerBoundScheduleAuthorityError(
      `owning BotMux daemon is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch {
    throw new ControllerBoundScheduleAuthorityError(
      'owning BotMux daemon returned an invalid controller-bound schedule response',
    );
  }
  if (!response.ok || !validDocument(payload)) {
    throw new ControllerBoundScheduleAuthorityError(
      'controller-bound child schedule authority could not be verified by the owning daemon',
    );
  }
  return payload;
}
