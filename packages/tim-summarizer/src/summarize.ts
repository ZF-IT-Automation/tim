#!/usr/bin/env node
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from 'tim-core';
import { TimStore } from 'tim-store';
import { connectTimMcp, callTimTool, type UnsummarizedBatch } from './mcp-client.js';
import {
  generateSummary,
  generateProjectSummary,
  extractTags,
  FALLBACK_MARKER,
} from './generate-summary.js';

export const PROJECT_SUMMARY_MARKER = '## Project Summary';

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
  const result = await store.loadProject(label);
  if (!result) throw new Error(`Project not found: ${label}`);

  const summaries = result.children
    .filter(c => c.tags.includes('#session-summary'))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(c => (c.content?.trim() || c.title.trim()))
    .filter(Boolean);
  if (summaries.length === 0) return false;

  const summary = await generateProjectSummary(summaries);
  if (!summary) return false; // total CLI failure → write nothing

  const newContent = mergeProjectSummary(result.project.content, summary);
  // Pass title too: store.update() strips the first content line as title
  // when patch.title is undefined and the entry already has a title.
  await store.update(result.project.id, {
    title: result.project.title,
    content: newContent,
  });
  return true;
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

export async function runSummarizerLoop(sessionId: string): Promise<number> {
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
      const raw = await generateSummary(batch, onMCPError);
      const { seqFrom, seqTo } = seqRange(batch);
      let summary: string;
      let tags: string[] | undefined;

      if (raw === FALLBACK_MARKER) {
        summary =
          `[ALL SUMMARIZER CLIs FAILED — main agent please resummarize batch ${batch.batchIndex}]\n` +
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
    await client.close();
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
    const count = await runSummarizerLoop(sessionId);
    console.error(`tim-summarizer: wrote ${count} batch summary(ies) for ${sessionId}`);
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
