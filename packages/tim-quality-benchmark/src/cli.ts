#!/usr/bin/env node
import { runBenchmark } from './runner.js';
import type { ProviderMode } from './types.js';

function parseArgs(argv: string[]): { output?: string; providerMode: ProviderMode } {
  let output: string | undefined;
  let providerMode: ProviderMode = 'synthetic';
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--real-provider') {
      providerMode = 'real';
    } else if (arg === '--output' && argv[i + 1]) {
      output = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: tim-quality-benchmark [--output <path>] [--real-provider]

Runs bilingual memory quality scenarios (no-memory, fixed-handoff, tim).
Default provider mode is deterministic synthetic (CI smoke).
Pass --real-provider with TIM_EMBEDDING_REAL_MODEL=1 for optional local model smoke.`);
      process.exit(0);
    }
  }
  return { output, providerMode };
}

async function main(): Promise<void> {
  const { output, providerMode } = parseArgs(process.argv);
  const report = await runBenchmark({ providerMode, outputPath: output });
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
