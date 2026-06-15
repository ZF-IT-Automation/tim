"use strict";
// TIM MCP — tim_show integration tests
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
    constructor(dbPath, extraEnv = {}) {
        if (!fs.existsSync(SERVER_PATH)) {
            throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
        }
        this.proc = (0, node_child_process_1.spawn)('node', [SERVER_PATH], {
            env: { ...process.env, TIM_DB_PATH: dbPath, ...extraEnv },
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
                // ignore non-JSON lines
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
            clientInfo: { name: 'show-test', version: '0.0.1' },
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
async function seedProjectWithTask(client, label, title, taskTitle, taskMeta = {}, taskTags = ['#task', '#tim']) {
    const proj = await client.callTool('tim_create_project', { label, content: title });
    (0, vitest_1.expect)(proj.error).toBeUndefined();
    const project = JSON.parse(proj.result.content[0].text);
    const section = await client.callTool('tim_write', {
        content: 'Next Steps',
        parentId: project.id,
        metadata: { kind: 'section', label: 'Next Steps' },
        tags: ['#section', '#schema'],
    });
    (0, vitest_1.expect)(section.error).toBeUndefined();
    const sec = JSON.parse(section.result.content[0].text);
    const writeResp = await client.callTool('tim_write', {
        content: taskTitle,
        parentId: sec.id,
        metadata: {
            type: 'task',
            task: {
                status: taskMeta.status ?? 'todo',
                priority: taskMeta.priority ?? 'medium',
            },
        },
        tags: taskTags,
    });
    (0, vitest_1.expect)(writeResp.error).toBeUndefined();
    (0, vitest_1.expect)(writeResp.result?.isError).toBeFalsy();
}
(0, vitest_1.describe)('tim_show', () => {
    let client;
    let dbPath;
    (0, vitest_1.beforeEach)(async () => {
        dbPath = `/tmp/tim-show-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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
    (0, vitest_1.it)('what:tasks with explicit root scopes to single project', async () => {
        await seedProjectWithTask(client, 'P0400', 'Active Proj', 'Active task');
        await seedProjectWithTask(client, 'P0401', 'Other Proj', 'Other task');
        const resp = await client.callTool('tim_show', { what: 'tasks', root: 'P0400' });
        (0, vitest_1.expect)(resp.error).toBeUndefined();
        (0, vitest_1.expect)(resp.result?.isError).toBeFalsy();
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('Active task');
        (0, vitest_1.expect)(text).not.toContain('Other task');
    });
    (0, vitest_1.it)('what:tasks root:all groups tasks from multiple projects', async () => {
        await seedProjectWithTask(client, 'P0410', 'Alpha', 'Alpha task');
        await seedProjectWithTask(client, 'P0411', 'Beta', 'Beta task');
        const resp = await client.callTool('tim_show', { what: 'tasks', root: 'all' });
        (0, vitest_1.expect)(resp.error).toBeUndefined();
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('P0410');
        (0, vitest_1.expect)(text).toContain('P0411');
        (0, vitest_1.expect)(text).toContain('Alpha task');
        (0, vitest_1.expect)(text).toContain('Beta task');
    });
    (0, vitest_1.it)('what:bugs returns only #bug tagged entries', async () => {
        const proj = await client.callTool('tim_create_project', { label: 'P0440', content: 'Bug Proj' });
        const project = JSON.parse(proj.result.content[0].text);
        const section = await client.callTool('tim_write', {
            content: 'Tasks',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const sec = JSON.parse(section.result.content[0].text);
        await client.callTool('tim_write', {
            content: 'Real bug',
            parentId: sec.id,
            tags: ['#bug', '#test'],
        });
        await client.callTool('tim_write', {
            content: 'Not a bug',
            parentId: sec.id,
            tags: ['#note', '#test'],
        });
        const resp = await client.callTool('tim_show', { what: 'bugs', root: 'all' });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('Real bug');
        (0, vitest_1.expect)(text).not.toContain('Not a bug');
    });
    (0, vitest_1.it)('what:errors unions type=error and #error tag deduped', async () => {
        const proj = await client.callTool('tim_create_project', { label: 'P0441', content: 'Error Proj' });
        const project = JSON.parse(proj.result.content[0].text);
        const section = await client.callTool('tim_write', {
            content: 'Errors',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const sec = JSON.parse(section.result.content[0].text);
        for (const [content, meta] of [
            ['Typed error', { type: 'error' }],
            ['Tagged only', {}],
            ['Both signals', { type: 'error' }],
        ]) {
            const w = await client.callTool('tim_write', {
                content,
                parentId: sec.id,
                metadata: meta,
                tags: ['#error', '#test'],
            });
            (0, vitest_1.expect)(w.error).toBeUndefined();
            (0, vitest_1.expect)(w.result?.isError).toBeFalsy();
        }
        const resp = await client.callTool('tim_show', { what: 'errors', root: 'all' });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('Typed error');
        (0, vitest_1.expect)(text).toContain('Tagged only');
        (0, vitest_1.expect)(text).toContain('Both signals');
        const bothCount = (text.match(/Both signals/g) ?? []).length;
        (0, vitest_1.expect)(bothCount).toBe(1);
    });
    (0, vitest_1.it)('what:Ideas returns section children only', async () => {
        const proj = await client.callTool('tim_create_project', {
            label: 'P0420',
            content: 'Ideas Project',
        });
        const project = JSON.parse(proj.result.content[0].text);
        const ideas = await client.callTool('tim_write', {
            content: 'Ideas',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const ideasSec = JSON.parse(ideas.result.content[0].text);
        await client.callTool('tim_write', {
            content: 'My idea',
            parentId: ideasSec.id,
            tags: ['#idea', '#test'],
        });
        await client.callTool('tim_write', {
            content: 'Random root',
            tags: ['#idea', '#test'],
        });
        const resp = await client.callTool('tim_show', { what: 'Ideas', root: 'P0420' });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('My idea');
        (0, vitest_1.expect)(text).not.toContain('Random root');
    });
    (0, vitest_1.it)('with:open excludes done and cancelled tasks', async () => {
        const proj = await client.callTool('tim_create_project', { label: 'P0450', content: 'Filter Proj' });
        const project = JSON.parse(proj.result.content[0].text);
        const section = await client.callTool('tim_write', {
            content: 'Tasks',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const sec = JSON.parse(section.result.content[0].text);
        for (const [content, status] of [
            ['Open task', 'todo'],
            ['Done task', 'done'],
            ['Cancelled task', 'cancelled'],
        ]) {
            await client.callTool('tim_write', {
                content,
                parentId: sec.id,
                metadata: { task: true, status },
                tags: ['#task', '#test'],
            });
        }
        const resp = await client.callTool('tim_show', { what: 'tasks', root: 'P0450', with: 'open' });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('Open task');
        (0, vitest_1.expect)(text).not.toContain('Done task');
        (0, vitest_1.expect)(text).not.toContain('Cancelled task');
    });
    (0, vitest_1.it)('with:done returns only done tasks', async () => {
        await seedProjectWithTask(client, 'P0451', 'Done Proj', 'Todo task', { status: 'todo' });
        await seedProjectWithTask(client, 'P0452', 'Done Proj 2', 'Finished task', { status: 'done' });
        const resp = await client.callTool('tim_show', {
            what: 'tasks',
            root: 'all',
            with: 'done',
        });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('Finished task');
        (0, vitest_1.expect)(text).not.toContain('Todo task');
    });
    (0, vitest_1.it)('with:urgent returns only #urgent entries', async () => {
        const proj = await client.callTool('tim_create_project', { label: 'P0453', content: 'Urgent Proj' });
        const project = JSON.parse(proj.result.content[0].text);
        const section = await client.callTool('tim_write', {
            content: 'Tasks',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const sec = JSON.parse(section.result.content[0].text);
        await client.callTool('tim_write', {
            content: 'Urgent item',
            parentId: sec.id,
            metadata: { task: true, status: 'todo' },
            tags: ['#task', '#urgent', '#test'],
        });
        await client.callTool('tim_write', {
            content: 'Normal item',
            parentId: sec.id,
            metadata: { task: true, status: 'todo' },
            tags: ['#task', '#test'],
        });
        const resp = await client.callTool('tim_show', { what: 'tasks', root: 'P0453', with: 'urgent' });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('Urgent item');
        (0, vitest_1.expect)(text).not.toContain('Normal item');
    });
    (0, vitest_1.it)('with:recent keeps freshly written entries', async () => {
        await seedProjectWithTask(client, 'P0454', 'Recent Proj', 'Fresh task');
        const resp = await client.callTool('tim_show', {
            what: 'tasks',
            root: 'P0454',
            with: 'recent',
        });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('Fresh task');
    });
    (0, vitest_1.it)('with freetext narrows via FTS intersect', async () => {
        await seedProjectWithTask(client, 'P0455', 'FTS Proj', 'UniqueAlphaKeyword task');
        await seedProjectWithTask(client, 'P0456', 'FTS Proj 2', 'Other unrelated task');
        const resp = await client.callTool('tim_show', {
            what: 'tasks',
            root: 'all',
            with: 'UniqueAlphaKeyword',
        });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('UniqueAlphaKeyword');
        (0, vitest_1.expect)(text).not.toContain('Other unrelated');
    });
    (0, vitest_1.it)('limit applied after scope not before', async () => {
        const proj = await client.callTool('tim_create_project', { label: 'P0460', content: 'Limit Proj' });
        const project = JSON.parse(proj.result.content[0].text);
        const section = await client.callTool('tim_write', {
            content: 'Tasks',
            parentId: project.id,
            metadata: { kind: 'section' },
            tags: ['#section', '#schema'],
        });
        const sec = JSON.parse(section.result.content[0].text);
        for (let i = 0; i < 3; i++) {
            await client.callTool('tim_write', {
                content: `Scoped task ${i}`,
                parentId: sec.id,
                metadata: { task: true, status: 'todo' },
                tags: ['#task', '#test'],
            });
        }
        for (let i = 0; i < 25; i++) {
            await seedProjectWithTask(client, `P09${String(i).padStart(2, '0')}`, `Noise ${i}`, `Noise task ${i}`);
        }
        const resp = await client.callTool('tim_show', {
            what: 'tasks',
            root: 'P0460',
            limit: 2,
        });
        const text = resp.result.content[0].text;
        const scopedMatches = (text.match(/Scoped task/g) ?? []).length;
        (0, vitest_1.expect)(scopedMatches).toBe(2);
        (0, vitest_1.expect)(text).not.toContain('Noise task');
    });
    (0, vitest_1.it)('output includes status legend and glyphs', async () => {
        await seedProjectWithTask(client, 'P0430', 'Glyph Test', 'In progress task', {
            status: 'in_progress',
        });
        const resp = await client.callTool('tim_show', { what: 'tasks', root: 'P0430' });
        const text = resp.result.content[0].text;
        (0, vitest_1.expect)(text).toContain('[!]');
        (0, vitest_1.expect)(text).toMatch(/\[!\].*in_progress|#in_progress/);
        (0, vitest_1.expect)(text).toContain('[!]=in_progress');
    });
});
//# sourceMappingURL=show-output.test.js.map