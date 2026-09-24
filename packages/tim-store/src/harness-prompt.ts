import type { Entry } from 'tim-core';

/** Harness-injected XML blocks that are not human user turns. */
const HARNESS_BLOCK_TAGS = [
  'task-notification',
  'system-reminder',
  'local-command-caveat',
  'command-name',
] as const;

function blockPattern(tag: string): RegExp {
  return new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
}

/** Remove harness-only XML blocks from stored user text. */
export function stripHarnessBlocks(text: string): string {
  let out = text;
  for (const tag of HARNESS_BLOCK_TAGS) {
    out = out.replace(blockPattern(tag), '');
  }
  // Only complete blocks are removed; an unclosed tag may be followed by human text.
  return out.trim();
}

/** True when the prompt is only harness blocks (no human text remains after strip). */
export function isHarnessOnlyPrompt(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  return stripHarnessBlocks(raw).length === 0;
}

export interface SanitizedUserContent {
  content: string;
  systemTurn: boolean;
}

/** Strip harness blocks; flag when nothing human remains. */
export function sanitizeUserExchangeContent(raw: string): SanitizedUserContent {
  const stripped = stripHarnessBlocks(raw);
  const systemTurn = stripped.length === 0 && raw.trim().length > 0;
  return { content: stripped, systemTurn };
}

function entryText(entry: Entry): string {
  const title = entry.title.trim();
  const body = entry.content.trim();
  return [title, body].filter(Boolean).join('\n');
}

/** Whether a logged user exchange counts toward exchange_count and briefing turns. */
export function isCountableUserExchange(entry: Entry): boolean {
  if (entry.metadata.system_turn === true) return false;
  const text = entryText(entry);
  if (!text.trim()) return false;
  return !isHarnessOnlyPrompt(text);
}

/** Skip prompt-submit recall and topic hits from harness plumbing or flagged turns. */
export function shouldSkipPromptRecall(entry: Entry): boolean {
  if (entry.metadata.system_turn === true) return true;
  if (entry.metadata.kind === 'exchange' && entry.metadata.role === 'user') {
    const text = entryText(entry);
    if (text.trim() && isHarnessOnlyPrompt(text)) return true;
  }
  return false;
}
