/**
 * Pure goal evaluators for scripts/briefing-eval.mjs.
 * Each returns { id, hard, pass, value, detail }.
 */

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const STALE_DAYS = 14;
const STALE_ACTIVE_DAYS = 7;
const DIRECTIVE_BUDGET = 4 * 1024;
const LOAD_BUDGET = 12 * 1024;

function result(id, hard, pass, value, detail, na = false) {
  return { id, hard, pass, value, detail, na };
}

function firstLines(text, n) {
  return text.split('\n').slice(0, n);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBlock(text, heading) {
  const re = new RegExp(`── ${escapeRe(heading)} ──\\s*\\n([\\s\\S]*?)(?=\\n── |\\n${'─'.repeat(8)}|$)`);
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function parseRecentSessions(text) {
  const m = text.match(/── Recent Sessions \((\d+)\/(\d+)\) ──([\s\S]*?)(?=\n── |\n────────|$)/);
  if (!m) return null;
  const block = m[3] ?? '';
  const dates = [];
  for (const line of block.split('\n')) {
    // "2026-09-22 – 2026-09-23" = multi-day session; its last day is what recency means.
    const dm = line.match(/(\d+) exchanges · (\d{4}-\d{2}-\d{2})(?: – (\d{4}-\d{2}-\d{2}))?/);
    if (dm) dates.push(dm[3] ?? dm[2]);
  }
  return { shown: Number(m[1]), total: Number(m[2]), dates };
}

/** Sum of "+ N more open tasks" / "+ N stale open tasks" in the Open work block. */
function parseCountLines(text) {
  const block = extractBlock(text, 'Open work') ?? '';
  let n = 0;
  for (const m of block.matchAll(/^\+ (\d+) (?:more|stale) open tasks?/gm)) n += Number(m[1]);
  return n;
}

function parseOpenWorkLines(text) {
  const block = extractBlock(text, 'Open work');
  if (!block) return [];
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
}

/** Matches tim_load_project meta line grammar in project-output.ts `projectMetaLine`. */
function parseHeaderMeta(line) {
  const withStatus = line.match(
    /^Status:\s*(.+?)\s*·\s*(?:last activity\s+)?(\d{4}-\d{2}-\d{2})(?:\s*·\s*(?:(\d+)\s+packages)?)?(?:\s*·\s*(?:(\d+)\s+tests?)?)?/i,
  );
  if (withStatus) {
    return {
      status: withStatus[1].trim(),
      date: withStatus[2],
      packages: withStatus[3] ? Number(withStatus[3]) : undefined,
      tests: withStatus[4] ? Number(withStatus[4]) : undefined,
    };
  }
  const activityOnly = line.match(
    /^last activity\s+(\d{4}-\d{2}-\d{2})(?:\s*·\s*(?:(\d+)\s+packages)?)?(?:\s*·\s*(?:(\d+)\s+tests?)?)?/i,
  );
  if (activityOnly) {
    return {
      status: undefined,
      date: activityOnly[1],
      packages: activityOnly[2] ? Number(activityOnly[2]) : undefined,
      tests: activityOnly[3] ? Number(activityOnly[3]) : undefined,
    };
  }
  return null;
}

function findHeaderMetaLine(lines) {
  return lines.find(
    (l) => l.startsWith('Status:') || /^last activity\s+\d{4}-\d{2}-\d{2}/i.test(l),
  );
}

function daysBetween(a, b) {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return ms / (24 * 60 * 60 * 1000);
}

function parseTaskLinesFromLoad(text) {
  const lines = [];
  let inTasks = false;
  for (const raw of text.split('\n')) {
    if (/^\s{2}Tasks\s*$/.test(raw) || raw.trim() === 'Tasks') {
      inTasks = true;
      continue;
    }
    if (inTasks && /^\s{2}[A-Z]/.test(raw) && !raw.includes('[in_progress]') && !raw.includes('[todo]')) {
      break;
    }
    if (inTasks) {
      const m = raw.match(/^\s{4}(.+?) \[(in_progress|todo)[^\]]*\]/);
      if (m) lines.push({ title: m[1].trim(), line: raw.trim(), status: m[2] });
    }
  }
  return lines;
}

/** G1 — first screen essentials (load.txt lines 1–40). */
export function evalG1(loadText) {
  const lines = firstLines(loadText, 40);
  const block = lines.join('\n');
  const hasOverview =
    /Project overview|Overview|── Project Summary ──/i.test(block) &&
    lines.some((l) => l.trim().length > 20 && !/^─/.test(l.trim()));
  const hasDate = ISO_DATE.test(block);
  const hasOpen =
    /── Open work ──|Open work|── Now ──|── Next|NEXT:/i.test(block) ||
    /\bTasks\b/.test(block) && /\[in_progress\]/.test(block);
  const pass = hasOverview && hasDate && hasOpen;
  const detail = `overview=${hasOverview} date=${hasDate} openOrTasks=${hasOpen}`;
  return result('G1', true, pass, pass, detail);
}

/** G2 — header counts/dates not stale vs project last activity. */
export function evalG2(loadText, dbCtx) {
  const header = firstLines(loadText, 10).join('\n');
  const metaLine = findHeaderMetaLine(firstLines(loadText, 10));
  const meta = metaLine ? parseHeaderMeta(metaLine) : null;
  const lastActivity = dbCtx.lastActivity?.slice(0, 10);
  if (!meta || !lastActivity) {
    return result('G2', true, false, false, 'missing header meta or db lastActivity');
  }
  const headerDateStale = daysBetween(meta.date, lastActivity) > 1;
  const headerTestsStale =
    meta.tests != null &&
    dbCtx.liveTestCount != null &&
    meta.tests !== dbCtx.liveTestCount;
  const labelledHistorical = /historical|archive|as of/i.test(header);
  const pass = labelledHistorical || (!headerDateStale && !headerTestsStale);
  const detail = `headerDate=${meta.date} lastActivity=${lastActivity} tests=${meta.tests ?? 'n/a'} liveTests=${dbCtx.liveTestCount ?? 'n/a'} staleDate=${headerDateStale} staleTests=${headerTestsStale}`;
  return result('G2', true, pass, pass, detail);
}

/** G3 — project summary covers project, not one session. */
export function evalG3(loadText, dbCtx) {
  const summary = extractBlock(loadText, 'Project Summary');
  if (!summary) {
    return result('G3', true, false, false, 'no Project Summary block');
  }
  const dates = [...summary.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
  const newestSource = dates.sort().at(-1);
  const windowOk =
    (/\d{4}-\d{2}-\d{2}.*(?:to|–|-|through).*\d{4}-\d{2}-\d{2}/i.test(summary)) ||
    /\b(\d+)\s+sessions?\b/i.test(summary) && Number(summary.match(/\b(\d+)\s+sessions?\b/i)?.[1] ?? 0) >= 3 ||
    /\bsessions?\s+\d+\s*[-–]\s*\d+\b/i.test(summary);
  const lastActivity = dbCtx.lastActivity?.slice(0, 10);
  const freshEnough =
    newestSource && lastActivity
      ? daysBetween(newestSource, lastActivity) <= STALE_DAYS
      : false;
  const pass = windowOk && freshEnough;
  const detail = `window=${windowOk} newestSource=${newestSource ?? 'none'} lastActivity=${lastActivity ?? 'none'} freshWithin${STALE_DAYS}d=${freshEnough}`;
  return result('G3', true, pass, pass, detail);
}

/** G4 — recent sessions recent and plural (newest substantive session, not any session). */
export function evalG4(loadText, dbCtx) {
  if ((dbCtx.sessionCount ?? 0) === 0) {
    return result('G4', true, true, true, 'no sessions in project', true);
  }
  const rs = parseRecentSessions(loadText);
  if (!rs) {
    return result('G4', true, false, false, 'no Recent Sessions block');
  }
  const pluralOk = rs.total < 3 ? true : rs.shown >= 3;
  const newestListed = rs.dates[0];
  const newestDb = dbCtx.newestSubstantiveActivityDate?.slice(0, 10)
    ?? dbCtx.newestSubstantiveSessionDate?.slice(0, 10)
    ?? dbCtx.newestSessionDate?.slice(0, 10);
  const dateOk = newestListed && newestDb ? newestListed === newestDb : false;
  const pass = pluralOk && dateOk;
  const detail = `shown=${rs.shown}/${rs.total} pluralOk=${pluralOk} newestListed=${newestListed ?? 'none'} newestSubstantiveDb=${newestDb ?? 'none'}`;
  return result('G4', true, pass, pass, detail);
}

/** G5 — continue finds real handoff (preview.txt). */
export function evalG5(previewText, dbCtx) {
  const handoffInPreview = /handoff:|Handoff|── Previous session/i.test(previewText);
  const newestHandoff = dbCtx.newestHandoffNote;
  const needsHandoff = Boolean(newestHandoff);
  const handoffSnippet = newestHandoff
    ? newestHandoff.replace(/\s+/g, ' ').trim().slice(0, 48)
    : '';
  const showsHandoff =
    !needsHandoff ||
    (handoffSnippet.length > 0 && previewText.replace(/\s+/g, ' ').includes(handoffSnippet));
  const substantive = dbCtx.newestSubstantiveSession;
  const trivialNewest = dbCtx.newestSessionExchangeCount < 3 && !dbCtx.newestSessionHasHandoff;
  const masksSubstantive =
    trivialNewest &&
    substantive &&
    substantive.sessionId !== dbCtx.newestSessionId;
  const showsSubstantive =
    !masksSubstantive ||
    (substantive &&
      (previewText.includes(substantive.label?.slice(0, 10) ?? '') ||
        previewText.includes(substantive.summarySnippet ?? '')));
  const pass = (!needsHandoff || showsHandoff) && (!masksSubstantive || showsSubstantive);
  const detail = `needsHandoff=${needsHandoff} showsHandoff=${showsHandoff} previousSessionBlock=${handoffInPreview} trivialNewest=${trivialNewest} masksSubstantive=${masksSubstantive} showsSubstantive=${showsSubstantive}`;
  return result('G5', true, pass, pass, detail);
}

/** G6 — directive does not contradict itself (hook.txt). */
export function evalG6(hookText) {
  const already = /already loaded|do NOT re-fetch/i.test(hookText);
  const callLoad = /tim_load_project/i.test(hookText);
  const pass = !(already && callLoad);
  const detail = `alreadyLoaded=${already} callTimLoadProject=${callLoad}`;
  return result('G6', true, pass, pass, detail);
}

/**
 * G7 — delta bullets are news, not bookkeeping. Scans every `[Since last session]`
 * block in the hook text and the preview (tim_session_start briefing). Heuristic:
 * a bullet is bookkeeping when it names a checkpoint/batch/exchange count, is a bare
 * session timestamp title (YYYY-MM-DD-HHMM), or repeats a raw turn shown elsewhere
 * in the preview (▸ user / ↳ agent lines) — i.e. it is an exchange node.
 */
export function evalG7(hookText, previewText = '') {
  const texts = [hookText, previewText];
  const turns = new Set();
  for (const line of previewText.split('\n')) {
    const t = line.replace(/^\s*[▸↳]\s*/, '').trim();
    if (t && t !== line.trim()) turns.add(t.slice(0, 40));
  }
  const bad = [];
  let blocks = 0;
  for (const text of texts) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('[Since last session]')) return;
      blocks++;
      for (let j = i + 1; j < lines.length && /^\s*•/.test(lines[j]); j++) {
        const b = lines[j].replace(/^\s*•\s*/, '').trim();
        if (/^Session checkpoint:|^Batch \d+$|^\d+ exchanges?\b/i.test(b) || /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(b) || turns.has(b.slice(0, 40))) bad.push(b.slice(0, 40));
      }
    });
  }
  if (blocks === 0) return result('G7', true, true, true, 'no Since-last-session block');
  const pass = bad.length === 0;
  return result('G7', true, pass, bad.length, `blocks=${blocks} bookkeeping=${JSON.stringify(bad)}`);
}

