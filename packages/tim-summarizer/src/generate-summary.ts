import type { UnsummarizedBatch } from './mcp-client.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getTimDir, loadConfig } from 'tim-core';

function resolveEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  // Fallback: read from ~/.hermes/.env (Hermes env file)
  try {
    const envPath = path.join(os.homedir(), '.hermes', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const m = line.match(/^(\w+)=(.*)$/);
        if (m && m[1] === name) return m[2];
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export type ErrorLogFn = (tool: string, error: string, stack?: string) => void;

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
    })}\n\n` +
    `End your response with a line: TAGS: #tag1 #tag2 ... (3-5 content hashtags, lowercase kebab-case, # prefix).`
  );
}

export const FALLBACK_MARKER = 'TIM_SUMMARIZER_FALLBACK_NEEDED';

function normalizeTag(raw: string): string | null {
  let tag = raw.trim().toLowerCase();
  if (!tag.startsWith('#')) tag = `#${tag}`;
  const name = tag
    .slice(1)
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  if (!name) return null;
  return `#${name}`;
}

/** Parse TAGS line from LLM output; strip it from body. */
export function extractTags(text: string): { body: string; tags: string[] } {
  if (text === FALLBACK_MARKER) return { body: text, tags: [] };

  const lines = text.split('\n');
  let tagLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^TAGS:\s*/i.test(lines[i]!.trim())) {
      tagLineIdx = i;
      break;
    }
  }
  if (tagLineIdx < 0) return { body: text.trimEnd(), tags: [] };

  const tagLine = lines[tagLineIdx]!.trim();
  const tagPart = tagLine.replace(/^TAGS:\s*/i, '');
  const rawTags = tagPart.match(/#\S+/g) ?? [];

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTags) {
    const normalized = normalizeTag(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      tags.push(normalized);
    }
  }

  const body = [...lines.slice(0, tagLineIdx), ...lines.slice(tagLineIdx + 1)].join('\n').trimEnd();
  return { body, tags: tags.slice(0, 5) };
}

function appendSummarizerLog(line: string): void {
  try {
    const logPath = path.join(getTimDir(), 'summarizer.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore log write failures
  }
}

function runCliProcess(
  command: string,
  args: string[],
  prompt: string | null,
  timeoutSec: number,
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (prompt !== null) {
      child.stdin.write(prompt);
    }
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutSec * 1000);

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal, timedOut });
    });
  });
}

