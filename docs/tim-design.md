# TIM - Theoretically Infinite Memory
## Architecture & Feature Plan v1.0

> **Status**: Design Phase — 2026-05-29
> **Author**: bbbee + Brain Mesh (nemotron-3-super-120b, gpt-oss-120b, gemma-4-31b)
> **Prior Art**: hmem v1.3.8 (its-over-9k), hmem v2 worktree

---

## 1. Executive Summary

TIM is a **local-first, self-optimizing cognitive OS for AI agents**. It replaces static key-value storage with a **weighted hypergraph** that learns what matters, forgets what doesn't, and converges across devices via **confidence-weighted CRDT sync**. One command: `tim init`. One file: `tim.db`. Every agent speaks MCP. Memory that actually works.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        MCP SERVER                           │
│  stdio transport — universal agent interface                │
│  Tools: read, write, search, sync, lease, visualize, ...   │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                     TIM KERNEL                              │
│  Core orchestrator. Routes tool calls → capabilities.      │
│  Event bus: typed events between modules.                   │
│  Plugin registry: load/unload capabilities at runtime.     │
└──┬──────────┬──────────┬──────────┬──────────┬─────────────┘
   │          │          │          │          │
┌──▼──┐  ┌───▼───┐  ┌───▼───┐  ┌───▼───┐  ┌───▼──────┐
│STORE│  │ SYNC  │  │SEARCH │  │ AGENT │  │  REM     │
│     │  │       │  │       │  │ MESH  │  │  SLEEP   │
│SQLite│  │CRDT   │  │FTS5 + │  │P2P    │  │compress, │
│+Vec  │  │Merkle │  │Vector │  │leases │  │decay,    │
│     │  │       │  │       │  │       │  │dedup     │
└─────┘  └───────┘  └───────┘  └───────┘  └──────────┘
```

### Module Structure (npm workspaces)

```
packages/
  tim-core/          # Kernel: event bus, plugin registry, MemoryInterface
  tim-store/         # SQLite driver + vector index
  tim-sync/          # CRDT sync protocol, Merkle tree, staging ledger
  tim-search/        # FTS5 + vector search, hybrid ranking
  tim-agent-mesh/    # P2P agent memory sharing, leases
  tim-rem-sleep/     # Background optimization engine
  tim-cli/           # CLI: init, sync, migrate, doctor, visualize
  tim-mcp/           # MCP server, tool registration
  tim-migrate/       # hmem → TIM migration engine
  tim-visualizer/    # 3D WebGL memory graph (Pro)
```

### Why This Architecture

- **hmem's sin**: 5439-line store monolith. Every change touches everything.
- **TIM's fix**: Each package has one job, version-locked interface. Replace `tim-store` without touching `tim-sync`.
- **Event bus**: Modules don't import each other — they emit and listen. `tim-rem-sleep` listens for `memory:written` events, triggers compression.
- **Plugin registry**: Third-party capabilities register at runtime. `tim-plugin-notion` syncs memory to Notion. No core changes needed.

---

## 3. Memory Model

### From Hierarchy to Hypergraph

hmem's 5-level hierarchy (L1-L5) was good but rigid. TIM uses a **weighted hypergraph**:

```
Entry (node)
  ├── id: ULID
  ├── content: text | json | blob
  ├── depth: 1-5 (preserved from hmem)
  ├── confidence: 0.0-1.0
  ├── created: timestamp
  ├── last_accessed: timestamp
  ├── decay_rate: float (Ebbinghaus curve parameter)
  └── visibility: bitmask (which agents can see this)

Edge (relationship)
  ├── source_id → target_id
  ├── type: relates | extends | contradicts | implements | blocks | leases
  ├── weight: 0.0-1.0
  └── metadata: json (lease expiry, creation context)
```

### SQLite Schema

```sql
-- Core entries
CREATE TABLE entries (
  id TEXT PRIMARY KEY,              -- ULID
  parent_id TEXT,                    -- NULL = root
  content TEXT NOT NULL,
  content_type TEXT DEFAULT 'text',  -- 'text' | 'json' | 'blob'
  depth INTEGER DEFAULT 1,          -- 1-5
  confidence REAL DEFAULT 1.0,      -- 0.0-1.0
  created_at TEXT NOT NULL,         -- ISO 8601
  accessed_at TEXT NOT NULL,
  decay_rate REAL DEFAULT 0.0,      -- 0.0 = never decay
  visibility INTEGER DEFAULT 1,     -- bitmask: 1=owner, 2=trusted, 4=public
  tags TEXT DEFAULT '[]',           -- JSON array
  irrelevant INTEGER DEFAULT 0,     -- soft delete
  tombstoned_at TEXT                -- hard-delete marker
);

