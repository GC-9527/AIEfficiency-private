#!/usr/bin/env node
/**
 * 独立 CLI 入口 —— 不依赖 gateway，可在任何项目里无人值守跑（等价参考工程的 autoRun.bat）。
 *
 *   node cli.js --spec spec.json [--state-dir runtime] [--print-events]
 *
 * 创建 STOP 文件（<state-dir>/STOP）可优雅停止；状态在 <state-dir>/run-state.json，删它=从头跑。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runOrchestrator, validateSpec } from "./index.js";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

async function main() {
  const specPath = arg("--spec");
  if (!specPath || !existsSync(specPath)) { console.error("用法: node cli.js --spec spec.json [--state-dir runtime]"); process.exit(2); }
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const errs = validateSpec(spec);
  if (errs.length) { console.error("spec 校验失败:\n" + errs.map((e) => " - " + e).join("\n")); process.exit(2); }

  const stateDir = path.resolve(arg("--state-dir", path.join(path.dirname(specPath), "runtime")));
  const stopFile = path.join(stateDir, "STOP");
  const printEvents = process.argv.includes("--print-events");

  const r = await runOrchestrator({
    spec, stateDir,
    hooks: {
      isStopRequested: () => existsSync(stopFile),
      onEvent: (evt) => {
        if (printEvents) console.log(JSON.stringify(evt));
        else if (["milestone_start", "milestone_done", "acceptance", "needs_human", "cost", "run_done", "run_exit"].includes(evt.type)) {
          const tag = evt.type.toUpperCase();
          console.log(`[${tag}] ${evt.id || ""} ${evt.title || evt.reason || evt.status || (evt.pass != null ? "pass=" + evt.pass : "") || ""} ${evt.sessionCostUsd != null ? "$" + evt.sessionCostUsd : ""}`.trim());
        }
      },
    },
  });
  console.log(`\n=== 结束: ${r.status} ===`);
  process.exit(r.status === "completed" ? 0 : r.status === "needs_human" ? 3 : 99);
}

main().catch((e) => { console.error(e); process.exit(1); });
