/**
 * How long a batch summary is allowed to be, and how much of one is rendered.
 *
 * Shared by the summarizer (which asks the model for it) and by the readers
 * that render summaries back, so the budget is stated once. Without a stated
 * budget the models had none: measured over the 445 batch summaries in the live
 * database the median is 915 characters, but the top decile runs past 2715 and
 * the longest is 4953 — and a topic recall renders ten of them at once, so one
 * call spent 33k characters before the reader did anything.
 *
 * Count entries of kind `batch-summary`, never entries tagged `#batch-summary`:
 * a batch summary carries `#session-summary` too, so a tag query conflates them
 * with the session roots and inflates every figure derived from it.
 */

/**
 * The budget put to the model. Chosen from that distribution rather than from
 * taste: it sits above the median, so a typical summary is unaffected, and binds
 * the 40% that were running past it.
 */
export const BATCH_SUMMARY_MAX_CHARS = 1200;

/**
 * Where a renderer cuts. Deliberately above the budget — a model that overshoots
 * a little is still doing its job, and cutting at exactly the limit would
 * truncate summaries that are fine. Anything past this is not overshoot.
 */
export const BATCH_SUMMARY_RENDER_CHARS = Math.round(BATCH_SUMMARY_MAX_CHARS * 1.2);

/**
 * Total characters of batch summaries a session rollup may be given. Without it
 * the rollup prompt concatenated them raw: measured across the 312 sessions that
 * have batch summaries, the worst fed 52,617 characters — about 13k tokens —
 * into the free model on every session end.
 */
export const ROLLUP_INPUT_MAX_CHARS = 20000;

/**
 * How much of each batch summary a rollup over `count` of them may read.
 *
 * Shrinks the per-batch allowance rather than dropping batches: a rollup is
 * supposed to cover the whole session, and dropping the early ones would lose
 * how the session started while leaving the total just as unbounded.
 */
export function rollupInputBudget(count: number): number {
  if (count <= 0) return BATCH_SUMMARY_RENDER_CHARS;
  return Math.min(BATCH_SUMMARY_RENDER_CHARS, Math.floor(ROLLUP_INPUT_MAX_CHARS / count));
}

/**
 * Cut on a line boundary when there is one nearby: these summaries are bullet
 * lists, and half a bullet reads as a different claim than the whole one. Also
 * drops a heading the cut would leave empty — "### Open items" followed by
 * nothing reads as "there are none", which is a false statement rather than a
 * shortened true one. Measured on a real summary: the cut fell exactly there.
 */
function cutAtLine(text: string, maxChars: number): string {
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  const body = (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd();
  const lines = body.split('\n');
  while (lines.length && /^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$)/.test(lines[lines.length - 1]!)) {
    lines.pop();
  }
  return lines.join('\n').trimEnd();
}

/**
 * Cut a summary being fed to another prompt. No `tim_read` pointer: the reader
 * is a model that cannot follow one, and an id it cannot use is an invitation
 * to hallucinate having read the rest.
 */
export function clampForPrompt(
  text: string,
  maxChars: number = BATCH_SUMMARY_RENDER_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${cutAtLine(text, maxChars)}\n[…]`;
}

/**
 * Cut a summary for display, naming what it takes to see the rest.
 */
export function truncateSummary(
  text: string,
  id: string,
  maxChars: number = BATCH_SUMMARY_RENDER_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${cutAtLine(text, maxChars)}\n  […] full summary: tim_read({ id: "${id}" })`;
}
