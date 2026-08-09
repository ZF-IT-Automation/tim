#!/usr/bin/env node
/**
 * One-shot migration: move the children of a project's `Bugs` section onto the
 * `metadata.bug` annotation introduced in aa5a70b.
 *
 * Per node:
 *   - metadata.type      = 'bug'
 *   - metadata.bug.status derived from metadata.task.status / metadata.status
 *                        (done|fixed → fixed, documented → documented,
 *                         cancelled → wontfix, anything else → open)
 *   - metadata.bug.severity carried over from metadata.severity when present
 *   - metadata.bug.legacy = true when the node closes without a fix commit —
 *     their commit, where it exists, is prose in the body and is not parsed
 *   - metadata.task      = null, so the node leaves the task listing
 *
 * Post-mortem reports and root-cause analyses filed under `Bugs` are not bugs
 * and are skipped; they are recognized by their #post-mortem tag.
 *
 * Dry-run by default. Idempotent: a node that already carries metadata.bug is
 * reported as unchanged.
 *
 * Usage:
 *   node scripts/migrate-bugs.mjs --project P0063 [--db PATH] [--apply]
 *   node scripts/migrate-bugs.mjs --section <sectionId> [--db PATH] [--apply]
 *
 * --section takes a Bugs section id directly, for projects whose label resolves
 * to a different tree than the one holding the section (P0062 has two).
 */

import path from 'node:path';
import { TimStore } from '../packages/tim-store/dist/index.js';

const defaultDb = path.join(process.env.HOME ?? '', '.tim', 'tim.db');

function parseArgs(argv) {
  let dbPath = defaultDb;
  let project = null;
  let sectionId = null;
  let apply = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--project') {
      project = argv[++i];
    } else if (arg === '--section') {
      sectionId = argv[++i];
    } else if (arg === '--db') {
      dbPath = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/migrate-bugs.mjs --project P0063 [--db PATH] [--apply]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!project && !sectionId) {
    console.error('--project or --section is required (e.g. --project P0063)');
    process.exit(1);
  }
  return { dbPath, project, sectionId, apply };
}

const CLOSED_STATUS = { done: 'fixed', fixed: 'fixed', documented: 'documented', cancelled: 'wontfix' };

function currentStatus(metadata) {
  const task = metadata.task;
  if (task && typeof task === 'object' && !Array.isArray(task) && typeof task.status === 'string') {
    return task.status;
  }
  return typeof metadata.status === 'string' ? metadata.status : null;
}

/** The shape this node should end up with, or null when it must not be touched. */
function plan(entry) {
  const metadata = entry.metadata ?? {};
  const tags = entry.tags ?? [];

  if (tags.includes('#post-mortem')) return { skip: 'post-mortem, not a bug' };
  if (metadata.bug && typeof metadata.bug === 'object') return { skip: 'already migrated' };

  const bug = { status: CLOSED_STATUS[currentStatus(metadata)] ?? 'open' };
  if (typeof metadata.severity === 'string') bug.severity = metadata.severity;
  if (bug.status !== 'open') bug.legacy = true;

  return { patch: { type: 'bug', bug, task: null } };
}

async function main() {
  const { dbPath, project, sectionId, apply } = parseArgs(process.argv);
  const store = new TimStore(dbPath);

  try {
    let sectionRef = sectionId;
    let label = sectionId;

    if (!sectionRef) {
      const resolved = await store.resolveProjectLabel(project);
      if (resolved.status !== 'found') {
        console.error(`Project not resolvable: ${project} (${resolved.status})`);
        process.exit(1);
      }
      const root = await store.read(resolved.label);
      const section = await store.resolveSectionByTitle(root.id, 'Bugs');
      if (section.status !== 'found') {
        console.error(`No unique 'Bugs' section in ${project} (${section.status})`);
        process.exit(1);
      }
      sectionRef = section.id;
      label = `${resolved.label} (root ${root.id})`;
    }

    const children = await store.getChildren(sectionRef);
    console.log(`DB: ${dbPath}`);
    console.log(`Bugs section: ${label} · children: ${children.length}`);
    console.log(`Mode: ${apply ? 'WRITE' : 'dry-run'}\n`);

    let migrated = 0;
    let skipped = 0;

    for (const entry of children) {
      const { skip, patch } = plan(entry);
      const title = entry.title.replace(/\s+/g, ' ').slice(0, 60);

      if (skip) {
        skipped++;
        console.log(`  skip   ${entry.id.slice(-6)} ${title} — ${skip}`);
        continue;
      }

      migrated++;
      console.log(`  bug    ${entry.id.slice(-6)} ${title} — ${JSON.stringify(patch.bug)}`);
      if (apply) await store.update(entry.id, { metadata: patch });
    }

    console.log(`\nSummary: ${migrated} ${apply ? 'migrated' : 'would migrate'}, ${skipped} skipped.`);
  } finally {
    store.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
