import * as fs from 'fs';
import * as path from 'path';
import { getTimDir, loadConfig } from 'tim-core';
import { tryCli } from './generate-summary.js';

export const REMEMBER_FALLBACK_MARKER = 'TIM_REMEMBER_FALLBACK_NEEDED';

export interface RememberCandidate {
  id: string;
  title: string;
  excerpt: string;
  parents: Array<{ id: string; title: string }>;
}

export interface RememberQueryInput {
  query: string;
  candidates: RememberCandidate[];
  batchSummaries?: Array<{ id: string; title: string; excerpt: string }>;
  topK: number;
}

export interface RankedCandidate {
  node_id: string;
  confidence: number;
  reasoning: string;
}

export interface RerankResult {
  ranked: RankedCandidate[] | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  fallback: 'none' | 'timeout' | 'error' | 'all_chain_failed' | 'invalid_json';
}

export function buildRerankPrompt(input: RememberQueryInput): string {
  return (
    `You are a TIM memory recall assistant. Your ONLY task: rank the candidates below ` +
    `by semantic relevance to the user's query.\n\n` +
    `Query: "${input.query}"\n\n` +
    `Candidates (${input.candidates.length} total):\n` +
    `${JSON.stringify(input.candidates, null, 0)}\n\n` +
    (input.batchSummaries?.length
      ? `Recent batch summaries (recency context):\n${JSON.stringify(input.batchSummaries)}\n\n`
      : '') +
    `Return a strict JSON array, sorted by confidence descending, max ${input.topK * 2} entries:\n` +
    `[{"node_id": "<ULID>", "confidence": <0.0-1.0>, "reasoning": "<max 120 chars>"}]\n\n` +
    `Rules:\n` +
    `- confidence = YOUR semantic-relevance estimate (not word-match).\n` +
    `- Skip candidates with confidence < 0.2 (don't include them).\n` +
    `- Output ONLY the JSON array, no prose, no markdown fences.\n` +
    `- If no candidate matches, return [].\n` +
    `- If the chain fails entirely, output exactly: ${REMEMBER_FALLBACK_MARKER}\n`
  );
}

export function parseRerankOutput(text: string, maxTopK: number): RankedCandidate[] | null {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const ranked: RankedCandidate[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const nodeId = row.node_id;
    const confidence = row.confidence;
    const reasoning = row.reasoning;
    if (
      typeof nodeId === 'string' &&
      typeof confidence === 'number' &&
      confidence >= 0 &&
      confidence <= 1 &&
      typeof reasoning === 'string'
    ) {
      ranked.push({
        node_id: nodeId,
        confidence,
        reasoning: reasoning.slice(0, 120),
      });
    }
  }

  ranked.sort((a, b) => b.confidence - a.confidence);
  return ranked.slice(0, maxTopK * 2);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function appendRememberLog(line: string): void {
  try {
    const logPath = path.join(getTimDir(), 'remember.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore log write failures
  }
}

export async function rememberRerank(input: RememberQueryInput): Promise<RerankResult> {
  const config = loadConfig();
  const chain = config.remember?.chain;
  if (!chain || chain.length === 0) {
    return {
      ranked: null,
      model: 'none',
      tokensIn: 0,
      tokensOut: 0,
      fallback: 'all_chain_failed',
    };
  }

  const prompt = buildRerankPrompt(input);
  const timeoutSec = config.remember?.timeout_sec ?? 5;

  for (const entry of chain) {
    const result = await tryCli(entry.cli, entry.model, entry.provider, prompt, timeoutSec);
    if (!result) continue;

    const label = entry.provider
      ? `${entry.cli}/${entry.provider}/${entry.model}`
      : `${entry.cli}/${entry.model}`;

    if (result === REMEMBER_FALLBACK_MARKER) continue;

    const ranked = parseRerankOutput(result, input.topK);
    if (ranked === null) {
      appendRememberLog(`INVALID_JSON ${label}: ${result.slice(0, 200)}`);
      continue;
    }

    return {
      ranked,
      model: label,
      tokensIn: estimateTokens(prompt),
      tokensOut: estimateTokens(result),
      fallback: 'none',
    };
  }

  return {
    ranked: null,
    model: 'chain-exhausted',
    tokensIn: 0,
    tokensOut: 0,
    fallback: 'all_chain_failed',
  };
}

const isMain =
  process.argv[1]?.endsWith('remember-query.js') || process.argv[1]?.endsWith('remember-query.ts');
if (isMain) {
  let stdinData = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    stdinData += chunk;
  });
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(stdinData) as RememberQueryInput;
      const result = await rememberRerank(input);
      process.stdout.write(JSON.stringify(result));
    } catch {
      process.stdout.write(
        JSON.stringify({
          ranked: null,
          model: 'parse-error',
          tokensIn: 0,
          tokensOut: 0,
          fallback: 'error',
        }),
      );
    }
  });
}
