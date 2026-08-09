#!/usr/bin/env node
import * as os from 'os';
import * as path from 'path';
import { loadConfig, type Entry } from 'tim-core';
import {
  TimStore,
  SessionManager,
  findChildByKind,
  KIND_BATCH,
  KIND_SUMMARY_ROOT,
  KIND_SESSION,
} from 'tim-store';
import { connectTimMcp, callTimTool, type UnsummarizedBatch } from './mcp-client.js';
import {
  generateSummary,
  generateSummaryDetailed,
  generateProjectSummary,
  generateSessionRollup,
  generateSummaryHeuristic,
  extractTags,
  FALLBACK_MARKER,
  type SummaryStatus,
} from './generate-summary.js';

export const PROJECT_SUMMARY_MARKER = '## Project Summary';

/**
 * Prefix of the placeholder stored when no CLI produced a summary. `tim doctor`
 * scans stored summaries for it to surface previously-corrupted sessions.
 */
export const SUMMARY_FAILURE_MARKER = '[ALL SUMMARIZER CLIs FAILED';

/**
 * Idempotently merge a project summary into the project content body.
 * Strips any existing `## Project Summary` block first, so running it twice
 * yields exactly one block — matching the renderer's first-occurrence parse.
 */
export function mergeProjectSummary(content: string, summary: string): string {
  const base = content.split(PROJECT_SUMMARY_MARKER)[0].trimEnd();
  const block = `${PROJECT_SUMMARY_MARKER}\n${summary.trim()}`;
  return base ? `${base}\n\n${block}` : block;
}

