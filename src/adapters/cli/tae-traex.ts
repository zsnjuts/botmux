import { resolveCommand } from './registry.js';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { writeRunnerInput } from './runner-input.js';
import type { CliAdapter, PtyHandle, WriteInputContext } from './types.js';
import type { TrustedCaller } from '../../types.js';

export const TAE_TRAEX_RUNNER_MARKER = '::botmux-tae-traex:';

const TAE_TRAEX_FAILURE_STATUS_BY_CODE = {
  tae_traex_auth_required: 'failed',
  tae_traex_turn_failed: 'failed',
  tae_traex_turn_ambiguous: 'ambiguous',
  tae_traex_runner_failed: 'failed',
} as const;

export interface TaeTraexFailureMarker {
  turnId: string;
  content: string;
  status: 'failed' | 'ambiguous';
  errorCode: keyof typeof TAE_TRAEX_FAILURE_STATUS_BY_CODE;
  retryable: false;
}

/** Validate the only failure records the trusted TAE runner may emit.
 * Keep the code/status pairing closed so arbitrary PTY content can never
 * choose daemon retry policy or settle an unrelated turn. */
export function normalizeTaeTraexFailureMarker(
  value: unknown,
): TaeTraexFailureMarker | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const turnId = typeof raw.turnId === 'string' ? raw.turnId.trim() : '';
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!turnId || !content || raw.retryable !== false) return undefined;
  if (typeof raw.errorCode !== 'string'
      || !(raw.errorCode in TAE_TRAEX_FAILURE_STATUS_BY_CODE)) return undefined;
  const errorCode = raw.errorCode as keyof typeof TAE_TRAEX_FAILURE_STATUS_BY_CODE;
  const status = TAE_TRAEX_FAILURE_STATUS_BY_CODE[errorCode];
  if (raw.status !== status) return undefined;
  return { turnId, content, status, errorCode, retryable: false };
}

const MISSING_TURN_ID = 'TAE TraeX runner requires an authenticated BotMux turn id';
const MISSING_ACTOR = 'TAE TraeX runner requires a daemon-authenticated human caller';

export interface TaeTraexTurnAuthority {
  turnId: string;
  trustedCaller: TrustedCaller & {
    requestUserOpenId: string;
    requestLarkAppId: string;
    senderType: 'user';
  };
}

/**
 * Freeze the only authority accepted by the TAE runner.
 *
 * The prompt's <sender> block is untrusted model input. Only the daemon-created
 * WriteInputContext may select the per-user TraeX profile, and any missing or
 * non-human caller fails closed instead of falling back to the session owner,
 * deployment account, or previous turn's actor.
 */
export function taeTraexTurnAuthority(
  context: WriteInputContext | undefined,
): TaeTraexTurnAuthority | { failureReason: string } {
  const turnId = context?.turnId?.trim();
  if (!turnId) return { failureReason: MISSING_TURN_ID };

  const caller = context?.trustedCaller;
  const requestUserOpenId = caller?.requestUserOpenId?.trim();
  const requestLarkAppId = caller?.requestLarkAppId?.trim();
  if (caller?.senderType !== 'user' || !requestUserOpenId || !requestLarkAppId) {
    return { failureReason: MISSING_ACTOR };
  }

  return {
    turnId,
    trustedCaller: {
      ...caller,
      requestUserOpenId,
      requestLarkAppId,
      senderType: 'user',
    },
  };
}

function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

/**
 * Local control-runner adapter for one BotMux session backed by one TAE
 * Sandbox and one native TraeX thread. The runner executable is supplied by
 * the deployment package; BotMux only owns the authenticated turn envelope.
 */
export function createTaeTraexAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'botmux-tae-traex-runner';
  let cachedBin: string | undefined;
  return {
    id: 'tae-traex',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    allowExtraArgs: false,

    buildArgs({ sessionId, workingDir, model, reasoningEffort }) {
      const args = ['--session-id', sessionId];
      pushOpt(args, '--cwd', workingDir);
      pushOpt(args, '--model', model?.trim());
      pushOpt(args, '--reasoning-effort', reasoningEffort);
      return args;
    },

    buildResumeCommand() {
      // Remote lineage is restored by the runner's persisted session state.
      return null;
    },

    async writeInput(pty: PtyHandle, content: string, context?: WriteInputContext) {
      const authority = taeTraexTurnAuthority(context);
      if ('failureReason' in authority) {
        return {
          submitted: false,
          submissionDisposition: 'untouched' as const,
          failureReason: authority.failureReason,
        };
      }

      return writeRunnerInput(
        pty,
        TAE_TRAEX_RUNNER_MARKER,
        content,
        undefined,
        authority.turnId,
        undefined,
        authority.trustedCaller,
      );
    },

    supportsTypeAhead: false,
    completionPattern: undefined,
    readyPattern: /›/,
    deferFirstPromptTimeoutUntilReady: true,
    systemHints: [],
    altScreen: false,
    modelChoices: CLI_MODEL_CHOICES['tae-traex'],
  };
}

export const create = createTaeTraexAdapter;
