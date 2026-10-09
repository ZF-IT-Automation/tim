import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureCacheHookInConfig, installHermesHooks } from '../hermes-hooks-install.js';

const BASE = `hooks:
  pre_llm_call:
  - command: ~/.hermes/agent-hooks/o9k-startup.sh
    timeout: 10
  - command: ~/.hermes/agent-hooks/tim-session-start.sh
    timeout: 10
`;

describe('hermes hooks install', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-hermes-hooks-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('ensureCacheHookInConfig is idempotent', () => {
    const first = ensureCacheHookInConfig(BASE);
    expect(first.changed).toBe(true);
    expect(first.yaml).toContain('tim-hermes-session-cache.sh');
    expect(ensureCacheHookInConfig(first.yaml).changed).toBe(false);
  });

  it('links the session-cache hook and registers it once; no status bar', async () => {
    const hooksDir = path.join(root, 'agent-hooks');
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, BASE);

    const first = await installHermesHooks({ hooksDir, configPath });
    expect(first.ok).toBe(true);
    expect(fs.readdirSync(hooksDir)).toEqual(['tim-hermes-session-cache.sh']);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('tim-hermes-session-cache.sh');

    const second = await installHermesHooks({ hooksDir, configPath });
    expect(second.steps.map(s => s.status)).toEqual(['skip', 'skip']);
  });
});
