import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TenantRegistry } from '../tenant-registry.js';
import { acknowledgeCursor, createFile, pullBlobs, pushBlobs } from '../storage.js';
let root: string; let r: TenantRegistry; let tenant: string; let generation: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(),'cursor-protocol-')); r = new TenantRegistry(root); tenant = r.register().id;
  const f = createFile(r,tenant,'f','salt'); if ('conflict' in f) throw new Error(); generation = f.generation;
});
afterEach(() => { r.close(); rmSync(root,{ recursive: true,force: true }); });
function push(key: string): number {
  const result = pushBlobs(r,tenant,'free','f',key,[{ proposed_id: key,entity_type: 'entry',entity_key: key,
    data: 'cipher',device_id: 'sender',lww_device: 'origin',updated_at: new Date(100).toISOString() }],generation);
  if ('error' in result) throw new Error(result.error); return result.mappings[0].final_id;
}
it('rejects wrong-generation/future/malformed cursors and bounds ACK by delivered pages', () => {
  push('a'); push('b');
  expect(pullBlobs(r,tenant,'f',`${generation}|3`)).toMatchObject({ status: 409 });
  expect(pullBlobs(r,tenant,'f','wrong|1')).toMatchObject({ status: 409 });
  expect(pullBlobs(r,tenant,'f',`${generation}|1junk`)).toMatchObject({ status: 409 });
  const p = pullBlobs(r,tenant,'f',undefined,1,generation,'dev'); if ('error' in p) throw new Error();
  expect(p.has_more).toBe(true);
  expect(acknowledgeCursor(r,tenant,'f',generation,'dev',`${generation}|2`)).toMatchObject({ status: 409 });
  expect(acknowledgeCursor(r,tenant,'f',generation,'dev',p.next_cursor)).toHaveProperty('cursor',p.next_cursor);
  expect(acknowledgeCursor(r,tenant,'f',generation,'dev',`${generation}|0`)).toHaveProperty('cursor',p.next_cursor);
  r.close(); r = new TenantRegistry(root);
  const db = r.getTenantDb(tenant);
  expect(db.prepare('SELECT applied_id,delivered_id FROM device_cursors').get()).toEqual({ applied_id: 1,delivered_id: 1 });
  expect(db.prepare('SELECT received_at,lww_device,device_id FROM blobs LIMIT 1').get()).toMatchObject({ lww_device:'origin',device_id:'sender',received_at:expect.any(String) });
  db.close();
});
it('preserves high-water and never reuses IDs after history deletion', () => {
  const id = push('a');
  const db = r.getTenantDb(tenant); db.exec('DELETE FROM blobs'); db.close();
  expect(pullBlobs(r,tenant,'f',`${generation}|${id}`)).not.toHaveProperty('error');
  expect(push('b')).toBeGreaterThan(id);
});
it('generation rotation fences old requests, cursors and acknowledgements', () => {
  push('a'); pullBlobs(r,tenant,'f',undefined,1,generation,'dev');
  const db = r.getTenantDb(tenant); db.prepare("UPDATE files SET generation='restored-generation'").run(); db.close();
  expect(pullBlobs(r,tenant,'f',`${generation}|1`,1,generation,'dev')).toMatchObject({ status:409 });
  expect(acknowledgeCursor(r,tenant,'f',generation,'dev',`${generation}|1`)).toMatchObject({ status:409 });
  expect(pushBlobs(r,tenant,'free','f','a',[],generation)).toMatchObject({ status:409 });
});
it('preserves legacy unknown metadata and sequence high-water during migration', () => {
  let db = r.getTenantDb(tenant);
  db.exec(`DROP TABLE blobs; CREATE TABLE blobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,file_id TEXT NOT NULL,client_proposed_id TEXT NOT NULL,
    data TEXT NOT NULL,device_id TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,
    UNIQUE(file_id, client_proposed_id));
    INSERT INTO blobs VALUES (25,'f','legacy','cipher','sender','unknown-time',NULL);
    INSERT INTO blobs VALUES (99,'f','removed','cipher','sender','unknown-time',NULL);
    DELETE FROM blobs WHERE id=99;`);
  db.close(); db = r.getTenantDb(tenant);
  expect(db.prepare('SELECT id,entity_type,entity_key,lww_device,received_at FROM blobs').get()).toEqual({
    id:25,entity_type:null,entity_key:null,lww_device:null,received_at:null,
  });
  expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='blobs'").get()).toEqual({seq:99}); db.close();
  expect(push('new')).toBeGreaterThan(99);
});