-- Relationships (edges in the hypergraph)
CREATE TABLE edges (
  id TEXT PRIMARY KEY,              -- ULID
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT DEFAULT 'relates',      -- relates|extends|contradicts|implements|blocks|leases
  weight REAL DEFAULT 1.0,
  metadata TEXT DEFAULT '{}',       -- JSON: lease_expiry, confidence_override, ...
  FOREIGN KEY (source_id) REFERENCES entries(id),
  FOREIGN KEY (target_id) REFERENCES entries(id)
);

-- Vector embeddings (for semantic search)
CREATE VIRTUAL TABLE vec_entries USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[768]              -- all-MiniLM-L6-v2 dimension
);

-- Staging ledger (for sync)
CREATE TABLE staging (
  key TEXT PRIMARY KEY,             -- entry_id or edge_id
  entity_type TEXT NOT NULL,        -- 'entry' | 'edge'
  operation TEXT NOT NULL,          -- 'upsert' | 'delete'
  payload TEXT NOT NULL,            -- full row as JSON
  lww_timestamp INTEGER NOT NULL,   -- Unix ms
  lww_device TEXT NOT NULL,         -- device ULID
  lww_confidence REAL DEFAULT 1.0,
  acked INTEGER DEFAULT 0           -- 0=pending, 1=synced
);

-- Negative memory (suppression list)
CREATE TABLE suppressed (
  pattern TEXT NOT NULL,            -- FTS5 pattern or entry_id
  reason TEXT,
  suppressed_at TEXT NOT NULL,
  suppressed_by TEXT NOT NULL,      -- agent or device
  expires_at TEXT                   -- NULL = permanent
);

-- FTS5 index (full-text search)
CREATE VIRTUAL TABLE fts_entries USING fts5(
  content, tags, content_type,
  content='entries', content_rowid='rowid'
);
```

### Why Hypergraph Over Hierarchy

- **hmem**: Parent-child only. Can't model "this contradicts that" or "this implements that."
- **TIM**: Typed edges model real knowledge relationships. `trace_chain(start_id, type='contradicts', depth=5)` finds conflicting facts.
- **Confidence scores**: Two agents learn conflicting facts → TIM keeps both, marks lower-confidence one "contradicted." Agent sees both and decides.
- **Depth preserved**: L1-L5 still works — just one dimension of the graph. `parent_id` gives hierarchy; `edges` give cross-cutting connections.

---

## 4. Sync Protocol

### Confidence-Weighted CRDT

hmem v2 uses pure LWW (last-write-wins) + event union. This works for most cases but fails when:
- Device A writes a carefully researched fact (high confidence)
- Device B writes a quick note (low confidence) with a newer timestamp
- LWW picks B's note → A's research is lost

TIM's solution: **Confidence-weighted LWW**:

```
resolve_conflict(entry_a, entry_b):
  score_a = entry_a.confidence * time_decay(entry_a.timestamp)
  score_b = entry_b.confidence * time_decay(entry_b.timestamp)
  winner = max(score_a, score_b)
  if winner == entry_a:
    create_edge(entry_b, entry_a, type='contradicted_by')
    return entry_a
  else:
    create_edge(entry_a, entry_b, type='contradicted_by')
    return entry_b
```

### Merkle Tree for Delta Detection

Instead of comparing full staging ledgers (expensive for large DBs):

```
merkle_root = hash(
  hash(entry_1) + hash(entry_2) + ... + hash(entry_N)
)
```

Devices exchange merkle roots first. If roots match → in sync. If not → binary search down the tree to find divergent branches. Only sync the deltas.

### Staging Ledger with GC

From hmem v2 branch (proven design):
1. Every write → staging row with LWW timestamp
2. `tim sync push` → export staging rows since last acked cursor
3. Remote → import, reconcile, ack
4. `tim sync gc` → delete staging rows older than N days where all devices acked

### Why Not Pure CRDT

- CRDTs (Conflict-free Replicated Data Types) are elegant but complex to implement correctly
- LWW covers 95% of use cases; confidence-weighting covers the remaining 5%
- Merkle trees add efficient delta detection without CRDT complexity
- This is **proven**: hmem v2 branch has 357 tests for LWW+event-union

---

## 5. Multi-Agent Support

### Visibility Bitmasks

Each entry has a `visibility` bitmask (integer):
- Bit 0 (1): Owner agent
- Bit 1 (2): Trusted agents (same user, different CLI)
- Bit 2 (4): Leased agents (temporary access)
- Bit 3 (8): Public (all agents on device)

```
SET visibility = 1          -- private
SET visibility = 3          -- owner + trusted (1|2)
SET visibility = 7          -- owner + trusted + leased
```

### Agent Identity

Each agent gets a ULID + label at registration:
```
tim agent register --name "Claude Code" --label "claude"
tim agent register --name "Cursor" --label "cursor"
```

Agent ULIDs are stable across restarts (stored in config, not derived from PID).

### Memory Leases

Agents can temporarily delegate access:
```
tim lease grant \
  --agent cursor \
  --entry P0048 \
  --duration 1h \
  --permission read
