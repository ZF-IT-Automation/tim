/**
 * Resolve evidence source availability at read time (no network/git fetches).
 */

import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { isSecret } from './secret.js';
import {
  findChildByKind,
  KIND_EXCHANGE_BATCH,
  KIND_EXCHANGES_ROOT,
  KIND_SESSION,
} from './session-tree.js';

export type EvidenceSourceStatus =
  | 'available'
  | 'unavailable'
  | 'suppressed'
  | 'secret'
  | 'unverified';

async function entryVisible(
  store: TimStore,
  id: string,
  enforceSuppression: boolean,
): Promise<Entry | null> {
  return store.read(id, {
    showIrrelevant: true,
    includeChildren: false,
    enforceSuppression,
  });
}

export async function resolveEntrySourceStatus(
  store: TimStore,
  entryId: string,
): Promise<EvidenceSourceStatus> {
  const raw = await entryVisible(store, entryId, false);
  if (!raw || raw.tombstonedAt) return 'unavailable';
  const visible = await entryVisible(store, entryId, true);
  if (!visible) return 'suppressed';
  if (isSecret(store.getDb(), raw.id)) return 'secret';
  return 'available';
}

async function userExchangesInSeqRange(
  store: TimStore,
  sessionId: string,
  seqFrom: number,
  seqTo: number,
): Promise<Entry[]> {
  const canonicalSessionId = store.resolveSessionAlias(sessionId);
  const session = await store.read(canonicalSessionId, { showIrrelevant: true, includeChildren: false });
  if (!session || session.metadata.kind !== KIND_SESSION) return [];

  sessionId = canonicalSessionId;

  const exNode = await findChildByKind(store, sessionId, KIND_EXCHANGES_ROOT);
  if (!exNode) return [];

  const batches = await store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH);
  const users: Entry[] = [];
  for (const batch of batches) {
    const batchUsers = (await store.getChildrenBySeq(batch.id)).filter(
      u => u.metadata.role === 'user',
    );
    for (const u of batchUsers) {
      const seq = Number(u.metadata.seq);
      if (Number.isFinite(seq) && seq >= seqFrom && seq <= seqTo) users.push(u);
    }
  }
  return users;
}

export async function resolveSessionSourceStatus(
  store: TimStore,
  sessionId: string,
  seqFrom: number,
  seqTo: number,
): Promise<EvidenceSourceStatus> {
  const canonicalSessionId = store.resolveSessionAlias(sessionId);
  const users = await userExchangesInSeqRange(store, canonicalSessionId, seqFrom, seqTo);
  if (users.length === 0) return 'unavailable';

  for (const user of users) {
    const visible = await entryVisible(store, user.id, true);
    if (!visible) return 'suppressed';
    if (isSecret(store.getDb(), user.id)) return 'secret';
  }
  return 'available';
}
