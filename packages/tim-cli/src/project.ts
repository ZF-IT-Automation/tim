import {
  TimStore,
  listRelatedProjects,
  relateProjects,
  unrelateProjects,
  setProjectDescription,
  getProjectInterfaces,
  setProjectInterfaces,
  formatRelatedProjectLine,
  projectDisplayNameFromEntry,
} from 'tim-store';
import { findMarker, findMarkerOptionsFromEnv } from 'tim-hooks';
import { getDbPath } from './db-path.js';

const USAGE =
  'Usage: tim project <relate|unrelate|related|describe|interfaces> ...\n' +
  '  tim project relate [<A>] <B>        link two projects (A defaults to this directory\'s project)\n' +
  '  tim project unrelate [<A>] <B>\n' +
  '  tim project related [<A>]\n' +
  '  tim project describe [<P>] "<text>"  1–3 sentences: what the project IS\n' +
  '  tim project interfaces [<P>] [--set "<text>"]  what the project exposes (CLI, MCP, files, env, APIs)\n' +
  'A project is a label (P0054), an alias or a name ("MAIMO", "game harness").';

class ProjectArgError extends Error {}

/** Label + readable name for any query the user could have typed. */
async function resolve(store: TimStore, query: string): Promise<{ label: string; name: string }> {
  const r = await store.resolveProjectLabel(query);
  if (r.status === 'found') {
    const entry = await store.requireProject(r.label);
    return { label: r.label, name: projectDisplayNameFromEntry(entry) };
  }
  const all = await store.listProjects();
  const named = (labels: string[]) => labels
    .map(l => `  ${l} ${all.find(p => p.label === l)?.title.split('|')[0]!.trim() ?? ''}`)
    .join('\n');
  if (r.status === 'ambiguous') {
    throw new ProjectArgError(`"${query}" matches several projects — pass the label:\n${named(r.labels)}`);
  }
  throw new ProjectArgError(`No project matches "${query}". Known projects:\n${named(all.map(p => p.label).sort())}`);
}

/** The project this directory is bound to (.tim-project), for the omitted first argument. */
function currentProject(): string {
  const found = findMarker(process.cwd(), { ...(findMarkerOptionsFromEnv() ?? {}), walkUp: true });
  if (!found) {
    throw new ProjectArgError('No project given and this directory has no .tim-project marker — name the project.');
  }
  return found.marker.project;
}

const show = (p: { label: string; name: string }) => `${p.label} ${p.name}`;

export async function cmdProject(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '--help') {
    console.error(USAGE);
    return;
  }

  const store = new TimStore(getDbPath());
  try {
    switch (sub) {
      case 'relate':
      case 'unrelate': {
        if (rest.length < 1 || rest.length > 2) throw new ProjectArgError(USAGE);
        const [qa, qb] = rest.length === 2 ? rest : [currentProject(), rest[0]!];
        const a = await resolve(store, qa!);
        const b = await resolve(store, qb!);
        if (sub === 'relate') {
          const result = await relateProjects(store, a.label, b.label);
          console.log(
            result === 'noop-self' ? `No change: ${show(a)} is the same project on both sides`
              : result === 'noop-exists' ? `Already related: ${show(a)} ↔ ${show(b)}`
                : `Related ${show(a)} ↔ ${show(b)}`,
          );
        } else {
          const removed = await unrelateProjects(store, a.label, b.label);
          console.log(removed
            ? `Unrelated ${show(a)} ↔ ${show(b)}`
            : `No related edge between ${show(a)} and ${show(b)}`);
        }
        break;
      }
      case 'related': {
        const a = await resolve(store, rest[0] ?? currentProject());
        const neighbours = await listRelatedProjects(store, a.label);
        if (neighbours.length === 0) console.log(`No related projects for ${show(a)}`);
        for (const n of neighbours) console.log(formatRelatedProjectLine(n));
        break;
      }
      case 'describe': {
        if (rest.length === 0) throw new ProjectArgError(USAGE);
        // Two or more args: the first is the project when it names one;
        // otherwise everything is the text for this directory's project.
        let target: { label: string; name: string } | null = null;
        let words = rest;
        if (rest.length >= 2) {
          target = await resolve(store, rest[0]!).catch(() => null);
          if (target) words = rest.slice(1);
        }
        target ??= await resolve(store, currentProject());
        const text = words.join(' ').trim();
        if (!text) throw new ProjectArgError(USAGE);
        await setProjectDescription(store, target.label, text);
        console.log(`Description set for ${show(target)}`);
        break;
      }
      case 'interfaces': {
        const setAt = rest.indexOf('--set');
        const head = setAt === -1 ? rest : rest.slice(0, setAt);
        if (head.length > 1) throw new ProjectArgError(USAGE);
        const target = await resolve(store, head[0] ?? currentProject());
        if (setAt === -1) {
          const entry = await getProjectInterfaces(store, target.label);
          if (!entry) {
            console.log(`No interfaces recorded for ${show(target)} — tim project interfaces ${target.label} --set "<text>"`);
          } else {
            console.log(`${entry.id} · ${show(target)}\n${entry.content}`);
          }
          break;
        }
        const text = rest.slice(setAt + 1).join(' ').trim();
        if (!text) throw new ProjectArgError(USAGE);
        const entry = await setProjectInterfaces(store, target.label, text);
        console.log(`Interfaces set for ${show(target)}: ${entry.id}`);
        break;
      }
      default:
        throw new ProjectArgError(USAGE);
    }
  } catch (err) {
    if (!(err instanceof ProjectArgError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
