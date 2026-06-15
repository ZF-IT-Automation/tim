#!/usr/bin/env python3
"""
migrate_v3_types.py — Bulk-set metadata.type on all TIM entries.

Strategy: derive type from section-name (parent title) using section-to-type
mapping. Idempotent: skip entries that already have metadata.type.

Usage:
  python3 migrate_v3_types.py --dry-run                    # show what would change
  python3 migrate_v3_types.py --limit 50                   # first 50 entries
  python3 migrate_v3_types.py --limit 100
  python3 migrate_v3_types.py --limit 500
  python3 migrate_v3_types.py                              # all entries
  python3 migrate_v3_types.py --verify                     # stats only, no writes
  python3 migrate_v3_types.py --verify --inherit           # section pass + inheritance stats
  python3 migrate_v3_types.py --dry-run --inherit          # show inheritance upgrades
  python3 migrate_v3_types.py --task-subsections           # migrate tags → metadata.task object
  python3 migrate_v3_types.py --task-subsections --verify  # stats only, no writes
  python3 migrate_v3_types.py --rule-subsections           # migrate #rule → metadata.rule object
  python3 migrate_v3_types.py --rule-subsections --verify  # stats only, no writes
  python3 migrate_v3_types.py --bug-subsections            # migrate bug tags → metadata.bug object
  python3 migrate_v3_types.py --bug-subsections --verify   # stats only, no writes
  python3 migrate_v3_types.py --force-rebuild-types        # overwrite existing type (DANGEROUS)

The script is OUTSIDE the tim-mcp TypeScript package because:
  - Python 3 is the standard tool for one-off data migrations
  - Spawned by Workers/overseer via `python3` not via npm script
  - Can use the tim MCP server as a subprocess OR call MCP JSON-RPC over stdio

Implementation: use MCP JSON-RPC over stdio to talk to the tim-mcp server.
The script starts `node packages/tim-mcp/dist/server.js` as a subprocess,
sends JSON-RPC initialize + tools/call requests, walks all entries via
tim_read (JSON) per project, derives type, calls tim_update.

Section-to-type mapping (canonical, must match TIM master spec):
  Tasks     -> task
  Errors    -> error
  Decisions -> decision
  Learnings -> learning
  Log       -> log
  Commits   -> commit
  Summary   -> summary
  Project roots (label=*, kind=project) -> project
  Everything else -> standard

Algorithm:
  1. initialize MCP connection
  2. for each project, call tim_read(project, depth=5) for JSON tree
  3. walk tree, for each entry:
     a. if entry.metadata.type already set (and not --force-rebuild-types): skip
     b. derive type from parent section title (or project root marker)
     c. call tim_update(id=entry.id, metadata={...existing, type: derived_type})
  4. progress: print every 100 entries
  5. exit 0 on success, log to /var/log/tim-migration.log

Output format: a single JSON object per update: {"id": "...", "type": "...", "old_type": null|"..."}.

VERIFY: after run, the script prints a distribution table:
  standard:  N
  task:      N
  ...
  total:     N
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

# ─── Constants ───────────────────────────────────────────────────────────────

DEFAULT_SERVER = (
    Path(__file__).resolve().parent.parent / "dist" / "server.js"
)

SECTION_TO_TYPE: dict[str, str] = {
    "tasks": "task",
    "errors": "error",
    "decisions": "decision",
    "learnings": "learning",
    "ideas": "idea",
    "log": "log",
    "commits": "commit",
    "summary": "summary",
    "rules": "rule",
}

KIND_TO_TYPE: dict[str, str] = {
    "project": "project",
    "session": "session",
    "batch-summary": "batch_summary",
    "exchange": "exchange",
    "checkpoint": "event",
}

BUILTIN_TYPES = frozenset({
    "standard", "project", "task", "error", "decision", "learning", "idea",
    "log", "commit", "summary", "session", "batch_summary", "exchange", "event",
})

STATUS_TAGS = frozenset({"todo", "done", "in_progress", "cancelled"})
BUG_SEVERITIES = frozenset({"P0", "P1", "P2", "P3"})
BUG_STATUS_TAGS = frozenset({"open", "fixed", "wontfix", "in_progress"})

LOG_PATH = "/var/log/tim-migration.log"
MCP_TIMEOUT_SEC = 30.0
MCP_MAX_RETRIES = 3
MCP_RETRY_DELAY_SEC = 0.5


# ─── Logging ─────────────────────────────────────────────────────────────────

def setup_logging() -> logging.Logger:
    logger = logging.getLogger("migrate_v3_types")
    logger.setLevel(logging.DEBUG)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")

    sh = logging.StreamHandler(sys.stderr)
    sh.setLevel(logging.INFO)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    try:
        fh = logging.FileHandler(LOG_PATH, encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    except OSError as exc:
        logger.warning("Cannot open log file %s: %s", LOG_PATH, exc)

    return logger


# ─── MCP stdio client ────────────────────────────────────────────────────────

class McpError(Exception):
    pass


class McpClient:
    """Minimal MCP JSON-RPC client over subprocess stdio (newline-delimited)."""

    def __init__(self, server_path: Path, env: dict[str, str] | None = None) -> None:
        self._server_path = server_path
        self._proc: subprocess.Popen[bytes] | None = None
        self._next_id = 1
        self._buffer = ""
        self._ready = False
        self._env = env

    def start(self) -> None:
        if not self._server_path.is_file():
            raise McpError(f"MCP server not found: {self._server_path} (run npm run build)")
        env = {**os.environ, **(self._env or {})}
        self._proc = subprocess.Popen(
            ["node", str(self._server_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

    def close(self) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
            self._proc.terminate()
            self._proc.wait(timeout=5)
        except (subprocess.TimeoutExpired, OSError):
            if self._proc.poll() is None:
                self._proc.kill()
        self._proc = None
        self._ready = False

    def _read_response(self, req_id: int, timeout: float) -> dict[str, Any]:
        if self._proc is None or self._proc.stdout is None:
            raise McpError("MCP process not started")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                raise McpError("MCP server process exited unexpectedly")
            chunk = self._proc.stdout.read1(4096)
            if chunk:
                self._buffer += chunk.decode("utf-8", errors="replace")
            while "\n" in self._buffer:
                line, self._buffer = self._buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("id") == req_id:
                    return msg
            if not chunk:
                time.sleep(0.01)
        raise McpError(f"Timeout waiting for MCP response id={req_id}")

    def _send(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._proc is None or self._proc.stdin is None:
            raise McpError("MCP process not started")
        req_id = self._next_id
        self._next_id += 1
        frame = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}})
        self._proc.stdin.write((frame + "\n").encode("utf-8"))
        self._proc.stdin.flush()
        return self._read_response(req_id, MCP_TIMEOUT_SEC)

    def _send_with_retry(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        last_err: Exception | None = None
        for attempt in range(1, MCP_MAX_RETRIES + 1):
            try:
                return self._send(method, params)
            except McpError as exc:
                last_err = exc
                if attempt < MCP_MAX_RETRIES:
                    time.sleep(MCP_RETRY_DELAY_SEC * attempt)
        raise McpError(f"MCP {method} failed after {MCP_MAX_RETRIES} retries: {last_err}")

    def initialize(self) -> None:
        if self._ready:
            return
        resp = self._send_with_retry(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "migrate_v3_types", "version": "1.0.0"},
            },
        )
        if "error" in resp:
            raise McpError(f"initialize error: {resp['error']}")
        # MCP initialized notification (no id)
        if self._proc and self._proc.stdin:
            note = json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
            self._proc.stdin.write((note + "\n").encode("utf-8"))
            self._proc.stdin.flush()
        self._ready = True

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        self.initialize()
        resp = self._send_with_retry(
            "tools/call",
            {"name": name, "arguments": arguments or {}},
        )
        if "error" in resp:
            raise McpError(f"tools/call {name} error: {resp['error']}")
        result = resp.get("result", {})
        if result.get("isError"):
            content = result.get("content", [])
            text = content[0].get("text", "") if content else "unknown error"
            raise McpError(f"tools/call {name} tool error: {text}")
        content = result.get("content", [])
        if not content:
            return None
        text = content[0].get("text", "")
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text


# ─── Type derivation ─────────────────────────────────────────────────────────

def derive_type_from_section(section_title: str | None) -> str:
    if not section_title:
        return "standard"
    key = section_title.strip().lower()
    return SECTION_TO_TYPE.get(key, "standard")


def derive_entry_type(entry: dict[str, Any], parent_section: str | None) -> str:
    meta = entry.get("metadata") or {}
    if not isinstance(meta, dict):
        meta = {}
    kind = meta.get("kind")
    if isinstance(kind, str) and kind in KIND_TO_TYPE:
        return KIND_TO_TYPE[kind]
    return derive_type_from_section(parent_section)


def is_section_node(entry: dict[str, Any]) -> bool:
    meta = entry.get("metadata") or {}
    if not isinstance(meta, dict):
        return False
    if meta.get("kind") == "section":
        return True
    title = entry.get("title")
    if isinstance(title, str) and title.strip().lower() in SECTION_TO_TYPE:
        return True
    return False


def section_title_for_children(
    entry: dict[str, Any],
    parent_section: str | None,
    parent_kind: str | None,
) -> str | None:
    if parent_kind == "project":
        title = entry.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()
    if is_section_node(entry):
        title = entry.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()
    return parent_section


def is_project_root(entry: dict[str, Any]) -> bool:
    meta = entry.get("metadata") or {}
    if not isinstance(meta, dict):
        return False
    return meta.get("kind") == "project"


def get_explicit_type(entry: dict[str, Any]) -> str | None:
    meta = entry.get("metadata") or {}
    if not isinstance(meta, dict):
        return None
    t = meta.get("type")
    return t if isinstance(t, str) else None


def inherit_entry_type(
    entry: dict[str, Any],
    parent_map: dict[str, str],
    entries_map: dict[str, dict[str, Any]],
    derived_map: dict[str, str],
) -> str:
    """Walk up parent chain; inherit first non-standard/non-project ancestor type."""
    entry_id = entry.get("id")
    if not isinstance(entry_id, str):
        return "standard"

    current: str | None = parent_map.get(entry_id)
    visited: set[str] = set()

    while current and current not in visited:
        visited.add(current)
        ancestor = entries_map.get(current)
        if ancestor is None:
            break

        if is_project_root(ancestor):
            return "standard"

        explicit = get_explicit_type(ancestor)
        effective = explicit if explicit else derived_map.get(current, "standard")

        if effective not in ("standard", "project"):
            return effective

        current = parent_map.get(current)

    return "standard"


def apply_inheritance_pass(
    all_pairs: list[tuple[dict[str, Any], str]],
    parent_map: dict[str, str],
    entries_map: dict[str, dict[str, Any]],
    logger: logging.Logger,
) -> list[tuple[dict[str, Any], str]]:
    derived_map: dict[str, str] = {}
    for entry, derived in all_pairs:
        eid = entry.get("id")
        if isinstance(eid, str):
            derived_map[eid] = derived

    upgraded = 0
    result: list[tuple[dict[str, Any], str]] = []
    for entry, derived_type in all_pairs:
        if get_explicit_type(entry) is None and derived_type == "standard":
            new_type = inherit_entry_type(entry, parent_map, entries_map, derived_map)
            if new_type != derived_type:
                eid = entry.get("id")
                logger.debug("Inherit %s: standard -> %s", eid, new_type)
                upgraded += 1
                derived_type = new_type
                if isinstance(eid, str):
                    derived_map[eid] = new_type
        result.append((entry, derived_type))

    logger.info("Inheritance pass: %d entries upgraded from standard", upgraded)
    return result


# ─── Tree walk ───────────────────────────────────────────────────────────────

def walk_entries(
    entry: dict[str, Any],
    parent_section: str | None,
    parent_kind: str | None,
    parent_id: str | None,
    out: list[tuple[dict[str, Any], str]],
    parent_map: dict[str, str],
) -> None:
    derived = derive_entry_type(entry, parent_section)
    out.append((entry, derived))
    entry_id = entry.get("id")
    if isinstance(entry_id, str) and parent_id is not None:
        parent_map[entry_id] = parent_id
    meta = entry.get("metadata") or {}
    entry_kind = meta.get("kind") if isinstance(meta, dict) else None
    entry_kind_str = entry_kind if isinstance(entry_kind, str) else None
    child_section = section_title_for_children(entry, parent_section, parent_kind)
    child_parent_id = entry_id if isinstance(entry_id, str) else parent_id
    for child in entry.get("children") or []:
        if isinstance(child, dict):
            walk_entries(child, child_section, entry_kind_str, child_parent_id, out, parent_map)


# ─── Project discovery ───────────────────────────────────────────────────────

def discover_projects(client: McpClient, logger: logging.Logger) -> list[str]:
    """Find project labels via FTS search for kind=project roots."""
    labels: set[str] = set()
    for query in ("P0", "P00", "project"):
        try:
            results = client.call_tool(
                "tim_search",
                {"query": query, "root": "all", "topK": 1000},
            )
        except McpError as exc:
            logger.debug("search %r failed: %s", query, exc)
            continue
        if not isinstance(results, list):
            continue
        for entry in results:
            if not isinstance(entry, dict):
                continue
            meta = entry.get("metadata") or {}
            if isinstance(meta, dict) and meta.get("kind") == "project":
                label = meta.get("label") or entry.get("id")
                if isinstance(label, str) and label:
                    labels.add(label)

    if labels:
        return sorted(labels)

    # Fallback: probe P0000–P0099
    logger.info("FTS discovery empty — probing P0000–P0099")
    for i in range(100):
        label = f"P{i:04d}"
        try:
            data = client.call_tool(
                "tim_read",
                {"project": label, "depth": 1, "includeChildren": False},
            )
        except McpError:
            continue
        if isinstance(data, dict) and data.get("entry"):
            meta = (data["entry"].get("metadata") or {})
            if isinstance(meta, dict) and meta.get("kind") == "project":
                labels.add(label)

    return sorted(labels)


def load_project_tree(client: McpClient, label: str, depth: int = 5) -> dict[str, Any] | None:
    data = client.call_tool(
        "tim_read",
        {"project": label, "depth": depth, "includeChildren": True},
    )
    if not isinstance(data, dict):
        return None
    entry = data.get("entry")
    if not isinstance(entry, dict):
        return None
    return entry


# ─── Migration core ──────────────────────────────────────────────────────────

def merge_metadata(existing: dict[str, Any], new_type: str) -> dict[str, Any]:
    merged = dict(existing)
    merged["type"] = new_type
    return merged


# ─── Task sub-sections (Phase 2a) ────────────────────────────────────────────

def is_task_object(task_val: Any) -> bool:
    return isinstance(task_val, dict) and not isinstance(task_val, bool)


def parse_task_tags(tags: list[Any]) -> dict[str, str]:
    """Parse legacy #todo / #priority-* / #due-YYYY-MM-DD tags into task fields."""
    parsed: dict[str, str] = {}
    for tag in tags:
        if not isinstance(tag, str):
            continue
        cleaned = tag.strip().lstrip("#")
        if cleaned in STATUS_TAGS and "status" not in parsed:
            parsed["status"] = cleaned
        elif cleaned.startswith("priority-") and "priority" not in parsed:
            parsed["priority"] = cleaned[len("priority-") :]
        elif cleaned.startswith("due-") and "due_date" not in parsed:
            parsed["due_date"] = cleaned[len("due-") :]
    return parsed


