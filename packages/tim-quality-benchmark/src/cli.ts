#!/usr/bin/env node
import { runBenchmark } from './runner.js';

function parseArgs(argv: string[]): { output?: string } {
  let output: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' && argv[i + 1]) {
      output = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: tim-quality-benchmark [--output <path>]

Runs bilingual memory quality scenarios (no-memory, fixed-handoff, tim) with full-text search.`);
      process.exit(0);
    }
  }
  return { output };
}

async function main(): Promise<void> {
  const { output } = parseArgs(process.argv);
  const report = await runBenchmark({ outputPath: output });
  if (!output) {
    process.stdout.write(JSON.stringify(report, null, 2));
    process.stdout.write('\n');
  } else {
    process.stderr.write(`Wrote report to ${output}\n`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
