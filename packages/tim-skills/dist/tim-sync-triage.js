"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIM_SYNC_TRIAGE_SKILL = void 0;
exports.TIM_SYNC_TRIAGE_SKILL = {
    name: 'tim-sync-triage',
    description: 'Diagnose TIM sync problems in safe read-first order.',
    content: `# tim-sync-triage

Use when TIM sync looks stuck or divergent.

Read-only first:
1. \`tim sync status\`
2. MCP \`tim_sync({ action:"status" })\`
3. Check \`TIM_SYNC_PASSPHRASE\` exists, but never print it.
4. \`tim doctor\`; record broken links/orphans separately from sync.

Safe retry:
- Pull before push if the user expects remote changes.
- Push only after status + passphrase are sane.
- If queue/backoff is stuck, restart client process before changing data.

Escalate:
- auth/passphrase mismatch
- repeated LWW conflicts
- remote returns quota/tenant errors
- secret sync placeholder echoes

Handoff: local DB path, server URL, last pull/push result, remaining queue count.
`,
};
//# sourceMappingURL=tim-sync-triage.js.map