/** G8 — open work trustworthy (hook open work + load tasks). */
export function evalG8(hookText, loadText, dbCtx, now = new Date()) {
  const openLines = parseOpenWorkLines(hookText);
  const loadTasks = parseTaskLinesFromLoad(loadText);
  const lines = openLines.length > 0 ? openLines : loadTasks.map((t) => t.line);
  if (lines.length === 0) {
    return result('G8', true, true, true, 'no open work lines');
  }
  const stale = [];
  // Coverage: every open task is named or inside a count line ("+ N more …", "+ N stale …").
  if (dbCtx.openTaskCount != null && openLines.length > 0) {
    const named = openLines.filter((l) => l.startsWith('- [')).length;
    const counted = parseCountLines(hookText);
    if (named + counted !== dbCtx.openTaskCount) {
      stale.push(`coverage: ${named} named + ${counted} counted != ${dbCtx.openTaskCount} open in db`);
    }
  }
  for (const line of lines) {
    if (/ · stale since \d{4}-\d{2}-\d{2}/.test(line)) continue;
    const titleM = line.match(/\]\s+(.+?)(?:\s*$|…)/);
    const title = titleM?.[1]?.trim();
    const norm = title
      ? title.normalize('NFKC').replace(/\u2013|\u2014/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
      : '';
    const task = norm ? dbCtx.openTasksByTitle?.get(norm) : undefined;
    if (!task) {
      stale.push(`${title ?? line}: no db match`);
      continue;
    }
    // Staleness counts days of project work since the last touch, not calendar days.
    const touched = task.updated_at.slice(0, 10);
    const workDays = (dbCtx.activeDays ?? []).filter((d) => d > touched).length;
    if (workDays >= STALE_ACTIVE_DAYS) stale.push(`${title}: updated ${touched} (${workDays} work days)`);
  }
  const pass = stale.length === 0;
  return result('G8', true, pass, pass, pass ? `checked ${lines.length} items` : stale.join('; '));
}

