# MCP tool inventory

Counted 2026-09-25. Proposals only — this change removes `tim_read_project` and leaves every other tool registered.

Method: Claude Code transcripts under `~/.claude/projects/*/*.jsonl` with mtime in the 30 days before 2026-09-25 (7507 files, oldest 29.0 days; 99 files contained a TIM call); a call is a `tool_use` block whose `name` starts with `mcp__tim__tim_`, and an error is the matching `tool_result` with `is_error: true` (507 calls, 19 errors).
Telemetry column is empty: `recordRead` stores entry ids in device-local `entry_usage`, not tool names, and `~/.tim/logs` (`jev.log`, snapshot cron/prune) plus `remember.log` do not record MCP tool calls.
CLI `node packages/tim-cli/dist/cli.js doctor` has no per-tool error breakdown and there is no `error-stats` command; the 24h window was 1222 errors (1217 idle-sweep skips, 5 sessions with no `.tim-project` marker), so the errors column is transcript `is_error` only. Zeros mean "not seen in Claude Code", not "unused" — Cursor and Hermes transcripts were outside this count.

Proposed core (10), from what agents actually called plus the one recall path that is not already `tim_search`: `tim_load_project`, `tim_read`, `tim_search`, `tim_write`, `tim_update`, `tim_show`, `tim_preview_briefing`, `tim_resume_topic`, `tim_delete`, `tim_doctor`.

Of the six recall paths, only `tim_search` (51) and `tim_resume_topic` (3) were called. `tim_remember`, `tim_resume_list`, `tim_session_resume`, and `tim_trace` were 0.

