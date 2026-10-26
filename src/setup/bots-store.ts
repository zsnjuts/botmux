/**
 * `bots.json` 原子读写. Codex review 边界 #2 + #3:
 * - tmp 文件必须和 `bots.json` 同目录, 保证 `renameSync` 在同 fs 下原子覆盖
 * - 任意写入失败不留半截 JSON (renameSync 之前一切失败都不影响旧文件)
 * - 文件权限 0o600 (只有用户自己能读), secret 不外泄给同机器人其它用户
 */
import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { withFileLockSync } from '../utils/file-lock.js';
import { assertCodexInstanceConfigWrite } from '../services/codex-instance-config-guard.js';
import { assertQuotaFallbackGraphAcyclic } from '../services/quota-fallback.js';
import { assertChangedBotConfigInvariants } from '../services/bot-config-invariants.js';
import { assertDurableConfigMutationAllowed } from '../services/durable-config-mutation.js';

let processSnapshotStore: {
  read(path: string): any[];
  write(path: string, bots: any[]): void;
} | null = null;

/**
 * 安装进程级 bots.json 投影/写事务适配器。
 *
 * Dashboard 借此让 BotOnboardingManager 的旧同步接口只操作内存事务，真实共享存储
 * I/O 由外层 CAS mutation 异步完成；其他进程仍使用下面的直接原子文件实现。
 */
export function installBotsJsonSnapshotStore(provider: {
  read(path: string): any[];
  write(path: string, bots: any[]): void;
}): () => void {
  const previous = processSnapshotStore;
  processSnapshotStore = provider;
  return () => {
    if (processSnapshotStore === provider) processSnapshotStore = previous;
  };
}

export function writeBotsJsonAtomic(botsJsonPath: string, bots: any[]): void {
  assertDurableConfigMutationAllowed('bots');
  if (processSnapshotStore) {
    processSnapshotStore.write(botsJsonPath, bots);
    return;
  }
  // PM2 start surfaces hold this same generation lock from snapshot through
  // post-start verification/rollback, so the ecosystem and its expected names
  // can never be built from different bots.json generations.
  withFileLockSync(botsJsonPath, () => {
    const previous = existsSync(botsJsonPath) ? JSON.parse(readFileSync(botsJsonPath, 'utf8')) as any[] : [];
    assertCodexInstanceConfigWrite(previous, bots);
    assertChangedBotConfigInvariants(previous, bots);
    // Clone/onboarding callers pass the exact generation they intend to save.
    assertQuotaFallbackGraphAcyclic(bots);
    // 注意: tmp 必须在同一目录下 (同 fs), 否则 rename 可能跨文件系统失败.
    const tmp = botsJsonPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(bots, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, botsJsonPath);
  });
}

export function readBotsJsonOrEmpty(botsJsonPath: string): any[] {
  if (processSnapshotStore) return processSnapshotStore.read(botsJsonPath);
  if (!existsSync(botsJsonPath)) return [];
  try {
    return JSON.parse(readFileSync(botsJsonPath, 'utf-8'));
  } catch {
    return [];
  }
}
