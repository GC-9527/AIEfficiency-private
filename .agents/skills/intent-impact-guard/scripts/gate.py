#!/usr/bin/env python3
"""Deterministic PREWRITE/POSTWRITE gate for intent-impact decision records."""
from __future__ import annotations

import argparse
import fnmatch
import json
import shutil
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POLICY = SKILL_ROOT / "assets" / "policy.default.json"
DEFAULT_TEMPLATE = SKILL_ROOT / "assets" / "decision-record.template.json"


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError(f"file not found: {path}") from None
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON {path}: {exc}") from None
    if not isinstance(value, dict):
        raise ValueError(f"root must be an object: {path}")
    return value


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def matches_budget(path: str, patterns: list[str]) -> bool:
    normalized = path.replace("\\", "/").lstrip("./")
    for pattern in patterns:
        pat = str(pattern).replace("\\", "/").lstrip("./")
        if normalized == pat or fnmatch.fnmatch(normalized, pat):
            return True
        if pat.endswith("/") and normalized.startswith(pat):
            return True
    return False


def validate_common(record: dict[str, Any], policy: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if record.get("schema_version") != policy.get("schema_version"):
        errors.append("schema_version does not match policy")
    if not nonempty(record.get("task_id")):
        errors.append("task_id is required")

    request = record.get("request")
    if not isinstance(request, dict):
        errors.append("request object is required")
        request = {}
    if not nonempty(request.get("problem_signal")):
        errors.append("request.problem_signal is required")
    if not nonempty(request.get("business_goal")):
        errors.append("request.business_goal is required")
    if not isinstance(request.get("non_goals", []), list):
        errors.append("request.non_goals must be a list")

    decision = record.get("decision")
    if not isinstance(decision, dict):
        errors.append("decision object is required")
        decision = {}

    risk = decision.get("risk")
    if risk not in policy.get("risk_levels", []):
        errors.append(f"decision.risk must be one of {policy.get('risk_levels')}")
    permission = decision.get("permission")
    if permission not in policy.get("permissions", []):
        errors.append(f"decision.permission must be one of {policy.get('permissions')}")

    evidence = record.get("evidence")
    if not isinstance(evidence, list):
        errors.append("evidence must be a list")
        evidence = []
    verified = 0
    for i, item in enumerate(evidence):
        if not isinstance(item, dict):
            errors.append(f"evidence[{i}] must be an object")
            continue
        if item.get("status") == "VERIFIED":
            verified += 1
        if item.get("status") not in {"VERIFIED", "INFERRED", "UNKNOWN"}:
            errors.append(f"evidence[{i}].status is invalid")
        if not nonempty(item.get("finding")):
            errors.append(f"evidence[{i}].finding is required")
        if item.get("status") == "VERIFIED" and not nonempty(item.get("path")):
            errors.append(f"evidence[{i}].path is required for VERIFIED evidence")

    minimum = policy.get("minimum_verified_evidence", {}).get(risk, 1)
    if verified < minimum:
        errors.append(f"risk {risk} requires at least {minimum} VERIFIED evidence items; got {verified}")

    invariants = record.get("invariants")
    if policy.get("require_invariants") and not isinstance(invariants, list):
        errors.append("invariants must be a list")
        invariants = []
    if policy.get("require_invariants") and not invariants:
        errors.append("at least one invariant is required")
    for i, item in enumerate(invariants or []):
        if not isinstance(item, dict) or not nonempty(item.get("statement")):
            errors.append(f"invariants[{i}].statement is required")
        if isinstance(item, dict) and not nonempty(item.get("verification")):
            errors.append(f"invariants[{i}].verification is required")

    options = record.get("options")
    if not isinstance(options, list):
        errors.append("options must be a list")
        options = []
    if len(options) < int(policy.get("minimum_options", 2)):
        errors.append(f"at least {policy.get('minimum_options', 2)} options are required")
    option_ids: list[str] = []
    for i, option in enumerate(options):
        if not isinstance(option, dict):
            errors.append(f"options[{i}] must be an object")
            continue
        oid = option.get("id")
        if not nonempty(oid):
            errors.append(f"options[{i}].id is required")
        else:
            option_ids.append(oid)
        if option.get("risk") not in policy.get("risk_levels", []):
            errors.append(f"options[{i}].risk is invalid")
        if not isinstance(option.get("reversible"), bool):
            errors.append(f"options[{i}].reversible must be boolean")
        if not nonempty(option.get("summary")):
            errors.append(f"options[{i}].summary is required")
    if len(set(option_ids)) != len(option_ids):
        errors.append("option ids must be unique")

    selected_id = decision.get("selected_option_id")
    selected = next((o for o in options if isinstance(o, dict) and o.get("id") == selected_id), None)
    if not selected:
        errors.append("decision.selected_option_id must reference an existing option")
    if not nonempty(decision.get("reason")):
        errors.append("decision.reason is required")

    authorization = bool(decision.get("explicit_authorization"))
    if risk in {"HIGH", "CRITICAL"} and policy.get("high_risk_requires_explicit_authorization") and not authorization:
        errors.append(f"{risk} risk requires explicit_authorization=true")
    if permission == "EXTERNAL_WRITE" and policy.get("external_write_requires_explicit_authorization") and not authorization:
        errors.append("EXTERNAL_WRITE requires explicit authorization")
    if permission == "DESTRUCTIVE" and policy.get("destructive_requires_explicit_authorization") and not authorization:
        errors.append("DESTRUCTIVE requires explicit authorization")
    if selected and selected.get("reversible") is False and not authorization:
        errors.append("an irreversible selected option requires explicit authorization")

    budget = record.get("change_budget")
    if policy.get("require_change_budget") and not isinstance(budget, dict):
        errors.append("change_budget object is required")
        budget = {}
    allowed_files = budget.get("allowed_files", []) if isinstance(budget, dict) else []
    allowed_modules = budget.get("allowed_modules", []) if isinstance(budget, dict) else []
    if not isinstance(allowed_files, list) or not isinstance(allowed_modules, list):
        errors.append("change_budget.allowed_files/allowed_modules must be lists")
    if permission != "READ_ONLY" and not allowed_files and not allowed_modules:
        errors.append("write permission requires allowed_files or allowed_modules")
    max_files = budget.get("max_files", 0) if isinstance(budget, dict) else 0
    if permission != "READ_ONLY" and (not isinstance(max_files, int) or max_files < 1):
        errors.append("write permission requires change_budget.max_files >= 1")

    forbidden = record.get("forbidden_outcomes_detected")
    if not isinstance(forbidden, list):
        errors.append("forbidden_outcomes_detected must be a list")
    elif policy.get("forbidden_outcomes_must_be_empty") and forbidden:
        errors.append("forbidden_outcomes_detected must be empty before write")

    if request.get("explicit_solution") and request.get("explicit_solution") == request.get("problem_signal"):
        warnings.append("explicit_solution equals problem_signal; verify that a symptom was not mistaken for a solution")

    return errors, warnings


def validate_prewrite(record: dict[str, Any], policy: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors, warnings = validate_common(record, policy)
    decision = record.get("decision", {})
    status = decision.get("status")
    if status not in {"READY", "BLOCKED_NEEDS_DECISION"}:
        errors.append("decision.status must be READY or BLOCKED_NEEDS_DECISION")
    if status == "BLOCKED_NEEDS_DECISION":
        errors.append("record is intentionally blocked; no file writes are allowed")
    verification = record.get("verification", {})
    planned = verification.get("planned", []) if isinstance(verification, dict) else []
    if not isinstance(planned, list) or not planned:
        errors.append("verification.planned must contain at least one check")
    return errors, warnings


def validate_postwrite(record: dict[str, Any], policy: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors, warnings = validate_common(record, policy)
    decision = record.get("decision", {})
    if decision.get("status") not in {"READY", "IMPLEMENTED", "VERIFIED"}:
        errors.append("postwrite requires decision.status READY, IMPLEMENTED, or VERIFIED")

    actual = record.get("actual")
    if not isinstance(actual, dict):
        errors.append("actual object is required")
        actual = {}
    changed = actual.get("changed_files", [])
    if not isinstance(changed, list):
        errors.append("actual.changed_files must be a list")
        changed = []
    permission = decision.get("permission")
    if permission != "READ_ONLY" and not changed:
        errors.append("postwrite for a write task requires actual.changed_files")

    budget = record.get("change_budget", {})
    allowed = list(budget.get("allowed_files", [])) + [str(x).rstrip("/") + "/**" for x in budget.get("allowed_modules", [])]
    expansion = bool(budget.get("scope_expansion_approved"))
    if policy.get("postwrite_scope_must_match_budget") and not expansion:
        outside = [path for path in changed if not matches_budget(str(path), allowed)]
        if outside:
            errors.append(f"changed files outside approved budget: {outside}")
    max_files = budget.get("max_files", 0)
    if isinstance(max_files, int) and max_files > 0 and len(changed) > max_files and not expansion:
        errors.append(f"changed file count {len(changed)} exceeds max_files {max_files}")

    invariants = record.get("invariants", [])
    for i, item in enumerate(invariants if isinstance(invariants, list) else []):
        result = item.get("result") if isinstance(item, dict) else None
        if result not in {"PASS", "NOT_APPLICABLE"}:
            errors.append(f"invariants[{i}].result must be PASS or NOT_APPLICABLE after write")

    verification = record.get("verification")
    if not isinstance(verification, dict):
        errors.append("verification object is required")
        verification = {}
    executed = verification.get("executed", [])
    if policy.get("require_target_verification") and (not isinstance(executed, list) or not executed):
        errors.append("verification.executed must contain real results")
    for i, item in enumerate(executed if isinstance(executed, list) else []):
        if not isinstance(item, dict):
            errors.append(f"verification.executed[{i}] must be an object")
            continue
        if item.get("status") not in {"PASS", "NOT_RUN", "NOT_APPLICABLE"}:
            errors.append(f"verification.executed[{i}].status must be PASS/NOT_RUN/NOT_APPLICABLE")
        if item.get("status") == "NOT_RUN" and not nonempty(item.get("reason")):
            errors.append(f"verification.executed[{i}] NOT_RUN requires reason")
        if item.get("status") == "PASS" and not nonempty(item.get("evidence")):
            errors.append(f"verification.executed[{i}] PASS requires evidence")
    if verification.get("status") not in {"PASS", "PARTIAL", "FAIL"}:
        errors.append("verification.status must be PASS/PARTIAL/FAIL after write")
    if record.get("result") not in {"PASS", "PARTIAL", "FAIL", "BLOCKED"}:
        errors.append("result must be PASS/PARTIAL/FAIL/BLOCKED after write")
    if record.get("result") == "PASS" and verification.get("status") != "PASS":
        errors.append("result PASS requires verification.status PASS")
    return errors, warnings


def cmd_init(output: Path, task_id: str | None) -> int:
    if output.exists():
        print(f"ERROR: output already exists: {output}", file=sys.stderr)
        return 1
    output.parent.mkdir(parents=True, exist_ok=True)
    data = load_json(DEFAULT_TEMPLATE)
    data["task_id"] = task_id or f"IIG-{uuid.uuid4().hex[:8]}"
    data["created_at"] = datetime.now(timezone.utc).isoformat()
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(output)
    return 0


def cmd_check(record_path: Path, policy_path: Path, phase: str, as_json: bool) -> int:
    try:
        record = load_json(record_path)
        policy = load_json(policy_path)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if phase == "prewrite":
        errors, warnings = validate_prewrite(record, policy)
    else:
        errors, warnings = validate_postwrite(record, policy)

    result = {
        "ok": not errors,
        "phase": phase.upper(),
        "record": str(record_path),
        "task_id": record.get("task_id"),
        "errors": errors,
        "warnings": warnings,
        "decision_status": record.get("decision", {}).get("status"),
        "risk": record.get("decision", {}).get("risk"),
        "permission": record.get("decision", {}).get("permission"),
    }
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{'PASS' if result['ok'] else 'FAIL'} {phase.upper()} — {record.get('task_id', '<missing>')}")
        for warning in warnings:
            print(f"WARN: {warning}")
        for error in errors:
            print(f"ERROR: {error}")
    return 0 if result["ok"] else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    init_p = sub.add_parser("init", help="Create a decision record from the template")
    init_p.add_argument("--output", type=Path, required=True)
    init_p.add_argument("--task-id")

    check_p = sub.add_parser("check", help="Validate a decision record")
    check_p.add_argument("record", type=Path)
    check_p.add_argument("--phase", choices=["prewrite", "postwrite"], required=True)
    check_p.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    check_p.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command == "init":
        return cmd_init(args.output, args.task_id)
    return cmd_check(args.record, args.policy, args.phase, args.json)


if __name__ == "__main__":
    sys.exit(main())
