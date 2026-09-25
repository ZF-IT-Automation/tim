#!/usr/bin/env node
import * as os from 'os';
import * as path from 'path';
import { askJev, loadConfig, type Entry, type JevAnswer } from 'tim-core';
import {
  TimStore,
  SessionManager,
  findChildByKind,
  KIND_BATCH,
  KIND_SUMMARY_ROOT,
  KIND_SESSION,
  deriveSessionCoverage,
  isSubstantiveSession,
  parseSessionSubstance,
} from 'tim-store';
import { connectTimMcp, callTimTool, type UnsummarizedBatch } from './mcp-client.js';
import {
  generateSummary,
  generateSummaryDetailed,
  generateProjectSummary,
  generateSessionRollup,
  generateSummaryHeuristic,
  generateSubstanceVerdict,
  projectOverviewLines,
  type SubstanceProjectContext,
  appendSummarizerLog,
  extractTags,
  FALLBACK_MARKER,
  type SummaryStatus,
  type SessionSubstance,
} from './generate-summary.js';

export const PROJECT_SUMMARY_MARKER = '## Project Summary';

/**
 * Prefix of the placeholder stored when no CLI produced a summary. `tim doctor`
 * scans stored summaries for it to surface previously-corrupted sessions.
 */
export const SUMMARY_FAILURE_MARKER = '[ALL SUMMARIZER CLIs FAILED';

const PROJECT_SUMMARY_SESSION_LIMIT = 10;

function sessionDateLabel(session: Entry): string {
  return typeof session.metadata.date === 'string'
    ? session.metadata.date.slice(0, 10)
    : session.createdAt.slice(0, 10);
}

async function sessionSummaryTexts(
  store: TimStore,
  sessionId: string,
): Promise<string[]> {
  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
  if (!summaryNode) return [];

  const stored = typeof summaryNode.metadata.summary === 'string'
    ? summaryNode.metadata.summary.trim()
    : '';
  if (stored) return [stored];

  const children = await store.getChildren(summaryNode.id);
  const batchSummaries = children
    .filter(c => c.tags.includes('#batch-summary') || c.metadata.kind === KIND_BATCH)
    .sort((a, b) => (Number(a.metadata.batch_index) || 0) - (Number(b.metadata.batch_index) || 0))
    .map(c => (c.content ?? '').trim() || c.title.trim())
    .filter(Boolean);
  if (batchSummaries.length > 0) return batchSummaries;
  const body = summaryNode.content?.trim() || summaryNode.title.trim();
  return body ? [body] : [];
}

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
    const project = await store.requireProject(label);
    const rows = store.listProjectSessionsByActivity(project.id, 1000);
    if (rows.length === 0) return false;

    const picked: Array<{ date: string; summaries: string[] }> = [];
    for (const { id } of rows) {
      if (picked.length >= PROJECT_SUMMARY_SESSION_LIMIT) break;
      const session = await store.read(id);
      if (!session || session.metadata.kind !== KIND_SESSION) continue;
      const summaryNode = await findChildByKind(store, id, KIND_SUMMARY_ROOT);
      const handoff = typeof summaryNode?.metadata.handoff_note === 'string'
        ? summaryNode.metadata.handoff_note.trim()
        : '';
      const exchangeCount = Number(session.metadata.exchange_count) || 0;
      const substance = parseSessionSubstance(summaryNode?.metadata.substance);
      if (!isSubstantiveSession(exchangeCount, Boolean(handoff), substance)) continue;
      const summaries = await sessionSummaryTexts(store, id);
      if (summaries.length === 0) continue;
      picked.push({ date: sessionDateLabel(session), summaries });
    }
    if (picked.length === 0) return false;

    const generated = await generateProjectSummary(picked.flatMap(p => p.summaries));
    if (!generated) return false;

    const dates = picked.map(p => p.date).sort();
    const coverage = `_Covers ${picked.length} sessions, ${dates[0]} – ${dates[dates.length - 1]}_`;
    const summary = `${coverage}\n${generated.trim()}`;
    const newContent = mergeProjectSummary(project.content, summary);
    await store.update(project.id, {
      title: project.title,
      content: newContent,
    });

    const sessions = new SessionManager(store);
    await sessions.updateProjectSummary(label);
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

interface BackfillSubstanceOptions {
  project?: string;
  dryRun?: boolean;
  limit?: number;
}

function parseLimitArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid --limit: ${raw}`);
  }
  return n;
}

function parseBackfillSubstanceArgs(argv: string[]): BackfillSubstanceOptions | null {
  if (!argv.includes('--backfill-substance')) return null;
  const opts: BackfillSubstanceOptions = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--project' && argv[i + 1]) opts.project = argv[++i];
    else if (arg.startsWith('--project=')) opts.project = arg.slice('--project='.length) || undefined;
    else if (arg === '--limit' && argv[i + 1]) opts.limit = parseLimitArg(argv[++i]!);
    else if (arg.startsWith('--limit=')) opts.limit = parseLimitArg(arg.slice('--limit='.length));
  }
  return opts;
}

/**
 * Backfill metadata.substance on summary-root nodes that predate the verdict pass.
 * Idempotent and resumable — skips sessions that already have a substance verdict.
 */
function isSqliteBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  return code === 'SQLITE_BUSY' || /database is locked/i.test(err.message);
}

async function updateWithBusyRetry(
  store: TimStore,
  id: string,
  patch: Parameters<TimStore['update']>[1],
): Promise<void> {
  const delays = [50, 150, 400];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      await store.update(id, patch);
      return;
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt === delays.length - 1) throw err;
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
}

/** Skip sessions still accumulating exchanges or awaiting summarization. */
async function isSessionLiveForBackfill(
  store: TimStore,
  sessionId: string,
  lastActivity: string,
): Promise<boolean> {
  const idleMinutes = loadConfig().summarizer?.idle_sweep?.idle_minutes ?? 15;
  const idleMs = idleMinutes * 60_000;
  const lastMs = Date.parse(lastActivity);
  if (Number.isFinite(lastMs) && Date.now() - lastMs < idleMs) return true;

  const coverage = await deriveSessionCoverage(store, sessionId);
  return coverage.hasPendingSummarization;
}

export async function runBackfillSubstance(
  opts: BackfillSubstanceOptions = {},
): Promise<Record<SessionSubstance | 'skipped' | 'already' | 'failed', number>> {
  const counts: Record<SessionSubstance | 'skipped' | 'already' | 'failed', number> = {
    none: 0,
    low: 0,
    real: 0,
    skipped: 0,
    already: 0,
    failed: 0,
  };
  const store = new TimStore(resolveDbPath());
  try {
    const projects: string[] = [];
    if (opts.project) {
      const resolved = await store.resolveProjectLabel(opts.project);
      if (resolved.status !== 'found') {
        throw new Error(`Project not found: ${opts.project}`);
      }
      projects.push(resolved.label);
    } else {
      const all = await store.listProjects();
      projects.push(...all.map(p => p.label || p.id));
    }

    let processed = 0;
    outer:
    for (const label of projects) {
      const project = await store.read(label);
      if (!project) continue;
      const projectContext: SubstanceProjectContext = {
        title: project.title,
        overview: projectOverviewLines(project.content ?? ''),
      };
      const rows = store.listProjectSessionsByActivity(project.id, 1000);
      for (const { id: sessionId, lastActivity } of rows) {
        if (opts.limit != null && processed >= opts.limit) break outer;
        const session = await store.read(sessionId);
        if (!session || session.metadata.kind !== KIND_SESSION) continue;
        const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
        if (!summaryNode) continue;
        const existing = parseSessionSubstance(summaryNode.metadata.substance);
        if (existing) {
          counts.already += 1;
          continue;
        }

        if (await isSessionLiveForBackfill(store, sessionId, lastActivity)) {
          counts.skipped += 1;
          continue;
        }

        const summaries = await sessionSummaryTexts(store, sessionId);
        const exchangeCount = Number(session.metadata.exchange_count) || 0;
        let verdict: SessionSubstance;
        if (summaries.length === 0 && exchangeCount < 3) {
          verdict = 'none';
        } else if (summaries.length === 0) {
          counts.skipped += 1;
          continue;
        } else {
          const combined = summaries.join('\n\n').trim();
          const fromLlm = await generateSubstanceVerdict(combined, undefined, projectContext);
          if (!fromLlm) {
            counts.failed += 1;
            processed += 1;
            continue;
          }
          verdict = fromLlm;
        }

        if (!opts.dryRun) {
          await updateWithBusyRetry(store, summaryNode.id, {
            metadata: { substance: verdict },
          });
        }
        counts[verdict] += 1;
        processed += 1;
      }
    }
    return counts;
  } finally {
    store.close();
  }
}

function seqRange(batch: UnsummarizedBatch): { seqFrom: number; seqTo: number } {
  const seqs = batch.exchanges.map(e => e.seq);
  return { seqFrom: Math.min(...seqs), seqTo: Math.max(...seqs) };
}

function entryText(entry: Entry): string {
  return [entry.title, entry.content].filter(Boolean).join('\n').trim();
}

const AUTOMATION_SUMMARY = 'No user content (automation).';
const TRIVIAL_SUMMARY = 'Session judged trivial.';
// First+last turns at this clip matched a full transcript on the skip decision
// (eval 3-session-substance) at about half the tokens.
const TURN_CLIP = 1500;
// argmax trivial alone is not enough: P=0.55 still hid a real blocker.
const TRIVIAL_MIN_P = 0.7;

const SUBSTANCE_QUESTION = {
  substance: {
    type: 'score' as const,
    instructions: 'How substantive is this session for future work?',
    criteria: ['trivial', 'some substance', 'major'],
  },
};

function clipTurn(text: string, max = TURN_CLIP): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function substanceTurns(batch: UnsummarizedBatch) {
  const turns = batch.exchanges;
  if (turns.length <= 8) return turns;
  const picked = new Set(turns.slice(0, 4).concat(turns.slice(-4)));
  return turns.filter(turn => picked.has(turn));
}

function substanceState(batch: UnsummarizedBatch): string {
  const meta = batch.sessionMeta;
  const header = [
    meta.title ? `title: ${clipTurn(meta.title, 120)}` : '',
    `session: ${batch.sessionId}`,
    meta.project ? `project: ${meta.project}` : '',
    meta.tool ? `tool: ${meta.tool}` : '',
    meta.date ? `date: ${meta.date.slice(0, 10)}` : '',
    meta.model ? `model: ${meta.model}` : '',
    meta.task_summary ? `task: ${clipTurn(meta.task_summary, 240)}` : '',
  ].filter(Boolean);
  const body = substanceTurns(batch).map(turn => {
    const user = `U${turn.seq}: ${clipTurn(turn.userContent)}`;
    const agent = turn.agentContent?.trim() ? `A${turn.seq}: ${clipTurn(turn.agentContent)}` : '';
    return agent ? `${user}\n${agent}` : user;
  }).join('\n\n');
  return `${header.join('\n')}\n\n${body}`;
}

/**
 * P(trivial) only when level 0 is the unique argmax and at least 0.7.
 * Any other answer, including a missing one, must not skip the summarizer.
 */
function trivialSkipProbability(answer: JevAnswer | undefined): number | null {
  if (!answer || answer.type !== 'score' || !answer.probabilities) return null;
  const p = answer.probabilities['0'];
  if (typeof p !== 'number' || !(p >= TRIVIAL_MIN_P)) return null;
  for (const [key, value] of Object.entries(answer.probabilities)) {
    if (key === '0') continue;
    if (typeof value === 'number' && value >= p) return null;
  }
  return p;
}

async function jevTrivialProbability(batch: UnsummarizedBatch): Promise<number | null> {
  try {
    const answers = await askJev('summarizer-substance', substanceState(batch), SUBSTANCE_QUESTION);
    return answers ? trivialSkipProbability(answers.substance) : null;
  } catch {
    return null;
  }
}

function batchHasOnlyEmptyUserTurns(batch: UnsummarizedBatch): boolean {
  return batch.exchanges.length > 0
    && batch.exchanges.every(e => !e.userContent.trim());
}

/** Process pending curation-queue entries via LLM (duplicates merge, decay confirm).
 *  Manual only (`tim consolidate run`) — never called from the summarizer (Benni 2026-09-24). */
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
      const { seqFrom, seqTo } = seqRange(batch);
      let summary: string;
      let tags: string[] | undefined;
      let substance: SessionSubstance | undefined;

      if (batchHasOnlyEmptyUserTurns(batch)) {
        summary = AUTOMATION_SUMMARY;
        substance = 'none';
      } else {
        const trivialP = await jevTrivialProbability(batch);
        if (trivialP != null) {
          summary = TRIVIAL_SUMMARY;
          substance = 'none';
          appendSummarizerLog(`SKIP jev-trivial session=${sessionId} P(trivial)=${trivialP}`);
        } else {
          const { text: raw, status } = await generateSummaryDetailed(batch, onMCPError);
          if (status !== 'ok') opts.onDegraded?.({ batchIndex: batch.batchIndex, status });

          if (raw === FALLBACK_MARKER) {
            summary =
              `${SUMMARY_FAILURE_MARKER} — main agent please resummarize batch ${batch.batchIndex}]\n` +
              `${batch.exchanges.map(e => `Q: ${e.userContent.trim().slice(0, 200)}`).join('\n')}`;
            tags = undefined;
          } else {
            const extracted = extractTags(raw);
            substance = extracted.substance;
            summary = extracted.body;
            tags = extracted.tags.length > 0 ? extracted.tags : undefined;
          }
        }
      }

      await callTimTool(client, 'tim_write_batch_summary', {
        sessionId,
        batchIndex: batch.batchIndex,
        summary,
        seqFrom,
        seqTo,
        ...(tags && { tags }),
        ...(substance && { substance }),
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
  const backfillOpts = parseBackfillSubstanceArgs(process.argv);
  if (backfillOpts) {
    try {
      const counts = await runBackfillSubstance(backfillOpts);
      const mode = backfillOpts.dryRun ? 'dry-run' : 'write';
      console.error(
        `tim-summarizer --backfill-substance (${mode}): ` +
        `none=${counts.none} low=${counts.low} real=${counts.real} ` +
        `skipped=${counts.skipped} already=${counts.already} failed=${counts.failed}`,
      );
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`tim-summarizer backfill-substance failed: ${msg}`);
      process.exit(1);
    }
  }

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
