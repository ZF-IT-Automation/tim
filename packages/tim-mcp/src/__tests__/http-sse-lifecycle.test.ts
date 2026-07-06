import { describe, it, expect, afterEach } from 'vitest';
import { createHttpServer } from '../server.js';

describe('SSE lifecycle', () => {
  let handle: Awaited<ReturnType<typeof createHttpServer>>;

  afterEach(async () => { await handle.close(); });

  it('releases the per-connection Server when the client disconnects', async () => {
    process.env.TIM_DB_PATH = `/tmp/tim-sse-${Date.now()}.db`;
    handle = await createHttpServer({ host: '127.0.0.1', port: 0 });

    const open = async () => {
      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${handle.port}/sse`, {
        signal: ctrl.signal, headers: { accept: 'text/event-stream' },
      });
      // Read until the endpoint event arrives so the server side is fully set up.
      const reader = res.body!.getReader();
      await reader.read();
      return { ctrl, reader };
    };

    const a = await open();
    const b = await open();
    a.ctrl.abort();
    b.ctrl.abort();
    // Give close events a tick to propagate.
    await new Promise(r => setTimeout(r, 200));

    expect(handle.activeConnections()).toBe(0);
  });
});
