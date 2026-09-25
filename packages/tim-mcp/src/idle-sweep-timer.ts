import { loadConfig } from 'tim-core';
import { embedUnembeddedEntries, isSummarizerChild, sweepIdleSessions } from 'tim-hooks';
import type { TimStore } from 'tim-store';

let idleSweepTimer: ReturnType<typeof setInterval> | null = null;
let embeddingTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic idle-session sweep (idempotent). */
export function startIdleSweepTimer(store: TimStore): void {
  if (idleSweepTimer) return;
  if (isSummarizerChild()) return;

  const config = loadConfig();
  if (config.summarizer?.idle_sweep?.enabled === false) return;

  const intervalMinutes = config.summarizer?.idle_sweep?.interval_minutes ?? 5;
  const idleMinutes = config.summarizer?.idle_sweep?.idle_minutes ?? 15;
  const maxSpawnsPerPass = config.summarizer?.idle_sweep?.max_spawns_per_pass ?? 3;

  idleSweepTimer = setInterval(() => {
    void sweepIdleSessions(store, {
      idleMinutes,
      maxSpawnsPerPass,
    }).catch(() => {
      /* best-effort — never crash the MCP server */
    });
  }, intervalMinutes * 60_000);

  // Node keeps the process alive for stdio MCP even when the interval is the only handle.
  idleSweepTimer.unref?.();
}

/** Stop the idle sweep timer (for tests and graceful shutdown). */
export function stopIdleSweepTimer(): void {
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  }
}

/** Whether the idle sweep timer is running (tests). */
export function isIdleSweepTimerRunning(): boolean {
  return idleSweepTimer !== null;
}

/**
 * Keep entry_vectors filled (duplicate detection's cosine arm, hybrid search).
 * Started by the HTTP singleton only: every stdio server would load its own
 * ~90 MB ONNX model. Drains all unembedded entries per pass; the first pass is
 * the backfill.
 */
export function startEmbeddingTimer(store: TimStore, intervalMs = 5 * 60_000): void {
  if (embeddingTimer || isSummarizerChild()) return;
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      while ((await embedUnembeddedEntries(store)) > 0) { /* next batch */ }
    } catch {
      /* best-effort — never crash the MCP server */
    } finally {
      running = false;
    }
  };
  void pass();
  embeddingTimer = setInterval(() => void pass(), intervalMs);
  embeddingTimer.unref?.();
}

export function stopEmbeddingTimer(): void {
  if (embeddingTimer) {
    clearInterval(embeddingTimer);
    embeddingTimer = null;
  }
}