def build_task_object(
    tags: list[Any],
    meta: dict[str, Any],
) -> dict[str, Any] | None:
    """Build nested metadata.task from tags + flat completion_evidence. None = skip."""
    parsed = parse_task_tags(tags)
    completion_evidence = meta.get("completion_evidence")

    if not parsed and completion_evidence is None:
        return None

    task_obj: dict[str, Any] = {
        "status": parsed.get("status", "todo"),
        "priority": parsed.get("priority", "medium"),
    }
    if "due_date" in parsed:
        task_obj["due_date"] = parsed["due_date"]
    if completion_evidence is not None:
        task_obj["completion_evidence"] = completion_evidence
    return task_obj


def collect_task_entries(
    all_pairs: list[tuple[dict[str, Any], str]],
) -> list[dict[str, Any]]:
    """Filter walked entries to those with metadata.type == task."""
    tasks: list[dict[str, Any]] = []
    for entry, _derived in all_pairs:
        meta = entry.get("metadata") or {}
        if isinstance(meta, dict) and meta.get("type") == "task":
            tasks.append(entry)
    return tasks


def run_task_subsections(args: argparse.Namespace, logger: logging.Logger) -> int:
    server_path = Path(args.server).resolve()
    env: dict[str, str] = {}
    if args.db:
        env["TIM_DB_PATH"] = args.db

    client = McpClient(server_path, env=env)
    client.start()

    total = 0
    updated = 0
    skipped = 0
    errors = 0

    try:
        projects = discover_projects(client, logger)
        logger.info("Discovered %d project(s)", len(projects))

        all_pairs: list[tuple[dict[str, Any], str]] = []
        parent_map: dict[str, str] = {}
        for label in projects:
            tree = load_project_tree(client, label, depth=args.depth)
            if tree is None:
                logger.warning("Could not load project %s", label)
                continue
            walk_entries(tree, None, None, None, all_pairs, parent_map)

        task_entries = collect_task_entries(all_pairs)
        total = len(task_entries)
        logger.info("Found %d task entries (metadata.type=task)", total)

        limit = args.limit if args.limit and args.limit > 0 else None
        processed = 0

        for entry in task_entries:
            if limit is not None and processed >= limit:
                break

            entry_id = entry.get("id")
            if not isinstance(entry_id, str) or not entry_id:
                continue

            meta = entry.get("metadata") or {}
            if not isinstance(meta, dict):
                meta = {}

            tags = entry.get("tags") or []
            if not isinstance(tags, list):
                tags = []

            existing_task = meta.get("task")
            if is_task_object(existing_task):
                record = {
                    "id": entry_id,
                    "tags": tags,
                    "task": existing_task,
                    "status": "skipped",
                }
                print(json.dumps(record))
                skipped += 1
                processed += 1
                continue

            task_obj = build_task_object(tags, meta)
            if task_obj is None:
                record = {
                    "id": entry_id,
                    "tags": tags,
                    "task": None,
                    "status": "skipped",
                }
                print(json.dumps(record))
                skipped += 1
                processed += 1
                continue

            record = {
                "id": entry_id,
                "tags": tags,
                "task": task_obj,
                "status": "updated" if not args.verify else "would_update",
            }

            if args.verify or args.dry_run:
                print(json.dumps(record))
                if not args.verify:
                    updated += 1
                processed += 1
                continue

            new_meta = dict(meta)
            new_meta["task"] = task_obj
            try:
                client.call_tool("tim_update", {"id": entry_id, "metadata": new_meta})
                record["status"] = "updated"
                print(json.dumps(record))
                updated += 1
            except McpError as exc:
                errors += 1
                record["status"] = "error"
                record["error"] = str(exc)
                print(json.dumps(record))
                logger.error("tim_update failed for %s: %s", entry_id, exc)

            processed += 1
            if processed % 100 == 0:
                logger.info("Progress: %d task entries processed", processed)

    finally:
        client.close()

    print(
        f"\n=== Task sub-sections ===\n"
        f"  total: {total}\n"
        f"  updated: {updated}\n"
        f"  skipped: {skipped}\n"
        f"  errors: {errors}",
        file=sys.stderr,
    )
    mode = "verify" if args.verify else ("dry-run" if args.dry_run else "live")
    print(f"  mode: {mode}", file=sys.stderr)

    return 1 if errors > 0 else 0


