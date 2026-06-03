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
    (0, vitest_1.describe)('deriveCounters', () => {
        (0, vitest_1.it)('returns zeros for a session with no Exchanges/Summary nodes', async () => {
            const s = await store.write('bare', { id: 'bare-sess', metadata: { kind: 'session' } });
            const c = await (0, index_js_1.deriveCounters)(store, s.id);
            (0, vitest_1.expect)(c).toEqual({ exchangeCount: 0, batchesSummarized: 0 });
        });
        (0, vitest_1.it)('counts user exchanges per batch, skips empty trailing batch', async () => {
            await store.createProject('P0093');
            await sessions.startProjectSession({
                sessionId: 'dc',
                projectId: 'P0093',
                agentName: 'a',
                cwd: '/',
                harness: 't',
                batchSize: 2,
            });
            (0, vitest_1.expect)(await (0, index_js_1.deriveCounters)(store, 'dc')).toEqual({
                exchangeCount: 0,
                batchesSummarized: 0,
            });
            await sessions.logExchange('dc', [{ role: 'user', content: 'Q1' }]);
            (0, vitest_1.expect)(await (0, index_js_1.deriveCounters)(store, 'dc')).toEqual({
                exchangeCount: 1,
                batchesSummarized: 0,
            });
            await sessions.logExchange('dc', [
                { role: 'user', content: 'Q2' },
                { role: 'user', content: 'Q3' },
            ]);
            (0, vitest_1.expect)(await (0, index_js_1.deriveCounters)(store, 'dc')).toEqual({
                exchangeCount: 3,
                batchesSummarized: 0,
            });
            const summaryNode = (await store.getChildByKind('dc', 'session-summary-root'))[0];
            await store.write('Batch 1', {
                parentId: summaryNode.id,
                metadata: { kind: 'batch-summary', batch_index: 1, seq_from: 1, seq_to: 2 },
            });
            (0, vitest_1.expect)(await (0, index_js_1.deriveCounters)(store, 'dc')).toEqual({
                exchangeCount: 3,
                batchesSummarized: 1,
            });
        });
    });
    (0, vitest_1.describe)('ensureInboxProject', () => {
        (0, vitest_1.it)('creates P0000 Inbox system project once', async () => {
            const first = await (0, index_js_1.ensureInboxProject)(store);
            const second = await (0, index_js_1.ensureInboxProject)(store);
            (0, vitest_1.expect)(first.metadata.label).toBe('P0000');
            (0, vitest_1.expect)(first.metadata.is_system).toBe(true);
            (0, vitest_1.expect)(first.title).toBe('Inbox');
            (0, vitest_1.expect)(second.id).toBe(first.id);
        });
    });
    (0, vitest_1.describe)('startProjectSession', () => {
        (0, vitest_1.it)('creates Sessions section + session node + Summary + Exchanges', async () => {
            await store.createProject('P0099');
            const session = await sessions.startProjectSession({
                sessionId: 'sess-proj-1',
                projectId: 'P0099',
                agentName: 'claude',
                cwd: '/p',
                harness: 'claude-code',
            });
            (0, vitest_1.expect)(session.id).toBe('sess-proj-1');
            (0, vitest_1.expect)(session.metadata.kind).toBe('session');
            (0, vitest_1.expect)(session.metadata.project_ref).toBe('P0099');
            (0, vitest_1.expect)(session.metadata.batch_size).toBe(5);
            const project = await store.read('P0099');
            const sectionKids = await store.getChildByKind(project.id, 'sessions-root');
            (0, vitest_1.expect)(sectionKids).toHaveLength(1);
            (0, vitest_1.expect)(sectionKids[0].metadata.order).toBe(1000);
            (0, vitest_1.expect)(session.parentId).toBe(sectionKids[0].id);
            const summary = await store.getChildByKind(session.id, 'session-summary-root');
            const exchanges = await store.getChildByKind(session.id, 'exchanges-root');
            (0, vitest_1.expect)(summary).toHaveLength(1);
            (0, vitest_1.expect)(exchanges).toHaveLength(1);
            (0, vitest_1.expect)(summary[0].tags).toContain('#session-summary');
            const batches = await store.getChildByKind(exchanges[0].id, 'exchange-batch');
            (0, vitest_1.expect)(batches).toHaveLength(1);
            (0, vitest_1.expect)(batches[0].title).toBe('Batch 1');
            (0, vitest_1.expect)(batches[0].metadata.batch_index).toBe(1);
        });
        (0, vitest_1.it)('is idempotent and reuses the Sessions section across sessions', async () => {
            await store.createProject('P0098');
            await sessions.startProjectSession({
                sessionId: 's1',
                projectId: 'P0098',
                agentName: 'a',
                cwd: '/',
                harness: 't',
            });
            await sessions.startProjectSession({
                sessionId: 's1',
                projectId: 'P0098',
                agentName: 'a',
                cwd: '/',
                harness: 't',
            });
            await sessions.startProjectSession({
                sessionId: 's2',
                projectId: 'P0098',
                agentName: 'a',
                cwd: '/',
                harness: 't',
            });
            const project = await store.read('P0098');
            const sections = await store.getChildByKind(project.id, 'sessions-root');
            (0, vitest_1.expect)(sections).toHaveLength(1);
            const sessionNodes = await store.getChildByKind(sections[0].id, 'session');
            (0, vitest_1.expect)(sessionNodes.map(s => s.id).sort()).toEqual(['s1', 's2']);
        });
        (0, vitest_1.it)('updates project_ref when rebinding an existing session to another project', async () => {
            await store.createProject('P0096');
            await store.createProject('P0095');
            await sessions.startProjectSession({
                sessionId: 'rebind-s',
                projectId: 'P0096',
                agentName: 'a',
                cwd: '/',
                harness: 't',
            });
            const rebound = await sessions.startProjectSession({
                sessionId: 'rebind-s',
                projectId: 'P0095',
                agentName: 'a',
                cwd: '/',
                harness: 't',
            });
            (0, vitest_1.expect)(rebound.metadata.project_ref).toBe('P0095');
        });
        (0, vitest_1.it)('binds unbound sessions to P0000 Inbox when using inbox helper', async () => {
            await (0, index_js_1.ensureInboxProject)(store);
            const session = await sessions.startProjectSession({
                sessionId: 'inbox-sess',
                projectId: 'P0000',
                agentName: 'a',
                cwd: '/',
                harness: 't',
            });
            (0, vitest_1.expect)(session.metadata.project_ref).toBe('P0000');
        });
    });
    (0, vitest_1.describe)('logExchange (nested)', () => {
        (0, vitest_1.beforeEach)(async () => {
            await store.createProject('P0097');
            await sessions.startProjectSession({
                sessionId: 'sx',
                projectId: 'P0097',
                agentName: 'a',
                cwd: '/',
                harness: 't',
            });
        });
        (0, vitest_1.it)('nests agent reply under its user message and seqs only user nodes', async () => {
            await sessions.logExchange('sx', [
                { role: 'user', content: 'Q1' },
                { role: 'agent', content: 'A1' },
                { role: 'user', content: 'Q2' },
                { role: 'agent', content: 'A2' },
            ]);
            const exNode = (await store.getChildByKind('sx', 'exchanges-root'))[0];
            const batches = await store.getChildByKind(exNode.id, 'exchange-batch');
            (0, vitest_1.expect)(batches).toHaveLength(1);
            (0, vitest_1.expect)(batches[0].title).toBe('Batch 1');
            const users = (await store.getChildrenBySeq(batches[0].id)).filter(u => u.metadata.role === 'user');
            (0, vitest_1.expect)(users.map(u => [u.title, u.metadata.seq, u.metadata.role])).toEqual([
                ['Q1', 1, 'user'],
                ['Q2', 2, 'user'],
            ]);
            const a1 = await store.getChildren(users[0].id);
            (0, vitest_1.expect)(a1).toHaveLength(1);
            (0, vitest_1.expect)(a1[0].title).toBe('A1');
            (0, vitest_1.expect)(a1[0].metadata.role).toBe('agent');
            (0, vitest_1.expect)(a1[0].metadata.seq).toBe(1);
        });
        (0, vitest_1.it)('continues seq across calls and updates the cached exchange_count', async () => {
            await sessions.logExchange('sx', [{ role: 'user', content: 'first' }]);
            await sessions.logExchange('sx', [{ role: 'user', content: 'second' }]);
            const exNode = (await store.getChildByKind('sx', 'exchanges-root'))[0];
            const batch = (await store.getChildByKind(exNode.id, 'exchange-batch'))[0];
            const users = (await store.getChildrenBySeq(batch.id)).filter(u => u.metadata.role === 'user');
            (0, vitest_1.expect)(users.map(u => u.metadata.seq)).toEqual([1, 2]);
            const session = await store.read('sx');
            (0, vitest_1.expect)(session.metadata.exchange_count).toBe(2);
        });
        (0, vitest_1.it)('splits into a new exchange-batch when batch_size is reached', async () => {
            await sessions.startProjectSession({
                sessionId: 'sx-split',
                projectId: 'P0097',
                agentName: 'a',
                cwd: '/',
                harness: 't',
                batchSize: 2,
            });
            await sessions.logExchange('sx-split', [
                { role: 'user', content: 'Q1' },
                { role: 'agent', content: 'A1' },
                { role: 'user', content: 'Q2' },
                { role: 'agent', content: 'A2' },
                { role: 'user', content: 'Q3' },
                { role: 'agent', content: 'A3' },
            ]);
            const exNode = (await store.getChildByKind('sx-split', 'exchanges-root'))[0];
            const batches = await store.getChildByKind(exNode.id, 'exchange-batch');
            (0, vitest_1.expect)(batches.map(b => b.metadata.batch_index)).toEqual([1, 2]);
            const batch1Users = (await store.getChildrenBySeq(batches[0].id)).filter(u => u.metadata.role === 'user');
            const batch2Users = (await store.getChildrenBySeq(batches[1].id)).filter(u => u.metadata.role === 'user');
            (0, vitest_1.expect)(batch1Users.map(u => u.title)).toEqual(['Q1', 'Q2']);
            (0, vitest_1.expect)(batch2Users.map(u => u.title)).toEqual(['Q3']);
        });
    });
    (0, vitest_1.describe)('showUnsummarized', () => {
        (0, vitest_1.beforeEach)(async () => {
            await store.createProject('P0096');
            await sessions.startProjectSession({
                sessionId: 'su',
                projectId: 'P0096',
                agentName: 'a',
                cwd: '/',
                harness: 't',
                batchSize: 2,
            });
            await sessions.logExchange('su', [
                { role: 'user', content: 'Q1' },
                { role: 'agent', content: 'A1' },
                { role: 'user', content: 'Q2' },
                { role: 'agent', content: 'A2' },
                { role: 'user', content: 'Q3' },
                { role: 'agent', content: 'A3' },
            ]);
        });
        (0, vitest_1.it)('returns the first unsummarized batch with user+agent content', async () => {
            const batch = await sessions.showUnsummarized('su');
            (0, vitest_1.expect)(batch.batchIndex).toBe(1);
            (0, vitest_1.expect)(batch.batchSize).toBe(2);
            (0, vitest_1.expect)(batch.exchanges.map(e => [e.seq, e.userContent, e.agentContent])).toEqual([
                [1, 'Q1', 'A1'],
                [2, 'Q2', 'A2'],
            ]);
            (0, vitest_1.expect)(batch.hasMore).toBe(true);
            (0, vitest_1.expect)(batch.summaryNodeId).toBeTruthy();
        });
        (0, vitest_1.it)('skips already-summarized batches (derived from existing Batch nodes)', async () => {
            const summaryNode = (await store.getChildByKind('su', 'session-summary-root'))[0];
            await store.write('Batch 1', {
                parentId: summaryNode.id,
                metadata: { kind: 'batch-summary', batch_index: 1, seq_from: 1, seq_to: 2 },
            });
            const batch = await sessions.showUnsummarized('su');
            (0, vitest_1.expect)(batch.batchIndex).toBe(2);
            (0, vitest_1.expect)(batch.exchanges.map(e => e.seq)).toEqual([3]);
            (0, vitest_1.expect)(batch.hasMore).toBe(false);
        });
    });
    (0, vitest_1.describe)('writeBatchSummary + rollUpSession', () => {
        (0, vitest_1.beforeEach)(async () => {
            await store.createProject('P0095');
            await sessions.startProjectSession({
                sessionId: 'sb',
                projectId: 'P0095',
                agentName: 'a',
                cwd: '/',
                harness: 't',
                batchSize: 2,
            });
            await sessions.logExchange('sb', [
                { role: 'user', content: 'Q1' },
                { role: 'agent', content: 'A1' },
                { role: 'user', content: 'Q2' },
                { role: 'agent', content: 'A2' },
            ]);
        });
        (0, vitest_1.it)('writes a Batch node under Summary and bumps derived batches_summarized', async () => {
            const batch = await sessions.showUnsummarized('sb');
            const node = await sessions.writeBatchSummary('sb', batch.batchIndex, 'themes: greetings', {
                seqFrom: 1,
                seqTo: 2,
            });
            (0, vitest_1.expect)(node.metadata.kind).toBe('batch-summary');
            (0, vitest_1.expect)(node.metadata.batch_index).toBe(1);
            (0, vitest_1.expect)(node.metadata.summarized_at).toBeTruthy();
            (0, vitest_1.expect)(node.tags).toContain('#session-summary');
            const { batchesSummarized } = await (0, index_js_1.deriveCounters)(store, 'sb');
            (0, vitest_1.expect)(batchesSummarized).toBe(1);
        });
        (0, vitest_1.it)('is idempotent: re-writing the same batch_index does not duplicate', async () => {
            await sessions.writeBatchSummary('sb', 1, 'first', { seqFrom: 1, seqTo: 2 });
            await sessions.writeBatchSummary('sb', 1, 'again', { seqFrom: 1, seqTo: 2 });
            const summaryNode = (await store.getChildByKind('sb', 'session-summary-root'))[0];
            const batches = await store.getChildByKind(summaryNode.id, 'batch-summary');
            (0, vitest_1.expect)(batches).toHaveLength(1);
        });
        (0, vitest_1.it)('rollUpSession folds all batches into the Summary node body + metadata (multi-line safe)', async () => {
            await sessions.writeBatchSummary('sb', 1, 'batch one summary', { seqFrom: 1, seqTo: 2 });
            const summary = await sessions.rollUpSession('sb', async (batches) => `Themes:\n${batches.map(b => b.content).join('\n')}`);
            (0, vitest_1.expect)(summary.content.startsWith('Themes:')).toBe(true);
            (0, vitest_1.expect)(summary.content).toContain('batch one summary');
            (0, vitest_1.expect)(summary.metadata.summary).toContain('Themes:');
            (0, vitest_1.expect)(summary.metadata.exchanges).toBe(2);
            (0, vitest_1.expect)(summary.tags).toContain('#session-summary');
        });
    });
    (0, vitest_1.describe)('onBatchFull live trigger', () => {
        (0, vitest_1.it)('fires when logExchange rolls to a new batch', async () => {
            const onBatchFull = vitest_1.vi.fn();
            sessions.setOnBatchFull(onBatchFull);
            await store.createProject('P0093');
            await sessions.startProjectSession({
                sessionId: 'live',
                projectId: 'P0093',
                agentName: 'a',
                cwd: '/tmp/live',
                harness: 't',
                batchSize: 2,
            });
            await sessions.logExchange('live', [
                { role: 'user', content: 'Q1' },
                { role: 'agent', content: 'A1' },
                { role: 'user', content: 'Q2' },
                { role: 'agent', content: 'A2' },
                { role: 'user', content: 'Q3' },
            ]);
            (0, vitest_1.expect)(onBatchFull).toHaveBeenCalledOnce();
            (0, vitest_1.expect)(onBatchFull.mock.calls[0][0]).toMatchObject({
                sessionId: 'live',
                batchIndex: 1,
            });
        });
    });
    (0, vitest_1.describe)('getSessionExchanges tree-awareness', () => {
        (0, vitest_1.it)('reads exchanges from the Exchanges subtree for project sessions', async () => {
            await store.createProject('P0094');
            await sessions.startProjectSession({
                sessionId: 'sc',
                projectId: 'P0094',
                agentName: 'a',
                cwd: '/',
                harness: 't',
            });
            await sessions.logExchange('sc', [
                { role: 'user', content: 'U1' },
                { role: 'agent', content: 'Ag1' },
            ]);
            const ex = await sessions.getSessionExchanges('sc');
            (0, vitest_1.expect)(ex.map(e => e.metadata.role)).toEqual(['user', 'agent']);
        });
    });
});
//# sourceMappingURL=session.test.js.map