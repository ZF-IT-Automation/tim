import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, TimStore, type EmbeddingProvider } from 'tim-store';
import type { DatasetEntry, DatasetFixture } from './types.js';
import { SYNTHETIC_DIMENSION, SYNTHETIC_MODEL_ID, vectorForHint } from './synthetic-provider.js';

export interface FixtureStore {
  store: TimStore;
  dbPath: string;
  tmpDir: string;
  goldToEntryId: Map<string, string>;
  entryIdToGold: Map<string, string>;
  projectLabel: string;
  adversarialProjectLabel: string;
}

export interface BuildFixtureOptions {
  /** When true, embed entry text through the provider instead of vectorHint shortcuts. */
  realEmbeddings?: boolean;
}

async function writeSection(
  store: TimStore,
  projectId: string,
  title: string,
  order: number,
): Promise<string> {
  const section = await store.write(title, {
    parentId: projectId,
    metadata: { kind: 'section', label: title, order },
    tags: ['#section', '#schema'],
  });
  return section.id;
}

async function seedNoisyLog(store: TimStore, projectId: string): Promise<void> {
  const log = await store.write('Log', {
    parentId: projectId,
    metadata: { kind: 'section', label: 'Log', order: 1 },
    tags: ['#section', '#schema'],
  });
  for (let i = 0; i < 120; i++) {
    await store.write(`Log filler ${i}\nnoise-entry-${i} unrelated chatter [retrieved:log-${i}]`, {
      parentId: log.id,
      tags: ['#log'],
    });
  }
}

async function seedPartialSession(
  store: TimStore,
  projectLabel: string,
): Promise<void> {
  const sessions = new SessionManager(store);
  await sessions.startProjectSession({
    sessionId: 'bench-partial',
    projectId: projectLabel,
    agentName: 'benchmark',
    cwd: '/tmp',
    harness: 'tim-quality-benchmark',
    batchSize: 5,
  });
  await sessions.logExchange('bench-partial', [
    { role: 'user', content: 'Q1 auth scope' },
    { role: 'agent', content: 'A1 partial' },
    { role: 'user', content: 'Q2 middleware' },
    { role: 'agent', content: 'A2 partial' },
  ]);
  await sessions.writeBatchSummary(
    'bench-partial',
    1,
    'Partial session checkpoint [gold:session-partial]\nCovered exchanges 1-2; tail still pending summarization.',
    { seqFrom: 1, seqTo: 2 },
  );
  await sessions.logExchange('bench-partial', [
    { role: 'user', content: 'Q3 tail pending' },
    { role: 'agent', content: 'A3 tail pending' },
  ]);
}

async function writeFixtureEntry(
  store: TimStore,
  fixture: DatasetFixture,
  entry: DatasetEntry,
  projectIds: Record<string, string>,
  sectionIds: Record<string, string>,
  useSyntheticVectors: boolean,
): Promise<string> {
  const projectKey = entry.project ?? fixture.projectLabel;
  const projectId = projectIds[projectKey];
  const sectionId = sectionIds[`${projectKey}:${entry.section}`];
  const written = await store.write(`${entry.title}\n${entry.body} [${entry.goldLabel}]`, {
    parentId: sectionId,
    tags: entry.tags ?? ['#note'],
    metadata: {
      benchmark: { goldLabel: entry.goldLabel },
      ...(entry.temporal ? { temporal: entry.temporal } : {}),
      ...(entry.section === 'Tasks'
        ? { task: { status: 'todo', priority: 'high', order: 10 } }
        : {}),
      ...(entry.section === 'Rules'
        ? { type: 'rule', rule: { action: entry.title } }
        : {}),
    },
  });
  if (useSyntheticVectors) {
    if (entry.vectorHint) {
      store.setVectors(
        written.id,
        vectorForHint(entry.vectorHint),
        SYNTHETIC_MODEL_ID,
        SYNTHETIC_DIMENSION,
      );
    } else if (entry.section === 'Decisions') {
      store.setVectors(
        written.id,
        vectorForHint('decision'),
        SYNTHETIC_MODEL_ID,
        SYNTHETIC_DIMENSION,
      );
    }
  }
  return written.id;
}