# ─── Rule sub-sections (Phase 2b) ────────────────────────────────────────────

def is_rule_object(rule_val: Any) -> bool:
    return isinstance(rule_val, dict) and not isinstance(rule_val, bool)


def has_rule_tag(tags: list[Any]) -> bool:
    for tag in tags:
        if not isinstance(tag, str):
            continue
        cleaned = tag.strip().lower().lstrip("#")
        if cleaned == "rule":
            return True
    return False


def parse_rule_content(title: str, content: str) -> dict[str, str]:
    """Parse rule title/content into trigger + action sub-section fields."""
    title = (title or "").strip()
    body = (content or "").strip()

    if not body:
        return {"trigger": "", "action": title}

    sentences = re.split(r"(?<=[.!?])\s+|\n+", body)
    sentences = [s.strip() for s in sentences if s.strip()]

    trigger = ""
    action = body

    for i, sentence in enumerate(sentences):
        lower = sentence.lower()
        if lower.startswith("when ") or lower.startswith("trigger"):
            trigger = sentence
            rest = sentences[i + 1 :]
            action = " ".join(rest).strip() if rest else ""
            break

    return {"trigger": trigger, "action": action}


def build_rule_object(title: str, content: str) -> dict[str, str]:
    return parse_rule_content(title, content)


