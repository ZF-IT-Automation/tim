// Retrieval by topic: everything a project ever recorded under one tag, in the
// order it happened, plus the one live handoff from the newest session that
// touched it. Replaces the recency-picked previous session that used to be
// injected into every session start whether it was relevant or not.
import type { Entry } from 'tim-core';
import type { TimStore } from 'tim-store';
import { KIND_BATCH, KIND_SESSION, KIND_SUMMARY_ROOT } from 'tim-store';
import { recentExchanges } from 'tim-hooks';

/** How much raw tail to render. Same order of magnitude as the old briefing's. */
const RAW_TAIL_MAX_CHARS = 2000;
/** Enough to cover a project's whole history under one tag without unbounded output. */
const MAX_TAG_HITS = 500;

export interface TopicSessionHit {
  sessionId: string;
  date: string;
  batchIndex: number;
  title: string;
  summary: string;
}

export interface TopicResume {
  tag: string;
  projectLabel: string;
  /** Batch summaries carrying the tag, oldest first. */
  sessions: TopicSessionHit[];
  /** Tasks, bugs and ideas carrying the tag. */
  work: Entry[];
  /** The newest session among the hits — the only one whose note and turns are shown. */
  newest?: { sessionId: string; date: string; handoffNote?: string; rawTurns: string[] };
  /** Total entries carrying the tag, including the kinds this view does not render. */
  otherHits: number;
}

/**
 * Task/bug/idea, across the three places status bookkeeping actually lives.
 * `metadata.type` has no 'bug' member — bugs are recognised by kind — so the
 * kind check is not redundant with the type check.
 */
function isWorkEntry(e: Entry): boolean {
  const kind = e.metadata.kind;
  return e.metadata.task !== undefined
    || kind === 'task' || kind === 'bug' || kind === 'idea'
    || e.metadata.type === 'idea';
}

/**
 * Walk a batch summary up to its session: batch → Summary root → session node.
 * The batch carries no session id of its own, and the tree is the only place the
 * relation is recorded.
 */
async function sessionOfBatch(
  store: TimStore,
  batch: Entry,
): Promise<{ session: Entry; summaryRoot: Entry } | null> {
  if (!batch.parentId) return null;
  const summaryRoot = await store.read(batch.parentId);
  if (!summaryRoot || summaryRoot.metadata.kind !== KIND_SUMMARY_ROOT) return null;
  if (!summaryRoot.parentId) return null;
  const session = await store.read(summaryRoot.parentId);
  if (!session || session.metadata.kind !== KIND_SESSION) return null;
  return { session, summaryRoot };
}

function sessionDate(session: Entry): string {
  return typeof session.metadata.date === 'string' ? session.metadata.date : session.createdAt;
}

export async function collectTopicResume(
  store: TimStore,
  projectLabel: string,
  tag: string,
): Promise<TopicResume> {
  const needle = tag.startsWith('#') ? tag : `#${tag}`;
  const hits = await store.searchByTag(needle, MAX_TAG_HITS, projectLabel);

  const sessions: TopicSessionHit[] = [];
  // Keyed by session id so several matching batches of one session collapse into
  // one candidate for "newest".
  const candidates = new Map<string, { date: string; summaryRoot: Entry }>();

  for (const hit of hits) {
    if (hit.metadata.kind !== KIND_BATCH) continue;
    const located = await sessionOfBatch(store, hit);
    if (!located) continue;
    const date = sessionDate(located.session);
    sessions.push({
      sessionId: located.session.id,
      date,
      batchIndex: Number(hit.metadata.batch_index) || 0,
      title: hit.title,
      summary: (hit.content ?? '').trim(),
    });
    const known = candidates.get(located.session.id);
    if (!known || date > known.date) {
      candidates.set(located.session.id, { date, summaryRoot: located.summaryRoot });
    }
  }

  // Within a session, batch order — not title order, which would put "Batch 10"
  // before "Batch 2" the moment a session runs long enough to have ten.
  sessions.sort((a, b) => a.date.localeCompare(b.date) || a.batchIndex - b.batchIndex);

  const newestEntry = [...candidates.entries()].sort(
    (a, b) => b[1].date.localeCompare(a[1].date) || b[0].localeCompare(a[0]),
  )[0];

  let newest: TopicResume['newest'];
  if (newestEntry) {
    const [sessionId, { date, summaryRoot }] = newestEntry;
    const note = summaryRoot.metadata.handoff_note;
    // The note and the turns come from the same session, always. A note from one
    // session beside turns from another would read as one state of the work and
    // describe two.
    newest = {
      sessionId,
      date,
      ...(typeof note === 'string' && note.trim() ? { handoffNote: note.trim() } : {}),
      rawTurns: await recentExchanges(store, sessionId, RAW_TAIL_MAX_CHARS).catch(() => []),
    };
  }

  return {
    tag: needle,
    projectLabel,
    sessions,
    work: hits.filter(isWorkEntry),
    newest,
    otherHits: hits.length,
  };
}

