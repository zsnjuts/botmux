import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-distributed-lineage.mjs');
const hook = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'git-hooks', 'pre-push');
const repositories: string[] = [];

function git(repository: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'botmux-distributed-lineage-'));
  repositories.push(repository);
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.name', 'Lineage Test');
  git(repository, 'config', 'user.email', 'lineage@example.invalid');
  return repository;
}

function commit(repository: string, label: string): string {
  writeFileSync(join(repository, 'history.txt'), `${label}\n`, { flag: 'a' });
  git(repository, 'add', 'history.txt');
  git(repository, 'commit', '-m', label);
  return git(repository, 'rev-parse', 'HEAD');
}

function verify(repository: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repository,
    encoding: 'utf8',
  });
}

function installHookFixture(repository: string): string {
  const scriptsDirectory = join(repository, 'scripts');
  const hooksDirectory = join(scriptsDirectory, 'git-hooks');
  mkdirSync(hooksDirectory, { recursive: true });
  copyFileSync(script, join(scriptsDirectory, 'verify-distributed-lineage.mjs'));
  const installedHook = join(hooksDirectory, 'pre-push');
  copyFileSync(hook, installedHook);
  chmodSync(installedHook, 0o755);
  return installedHook;
}

function runHook(repository: string, installedHook: string, input: string) {
  return spawnSync(installedHook, ['origin', 'unused'], {
    cwd: repository,
    input,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe('verify-distributed-lineage', () => {
  it('accepts a candidate that contains the latest numeric distributed tag', () => {
    const repository = createRepository();
    commit(repository, 'v1');
    git(repository, 'tag', 'distributed/v1');
    commit(repository, 'v2');
    git(repository, 'tag', 'distributed/v2');
    commit(repository, 'candidate');

    const result = verify(repository);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('HEAD contains distributed/v2');
  });

  it('rejects a candidate that diverges before the latest distributed tag', () => {
    const repository = createRepository();
    const v1 = commit(repository, 'v1');
    git(repository, 'tag', 'distributed/v1');
    commit(repository, 'v2');
    git(repository, 'tag', 'distributed/v2');
    git(repository, 'checkout', '--detach', v1);
    commit(repository, 'diverged');

    const result = verify(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not contain required ancestor');
  });

  it('checks a new tag against the greatest lower numeric version', () => {
    const repository = createRepository();
    const v9 = commit(repository, 'v9');
    git(repository, 'tag', 'distributed/v9');
    commit(repository, 'v10');
    git(repository, 'tag', 'distributed/v10');
    git(repository, 'checkout', '--detach', v9);
    commit(repository, 'diverged-v11');

    const result = verify(repository, '--tag', 'distributed/v11', '--candidate', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not contain required ancestor');
  });

  it('accepts a linear new tag and reports its predecessor', () => {
    const repository = createRepository();
    commit(repository, 'v1');
    git(repository, 'tag', 'distributed/v1');
    commit(repository, 'v2');
    git(repository, 'tag', 'distributed/v2');
    commit(repository, 'v3-candidate');

    const result = verify(repository, '--tag', 'distributed/v3', '--candidate', 'HEAD');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('distributed/v3 contains distributed/v2');
  });

  it('rejects a new tag whose version is below an existing release', () => {
    const repository = createRepository();
    commit(repository, 'v9');
    git(repository, 'tag', 'distributed/v9');
    commit(repository, 'v10');
    git(repository, 'tag', 'distributed/v10');

    const result = verify(repository, '--tag', 'distributed/v8', '--candidate', 'HEAD');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('distributed/v8 is older than existing release distributed/v9');
  });

  it('supports explicit fast-forward ancestry checks', () => {
    const repository = createRepository();
    const previous = commit(repository, 'previous');
    const candidate = commit(repository, 'candidate');

    expect(verify(repository, '--previous', previous, '--candidate', candidate).status).toBe(0);
    expect(verify(repository, '--previous', candidate, '--candidate', previous).status).toBe(1);
  });

  it('allows bootstrap without prior tags but rejects malformed reserved tags', () => {
    const repository = createRepository();
    commit(repository, 'initial');

    expect(verify(repository, '--tag', 'distributed/v1', '--candidate', 'HEAD').status).toBe(0);

    git(repository, 'tag', 'distributed/v01');
    const malformed = verify(repository);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('invalid tag in reserved namespace: distributed/v01');
  });

  it('pre-push accepts fast-forwards and rejects destructive distributed ref updates', () => {
    const repository = createRepository();
    const v1 = commit(repository, 'v1');
    git(repository, 'tag', 'distributed/v1');
    const v2 = commit(repository, 'v2');
    git(repository, 'tag', 'distributed/v2');
    const installedHook = installHookFixture(repository);
    const zero = '0'.repeat(40);

    const fastForward = runHook(
      repository,
      installedHook,
      `refs/heads/main ${v2} refs/heads/distributed ${v1}\n`,
    );
    expect(fastForward.status).toBe(0);

    const nonFastForward = runHook(
      repository,
      installedHook,
      `refs/heads/main ${v1} refs/heads/distributed ${v2}\n`,
    );
    expect(nonFastForward.status).toBe(1);
    expect(nonFastForward.stderr).toContain('does not contain required ancestor');

    const deleteBranch = runHook(
      repository,
      installedHook,
      `(delete) ${zero} refs/heads/distributed ${v2}\n`,
    );
    expect(deleteBranch.status).toBe(1);
    expect(deleteBranch.stderr).toContain('distributed 分支不能删除');

    const newTag = runHook(
      repository,
      installedHook,
      `refs/tags/distributed/v3 ${v2} refs/tags/distributed/v3 ${zero}\n`,
    );
    expect(newTag.status).toBe(0);

    const moveTag = runHook(
      repository,
      installedHook,
      `refs/tags/distributed/v2 ${v1} refs/tags/distributed/v2 ${v2}\n`,
    );
    expect(moveTag.status).toBe(1);
    expect(moveTag.stderr).toContain('已存在的 distributed/v2 不能移动');

    const deleteTag = runHook(
      repository,
      installedHook,
      `(delete) ${zero} refs/tags/distributed/v2 ${v2}\n`,
    );
    expect(deleteTag.status).toBe(1);
    expect(deleteTag.stderr).toContain('distributed/v2 不能删除');
  });
});
