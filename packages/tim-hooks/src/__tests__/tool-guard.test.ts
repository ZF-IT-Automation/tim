import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import * as timCore from 'tim-core';
import { isRiskyCommand, scrubCommand } from '../risky-command.js';
import { runToolGuard } from '../tool-guard.js';

describe('isRiskyCommand', () => {
  it.each([
    'git push origin master',
    'cd ~/projects/tim && git commit -m "fix"',
    'rm -rf old-clone',
    'npm publish --access public',
    'sudo systemctl restart nginx',
    'ssh strato "df -h"',
    'sqlite3 ~/.tim/tim.db "select 1"',
    'npm run deploy',
    './scripts/migrate.sh',
    'rmapi put file.pdf',
  ])('%s', command => {
    expect(isRiskyCommand(command)).toBe(true);
  });

  it.each([
    'ls -la',
    'git status',
    'git diff --stat',
    'npx vitest run packages/tim-hooks',
    'cat docs/deploy.md',
    'grep -rn "term" src',
  ])('not %s', command => {
    expect(isRiskyCommand(command)).toBe(false);
  });
});

describe('scrubCommand', () => {
  it.each([
    ['curl -H "Authorization: Bearer sk-live-abc123def456" https://api.x', 'sk-live-abc123def456'],
    ['GITHUB_TOKEN=ghp_abcdefghijklmnop git push', 'ghp_abcdefghijklmnop'],
    ['psql postgres://ben:hunter2@db.local/app', 'hunter2'],
    ['mysql -u root --password=hunter2', 'hunter2'],
    ['curl -d key=0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
  ])('%s', (command, secret) => {
    expect(scrubCommand(command)).not.toContain(secret);
  });

  it('keeps the words of an ordinary command', () => {
    expect(scrubCommand('git push --force origin master')).toBe('git push --force origin master');
  });
});

describe('runToolGuard', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-tool-guard-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function learning() {
    return store.write('Never push straight to master\nOpen a PR; master is protected.', { metadata: { kind: 'learning' } });
  }

  it('returns a guard line for a learning Jev says applies', async () => {
    const hit = await learning();
    vi.spyOn(store, 'searchFailures').mockResolvedValue([hit]);
    vi.spyOn(timCore, 'askJev').mockResolvedValue({ rel: { type: 'noul', noul: 0.9 } });

    const result = await runToolGuard(store, { command: 'git push origin master', projectLabel: 'P0001' });
    expect(result!.lines).toEqual([expect.stringContaining(`TIM guard (learning): Never push straight to master [${hit.id}]`)]);
  });

  it('stays silent when Jev rejects or does not answer', async () => {
    vi.spyOn(store, 'searchFailures').mockResolvedValue([await learning()]);
    const ask = vi.spyOn(timCore, 'askJev').mockResolvedValue({ rel: { type: 'noul', noul: 0.2 } });
    expect(await runToolGuard(store, { command: 'git push origin master', projectLabel: 'P0001' })).toBeNull();
    ask.mockResolvedValue(null);
    expect(await runToolGuard(store, { command: 'git push origin master', projectLabel: 'P0001' })).toBeNull();
  });

  it('searches and sends only the scrubbed command, paths cut to their last part', async () => {
    const guard = vi.spyOn(store, 'searchFailures').mockResolvedValue([await learning()]);
    const ask = vi.spyOn(timCore, 'askJev').mockResolvedValue({ rel: { type: 'noul', noul: 0.9 } });

    await runToolGuard(store, {
      command: 'GITHUB_TOKEN=ghp_abcdefghijklmnop git -C /home/bbbee/projects/old-clone push',
      description: 'Push the old clone with token=ghp_zyxwvutsrqponmlk',
      projectLabel: 'P0001',
    });
    const searched = guard.mock.calls[0]![0];
    expect(searched).not.toContain('ghp_');
    expect(searched).not.toContain('bbbee');
    expect(searched).toContain('old-clone');
    expect(searched).toContain('Push the old clone');
    expect(searched).not.toContain('zyxwvuts');
    expect(JSON.stringify(ask.mock.calls[0]![1])).not.toContain('ghp_');
  });

  it('shows a learning once per session', async () => {
    vi.spyOn(store, 'searchFailures').mockResolvedValue([await learning()]);
    const ask = vi.spyOn(timCore, 'askJev').mockResolvedValue({ rel: { type: 'noul', noul: 0.9 } });
    const sessionId = `test-${path.basename(dir)}`;

    expect(await runToolGuard(store, { command: 'git push', projectLabel: 'P0001', sessionId })).not.toBeNull();
    expect(await runToolGuard(store, { command: 'git push', projectLabel: 'P0001', sessionId })).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