export function formatTopicResume(r: TopicResume): string {
  if (r.sessions.length === 0 && r.work.length === 0) {
    // This view renders session history and open work. Saying "nothing" when
    // the tag does exist on other kinds of entry would send the reader looking
    // for a different tag instead of a different tool.
    return r.otherHits > 0
      ? `No session summaries and no open work tagged ${r.tag} in ${r.projectLabel} — ` +
        `but ${r.otherHits} other ${r.otherHits === 1 ? 'entry carries' : 'entries carry'} it. ` +
        `Use tim_search with tag=${r.tag} to see them.`
      : `No entries tagged ${r.tag} in ${r.projectLabel}.`;
  }

  const out: string[] = [`## Topic ${r.tag} — ${r.projectLabel}`];

  if (r.sessions.length > 0) {
    out.push('', `── Sessions on this topic (${r.sessions.length}, oldest first) ──`);
    for (const s of r.sessions) {
      out.push(`▸ ${s.date.slice(0, 16).replace('T', ' ')} · ${s.sessionId} · ${s.title}`);
      if (s.summary) out.push(`  ${s.summary}`);
    }
  }

  if (r.work.length > 0) {
    out.push('', `── Tasks, bugs and ideas tagged ${r.tag} (${r.work.length}) ──`);
    for (const w of r.work) {
      const status = typeof w.metadata.status === 'string' ? ` [${w.metadata.status}]` : '';
      out.push(`- ${w.title}${status}`);
    }
  }

  if (r.newest) {
    const when = r.newest.date.slice(0, 16).replace('T', ' ');
    out.push('', `── Newest session on this topic: ${r.newest.sessionId} (${when}) ──`);
    // A missing note is information; a foreign one is a false statement about the
    // current state of the work. So this says so instead of reaching backwards.
    out.push(
      r.newest.handoffNote
        ? `Handoff note:\n${r.newest.handoffNote}`
        : `No handoff note — session ${r.newest.sessionId} (${when}) ended without one.`,
    );
    if (r.newest.rawTurns.length > 0) {
      out.push('', '── Its turns since the last summary ──', ...r.newest.rawTurns);
    }
  }

  // The same silence that the empty case already fixed, in the case that is not
  // empty. Measured against the live database: #topic-recall matches five
  // entries in P0063, of which this view renders one — the other four are notes
  // and Summary roots, kinds it deliberately does not show. Reporting "1
  // session" and nothing else reads as "that is all there is", and the reader
  // never learns a different tool would show more.
  const rendered = r.sessions.length + r.work.length;
  if (r.otherHits > rendered) {
    const rest = r.otherHits - rendered;
    out.push(
      '',
      `${rest} further ${rest === 1 ? 'entry carries' : 'entries carry'} ${r.tag} in kinds ` +
        `this view does not render (notes, Summary roots). ` +
        `Use tim_search with tag=${r.tag} to see them.`,
    );
  }

  return out.join('\n');
}
