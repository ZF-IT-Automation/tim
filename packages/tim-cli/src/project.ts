import * as os from 'os';
import * as path from 'path';
import { loadConfig } from 'tim-core';
import {
  TimStore,
  listRelatedProjects,
  relateProjects,
  unrelateProjects,
  setProjectDescription,
  formatRelatedProjectLine,
} from 'tim-store';

function resolveDbPath(): string {
  if (process.env.TIM_DB_PATH) return process.env.TIM_DB_PATH;
  const config = loadConfig();
  return config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

function usage(): void {
  console.error(
    'Usage: tim project <relate|unrelate|related|describe> ...\n' +
      '  tim project relate <A> <B>\n' +
      '  tim project unrelate <A> <B>\n' +
      '  tim project related <A>\n' +
      '  tim project describe <P> "<text>"',
  );
}

export async function cmdProject(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === 'help' || sub === '--help') {
    usage();
    return;
  }

  const store = new TimStore(resolveDbPath());
  try {
    switch (sub) {
      case 'relate': {
        const [a, b] = rest;
        if (!a || !b) {
          usage();
          process.exit(1);
        }
        const result = await relateProjects(store, a, b);
        if (result === 'noop-self') {
          console.log(`No change: ${a} and ${b} are the same project`);
        } else if (result === 'noop-exists') {
          console.log(`Already related: ${a} ↔ ${b}`);
        } else {
          console.log(`Related ${a} ↔ ${b}`);
        }
        break;
      }
      case 'unrelate': {
        const [a, b] = rest;
        if (!a || !b) {
          usage();
          process.exit(1);
        }
        const removed = await unrelateProjects(store, a, b);
        console.log(removed ? `Unrelated ${a} ↔ ${b}` : `No related edge between ${a} and ${b}`);
        break;
      }
      case 'related': {
        const [a] = rest;
        if (!a) {
          usage();
          process.exit(1);
        }
        const neighbours = await listRelatedProjects(store, a);
        if (neighbours.length === 0) {
          console.log(`No related projects for ${a}`);
        } else {
          for (const n of neighbours) {
            console.log(formatRelatedProjectLine(n));
          }
        }
        break;
      }
      case 'describe': {
        const label = rest[0];
        const text = rest.slice(1).join(' ').trim();
        if (!label || !text) {
          usage();
          process.exit(1);
        }
        await setProjectDescription(store, label, text);
        console.log(`Description set for ${label}`);
        break;
      }
      default:
        usage();
        process.exit(1);
    }
  } finally {
    store.close();
  }
}