def collect_rule_entries(
    all_pairs: list[tuple[dict[str, Any], str]],
) -> list[dict[str, Any]]:
    """Filter walked entries to those with #rule tag or metadata.type == rule."""
    rules: list[dict[str, Any]] = []
    for entry, _derived in all_pairs:
        meta = entry.get("metadata") or {}
        tags = entry.get("tags") or []
        if not isinstance(meta, dict):
            meta = {}
        if not isinstance(tags, list):
            tags = []
        if meta.get("type") == "rule" or has_rule_tag(tags):
            rules.append(entry)
    return rules


def run_rule_subsections(args: argparse.Namespace, logger: logging.Logger) -> int:
    server_path = Path(args.server).resolve()
    env: dict[str, str] = {}
    if args.db:
        env["TIM_DB_PATH"] = args.db

    client = McpClient(server_path, env=env)
    client.start()

    total = 0
    updated = 0
    skipped = 0
    errors = 0

    try:
        projects = discover_projects(client, logger)
        logger.info("Discovered %d project(s)", len(projects))

        all_pairs: list[tuple[dict[str, Any], str]] = []
        parent_map: dict[str, str] = {}
        for label in projects:
            tree = load_project_tree(client, label, depth=args.depth)
            if tree is None:
                logger.warning("Could not load project %s", label)
                continue
            walk_entries(tree, None, None, None, all_pairs, parent_map)

        rule_entries = collect_rule_entries(all_pairs)
        total = len(rule_entries)
        logger.info("Found %d rule entries (#rule tag or metadata.type=rule)", total)

        limit = args.limit if args.limit and args.limit > 0 else None
        processed = 0

        for entry in rule_entries:
            if limit is not None and processed >= limit:
                break

            entry_id = entry.get("id")
            if not isinstance(entry_id, str) or not entry_id:
                continue

            meta = entry.get("metadata") or {}
            if not isinstance(meta, dict):
                meta = {}

            tags = entry.get("tags") or []
            if not isinstance(tags, list):
                tags = []

            existing_rule = meta.get("rule")
            if is_rule_object(existing_rule):
                record = {
                    "id": entry_id,
                    "tags": tags,
                    "rule": existing_rule,
                    "status": "skipped",
                }
                print(json.dumps(record))
                skipped += 1
                processed += 1
                continue

            title = entry.get("title") if isinstance(entry.get("title"), str) else ""
            content = entry.get("content") if isinstance(entry.get("content"), str) else ""
            rule_obj = build_rule_object(title, content)

            record = {
                "id": entry_id,
                "tags": tags,
                "rule": rule_obj,
                "status": "updated" if not args.verify else "would_update",
            }

            if args.verify or args.dry_run:
                print(json.dumps(record))
                if not args.verify:
                    updated += 1
                processed += 1
                continue

            new_meta = dict(meta)
            new_meta["rule"] = rule_obj
            try:
                client.call_tool("tim_update", {"id": entry_id, "metadata": new_meta})
                record["status"] = "updated"
                print(json.dumps(record))
                updated += 1
            except McpError as exc:
                errors += 1
                record["status"] = "error"
                record["error"] = str(exc)
                print(json.dumps(record))
                logger.error("tim_update failed for %s: %s", entry_id, exc)

            processed += 1
            if processed % 100 == 0:
                logger.info("Progress: %d rule entries processed", processed)

    finally:
        client.close()

    print(
        f"\n=== Rule sub-sections ===\n"
        f"  total: {total}\n"
        f"  updated: {updated}\n"
        f"  skipped: {skipped}\n"
        f"  errors: {errors}",
        file=sys.stderr,
    )
    mode = "verify" if args.verify else ("dry-run" if args.dry_run else "live")
    print(f"  mode: {mode}", file=sys.stderr)

    return 1 if errors > 0 else 0


