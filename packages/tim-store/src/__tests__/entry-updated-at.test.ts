import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('Entry.updatedAt', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes updated_at on read and bumps it on update', async () => {
    const written = await store.write('Fact\nThe API uses port 3100.', {
      tags: ['#api', '#infra'],
    });
    expect(written.updatedAt).toBe(written.createdAt);

    await new Promise(r => setTimeout(r, 5));
    await store.update(written.id, { content: 'The API uses port 3200.' });

    const read = await store.read(written.id);
    expect(read!.updatedAt > read!.createdAt).toBe(true);
  });
});
