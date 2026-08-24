#!/usr/bin/env python3
"""Run package self-tests without third-party dependencies."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
TESTS = SKILL_ROOT / "tests" / "fixtures"
PYTHON = sys.executable


def run(name: str, command: list[str], expected: int) -> dict:
    proc = subprocess.run(command, text=True, capture_output=True, check=False)
    ok = proc.returncode == expected
    return {
        "name": name,
        "ok": ok,
        "expected_exit": expected,
        "actual_exit": proc.returncode,
        "stdout": proc.stdout.strip(),
        "stderr": proc.stderr.strip(),
    }


def main() -> int:
    tests = [
        run("skill-structure", [PYTHON, str(SKILL_ROOT / "scripts" / "validate_skill.py")], 0),
        run("prewrite-pass-login", [PYTHON, str(SKILL_ROOT / "scripts" / "gate.py"), "check", str(TESTS / "prewrite-pass-login.json"), "--phase", "prewrite"], 0),
        run("prewrite-fail-repurpose-admin", [PYTHON, str(SKILL_ROOT / "scripts" / "gate.py"), "check", str(TESTS / "prewrite-fail-repurpose-admin.json"), "--phase", "prewrite"], 1),
        run("postwrite-pass-login", [PYTHON, str(SKILL_ROOT / "scripts" / "gate.py"), "check", str(TESTS / "postwrite-pass-login.json"), "--phase", "postwrite"], 0),
    ]
    result = {"ok": all(t["ok"] for t in tests), "tests": tests}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
