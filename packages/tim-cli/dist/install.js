"use strict";
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
exports.HOST_TOOLS = void 0;
exports.detectInstalledHosts = detectInstalledHosts;
exports.buildTimMcpEntry = buildTimMcpEntry;
exports.mergeMcpConfig = mergeMcpConfig;
exports.installMcpForHosts = installMcpForHosts;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
function homeDir() {
    return os.homedir();
}
exports.HOST_TOOLS = [
    {
        id: 'claude-code',
        name: 'Claude Code',
        detect: () => fs.existsSync(path.join(homeDir(), '.claude')),
        mcpConfigPath: (global) => global ? path.join(homeDir(), '.claude.json') : path.join(process.cwd(), '.mcp.json'),
        format: 'standard',
    },
    {
        id: 'cursor',
        name: 'Cursor',
        detect: () => fs.existsSync(path.join(homeDir(), '.cursor')),
        mcpConfigPath: (global) => global
            ? path.join(homeDir(), '.cursor', 'mcp.json')
            : path.join(process.cwd(), '.cursor', 'mcp.json'),
        format: 'standard',
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        detect: () => fs.existsSync(path.join(homeDir(), '.config', 'opencode')),
        mcpConfigPath: (global) => global
            ? path.join(homeDir(), '.config', 'opencode', 'opencode.json')
            : path.join(process.cwd(), 'opencode.json'),
        format: 'opencode',
    },
    {
        id: 'gemini-cli',
        name: 'Gemini CLI',
        detect: () => fs.existsSync(path.join(homeDir(), '.gemini')) ||
            fs.existsSync(path.join(homeDir(), '.config', 'gemini')),
        mcpConfigPath: (global) => global
            ? path.join(homeDir(), '.gemini', 'settings.json')
            : path.join(process.cwd(), '.gemini', 'settings.json'),
        format: 'standard',
    },
];
function detectInstalledHosts() {
    return exports.HOST_TOOLS.filter(t => t.detect());
}
function buildTimMcpEntry(dbPath) {
    return {
        command: 'npx',
        args: ['tim-mcp'],
        env: { TIM_DB_PATH: dbPath },
    };
}
function mergeMcpConfig(existing, entry, format) {
    if (format === 'opencode') {
        const mcp = existing.mcp ?? {};
        return {
            ...existing,
            mcp: {
                ...mcp,
                tim: { type: 'local', command: [entry.command, ...entry.args], environment: entry.env ?? {} },
            },
        };
    }
    const servers = existing.mcpServers ?? {};
    return {
        ...existing,
        mcpServers: {
            ...servers,
            tim: entry,
        },
    };
}
function installMcpForHosts(dbPath, global = true) {
    const installed = [];
    const skipped = [];
    for (const tool of detectInstalledHosts()) {
        const configPath = tool.mcpConfigPath(global);
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        let existing = {};
        if (fs.existsSync(configPath)) {
            try {
                existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
            catch {
                skipped.push({ tool: tool.name, path: configPath, reason: 'config parse failed' });
                continue;
            }
            fs.copyFileSync(configPath, `${configPath}.backup.${Date.now()}`);
        }
        const merged = mergeMcpConfig(existing, buildTimMcpEntry(dbPath), tool.format);
        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
        installed.push({ tool: tool.name, path: configPath });
    }
    return { installed, skipped };
}
//# sourceMappingURL=install.js.map