```

Lease is an edge: `{type: 'leases', metadata: {expiry: '2026-05-29T23:30:00Z', permission: 'read'}}`.

On access check: if lease expired → edge weight → 0, entry invisible to lessee.

### Why This Over hmem's Approach

- hmem: one agent per device. Agent identity = PID. Cross-agent → chaos.
- TIM: registered agents with stable ULIDs. Visibility bitmasks for sharing. Leases for temporary delegation.
- This enables the **Agent Mesh** vision: agents on different devices share memory securely.

---

## 6. REM Sleep — Self-Improvement Engine

### Background Processes (runs on idle or cron)

| Process | Trigger | What it does |
|---------|---------|-------------|
| **Compression** | After 100 writes | LLM summarizes consecutive entries, stores as single L1 entry with `confidence=0.8` |
| **Dedup** | Every 6h | FTS5 + vector cosine similarity → find near-duplicates → merge, keep higher-confidence |
| **Decay** | Every 1h | `decay_rate * hours_since_access * confidence` → if score < 0.1, mark irrelevant |
| **Clustering** | Every 24h | Vector clustering (k-means on embeddings) → auto-create tag groups |
| **Health** | Every 6h | Broken links, orphan entries, FTS integrity → auto-repair or flag |
| **Counterfactual** | Idle | "What if agent tried Y instead of X?" → simulate alternative, store as virtual experience |

### Compression Algorithm

```
1. Find chains: entries linked by 'extends' or 'relates' edges
2. Group by time proximity (< 1h apart)
3. LLM prompt: "Summarize these N entries into one. Preserve: key facts, decisions, contradictions."
4. Store summary as new entry, link to originals via 'summarizes' edges
5. Originals: decay_rate *= 2 (age faster)
```

### Negative Memory (Suppression)

Pattern-based suppression:
```
tim suppress --pattern "npm publish rate limit" --reason "Fixed in v2.0.0" --duration 30d
```

Before returning search results, TIM filters against suppressed patterns. Agent never sees stale corrections.

### Why REM Sleep

- hmem: memory only grows. 6 months → your agent drowns in old context.
- TIM: memory self-maintains. Stale facts decay. Duplicates merge. Important facts survive.
- **Cold start protection**: No clustering/compression until > 50 entries exist. Graceful degradation.

---

## 7. Developer Experience

### `tim init` — One Command

```
$ tim init
✓ SQLite database created: ~/.tim/tim.db
✓ MCP config written: ~/.tim/mcp.json
✓ Agent registered: "claude" (ULID: 01ARZ3...)
✓ Agent registered: "cursor" (ULID: 01ARZ4...)
✓ Vector index initialized (all-MiniLM-L6-v2)
✓ Sync: local-only (tim sync setup for multi-device)