/** G9 — budget sizes. */
export function evalG9Directive(hookText) {
  const bytes = Buffer.byteLength(hookText, 'utf8');
  const pass = bytes <= DIRECTIVE_BUDGET;
  return result('G9', true, pass, bytes, `directiveBytes=${bytes} limit=${DIRECTIVE_BUDGET}`);
}

export function evalG9Load(loadText) {
  const bytes = Buffer.byteLength(loadText, 'utf8');
  const pass = bytes <= LOAD_BUDGET;
  return result('G9', true, pass, bytes, `loadBytes=${bytes} limit=${LOAD_BUDGET}`);
}

/** S1 — no loose root children. */
export function evalS1(structure) {
  const loose = (structure?.looseDirectChildren ?? null)?.filter?.(c => !['sessions-root', 'commits-root', 'project-path'].includes(c?.kind)).length ?? -1;
  const pass = loose === 0;
  return result('S1', false, pass, loose, `looseDirectChildren=${loose}`);
}

/** S2 — bugs open-first. */
export function evalS2(loadText) {
  const bugs = extractBlock(loadText, 'Bugs') || '';
  const lines = bugs.split('\n').map((l) => l.trim()).filter(Boolean);
  let lastOpenIdx = -1;
  let fixedBeforeOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFixed = /\[fixed\]|\[done\]|✓|fixed\)/i.test(line);
    const isOpen = /\[todo\]|\[open\]/i.test(line) || (!isFixed && /\[/.test(line));
    if (isOpen) lastOpenIdx = i;
    if (isFixed && (lastOpenIdx === -1 || i < lastOpenIdx)) fixedBeforeOpen = true;
  }
  const pass = !fixedBeforeOpen;
  return result('S2', false, pass, pass, `fixedBeforeOpen=${fixedBeforeOpen}`);
}

