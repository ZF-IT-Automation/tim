"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const tim_core_1 = require("tim-core");
const store_js_1 = require("../store.js");
(0, vitest_1.describe)('TimStore events', () => {
    let store;
    let bus;
    (0, vitest_1.beforeEach)(() => {
        bus = new tim_core_1.InProcessEventBus();
        store = new store_js_1.TimStore(':memory:', { emitter: bus, agentId: 'test-agent' });
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
    });
    (0, vitest_1.it)('emits memory:written on write with correct payload', async () => {
        const handler = vitest_1.vi.fn();
        bus.on('memory:written', handler);
        const entry = await store.write('hello');
        await new Promise(r => setTimeout(r, 0));
        (0, vitest_1.expect)(handler).toHaveBeenCalledOnce();
        const event = handler.mock.calls[0][0];
        (0, vitest_1.expect)(event.payload).toMatchObject({
            entry: { id: entry.id, content: 'hello' },
            agentId: 'test-agent',
        });
        (0, vitest_1.expect)(typeof event.payload.timestamp).toBe('string');
    });
    (0, vitest_1.it)('emits memory:updated on update', async () => {
        const handler = vitest_1.vi.fn();
        bus.on('memory:updated', handler);
        const entry = await store.write('original');
        handler.mockClear();
        await store.update(entry.id, { content: 'updated' });
        await new Promise(r => setTimeout(r, 0));
        (0, vitest_1.expect)(handler).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(handler.mock.calls[0][0].payload.entry.content).toBe('updated');
    });
    (0, vitest_1.it)('emits memory:deleted on delete', async () => {
        const handler = vitest_1.vi.fn();
        bus.on('memory:deleted', handler);
        const entry = await store.write('delete me');
        await store.delete(entry.id);
        await new Promise(r => setTimeout(r, 0));
        (0, vitest_1.expect)(handler).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(handler.mock.calls[0][0].payload.entry.id).toBe(entry.id);
    });
    (0, vitest_1.it)('emits edge:created on link', async () => {
        const handler = vitest_1.vi.fn();
        bus.on('edge:created', handler);
        const a = await store.write('A');
        const b = await store.write('B');
        handler.mockClear();
        const edge = await store.link(a.id, b.id, 'relates');
        await new Promise(r => setTimeout(r, 0));
        (0, vitest_1.expect)(handler).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(handler.mock.calls[0][0].payload.edge.id).toBe(edge.id);
    });
    (0, vitest_1.it)('does not fail write when handler throws', async () => {
        bus.on('memory:written', () => {
            throw new Error('handler boom');
        });
        const entry = await store.write('still works');
        (0, vitest_1.expect)(entry.content).toBe('still works');
    });
    (0, vitest_1.it)('works without emitter', async () => {
        const plain = new store_js_1.TimStore(':memory:');
        const entry = await plain.write('no events');
        (0, vitest_1.expect)(entry.id).toBeTruthy();
        plain.close();
    });
});
(0, vitest_1.describe)('TimStore runDecay', () => {
    let store;
    (0, vitest_1.beforeEach)(() => {
        store = new store_js_1.TimStore(':memory:');
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
    });
    (0, vitest_1.it)('marks entries before cutoff as irrelevant excluding listed ids', async () => {
        const old = await store.write('old');
        await new Promise(r => setTimeout(r, 5));
        const keep = await store.write('keep');
        const cutoff = new Date().toISOString();
        await new Promise(r => setTimeout(r, 5));
        const recent = await store.write('recent');
        const count = await store.runDecay({
            before: cutoff,
            exclude: [keep.id],
        });
        (0, vitest_1.expect)(count).toBe(1);
        (0, vitest_1.expect)((await store.read(old.id, { showIrrelevant: true }))?.irrelevant).toBe(true);
        (0, vitest_1.expect)((await store.read(keep.id))?.content).toBe('keep');
        (0, vitest_1.expect)((await store.read(recent.id))?.content).toBe('recent');
    });
});
//# sourceMappingURL=events.test.js.map