function resolveDbPath(): string {
  if (process.env.TIM_DB_PATH) return process.env.TIM_DB_PATH;
  const config = loadConfig();
  return config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

/**
 * Generate a project-level summary from all session summaries and write it
 * into project.content under `## Project Summary`. Returns true when written,
 * false when skipped (no sessions, or every CLI failed → leave content as-is).
 */
export async function runProjectSummary(label: string): Promise<boolean> {
  const store = new TimStore(resolveDbPath());
  try {
    const result = await store.loadProject(label);
    if (!result) throw new Error(`Project not found: ${label}`);

    // Collect batch summary content from each session-summary-root node.
    // The root nodes themselves have empty content; real summaries are in #batch-summary children.
    const sessionNodes = result.children
      .filter(c => c.tags.includes('#session-summary'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (sessionNodes.length === 0) return false;

    const summaries: string[] = [];
    for (const session of sessionNodes) {
      const children = await store.getChildren(session.id);
      const batchSummaries = children
        .filter(c => c.tags.includes('#batch-summary'))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(c => c.content?.trim() || c.title.trim())
        .filter(Boolean);
      if (batchSummaries.length > 0) {
        summaries.push(...batchSummaries);
      } else if (session.content?.trim()) {
        summaries.push(session.content.trim());
      }
    }
    if (summaries.length === 0) return false;

    const summary = await generateProjectSummary(summaries);
    if (!summary) return false; // total CLI failure → write nothing

    const newContent = mergeProjectSummary(result.project.content, summary);
    await store.update(result.project.id, {
      title: result.project.title,
      content: newContent,
    });

    const sessions = new SessionManager(store);
    await sessions.updateProjectSummary(label);
    await processCurationQueue(store, label);
    return true;
  } finally {
    store.close();
  }
}

function parseProjectSummaryArg(argv: string[]): string | null {
  const idx = argv.indexOf('--project-summary');
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('-')) return argv[idx + 1];
  const eq = argv.find(a => a.startsWith('--project-summary='));
  if (eq) return eq.slice('--project-summary='.length) || null;
  return null;
}

function seqRange(batch: UnsummarizedBatch): { seqFrom: number; seqTo: number } {
  const seqs = batch.exchanges.map(e => e.seq);
  return { seqFrom: Math.min(...seqs), seqTo: Math.max(...seqs) };
}

function entryText(entry: Entry): string {
  return [entry.title, entry.content].filter(Boolean).join('\n').trim();
}

/** Process pending curation-queue entries via LLM (duplicates merge, decay confirm). */
export async function processCurationQueue(store: TimStore, projectLabel: string): Promise<number> {
  const mgr = store.consolidate();
  const pending = await mgr.getCurationQueue(projectLabel, 'pending');
  let processed = 0;

  for (const item of pending) {
    const meta = item.metadata;
    const consolidation = meta.consolidation as string | undefined;

    if (consolidation === 'duplicate' && Array.isArray(meta.pair) && meta.pair.length === 2) {
      const [keepId, dropId] = meta.pair as [string, string];
      const keep = await store.read(keepId);
      const drop = await store.read(dropId);
      if (!keep || !drop) {
        await mgr.setCurationRejected(item.id);
        continue;
      }

      const batch: UnsummarizedBatch = {
        sessionId: 'curation',
        summaryNodeId: '',
        exchangesNodeId: '',
        batchIndex: 1,
        batchSize: 2,
        exchanges: [
          {
            seq: 1,
            userId: keepId,
            userContent: entryText(keep),
            agentId: dropId,
            agentContent: entryText(drop),
          },
        ],
        hasMore: false,
        previousSummaries: [],
        sessionMeta: { project: projectLabel },
      };

      const raw = await generateSummary(batch);
      const merged =
        raw === FALLBACK_MARKER
          ? `${entryText(keep)}\n\n---\n\n${entryText(drop)}`
          : extractTags(raw).body;

      await store.update(keepId, {
        content: merged,
        title: keep.title,
      });
      await store.update(dropId, { irrelevant: true });
      await mgr.setCurationDone(item.id);
      processed += 1;
      continue;
    }

    if (consolidation === 'decay' && typeof meta.target === 'string') {
      const target = await store.read(meta.target);
      if (!target) {
        await mgr.setCurationRejected(item.id);
        continue;
      }

      const batch: UnsummarizedBatch = {
        sessionId: 'curation',
        summaryNodeId: '',
        exchangesNodeId: '',
        batchIndex: 1,
        batchSize: 1,
        exchanges: [
          {
            seq: 1,
            userId: target.id,
            userContent:
              `Should this memory entry be marked irrelevant (decay)? Entry:\n${entryText(target)}\n` +
              `Reason queued: ${String(meta.reason ?? '')}\n` +
              `Reply DECAY to confirm or KEEP to reject.`,
            agentId: null,
            agentContent: null,
          },
        ],
        hasMore: false,
        previousSummaries: [],
        sessionMeta: { project: projectLabel },
      };

      const raw = await generateSummary(batch);
      const verdict =
        raw === FALLBACK_MARKER
          ? generateSummaryHeuristic(batch)
          : extractTags(raw).body;
      const decay = /\bDECAY\b/i.test(verdict) && !/\bKEEP\b/i.test(verdict);

      if (decay) {
        await store.update(meta.target, { irrelevant: true });
        await mgr.setCurationDone(item.id);
      } else {
        await mgr.setCurationRejected(item.id);
      }
      processed += 1;
    }
  }

  return processed;
}

/**
 * Read this session's batch summaries in batch order — the input for the LLM rollup.
 * Goes to the store directly (not MCP) so it also sees batches written by earlier
 * summarizer runs for the same session. Returns [] on any read problem.
 */
async function collectBatchSummaries(sessionId: string): Promise<string[]> {
  let store: TimStore | null = null;
  try {
    store = new TimStore(resolveDbPath());
    const resolved = store.resolveSessionAlias(sessionId);
    const summaryNode = await findChildByKind(store, resolved, KIND_SUMMARY_ROOT);
    if (!summaryNode) return [];
    const batches = await store.getChildByKind(summaryNode.id, KIND_BATCH);
    return batches
      .slice()
      .sort((a, b) => (Number(a.metadata.batch_index) || 0) - (Number(b.metadata.batch_index) || 0))
      .map(b => (b.content || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    store?.close();
  }
}

async function postSummarizerHandoff(sessionId: string): Promise<void> {
  const store = new TimStore(resolveDbPath());
  try {
    const session = await store.read(sessionId);
    if (!session || session.metadata.kind !== KIND_SESSION) return;

    const sessions = new SessionManager(store);
    const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
    const text = String(summaryNode?.content || summaryNode?.metadata.summary || '').trim();
    if (text) {
      await sessions.updateSessionSummary(sessionId, text);
    }

    const projectRef =
      typeof session.metadata.project_ref === 'string' ? session.metadata.project_ref : null;
    if (projectRef) {
      await sessions.updateProjectSummary(projectRef);
      await processCurationQueue(store, projectRef);
    }
  } finally {
    store.close();
  }
}

export interface SummarizerLoopOpts {
  /** Called per batch that was stored degraded (marker or heuristic transcript). */
  onDegraded?: (info: { batchIndex: number; status: SummaryStatus }) => void;
}

export async function runSummarizerLoop(
  sessionId: string,
  opts: SummarizerLoopOpts = {},
): Promise<number> {
  const client = await connectTimMcp();
  let written = 0;

  const onMCPError = async (tool: string, error: string, stack?: string) => {
    try {
      await callTimTool(client, 'tim_error_log', { tool, error, stack, sessionId });
    } catch {
      // Non-critical — don't fail the summarizer if error logging fails
    }
  };

  try {
    let batch = await callTimTool<UnsummarizedBatch>(client, 'tim_show_unsummarized', { sessionId });
    while (batch.exchanges.length > 0) {
      const { text: raw, status } = await generateSummaryDetailed(batch, onMCPError);
      if (status !== 'ok') opts.onDegraded?.({ batchIndex: batch.batchIndex, status });
      const { seqFrom, seqTo } = seqRange(batch);
      let summary: string;
      let tags: string[] | undefined;

      if (raw === FALLBACK_MARKER) {
        summary =
          `${SUMMARY_FAILURE_MARKER} — main agent please resummarize batch ${batch.batchIndex}]\n` +
          `${batch.exchanges.map(e => `Q: ${e.userContent.trim().slice(0, 200)}`).join('\n')}`;
        tags = undefined;
      } else {
        const extracted = extractTags(raw);
        summary = extracted.body;
        tags = extracted.tags.length > 0 ? extracted.tags : undefined;
      }

      await callTimTool(client, 'tim_write_batch_summary', {
        sessionId,
        batchIndex: batch.batchIndex,
        summary,
        seqFrom,
        seqTo,
        ...(tags && { tags }),
      });
      written += 1;
      if (!batch.hasMore) break;
      batch = await callTimTool<UnsummarizedBatch>(client, 'tim_show_unsummarized', { sessionId });
    }
  } finally {
    try {
      // Condense the batch summaries into a real handoff; the server falls back to
      // concatenation when we cannot produce one.
      const batchSummaries = await collectBatchSummaries(sessionId);
      const rollup =
        batchSummaries.length > 0 ? await generateSessionRollup(batchSummaries, onMCPError) : null;
      await callTimTool(client, 'tim_rollup_session_summary', {
        sessionId,
        ...(rollup ? { summary: rollup } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      await onMCPError('tim_rollup_session_summary', msg, stack);
    }
    try {
      await client.close();
    } catch {
      /* best-effort cleanup */
    }
    try {
      await postSummarizerHandoff(sessionId);
    } catch {
      /* best-effort handoff */
    }
  }
  return written;
}

async function main(): Promise<void> {
  // Project-summary mode: aggregate session summaries into project.content
  const projectLabel = parseProjectSummaryArg(process.argv);
  if (projectLabel) {
    try {
      const wrote = await runProjectSummary(projectLabel);
      console.error(
        `tim-summarizer: project summary for ${projectLabel} → ${wrote ? 'written' : 'skipped'}`,
      );
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`tim-summarizer project-summary failed: ${msg}`);
      process.exit(1);
    }
  }

  const sessionId = process.env.TIM_SESSION_ID;
  if (!sessionId) {
    console.error('TIM_SESSION_ID is required');
    process.exit(1);
  }
  try {
    const degraded: SummaryStatus[] = [];
    const count = await runSummarizerLoop(sessionId, {
      onDegraded: ({ status }) => degraded.push(status),
    });
    console.error(`tim-summarizer: wrote ${count} batch summary(ies) for ${sessionId}`);
    if (degraded.length > 0) {
      // Exit 2 = summaries were stored, but degraded — distinguishable from success (0)
      // and from a hard failure (1). Run `tim doctor` for the cause.
      console.error(
        `tim-summarizer: ${degraded.length} of ${count} batch summary(ies) DEGRADED ` +
          `(${[...new Set(degraded)].join(', ')}) — run 'tim doctor'`,
      );
      process.exit(2);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`tim-summarizer failed: ${msg}`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1]?.endsWith('summarize.js') || process.argv[1]?.endsWith('summarize.ts');
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
