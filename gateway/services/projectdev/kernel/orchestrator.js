/**
 * 里程碑编排主循环 —— 无人值守、可断点续跑、外部自验收。
 *
 * 零业务依赖：业务全在 spec（vision + 里程碑 prompt + 验收检查）。对照 autorunv2.py。
 * 通过 hooks 把流式事件 / 控制信号 接到外部（WS、DB、UI）；不接也能独立 CLI 跑。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { StateManager } from "./state-manager.js";
import { runClaude } from "./claude-runner.js";
import { checkAll } from "./acceptance.js";

const sleep = (ms, signal) => new Promise((r) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true });
});

const nowIso = () => new Date().toISOString();

/**
 * @param {object} p
 *  - spec       见 design §2.1
 *  - stateDir   状态/日志落点（含 run-state.json）
 *  - hooks      {
 *       onEvent(evt),                  // 统一事件出口：milestone_start/turn/stream/acceptance/cost/needs_human/done/log
 *       isStopRequested(): bool,       // 外部请求停止（落盘后安全退出，可续跑）
 *       isPauseRequested(): bool,      // 外部请求暂停
 *       waitApproval(milestoneId): Promise // gating=per_milestone 时等人审批
 *     }
 *  - signal     AbortSignal（硬停）
 * @returns {Promise<{status, state}>}
 */
