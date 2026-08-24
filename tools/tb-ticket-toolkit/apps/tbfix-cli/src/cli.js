import { execFileSync } from "node:child_process";

import { ToolkitError, redactErrorMessage, redactSecrets } from "../../../packages/tb-domain/src/index.js";
import { bootstrapToolkit } from "../../../packages/tb-application/src/bootstrap.js";
import { inspectOfficialMcpRuntime } from "../../../packages/tb-official-mcp/src/index.js";

export const EXIT_CODES = Object.freeze({
  OK: 0, INVALID_ARGUMENT: 2, INPUT_REQUIRED: 10, AMBIGUOUS_TASK: 11, CONTEXT_INCOMPLETE: 12,
  ATTACHMENT_FAILED: 13, GIT_ISOLATION_FAILED: 14, AUTH_REQUIRED: 20, FORBIDDEN: 21,
  WRITE_DISABLED: 30, CONFLICT: 31, INVALID_TRANSITION: 32, PARTIAL: 33,
  VERIFY_FAILED: 40, INTERNAL_ERROR: 50,
});

function exitForCode(code) {
  if (["NEEDS_ATTACHMENT_SELECTION", "INPUT_REQUIRED"].includes(code)) return EXIT_CODES.INPUT_REQUIRED;
  if (["TASK_REF_AMBIGUOUS", "AMBIGUOUS_TASK"].includes(code)) return EXIT_CODES.AMBIGUOUS_TASK;
  if (["CONTEXT_INCOMPLETE", "PREPARE_REQUIRED", "PREPARE_NOT_READY"].includes(code)) return EXIT_CODES.CONTEXT_INCOMPLETE;
  if (String(code).startsWith("ATTACHMENT_") || code === "LOCAL_FILE_CONFLICT") return EXIT_CODES.ATTACHMENT_FAILED;
  if (String(code).startsWith("GIT_") || String(code).startsWith("TEMP_")) return EXIT_CODES.GIT_ISOLATION_FAILED;
  if (["AUTH_REQUIRED", "OFFICIAL_MCP_AUTH_REQUIRED"].includes(code)) return EXIT_CODES.AUTH_REQUIRED;
  if (code === "FORBIDDEN") return EXIT_CODES.FORBIDDEN;
  if (["WRITE_DISABLED", "PLAN_EXPIRED", "PLAN_TAMPERED"].includes(code)) return EXIT_CODES.WRITE_DISABLED;
  if (["CONFLICT", "CONTEXT_CHANGED", "LOCKED", "LOCK_LOST"].includes(code)) return EXIT_CODES.CONFLICT;
  if (code === "INVALID_TRANSITION" || code === "TRIAGE_STATUS_NOT_FOUND") return EXIT_CODES.INVALID_TRANSITION;
  if (code === "PARTIAL_OPERATION") return EXIT_CODES.PARTIAL;
  if (["EVIDENCE_INSUFFICIENT", "COMMENT_STYLE_REJECTED"].includes(code)) return EXIT_CODES.VERIFY_FAILED;
  if (code === "INVALID_ARGUMENT" || code === "TASK_REF_REQUIRED" || code === "TASK_REF_UNSUPPORTED") return EXIT_CODES.INVALID_ARGUMENT;
  return EXIT_CODES.INTERNAL_ERROR;
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const name = value.slice(2);
    if (["json", "apply"].includes(name)) { flags[name] = true; continue; }
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) throw new ToolkitError("INVALID_ARGUMENT", `--${name} 需要参数`);
    flags[name] = next;
    index += 1;
  }
  return { positionals, flags };
}

