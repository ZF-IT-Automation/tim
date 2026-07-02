# Plan 5: HTTP/SSE Multi-Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In HTTP/SSE mode, each connected client gets its own session identity (no daemon-global cwd/session-cache leakage, no marker files written into the daemon's directory), and disconnected SSE clients no longer leak `Server` instances.

**Architecture:** `createMcpServer` gains a `transportMode` option threaded from `startServer`/`createHttpServer`. In HTTP mode the handlers stop consulting daemon-local state (`process.cwd()`, the global session-cache file, marker walk-up) and rely on explicit args (`sessionId`, `cwd`) only. `resolveActiveSessionId` in tim-core gains a `useSessionCache` flag.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk (SSEServerTransport), express, Vitest.

## Global Constraints

- stdio behavior must be byte-identical to today — all changes are gated on `transportMode === 'http'`.
- HTTP mode contract: session/cwd context comes exclusively from tool arguments and `TIM_SESSION_ID`-style env is NOT trusted either (env is daemon-global too). Document this in the tool descriptions touched.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Close per-connection Server instances on SSE disconnect

**Files:**
- Modify: `packages/tim-mcp/src/server.ts:2587-2649` (`createHttpServer`)
- Test: `packages/tim-mcp/src/__tests__/http-sse-lifecycle.test.ts` (new; if an http test already exists, extend it)

**Interfaces:**
- Produces: `createHttpServer` keeps a `Map<string, Server>` keyed by transport sessionId; `res.on('close')` closes and removes the per-connection `Server`; shutdown `close()` iterates the map.

- [ ] **Step 1: Write the failing test**

```typescript
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
```

This requires exposing a counter — add `activeConnections: () => number` to `HttpServerHandle` (returns the map size). That is a public-interface addition; include it in the same commit.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/tim-mcp && npx vitest run src/__tests__/http-sse-lifecycle.test.ts`
Expected: FAIL — `activeConnections` doesn't exist yet; after adding it naively over the array, count stays 2.

- [ ] **Step 3: Implement**

In `createHttpServer`, replace `const mcpServers: Server[] = [];` with `const mcpServers = new Map<string, Server>();` and rework the `/sse` handler:

```typescript
  app.get('/sse', async (_req, res) => {
    try {
      const transport = new SSEServerTransport('/messages', res);
      const mcpServer = await createMcpServer({ transportMode: 'http' });
      transports.set(transport.sessionId, transport);
      mcpServers.set(transport.sessionId, mcpServer);
      res.on('close', () => {
        transports.delete(transport.sessionId);
        mcpServers.delete(transport.sessionId);
        void mcpServer.close().catch(() => {});
      });
      await mcpServer.connect(transport);
    } catch (err) {
      console.error('[tim-mcp] SSE connection error:', err);
      if (!res.headersSent) {
        res.status(500).end('Internal Server Error');
      }
    }
  });
```

(`createMcpServer({ transportMode: 'http' })` lands in Task 2 — for THIS task, call it without arguments and add the option in Task 2; or land Task 2 first if executing in one session. Keep the map-based cleanup regardless.)

Update `close()` to iterate `mcpServers.values()` and then `mcpServers.clear()`. Add to the returned handle:

```typescript
  return { app, httpServer, port: actualPort, close, activeConnections: () => mcpServers.size };
```

and extend the `HttpServerHandle` interface with `activeConnections: () => number;`.

- [ ] **Step 4: Run tests + commit**

Run: `npm run build && cd packages/tim-mcp && npx vitest run`

```bash
git add packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/http-sse-lifecycle.test.ts
git commit -m "fix(tim-mcp): close per-connection Server on SSE disconnect (leak)"
```

---

### Task 2: Per-client session identity in HTTP mode

**Files:**
- Modify: `packages/tim-core/src/session-cache.ts:36-56` (`resolveActiveSessionId`)
- Modify: `packages/tim-mcp/src/server.ts` — `createMcpServer` signature, `tim_load_project` handler (~2387), `tim_session_start` handler (~2213), any other `process.cwd()` / `findMarker` / `syncNearestProjectMarker` call inside the CallTool switch (grep them all)
- Test: `packages/tim-core/src/__tests__/session-cache.test.ts` (extend), `packages/tim-mcp/src/__tests__/http-session-identity.test.ts` (new)

**Interfaces:**
- Consumes: `resolveActiveSessionId(options)` — today falls back to arg → env → global cache file → marker.
- Produces:
  - `resolveActiveSessionId(options & { useSessionCache?: boolean; useEnv?: boolean })` — both default `true`; `false` skips that source.
  - `createMcpServer(options?: { transportMode?: 'stdio' | 'http' })`, default `'stdio'`.
  - HTTP-mode handler behavior: `cwd` is `undefined` unless passed as a tool argument; no marker read/write when `cwd` is undefined; session id resolution uses only the explicit `sessionId` argument.

- [ ] **Step 1: Write the failing tim-core test**

Extend `packages/tim-core/src/__tests__/session-cache.test.ts` (create if missing):

```typescript
it('useSessionCache:false skips the global cache file', () => {
  // Arrange: write a session-cache file the way readTimSessionCache expects
  // (see the fixture helper already used in this test file / the cache-path
  // constant in session-cache.ts) with session_id 'CACHED-1'.
  const resolved = resolveActiveSessionId({ useSessionCache: false, useEnv: false });
  expect(resolved).toBeUndefined();
});

