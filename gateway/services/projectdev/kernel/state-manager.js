/**
 * 状态管理器 —— 编排运行状态的原子持久化（可断点续跑）。
 *
 * 无业务依赖：只认 run-state.json 的通用结构（见 design_projectdev.md §2.2）。
 * 原子写：同目录 tmp 文件 + rename，避免半截写坏导致续跑失败。
 * 移植对照：Python state_manager.py 的 StateManager（snapshot/get/set/mark_*）。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

const STATE_FILE = "run-state.json";

export class StateManager {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, STATE_FILE);
    mkdirSync(stateDir, { recursive: true });
    this.state = this._load();
  }

  _load() {
    if (existsSync(this.file)) {
      try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { /* 坏档则重建 */ }
    }
    return null;
  }

  /** 首次创建（已有状态则保留，用于续跑）。 */
  init(specId, nowIso) {
    if (this.state && this.state.specId === specId) return this.state;
    this.state = {
      specId,
      status: "running",
      startedAt: nowIso,
      updatedAt: nowIso,
      sessionCostUsd: 0,
      currentMilestone: null,
      milestones: {},
      needsHuman: null,
      unproductiveStreak: 0,
    };
    this._flush();
    return this.state;
  }

  exists() { return !!this.state; }
  snapshot() { return JSON.parse(JSON.stringify(this.state)); }
  get(key, dflt = null) { return this.state && key in this.state ? this.state[key] : dflt; }

  set(key, value) {
    this.state[key] = value;
    this._flush();
  }

  /** 合并更新里程碑子状态。 */
  setMilestone(id, patch) {
    const m = this.state.milestones[id] || {
      status: "pending", attempts: 0, costUsd: 0, turns: 0,
      lastFailure: "", lastDiffHash: "", startedAt: "", finishedAt: "",
    };
    this.state.milestones[id] = { ...m, ...patch };
    this._flush();
    return this.state.milestones[id];
  }

  getMilestone(id) { return this.state.milestones[id] || null; }

  /** 累加会话成本，返回新总计。 */
  addCost(usd) {
    this.state.sessionCostUsd = +(this.state.sessionCostUsd + (usd || 0)).toFixed(6);
    this._flush();
    return this.state.sessionCostUsd;
  }

  /** 无产出连击计数（断路器用）。writes>0 时清零。 */
  bumpUnproductive(reset) {
    this.state.unproductiveStreak = reset ? 0 : (this.state.unproductiveStreak || 0) + 1;
    this._flush();
    return this.state.unproductiveStreak;
  }

  /** 挂起等人：不是崩溃，是把决策权交回人。 */
  requestHuman(reason, options, nowIso) {
    this.state.status = "needs_human";
    this.state.needsHuman = { reason, options: options || [], raisedAt: nowIso };
    this._flush();
  }

  clearHuman() {
    this.state.needsHuman = null;
    if (this.state.status === "needs_human") this.state.status = "running";
    this._flush();
  }

  setStatus(status) { this.set("status", status); }

  _flush() {
    this.state.updatedAt = new Date().toISOString();
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, this.file); // 原子替换
  }
}
