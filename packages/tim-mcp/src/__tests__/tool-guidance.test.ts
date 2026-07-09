import { describe, it, expect } from 'vitest';
import { TOOL_DEFS } from '../server.js';

function desc(name: string): string {
  return TOOL_DEFS.find(d => d.name === name)?.description ?? '';
}

describe('MCP tool guidance', () => {
  it('guides hmem import order', () => {
    expect(desc('tim_import')).toContain('dryRun:true');
    expect(desc('tim_import')).toContain('tim_import_manifest');
    expect(desc('tim_import')).toContain('tim_import_audit');
  });

  it('warns write tools to read before replacing content', () => {
    expect(desc('tim_update')).toContain('tim_read first');
    expect(desc('tim_move_entry')).toContain('Preview with tim_dry_run_move');
  });
});
