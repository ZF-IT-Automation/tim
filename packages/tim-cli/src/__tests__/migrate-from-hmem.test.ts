import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import { writeMarkerExclusive } from 'tim-hooks';
import {
  buildImportAuditArgs,
  buildMigrateFromHmemPlan,
  collectMigrationProjectBindings,
  evaluateDryRunGate,
  formatMigrationBindingLines,
} from '../migrate-from-hmem.js';

const TEST_ROOT = '/tmp/tim-test-runs';

describe('migrate-from-hmem planner', () => {
  it('runs manifest, dry-run, snapshot, import, audit, doctor in order', () => {
    const plan = buildMigrateFromHmemPlan('/tmp/source.hmem', { deduplicate: true });
    expect(plan.map(s => s.id)).toEqual([
      'manifest',
      'dry-run',
      'snapshot',
      'import',
      'audit',
      'doctor',
      'bindings',
      'handoff',
    ]);
  });

  it('blocks live import when dry-run reports unknown format or warnings', () => {
    expect(evaluateDryRunGate({ format: 'unknown', warnings: [] })).toEqual([
      'Dry-run could not identify the source hmem format.',
    ]);
    expect(evaluateDryRunGate({ format: 'v2', warnings: ['bad link'] })).toEqual([
      'Dry-run warning: bad link',
    ]);
  });

  it('builds copy-paste safe import audit arguments', () => {
    expect(buildImportAuditArgs('/tmp/source.hmem')).toEqual({
      source: '/tmp/source.hmem',
      includeRepairPlan: true,
    });
  });
});

describe('migration binding report', () => {
  let root: string;
  let dbPath: string;
  let store: TimStore;
  let dirBound: string;
  let dirUnbound: string;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    root = fs.mkdtempSync(path.join(TEST_ROOT, 'migrate-bind-'));
    dbPath = path.join(root, 'tim.db');
    dirBound = path.join(root, 'bound');
    dirUnbound = path.join(root, 'unbound');
    fs.mkdirSync(dirBound);
    fs.mkdirSync(dirUnbound);

    store = new TimStore(dbPath);
    await store.createProject('P8101', {
      metadata: { path: dirBound, hmemUid: 'hmem-8101' },
    });
    await store.createProject('P8102', {
      metadata: { path: dirUnbound, hmemUid: 'hmem-8102' },
    });
    await store.createProject('P8103', {
      metadata: { hmemUid: 'hmem-8103' },
    });
    await store.createProject('P8199', { metadata: { path: dirBound } });

    writeMarkerExclusive(dirBound, { project: 'P8101' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports binding-state lines only for hmem-imported projects', async () => {
    const findings = await collectMigrationProjectBindings(store);
    const lines = formatMigrationBindingLines(findings);

    expect(findings.map(f => f.label)).toEqual(['P8101', 'P8102', 'P8103']);
    expect(lines).toContain(`${'P8101'} ${dirBound} bound`);
    expect(lines).toContain(`${'P8102'} ${dirUnbound} unbound`);
    expect(lines).toContain('P8103 no-path');
    expect(lines.some(line => line.includes('P8199'))).toBe(false);
  });
});