async function embedEntriesForReal(
  store: TimStore,
  entryTexts: Map<string, string>,
  provider: EmbeddingProvider,
): Promise<void> {
  const ids = [...entryTexts.keys()];
  if (ids.length === 0) return;
  const texts = ids.map(id => entryTexts.get(id)!);
  const vectors = await provider.embed(texts);
  for (let i = 0; i < ids.length; i++) {
    store.setVectors(ids[i], vectors[i], provider.modelId, provider.dimension);
  }
}

export async function buildFixtureStore(
  fixture: DatasetFixture,
  provider: EmbeddingProvider,
  options: BuildFixtureOptions = {},
): Promise<FixtureStore> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-quality-bench-'));
  const dbPath = path.join(tmpDir, 'bench.db');
  const store = new TimStore(dbPath, { embeddingProvider: provider });
  const useSyntheticVectors = !options.realEmbeddings;

  const goldToEntryId = new Map<string, string>();
  const entryIdToGold = new Map<string, string>();
  const entryTexts = new Map<string, string>();

  try {
    const mainProject = await store.createProject(fixture.projectLabel, {
      content: 'Memory quality benchmark primary project',
    });
    const noiseProject = await store.createProject(fixture.adversarialProjectLabel, {
      content: 'Adversarial similar project for scope confusion',
    });

    const projectIds: Record<string, string> = {
      [fixture.projectLabel]: mainProject.id,
      [fixture.adversarialProjectLabel]: noiseProject.id,
    };

    const sectionNames = new Set(fixture.entries.map(e => e.section));
    sectionNames.add('Decisions');
    sectionNames.add('Ideas');
    sectionNames.add('Rules');
    sectionNames.add('Tasks');

    const sectionIds: Record<string, string> = {};
    let order = 2;
    for (const projectKey of [fixture.projectLabel, fixture.adversarialProjectLabel]) {
      for (const name of sectionNames) {
        const needed =
          fixture.entries.some(
            e => (e.project ?? fixture.projectLabel) === projectKey && e.section === name,
          ) || projectKey === fixture.projectLabel;
        if (!needed) continue;
        sectionIds[`${projectKey}:${name}`] = await writeSection(
          store,
          projectIds[projectKey],
          name,
          order++,
        );
      }
    }

    await seedNoisyLog(store, mainProject.id);
    await seedPartialSession(store, fixture.projectLabel);

    const pendingLinks: Array<{ fromGold: string; toGold: string }> = [];
    for (const entry of fixture.entries) {
      const entryId = await writeFixtureEntry(
        store,
        fixture,
        entry,
        projectIds,
        sectionIds,
        useSyntheticVectors,
      );
      goldToEntryId.set(entry.goldLabel, entryId);
      entryIdToGold.set(entryId, entry.goldLabel);
      entryTexts.set(entryId, `${entry.title}\n${entry.body} [${entry.goldLabel}]`);
      if (entry.supersedesGold) {
        pendingLinks.push({ fromGold: entry.goldLabel, toGold: entry.supersedesGold });
      }
    }

    if (options.realEmbeddings) {
      await embedEntriesForReal(store, entryTexts, provider);
    }

    for (const link of pendingLinks) {
      const fromId = goldToEntryId.get(link.fromGold);
      const toId = goldToEntryId.get(link.toGold);
      if (!fromId || !toId) {
        throw new Error(`Missing supersession endpoints: ${link.fromGold} -> ${link.toGold}`);
      }
      await store.link(fromId, toId, 'supersedes', 1.0, {
        effectiveAt: '2026-03-01T00:00:00Z',
      });
    }

    return {
      store,
      dbPath,
      tmpDir,
      goldToEntryId,
      entryIdToGold,
      projectLabel: fixture.projectLabel,
      adversarialProjectLabel: fixture.adversarialProjectLabel,
    };
  } catch (err) {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

export function closeFixtureStore(fixture: FixtureStore): void {
  try {
    fixture.store.close();
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.unlinkSync(fixture.dbPath + suffix);
      } catch {
        /* already removed with tmpDir */
      }
    }
  }
}
