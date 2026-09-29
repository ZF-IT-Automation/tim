// `tim open-work` — every open task, bug and idea of every project as JSON.
//
// A read surface for outside tools (the team-up dashboard panel): they get the
// backlog through this command instead of opening the database themselves.
// It adds no SELECTs of its own — getTasks/getBugs and the Ideas section are
// the same queries the briefing and tim_show already run.

import { TimStore, isSecret } from 'tim-store';
import { loadConfig, isClosedBugStatus } from 'tim-core';
import * as path from 'path';
import * as os from 'os';

/** Same closed set as the session briefing's open work. */
const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled', 'closed', 'wontfix']);

export interface OpenWorkItem {
  id: string;
  kind: 'task' | 'bug' | 'idea';
  title: string;
  status: string;
  priority: string | null;
  project: string;
}

export interface OpenWorkReport {
  projects: Array<{ label: string; title: string }>;
  items: OpenWorkItem[];
}

/** Titles copied from markdown bodies start with "# " / "## TASK:" — noise in a list. */
const listTitle = (title: string | null): string => String(title ?? '').replace(/^\s*#+\s*/, '');

const ideaStatus = (metadata: Record<string, unknown>): string => {
  const idea = metadata.idea;
  if (typeof idea === 'object' && idea !== null && !Array.isArray(idea)) {
    const st = (idea as Record<string, unknown>).status;
    if (typeof st === 'string') return st;
  }
  return 'new';
};

export async function collectOpenWork(store: TimStore): Promise<OpenWorkReport> {
  const db = store.getDb();
  const projects = await store.listProjects();
  const known = new Set(projects.map(p => p.label));
  const items: OpenWorkItem[] = [];
  const push = (item: OpenWorkItem) => {
    if (!known.has(item.project) || isSecret(db, item.id)) return;
    items.push(item);
  };

  for (const task of await store.getTasks()) {
    const status = task.status ?? 'todo';
    if (!task.project_label || CLOSED_TASK_STATUSES.has(status)) continue;
    push({
      id: task.id,
      kind: 'task',
      title: listTitle(task.title),
      status,
      priority: task.priority,
      project: task.project_label,
    });
  }

  for (const bug of await store.getBugs()) {
    const status = bug.status ?? 'open';
    if (!bug.project_label || isClosedBugStatus(status)) continue;
    push({
      id: bug.id,
      kind: 'bug',
      title: listTitle(bug.title),
      status,
      priority: bug.severity,
      project: bug.project_label,
    });
  }

  for (const project of projects) {
    const section = await store.resolveSectionByTitle(project.label, 'Ideas');
    const sections = section.status === 'found'
      ? [section.id]
      : section.status === 'ambiguous' ? section.candidates.map(c => c.id) : [];
    for (const id of sections) {
      for (const entry of await store.getChildren(id)) {
        // A promoted idea carries metadata.task and is already in the task list.
        if (entry.metadata.task !== undefined) continue;
        const status = ideaStatus(entry.metadata);
        if (status === 'rejected') continue;
        push({
          id: entry.id,
          kind: 'idea',
          title: listTitle(entry.title),
          status,
          priority: null,
          project: project.label,
        });
      }
    }
  }

  return { projects: projects.map(p => ({ label: p.label, title: p.title })), items };
}

export async function cmdOpenWork(_args: string[]): Promise<void> {
  const config = loadConfig();
  const dbPath = process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
  const store = new TimStore(dbPath);
  try {
    console.log(JSON.stringify(await collectOpenWork(store), null, 2));
  } finally {
    store.close();
  }
}
