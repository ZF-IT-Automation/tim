import { describe, it, expect } from 'vitest';
import { CORE_MCP_TOOLS, TOOL_DEFS } from '../server.js';

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
    expect(desc('tim_move_entry')).toContain('Read the entry and its parent first');
    expect(desc('tim_move_entry')).not.toContain('tim_dry_run_move');
  });

  it('core tool descriptions do not name a hidden tool', () => {
    const core = new Set<string>(CORE_MCP_TOOLS);
    const hidden = TOOL_DEFS.map(def => def.name).filter(name => !core.has(name));
    for (const def of TOOL_DEFS) {
      if (!core.has(def.name)) continue;
      for (const name of hidden) {
        const mention = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
        expect(def.description, `${def.name} mentions ${name}`).not.toMatch(mention);
      }
    }
  });

  it('documents the opt-in looks-done filter on tim_show', () => {
    expect(desc('tim_show')).toContain('looks-done');
    const show = TOOL_DEFS.find(definition => definition.name === 'tim_show')!;
    expect(show.schema.shape.with.description).toContain('looks-done');
  });

  it('documents the bounded tim_search response contract', () => {
    const search = TOOL_DEFS.find(definition => definition.name === 'tim_search')!;

    expect(search.description).toContain('{results, returned, omitted, truncated}');
    expect(search.description).toContain('bounded excerpts');
    expect(search.description).toContain('tim_read');
    expect(search.description).toContain('full body');
    expect(search.description).toContain('includeCommits');
    expect(search.schema.description).toContain('{results, returned, omitted, truncated}');
  });
});