export async function runOrchestrator({ spec, stateDir, hooks = {}, signal }) {
  const emit = (evt) => { try { hooks.onEvent?.({ ts: nowIso(), ...evt }); } catch {} };
  const stopRequested = () => signal?.aborted || hooks.isStopRequested?.();

  const sm = new StateManager(stateDir);
  sm.init(spec.specId, nowIso());
  sm.setStatus("running");
  emit({ type: "run_start", specId: spec.specId, projectDir: spec.projectDir });

  const projectDir = spec.projectDir;
  const costCap = spec.sessionCostCapUsd ?? 300;
  const cooldown = (spec.cooldownSeconds ?? 3) * 1000;
  let cliSessionId = sm.get("cliSessionId") || null;

  for (const ms of spec.milestones) {
    const cur = sm.getMilestone(ms.id);
    if (cur && cur.status === "completed") continue;

    if (stopRequested()) { sm.setStatus("paused"); emit({ type: "paused", at: ms.id }); return done(sm, emit); }

    sm.set("currentMilestone", ms.id);
    sm.setMilestone(ms.id, { status: "running", startedAt: cur?.startedAt || nowIso() });
    emit({ type: "milestone_start", id: ms.id, title: ms.title });

    // 早退优化：验收已全过则直接完成（省钱，续跑时常见）
    let acc = checkAll(ms.acceptance, projectDir);
    if (acc.pass && (ms.acceptance || []).length) {
      sm.setMilestone(ms.id, { status: "completed", finishedAt: nowIso() });
      emit({ type: "acceptance", id: ms.id, pass: true, results: acc.results, note: "进入时已满足" });
      emit({ type: "milestone_done", id: ms.id });
      if (spec.gating === "per_milestone") await gate(hooks, ms.id, sm, emit, stopRequested);
      continue;
    }

    // script 类里程碑：跑脚本，不烧 token
    if (ms.kind === "script") {
      const r = spawnSync(ms.script, { cwd: projectDir, shell: true, encoding: "utf8", timeout: (ms.scriptTimeoutSec || 1800) * 1000, maxBuffer: 32 * 1024 * 1024 });
      emit({ type: "log", level: "info", message: `[script ${ms.id}] rc=${r.status}\n${(r.stdout || "") + (r.stderr || "")}`.slice(0, 4000) });
      acc = checkAll(ms.acceptance, projectDir);
      if (acc.pass) { sm.setMilestone(ms.id, { status: "completed", finishedAt: nowIso() }); emit({ type: "acceptance", id: ms.id, pass: true, results: acc.results }); emit({ type: "milestone_done", id: ms.id }); }
      else { sm.requestHuman(`脚本里程碑 ${ms.id} 验收未过`, ["改脚本重试", "跳过", "终止"], nowIso()); emit({ type: "needs_human", id: ms.id, reason: "script 验收未过", failures: acc.failures }); return done(sm, emit); }
      continue;
    }

    // claude 类里程碑：逐轮驱动到验收通过或触顶
    const maxTurns = ms.maxTurns ?? 60;
    const maxCost = ms.maxCostUsd ?? 50;
    let lastFailure = cur?.lastFailure || "";
    let lastDiffHash = cur?.lastDiffHash || "";

    while (true) {
      if (stopRequested()) { sm.setStatus("paused"); emit({ type: "paused", at: ms.id }); return done(sm, emit); }
      if (hooks.isPauseRequested?.()) { await sleep(1500, signal); continue; }

      const m = sm.getMilestone(ms.id);
      if (sm.get("sessionCostUsd") >= costCap) { sm.requestHuman(`会话成本达上限 $${costCap}`, ["提高预算继续", "终止"], nowIso()); emit({ type: "needs_human", id: ms.id, reason: "session cost cap" }); return done(sm, emit); }
      if (m.costUsd >= maxCost) { sm.requestHuman(`里程碑 ${ms.id} 成本达上限 $${maxCost}`, ["提高里程碑预算", "跳过", "终止"], nowIso()); emit({ type: "needs_human", id: ms.id, reason: "milestone cost cap" }); return done(sm, emit); }
      if (m.turns >= maxTurns) { sm.requestHuman(`里程碑 ${ms.id} 轮数达上限 ${maxTurns}`, ["提高轮数上限", "跳过", "终止"], nowIso()); emit({ type: "needs_human", id: ms.id, reason: "milestone turn cap" }); return done(sm, emit); }

      const prompt = buildPrompt(spec, ms, lastFailure, sm.snapshot());
      emit({ type: "turn", id: ms.id, attempt: (m.attempts || 0) + 1 });

      const run = await runClaude({
        cwd: projectDir, prompt, engine: spec.engine || "claude", cliSessionId,
        maxTurns: ms.perCallMaxTurns, allowedTools: spec.allowedTools,
        // 流式子事件包成 {type:"stream", streamType:'thinking'|'text'|'tool_use'|'usage'|'log', ...}
        // 注意：必须把 e.type 重命名为 streamType，否则展开会覆盖外层 type:"stream"。
        onEvent: (e) => { const { type: st, ...rest } = e; emit({ type: "stream", streamType: st, id: ms.id, ...rest }); },
        signal,
      });
      cliSessionId = run.sessionId || cliSessionId;
      sm.set("cliSessionId", cliSessionId);

      // 累计成本 / 轮数 / 产出
      sm.addCost(run.costUsd);
      const turns = (m.turns || 0) + Math.max(1, run.turns || 1);
      const attempts = (m.attempts || 0) + 1;
      sm.setMilestone(ms.id, { turns, attempts, costUsd: +(m.costUsd + run.costUsd).toFixed(6) });
      sm.bumpUnproductive(run.writesOrEdits > 0);
      emit({ type: "cost", id: ms.id, turnCostUsd: run.costUsd, sessionCostUsd: sm.get("sessionCostUsd"), writes: run.writesOrEdits });

      // 限流：睡到重置（可中断）后原样重试本轮
      if (run.rateLimited) {
        const waitMs = run.rateLimitResetAt ? Math.max(0, run.rateLimitResetAt * 1000 - Date.now()) : 60_000;
        emit({ type: "log", level: "warn", message: `限流，等待 ${Math.round(waitMs / 1000)}s 后重试 ${ms.id}` });
        await sleep(Math.min(waitMs + 2000, 6 * 3600 * 1000), signal);
        continue;
      }
      // 临时过载：退避重试
      if (run.transientOverload) { emit({ type: "log", level: "warn", message: "API 529 过载，退避 30s" }); await sleep(30_000, signal); continue; }

      // 跑外部验收
      acc = checkAll(ms.acceptance, projectDir);
      emit({ type: "acceptance", id: ms.id, pass: acc.pass, results: acc.results });
      if (acc.pass) { sm.setMilestone(ms.id, { status: "completed", finishedAt: nowIso(), lastFailure: "" }); emit({ type: "milestone_done", id: ms.id }); break; }

      // 失败：循环检测（同样的失败 + 同样的工作区 diff → 升级人工，防烧钱空转）
      const failSig = acc.failures.map((f) => `${f.check.type}:${(f.output || "").slice(0, 200)}`).join("|");
      const diffHash = workspaceDiffHash(projectDir);
      if (failSig && failSig === lastFailure && diffHash === lastDiffHash) {
        sm.setMilestone(ms.id, { status: "needs_human", lastFailure: failSig, lastDiffHash: diffHash });
        sm.requestHuman(`里程碑 ${ms.id} 连续两轮相同失败、工作区无变化（疑似死循环）`, ["人工介入后继续", "跳过", "终止"], nowIso());
        emit({ type: "needs_human", id: ms.id, reason: "stuck loop", failures: acc.failures });
        return done(sm, emit);
      }
      lastFailure = failSig; lastDiffHash = diffHash;
      sm.setMilestone(ms.id, { lastFailure: failSig, lastDiffHash: diffHash });
      await sleep(cooldown, signal);
    }

    if (spec.gating === "per_milestone") {
      const cont = await gate(hooks, ms.id, sm, emit, stopRequested);
      if (!cont) return done(sm, emit);
    }
    await sleep(cooldown, signal);
  }

  sm.setStatus("completed");
  emit({ type: "run_done", status: "completed" });
  return done(sm, emit);
}