TIM ready. Connect your MCP client to ~/.tim/mcp.json
```

### MCP Tool API (v1.0)

| Tool | Purpose | Example |
|------|---------|---------|
| `tim_read` | Read entry + children + edges | `tim_read(id='P0048', depth=2, include_edges=true)` |
| `tim_write` | Create entry with edges, confidence, visibility | `tim_write(content='...', confidence=0.9, visibility=3)` |
| `tim_search` | Hybrid FTS5 + vector search | `tim_search(query='sync bug', top_k=10)` |
| `tim_link` | Create/update edge between entries | `tim_link(source='D001', target='E005', type='contradicts')` |
| `tim_trace` | Follow edge chain | `tim_trace(start='D001', type='implements', depth=5)` |
| `tim_lease` | Grant/revoke agent memory access | `tim_lease(grant='cursor', entry='P0048', ttl='1h')` |
| `tim_sync` | Push/pull/status | `tim_sync(action='push')` |
| `tim_suppress` | Add to negative memory | `tim_suppress(pattern='npm rate limit', ttl='30d')` |
| `tim_health` | DB integrity, broken links, stats | `tim_health()` |
| `tim_cluster` | Auto-tag clustering | `tim_cluster()` |
| `tim_decay` | Manual decay run | `tim_decay()` |
| `tim_export` | Export as .tim or .md | `tim_export(format='md')` |
| `tim_import` | Import .hmem or .tim | `tim_import(source='backup.tim')` |
| `tim_doctor` | Diagnostic: config, deps, API, DB | `tim_doctor()` |
| `tim_visualize` | Open 3D graph in browser (Pro) | `tim_visualize()` |

### Plugin System

```
// tim-plugin-notion/plugin.ts
export default {
  name: 'notion',
  version: '1.0.0',
  hooks: {
    'memory:written': async (entry) => {
      await notion.pages.create({...})
    }
  }
}
```

Install: `tim plugin install tim-plugin-notion`

### Why This DX

- hmem: `hmem init` requires answering 5+ questions. Manual hook deployment. `~/.hmem/.mcp.json` confusing path.
- TIM: `tim init` → done. Hooks auto-deploy. MCP config auto-written. Zero questions for 80% use case.
- Plugin system borrowed from hmem's MCP tool registration pattern but generalized.

---

## 8. Migration: hmem → TIM

### `tim migrate`

```
$ tim migrate --from ~/.hmem/personal.hmem --to ~/.tim/tim.db
✓ Scanning hmem: 2,003 entries, 234 nodes, 89 tags
✓ Schema mapping: hmem_ids → TIM_ids
  - P0001 → E0001 (Project entries become regular entries)
  - L0003 → E0003 (Lesson entries, type='lesson')
  - Tags → edges (type='tagged')
✓ Converting hierarchy: parent_id preserved, depth calculated
✓ Creating edges: links → edges (type='relates')
✓ Preserving timestamps: created_at, modified_at
✓ Migrated: 2,237 entries, 342 edges, 89 tags
✓ hmem backup: ~/.hmem/personal.hmem.backup-20260529

