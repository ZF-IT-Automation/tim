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
exports.createTimMcpTransport = createTimMcpTransport;
exports.connectTimMcp = connectTimMcp;
exports.callTimTool = callTimTool;
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const tim_core_1 = require("tim-core");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
function dbPathFromEnv() {
    if (process.env.TIM_DB_PATH)
        return process.env.TIM_DB_PATH;
    const config = (0, tim_core_1.loadConfig)();
    return config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
function createTimMcpTransport() {
    const serverPath = process.env.TIM_MCP_PATH
        || path.resolve(__dirname, '..', '..', 'tim-mcp', 'dist', 'server.js');
    return new stdio_js_1.StdioClientTransport({
        command: 'node',
        args: [serverPath],
        env: { ...process.env, TIM_DB_PATH: dbPathFromEnv() },
    });
}
async function connectTimMcp() {
    const transport = createTimMcpTransport();
    const client = new index_js_1.Client({ name: 'tim-summarizer', version: '0.1.0-alpha' }, { capabilities: {} });
    await client.connect(transport);
    return client;
}
function parseToolJson(result) {
    const text = result.content?.find(c => c.type === 'text')?.text ?? '';
    if (result.isError) {
        throw new Error(text || 'MCP tool error');
    }
    return JSON.parse(text);
}
async function callTimTool(client, name, args) {
    const result = await client.callTool({ name, arguments: args });
    return parseToolJson(result);
}
//# sourceMappingURL=mcp-client.js.map