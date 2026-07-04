import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annotateTrust } from '../trust.js';
import { clearCommitsSinceCache, getCommitsSinceCacheStats } from '../provenance.js';
import type { Entry } from 'tim-core';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString().trim();
}

function entryFixture(overrides: Partial<Entry>): Entry {
  const now = new Date().toISOString();
  return {
    id: 'x'.repeat(26),
    parentId: null,
    title: 'Fact',
    content: 'body',
    contentType: 'text',
    depth: 1,
    confidence: 1,
    createdAt: now,
    accessedAt: now,
    updatedAt: now,
    decayRate: 0,
    visibility: 1,
    tags: [],
    irrelevant: false,
    favorite: false,
    tombstonedAt: null,
    metadata: {},
    ...overrides,
  };
}

describe('annotateTrust — staleness', () => {
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();

  it('marks unverified old knowledge entries stale', () => {
    const out = annotateTrust(entryFixture({ createdAt: old, updatedAt: old }), process.cwd());
    expect(out.stale).toBeDefined();
    expect(out.stale!.daysSince).toBeGreaterThan(90);
    expect(out.stale!.lastVerified).toBe(old);
  });

  it('respects a recent metadata.verified_at', () => {
    const out = annotateTrust(
      entryFixture({
        createdAt: old,
        updatedAt: old,
        metadata: { verified_at: new Date().toISOString() },
      }),
      process.cwd(),
    );
    expect(out.stale).toBeUndefined();
  });

  it('never marks schema entries stale', () => {
    const out = annotateTrust(
      entryFixture({ createdAt: old, updatedAt: old, metadata: { kind: 'session' } }),
      process.cwd(),
    );
    expect(out.stale).toBeUndefined();
  });

  it('does not mark entries at exactly 90 days stale', () => {
    const now = Date.now();
    const last = new Date(now - 90 * 86400_000).toISOString();
    const out = annotateTrust(entryFixture({ createdAt: last, updatedAt: last }), process.cwd());
    expect(out.stale).toBeUndefined();
  });
});

describe('annotateTrust — provenance drift', () => {
  let repo: string;
  let firstCommit: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-trust-prov-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@test');
    git(repo, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'first');
    firstCommit = git(repo, 'rev-parse', '--short', 'HEAD');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'second');
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('annotates provenance_drift when HEAD has moved on', () => {
    const entry = entryFixture({
      metadata: { provenance: { commit: firstCommit } },
    });
    const out = annotateTrust(entry, repo);
    expect(out.provenance_drift).toEqual({ commitsSince: 1 });
  });

  it('memoises git drift lookups across repeated annotations', () => {
    clearCommitsSinceCache();
    const entry = entryFixture({
      metadata: { provenance: { commit: firstCommit } },
    });
    for (let i = 0; i < 10; i++) {
      annotateTrust(entry, repo);
    }
    const stats = getCommitsSinceCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(9);
    clearCommitsSinceCache();
  });
});
