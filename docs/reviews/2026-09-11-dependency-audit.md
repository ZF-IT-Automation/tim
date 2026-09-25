# Dependency audit follow-up

## Evidence and scope

On 2026-09-11, a fresh isolated installation at `435150e` with Node22.23.2 reported **11 affected dependency packages: five moderate, five high and one critical**. These are npm audit package counts, not eleven demonstrated exploits in TIM. No exploit was executed.

`git diff acb738b -- package.json package-lock.json 'packages/*/package.json'` was empty before benchmark integration. The dependency manifests and lockfile were unchanged from the original review baseline; these findings were not introduced by the memory extension source changes. They remain unresolved by the #27–#39 program and must not be hidden behind passing functional tests.

Update 2026-09-25: the embedding package in the first two rows was removed with the local index. This page records the 2026-09-11 audit. A fresh `npm audit` in the worktree that dropped that package reported 0 vulnerabilities.

## Verified package paths

| Installed chain | Audit concern | Observed TIM boundary |
|---|---|---|
| Root `fastembed@2.1.0` → `tar@6.2.1` | Archive extraction advisories, including critical resource exhaustion | The provider downloads a model archive from the fixed Qdrant Google Cloud Storage endpoint and extracts it using `tar.x`. This is a model-download/cache trust boundary, not an observed arbitrary-archive MCP upload endpoint. |
| `tim-hooks` → `fastembed@1.14.4` → `tar@6.2.1` | Same affected archive dependency | Existing second fastembed dependency; both versions must be considered during consolidation. |
| `onnxruntime-node@1.21.0` → `tar@7.5.19` | Later archive parsing advisory | Its installation script fetches ONNX release artifacts and uses `tar.t`. Version7.5.19 fixes the earlier decompression advisory but is still included in a later advisory's affected range. |
| `vitest@3.2.7` → `@vitest/mocker` | Redirect-mock arbitrary file read | Development/test dependency. The routine command here is `vitest run`, not a publicly exposed development server. Reachability of the vulnerable endpoint in a TIM deployment was not established. |

Primary advisories: [tar resource exhaustion](https://github.com/advisories/GHSA-23hp-3jrh-7fpw), [later tar parser recursion](https://github.com/advisories/GHSA-r292-9mhp-454m), and [Vitest redirect mock](https://github.com/advisories/GHSA-82fw-gwwq-j7x9). A trusted download origin reduces the obvious input surface but is not evidence that a vulnerable parser is safe.

The remaining affected packages reported by npm were `@hono/node-server`, `fast-uri`, `hono`, `ip-address`, `nanoid`, `postcss` and `qs`. Their exact vulnerable call paths were not exhaustively traced. Do not equate a transitive advisory with a demonstrated remote exploit, or dismiss it merely because it is transitive.

## Upgrade contract

This needs a separate dependency-maintenance slice, not `npm audit fix --force` folded into feature acceptance. The proposed audit fix includes a major Vitest upgrade and even a fastembed downgrade to1.0.0; neither is an accepted compatibility decision.

Acceptance criteria for that slice:

1. Resolve patch/minor-compatible advisories in an isolated clone and record the resulting package chains.
2. Select a supported embedding/archive dependency strategy covering both fastembed installations and ONNX installation. Verify downloaded-artifact handling with bounded fixtures and the actual provider initialization path.
3. Upgrade the test toolchain deliberately, preserving all current tests, public build entrypoints and Node22 compatibility.
4. Run fresh `npm ci`, type checks, the whole suite, the clean-build pipeline and a new audit. Report every remaining advisory with an explicit exposure assessment and mitigation.
5. Review the dependency diff independently. Do not change a live installation or production database as part of validation.

Until then, this document is an open security follow-up, not a security clearance or a completed fix.
