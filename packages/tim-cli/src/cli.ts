#!/usr/bin/env node
// TIM CLI — v0.1.0-alpha

import { TimStore } from 'tim-store';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DB_PATH = process.env.TIM_DB_PATH || path.join(os.homedir(), '.tim', 'tim.db');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function cmdInit() {
  const timDir = path.join(os.homedir(), '.tim');
  ensureDir(timDir);

  const store = new TimStore(DB_PATH);

  // Register default agents
  try {
    await store.registerAgent('Default Agent', 'default');
    console.log('✓ Agent registered: "default"');
  } catch {}

  // Write MCP config
  const mcpConfig = {
    mcpServers: {
      tim: {
        command: 'npx',
        args: ['tim-mcp'],
        env: { TIM_DB_PATH: DB_PATH },
      },
    },
  };
  fs.writeFileSync(
    path.join(timDir, 'mcp.json'),
    JSON.stringify(mcpConfig, null, 2)
  );

  // Check health
  const health = await store.health();
  console.log(`✓ Database created: ${DB_PATH}`);
  console.log(`✓ MCP config written: ${timDir}/mcp.json`);
  console.log(`✓ Health: ${health.totalEntries} entries, FTS5=${health.ftsIntegrity ? 'OK' : 'BROKEN'}`);
  console.log(`\nTIM ready. Connect your MCP client to ${timDir}/mcp.json`);

  store.close();
}

async function cmdDoctor() {
  const store = new TimStore(DB_PATH);
  const health = await store.health();
  const stats = await store.stats();
  const agents = await store.getAgents();

  console.log('═══ TIM Doctor ═══');
  console.log(`DB: ${DB_PATH}`);
  console.log(`Entries: ${stats.totalEntries} | Edges: ${stats.totalEdges}`);
  console.log(`Confidence avg: ${stats.avgConfidence?.toFixed(2) ?? 'N/A'}`);
  console.log(`Broken links: ${health.brokenLinks}`);
  console.log(`Orphan entries: ${health.orphanEntries}`);
  console.log(`FTS5: ${health.ftsIntegrity ? '✓' : '✗ BROKEN'}`);
  console.log(`Agents: ${agents.map(a => a.label).join(', ') || 'none'}`);
  if (stats.oldestEntry) console.log(`Oldest: ${stats.oldestEntry}`);
  if (stats.newestEntry) console.log(`Newest: ${stats.newestEntry}`);
  console.log(`Stale (>30d): ${stats.staleCount}`);
  if (health.issues.length) {
    console.log('\n⚠ Issues:');
    health.issues.forEach(i => console.log(`  - ${i}`));
  }
  console.log(`\nTop tags: ${stats.topTags.slice(0, 5).map(t => `${t.tag}(${t.count})`).join(', ') || 'none'}`);

  store.close();
}

async function cmdStats() {
  const store = new TimStore(DB_PATH);
  const stats = await store.stats();
  console.log(JSON.stringify(stats, null, 2));
  store.close();
}

async function main() {
  const cmd = process.argv[2] || 'init';

  switch (cmd) {
    case 'init':
      await cmdInit();
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'stats':
      await cmdStats();
      break;
    case '--version':
    case '-v':
      console.log('tim v0.1.0-alpha');
      break;
    case '--help':
    case '-h':
      console.log(`TIM — Theoretically Infinite Memory

Usage: tim <command>

Commands:
  init      Initialize TIM (create DB, register agents, write MCP config)
  doctor    Run diagnostics
  stats     Show memory statistics
  --help    Show this help`);
      break;
    default:
      console.log(`Unknown command: ${cmd}\nRun 'tim --help' for usage.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
