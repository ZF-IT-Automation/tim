"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const tim_core_1 = require("tim-core");
const index_js_1 = require("../index.js");
(0, vitest_1.describe)('SessionManager', () => {
    let store;
    let sessions;
    (0, vitest_1.beforeEach)(() => {
        store = new index_js_1.TimStore(':memory:');
        sessions = new index_js_1.SessionManager(store);
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
    });
    (0, vitest_1.describe)('sessionStart', () => {
        (0, vitest_1.it)('creates session entry with correct metadata', async () => {
            const entry = await sessions.sessionStart({
                sessionId: 'sess-001',
                agentName: 'cursor',
                cwd: '/tmp/project',
                harness: 'cursor',
            });
            (0, vitest_1.expect)(entry.id).toBe('sess-001');
            (0, vitest_1.expect)(entry.metadata.kind).toBe('session');
            (0, vitest_1.expect)(entry.metadata.agent).toBe('cursor');
            (0, vitest_1.expect)(entry.metadata.harness).toBe('cursor');
            (0, vitest_1.expect)(entry.metadata.cwd).toBe('/tmp/project');
        });
        (0, vitest_1.it)('is idempotent on repeat', async () => {
            const first = await sessions.sessionStart({
                sessionId: 'sess-002',
                agentName: 'claude',
                cwd: '/a',
                harness: 'claude-code',
            });
            const second = await sessions.sessionStart({
                sessionId: 'sess-002',
                agentName: 'other',
                cwd: '/b',
                harness: 'other',
            });
            (0, vitest_1.expect)(second.id).toBe(first.id);
            (0, vitest_1.expect)(second.metadata.agent).toBe('claude');
        });
    });
    (0, vitest_1.describe)('sessionLog', () => {
        (0, vitest_1.it)('creates child exchanges with monotonic seq and preserved roles', async () => {
            await sessions.sessionStart({
                sessionId: 'sess-log',
                agentName: 'agent',
                cwd: '/',
                harness: 'test',
            });
            const batch1 = await sessions.sessionLog('sess-log', [
                { role: 'user', content: 'Hello' },
                { role: 'agent', content: 'Hi there' },
            ]);
            const batch2 = await sessions.sessionLog('sess-log', [
                { role: 'user', content: 'Bye' },
            ]);
            (0, vitest_1.expect)(batch1[0].metadata.seq).toBe(1);
            (0, vitest_1.expect)(batch1[1].metadata.seq).toBe(2);
            (0, vitest_1.expect)(batch2[0].metadata.seq).toBe(3);
            (0, vitest_1.expect)(batch1[0].metadata.role).toBe('user');
            (0, vitest_1.expect)(batch1[1].metadata.role).toBe('agent');
            (0, vitest_1.expect)(batch1[0].parentId).toBe('sess-log');
        });
    });
    (0, vitest_1.describe)('checkpoint', () => {
        (0, vitest_1.it)('creates summary, summarises edge, and calls summarizer in order', async () => {
            await sessions.sessionStart({
                sessionId: 'sess-cp',
                agentName: 'agent',
                cwd: '/',
                harness: 'test',
            });
            await sessions.sessionLog('sess-cp', [
                { role: 'user', content: 'First' },
                { role: 'agent', content: 'Second' },
            ]);
            const received = [];
            const summarize = vitest_1.vi.fn(async (exchanges) => {
                for (const e of exchanges) {
                    received.push(String(e.metadata.seq));
                }
                return 'summary text';
            });
            const summary = await sessions.checkpoint('sess-cp', { summarize, runDecay: false });
            (0, vitest_1.expect)(summary.metadata.kind).toBe('checkpoint');
            (0, vitest_1.expect)(summary.metadata.sessionId).toBe('sess-cp');
            (0, vitest_1.expect)(summary.metadata.count).toBe(2);
            (0, vitest_1.expect)(summarize).toHaveBeenCalledOnce();
            (0, vitest_1.expect)(received).toEqual(['1', '2']);
            const edges = await store.getEdges(summary.id, 'outgoing');
            (0, vitest_1.expect)(edges.some(e => e.type === 'summarizes' && e.targetId === 'sess-cp')).toBe(true);
        });
        (0, vitest_1.it)('runs decay only after summary is durable', async () => {
            const old = await store.write('old entry', {
                metadata: { kind: 'note' },
            });
            await new Promise(r => setTimeout(r, 5));
            await sessions.sessionStart({
                sessionId: 'sess-decay',
                agentName: 'agent',
                cwd: '/',
                harness: 'test',
            });
            await sessions.sessionLog('sess-decay', [
                { role: 'user', content: 'msg' },
            ]);
            const summary = await sessions.checkpoint('sess-decay');
            const oldRead = await store.read(old.id, { showIrrelevant: true });
            (0, vitest_1.expect)(oldRead?.irrelevant).toBe(true);
            const sessionRead = await store.read('sess-decay');
            const summaryRead = await store.read(summary.id);
            (0, vitest_1.expect)(sessionRead).not.toBeNull();
            (0, vitest_1.expect)(summaryRead).not.toBeNull();
        });
        (0, vitest_1.it)('uses default summarizer stub truncated to 2000 chars', async () => {
            await sessions.sessionStart({
                sessionId: 'sess-stub',
                agentName: 'agent',
                cwd: '/',
                harness: 'test',
            });
            await sessions.sessionLog('sess-stub', [
                { role: 'user', content: 'x'.repeat(1500) },
                { role: 'agent', content: 'y'.repeat(1500) },
            ]);
            const summary = await sessions.checkpoint('sess-stub', { runDecay: false });
            (0, vitest_1.expect)(summary.content.length).toBeLessThanOrEqual(2001);
            (0, vitest_1.expect)(summary.content.endsWith('…')).toBe(true);
        });
        (0, vitest_1.it)('does not run decay if summary write fails', async () => {
            const old = await store.write('protected old');
            await new Promise(r => setTimeout(r, 5));
            await sessions.sessionStart({
                sessionId: 'sess-fail',
                agentName: 'agent',
                cwd: '/',
                harness: 'test',
            });
            await sessions.sessionLog('sess-fail', [
                { role: 'user', content: 'msg' },
            ]);
            const decaySpy = vitest_1.vi.spyOn(store, 'runDecay');
            const writeSpy = vitest_1.vi.spyOn(store, 'write');
            writeSpy.mockImplementationOnce(async () => {
                throw new Error('write failed');
            });
            await (0, vitest_1.expect)(sessions.checkpoint('sess-fail', { summarize: async () => 'x' })).rejects.toThrow('write failed');
            (0, vitest_1.expect)(decaySpy).not.toHaveBeenCalled();
            const oldRead = await store.read(old.id);
            (0, vitest_1.expect)(oldRead).not.toBeNull();
            writeSpy.mockRestore();
            decaySpy.mockRestore();
        });
    });
    (0, vitest_1.describe)('integration: full session lifecycle', () => {
        (0, vitest_1.it)('start → log → checkpoint with events in order', async () => {
            const bus = new tim_core_1.InProcessEventBus();
            const events = [];
            bus.on('memory:written', () => { events.push('memory:written'); });
            bus.on('edge:created', () => { events.push('edge:created'); });
            const eventStore = new index_js_1.TimStore(':memory:', { emitter: bus });
            const eventSessions = new index_js_1.SessionManager(eventStore);
            const old = await eventStore.write('stale data');
            await new Promise(r => setTimeout(r, 5));
            await eventSessions.sessionStart({
                sessionId: 'lifecycle',
                agentName: 'test-agent',
                cwd: '/proj',
                harness: 'vitest',
            });
            await eventSessions.sessionLog('lifecycle', [
                { role: 'user', content: 'Q1' },
                { role: 'agent', content: 'A1' },
                { role: 'user', content: 'Q2' },
            ]);
            const summary = await eventSessions.checkpoint('lifecycle');
            (0, vitest_1.expect)(events.filter(e => e === 'memory:written').length).toBeGreaterThanOrEqual(5);
            (0, vitest_1.expect)(events).toContain('edge:created');
            const exchanges = await eventSessions.getSessionExchanges('lifecycle');
            (0, vitest_1.expect)(exchanges).toHaveLength(3);
            const stale = await eventStore.read(old.id, { showIrrelevant: true });
            (0, vitest_1.expect)(stale?.irrelevant).toBe(true);
            (0, vitest_1.expect)(await eventStore.read('lifecycle')).not.toBeNull();
            (0, vitest_1.expect)(await eventStore.read(summary.id)).not.toBeNull();
            eventStore.close();
        });
    });
});
//# sourceMappingURL=session.test.js.map