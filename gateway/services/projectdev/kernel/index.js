/**
 * 项目开发编排内核 —— 公共导出。
 *
 * 零业务依赖、可整 kernel/ 目录拷到任何 Node 项目。移植只需：拷目录 + 写一份 spec.json。
 * 详见 README.md / docs/devProject/step0/design_projectdev.md。
 */
export { StateManager } from "./state-manager.js";
export { runClaude } from "./claude-runner.js";
export { checkOne, checkAll } from "./acceptance.js";
export { runOrchestrator } from "./orchestrator.js";

/** 轻量校验 spec 的必填项，返回错误数组（空=通过）。 */
export function validateSpec(spec) {
  const errs = [];
  if (!spec || typeof spec !== "object") return ["spec 必须是对象"];
  if (!spec.specId) errs.push("缺少 specId");
  if (!spec.projectDir) errs.push("缺少 projectDir（目标工程目录）");
  if (!spec.vision) errs.push("缺少 vision（项目愿景）");
  if (!Array.isArray(spec.milestones) || !spec.milestones.length) errs.push("milestones 至少 1 个");
  (spec.milestones || []).forEach((m, i) => {
    if (!m.id) errs.push(`milestones[${i}] 缺少 id`);
    if (!m.title) errs.push(`milestones[${i}] 缺少 title`);
    if ((m.kind || "claude") === "claude" && !m.prompt) errs.push(`milestones[${i}] 缺少 prompt`);
    if ((m.kind || "claude") === "script" && !m.script) errs.push(`milestones[${i}] kind=script 但缺少 script`);
  });
  return errs;
}