# ─── Bug sub-sections (Phase 2c) ─────────────────────────────────────────────

def is_bug_object(bug_val: Any) -> bool:
    return isinstance(bug_val, dict) and not isinstance(bug_val, bool)


def parse_bug_tags(tags: list[Any]) -> dict[str, str]:
    """Parse legacy #priority-P* / #severity-P* / #open|#fixed|#wontfix|#in_progress tags."""
    parsed: dict[str, str] = {}
    for tag in tags:
        if not isinstance(tag, str):
            continue
        cleaned = tag.strip().lstrip("#")
        lower = cleaned.lower()
        if lower in BUG_STATUS_TAGS and "status" not in parsed:
            parsed["status"] = lower
        elif cleaned.startswith("priority-") and "severity" not in parsed:
            sev = cleaned[len("priority-") :].upper()
            if sev in BUG_SEVERITIES:
                parsed["severity"] = sev
        elif cleaned.startswith("severity-") and "severity" not in parsed:
            sev = cleaned[len("severity-") :].upper()
            if sev in BUG_SEVERITIES:
                parsed["severity"] = sev
    return parsed


def build_bug_object(tags: list[Any]) -> dict[str, str]:
    parsed = parse_bug_tags(tags)
    return {
        "severity": parsed.get("severity", "P1"),
        "status": parsed.get("status", "open"),
    }


