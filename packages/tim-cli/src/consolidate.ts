import * as os from 'os';
import * as path from 'path';
import { loadConfig } from 'tim-core';
import { TimStore } from 'tim-store';
import { processCurationQueue } from 'tim-summarizer';

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = 'true';
      }
    }
  }
  return parsed;
}

function resolveDbPath(): string {
  if (process.env.TIM_DB_PATH) return process.env.TIM_DB_PATH;
  const config = loadConfig();
  return config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

function printHelp(): void {
  console.log(`tim consolidate — memory consolidation pipeline

Usage:
  tim consolidate find-duplicates [--project P0063]
  tim consolidate find-decay [--project P0063]
  tim consolidate run [--project P0063]
  tim consolidate status [--project P0063]
`);
}

export async function cmdConsolidate(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = sub ? args.slice(1) : args;
  const flags = parseArgs(rest);
  const project = flags.project;

  if (!sub || sub === 'help' || sub === '--help') {
    printHelp();
    return;
  }

  if (!project) {
    console.error(`tim consolidate ${sub}: --project <P00XX> required`);
    process.exit(1);
  }

  const store = new TimStore(resolveDbPath());
  try {
    const mgr = store.consolidate();

    switch (sub) {
      case 'find-duplicates': {
        const hits = await mgr.findDuplicateCandidates(project, {
          threshold: flags.threshold ? Number(flags.threshold) : undefined,
        });
        console.log(JSON.stringify({ project, count: hits.length, candidates: hits }, null, 2));
        break;
      }
      case 'find-decay': {
        const hits = await mgr.findDecayCandidates(project, {
          accessDays: flags['access-days'] ? Number(flags['access-days']) : undefined,
          accessCount: flags['access-count'] ? Number(flags['access-count']) : undefined,
          verifiedDays: flags['verified-days'] ? Number(flags['verified-days']) : undefined,
        });
        console.log(JSON.stringify({ project, count: hits.length, candidates: hits }, null, 2));
        break;
      }
      case 'run': {
        const dupes = await mgr.findDuplicateCandidates(project);
        const decay = await mgr.findDecayCandidates(project);
        const processed = await processCurationQueue(store, project);
        console.log(
          JSON.stringify(
            {
              project,
              queued: { duplicates: dupes.length, decay: decay.length },
              processed,
            },
            null,
            2,
          ),
        );
        break;
      }
      case 'status': {
        const stats = await mgr.getCurationStats(project);
        const pending = await mgr.getCurationQueue(project, 'pending');
        console.log(
          JSON.stringify(
            {
              project,
              stats,
              pending: pending.map(e => ({
                id: e.id,
                consolidation: e.metadata.consolidation,
                pair: e.metadata.pair,
                target: e.metadata.target,
                reason: e.metadata.reason,
              })),
            },
            null,
            2,
          ),
        );
        break;
      }
      default:
        printHelp();
        process.exit(1);
    }
  } finally {
    store.close();
  }
}