function gitValue(repo, args) {
  try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

function usage() {
  return [
    "tbfix doctor | config validate",
    "tbfix ticket prepare <taskRef> --repo <path> [--attachments 1,3|all] [--json]",
    "tbfix workflow get <taskRef> [--repo <path>] [--json]",
    "tbfix update plan <taskRef> --phase triage|resolution --to <status> --reason <text> --measure <text> --evidence-summary <text> [--evidence-result PASS]",
    "tbfix update apply --plan <planId> --fingerprint <fingerprint> --idempotency-key <key> --apply",
    "tbfix operation get <operationId> [--repo <path>] [--json]",
  ].join("\n");
}

function humanPrepare(result) {
  if (result.state !== "NEEDS_ATTACHMENT_SELECTION") return `${result.task.taskNo} 上下文 ${result.state}，已下载 ${result.downloads.length} 个附件。`;
  const lines = [`${result.task.taskNo} 有 ${result.choices.length} 个附件，请选择要下载的编号：`];
  for (const item of result.choices) lines.push(`${item.index}. ${item.name}（${item.source}，${item.size ?? "大小未知"}，${item.mimeType || "类型未知"}）`);
  lines.push(`重新执行：tbfix ticket prepare ${result.task.taskNo} --repo . --attachments 1,3`);
  lines.push(`全部下载：tbfix ticket prepare ${result.task.taskNo} --repo . --attachments all`);
  return lines.join("\n");
}

function printValue(value, { json, stdout }) {
  stdout(json ? `${JSON.stringify(redactSecrets(value))}\n` : `${String(value)}\n`);
}

export async function runCli(argv, {
  env = process.env,
  cwd = process.cwd(),
  stdout = (value) => process.stdout.write(value),
  stderr = (value) => process.stderr.write(value),
  bootstrap = bootstrapToolkit,
} = {}) {
  let runtime = null;
  try {
    const { positionals, flags } = parseArgs(argv);
    const json = flags.json === true;
    const route = positionals.slice(0, 2).join(" ");
    if (positionals[0] === "doctor" || route === "config validate") {
      const profile = env.TB_TOOLKIT_PROFILE === "write" ? "write" : "read";
      const inspected = inspectOfficialMcpRuntime({ profile });
      const required = profile === "write"
        ? ["TB_MCP_APP_ID", "TB_MCP_APP_SECRET", "TB_WEB_COOKIE", "TB_MCP_OPERATOR_ID", "TB_TOOLKIT_WRITE_ALLOWLIST"]
        : ["TB_MCP_APP_ID", "TB_MCP_APP_SECRET", "TB_WEB_COOKIE"];
      const missing = required.filter((name) => !String(env[name] || "").trim());
      const result = {
        ok: inspected.ok && missing.length === 0,
        profile,
        officialMcp: inspected.ok ? `${inspected.registration.packageName}@${inspected.registration.packageVersion}` : "unavailable",
        canonicalMcp: "tb-ticket-mcp",
        missingEnvironmentNames: missing,
        remoteWriteEnabled: profile === "write" && /^(?:1|true)$/i.test(String(env.TB_TOOLKIT_WRITE_ENABLED || "")),
      };
      printValue(json ? result : (result.ok ? "tbfix 配置有效。" : `tbfix 配置不完整：${missing.join(", ") || inspected.problems.join("; ")}`), { json, stdout });
      return result.ok ? EXIT_CODES.OK : EXIT_CODES.AUTH_REQUIRED;
    }
    const repo = String(flags.repo || env.TB_TOOLKIT_REPO || cwd);
    const profile = route === "update apply" ? "write" : (env.TB_TOOLKIT_PROFILE === "write" ? "write" : "read");
    runtime = await bootstrap({ env: { ...env, TB_TOOLKIT_REPO: repo }, repoPath: repo, profile });
    const app = runtime.application;

    if (route === "ticket prepare") {
      const taskRef = positionals[2];
      if (!taskRef) throw new ToolkitError("INVALID_ARGUMENT", "ticket prepare 缺少 taskRef");
      let selection = null;
      const rawSelection = String(flags.attachments || "").trim();
      if (rawSelection === "all") selection = { mode: "all" };
      else if (rawSelection) {
        const indexes = rawSelection.split(",").map((value) => Number(value.trim()));
        if (indexes.some((value) => !Number.isInteger(value) || value < 1) || new Set(indexes).size !== indexes.length) {
          throw new ToolkitError("INVALID_ARGUMENT", "--attachments 必须是唯一正整数编号或 all");
        }
        const { context } = await app.readContext(taskRef);
        const ids = indexes.map((index) => context.attachments[index - 1]?.attachmentId);
        if (ids.some((id) => !id)) throw new ToolkitError("INVALID_ARGUMENT", "--attachments 包含超出清单的编号");
        selection = { mode: "selected", attachmentIds: ids };
      }
      const result = await app.prepare({ taskRef, repoPath: repo, selection });
      printValue(json ? result : humanPrepare(result), { json, stdout });
      return result.state === "NEEDS_ATTACHMENT_SELECTION" ? EXIT_CODES.INPUT_REQUIRED
        : result.state === "READY" ? EXIT_CODES.OK : EXIT_CODES.CONTEXT_INCOMPLETE;
    }

    if (route === "workflow get") {
      const taskRef = positionals[2];
      if (!taskRef) throw new ToolkitError("INVALID_ARGUMENT", "workflow get 缺少 taskRef");
      const result = await app.workflowGet(taskRef);
      printValue(json ? result : `${result.task.taskNo}：${result.currentStatus.displayName || "未知"}；AI甄别=${result.triageStatus.displayName}`, { json, stdout });
      return EXIT_CODES.OK;
    }

    if (route === "update plan") {
      const taskRef = positionals[2];
      const phase = String(flags.phase || "").toUpperCase();
      for (const name of ["to", "reason", "measure", "evidence-summary"]) if (!flags[name]) throw new ToolkitError("INVALID_ARGUMENT", `update plan 缺少 --${name}`);
      const prepared = app.getPreparedContext(taskRef);
      const repoRoot = app.store.gitRoot;
      const result = await app.updatePlan({
        phase,
        taskRef,
        targetStatus: { displayName: flags.to },
        contextDigest: prepared.contextDigest,
        reason: flags.reason,
        measure: flags.measure,
        evidenceRefs: [{
          kind: flags["evidence-kind"] || (phase === "RESOLUTION" ? "integration_test" : "source"),
          result: String(flags["evidence-result"] || (phase === "RESOLUTION" ? "INCOMPLETE" : "OBSERVED")).toUpperCase(),
          ...(flags["evidence-command"] ? { command: flags["evidence-command"] } : {}),
          summary: flags["evidence-summary"],
        }],
        source: {
          repoPath: repoRoot,
          branch: flags.branch || gitValue(repoRoot, ["branch", "--show-current"]),
          commit: flags.commit || gitValue(repoRoot, ["rev-parse", "HEAD"]),
          actor: flags.actor || "tbfix-cli",
        },
        ...(flags["idempotency-key"] ? { idempotencyKey: flags["idempotency-key"] } : {}),
      });
      printValue(json ? result : `计划 ${result.planId}\n指纹 ${result.fingerprint}\n评论 ${result.proposedChanges.comment}`, { json, stdout });
      return EXIT_CODES.OK;
    }

    if (route === "update apply") {
      for (const name of ["plan", "fingerprint", "idempotency-key"]) if (!flags[name]) throw new ToolkitError("INVALID_ARGUMENT", `update apply 缺少 --${name}`);
      const result = await app.updateApply({ planId: flags.plan, fingerprint: flags.fingerprint, idempotencyKey: flags["idempotency-key"], apply: flags.apply === true });
      printValue(json ? result : `操作 ${result.operationId}：${result.state}`, { json, stdout });
      return result.state === "COMPLETED" ? EXIT_CODES.OK : result.state === "PARTIAL" ? EXIT_CODES.PARTIAL : EXIT_CODES.CONFLICT;
    }

    if (route === "operation get") {
      const operationId = positionals[2];
      if (!operationId) throw new ToolkitError("INVALID_ARGUMENT", "operation get 缺少 operationId");
      const result = app.operationGet(operationId);
      printValue(json ? result : `操作 ${result.operationId}：${result.state}；下一步：${result.nextAction}`, { json, stdout });
      return result.state === "PARTIAL" ? EXIT_CODES.PARTIAL : EXIT_CODES.OK;
    }
    throw new ToolkitError("INVALID_ARGUMENT", usage());
  } catch (error) {
    const code = error instanceof ToolkitError ? error.code : "INTERNAL_ERROR";
    const output = { ok: false, error: { code, message: redactErrorMessage(error) } };
    const json = argv.includes("--json");
    if (json) stdout(`${JSON.stringify(output)}\n`);
    else stderr(`${output.error.message}\n`);
    return exitForCode(code);
  } finally {
    if (runtime) await runtime.close().catch(() => {});
  }
}