def collect_bug_entries(
    all_pairs: list[tuple[dict[str, Any], str]],
) -> list[dict[str, Any]]:
    """Filter walked entries to those with metadata.type == bug."""
    bugs: list[dict[str, Any]] = []
    for entry, _derived in all_pairs:
        meta = entry.get("metadata") or {}
        if isinstance(meta, dict) and meta.get("type") == "bug":
            bugs.append(entry)
    return bugs


def run_bug_subsections(args: argparse.Namespace, logger: logging.Logger) -> int:
    server_path = Path(args.server).resolve()
    env: dict[str, str] = {}
    if args.db:
        env["TIM_DB_PATH"] = args.db

    client = McpClient(server_path, env=env)
    client.start()

    total = 0
    updated = 0
    skipped = 0
    errors = 0

    try:
        projects = discover_projects(client, logger)
        logger.info("Discovered %d project(s)", len(projects))

        all_pairs: list[tuple[dict[str, Any], str]] = []
        parent_map: dict[str, str] = {}
        for label in projects:
            tree = load_project_tree(client, label, depth=args.depth)
            if tree is None:
                logger.warning("Could not load project %s", label)
                continue
            walk_entries(tree, None, None, None, all_pairs, parent_map)

        bug_entries = collect_bug_entries(all_pairs)
        total = len(bug_entries)
        logger.info("Found %d bug entries (metadata.type=bug)", total)

        limit = args.limit if args.limit and args.limit > 0 else None
        processed = 0

        for entry in bug_entries:
            if limit is not None and processed >= limit:
                break

            entry_id = entry.get("id")
            if not isinstance(entry_id, str) or not entry_id:
                continue

            meta = entry.get("metadata") or {}
            if not isinstance(meta, dict):
                meta = {}

            tags = entry.get("tags") or []
            if not isinstance(tags, list):
                tags = []

            existing_bug = meta.get("bug")
            if is_bug_object(existing_bug):
                record = {
                    "id": entry_id,
                    "tags": tags,
                    "bug": existing_bug,
                    "status": "skipped",
                }
                print(json.dumps(record))
                skipped += 1
                processed += 1
                continue

            bug_obj = build_bug_object(tags)

            record = {
                "id": entry_id,
                "tags": tags,
                "bug": bug_obj,
                "status": "updated" if not args.verify else "would_update",
            }

            if args.verify or args.dry_run:
                print(json.dumps(record))
                if not args.verify:
                    updated += 1
                processed += 1
                continue

            new_meta = dict(meta)
            new_meta["bug"] = bug_obj
            try:
                client.call_tool("tim_update", {"id": entry_id, "metadata": new_meta})
                record["status"] = "updated"
                print(json.dumps(record))
                updated += 1
            except McpError as exc:
                errors += 1
                record["status"] = "error"
                record["error"] = str(exc)
                print(json.dumps(record))
                logger.error("tim_update failed for %s: %s", entry_id, exc)

            processed += 1
            if processed % 100 == 0:
                logger.info("Progress: %d bug entries processed", processed)

    finally:
        client.close()

    print(
        f"\n=== Bug sub-sections ===\n"
        f"  total: {total}\n"
        f"  updated: {updated}\n"
        f"  skipped: {skipped}\n"
        f"  errors: {errors}",
        file=sys.stderr,
    )
    mode = "verify" if args.verify else ("dry-run" if args.dry_run else "live")
    print(f"  mode: {mode}", file=sys.stderr)

    return 1 if errors > 0 else 0