| tool | calls (transcripts) | calls (telemetry) | errors | overlaps-with | proposal |
| --- | ---: | --- | ---: | --- | --- |
| `tim_read` | 50 | — | 1 | `tim_search` (excerpt vs full body), `tim_section_children` | keep core |
| `tim_write` | 148 | — | 8 | `tim_write_many`, `tim_update` (edit vs create) | keep core |
| `tim_write_many` | 5 | — | 0 | `tim_write` | merge into `tim_write` |
| `tim_search` | 51 | — | 1 | `tim_remember`, `tim_resume_topic`, `tim_show` | keep core |
| `tim_guard` | 0 | — | 0 | `tim_hook_prompt_submit` (hook already runs the check) | merge into `tim_hook_prompt_submit` |
| `tim_delta` | 0 | — | 0 | `tim_preview_briefing`, `tim_load_project` | merge into `tim_preview_briefing` |
| `tim_link` | 0 | — | 0 | `tim_unlink`, `tim_trace` | keep (not core) |
| `tim_unlink` | 0 | — | 0 | `tim_link` | keep (not core) |
| `tim_trace` | 0 | — | 0 | `tim_read` (edges on the entry) | move to CLI |
| `tim_update` | 166 | — | 8 | `tim_write`, `tim_tag_add`, `tim_verify`, `tim_update_many` | keep core |
| `tim_verify` | 1 | — | 0 | `tim_update` (stamp vs content edit) | keep (not core) |
| `tim_delete` | 2 | — | 0 | `tim_delete_batch` | keep core |
| `tim_delete_batch` | 0 | — | 0 | `tim_delete` | merge into `tim_delete` |
| `tim_sync` | 0 | — | 0 | `tim sync` CLI | move to CLI |
| `tim_suppress` | 0 | — | 0 | filters on `tim_search` / `tim_read` | keep (not core) |
| `tim_health` | 5 | — | 0 | `tim_doctor` | move to CLI |
| `tim_stats` | 0 | — | 0 | `tim stats` CLI | move to CLI |
| `tim_section_children` | 0 | — | 0 | `tim_read`, `tim_show` | merge into `tim_read` |
| `tim_export` | 0 | — | 0 | `tim export` CLI | move to CLI |
| `tim_import` | 0 | — | 0 | `tim import` CLI, `tim_import_manifest` | move to CLI |
| `tim_import_manifest` | 0 | — | 0 | `tim_import` | move to CLI |
| `tim_project_structure` | 1 | — | 0 | `tim_load_project` tree | move to CLI |
| `tim_find_duplicates` | 0 | — | 0 | `tim consolidate` CLI | move to CLI |
| `tim_import_audit` | 0 | — | 0 | `tim_import` | move to CLI |
| `tim_dry_run_move` | 0 | — | 0 | `tim_move_entry` | merge into `tim_move_entry` |
| `tim_repair_section` | 0 | — | 0 | `tim_move_entry` | move to CLI |
| `tim_doctor` | 7 | — | 0 | `tim_health`, `tim_error_stats`, `tim doctor` CLI | keep core |
| `tim_session_start` | 0 | — | 0 | `tim_load_project` (bind starts a project session), `tim hook session-start` | move to CLI |
| `tim_resume_list` | 0 | — | 0 | `tim_session_resume` | merge into `tim_session_resume` |
| `tim_resume_topic` | 3 | — | 0 | `tim_search`, `tim_preview_briefing` | keep core |
| `tim_preview_briefing` | 15 | — | 0 | `tim_load_project`, `tim_delta` | keep core |
| `tim_session_resume` | 0 | — | 0 | `tim_resume_list`, `tim_resume_topic` | keep (not core) |
| `tim_session_log` (internal) | 0 | — | 0 | `tim hook log` | keep registered (internal; not core) |
| `tim_show_unsummarized` (internal) | 0 | — | 0 | summarizer CLI | keep registered (internal; not core) |
| `tim_show_all_unsummarized` (internal) | 0 | — | 0 | `tim_show_unsummarized` | keep registered (internal; not core) |
| `tim_show_untagged` (internal) | 0 | — | 0 | summarizer retag | keep registered (internal; not core) |
| `tim_write_batch_summary` (internal) | 0 | — | 0 | summarizer CLI | keep registered (internal; not core) |
| `tim_rollup_session_summary` (internal) | 0 | — | 0 | summarizer CLI | keep registered (internal; not core) |
| `tim_record_commit` | 2 | — | 0 | `tim record-commit` CLI | move to CLI |
| `tim_checkpoint` | 0 | — | 0 | `tim checkpoint` CLI | move to CLI |
| `tim_hook_prompt_submit` (internal) | 0 | — | 0 | `tim_guard`, `tim_search` | keep registered (internal; not core) |
| `tim_rename_entry` | 0 | — | 0 | `tim_update` (title only; this one rewrites the id) | move to CLI |
| `tim_move_entry` | 3 | — | 0 | `tim_dry_run_move` | keep (not core) |
| `tim_update_many` | 0 | — | 0 | `tim_update` (flags only) | merge into `tim_update` |
| `tim_tag_add` | 0 | — | 0 | `tim_update` / `tim_write` tags | merge into `tim_update` |
| `tim_tag_remove` | 0 | — | 0 | `tim_tag_add` | merge into `tim_update` |
| `tim_tag_rename` | 0 | — | 0 | `tim_tag_add` | move to CLI |
| `tim_create_project` | 0 | — | 0 | `tim new-project` CLI | move to CLI |
| `tim_load_project` | 31 | — | 0 | former `tim_read_project` (`bind:false`), `tim_preview_briefing` | keep core |
| `tim_show` | 11 | — | 0 | `tim_search`, `tim_section_children` | keep core |
| `tim_task_order` | 0 | — | 0 | `tim_update` (order field) | merge into `tim_update` |
| `tim_error_stats` | 3 | — | 0 | `tim doctor` (24h totals only) | move to CLI |
| `tim_error_log` (internal) | 0 | — | 0 | `ErrorLogger` used by the server itself | keep registered (internal; not core) |
| `tim_remember` | 0 | — | 0 | `tim_search` | drop from the default tool list |
| `tim_read_project` (removed) | 3 | — | 1 | `tim_load_project` `bind:false` | drop (done) |

Transcript error samples (first distinct messages): `tim_write` rejected a string `tags` and a missing parent section; `tim_update` refused closing a bug as `fixed` without `metadata.bug.commit`; `tim_search` hit `vtable constructor failed: fts_entries`; `tim_read` was called with none of `id`, `project`, `section`; `tim_read_project` was called with `project` instead of `label` (the 2026-09-22 misuse shape).
