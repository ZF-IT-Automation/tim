"use strict";
// TIM MCP — extended tim_read / tim_search / tim_write integration tests
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
const vitest_1 = require("vitest");
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');
class McpClient {
    proc;
    nextId = 1;
    pending = new Map();
    buffer = '';
    ready = false;
    constructor(dbPath) {
        if (!fs.existsSync(SERVER_PATH)) {
            throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
        }
        this.proc = (0, node_child_process_1.spawn)('node', [SERVER_PATH], {
            env: { ...process.env, TIM_DB_PATH: dbPath },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc.stdout.on('data', (chunk) => this.onData(chunk.toString('utf8')));
        this.proc.stderr.on('data', () => { });
    }
    onData(text) {
        this.buffer += text;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line)
                continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id != null && this.pending.has(msg.id)) {
                    this.pending.get(msg.id)(msg);
                    this.pending.delete(msg.id);
                }
            }
            catch {
                // ignore
            }
        }
    }
    send(method, params) {
        const id = this.nextId++;
        const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timeout waiting for response to ${method}`));
            }, 10000);
            this.pending.set(id, (resp) => {
                clearTimeout(timer);
                resolve(resp);
            });
            this.proc.stdin.write(frame);
        });
    }
    async init() {
        if (this.ready)
            return;
        await this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'ext-test', version: '0.0.1' },
        });
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        this.ready = true;
    }
    async callTool(name, args = {}) {
        await this.init();
        return this.send('tools/call', { name, arguments: args });
    }
    kill() {
        this.proc.kill('SIGTERM');
        setTimeout(() => {
            if (!this.proc.killed)
                this.proc.kill('SIGKILL');
        }, 100);
    }
}
(0, vitest_1.describe)('tim_read extended', () => {
    let client;
    let dbPath;
    (0, vitest_1.beforeEach)(async () => {
        dbPath = `/tmp/tim-read-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
        client = new McpClient(dbPath);
        await client.init();
    });
    (0, vitest_1.afterEach)(() => {
        client.kill();
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
    });
    (0, vitest_1.it)('single string id returns {entry,edges} shape unchanged', async () => {
        const writeResp = await client.callTool('tim_write', {
            content: 'Read me',
            tags: ['#note', '#test'],
        });
        const written = JSON.parse(writeResp.result.content[0].text);
        const readResp = await client.callTool('tim_read', { id: written.id });
        (0, vitest_1.expect)(readResp.error).toBeUndefined();
        (0, vitest_1.expect)(readResp.result?.isError).toBeFalsy();
        const parsed = JSON.parse(readResp.result.content[0].text);
        (0, vitest_1.expect)(parsed).toHaveProperty('entry');
        (0, vitest_1.expect)(parsed).toHaveProperty('edges');
        (0, vitest_1.expect)(Array.isArray(parsed.edges)).toBe(true);
        (0, vitest_1.expect)(parsed.entry.id).toBe(written.id);
    });
    (0, vitest_1.it)('array id returns {entries,missing} with missing reported', async () => {
        const w1 = await client.callTool('tim_write', {
            content: 'One',
            tags: ['#note', '#test'],
        });
        const e1 = JSON.parse(w1.result.content[0].text);
        const readResp = await client.callTool('tim_read', {
            id: [e1.id, 'missing-ulid-123'],
        });
        const parsed = JSON.parse(readResp.result.content[0].text);
        (0, vitest_1.expect)(parsed.entries).toHaveLength(1);
        (0, vitest_1.expect)(parsed.entries[0].id).toBe(e1.id);
        (0, vitest_1.expect)(parsed.missing).toEqual(['missing-ulid-123']);
    });
    (0, vitest_1.it)('project reads project entry by label', async () => {
        await client.callTool('tim_create_project', { label: 'P0500', content: 'Read Project' });
        const readResp = await client.callTool('tim_read', { project: 'P0500' });
        const parsed = JSON.parse(readResp.result.content[0].text);
        (0, vitest_1.expect)(parsed.entry.metadata.label).toBe('P0500');
        (0, vitest_1.expect)(parsed.entry.metadata.kind).toBe('project');
    });
    (0, vitest_1.it)('section returns section and children', async () => {
        const proj = await client.callTool('tim_create_project', { label: 'P0501', content: 'Section Proj' });
        const project = JSON.parse(proj.result.content[0].text);
        const secWrite = await client.callTool('tim_write', {
            content: 'Tasks',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const section = JSON.parse(secWrite.result.content[0].text);
        await client.callTool('tim_write', {
            content: 'Child task',
            parentId: section.id,
            tags: ['#task', '#test'],
        });
        const readResp = await client.callTool('tim_read', {
            project: 'P0501',
            section: 'Tasks',
        });
        const parsed = JSON.parse(readResp.result.content[0].text);
        (0, vitest_1.expect)(parsed.section.title).toBe('Tasks');
        (0, vitest_1.expect)(parsed.children).toHaveLength(1);
        (0, vitest_1.expect)(parsed.children[0].title).toBe('Child task');
    });
});
(0, vitest_1.describe)('tim_search extended', () => {
    let client;
    let dbPath;
    (0, vitest_1.beforeEach)(async () => {
        dbPath = `/tmp/tim-search-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
        client = new McpClient(dbPath);
        await client.init();
    });
    (0, vitest_1.afterEach)(() => {
        client.kill();
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
    });
    async function seedScopedEntry(label, content, tags, meta = {}) {
        const proj = await client.callTool('tim_create_project', { label, content: `${label} Proj` });
        const project = JSON.parse(proj.result.content[0].text);
        const section = await client.callTool('tim_write', {
            content: 'Notes',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const sec = JSON.parse(section.result.content[0].text);
        await client.callTool('tim_write', {
            content,
            parentId: sec.id,
            tags,
            metadata: meta,
        });
    }
    (0, vitest_1.it)('root scopes search to project', async () => {
        await seedScopedEntry('P0510', 'AlphaSearchToken', ['#note', '#test']);
        await seedScopedEntry('P0511', 'AlphaSearchToken', ['#note', '#test']);
        const resp = await client.callTool('tim_search', {
            query: 'AlphaSearchToken',
            root: 'P0510',
        });
        const results = JSON.parse(resp.result.content[0].text);
        (0, vitest_1.expect)(results.length).toBeGreaterThanOrEqual(1);
        (0, vitest_1.expect)(results.every((r) => r.title === 'AlphaSearchToken')).toBe(true);
    });
    (0, vitest_1.it)('type tag status filters combine with AND', async () => {
        await seedScopedEntry('P0520', 'Errmark', ['#combo', '#test'], {
            type: 'error',
            status: 'todo',
        });
        await seedScopedEntry('P0521', 'Rulemark', ['#combo', '#test'], {
            type: 'rule',
            status: 'todo',
        });
        const hit = await client.callTool('tim_search', {
            query: 'Errmark',
            type: 'error',
            tag: 'combo',
            status: 'todo',
        });
        const hitResults = JSON.parse(hit.result.content[0].text);
        (0, vitest_1.expect)(hitResults).toHaveLength(1);
        (0, vitest_1.expect)(hitResults[0].title).toBe('Errmark');
        const miss = await client.callTool('tim_search', {
            query: 'Rulemark',
            type: 'error',
            tag: 'combo',
            status: 'todo',
        });
        const missResults = JSON.parse(miss.result.content[0].text);
        (0, vitest_1.expect)(missResults).toHaveLength(0);
    });
});
(0, vitest_1.describe)('tim_write where shorthand', () => {
    let client;
    let dbPath;
    (0, vitest_1.beforeEach)(async () => {
        dbPath = `/tmp/tim-write-where-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
        client = new McpClient(dbPath);
        await client.init();
    });
    (0, vitest_1.afterEach)(() => {
        client.kill();
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
    });
    (0, vitest_1.it)('where P0062/Tasks resolves project and section parent', async () => {
        const proj = await client.callTool('tim_create_project', { label: 'P0600', content: 'Where Proj' });
        const project = JSON.parse(proj.result.content[0].text);
        await client.callTool('tim_write', {
            content: 'Tasks',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const writeResp = await client.callTool('tim_write', {
            content: 'Task via where',
            where: 'P0600/Tasks',
            metadata: { task: true, status: 'todo' },
            tags: ['#task', '#test'],
        });
        (0, vitest_1.expect)(writeResp.error).toBeUndefined();
        (0, vitest_1.expect)(writeResp.result?.isError).toBeFalsy();
        const written = JSON.parse(writeResp.result.content[0].text);
        const readResp = await client.callTool('tim_read', {
            project: 'P0600',
            section: 'Tasks',
        });
        const parsed = JSON.parse(readResp.result.content[0].text);
        (0, vitest_1.expect)(parsed.children.some((c) => c.id === written.id)).toBe(true);
    });
    (0, vitest_1.it)('explicit parentId overrides where', async () => {
        const proj = await client.callTool('tim_create_project', { label: 'P0601', content: 'Override Proj' });
        const project = JSON.parse(proj.result.content[0].text);
        const tasks = await client.callTool('tim_write', {
            content: 'Tasks',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const tasksSec = JSON.parse(tasks.result.content[0].text);
        const ideas = await client.callTool('tim_write', {
            content: 'Ideas',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const ideasSec = JSON.parse(ideas.result.content[0].text);
        const writeResp = await client.callTool('tim_write', {
            content: 'Ideas child',
            where: 'P0601/Tasks',
            parentId: ideasSec.id,
            tags: ['#idea', '#test'],
        });
        const written = JSON.parse(writeResp.result.content[0].text);
        const ideasRead = await client.callTool('tim_read', { project: 'P0601', section: 'Ideas' });
        const ideasParsed = JSON.parse(ideasRead.result.content[0].text);
        (0, vitest_1.expect)(ideasParsed.children.some((c) => c.id === written.id)).toBe(true);
        const tasksRead = await client.callTool('tim_read', { project: 'P0601', section: 'Tasks' });
        const tasksParsed = JSON.parse(tasksRead.result.content[0].text);
        (0, vitest_1.expect)(tasksParsed.children.some((c) => c.id === written.id)).toBe(false);
        (0, vitest_1.expect)(tasksSec.id).not.toBe(ideasSec.id);
    });
    (0, vitest_1.it)('bad section in where returns clean error', async () => {
        await client.callTool('tim_create_project', { label: 'P0602', content: 'Bad Section Proj' });
        const writeResp = await client.callTool('tim_write', {
            content: 'Orphan attempt',
            where: 'P0602/NoSuchSection',
            tags: ['#note', '#test'],
        });
        (0, vitest_1.expect)(writeResp.result?.isError).toBe(true);
        (0, vitest_1.expect)(writeResp.result.content[0].text).toContain('section not found');
    });
    (0, vitest_1.it)('parentTitle+projectId path still works (regression)', async () => {
        const proj = await client.callTool('tim_create_project', { label: 'P0603', content: 'Legacy Proj' });
        const project = JSON.parse(proj.result.content[0].text);
        await client.callTool('tim_write', {
            content: 'Tasks',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const writeResp = await client.callTool('tim_write', {
            content: 'Legacy write',
            parentTitle: 'Tasks',
            projectId: 'P0603',
            tags: ['#task', '#test'],
        });
        (0, vitest_1.expect)(writeResp.error).toBeUndefined();
        (0, vitest_1.expect)(writeResp.result?.isError).toBeFalsy();
    });
});
(0, vitest_1.describe)('tim_tasks deprecation regression', () => {
    let client;
    let dbPath;
    (0, vitest_1.beforeEach)(async () => {
        dbPath = `/tmp/tim-tasks-reg-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
        client = new McpClient(dbPath);
        await client.init();
    });
    (0, vitest_1.afterEach)(() => {
        client.kill();
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
    });
    async function seedTask(label, title, status) {
        const proj = await client.callTool('tim_create_project', { label, content: title });
        const project = JSON.parse(proj.result.content[0].text);
        const section = await client.callTool('tim_write', {
            content: 'Next Steps',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const sec = JSON.parse(section.result.content[0].text);
        await client.callTool('tim_write', {
            content: `${title} task`,
            parentId: sec.id,
            metadata: { task: true, status },
            tags: ['#task', '#test'],
        });
    }
    (0, vitest_1.it)('getTasks status filter via tim_tasks returns only done tasks', async () => {
        await seedTask('P0700', 'TodoProj', 'todo');
        await seedTask('P0701', 'DoneProj', 'done');
        const resp = await client.callTool('tim_tasks', { status: 'done' });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('DoneProj task');
        (0, vitest_1.expect)(text).not.toContain('TodoProj task');
    });
});
//# sourceMappingURL=read-search-write-ext.test.js.map