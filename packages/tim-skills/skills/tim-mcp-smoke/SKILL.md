---
name: tim-mcp-smoke
description: Smoke-test that a host can see and use TIM MCP tools safely.
---

# tim-mcp-smoke

Use after installing TIM MCP in Claude/Cursor/Hermes/Codex.

Smoke:
1. Start host or server.
2. Call MCP `tools/list`; confirm TIM tools appear.
3. Call `tim_doctor` and inspect DB path.
4. Call `tim_stats` read-only.
5. Optional write test only with user consent:
   `tim_write({ content:"MCP smoke test", tags:["#smoke"], metadata:{kind:"test"} })`
   then `tim_delete({ id, hard:true })`.

Pass criteria:
- no JSON-RPC errors
- `tim_doctor` returns health text
- write/delete roundtrip leaves no test entry

Report host, DB path, tool count, and any missing tools.
