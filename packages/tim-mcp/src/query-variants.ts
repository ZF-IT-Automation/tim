/**
 * FTS5 pre-filter query variant expansion — deterministic, no DB/LLM.
 */

/** Hartkodierte Synonym-Mini-Map für Query-Expansion (Phase 1.0). */
export const SYNONYM_MAP: Map<string, string[]> = new Map([
  ['bug', ['error', 'issue', 'defect', 'failure']],
  ['task', ['todo', 'aufgabe']],
  ['worker', ['sub-agent', 'subagent']],
  ['telegram', ['bot', 'messenger']],
  ['config', ['einstellung', 'configuration', 'setting']],
  ['mcp', ['tool', 'server']],
  ['hook', ['callback', 'trigger', 'event']],
  ['lockfile', ['lock-file', 'lock file']],
  ['memory', ['erinnerung']],
  ['read', ['lesen', 'fetch', 'load']],
  ['write', ['schreiben', 'create', 'store']],
  ['search', ['suche', 'find', 'query']],
  ['error', ['fehler', 'bug', 'failure']],
  ['fix', ['repair', 'beheben', 'patch']],
  ['refactor', ['cleanup', 'aufräumen', 'restructure']],
  ['feature', ['funktion', 'capability']],
  ['test', ['spec', 'prüfung']],
  ['doc', ['doku', 'documentation']],
  ['session', ['sitzung']],
]);

const SUFFIXES = ['en', 'er', 'e', 's'] as const;
const FUZZY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Strip common DE/EN suffixes (-en, -er, -e, -s). Keeps result ≥3 chars or returns original.
 * Multi-word input: each token lemmatized separately.
 */
export function lemmatize(word: string): string {
  const tokens = word.split(/\s+/);
  const lemmatized = tokens.map((token) => lemmatizeToken(token));
  return lemmatized.join(' ');
}

function lemmatizeToken(token: string): string {
  let current = token;
  let changed = true;

  while (changed && current.length > 3) {
    changed = false;
    for (const suffix of SUFFIXES) {
      if (current.endsWith(suffix) && current.length - suffix.length >= 3) {
        current = current.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }

  return current.length >= 3 ? current : token;
}

/**
 * All Levenshtein-distance-1 variants: single-char insertions, deletions, substitutions.
 * Capped at 20. Empty for words shorter than 4 chars.
 */
export function fuzzyOne(word: string): string[] {
  if (word.length < 4) {
    return [];
  }

  const variants = new Set<string>();

  // Deletions
  for (let i = 0; i < word.length; i++) {
    variants.add(word.slice(0, i) + word.slice(i + 1));
  }

  // Substitutions
  for (let i = 0; i < word.length; i++) {
    const prefix = word.slice(0, i);
    const suffix = word.slice(i + 1);
    for (const ch of FUZZY_ALPHABET) {
      if (ch !== word[i]) {
        variants.add(prefix + ch + suffix);
      }
    }
  }

  // Insertions
  for (let i = 0; i <= word.length; i++) {
    const prefix = word.slice(0, i);
    const suffix = word.slice(i);
    for (const ch of FUZZY_ALPHABET) {
      variants.add(prefix + ch + suffix);
    }
  }

  return [...variants].slice(0, 20);
}

/**
 * Generate FTS5 query variants: original, lowercase, lemmatized, synonyms, fuzzy per word.
 * Deduplicated, capped at 12. Higher-priority variants kept when cap trims tail.
 */
export function expandQueryVariants(query: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const push = (v: string): void => {
    if (seen.has(v)) {
      return;
    }
    seen.add(v);
    ordered.push(v);
  };

  push(query);
  push(query.toLowerCase());
  push(lemmatize(query));

  const lowerQuery = query.toLowerCase();
  for (const [term, synonyms] of SYNONYM_MAP) {
    if (lowerQuery.includes(term)) {
      for (const syn of synonyms) {
        push(query.replace(new RegExp(term, 'gi'), syn));
      }
    }
  }

  for (const word of query.split(/\s+/)) {
    if (word.length < 4) {
      continue;
    }
    for (const variant of fuzzyOne(word)) {
      push(variant);
    }
  }

  return ordered.slice(0, 12);
}

/**
 * Deduplicate items by `id`, preserving first-occurrence order.
 */
export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }

  return result;
}