/** S3 — title length share. */
export function evalS3(structure) {
  const titles = [];
  for (const s of structure?.sections ?? []) titles.push(s.title);
  for (const l of structure?.looseDirectChildren ?? []) titles.push(l.title);
  if (titles.length === 0) {
    return result('S3', false, true, 0, 'no titles');
  }
  const long = titles.filter((t) => t.length > 100).length;
  const share = long / titles.length;
  const pass = share === 0;
  return result('S3', false, pass, share, `${long}/${titles.length} titles >100 chars`);
}

/** S4 — collapsed blocks name drill-down tool. */
export function evalS4(loadText) {
  const moreLines = loadText.split('\n').filter((l) => /…\s+\d+\s+more/i.test(l) || /older sessions/.test(l));
  if (moreLines.length === 0) {
    return result('S4', false, true, true, 'no collapsed blocks');
  }
  const bad = moreLines.filter((l) => !/tim_[a-z_]+/i.test(l));
  const pass = bad.length === 0;
  return result('S4', false, pass, pass, bad.length ? `missing tool hint: ${bad[0]}` : `checked ${moreLines.length} collapsed lines`);
}

export function evaluateAll(ctx) {
  const hard = [
    evalG1(ctx.loadText),
    evalG2(ctx.loadText, ctx.db),
    evalG3(ctx.loadText, ctx.db),
    evalG4(ctx.loadText, ctx.db),
    evalG5(ctx.previewText, ctx.db),
    evalG6(ctx.hookText),
    evalG7(ctx.hookText, ctx.previewText),
    evalG8(ctx.hookText, ctx.loadText, ctx.db, ctx.now),
    evalG9Directive(ctx.hookText),
    evalG9Load(ctx.loadText),
  ];
  // Merge G9: both must pass; use worst case for display
  const g9d = hard[8];
  const g9l = hard[9];
  hard[8] = {
    id: 'G9',
    hard: true,
    pass: g9d.pass && g9l.pass,
    value: { directive: g9d.value, load: g9l.value },
    detail: `${g9d.detail}; ${g9l.detail}`,
  };
  hard.pop();
  const soft = [
    evalS1(ctx.structure),
    evalS2(ctx.loadText),
    evalS3(ctx.structure),
    evalS4(ctx.loadText),
  ];
  return [...hard, ...soft];
}