def run_migration(args: argparse.Namespace, logger: logging.Logger) -> int:
    server_path = Path(args.server).resolve()
    env: dict[str, str] = {}
    if args.db:
        env["TIM_DB_PATH"] = args.db

    client = McpClient(server_path, env=env)
    client.start()

    stats: Counter[str] = Counter()
    processed = 0
    updated = 0
    skipped = 0
    errors = 0

    try:
        projects = discover_projects(client, logger)
        logger.info("Discovered %d project(s)", len(projects))

        all_pairs: list[tuple[dict[str, Any], str]] = []
        parent_map: dict[str, str] = {}
        for label in projects:
            tree = load_project_tree(client, label, depth=args.depth)
            if tree is None:
                logger.warning("Could not load project %s", label)
                continue
            walk_entries(tree, None, None, None, all_pairs, parent_map)

        logger.info("Collected %d entries across projects", len(all_pairs))

        entries_map: dict[str, dict[str, Any]] = {}
        for entry, _ in all_pairs:
            eid = entry.get("id")
            if isinstance(eid, str):
                entries_map[eid] = entry

        if args.inherit:
            all_pairs = apply_inheritance_pass(all_pairs, parent_map, entries_map, logger)

        limit = args.limit if args.limit and args.limit > 0 else None

        for entry, derived_type in all_pairs:
            if limit is not None and processed >= limit:
                break

            entry_id = entry.get("id")
            if not isinstance(entry_id, str) or not entry_id:
                continue

            meta = entry.get("metadata") or {}
            if not isinstance(meta, dict):
                meta = {}

            old_type = meta.get("type")
            old_type_str: str | None = old_type if isinstance(old_type, str) else None

            if old_type_str and not args.force_rebuild_types:
                skipped += 1
                stats[old_type_str] += 1
                processed += 1
                continue

            if derived_type not in BUILTIN_TYPES:
                logger.warning("Invalid derived type %r for %s — using standard", derived_type, entry_id)
                derived_type = "standard"

            processed += 1
            stats[derived_type] += 1

            if args.verify:
                continue

            if old_type_str == derived_type and not args.force_rebuild_types:
                skipped += 1
                continue

            record = {"id": entry_id, "type": derived_type, "old_type": old_type_str}

            if args.dry_run:
                print(json.dumps(record))
                updated += 1
                continue

            new_meta = merge_metadata(meta, derived_type)
            try:
                client.call_tool("tim_update", {"id": entry_id, "metadata": new_meta})
                print(json.dumps(record))
                updated += 1
            except McpError as exc:
                errors += 1
                logger.error("tim_update failed for %s: %s", entry_id, exc)

            if processed % 100 == 0:
                logger.info("Progress: %d entries processed", processed)

    finally:
        client.close()

    print_distribution(stats, processed, updated, skipped, errors, args)
    if errors > 0:
        return 1
    return 0


