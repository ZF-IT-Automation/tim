import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { applyArgAliases, explainMissingParams } from '../arg-aliases.js';
import { TOOL_DEFS } from '../server.js';

describe('applyArgAliases', () => {
  it('renames the names callers guessed for tim_load_project', () => {
    expect(applyArgAliases('tim_load_project', { project: 'P0054' })).toEqual({ label: 'P0054' });
    expect(applyArgAliases('tim_load_project', { projectId: 'P0054' })).toEqual({ label: 'P0054' });
  });

  it('renames tim_read placement synonyms', () => {
    expect(applyArgAliases('tim_read', { parentLabel: 'P0063', sectionTitle: 'Bugs' }))
      .toEqual({ project: 'P0063', section: 'Bugs' });
  });

  it('leaves the canonical name alone when both are present', () => {
    expect(applyArgAliases('tim_load_project', { label: 'P0063', project: 'P0054' }))
      .toEqual({ label: 'P0063', project: 'P0054' });
  });

  it('does not rewrite parameters that are legitimately snake_case', () => {
    const args = { id: 'P0063', include_body: true };
    expect(applyArgAliases('tim_read', args)).toBe(args);
  });

  it('passes through tools with no alias table', () => {
    const args = { query: 'foo' };
    expect(applyArgAliases('tim_search', args)).toBe(args);
  });

  it('only maps onto parameters the target schema really has', () => {
    for (const [tool, aliases] of Object.entries({
      tim_load_project: ['label'],
      tim_read: ['project', 'section'],
    })) {
      const def = TOOL_DEFS.find(d => d.name === tool);
      expect(def, `${tool} missing from TOOL_DEFS`).toBeDefined();
      for (const key of aliases) {
        expect(Object.keys(def!.schema.shape)).toContain(key);
      }
    }
  });
});

describe('explainMissingParams', () => {
  const schema = z.object({ label: z.string(), depth: z.number().optional() });

  it('names the missing parameter, what was sent, and what is valid', () => {
    const err = schema.safeParse({ cwd: '/tmp/x' });
    const msg = explainMissingParams('tim_load_project', (err as any).error, { cwd: '/tmp/x' }, [
      'label',
      'depth',
    ]);
    expect(msg).toBe(
      "tim_load_project: missing required parameter 'label'. Received: cwd. Valid parameters: label, depth."
    );
  });

  it('returns null for failures that are not a missing parameter', () => {
    const err = schema.safeParse({ label: 'P1', depth: 'deep' });
    expect(explainMissingParams('tim_load_project', (err as any).error, {}, ['label'])).toBeNull();
    expect(explainMissingParams('tim_read', new Error('boom'), {}, ['id'])).toBeNull();
  });
});