export function formatScorecard(results) {
  const lines = results.map((r) => {
    const tag = r.na ? 'n/a' : r.pass ? 'PASS' : 'FAIL';
    return `${tag} ${r.id} ${r.detail}`;
  });
  const hardApplicable = results.filter((r) => r.hard && !r.na);
  const hardPass = hardApplicable.filter((r) => r.pass).length;
  const hardTotal = hardApplicable.length;
  const softPass = results.filter((r) => !r.hard && r.pass).length;
  const softTotal = results.filter((r) => !r.hard).length;
  const naGoals = results.filter((r) => r.na).map((r) => r.id);
  const naSuffix = naGoals.length > 0 ? `  n/a: ${naGoals.join(',')}` : '';
  lines.push(`hard: ${hardPass}/${hardTotal}  soft: ${softPass}/${softTotal}${naSuffix}`);
  return lines.join('\n');
}

/** One-line summary for --all-active output. */
export function formatProjectSummaryLine(projectLabel, results) {
  const hardApplicable = results.filter((r) => r.hard && !r.na);
  const hardPass = hardApplicable.filter((r) => r.pass).length;
  const hardTotal = hardApplicable.length;
  const softPass = results.filter((r) => !r.hard && r.pass).length;
  const softTotal = results.filter((r) => !r.hard).length;
  const naGoals = results.filter((r) => r.na).map((r) => r.id);
  const naSuffix = naGoals.length > 0 ? ` (${naGoals.join(',')} n/a)` : '';
  return `${projectLabel}  hard ${hardPass}/${hardTotal}  soft ${softPass}/${softTotal}${naSuffix}`;
}
