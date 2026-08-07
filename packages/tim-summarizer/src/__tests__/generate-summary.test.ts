import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  generateSummaryHeuristic,
  extractTags,
  tryCli,
  FALLBACK_MARKER,
} from '../generate-summary.js';
import type { UnsummarizedBatch } from '../mcp-client.js';

const baseBatch: UnsummarizedBatch = {
  sessionId: 's1',
  summaryNodeId: 'sum',
  exchangesNodeId: 'ex',
  batchIndex: 1,
  batchSize: 2,
  exchanges: [
    { seq: 1, userId: 'u1', userContent: 'Hello', agentId: 'a1', agentContent: 'Hi' },
    { seq: 2, userId: 'u2', userContent: 'Bye', agentId: 'a2', agentContent: 'Later' },
  ],
  hasMore: false,
  previousSummaries: [],
  sessionMeta: { project: 'P0001' },
};

describe('generateSummaryHeuristic', () => {
  it('includes batch index and exchange bodies', () => {
    const text = generateSummaryHeuristic(baseBatch);
    expect(text).toContain('Batch 1');
    expect(text).toContain('Hello');
    expect(text).toContain('Hi');
    expect(text).toContain('project=P0001');
  });
});

describe('extractTags', () => {
  it('parses TAGS line, normalizes, dedups, caps at 5', () => {
    const text =
      'Themes: auth work\n- decided JWT\n\nTAGS: #Auth #auth #session-start #FOO_BAR #one #two #three #four #five #six';
    const { body, tags } = extractTags(text);
    expect(body).toBe('Themes: auth work\n- decided JWT');
    expect(tags).toEqual(['#auth', '#session-start', '#foo-bar', '#one', '#two']);
  });

  it('returns empty tags when TAGS line missing', () => {
    const { body, tags } = extractTags('Summary only');
    expect(body).toBe('Summary only');
    expect(tags).toEqual([]);
  });

  it('returns empty tags for FALLBACK_MARKER', () => {
    const { body, tags } = extractTags(FALLBACK_MARKER);
    expect(body).toBe(FALLBACK_MARKER);
    expect(tags).toEqual([]);
  });
});

/**
 * A stub on PATH that echoes its own argv, so the argv tryCli builds is
 * observable without invoking a real model.
 */
describe('tryCli argv', () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeAll(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-trycli-'));
    for (const name of ['opencode', 'codex']) {
      const stub = path.join(binDir, name);
      fs.writeFileSync(stub, '#!/bin/sh\ncat >/dev/null\necho "$@"\n');
      fs.chmodSync(stub, 0o755);
    }
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('passes --pure to opencode so plugin output cannot leak into the summary', async () => {
    const out = await tryCli('opencode', 'deepseek-v4-flash-free', 'opencode', 'prompt', 30);
    expect(out).toContain('--pure');
    expect(out).toContain('opencode/deepseek-v4-flash-free');
  });

  it('appends chain-entry args verbatim', async () => {
    const out = await tryCli('codex', 'gpt-5.6-luna', undefined, 'prompt', 30, undefined, [
      '-c',
      'model_reasoning_effort=max',
    ]);
    expect(out).toContain('--model gpt-5.6-luna');
    expect(out).toContain('-c model_reasoning_effort=max');
  });
});
