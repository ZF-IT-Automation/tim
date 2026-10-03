import * as fs from 'fs';
import * as path from 'path';
import { getConfigPath, type TimConfigFile } from 'tim-core';
import { TimStore, KIND_BATCH, KIND_SUMMARY_ROOT } from 'tim-store';
import { SUMMARY_FAILURE_MARKER } from 'tim-summarizer';

const SCAN_LIMIT = 500;

export interface SummarizerHealth {
  healthy: boolean;
  /** First chain entry, formatted as cli/model — null when no chain is configured. */
  firstEntry: string | null;
  chainLength: number;
  /** Session ids whose stored summary still carries the failure marker. */
  corruptedSessions: string[];
  issues: string[];
}

export const CLAUDE_CHAIN_HINT =
  `set "summarizer": { "chain": [{ "cli": "claude", "model": "haiku" }] } in ${getConfigPath()}.`;

/**
 * `tim init` on a config without a chain: the default chain guesses opencode
 * models a fresh machine rarely has, so pick Claude Code when it is installed.
 * A chain the user set — or a config.json we cannot parse — is never touched.
 */
export function ensureSummarizerChain(configPath = getConfigPath()): string {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return `⚠ ${configPath} is not valid JSON — summarizer chain left alone`;
    }
  }
  const summarizer = (raw.summarizer ?? {}) as Record<string, unknown>;
  if (Array.isArray(summarizer.chain)) return `✓ Summarizer chain: kept as configured in ${configPath}`;
  if (!resolveOnPath('claude')) {
    return `⚠ No summarizer chain configured and Claude Code not on PATH — summaries fall back to raw transcripts. ` +
      `Add a "summarizer.chain" to ${configPath} (see README).`;
  }
  raw.summarizer = { ...summarizer, chain: [{ cli: 'claude', model: 'haiku' }] };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  return `✓ Summarizer chain: claude/haiku (Claude Code print mode) → ${configPath}`;
}

/** Which binary a chain entry actually spawns (see tryCli in tim-summarizer). */
function commandForCli(cli: string): string {
  return cli === 'curl-openrouter' ? 'curl' : cli;
}

/** PATH lookup without spawning anything — doctor stays read-only. */
export function resolveOnPath(command: string): boolean {
  if (command.includes(path.sep)) {
    return fs.existsSync(command);
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // not here — keep looking
    }
  }
  return false;
}

/** Read-only summarizer health check for `tim doctor` (no writes, no spawns). */
export async function auditSummarizerHealth(
  store: TimStore,
  config: TimConfigFile,
): Promise<SummarizerHealth> {
  const issues: string[] = [];
  const chain = config.summarizer?.chain ?? [];
  const first = chain[0];
  const firstEntry = first ? `${first.cli}/${first.model}` : null;

  if (chain.length === 0) {
    issues.push(
      `no summarizer chain configured — every summary falls back to a raw transcript. ` +
        `Add a "summarizer" block to ${getConfigPath()}.`,
    );
  } else if (!resolveOnPath(commandForCli(first!.cli))) {
    issues.push(
      `first chain CLI '${commandForCli(first!.cli)}' not found on PATH — ` +
        `the chain starts by failing over.` +
        (resolveOnPath('claude') ? ` Claude Code is installed: ${CLAUDE_CHAIN_HINT}` : ''),
    );
  }

  // Previously-corrupted summaries: the marker survives in the tree until resummarized.
  const corrupted = new Set<string>();
  for (const kind of [KIND_BATCH, KIND_SUMMARY_ROOT]) {
    const nodes = await store.getByMetadataKind(kind, SCAN_LIMIT);
    for (const node of nodes) {
      if (!(node.content || '').includes(SUMMARY_FAILURE_MARKER)) continue;
      const sessionId =
        typeof node.metadata.sessionId === 'string' ? node.metadata.sessionId : node.parentId;
      if (sessionId) corrupted.add(sessionId);
    }
  }
  const corruptedSessions = [...corrupted].sort();
  if (corruptedSessions.length > 0) {
    issues.push(
      `${corruptedSessions.length} session(s) hold a failed-summary marker: ` +
        `${corruptedSessions.slice(0, 5).join(', ')}${corruptedSessions.length > 5 ? ', …' : ''}`,
    );
  }

  return {
    healthy: issues.length === 0,
    firstEntry,
    chainLength: chain.length,
    corruptedSessions,
    issues,
  };
}
