import { chmod } from 'node:fs/promises';

if (process.platform !== 'win32') {
  const executableEntrypoints = [
    'packages/tim-cli/dist/cli.js',
    'packages/tim-mcp/dist/server.js',
    'packages/tim-summarizer/dist/summarize.js',
    'packages/tim-sync-server/dist/cli.js',
  ];

  await Promise.all(executableEntrypoints.map((file) => chmod(file, 0o755)));
}