function done(sm, emit) {
  emit({ type: "run_exit", status: sm.get("status") });
  return { status: sm.get("status"), state: sm.snapshot() };
}

async function gate(hooks, id, sm, emit, stopRequested) {
  sm.setStatus("paused");
  emit({ type: "await_approval", id });
  if (hooks.waitApproval) {
    const ok = await hooks.waitApproval(id);
    if (!ok || stopRequested()) { emit({ type: "paused", at: id }); return false; }
  }
  sm.setStatus("running");
  return true;
}

/** 组装本轮 prompt：愿景前言 + 里程碑指令 + 上轮失败反馈 + 验收清单（让 AI 知道达标标准）。 */
function buildPrompt(spec, ms, lastFailure, state) {
  const lines = [];
  lines.push("# 项目愿景（贯穿全程）");
  lines.push(spec.vision || "(未提供)");
  lines.push("");
  lines.push(`# 当前里程碑 ${ms.id}：${ms.title}`);
  lines.push(ms.prompt || "");
  lines.push("");
  lines.push("# 本里程碑的验收标准（系统会用外部命令/检查实测，请确保全部满足）");
  for (const a of ms.acceptance || []) {
    if (a.type === "cmd") lines.push(`- 命令必须成功(退出码${a.expectRc ?? 0})：\`${a.cmd}\``);
    else if (a.type === "file_exists") lines.push(`- 必须存在文件：\`${a.path}\``);
    else if (a.type === "grep_count") lines.push(`- \`${a.path}\` 中 /${a.pattern}/ 命中 ${a.min ?? 1}~${a.max ?? "∞"} 次`);
    else if (a.type === "json_schema") lines.push(`- \`${a.path}\` 必须满足 JSON schema \`${typeof a.schema === "string" ? a.schema : "(内联)"}\``);
  }
  if (lastFailure) {
    lines.push("");
    lines.push("# 上一轮验收失败（请针对性修复，不要重复同样的改动）");
    lines.push("```");
    lines.push(lastFailure.slice(0, 3000));
    lines.push("```");
  }
  lines.push("");
  lines.push(`# 说明`);
  lines.push("- 你在目标工程目录内工作，直接读写真实文件。");
  lines.push("- 完成本里程碑即可，无需解释，重点是让上面验收全部通过。");
  return lines.join("\n");
}

/** 工作区指纹：git 有则用 `git status --porcelain` + 暂存 diff 摘要，无 git 则退化为 0。用于死循环检测。 */
function workspaceDiffHash(projectDir) {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf8", timeout: 10000 });
    const d = spawnSync("git", ["diff", "--stat"], { cwd: projectDir, encoding: "utf8", timeout: 10000 });
    const txt = (r.stdout || "") + "\n" + (d.stdout || "");
    return createHash("sha1").update(txt).digest("hex").slice(0, 16);
  } catch { return ""; }
}
