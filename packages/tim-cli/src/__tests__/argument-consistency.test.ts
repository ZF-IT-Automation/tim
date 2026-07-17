import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HANDLERS = [
  'record-commit.ts',
  'migrate-from-hmem.ts',
  'consolidate.ts',
  'sync-cli.ts',
  'snapshot.ts',
  'restore.ts',
  'new-project.ts',
  'hermes-statusline-install.ts',
];

describe('CLI argument parsing consistency', () => {
  it.each(HANDLERS)('%s uses the shared parser without private parsing loops', (filename) => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', filename), 'utf8');
    expect(source).toMatch(/from ['"]\.\/args\.js['"]/);
    expect(source).not.toMatch(/function parse(?:Args|Flags|SyncArgs|NewProjectArgs)\b/);
    expect(source).not.toMatch(/args\.includes\(['"]--/);
  });
});
