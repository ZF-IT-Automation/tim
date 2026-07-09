import { describe, it, expect } from 'vitest';
import {
  buildImportAuditArgs,
  buildMigrateFromHmemPlan,
  evaluateDryRunGate,
} from '../migrate-from-hmem.js';

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