async function tryCli(
  cli: string,
  model: string,
  provider: string | undefined,
  prompt: string,
  timeoutSec: number,
  onError?: ErrorLogFn,
): Promise<string | null> {
  const label = provider ? `${cli}/${provider}/${model}` : `${cli}/${model}`;
  let command: string;
  let args: string[];
  let stdinPrompt: string | null;

  if (cli === 'codex') {
    command = 'codex';
    args = ['exec', '--model', model, '--skip-git-repo-check'];
    stdinPrompt = prompt;
  } else if (cli === 'opencode') {
    const fullModel = provider ? `${provider}/${model}` : model;
    command = 'opencode';
    args = ['run', '-m', fullModel, '--print-logs'];
    stdinPrompt = prompt;
  } else if (cli === 'curl-openrouter') {
    // Direct OpenRouter API call via curl — no CLI dependency.
    const apiKey = resolveEnvVar('OPENROUTER_API_KEY');
    if (!apiKey) {
      appendSummarizerLog(`FAIL curl-openrouter/${model}: OPENROUTER_API_KEY not set`);
      return null;
    }
    const payload = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2000,
    });
    command = 'curl';
    args = [
      '-s', 'https://openrouter.ai/api/v1/chat/completions',
      '-H', `Authorization: Bearer ${apiKey}`,
      '-H', 'Content-Type: application/json',
      '-d', payload,
      '--max-time', String(timeoutSec),
    ];
    stdinPrompt = null;
  } else {
    command = cli;
    args = provider
      ? ['--provider', provider, '--model', model, '--prompt', prompt]
      : ['--model', model, '--prompt', prompt];
    stdinPrompt = null;
  }

  try {
    const { stdout, stderr, code, signal, timedOut } = await runCliProcess(
      command,
      args,
      stdinPrompt,
      timeoutSec,
    );
    if (timedOut || code !== 0 || signal) {
      const detail = [
        timedOut ? `timeout=${timeoutSec}s` : null,
        `exit=${code ?? 'null'}`,
        signal ? `signal=${signal}` : null,
        stderr.trim() ? `stderr=${stderr.trim().slice(0, 4000)}` : null,
        stdout.trim() ? `stdout=${stdout.trim().slice(0, 1000)}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      appendSummarizerLog(`FAIL ${label}: ${detail}`);
      onError?.(label, detail);
      if (process.env.TIM_SUMMARIZER_VERBOSE) {
        console.error(`tim-summarizer: ${label} failed (${detail})`);
      }
      return null;
    }

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
    if (cli === 'curl-openrouter') {
      // Parse OpenRouter JSON response
      try {
        const json = JSON.parse(text);
        text = json?.choices?.[0]?.message?.content?.trim() || '';
        if (!text) {
          const detail = `empty content in OpenRouter response: ${stdout.slice(0, 500)}`;
          appendSummarizerLog(`FAIL ${label}: ${detail}`);
          onError?.(label, detail);
          return null;
        }
      } catch {
        const detail = `JSON parse error: ${stdout.slice(0, 500)}`;
        appendSummarizerLog(`FAIL ${label}: ${detail}`);
        onError?.(label, detail);
        return null;
      }
    }
    if (text.length === 0) {
      const detail = stderr.trim()
        ? `empty stdout; stderr=${stderr.trim().slice(0, 4000)}`
        : 'empty stdout';
      appendSummarizerLog(`FAIL ${label}: ${detail}`);
      onError?.(label, detail);
      if (process.env.TIM_SUMMARIZER_VERBOSE) {
        console.error(`tim-summarizer: ${label} ${detail}`);
      }
      return null;
    }
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendSummarizerLog(`FAIL ${label}: spawn error: ${msg}`);
    onError?.(label, `spawn error: ${msg}`, err instanceof Error ? err.stack : undefined);
    if (process.env.TIM_SUMMARIZER_VERBOSE) {
      console.error(`tim-summarizer: ${label} error: ${msg}`);
    }
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
  onError?: ErrorLogFn,
): Promise<string | null> {
  const config = loadConfig();
  const chain = config.summarizer?.chain;
  if (!chain || chain.length === 0) return null;
  if (sessionSummaries.length === 0) return null;

  const prompt = buildProjectSummaryPrompt(sessionSummaries);
  const timeoutSec = config.summarizer?.timeout_sec ?? 600;

  for (const entry of chain) {
    const result = await tryCli(entry.cli, entry.model, entry.provider, prompt, timeoutSec, onError);
    if (result) {
      if (process.env.TIM_SUMMARIZER_VERBOSE) {
        console.error(`tim-summarizer: project summary via ${entry.label || entry.cli}/${entry.model}`);
      }
      return result;
    }
  }
  return null;
}

export async function generateSummary(batch: UnsummarizedBatch, onError?: ErrorLogFn): Promise<string> {
  const config = loadConfig();
  const chain = config.summarizer?.chain;
  if (!chain || chain.length === 0) return FALLBACK_MARKER;

  const prompt = buildPrompt(batch);
  const timeoutSec = config.summarizer?.timeout_sec ?? 600;

  for (const entry of chain) {
    const result = await tryCli(entry.cli, entry.model, entry.provider, prompt, timeoutSec, onError);
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

  // All CLIs failed — fall back to heuristic summary
  if (process.env.TIM_SUMMARIZER_VERBOSE) {
    console.error('tim-summarizer: all CLIs failed, using heuristic fallback');
  }
  const heuristic = generateSummaryHeuristic(batch);
  appendSummarizerLog(`HEURISTIC batch ${batch.batchIndex}: ${heuristic.slice(0, 200)}`);
  return heuristic;
}
