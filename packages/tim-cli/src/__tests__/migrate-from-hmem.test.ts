import { describe, it, expect } from 'vitest';
import { buildMigrateFromHmemPlan } from '../migrate-from-hmem.js';

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
});
