import { CHARS_PER_TOKEN } from 'tim-store';

/** Shared maximum for explicit tokenBudget parameters and clamped config defaults. */
export const MAX_TOKEN_BUDGET = 64000;

/** @deprecated Use MAX_TOKEN_BUDGET — kept for existing importers. */
export const MAX_TOKEN_BUDGET_PARAM = MAX_TOKEN_BUDGET;

export const DEFAULT_BRIEFING_TOKEN_BUDGET = 9000;

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
  return Math.max(1, Math.ceil(bytes / CHARS_PER_TOKEN));
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

  const units = [...text];
  let lo = 0;
  let hi = units.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTextTokens(units.slice(0, mid).join('')) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (lo === 0 && units.length > 0) return units[0] ?? '';
  return units.slice(0, lo).join('');
}

/** Charge up to maxTokens from text; returns rendered slice and whether it was truncated. */
export function chargePartialTokens(
  ledger: TokenBudgetLedger,
  text: string,
  maxTokens?: number,
): { text: string; charged: number; truncated: boolean } {
  const cap = maxTokens ?? ledger.remaining;
  if (cap <= 0 || !text) return { text: '', charged: 0, truncated: !!text };

  const built = clipToTokenBudget(text, cap);
  const truncated = built.length < text.length;
  const finalText = truncated ? `${built.trimEnd()}…` : built;
  const charged = Math.min(estimateTextTokens(finalText), ledger.remaining);
  ledger.used += charged;
  ledger.remaining -= charged;
  return { text: finalText, charged, truncated };
}

/** Final safety clamp on an assembled MCP response string. */
export function boundRenderedText(text: string, tokenBudget: number): {
  text: string;
  truncated: boolean;
  estimatedTokens: number;
} {
  const estimated = estimateTextTokens(text);
  if (estimated <= tokenBudget) {
    return { text, truncated: false, estimatedTokens: estimated };
  }

  const ellipsis = '…';
  const ellipsisCost = estimateTextTokens(ellipsis);
  const contentBudget = Math.max(1, tokenBudget - ellipsisCost);
  let clipped = clipToTokenBudget(text, contentBudget);
  if (clipped.length === 0) clipped = clipToTokenBudget(text, tokenBudget);
  const wasShortened = clipped.length < text.length || estimateTextTokens(text) > tokenBudget;
  const finalText = wasShortened ? `${clipped.trimEnd()}${ellipsis}` : clipped;
  const finalEstimate = estimateTextTokens(finalText);
  if (finalEstimate > tokenBudget) {
    const tighter = clipToTokenBudget(text, Math.max(1, tokenBudget));
    return {
      text: tighter.length < text.length ? `${tighter}${ellipsis}` : tighter,
      truncated: true,
      estimatedTokens: Math.min(estimateTextTokens(tighter), tokenBudget),
    };
  }
  return {
    text: finalText,
    truncated: true,
    estimatedTokens: Math.min(finalEstimate, tokenBudget),
  };
}
