/**
 * How long a batch summary is allowed to be, and how much of one is rendered.
 *
 * Shared by the summarizer (which asks the model for it) and by the readers
 * that render summaries back, so the budget is stated once. Without a stated
 * budget the models had none: measured over 553 batch summaries in the live
 * database the median is 637 characters, but the top decile runs past 2440 and
 * the longest is 4953 — and a topic recall renders ten of them at once, so one
 * call spent 33k characters before the reader did anything.
 */

/**
 * The budget put to the model. Chosen from that distribution rather than from
 * taste: it leaves the median summary untouched and only bites on the third of
 * them that were running free.
 */
export const BATCH_SUMMARY_MAX_CHARS = 1200;

/**
 * Where a renderer cuts. Deliberately above the budget — a model that overshoots
 * a little is still doing its job, and cutting at exactly the limit would
 * truncate summaries that are fine. Anything past this is not overshoot.
 */
export const BATCH_SUMMARY_RENDER_CHARS = Math.round(BATCH_SUMMARY_MAX_CHARS * 1.2);

/**
 * Cut a summary for display, naming what it takes to see the rest. Cuts on a
 * line boundary when there is one nearby, since these summaries are bullet
 * lists and half a bullet reads as a different claim than the whole one.
 */
export function truncateSummary(
  text: string,
  id: string,
  maxChars: number = BATCH_SUMMARY_RENDER_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  let body = (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd();

  // A cut that lands just after a heading leaves the heading promising content
  // that is not there — "### Open items" followed by nothing reads as "there are
  // none", which is a false statement rather than a shortened true one. Measured
  // on a real summary: the cut fell exactly there.
  const lines = body.split('\n');
  while (lines.length && /^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$)/.test(lines[lines.length - 1]!)) {
    lines.pop();
  }
  body = lines.join('\n').trimEnd();

  return `${body}\n  […] full summary: tim_read({ id: "${id}" })`;
}
