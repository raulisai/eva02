#!/usr/bin/env python3
"""Append a mandatory compact seed update for eva-project-seed."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path


def require_text(value: str, name: str) -> str:
    text = " ".join(value.split())
    if not text:
        raise SystemExit(f"--{name} is required and cannot be empty")
    if text.lower() in {"none", "n/a", "na", "nothing"}:
        raise SystemExit(f"--{name} must be actionable; do not write '{value}'")
    return text


def main() -> int:
    parser = argparse.ArgumentParser(description="Append EVA seed change + pending note.")
    parser.add_argument("--change", required=True, help="Compact change summary.")
    parser.add_argument("--pending", required=True, help="Mandatory pending/improvement/risk/test-gap note.")
    parser.add_argument("--files", default="unspecified", help="Comma-separated touched files.")
    parser.add_argument("--tests", default="not run", help="Verification command or reason not run.")
    args = parser.parse_args()

    change = require_text(args.change, "change")
    pending = require_text(args.pending, "pending")
    files = " ".join(args.files.split()) or "unspecified"
    tests = " ".join(args.tests.split()) or "not run"

    skill_dir = Path(__file__).resolve().parents[1]
    log_path = skill_dir / "references" / "change-log.md"
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%MZ")
    entry = (
        f"\n### {stamp}\n"
        f"C: {change}; files={files}; tests={tests}\n"
        f"P: pending/improve -> {pending}\n"
    )
    existing = log_path.read_text(encoding="utf-8")
    first_entry = existing.find("\n### ")
    if first_entry == -1:
        updated = existing.rstrip() + entry + "\n"
    else:
        updated = existing[:first_entry] + entry + existing[first_entry:]
    log_path.write_text(updated, encoding="utf-8")

    print(f"updated {log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
