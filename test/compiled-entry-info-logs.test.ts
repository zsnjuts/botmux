/**
 * A compiled binary reaches every entry through cli.ts, which silences info
 * logs for CLI subcommands. Fleet processes must get them back (they are the
 * daemon's only operational record); runner / relay entries must stay silent
 * because their stdout can be a protocol stream.
 */
import { describe, it, expect } from 'vitest';
import {
  ENTRY_SUBCOMMANDS,
  entryForSubcommand,
  entryLogsInfo,
  RUNNER_ENTRIES,
  type BotmuxEntry,
} from '../src/core/self-spawn.js';

const allEntries = [...ENTRY_SUBCOMMANDS].map(token => entryForSubcommand(token) as BotmuxEntry);

describe('entryLogsInfo', () => {
  it('re-enables info logs for the daemon and the workers it re-logs', () => {
    expect(entryLogsInfo('daemon')).toBe(true);
    expect(entryLogsInfo('worker')).toBe(true);
    expect(entryLogsInfo('supervisor')).toBe(true);
  });

  it('keeps every CLI-adapter runner and stdout relay silent', () => {
    for (const entry of RUNNER_ENTRIES) expect(entryLogsInfo(entry)).toBe(false);
    expect(entryLogsInfo('program-status-relay')).toBe(false);
    expect(entryLogsInfo('sandbox-network-runner')).toBe(false);
  });

  it('classifies every compiled entry token', () => {
    expect(allEntries.every(entry => entry !== null)).toBe(true);
    const logging = allEntries.filter(entryLogsInfo);
    expect(logging.length).toBeGreaterThan(0);
    expect(logging.some(entry => RUNNER_ENTRIES.includes(entry))).toBe(false);
  });
});
