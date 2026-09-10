import { CHARS_PER_TOKEN } from 'tim-store';

/** Upper bound for explicit tokenBudget tool parameters (not config default). */
export const MAX_TOKEN_BUDGET_PARAM = 4000;

export type TokenBudgetValidation =
  | { ok: true; value: number }
  | { ok: false; message: string };

/**
 * Conservative Unicode-safe token estimate for rendered briefing text.
 * Uses code-point count, not UTF-16 length or byte length. Not an exact tokenizer.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const codePoints = [...text].length;
  return Math.max(1, Math.ceil(codePoints / CHARS_PER_TOKEN));
}

/** Validate an optional tokenBudget override; absent values fall back to defaultBudget. */
export function validateTokenBudget(
  raw: unknown,
  defaultBudget: number,
): TokenBudgetValidation {
  if (raw === undefined || raw === null) {
    return { ok: true, value: defaultBudget };
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
  if (raw > MAX_TOKEN_BUDGET_PARAM) {
    return { ok: false, message: `tokenBudget must be at most ${MAX_TOKEN_BUDGET_PARAM}` };
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

/** Charge up to maxTokens from text; returns rendered slice and whether it was truncated. */
export function chargePartialTokens(
  ledger: TokenBudgetLedger,
  text: string,
  maxTokens?: number,
): { text: string; charged: number; truncated: boolean } {
  const cap = maxTokens ?? ledger.remaining;
  if (cap <= 0 || !text) return { text: '', charged: 0, truncated: !!text };

  const chars = [...text];
  let built = '';
  for (const ch of chars) {
    const candidate = built + ch;
    if (estimateTextTokens(candidate) > cap) break;
    built = candidate;
  }

  if (built.length === 0 && chars.length > 0) {
    built = chars[0];
  }

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
  let clipped = text;
  while (clipped.length > 0 && estimateTextTokens(clipped) > tokenBudget) {
    clipped = [...clipped].slice(0, -1).join('');
  }
  if (clipped.length === 0) clipped = '…';
  const finalText = clipped.length < text.length ? `${clipped.trimEnd()}…` : clipped;
  const finalEstimate = estimateTextTokens(finalText);
  return {
    text: finalEstimate <= tokenBudget ? finalText : clipped,
    truncated: true,
    estimatedTokens: Math.min(finalEstimate, tokenBudget),
  };
}
