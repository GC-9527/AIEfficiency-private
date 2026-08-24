#!/usr/bin/env python3
"""Static validator for the intent-impact-guard package. Uses only stdlib."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
REQUIRED = [
    "SKILL.md",
    "agents/openai.yaml",
    "references/decision-protocol.md",
    "references/risk-permission-model.md",
    "references/invariants-catalog.md",
    "references/evidence-verification.md",
    "references/domains/fullstack-web.md",
    "references/domains/android-kmp.md",
    "references/domains/sdk-governance.md",
    "references/domains/multi-agent.md",
    "references/examples.md",
    "references/evaluation-rubric.md",
    "assets/policy.default.json",
    "assets/decision-record.template.json",
    "assets/handoff.template.json",
    "scripts/gate.py",
    "scripts/run_self_test.py",
    "tests/fixtures/prewrite-pass-login.json",
    "tests/fixtures/prewrite-fail-repurpose-admin.json",
    "tests/fixtures/postwrite-pass-login.json",
]


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        raise ValueError("SKILL.md must start with YAML frontmatter")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise ValueError("SKILL.md frontmatter is not closed")
    front = text[4:end]
    body = text[end + 5 :]
    data: dict[str, str] = {}
    for line in front.splitlines():
        if not line or line[0].isspace() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data, body


def estimate_tokens(text: str) -> int:
    # Conservative mixed Chinese/English estimate: CJK roughly 1 token/char,
    # Latin prose/code roughly 1 token/4 chars.
    cjk = sum(1 for ch in text if "\u3400" <= ch <= "\u9fff")
    other = max(0, len(text) - cjk)
    return cjk + (other + 3) // 4


def validate(skill_root: Path) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    skill_md = skill_root / "SKILL.md"
    if not skill_md.is_file():
        return {"ok": False, "errors": [f"Missing {skill_md}"], "warnings": []}

    text = skill_md.read_text(encoding="utf-8")
    try:
        front, body = parse_frontmatter(text)
    except ValueError as exc:
        return {"ok": False, "errors": [str(exc)], "warnings": []}

    name = front.get("name", "")
    description = front.get("description", "")
    if not name:
        errors.append("frontmatter.name is required")
    elif not NAME_RE.fullmatch(name):
        errors.append("frontmatter.name must be lowercase kebab-case")
    if name and skill_root.name != name:
        errors.append(f"directory name '{skill_root.name}' must equal skill name '{name}'")
    if not 1 <= len(description) <= 1024:
        errors.append(f"description length must be 1..1024, got {len(description)}")
    if "Do not use" not in description:
        warnings.append("description should state a non-trigger boundary")

    token_estimate = estimate_tokens(body)
    if token_estimate > 5000:
        errors.append(f"SKILL.md body estimated at {token_estimate} tokens; keep under 5000")
    elif token_estimate > 4200:
        warnings.append(f"SKILL.md body estimated at {token_estimate} tokens; near 5000-token ceiling")

    for rel in REQUIRED:
        if not (skill_root / rel).is_file():
            errors.append(f"missing required file: {rel}")

    for json_path in sorted(skill_root.rglob("*.json")):
        try:
            json.loads(json_path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"invalid JSON {json_path.relative_to(skill_root)}: {exc}")

    for ref in sorted(set(re.findall(r"`((?:references|assets)/[^`]+)`", body))):
        if not (skill_root / ref).is_file():
            errors.append(f"SKILL.md references missing file: {ref}")

    forbidden_placeholders = ["TODO", "TBD", "FIXME", "<fill-me>"]
    for path in skill_root.rglob("*"):
        if path.resolve() == Path(__file__).resolve():
            continue
        if not path.is_file() or path.suffix.lower() in {".png", ".jpg", ".zip"}:
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for marker in forbidden_placeholders:
            if marker in content:
                warnings.append(f"placeholder '{marker}' found in {path.relative_to(skill_root)}")

    duplicate_skills = [p for p in skill_root.rglob("SKILL.md") if p != skill_md]
    if duplicate_skills:
        errors.append("canonical directory contains nested duplicate SKILL.md files")

    return {
        "ok": not errors,
        "skill_root": str(skill_root),
        "name": name,
        "description_chars": len(description),
        "body_chars": len(body),
        "estimated_body_tokens": token_estimate,
        "files": sum(1 for p in skill_root.rglob("*") if p.is_file()),
        "errors": errors,
        "warnings": sorted(set(warnings)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--skill-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Path containing SKILL.md",
    )
    args = parser.parse_args()
    result = validate(args.skill_root.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
