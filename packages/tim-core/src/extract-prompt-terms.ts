import { isHarnessOnlyPrompt } from './harness-prompt.js';

/** German and English function words stripped from natural-language prompts. */
export const PROMPT_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'via', 'into', 'your',
  'how', 'what', 'when', 'where', 'why', 'can', 'could', 'would', 'should',
  'have', 'has', 'had', 'are', 'was', 'were', 'been', 'being', 'will', 'about',
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem',
  'und', 'mit', 'von', 'für', 'auf', 'ist', 'nicht', 'wie', 'was', 'wann',
  'wo', 'warum', 'kann', 'können', 'haben', 'hat', 'sind', 'war', 'wurde',
  'werden', 'wird', 'über', 'dass', 'auch', 'noch', 'schon', 'nur', 'oder',
  'ich', 'mir', 'mich', 'dieses', 'dieser', 'diesem', 'diese', 'beim', 'zum',
]);

/**
 * Extract content-bearing terms from a natural-language prompt.
 * Strips DE/EN function words; keeps Unicode letters and digits.
 */
export function extractPromptTerms(prompt: string, minLength = 3): string[] {
  if (isHarnessOnlyPrompt(prompt)) return [];
  return prompt
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= minLength && !PROMPT_STOP_WORDS.has(w));
}

/**
 * Build an OR-joined FTS query for prompt recall. Falls back to the trimmed
 * prompt when no content terms survive stop-word removal.
 */
export function buildPromptSearchQuery(prompt: string): string {
  if (isHarnessOnlyPrompt(prompt)) return '';
  const terms = extractPromptTerms(prompt);
  if (terms.length === 0) return prompt.trim();
  return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
