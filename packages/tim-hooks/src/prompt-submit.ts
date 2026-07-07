import { loadConfig } from 'tim-core';
import type { TimStore } from 'tim-store';

const DEFAULT_TIMEOUT_MS = 1000;
const RETRIEVAL_TOP_K = 3;

/** Prompt looks like a planned action — run tim_guard-style failure lookup. */
const ACTION_PATTERN =
  /\b(run|deploy|upload|push|delete|migrate|install|spawn|execute|commit|publish|rmapi|restart|drop|truncate)\b/i;

export interface PromptSubmitParams {
  prompt: string;
  projectLabel?: string;
  timeoutMs?: number;
}

export interface PromptSubmitResult {
  lines: string[];
  context: string;
}

function excerpt(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function looksLikeAction(prompt: string): boolean {
  return ACTION_PATTERN.test(prompt);
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

async function computePromptContext(
  store: TimStore,
  params: PromptSubmitParams,
): Promise<PromptSubmitResult | null> {
  const query = params.prompt.trim();
  if (!query) return null;

  const lines: string[] = [];

  let hits = await store.search({
    query,
    topK: RETRIEVAL_TOP_K * 3,
    searchType: 'fts',
  });

  if (params.projectLabel) {
    hits = hits.filter(e => store.getProjectLabel(e.id) === params.projectLabel);
  }

  for (const hit of hits.slice(0, RETRIEVAL_TOP_K)) {
    const label = hit.title?.trim() || hit.id;
    lines.push(`TIM erinnert: ${label} — ${excerpt(hit.content || hit.title)}`);
  }

  if (looksLikeAction(query)) {
    const failures = await store.searchFailures(query, {
      projectLabel: params.projectLabel,
      limit: 3,
    });
    for (const f of failures) {
      const kind = typeof f.metadata.kind === 'string' ? f.metadata.kind : 'warning';
      lines.push(`TIM guard (${kind}): ${f.title} [${f.id}] — ${excerpt(f.content)}`);
    }
  }

  if (lines.length === 0) return null;
  return { lines, context: lines.join('\n') };
}

/**
 * UserPromptSubmit hook: hybrid FTS retrieval + optional guard warnings.
 * Never throws; returns null when disabled, empty, slow, or on error.
 */
export async function runPromptSubmit(
  store: TimStore,
  params: PromptSubmitParams,
): Promise<PromptSubmitResult | null> {
  const config = loadConfig();
  if (config.hooks?.promptSubmit?.enabled === false) return null;

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    return await raceWithTimeout(computePromptContext(store, params), timeoutMs);
  } catch {
    return null;
  }
}
