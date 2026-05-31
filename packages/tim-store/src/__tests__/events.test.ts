import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InProcessEventBus } from 'tim-core';
import { TimStore } from '../store.js';

describe('TimStore events', () => {
  let store: TimStore;
  let bus: InProcessEventBus;

  beforeEach(() => {
    bus = new InProcessEventBus();
    store = new TimStore(':memory:', { emitter: bus, agentId: 'test-agent' });
  });

  afterEach(() => {
    store.close();
  });

  it('emits memory:written on write with correct payload', async () => {
    const handler = vi.fn();
    bus.on('memory:written', handler);

    const entry = await store.write('hello');
    await new Promise(r => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0];
    expect(event.payload).toMatchObject({
      entry: { id: entry.id, content: 'hello' },
      agentId: 'test-agent',
    });
    expect(typeof event.payload.timestamp).toBe('string');
  });

  it('emits memory:updated on update', async () => {
    const handler = vi.fn();
    bus.on('memory:updated', handler);

    const entry = await store.write('original');
    handler.mockClear();

    await store.update(entry.id, { content: 'updated' });
    await new Promise(r => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].payload.entry.content).toBe('updated');
  });

  it('emits memory:deleted on delete', async () => {
    const handler = vi.fn();
    bus.on('memory:deleted', handler);

    const entry = await store.write('delete me');
    await store.delete(entry.id);
    await new Promise(r => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].payload.entry.id).toBe(entry.id);
  });

  it('emits edge:created on link', async () => {
    const handler = vi.fn();
    bus.on('edge:created', handler);

    const a = await store.write('A');
    const b = await store.write('B');
    handler.mockClear();

    const edge = await store.link(a.id, b.id, 'relates');
    await new Promise(r => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].payload.edge.id).toBe(edge.id);
  });

  it('does not fail write when handler throws', async () => {
    bus.on('memory:written', () => {
      throw new Error('handler boom');
    });

    const entry = await store.write('still works');
    expect(entry.content).toBe('still works');
  });

  it('works without emitter', async () => {
    const plain = new TimStore(':memory:');
    const entry = await plain.write('no events');
    expect(entry.id).toBeTruthy();
    plain.close();
  });
});

describe('TimStore runDecay', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('marks entries before cutoff as irrelevant excluding listed ids', async () => {
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

    expect(count).toBe(1);
    expect((await store.read(old.id, { showIrrelevant: true }))?.irrelevant).toBe(true);
    expect((await store.read(keep.id))?.content).toBe('keep');
    expect((await store.read(recent.id))?.content).toBe('recent');
  });
});
