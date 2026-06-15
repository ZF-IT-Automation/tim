#!/usr/bin/env python3
"""
cleanup_deprecated_tags.py — Remove deprecated status/priority tags from TIM entries.

Deprecated tags (exact match only):
  #todo, #done, #in_progress, #cancelled, #blocked
  #priority-critical, #priority-high, #priority-medium, #priority-low, #priority-mixed
  #due-YYYY-MM-DD (regex: ^#due-\\d{4}-\\d{2}-\\d{2}$)

Usage:
  python3 cleanup_deprecated_tags.py              # dry-run (default)
  python3 cleanup_deprecated_tags.py --live       # apply updates
  python3 cleanup_deprecated_tags.py --limit 50 # cap entries processed
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

DEFAULT_DB = Path.home() / ".tim" / "tim.db"
BATCH_SIZE = 100
BATCH_SLEEP_SEC = 0.5

DEPRECATED_EXACT = frozenset({
    "#todo",
    "#done",
    "#in_progress",
    "#cancelled",
    "#blocked",
    "#priority-critical",
    "#priority-high",
    "#priority-medium",
    "#priority-low",
    "#priority-mixed",
})

DUE_TAG_RE = re.compile(r"^#due-\d{4}-\d{2}-\d{2}$")


def is_deprecated_tag(tag: str) -> bool:
    if not isinstance(tag, str):
        return False
    if tag in DEPRECATED_EXACT:
        return True
    return bool(DUE_TAG_RE.match(tag))


def filter_tags(tags: list) -> tuple[list, int]:
    """Return (filtered_tags, removed_count)."""
    if not isinstance(tags, list):
        return [], 0
    kept: list = []
    removed = 0
    for tag in tags:
        if is_deprecated_tag(tag):
            removed += 1
        else:
            kept.append(tag)
    return kept, removed


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Remove deprecated status/priority tags from TIM entries.",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Apply updates (default: dry-run only)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Report changes without writing (default)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Max entries to process",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        help=f"Path to tim.db (default: {DEFAULT_DB})",
    )
    args = parser.parse_args()

    dry_run = not args.live
    db_path = args.db.expanduser().resolve()

    if not db_path.is_file():
        print(f"ERROR: database not found: {db_path}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    try:
        query = """
            SELECT id, tags
            FROM entries
            WHERE tags IS NOT NULL AND tags != '' AND tags != '[]'
            ORDER BY id
        """
        if args.limit is not None:
            query += f" LIMIT {int(args.limit)}"

        rows = conn.execute(query).fetchall()

        total_checked = len(rows)
        changed = 0
        tags_removed = 0
        batch_count = 0

        mode = "DRY-RUN" if dry_run else "LIVE"
        print(f"Mode: {mode} | DB: {db_path} | entries with tags: {total_checked}")

        for row in rows:
            entry_id = row["id"]
            raw_tags = row["tags"]

            try:
                tags = json.loads(raw_tags)
            except json.JSONDecodeError:
                print(f"WARN: skip {entry_id} — invalid JSON tags: {raw_tags!r}")
                continue

            if not isinstance(tags, list) or len(tags) == 0:
                continue

            filtered, removed = filter_tags(tags)
            if removed == 0:
                continue

            changed += 1
            tags_removed += removed

            if dry_run:
                print(f"  would update {entry_id}: remove {removed} tag(s) "
                      f"({len(tags)} -> {len(filtered)})")
            else:
                conn.execute(
                    "UPDATE entries SET tags = ? WHERE id = ?",
                    (json.dumps(filtered, ensure_ascii=False), entry_id),
                )

            batch_count += 1
            if batch_count % BATCH_SIZE == 0:
                if not dry_run:
                    conn.commit()
                print(f"  ... processed {batch_count} changed entries "
                      f"({tags_removed} tags removed so far)")
                time.sleep(BATCH_SLEEP_SEC)

        if not dry_run:
            conn.commit()

        print()
        print("Stats:")
        print(f"  total checked:  {total_checked}")
        print(f"  changed:        {changed}")
        print(f"  tags removed:   {tags_removed}")
        if dry_run:
            print("  (dry-run — no writes; use --live to apply)")

    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
