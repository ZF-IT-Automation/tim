import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore, SessionManager } from 'tim-store';
import type { TimConfigFile } from 'tim-core';
import { auditSummarizerHealth, ensureSummarizerChain, resolveOnPath } from '../summarizer-health.js';

const PROJECT = 'P8001';
const SESSION = 'sess-health';

function configWith(chain: { cli: string; model: string }[]): TimConfigFile {
  return {
    dbPath: ':memory:',
    deviceId: 'test',
    summarizer: { chain, timeout_sec: 600 },
  };
}

describe('resolveOnPath', () => {
  it('finds an executable that exists on PATH', () => {
    expect(resolveOnPath('node')).toBe(true);
  });

  it('reports a missing executable', () => {
    expect(resolveOnPath('definitely-not-a-real-cli-xyz')).toBe(false);
  });
});

describe('ensureSummarizerChain', () => {
  let root: string;
  let configPath: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-init-chain-'));
    configPath = path.join(root, '.tim', 'config.json');
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function withClaudeOnPath(): void {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = bin;
  }

  it('writes a claude chain next to existing keys when Claude Code is installed', () => {
    withClaudeOnPath();
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ batch_size: 7, summarizer: { timeout_sec: 300 } }));
    expect(ensureSummarizerChain(configPath)).toContain('claude/haiku');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      batch_size: 7,
      summarizer: { timeout_sec: 300, chain: [{ cli: 'claude', model: 'haiku' }] },
    });
  });

  it('never touches a configured chain or an unparseable file', () => {
    withClaudeOnPath();
    fs.mkdirSync(path.dirname(configPath));
    const own = JSON.stringify({ summarizer: { chain: [{ cli: 'codex', model: 'x' }] } });
    fs.writeFileSync(configPath, own);
    expect(ensureSummarizerChain(configPath)).toContain('kept');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(own);

    fs.writeFileSync(configPath, '{ nope');
    expect(ensureSummarizerChain(configPath)).toContain('not valid JSON');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ nope');
  });

  it('only warns when no claude is on PATH', () => {
    process.env.PATH = path.join(root, 'empty');
    expect(ensureSummarizerChain(configPath)).toContain('No summarizer chain configured');
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe('auditSummarizerHealth', () => {
  let store: TimStore;
  let sessions: SessionManager;
  let root: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-health-'));
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject(PROJECT);
    await sessions.startProjectSession({
      sessionId: SESSION,
      projectId: PROJECT,
      agentName: 'agent',
      cwd: root,
      harness: 'test',
      batchSize: 2,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('is healthy when the chain resolves and no summary is corrupted', async () => {
    await sessions.writeBatchSummary(SESSION, 1, 'real themes', { seqFrom: 1, seqTo: 2 });

    const health = await auditSummarizerHealth(store, configWith([{ cli: 'node', model: 'm' }]));
    expect(health.healthy).toBe(true);
    expect(health.firstEntry).toBe('node/m');
    expect(health.chainLength).toBe(1);
    expect(health.issues).toEqual([]);
  });

  it('flags a missing chain with the config path', async () => {
    const health = await auditSummarizerHealth(store, configWith([]));
    expect(health.healthy).toBe(false);
    expect(health.firstEntry).toBeNull();
    expect(health.issues.join(' ')).toContain('no summarizer chain configured');
    expect(health.issues.join(' ')).toContain('config.json');
  });

  it('flags a first chain CLI that is not on PATH', async () => {
    const health = await auditSummarizerHealth(
      store,
      configWith([{ cli: 'definitely-not-a-real-cli-xyz', model: 'm' }]),
    );
    expect(health.healthy).toBe(false);
    expect(health.issues.join(' ')).toContain('not found on PATH');
  });

  it('resolves curl-openrouter against the curl binary', async () => {
    const health = await auditSummarizerHealth(
      store,
      configWith([{ cli: 'curl-openrouter', model: 'some/model' }]),
    );
    expect(health.issues.some(i => i.includes('curl-openrouter'))).toBe(false);
  });

  it('reports sessions whose stored summary holds the failure marker', async () => {
    await sessions.writeBatchSummary(
      SESSION,
      1,
      '[ALL SUMMARIZER CLIs FAILED — main agent please resummarize batch 1]\nQ: something',
      { seqFrom: 1, seqTo: 2 },
    );

    const health = await auditSummarizerHealth(store, configWith([{ cli: 'node', model: 'm' }]));
    expect(health.healthy).toBe(false);
    expect(health.corruptedSessions).toEqual([SESSION]);
    expect(health.issues.join(' ')).toContain('failed-summary marker');
  });
});
