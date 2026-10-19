/**
 * Planned-action verbs for the guard lookup: the English form plus German imperative,
 * infinitive and present forms (participles like "gepusht" report, they do not plan).
 * Each verb carries the terms a learning about it would use — FTS does not stem, so
 * "Deploye" finds nothing until "deploy" is added. Nouns ("Deployment", "Start",
 * "Installation", "Migration") and "ausführlich" deliberately do not match.
 * ponytail: hand-written forms, misses rarer conjugations; a stemmer if that matters.
 */
const VERBS: Array<[forms: string, terms: string[]]> = [
  ['push(?:e|en|st|t)?', ['push', 'pushen']],
  ['deploy(?:e|en|st|t)?', ['deploy', 'deployen']],
  ['upload(?:e|en|est|et)?|hochl(?:a|ä)d(?:e|en|st|t)?|l(?:a|ä)de(?=[^.!?\n]{0,60}(?<![\\p{L}\\p{N}])hoch(?![\\p{L}\\p{N}]))', ['upload', 'hochladen']],
  ['delete|l(?:ö|oe)sch(?:e|en|st|t)?', ['delete', 'löschen']],
  ['migrate|migrier(?:e|en|st|t)?', ['migrate', 'migrieren', 'migration']],
  ['(?:re)?install|(?:neu)?installier(?:e|en|st|t)?', ['install', 'installieren']],
  ['spawn(?:e|en|st|t)?', ['spawn']],
  ['run|execute|ausf(?:ü|ue)hr(?:e|en|st|t)?|f(?:ü|ue)hre(?=[^.!?\n]{0,60}(?<![\\p{L}\\p{N}])aus(?![\\p{L}\\p{N}]))', ['run', 'execute', 'ausführen']],
  ['commit(?:t?(?:e|en|est|et))?', ['commit', 'committen']],
  ['publish|ver(?:ö|oe)ffentlich(?:e|en|st|t)?', ['publish', 'veröffentlichen']],
  ['restart|neu\\s?start(?:e|en|est|et)|start(?:e|en)', ['restart', 'neustart', 'neustarten']],
  ['rmapi', ['rmapi']],
  ['drop', ['drop']],
  ['truncate', ['truncate']],
];

// \b is ASCII-only in JS even with the u flag: "Lösche" has no \b before the "ö".
const PATTERNS = VERBS.map(([forms, terms]) => ({
  re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms})(?![\\p{L}\\p{N}])`, 'giu'),
  terms,
}));

/** Action verbs in `text`: the words that matched (lowercased) and the terms to search. */
export function matchActionVerbs(text: string): Array<{ words: string[]; terms: string[] }> {
  const out: Array<{ words: string[]; terms: string[] }> = [];
  for (const { re, terms } of PATTERNS) {
    const words = [...text.matchAll(re)].flatMap(m => m[0].toLowerCase().split(/\s+/));
    if (words.length > 0) out.push({ words: [...new Set(words)], terms });
  }
  return out;
}
