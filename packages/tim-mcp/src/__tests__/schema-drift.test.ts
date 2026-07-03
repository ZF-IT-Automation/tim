import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TOOL_DEFS } from '../server.js';

describe('ListTools schema drift', () => {
  it('every zod schema property appears in generated inputSchema', () => {
    for (const def of TOOL_DEFS) {
      const json = zodToJsonSchema(def.schema, { target: 'openApi3' }) as { properties?: Record<string, unknown> };
      const zodKeys = Object.keys(def.schema.shape);
      const jsonKeys = Object.keys(json.properties ?? {});
      expect(jsonKeys.sort(), `${def.name} missing keys`).toEqual(zodKeys.sort());
    }
  });
});
