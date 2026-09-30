// Summarizer watchdog. The idle sweep measures how long pending exchanges sit
// unsummarized and writes the result here; the start-hook briefing and doctor
// read the file instead of re-walking every session. Three outages in one week
// (stale lock, `spawn node ENOENT`, deleted cwd) all looked the same from
// outside: sessions stopped getting summaries and nobody noticed.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getTimDir } from 'tim-core';

export interface SummarizerHealth {
  checkedAt: string;
  /** Sessions whose pending exchanges have been idle longer than the stale threshold. */
  staleSessions: number;
  staleExchanges: number;
  /** Last exchange of the longest-idle stale session. */
  oldestIdleSince: string | null;
  /** Last FAIL line of the global summarizer log. */
  lastFail: string | null;
  /** An alert for the current outage went out. */
  alerted: boolean;
}

export const DEFAULT_STALE_MINUTES = 60;

export function summarizerHealthPath(): string {
  return path.join(getTimDir(), 'summarizer-health.json');
}

export function readSummarizerHealth(file = summarizerHealthPath()): SummarizerHealth | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SummarizerHealth;
  } catch {
    return null;
  }
}

/** Atomic: the start hook reads this file while a sweep may be writing it. */
export function writeSummarizerHealth(health: SummarizerHealth, file = summarizerHealthPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(health, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Last FAIL line from the tail of the global summarizer log (SKIP lines are not failures). */
export function lastFailLine(logFile = path.join(getTimDir(), 'summarizer.log')): string | null {
  try {
    const size = fs.statSync(logFile).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(logFile, 'r');
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split('\n').filter(l => / FAIL /.test(l));
    const last = lines.at(-1)?.trim();
    return last ? last.slice(0, 300) : null;
  } catch {
    return null;
  }
}

function problem(h: SummarizerHealth): string {
  return `${h.staleExchanges} exchange(s) in ${h.staleSessions} session(s) unsummarized, ` +
    `idle since ${h.oldestIdleSince ?? 'unknown'}`;
}

/**
 * Briefing warning lines. `sweepMaxAgeMinutes` catches a dead sweeper (tim-mcp
 * down): a dead process cannot send its own alert, so the file going stale is
 * the only signal left.
 */
export function summarizerHealthLines(
  h: SummarizerHealth | null,
  sweepMaxAgeMinutes: number,
  nowMs: number = Date.now(),
): string[] {
  if (!h) return [];
  const lines: string[] = [];
  const ageMin = Math.floor((nowMs - Date.parse(h.checkedAt)) / 60_000);
  if (ageMin > sweepMaxAgeMinutes) {
    lines.push(`⚠ Summarizer sweep has not run for ${ageMin} min (last ${h.checkedAt}) — check tim-mcp.service.`);
  }
  if (h.staleSessions > 0) {
    lines.push(
      `⚠ Summarizer: ${problem(h)}.` + (h.lastFail ? ` Last failure: ${h.lastFail}` : '') +
      ' Check ~/.tim/summarizer.log and `tim doctor`.',
    );
  }
  return lines;
}

export type AlertSender = (argv: string[], text: string) => Promise<boolean>;

const execAlert: AlertSender = (argv, text) =>
  new Promise(resolve => {
    const [cmd, ...args] = argv;
    if (!cmd) return resolve(false);
    execFile(cmd, [...args, text], { timeout: 30_000 }, err => resolve(!err));
  });

/** send-telegram posts with parse_mode=HTML; an unescaped `<` gets the message rejected. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Persist this pass and alert on transitions only: once when an outage starts,
 * once when it clears. `alerted` flips only after a successful send, so a
 * failed send is retried on the next pass.
 */
export async function recordSummarizerHealth(
  measured: Omit<SummarizerHealth, 'alerted' | 'lastFail'> & { lastFail?: string | null },
  opts: { file?: string; alertCommand?: string[]; send?: AlertSender } = {},
): Promise<SummarizerHealth> {
  const file = opts.file ?? summarizerHealthPath();
  const prev = readSummarizerHealth(file);
  const health: SummarizerHealth = {
    ...measured,
    lastFail: measured.lastFail === undefined ? lastFailLine() : measured.lastFail,
    alerted: prev?.alerted ?? false,
  };
  const send = opts.send ?? execAlert;
  const unhealthy = health.staleSessions > 0;
  if (opts.alertCommand?.length && unhealthy !== health.alerted) {
    const text = unhealthy
      ? `TIM summarizer is failing: ${problem(health)}.` + (health.lastFail ? `\nLast failure: ${health.lastFail}` : '')
      : 'TIM summarizer recovered: no stale exchanges left.';
    if (await send(opts.alertCommand, escapeHtml(text))) health.alerted = unhealthy;
  } else if (!opts.alertCommand?.length) {
    health.alerted = false;
  }
  writeSummarizerHealth(health, file);
  return health;
}
