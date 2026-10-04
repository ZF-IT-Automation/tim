# History rewrite 2026-10-04

On 2026-10-04 the repository history was rewritten with `git filter-repo` to drop
`node_modules/`, `packages/*/node_modules/` and `local_cache/` (an 86 MB ONNX model)
that early commits had included. A full clone went from 112 MiB to about 5 MiB. No file
in the current tree changed; every commit except the root got a new hash.

[`2026-10-04-commit-map.tsv`](2026-10-04-commit-map.tsv) maps each old commit hash to
its new one (856 rows). Use it to follow references in issues, pull requests, TIM
entries or notes written before the rewrite. Commit messages and the docs in this tree
were already updated to the new hashes.

Existing clones must be re-cloned (or `git fetch && git reset --hard origin/<branch>`
per branch, after saving local work). Pull-request refs on GitHub still point at the old
commits.
