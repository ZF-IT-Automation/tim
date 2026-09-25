// Opt-in "looks done" suggestion for tim_show what=tasks.
//
// Jev is a read-only filter on top of the normal listing. It must not run from
// tim_load_project, the session-start briefing, or any hook: one call is a
// network round-trip, and the start path cannot wait on it. A null answer
// (no key, timeout, HTTP error) leaves those tasks unjudged — never "done".
import { askJev, jevNoul, resolveEntryTaskStatus, type Entry } from 'tim-core';
import { KIND_BATCH, KIND_COMMIT, type TimStore } from 'tim-store';

export const LOOKS_DONE_WORD = 'looks-done';

const NOUL_MIN = 0.7;
const BATCH_SIZE = 6;
const EVIDENCE_LIMIT = 5;
const EVIDENCE_FETCH = 8;
const SNIPPET_CHARS = 300;

// Log entries and decisions are metadata.type values. tim-store has kind
// constants for commits and batch summaries only.
const EVIDENCE_KINDS = [KIND_COMMIT, KIND_BATCH];
const EVIDENCE_TYPES = ['log', 'decision'];

const STOP = new Set(
  `a an the and or of to for in on with from by at as is are was were be been being
   und oder der die das den dem des ein eine einer eines nicht mit von zu auf für im am
   task tasks bug fix implement plan review feature entry tim
   done fixed erledigt behoben`.split(/\s+/),
);

export function withRequestsLooksDone(withStr: string | undefined): boolean {
  if (!withStr) return false;
  return withStr.split(',').some(term => term.trim().toLowerCase() === LOOKS_DONE_WORD);
}

/** Drop status declarations so the task's own "done" cannot count as evidence. */
export function stripStatusWords(body: string): string {
  const withoutStatusLines = body
    .split('\n')
    .filter(line => !/\bstatus\s*:/i.test(line))
    .join('\n');
  return withoutStatusLines
    .replace(/\b(erledigt|behoben|fixed|done)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function contentWordQuery(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[#*_`]/g, ' ')
    .split(/[^0-9a-zà-öø-ÿ]+/)
    .filter(word => word.length > 3 && !STOP.has(word))
    .slice(0, 6);
  return words.map(word => `"${word}"`).join(' OR ');
}

function evidenceText(entry: Entry): string {
  const body = entry.content.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
  return `${entry.title} — ${body}`;
}

function isOpenTask(entry: Entry): boolean {
  const status = resolveEntryTaskStatus(entry.metadata);
  return status !== 'done' && status !== 'cancelled';
}

async function gatherEvidence(store: TimStore, task: Entry): Promise<Entry[]> {
  const query = contentWordQuery(task.title);
  const project = store.getProjectLabel(task.id);
  if (!query || !project) return [];
  const hits = await store.searchFts(query, EVIDENCE_FETCH, {
    project,
    ftsQueryMode: 'or-terms',
    includeKinds: EVIDENCE_KINDS,
    includeTypes: EVIDENCE_TYPES,
  });
  return hits.filter(hit => hit.id !== task.id).slice(0, EVIDENCE_LIMIT);
}

/**
 * Suggestion block for the open tasks already in scope (root, with-filters, limit).
 * Reads only. Jev null for a batch yields one "could not judge" line and no ids.
 */
export async function suggestLooksDone(store: TimStore, entries: Entry[]): Promise<string> {
  const lines = ['Looks done — suggestion only, nothing was changed.'];
  const open = entries.filter(isOpenTask);

  for (let start = 0; start < open.length; start += BATCH_SIZE) {
    const chunk = open.slice(start, start + BATCH_SIZE);
    const evidenceLists = await Promise.all(chunk.map(entry => gatherEvidence(store, entry)));
    const cases = chunk.map((entry, index) => ({
      id: `T${index}`,
      entry,
      evidence: evidenceLists[index],
    }));
    const questions: Record<string, { type: 'noul'; instructions: string }> = {};
    for (const caseRow of cases) {
      const n = caseRow.id.slice(1);
      questions[`t${n}`] = {
        type: 'noul',
        instructions: `Does the evidence show that task ${caseRow.id} was already implemented, fixed or shipped?`,
      };
    }
    const answers = await askJev(
      'tim_show:looks-done',
      {
        cases: cases.map(caseRow => ({
          id: caseRow.id,
          task: {
            title: caseRow.entry.title,
            body: stripStatusWords(caseRow.entry.content),
          },
          evidence: caseRow.evidence.map(evidenceText),
        })),
      },
      questions,
    );
    if (!answers) {
      lines.push(`could not judge ${chunk.length} tasks (Jev unavailable)`);
      continue;
    }
    for (const caseRow of cases) {
      const noul = jevNoul(answers, `t${caseRow.id.slice(1)}`);
      if (noul === undefined || noul < NOUL_MIN) continue;
      const evidenceIds = caseRow.evidence.map(hit => hit.id).join(', ');
      lines.push(`${caseRow.entry.id}  ${caseRow.entry.title}  noul=${noul}  evidence: ${evidenceIds}`);
    }
  }

  return lines.join('\n');
}