def print_distribution(
    stats: Counter[str],
    processed: int,
    updated: int,
    skipped: int,
    errors: int,
    args: argparse.Namespace,
) -> None:
    print("\n=== Type distribution ===", file=sys.stderr)
    total = 0
    for t in sorted(BUILTIN_TYPES):
        n = stats.get(t, 0)
        total += n
        print(f"  {t}: {n}", file=sys.stderr)
    # non-builtin keys
    for t, n in sorted(stats.items()):
        if t not in BUILTIN_TYPES:
            total += n
            print(f"  {t}: {n}", file=sys.stderr)
    print(f"  total: {total}", file=sys.stderr)
    mode = "verify" if args.verify else ("dry-run" if args.dry_run else "live")
    print(f"  mode: {mode} | processed: {processed} | updated: {updated} | skipped: {skipped} | errors: {errors}", file=sys.stderr)


# ─── CLI ─────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Bulk-set metadata.type on TIM entries (Schema v3 migration).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--dry-run", action="store_true", help="Show changes without writing")
    p.add_argument("--verify", action="store_true", help="Stats only, no writes")
    p.add_argument("--limit", type=int, default=None, metavar="N", help="Process at most N entries")
    p.add_argument(
        "--force-rebuild-types",
        action="store_true",
        help="Overwrite existing metadata.type (DANGEROUS)",
    )
    p.add_argument(
        "--server",
        type=str,
        default=str(DEFAULT_SERVER),
        help=f"Path to tim-mcp dist/server.js (default: {DEFAULT_SERVER})",
    )
    p.add_argument(
        "--db",
        type=str,
        default=None,
        help="TIM_DB_PATH override (default: ~/.tim/tim.db via server)",
    )
    p.add_argument(
        "--depth",
        type=int,
        default=5,
        help="Tree depth for tim_read per project (default: 5)",
    )
    p.add_argument(
        "--inherit",
        action="store_true",
        default=False,
        help="Second pass: inherit type from typed ancestors for unmapped entries",
    )
    p.add_argument(
        "--task-subsections",
        action="store_true",
        default=False,
        help="Migrate legacy task tags into nested metadata.task object (Phase 2a)",
    )
    p.add_argument(
        "--rule-subsections",
        action="store_true",
        default=False,
        help="Migrate #rule entries into nested metadata.rule object (Phase 2b)",
    )
    p.add_argument(
        "--bug-subsections",
        action="store_true",
        default=False,
        help="Migrate bug entries into nested metadata.bug object (Phase 2c)",
    )
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    logger = setup_logging()

    if args.dry_run and args.verify:
        logger.error("--dry-run and --verify are mutually exclusive")
        return 2

    if args.task_subsections and args.inherit:
        logger.error("--task-subsections and --inherit are mutually exclusive")
        return 2

    if args.rule_subsections and args.inherit:
        logger.error("--rule-subsections and --inherit are mutually exclusive")
        return 2

    if args.task_subsections and args.rule_subsections:
        logger.error("--task-subsections and --rule-subsections are mutually exclusive")
        return 2

    if args.bug_subsections and args.inherit:
        logger.error("--bug-subsections and --inherit are mutually exclusive")
        return 2

    if args.bug_subsections and args.task_subsections:
        logger.error("--bug-subsections and --task-subsections are mutually exclusive")
        return 2

    if args.bug_subsections and args.rule_subsections:
        logger.error("--bug-subsections and --rule-subsections are mutually exclusive")
        return 2

    logger.info(
        "migrate_v3_types start (dry_run=%s verify=%s inherit=%s task_subsections=%s rule_subsections=%s bug_subsections=%s limit=%s force=%s)",
        args.dry_run,
        args.verify,
        args.inherit,
        args.task_subsections,
        args.rule_subsections,
        args.bug_subsections,
        args.limit,
        args.force_rebuild_types,
    )

    try:
        if args.task_subsections:
            return run_task_subsections(args, logger)
        if args.rule_subsections:
            return run_rule_subsections(args, logger)
        if args.bug_subsections:
            return run_bug_subsections(args, logger)
        return run_migration(args, logger)
    except McpError as exc:
        logger.error("Fatal MCP error: %s", exc)
        return 1
    except KeyboardInterrupt:
        logger.info("Interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
