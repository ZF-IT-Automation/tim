// TIM Sync — package exports

export {
  buildMerkleTree,
  getMerkleRoot,
  resolveLWW,
  mergeStaging,
  syncCycle,
  computeDelta,
  isInSync,
} from './sync.js';

export type {
  MerkleNode,
  ConflictResolution,
  SyncPushRequest,
  SyncPushResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncResult,
} from './sync.js';
