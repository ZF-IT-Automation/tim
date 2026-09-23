/** Shared maximum for explicit tokenBudget parameters and clamped config defaults. */
export const MAX_TOKEN_BUDGET = 64000;

/** Appended when a final safety clamp trims assembled briefing text. */
export const BRIEFING_TRUNCATION_MARKER = '… [briefing truncated to token budget]';

export function briefingTruncationSuffix(drillDown?: string): string {
  if (!drillDown?.trim()) return BRIEFING_TRUNCATION_MARKER;
  return `${BRIEFING_TRUNCATION_MARKER} — ${drillDown.trim()}`;
}

/** Hooks approximate tokens as CHARS_PER_TOKEN visible characters — reconcile with byte budget. */
export const HOOK_CHARS_PER_TOKEN = 4;

/** @deprecated Use MAX_TOKEN_BUDGET — kept for existing importers. */
export const MAX_TOKEN_BUDGET_PARAM = MAX_TOKEN_BUDGET;

export const DEFAULT_BRIEFING_TOKEN_BUDGET = 12288;

export type TokenBudgetValidation =
  | { ok: true; value: number }
  | { ok: false; message: string };

/**
 * Conservative tokenizer-independent estimate for rendered briefing text.
 * Uses UTF-8 byte length (not code points): emoji, CJK and German umlauts
 * occupy more bytes per visible character, so byte-based sizing is deliberately
 * conservative. This is not an exact model tokenizer count.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes;
}

/** Convert MCP UTF-8 byte budget to hook maxTokens (char-budget units). */
export function byteBudgetToHookMaxTokens(byteBudget: number): number {
  if (byteBudget <= 0) return 0;
  return Math.max(1, Math.floor(byteBudget / HOOK_CHARS_PER_TOKEN));
}

function truncationMarkerForBudget(limit: number, drillDown?: string): string {
  const marker = briefingTruncationSuffix(drillDown);
  const fullCost = estimateTextTokens(marker);
  if (limit >= fullCost) return marker;
  const short = BRIEFING_TRUNCATION_MARKER;
  if (limit >= estimateTextTokens(short)) return short;
  return limit >= 3 ? '…' : '.'.repeat(Math.max(0, limit));
}

/** Clamp configured briefing.maxTokens to a safe finite default. */
export function clampBriefingDefaultBudget(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_BRIEFING_TOKEN_BUDGET;
  }
  return Math.min(raw, MAX_TOKEN_BUDGET);
}

/** Validate an optional tokenBudget override; absent values fall back to defaultBudget. */
export function validateTokenBudget(
  raw: unknown,
  defaultBudget: number,
): TokenBudgetValidation {
  if (raw === undefined || raw === null) {
    return { ok: true, value: clampBriefingDefaultBudget(defaultBudget) };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, message: 'tokenBudget must be a finite integer' };
  }
  if (!Number.isInteger(raw)) {
    return { ok: false, message: 'tokenBudget must be a finite integer' };
  }
  if (raw <= 0) {
    return { ok: false, message: 'tokenBudget must be a positive integer' };
  }
  if (raw > MAX_TOKEN_BUDGET) {
    return { ok: false, message: `tokenBudget must be at most ${MAX_TOKEN_BUDGET}` };
  }
  return { ok: true, value: raw };
}

export interface TokenBudgetLedger {
  limit: number;
  used: number;
  remaining: number;
}

export function createTokenBudget(limit: number): TokenBudgetLedger {
  const safe = Math.max(0, Math.floor(limit));
  return { limit: safe, used: 0, remaining: safe };
}

export function tryChargeTokens(ledger: TokenBudgetLedger, text: string): boolean {
  const cost = estimateTextTokens(text);
  if (cost > ledger.remaining) return false;
  ledger.used += cost;
  ledger.remaining -= cost;
  return true;
}

function clipToTokenBudget(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  if (estimateTextTokens(text) <= maxTokens) return text;

  const units: string[] = [];
  let used = 0;
  for (const unit of text) {
    const cost = Buffer.byteLength(unit, 'utf8');
    if (used + cost > maxTokens) break;
    units.push(unit);
    used += cost;
  }
  return units.join('');
}

/** Charge up to maxTokens from text; returns rendered slice and whether it was truncated. */
export function chargePartialTokens(
  ledger: TokenBudgetLedger,
  text: string,
  maxTokens?: number,
  drillDown?: string,
): { text: string; charged: number; truncated: boolean } {
  const cap = Math.min(maxTokens ?? ledger.remaining, ledger.remaining);
  if (cap <= 0 || !text) return { text: '', charged: 0, truncated: !!text };

  const bounded = boundRenderedText(text, cap, drillDown);
  const finalText = bounded.text;
  const truncated = bounded.truncated;
  const charged = estimateTextTokens(finalText);
  ledger.used += charged;
  ledger.remaining -= charged;
  return { text: finalText, charged, truncated };
}

/** Final safety clamp on an assembled MCP response string. */
export function boundRenderedText(text: string, tokenBudget: number, drillDown?: string): {
  text: string;
  truncated: boolean;
  estimatedTokens: number;
} {
  const estimated = estimateTextTokens(text);
  if (estimated <= tokenBudget) {
    return { text, truncated: false, estimatedTokens: estimated };
  }

  const limit = Math.max(0, Math.floor(tokenBudget));
  const ellipsis = truncationMarkerForBudget(limit, drillDown);
  const ellipsisCost = estimateTextTokens(ellipsis);
  const contentBudget = Math.max(0, limit - ellipsisCost);
  const clipped = clipToTokenBudget(text, contentBudget);
  const finalText = `${clipped.trimEnd()}${ellipsis}`;
  const finalEstimate = estimateTextTokens(finalText);
  return {
    text: finalText,
    truncated: true,
    estimatedTokens: finalEstimate,
  };
}
