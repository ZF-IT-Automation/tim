import type { Entry } from 'tim-core';
import {
  isHarnessOnlyPrompt,
  sanitizeUserExchangeContent,
  stripHarnessBlocks,
  type SanitizedUserContent,
} from 'tim-core';

export {
  stripHarnessBlocks,
  isHarnessOnlyPrompt,
  sanitizeUserExchangeContent,
  type SanitizedUserContent,
};

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
