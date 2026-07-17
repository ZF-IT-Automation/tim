import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

const generatedEntrypoints = [
  'packages/tim-core/dist/index.js',
  'packages/tim-store/dist/index.js',
  'packages/tim-hooks/dist/index.js',
  'packages/tim-cli/dist/cli.js',
  'packages/tim-mcp/dist/server.js',
  'packages/tim-summarizer/dist/summarize.js',
  'packages/tim-sync-server/dist/cli.js',
];

const executableEntrypoints = [
  'packages/tim-cli/dist/cli.js',
  'packages/tim-mcp/dist/server.js',
  'packages/tim-summarizer/dist/summarize.js',
  'packages/tim-sync-server/dist/cli.js',
];

for (const file of generatedEntrypoints) {
  await access(file, constants.R_OK);
}

if (process.platform !== 'win32') {
  for (const file of executableEntrypoints) {
    const mode = (await stat(file)).mode;
    if ((mode & 0o111) === 0) {
      throw new Error(`Expected executable build output: ${file}`);
    }
  }
}

console.log('Build outputs are present and executable entrypoints retain execute permission.');
