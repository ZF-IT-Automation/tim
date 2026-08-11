import type { UnsummarizedBatch } from './mcp-client.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getConfigPath, getTimDir, loadConfig } from 'tim-core';

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

export function buildPrompt(batch: UnsummarizedBatch): string {
  // Only tags the project reused, frequency-ordered (the caller drops
  // singletons and the machine-stamped commit tags). "Verbatim" is the load
  // bearing word: the drift being fixed is not only invented topics but
  // respellings of agreed ones — #bugfix, #bugfixing and #bug-fixing all exist
  // side by side in P0062, and each new spelling splits the topic again.
  const vocabulary = batch.vocabulary?.length
    ? `\n\nTags this project already reuses, most used first: ` +
      `${batch.vocabulary.join(' ')}\n` +
      `If one of them fits, use it verbatim — same spelling, same hyphens. ` +
      `Mint a new tag only for a subject none of them names.`
    : '';

  return (
    `Summarize this agent session batch thematically (bullet themes, decisions, open items). ` +
    `Batch index ${batch.batchIndex}. JSON:\n${JSON.stringify({
      exchanges: batch.exchanges,
      previousSummaries: batch.previousSummaries,
      sessionMeta: batch.sessionMeta,
    })}\n\n` +
    // A tag exists to be searched for later, so it has to name the thing the
    // work was about. Asking for 3-5 on a batch about one subject forces
    // padding, and padded tags are where the one-off inventions come from:
    // 407 of 509 tags in this database are used exactly once.
    `End your response with a line: TAGS: #tag1 #tag2 ... (1-3 content hashtags, lowercase kebab-case, # prefix). ` +
    `A tag names a feature, subsystem or subject that could have its own file or spec — ` +
    `#session-continuity, #summarizer, #topic-recall, #tim-viewer. ` +
    `Not an activity (#testing, #debugging, #refactoring), not a container (#queue, #tasks), ` +
    `not the project itself (#tim, #hermes). ` +
    `One precise tag is better than three padded ones; if only one subject fits, give one.` +
    vocabulary
  );
}

export const FALLBACK_MARKER = 'TIM_SUMMARIZER_FALLBACK_NEEDED';

/**
 * How a summary was produced. Anything other than 'ok' means the stored text is
 * degraded (marker or raw transcript), not a real summary.
 */
export type SummaryStatus = 'ok' | 'no-chain' | 'heuristic';

export interface SummaryResult {
  text: string;
  status: SummaryStatus;
}

/** Actionable operator message — a missing chain is config, not a transient CLI failure. */
export function noChainHint(): string {
  return (
    `no summarizer chain configured — summaries are NOT being generated. ` +
    `Add a "summarizer" block to ${getConfigPath()}, e.g. ` +
    `"summarizer": { "chain": [{ "cli": "opencode", "model": "claude-3-5-haiku", "provider": "anthropic" }], "timeout_sec": 600 }`
  );
}

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

export async function tryCli(
  cli: string,
  model: string,
  provider: string | undefined,
  prompt: string,
  timeoutSec: number,
  onError?: ErrorLogFn,
  extraArgs: string[] = [],
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
    // --pure disables external plugins. Without it, anything a plugin prints on
    // session.created lands in stdout ahead of the model's answer and gets stored
    // as the summary — including TIM's own session-start directive, which is how
    // a briefing ended up saved as a session summary.
    args = ['run', '-m', fullModel, '--pure', '--print-logs'];
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
      [...args, ...extraArgs],
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

function buildSessionRollupPrompt(batchSummaries: string[]): string {
  const joined = batchSummaries.join('\n\n---\n\n');
  return (
    `You are condensing the batch summaries of ONE agent session into a handoff ` +
    `for the next session on the same work.\n\n` +
    `Cover, in this order:\n` +
    `- What was done in this session\n` +
    `- Current state (what works, what is half-finished)\n` +
    `- Open threads / unresolved questions\n` +
    `- The single most likely next step\n\n` +
    `Format: 4-6 short bullets, 200 words max. Output ONLY the bullets, no preamble.\n\n` +
    `Batch summaries (chronological):\n${joined}`
  );
}

/**
 * Condense one session's batch summaries into a next-session handoff via the CLI chain.
 * Returns null on total failure (no chain, no input, or every CLI failed) so the caller
 * can fall back to plain concatenation instead of storing a degraded blob.
 */
export async function generateSessionRollup(
  batchSummaries: string[],
  onError?: ErrorLogFn,
): Promise<string | null> {
  const config = loadConfig();
  const chain = config.summarizer?.chain;
  if (!chain || chain.length === 0) {
    appendSummarizerLog(`NO_CHAIN session rollup: ${noChainHint()}`);
    return null;
  }
  if (batchSummaries.length === 0) return null;

  const prompt = buildSessionRollupPrompt(batchSummaries);
  const timeoutSec = config.summarizer?.timeout_sec ?? 600;

  for (const entry of chain) {
    const result = await tryCli(entry.cli, entry.model, entry.provider, prompt, timeoutSec, onError, entry.args);
    if (result) {
      if (process.env.TIM_SUMMARIZER_VERBOSE) {
        console.error(`tim-summarizer: session rollup via ${entry.label || entry.cli}/${entry.model}`);
      }
      return result;
    }
  }
  return null;
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
  if (!chain || chain.length === 0) {
    appendSummarizerLog(`NO_CHAIN project summary: ${noChainHint()}`);
    return null;
  }
  if (sessionSummaries.length === 0) return null;

  const prompt = buildProjectSummaryPrompt(sessionSummaries);
  const timeoutSec = config.summarizer?.timeout_sec ?? 600;

  for (const entry of chain) {
    const result = await tryCli(entry.cli, entry.model, entry.provider, prompt, timeoutSec, onError, entry.args);
    if (result) {
      if (process.env.TIM_SUMMARIZER_VERBOSE) {
        console.error(`tim-summarizer: project summary via ${entry.label || entry.cli}/${entry.model}`);
      }
      return result;
    }
  }
  return null;
}

/**
 * Summarize a batch and report *how* it was produced, so a caller can tell a real
 * summary apart from the marker / heuristic transcript that both get stored verbatim.
 */
export async function generateSummaryDetailed(
  batch: UnsummarizedBatch,
  onError?: ErrorLogFn,
): Promise<SummaryResult> {
  const config = loadConfig();
  const chain = config.summarizer?.chain;
  if (!chain || chain.length === 0) {
    // Config problem, not a CLI failure — say so on stderr and in the log instead
    // of routing it through onError, which reports per-CLI failures.
    const hint = noChainHint();
    appendSummarizerLog(`NO_CHAIN batch ${batch.batchIndex}: ${hint}`);
    console.error(`tim-summarizer: ${hint}`);
    return { text: FALLBACK_MARKER, status: 'no-chain' };
  }

  const prompt = buildPrompt(batch);
  const timeoutSec = config.summarizer?.timeout_sec ?? 600;

  for (const entry of chain) {
    const result = await tryCli(entry.cli, entry.model, entry.provider, prompt, timeoutSec, onError, entry.args);
    if (result) {
      if (process.env.TIM_SUMMARIZER_VERBOSE) {
        console.error(`tim-summarizer: used ${entry.label || entry.cli}/${entry.model}`);
      }
      return { text: result, status: 'ok' };
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
  return { text: heuristic, status: 'heuristic' };
}

export async function generateSummary(batch: UnsummarizedBatch, onError?: ErrorLogFn): Promise<string> {
  return (await generateSummaryDetailed(batch, onError)).text;
}
