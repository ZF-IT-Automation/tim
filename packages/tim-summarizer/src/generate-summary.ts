import type { UnsummarizedBatch } from './mcp-client.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig } from 'tim-core';

/** Compact thematic summary for a batch (no external API required). */
export function generateSummaryHeuristic(batch: UnsummarizedBatch): string {
  const lines = batch.exchanges.map(e => {
    const agent = e.agentContent?.trim() || '(no agent reply)';
    return `Q${e.seq}: ${e.userContent.trim()}\nA: ${agent}`;
  });
  const body = lines.join('\n\n');
  const prefix = batch.previousSummaries.length
    ? `Prior themes: ${batch.previousSummaries.slice(-2).join(' | ')}\n\n`
    : '';
  const meta = [
    batch.sessionMeta.project && `project=${batch.sessionMeta.project}`,
    batch.sessionMeta.tool && `tool=${batch.sessionMeta.tool}`,
    batch.sessionMeta.task_summary && `task=${batch.sessionMeta.task_summary}`,
  ]
    .filter(Boolean)
    .join(' ');

  let summary = `${prefix}Batch ${batch.batchIndex} (${batch.exchanges.length} exchanges)`;
  if (meta) summary += ` [${meta}]`;
  summary += `:\n${body}`;
  if (summary.length > 4000) summary = summary.slice(0, 3997) + '…';
  return summary;
}

function buildPrompt(batch: UnsummarizedBatch): string {
  return (
    `Summarize this agent session batch thematically (bullet themes, decisions, open items). ` +
    `Batch index ${batch.batchIndex}. JSON:\n${JSON.stringify({
      exchanges: batch.exchanges,
      previousSummaries: batch.previousSummaries,
      sessionMeta: batch.sessionMeta,
    })}`
  );
}

async function tryCli(
  cli: string,
  model: string,
  provider: string | undefined,
  prompt: string,
  timeoutSec: number,
): Promise<string | null> {
  const q = (s: string) => JSON.stringify(s);
  let cmd: string;
  if (cli === 'codex') {
    cmd = `echo ${q(prompt)} | codex exec --model ${q(model)} --skip-git-repo-check`;
  } else if (cli === 'opencode') {
    const fullModel = provider ? `${provider}/${model}` : model;
    cmd = `opencode run -m ${q(fullModel)} ${q(prompt)}`;
  } else {
    cmd = `${q(cli)} --model ${q(model)} --prompt ${q(prompt)}`;
    if (provider) cmd = `${q(cli)} --provider ${q(provider)} --model ${q(model)} --prompt ${q(prompt)}`;
  }

  try {
    const { stdout } = await promisify(exec)(cmd, {
      timeout: timeoutSec * 1000,
      maxBuffer: 64 * 1024,
    });
    let text = stdout.trim();
    if (cli === 'codex') {
      // Parse: ...\ncodex\n<response>\ntokens used\n...
      const codexMarker = '\ncodex\n';
      const idx = text.lastIndexOf(codexMarker);
      if (idx >= 0) {
        text = text.slice(idx + codexMarker.length);
        const tokenIdx = text.indexOf('\ntokens used\n');
        if (tokenIdx >= 0) text = text.slice(0, tokenIdx);
        text = text.trim();
      }
    }
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function buildProjectSummaryPrompt(sessionSummaries: string[]): string {
  const joined = sessionSummaries.join('\n\n---\n\n');
  return (
    `You are summarizing a project's progress across multiple sessions.\n` +
    `Below are summaries of the last N sessions. Produce a concise project-level summary.\n\n` +
    `Focus on:\n` +
    `- Overall progress toward project goals\n` +
    `- Key decisions made\n` +
    `- Recurring patterns or themes\n` +
    `- Current blockers or open items\n` +
    `- What changed since the last project summary\n\n` +
    `Format: 3-5 bullet points, 200 words max. Output ONLY the bullets, no preamble.\n\n` +
    `Session summaries:\n${joined}`
  );
}

/**
 * Aggregate session summaries into a project-level summary via the CLI chain.
 * Returns null on total failure (no chain, no input, or every CLI failed) —
 * caller must then write NOTHING, never a fallback marker into project content.
 */
export async function generateProjectSummary(
  sessionSummaries: string[],
): Promise<string | null> {
  const config = loadConfig();
  const chain = config.summarizer?.chain;
  if (!chain || chain.length === 0) return null;
  if (sessionSummaries.length === 0) return null;

  const prompt = buildProjectSummaryPrompt(sessionSummaries);
  const timeoutSec = config.summarizer?.timeout_sec ?? 600;

  for (const entry of chain) {
    const result = await tryCli(entry.cli, entry.model, entry.provider, prompt, timeoutSec);
    if (result) {
      if (process.env.TIM_SUMMARIZER_VERBOSE) {
        console.error(`tim-summarizer: project summary via ${entry.label || entry.cli}/${entry.model}`);
      }
      return result;
    }
  }
  return null;
}

export const FALLBACK_MARKER = 'TIM_SUMMARIZER_FALLBACK_NEEDED';

export async function generateSummary(batch: UnsummarizedBatch): Promise<string> {
  const config = loadConfig();
  const chain = config.summarizer?.chain;
  if (!chain || chain.length === 0) return FALLBACK_MARKER;

  const prompt = buildPrompt(batch);
  const timeoutSec = config.summarizer?.timeout_sec ?? 600;

  for (const entry of chain) {
    const result = await tryCli(entry.cli, entry.model, entry.provider, prompt, timeoutSec);
    if (result) {
      if (process.env.TIM_SUMMARIZER_VERBOSE) {
        console.error(`tim-summarizer: used ${entry.label || entry.cli}/${entry.model}`);
      }
      return result;
    }
    if (process.env.TIM_SUMMARIZER_VERBOSE) {
      console.error(`tim-summarizer: ${entry.label || entry.cli}/${entry.model} failed, trying next`);
    }
  }

  // All CLIs failed — signal main agent to handle this batch
  if (process.env.TIM_SUMMARIZER_VERBOSE) {
    console.error('tim-summarizer: all CLIs failed, signaling main agent');
  }
  return FALLBACK_MARKER;
}