it('explicit arg still wins regardless of flags', () => {
  expect(resolveActiveSessionId({ sessionIdArg: 'ARG-1', useSessionCache: false, useEnv: false }))
    .toBe('ARG-1');
});
```

- [ ] **Step 2: Implement the flags in tim-core**

```typescript
export function resolveActiveSessionId(options: {
  sessionIdArg?: string;
  envSessionId?: string;
  markerSession?: string;
  cacheMaxAgeMs?: number;
  /** Set false in daemon/HTTP contexts — the cache file is per-machine, not per-client. */
  useSessionCache?: boolean;
  /** Set false in daemon/HTTP contexts — env is daemon-global. */
  useEnv?: boolean;
}): string | undefined {
  const fromArg = options.sessionIdArg?.trim();
  if (fromArg) return fromArg;

  if (options.useEnv !== false) {
    const fromEnv =
      options.envSessionId?.trim() || process.env.TIM_SESSION_ID?.trim();
    if (fromEnv) return fromEnv;
  }

  if (options.useSessionCache !== false) {
    const cached = readTimSessionCache(options.cacheMaxAgeMs);
    if (cached?.session_id) return cached.session_id;
  }

  const fromMarker = options.markerSession?.trim();
  if (fromMarker) return fromMarker;

  return undefined;
}
```

Run: `cd packages/tim-core && npx vitest run` — PASS.

- [ ] **Step 3: Thread transportMode through createMcpServer**

In `packages/tim-mcp/src/server.ts`:

```typescript
export async function createMcpServer(
  options: { transportMode?: 'stdio' | 'http' } = {},
): Promise<Server> {
  const isHttp = options.transportMode === 'http';
  // ... existing body ...
```

`startServer` stdio path calls `createMcpServer()` unchanged; `createHttpServer` passes `{ transportMode: 'http' }` (from plan-5 Task 1).

In the `tim_load_project` handler, replace:

```typescript
          const cwd = process.cwd();
          const sessionId = resolveActiveSessionId({
            sessionIdArg: sessionIdArg,
            markerSession: findMarker(cwd, { walkUp: true })?.marker.session,
          });
```

with:

```typescript
          const cwd = isHttp ? undefined : process.cwd();
          const sessionId = resolveActiveSessionId({
            sessionIdArg: sessionIdArg,
            markerSession: cwd
              ? findMarker(cwd, { walkUp: true })?.marker.session
              : undefined,
            useSessionCache: !isHttp,
            useEnv: !isHttp,
          });
```

and guard the marker write:

```typescript
          if (cwd) {
            try {
              syncNearestProjectMarker(cwd, projectLabel, { sessionId });
            } catch {
              // Non-critical — brief still returned
            }
          }
```

The `startProjectSession` block stays gated on `sessionId` (already is) — in HTTP mode without an explicit `sessionId` arg it is simply skipped, which is the correct "read-only briefing" behavior for an unidentified client. When `cwd` is undefined and a session IS started, pass `cwd: ''`.

In the `tim_session_start` handler, replace `const cwdResolved = cwd ?? process.cwd();` with:

```typescript
          const cwdResolved = cwd ?? (isHttp ? '' : process.cwd());
```

Then sweep the rest of the CallTool switch: `grep -n "process.cwd()\|findMarker(\|syncNearestProjectMarker(\|resolveActiveSessionId(" packages/tim-mcp/src/server.ts` — apply the same `isHttp` guards to every hit inside handler code (helper functions used only at startup, like `loadProjectSchema()`, are out of scope here). List every converted site in the task report.

- [ ] **Step 4: Write the failing integration test**

`packages/tim-mcp/src/__tests__/http-session-identity.test.ts` — spin up `createHttpServer` on a temp DB, connect two MCP SSE clients (use `@modelcontextprotocol/sdk` `Client` + `SSEClientTransport`, mirroring how existing tests build stdio clients):

```typescript
it('two HTTP clients loading different projects both succeed and neither writes a marker into the daemon cwd', async () => {
  // create P9001 + P9002 via client A
  // client A: tim_load_project { label: 'P9001' } → ok
  // client B: tim_load_project { label: 'P9002' } → ok (no "already bound" bleed-over)
  // assert !fs.existsSync(path.join(process.cwd(), '.tim-project'))
});
```

Guard the marker assertion by snapshotting `fs.existsSync(process.cwd() + '/.tim-project')` before the test and asserting it unchanged (the repo itself has a marker — assert no NEW marker/mtime change, or run the daemon with `cwd` pointed at a scratch dir via `spawn` if the in-process approach can't isolate cwd; simplest: `process.chdir(scratchDir)` for the test and restore in `afterEach`).

- [ ] **Step 5: Run everything + commit**

Run: `npm run build && npm test`
Expected: PASS; stdio suites untouched.

```bash
git add packages/tim-core/src/session-cache.ts packages/tim-core/src/__tests__/session-cache.test.ts packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/http-session-identity.test.ts
git commit -m "fix(tim-mcp, tim-core): per-client session identity in HTTP mode"
```

---

### Task 3: Document the HTTP-mode contract

**Files:**
- Modify: `docs/tim-capabilities.md` (cross-harness section), `CHANGELOG.md` `[Unreleased]`

- [ ] **Step 1: Write it down**

Add to the capabilities doc: in HTTP/SSE mode, session identity and cwd must be passed explicitly by the client (`tim_session_start(cwd, sessionId)`, `tim_load_project(sessionId)`); daemon-global fallbacks (cache file, env, marker walk-up from daemon cwd) are disabled by design. One `Server` instance per SSE connection, closed on disconnect.

- [ ] **Step 2: Commit**

```bash
git add docs/tim-capabilities.md CHANGELOG.md
git commit -m "docs: HTTP/SSE multi-client contract"
```
