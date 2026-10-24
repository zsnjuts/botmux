import { beforeEach, describe, expect, it } from 'vitest';
import {
  __testOnly_resetBotRegistry,
  getBot,
  hotReloadBotConfigSnapshot,
  registerBot,
  type BotConfig,
} from '../src/bot-registry.js';

function config(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    larkAppId: 'cli_hot_reload',
    larkAppSecret: '',
    cliId: 'traex',
    apiOnly: true,
    model: 'old-model',
    globalGrants: ['ou_old'],
    ...overrides,
  } as BotConfig;
}

describe('hotReloadBotConfigSnapshot', () => {
  beforeEach(() => __testOnly_resetBotRegistry());

  it('updates the original config object so long-lived daemon closures see the new generation', () => {
    const original = config();
    registerBot(original);
    const reference = getBot(original.larkAppId).config;
    const result = hotReloadBotConfigSnapshot(original.larkAppId, config({
      model: 'new-model',
      globalGrants: ['ou_new'],
      reasoningEffort: 'xhigh',
    }));
    expect(getBot(original.larkAppId).config).toBe(reference);
    expect(reference.model).toBe('new-model');
    expect(reference.globalGrants).toEqual(['ou_new']);
    expect(reference.reasoningEffort).toBe('xhigh');
    expect(result.changedKeys).toEqual(['globalGrants', 'model', 'reasoningEffort']);
  });

  it('removes fields absent from the new canonical generation', () => {
    registerBot(config({ reasoningEffort: 'high' }));
    hotReloadBotConfigSnapshot('cli_hot_reload', config());
    expect(getBot('cli_hot_reload').config.reasoningEffort).toBeUndefined();
  });

  it('refreshes derived runtime metadata together with the config object', () => {
    registerBot(config({ cliId: 'traex' }));
    hotReloadBotConfigSnapshot('cli_hot_reload', config({
      cliId: 'traex',
      nativeSubagentRuntime: {
        model: { mode: 'custom', value: 'GPT-5.5' },
      },
    }));
    expect(getBot('cli_hot_reload').nativeSubagentRuntimeState).toEqual({
      status: 'valid',
      policy: { model: { mode: 'custom', value: 'GPT-5.5' } },
    });
  });

  it.each([
    { larkAppId: 'cli_other' },
    { larkAppSecret: 'changed' },
    { brand: 'lark' as const },
    { apiOnly: false },
  ])('rejects transport identity changes: %o', override => {
    registerBot(config());
    expect(() => hotReloadBotConfigSnapshot('cli_hot_reload', config(override)))
      .toThrow('bot_config_reload_identity_changed');
  });
});
