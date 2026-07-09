import { describe, it, expect } from 'vitest';
import { requiresSnapshot, requiresConfirm } from '../safety.js';

describe('risk safety', () => {
  it('requires snapshot for live imports and repairs', () => {
    expect(requiresSnapshot('import', { dryRun: false })).toBe(true);
    expect(requiresSnapshot('import', { dryRun: true })).toBe(false);
    expect(requiresSnapshot('repair-flags', { dryRun: false })).toBe(true);
    expect(requiresSnapshot('migrate-from-hmem', { dryRun: false })).toBe(true);
    expect(requiresSnapshot('migrate-from-hmem', { dryRun: true })).toBe(false);
  });

  it('requires confirm for destructive commands', () => {
    expect(requiresConfirm('restore', { force: true })).toBe(true);
    expect(requiresConfirm('restore', { force: 'true' })).toBe(true);
    expect(requiresConfirm('restore', { force: 'false' })).toBe(false);
    expect(requiresConfirm('delete-batch', { hard: true })).toBe(true);
    expect(requiresConfirm('delete-batch', { hard: 'true' })).toBe(true);
  });
});
