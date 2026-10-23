#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const DISTRIBUTED_TAG_PATTERN = /^distributed\/v([1-9][0-9]*)$/;

function fail(message) {
  console.error(`distributed-lineage: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  node scripts/verify-distributed-lineage.mjs [--candidate <commit-ish>]
  node scripts/verify-distributed-lineage.mjs --candidate <commit-ish> --previous <commit-ish>
  node scripts/verify-distributed-lineage.mjs --tag distributed/vN [--candidate <commit-ish>]

Without --previous or --tag, the newest numeric distributed/vN tag must be an
ancestor of the candidate. With --tag, the greatest existing numeric version
below N must be an ancestor of the candidate.`);
}

function parseArgs(argv) {
  const options = { candidate: undefined, previous: undefined, tag: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    }

    if (argument !== '--candidate' && argument !== '--previous' && argument !== '--tag') {
      fail(`unknown argument: ${argument}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`missing value for ${argument}`);
    }

    const key = argument.slice(2);
    if (options[key] !== undefined) {
      fail(`duplicate argument: ${argument}`);
    }
    options[key] = value;
    index += 1;
  }

  if (options.previous && options.tag) {
    fail('--previous and --tag cannot be used together');
  }

  return options;
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    fail(`could not run git: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    fail(`git ${args[0]} failed: ${detail}`);
  }

  return result;
}

function resolveCommit(reference, label) {
  const result = git(['rev-parse', '--verify', `${reference}^{commit}`], { allowFailure: true });
  if (result.status !== 0) {
    fail(`${label} is not a local commit: ${reference}`);
  }
  return result.stdout.trim();
}

function listNumericDistributedTags() {
  const result = git(['tag', '--list', 'distributed/v*']);
  const tags = [];

  for (const name of result.stdout.split('\n')) {
    if (!name) continue;
    const match = DISTRIBUTED_TAG_PATTERN.exec(name);
    if (!match) {
      fail(`invalid tag in reserved namespace: ${name}`);
    }
    tags.push({ name, version: BigInt(match[1]) });
  }

  tags.sort((left, right) => {
    if (left.version < right.version) return -1;
    if (left.version > right.version) return 1;
    return 0;
  });
  return tags;
}

function assertAncestor(previous, candidate) {
  const result = git(['merge-base', '--is-ancestor', previous, candidate], { allowFailure: true });
  if (result.status === 0) return;
  if (result.status === 1) {
    fail(`candidate ${candidate} does not contain required ancestor ${previous}`);
  }
  const detail = result.stderr.trim() || `exit ${result.status}`;
  fail(`could not compare ${previous} with ${candidate}: ${detail}`);
}

const options = parseArgs(process.argv.slice(2));
const candidateRef = options.candidate ?? options.tag ?? 'HEAD';
const candidate = resolveCommit(candidateRef, 'candidate');

if (options.previous) {
  const previous = resolveCommit(options.previous, 'previous');
  assertAncestor(previous, candidate);
  console.log(`distributed-lineage: ${candidateRef} contains ${options.previous}`);
  process.exit(0);
}

const tags = listNumericDistributedTags();

if (options.tag) {
  const match = DISTRIBUTED_TAG_PATTERN.exec(options.tag);
  if (!match) {
    fail(`tag must use the canonical distributed/vN form: ${options.tag}`);
  }

  const version = BigInt(match[1]);
  const higherTag = tags.find((tag) => tag.version > version);
  if (higherTag) {
    fail(`${options.tag} is older than existing release ${higherTag.name}`);
  }
  const previousTag = tags.filter((tag) => tag.version < version).at(-1);
  if (!previousTag) {
    console.log(`distributed-lineage: ${options.tag} is the first numeric distributed release`);
    process.exit(0);
  }

  const previous = resolveCommit(previousTag.name, 'previous tag');
  assertAncestor(previous, candidate);
  console.log(`distributed-lineage: ${options.tag} contains ${previousTag.name}`);
  process.exit(0);
}

const latestTag = tags.at(-1);
if (!latestTag) {
  console.log('distributed-lineage: no numeric distributed release tags exist yet');
  process.exit(0);
}

const previous = resolveCommit(latestTag.name, 'latest tag');
assertAncestor(previous, candidate);
console.log(`distributed-lineage: ${candidateRef} contains ${latestTag.name}`);
