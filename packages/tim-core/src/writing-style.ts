/**
 * How everything TIM stores is written. Benni 2026-10-04: briefings, summaries and
 * entries are read by agents, almost never by people, and caveman style stays
 * readable for the rare human — so every writer uses it.
 *
 * Measured on 8 real batches (claude/haiku, 2 runs each): with the rule placed
 * right before the format trailer, summaries came out 9% shorter and carried
 * markedly more hashes, numbers and commands per character. Placed at the top of
 * a long prompt the model ignored it, so callers put it next to the format part.
 */
export const CAVEMAN_STYLE =
  'Write in caveman style: terse fragments, every word carries information. Drop articles ' +
  '(a, an, the), filler (just, really, basically, actually, successfully), pleasantries, hedging, ' +
  'connectives and restated context. No intro or title line, no prose paragraphs. Use → = + / ' +
  "instead of verbs like 'was changed to'. Keep exactly: code, commands, paths, URLs, identifiers, " +
  'commit hashes, numbers, versions, dates, names, and every format line asked for. ' +
  "Not 'The dashboard layout was moved from the browser's localStorage to the server so that all " +
  "devices see the same layout.' but 'Dashboard layout: localStorage → server (same on all devices).'";

/** The one-line form for tool descriptions, which every session pays for. */
export const CAVEMAN_STYLE_SHORT =
  'Caveman style: terse fragments, no articles/filler/hedging; code, paths, ids, hashes, numbers exact.';
