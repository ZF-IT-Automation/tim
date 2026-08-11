// Retrieval by topic: what a project recorded about a subject, in the order it
// happened, plus the one live handoff from the newest session that touched it.
// Replaces the recency-picked previous session that used to be injected into
// every session start whether it was relevant or not.
//
// Two retrieval paths, unioned, because neither alone finds the topic. Tags are
// exact and exhaustive but only match a name somebody coined: measured against
// the live database, the tag for the viewer work is `#tim-inspector`, so asking
// for "tim-viewer" returned nothing while full text found the same batches by
// their bodies. Full text is forgiving but bm25-ranked and truncating, so it
// cannot promise completeness the way the tag scan does.
import type { Entry } from 'tim-core';
import type { TimStore } from 'tim-store';
import { KIND_BATCH, KIND_SESSION, KIND_SUMMARY_ROOT } from 'tim-store';
import { recentExchanges } from 'tim-hooks';

/** How much raw tail to render. Same order of magnitude as the old briefing's. */
const RAW_TAIL_MAX_CHARS = 2000;
/** Enough to cover a project's whole history under one tag without unbounded output. */
const MAX_TAG_HITS = 500;
/** Ranked candidates to pull before the recency cap picks among them. */
const MAX_FTS_HITS = 200;
/**
 * Raw turns match the topic's words in bulk and carry no tags, so they crowd a
 * ranked page out of the summaries that are the point of this view. They are
 * still reachable — the newest session's uncovered tail is rendered below.
 */
const FLOODING_KINDS = ['exchange'];
/** Sessions rendered by default: enough to see the arc, few enough to read. */
const DEFAULT_SESSION_LIMIT = 10;

export interface TopicSessionHit {
  sessionId: string;
  date: string;
  batchIndex: number;
  title: string;
  summary: string;
}

export interface TopicResume {
  /** What was asked for, as the user wrote it. */
  topic: string;
  /** The tag form that was looked up alongside the full-text search. */
  tag: string;
  projectLabel: string;
  /** Batch summaries matching the topic, oldest first — capped to the newest `limit` sessions. */
  sessions: TopicSessionHit[];
  /** How many sessions matched before the cap, so a partial history says it is one. */
  sessionsMatched: number;
  /** Tasks, bugs and ideas matching the topic. */
  work: Entry[];
  /** The newest session among the hits — the only one whose note and turns are shown. */
  newest?: { sessionId: string; date: string; handoffNote?: string; rawTurns: string[] };
  /** Total entries matched, including the kinds this view does not render. */
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
  topic: string,
  limit: number = DEFAULT_SESSION_LIMIT,
): Promise<TopicResume> {
  const needle = topic.startsWith('#') ? topic : `#${topic}`;
  // Topics arrive tag-shaped ("sync-server"), and FTS5 reads a quoted
  // "sync-server" as the adjacent phrase `sync server` — so the hyphen silently
  // demands a word order the prose never has to use. Measured in P0063:
  // "sync-server" matched no batch summary at all, while the same words as
  // separate terms matched several. Splitting them turns the phrase into an AND,
  // which is what a two-word topic actually means.
  const words = topic.replace(/^#/, '').replace(/[-_]+/g, ' ');
  const [tagged, matched] = await Promise.all([
    store.searchByTag(needle, MAX_TAG_HITS, projectLabel),
    store.searchFts(words, MAX_FTS_HITS, {
      project: projectLabel,
      excludeKinds: FLOODING_KINDS,
    }),
  ]);
  // Tag hits first so the exhaustive scan wins ties; dedupe on id, since an
  // entry that both carries the tag and names it in the body is one entry.
  const hits = [...new Map([...tagged, ...matched].map(e => [e.id, e])).values()];

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

  const byRecency = [...candidates.entries()].sort(
    (a, b) => b[1].date.localeCompare(a[1].date) || b[0].localeCompare(a[0]),
  );

  // Cap by session, then render chronologically. Selecting the newest and
  // rendering newest-first are different things: the second would make a topic's
  // history read backwards to buy the same bound.
  const sessionsMatched = byRecency.length;
  const kept = new Set(byRecency.slice(0, Math.max(1, limit)).map(([id]) => id));
  const rendered = sessions.filter(s => kept.has(s.sessionId));

  const newestEntry = byRecency[0];

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
    topic,
    tag: needle,
    projectLabel,
    sessions: rendered,
    sessionsMatched,
    work: hits.filter(isWorkEntry),
    newest,
    otherHits: hits.length,
  };
}

export function formatTopicResume(r: TopicResume): string {
  if (r.sessions.length === 0 && r.work.length === 0) {
    // This view renders session history and open work. Saying "nothing" when
    // the topic does exist on other kinds of entry would send the reader looking
    // for different words instead of a different tool.
    return r.otherHits > 0
      ? `No session summaries and no open work on "${r.topic}" in ${r.projectLabel} — ` +
        `but ${r.otherHits} other ${r.otherHits === 1 ? 'entry matches' : 'entries match'}. ` +
        `Use tim_search with query=${r.topic} to see them.`
      : `Nothing on "${r.topic}" in ${r.projectLabel} — no entry carries ${r.tag} and none mentions it.`;
  }

  const out: string[] = [`## Topic "${r.topic}" — ${r.projectLabel}`];

  if (r.sessions.length > 0) {
    const capped = r.sessionsMatched > new Set(r.sessions.map(s => s.sessionId)).size;
    out.push('', `── Sessions on this topic (${r.sessions.length}, oldest first) ──`);
    if (capped) {
      // A cap that does not announce itself turns a partial history into a
      // confident whole one — the reader has no way to tell the topic started
      // earlier than the oldest line shown.
      out.push(
        `Newest ${new Set(r.sessions.map(s => s.sessionId)).size} of ${r.sessionsMatched} ` +
        `matching sessions; earlier ones exist. Raise limit to see them.`,
      );
    }
    for (const s of r.sessions) {
      out.push(`▸ ${s.date.slice(0, 16).replace('T', ' ')} · ${s.sessionId} · ${s.title}`);
      if (s.summary) out.push(`  ${s.summary}`);
    }
  }

  if (r.work.length > 0) {
    out.push('', `── Tasks, bugs and ideas on this topic (${r.work.length}) ──`);
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
  const shown = r.sessions.length + r.work.length;
  if (r.otherHits > shown) {
    const rest = r.otherHits - shown;
    out.push(
      '',
      `${rest} further ${rest === 1 ? 'entry matches' : 'entries match'} "${r.topic}" in kinds ` +
        `this view does not render (notes, Summary roots). ` +
        `Use tim_search with query=${r.topic} to see them.`,
    );
  }

  return out.join('\n');
}
