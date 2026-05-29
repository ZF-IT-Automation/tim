#!/usr/bin/env node
"use strict";
// TIM CLI — v0.1.0-alpha
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const tim_store_1 = require("tim-store");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const DB_PATH = process.env.TIM_DB_PATH || path.join(os.homedir(), '.tim', 'tim.db');
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
async function cmdInit() {
    const timDir = path.join(os.homedir(), '.tim');
    ensureDir(timDir);
    const store = new tim_store_1.TimStore(DB_PATH);
    // Register default agents
    try {
        await store.registerAgent('Default Agent', 'default');
        console.log('✓ Agent registered: "default"');
    }
    catch { }
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
    fs.writeFileSync(path.join(timDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2));
    // Check health
    const health = await store.health();
    console.log(`✓ Database created: ${DB_PATH}`);
    console.log(`✓ MCP config written: ${timDir}/mcp.json`);
    console.log(`✓ Health: ${health.totalEntries} entries, FTS5=${health.ftsIntegrity ? 'OK' : 'BROKEN'}`);
    console.log(`\nTIM ready. Connect your MCP client to ${timDir}/mcp.json`);
    store.close();
}
async function cmdDoctor() {
    const store = new tim_store_1.TimStore(DB_PATH);
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
    if (stats.oldestEntry)
        console.log(`Oldest: ${stats.oldestEntry}`);
    if (stats.newestEntry)
        console.log(`Newest: ${stats.newestEntry}`);
    console.log(`Stale (>30d): ${stats.staleCount}`);
    if (health.issues.length) {
        console.log('\n⚠ Issues:');
        health.issues.forEach(i => console.log(`  - ${i}`));
    }
    console.log(`\nTop tags: ${stats.topTags.slice(0, 5).map(t => `${t.tag}(${t.count})`).join(', ') || 'none'}`);
    store.close();
}
async function cmdStats() {
    const store = new tim_store_1.TimStore(DB_PATH);
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
//# sourceMappingURL=cli.js.map