TIM ready. Old hmem still functional at ~/.hmem/
```

### Mapping

| hmem | TIM |
|------|-----|
| Entry ID (P0001) | Entry ID (E0001), metadata: {hmem_id: 'P0001'} |
| Prefix (P/L/E/T/D/M) | Entry type field |
| 5-level hierarchy | parent_id + depth |
| Links (string[]) | Edges (type='relates') |
| Tags (#sql) | Edges (type='tagged') |
| O-entries (session log) | Edges (type='session_exchange') |
| Sync (hmem-sync) | `tim sync` (compatible protocol for v1 transition) |

### Why This Approach

- **One command**. No manual steps. No data loss.
- **Backward compatible**: Old .hmem file stays, just copied.
- **Progressive**: Users can run TIM alongside hmem during transition.
- **Schema mapping is lossless**: Every hmem concept has a TIM equivalent.

---

## 9. Monetization

### Free Tier (OSS Core, npm: `tim-mcp`)

- Local memory: unlimited entries, edges, depth
- FTS5 search
- Agent registration (up to 3 agents)
- Manual sync (`tim sync push/pull`)
- REM Sleep: decay + health (basic)
- CLI: init, search, read, write, export, import
- MCP server (stdio transport)

### Pro Tier ($9/mo or $79/yr)

- Multi-device sync (hmem-sync Pro)
- Vector search (embeddings)
- Agent Mesh (P2P memory sharing)
- REM Sleep: full (compression, clustering, counterfactual)
- Unlimited agents
- 3D Visualizer (WebGL brain graph)
- Leases (temporary agent access)
- Priority support

### Why $9/mo

- hmem-sync Pro was planned at $5-10. TIM Pro adds vector search + visualizer → $9 justified.
- Free tier is genuinely useful (not crippleware). Pro adds power-user features.
- "SQLite of AI Memory" positioning: SQLite is free, but you pay for Cloud Sync (Litestream, Turso).

---

## 10. Technical Decisions

### SQLite vs PostgreSQL vs libSQL

**Decision: SQLite**
- Single file, zero config. "TIM is a file" is the pitch.
- better-sqlite3 is battle-tested (hmem's 357 tests prove it)
- FTS5 built-in, vec0 extension for vectors
- Can add Postgres driver later (`tim-driver-postgres`)

### MCP vs REST

**Decision: MCP stdio (primary), REST (sync server)**
- MCP is the universal agent protocol. Claude Code, Cursor, OpenCode, Hermes all speak it.
- REST for hmem-sync server (cross-device). Already proven in hmem v2.
- Agents don't need REST — they need tools in their context.

### LWW vs CRDT

**Decision: Confidence-weighted LWW**
- Pure CRDT is complex, hard to test, harder to debug.
- LWW covers 95% of use cases. Confidence-weighting covers the rest.
- Proven: hmem v2 branch has 357 passing tests for LWW+event-union.
- Can add full CRDT later as optional sync mode.

### TypeScript vs Rust vs Python

**Decision: TypeScript**
- npm ecosystem (distribution, MCP SDK)
- Same language as hmem → migration path smoother
- better-sqlite3 bindings are mature
- Can add native modules in Rust later for perf-critical paths

---

## 11. Implementation Phases

### Phase 1: Core (v1.0.0-alpha) — 2-3 days
- [ ] `tim-core`: kernel, event bus, plugin registry, MemoryInterface
- [ ] `tim-store`: SQLite schema, CRUD operations, migrations
- [ ] `tim-search`: FTS5 index, basic search
- [ ] `tim-cli`: init, write, read, search, doctor
- [ ] `tim-mcp`: MCP server with 8 core tools (read, write, search, link, health, export, import, doctor)
- [ ] Tests: 100+ unit tests for store, CLI, MCP

### Phase 2: Sync (v1.0.0-beta) — 2-3 days
- [ ] `tim-sync`: staging ledger, push/pull, confidence-weighted LWW
- [ ] Merkle tree delta detection
- [ ] Sync GC
- [ ] hmem-sync server compatibility layer
- [ ] Multi-agent registration + visibility bitmasks
- [ ] Tests: 200+ sync tests (port from hmem v2 branch)

### Phase 3: Advanced (v1.0.0) — 3-5 days
- [ ] `tim-rem-sleep`: decay, health, basic dedup
- [ ] `tim-agent-mesh`: leases, P2P prototype
- [ ] `tim-migrate`: hmem → TIM migration
- [ ] `tim-visualizer`: basic 3D graph (Pro)
- [ ] Vector search (optional, Pro)
- [ ] Full MCP tool set (15 tools)
- [ ] Docs, release notes, npm publish

### Phase 4: Pro (v1.1.0) — 5-7 days
- [ ] hmem-sync Pro server (multi-device)
- [ ] Full REM Sleep (compression, clustering, counterfactual)
- [ ] Agent Mesh P2P
- [ ] Billing, auth, Pro tier enforcement
- [ ] Landing page, docs site

---

## 12. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Sync data loss | Low | Critical | Confidence-weighted LWW never deletes — only marks superseded. Staging ledger is append-only. |
| Schema migration failure | Medium | High | hmem experience: migrations must be forward-compat. All TIM migrations are additive (ALTER TABLE ADD COLUMN). |
| Performance at scale (>10k entries) | Medium | Medium | SQLite handles 10k rows trivially. Vector index is the bottleneck — optional in Free tier. |
| Agent Mesh security | High | High | Leases have expiry. Visibility bitmasks enforced at store level, not MCP level. Audit log for all cross-agent access. |
| API rate limiting (embeddings) | Medium | Low | Embeddings are cached. Pro tier only. Batch processing. |
| hmem→TIM migration data loss | Low | High | Migration is read-only on source. Backup before migrate. Dry-run mode. |
| Competition (Mem0, Letta, LangMem) | Medium | Medium | TIM's edge: local-first, zero-config, MCP-native. Competitors are cloud-first, complex, Python-only. |

---

## 13. Appendix: hmem v2 Worktree Assets

The v2 worktree at `/home/bbbee/projects/hmem/.worktrees/v2` contains:

- **357 passing tests** (73 test files) for LWW+event-union sync
- **Staging ledger** with GC (bounded, ack-based)
- **Durable offline retry queue** (idempotency-stable)
- **Version-aware CLI dispatch** (schema_major=2 → v2 lane)
- **Collision-tolerant imports** (placeholder-insert + resolveLabelCollisions)
- **Deterministic label collision resolution** (ULID-based, quiescent)

All of these can be ported directly to `tim-sync` and `tim-store`. The sync protocol is proven — TIM adopts it with confidence-weighting as the only change.

### Porting Strategy

1. Copy v2 worktree to `~/projects/tim/`
2. Rename packages, update imports
3. Add confidence field to staging schema
4. Add confidence-weighted resolution to `resolveLabelCollisions`
5. Run 357 tests → all should pass
6. Add new tests for confidence-weighting edge cases

---

*End of TIM Architecture & Feature Plan v1.0*
*Next: Implementation Phase 1 — Core*
