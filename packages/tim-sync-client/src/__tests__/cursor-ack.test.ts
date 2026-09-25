import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TimStore } from 'tim-store';
import { startHostedSyncServer, type HostedServerHandle } from '../../../tim-sync-server/src/server.js';
import { TimSyncClient } from '../client.js';
import { pullCycle } from '../sync.js';
import { getSyncStatePath, type SyncState } from '../config.js';
import { deriveKey, encrypt, decrypt } from '../crypto.js';

const fault = vi.hoisted(() => ({ persist: false }));
vi.mock('../config.js', async original => {
  const config = await original<typeof import('../config.js')>();
  return { ...config, saveSyncState: (s: SyncState) => {
    if (fault.persist && s.cursor) throw new Error('disk full');
    config.saveSyncState(s);
  } };
});
let root: string; let server: HostedServerHandle; let client: TimSyncClient;
let store: TimStore; let state: SyncState; let tenant: string; let originalHome: string | undefined;
const cryptoKey = deriveKey('pass','salt');
const enc = (s: string) => encrypt(s,cryptoKey);
const dec = (s: string) => decrypt(s,cryptoKey);
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(),'cursor-ack-'));
  originalHome = process.env.HOME; process.env.HOME = join(root,'replica-a-home');
  server = await startHostedSyncServer({ port:0,dataDir:root });
  const t = server.registry.register('pro'); tenant=t.id;
  client = new TimSyncClient(`http://127.0.0.1:${server.port}`,t.token);
  const file = await client.createFile('f','salt');
  store = new TimStore(join(root,'replica-a.db'));
  state = { fileId:'f',fileGeneration:file.generation,cursor:null,lastPull:null,lastPush:null };
});
afterEach(async () => { fault.persist=false; store.close(); await server.close(); process.env.HOME=originalHome; rmSync(root,{recursive:true,force:true}); });
function blob(id: string, overrides: Record<string,unknown> = {}) {
  const e = { v:1,type:'entry',key:id,lww:new Date(100).toISOString(),device:'origin',deleted:true,payload:JSON.stringify({id}),...overrides };
  return { proposed_id:id,entity_key:id,entity_type:'entry' as const,lww_device:'origin',device_id:'forwarder',updated_at:new Date(100).toISOString(),data:enc(JSON.stringify(e)) };
}
async function push(blobs: ReturnType<typeof blob>[]): Promise<void> {
  await client.push({file_id:'f',file_generation:state.fileGeneration,client_schema_major:1,idempotency_key:String(Math.random()),blobs});
}
function ackRow(): { applied_id: number; delivered_id: number } | undefined {
  const db=server.registry.getTenantDb(tenant);
  try { return db.prepare('SELECT applied_id,delivered_id FROM device_cursors').get() as ReturnType<typeof ackRow>; } finally {db.close();}
}
it.each([
  {v:99}, {device:'different'}, {key:'other'}, {lww:'bad'}, {payload:'not JSON'},
  {type:'edge'}, {payload:JSON.stringify({id:'other'})},
])('rolls back and forbids ACK for malformed page: %j',async invalid => {
  await push([blob('valid'),blob('bad',invalid)]);
  await expect(pullCycle(client,store,state,dec,undefined,'replica')).rejects.toThrow();
  expect(store.getDb().prepare('SELECT id FROM entries').all()).toEqual([]);
  expect(state.cursor).toBeNull(); expect(ackRow()?.applied_id).toBe(0);
});
it('persists cursor before ACK, retries failed ACK, and safely applies duplicate replay',async () => {
  await push([blob('x')]);
  const original=client.ack.bind(client);
  const spy=vi.spyOn(client,'ack').mockImplementationOnce(async (_f,_g,_d,cursor) => {
    expect(JSON.parse(readFileSync(getSyncStatePath(),'utf8')).cursor).toBe(cursor);
    expect(store.getDb().prepare("SELECT tombstoned_at FROM entries WHERE id='x'").get()).toBeTruthy();
    throw new Error('lost ACK');
  });
  await expect(pullCycle(client,store,state,dec,undefined,'replica')).rejects.toThrow('lost ACK');
  expect(state.cursor).not.toBeNull(); expect(ackRow()?.applied_id).toBe(0);
  store.close(); store = new TimStore(join(root,'replica-a.db'));
  state = JSON.parse(readFileSync(getSyncStatePath(),'utf8')) as SyncState;
  spy.mockImplementation(original);
  await pullCycle(client,store,state,dec,undefined,'replica');
  expect(ackRow()?.applied_id).toBe(1);
  state.cursor=null;
  expect(await pullCycle(client,store,state,dec,undefined,'replica')).toMatchObject({pulled:0});
});
it('does not ACK when cursor persistence fails',async () => {
  await push([blob('x')]); fault.persist=true;
  await expect(pullCycle(client,store,state,dec,undefined,'replica')).rejects.toThrow('disk full');
  expect(state.cursor).toBeNull(); expect(ackRow()?.applied_id).toBe(0);
  fault.persist=false;
  await pullCycle(client,store,state,dec,undefined,'replica'); expect(ackRow()?.applied_id).toBe(1);
});
it('keeps successful earlier pages ACKed when a later page fails',async () => {
  await push([...Array.from({length:100},(_,i)=>blob(String(i))),blob('bad',{v:2})]);
  await expect(pullCycle(client,store,state,dec,undefined,'replica')).rejects.toThrow();
  expect(ackRow()?.applied_id).toBe(100); expect(state.cursor).toBe(`${state.fileGeneration}|100`);
});
it('rejects unsupported server generation clearly',async () => {
  const realFetch=globalThis.fetch;
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({protocol_generation:999,files:[]}))));
  try { await expect(client.listFiles()).rejects.toThrow('Unsupported server protocol generation'); }
  finally { globalThis.fetch=realFetch; }
});
it('rejects unsupported request schemas and outer ordering metadata',async () => {
  await expect(client.push({file_id:'f',file_generation:state.fileGeneration,client_schema_major:2,idempotency_key:'k',blobs:[]})).rejects.toThrow('Unsupported');
  await expect(client.push({file_id:'f',file_generation:state.fileGeneration,client_schema_major:1,idempotency_key:'k',blobs:[{...blob('x'),updated_at:'garbage'}]})).rejects.toThrow('Invalid push metadata');
});
it('does not ACK an undecryptable page',async () => {
  await push([blob('x')]);
  await expect(pullCycle(client,store,state,() => {throw new Error('wrong key');},undefined,'replica')).rejects.toThrow('wrong key');
  expect(state.cursor).toBeNull(); expect(ackRow()?.applied_id).toBe(0);
});
it('rolls back a page whose valid edge cannot be applied locally',async () => {
  const edge={v:1,type:'edge',key:'missing|target|relates',lww:new Date(100).toISOString(),device:'origin',deleted:false,
    payload:JSON.stringify({id:'edge',source_id:'missing',target_id:'target',type:'relates',weight:1,metadata:'{}'})};
  await client.push({file_id:'f',file_generation:state.fileGeneration,client_schema_major:1,idempotency_key:'edge',blobs:[
    blob('valid'),{...blob('missing|target|relates'),entity_type:'edge',data:enc(JSON.stringify(edge))},
  ]});
  await expect(pullCycle(client,store,state,dec,undefined,'replica')).rejects.toThrow('FOREIGN KEY');
  expect(store.getDb().prepare('SELECT id FROM entries').all()).toEqual([]);
  expect(state.cursor).toBeNull(); expect(ackRow()?.applied_id).toBe(0);
});
it('refuses a response cursor that skips beyond the returned records',async () => {
  const actual=globalThis.fetch;
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({protocol_generation:1,generation:state.fileGeneration,
    blobs:[],has_more:false,next_cursor:`${state.fileGeneration}|20`}))));
  try { await expect(client.pull('f',undefined,1,state.fileGeneration,'replica')).rejects.toThrow('Invalid cursor progression'); }
  finally { globalThis.fetch=actual; }
});
it('hosted encrypted entry and edge conflicts converge with reversed stale arrivals',async () => {
  const origin=new TimStore(':memory:',{deviceId:'source'});
  const other=new TimStore(join(root,'replica-b.db'));
  try {
    await origin.write('source',{id:'source'}); await origin.write('target',{id:'target'});
    await origin.write('node',{id:'node'});
    const entryPayload=(id:string,title:string) => JSON.stringify({
      ...origin.getDb().prepare('SELECT * FROM entries WHERE id=?').get(id) as object,title,
    });
    const make=(type:'entry'|'edge',key:string,time:number,device:string,deleted:boolean,payload:string) => ({
      proposed_id:key,entity_key:key,entity_type:type,updated_at:new Date(time).toISOString(),lww_device:device,device_id:'forwarder',
      data:enc(JSON.stringify({v:1,type,key,lww:new Date(time).toISOString(),device,deleted,payload})),
    });
    const baseline=['source','target'].map(id=>make('entry',id,10,'origin',false,entryPayload(id,id)));
    const edgePayload=(id:string)=>JSON.stringify({id,source_id:'source',target_id:'target',type:'relates',weight:1,metadata:'{}'});
    const events=[
      make('entry','node',100,'a',false,entryPayload('node','old')),
      make('entry','node',200,'a',false,entryPayload('node','loser')),
      make('entry','node',200,'z',false,entryPayload('node','winner')),
      make('edge','source|target|relates',100,'z',false,edgePayload('one')),
      make('edge','source|target|relates',200,'z',false,edgePayload('two')),
      make('edge','source|target|relates',300,'a',true,edgePayload('delete-other-id')),
    ];
    const second=await client.createFile('second','salt');
    await client.push({file_id:'f',file_generation:state.fileGeneration,client_schema_major:1,idempotency_key:'forward',blobs:[...baseline,...events]});
    await client.push({file_id:'second',file_generation:second.generation,client_schema_major:1,idempotency_key:'reverse',blobs:[...baseline,...events.reverse()]});
    await pullCycle(client,store,state,dec,undefined,'replica-a');
    process.env.HOME=join(root,'replica-b-home');
    await pullCycle(client,other,{fileId:'second',fileGeneration:second.generation,cursor:null,lastPull:null,lastPush:null},dec,undefined,'replica-b');
    const canonical=(s:TimStore)=>({
      entries:s.getDb().prepare('SELECT id,title,updated_at,lww_device,tombstoned_at FROM entries ORDER BY id').all(),
      edges:s.getDb().prepare('SELECT * FROM edges').all(),
      versions:s.getDb().prepare('SELECT * FROM edge_versions').all(),
    });
    expect(canonical(store)).toEqual(canonical(other));
    expect(await store.read('node')).toMatchObject({title:'winner'});
    expect(canonical(store).edges).toEqual([]);
  } finally {origin.close();other.close();}
});
