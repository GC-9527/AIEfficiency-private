import { randomUUID } from "crypto";
import { log, broadcastSubtaskUpdate } from "./logger.js";
import { createTask, updateTask } from "../db/sqlite.js";
import { runTask } from "./agent-runner.js";

/**
 * DAG 调度器：按依赖关系并行/串行执行子任务
 */
export class DAGScheduler {
  /**
   * @param {Array} subtaskDefs - 子任务定义数组 [{ id, title, description, type, engine, dependsOn }]
   * @param {string} parentTaskId - 父任务 ID
   * @param {string} sessionId - 会话 ID
   */
  constructor(subtaskDefs, parentTaskId, sessionId) {
    this.parentTaskId = parentTaskId;
    this.sessionId = sessionId;

    this.aborted = false;
    this.paused = false;       // 失败暂停时为 true，停止调度新任务
    this.supplements = new Map(); // subtaskId → 补充上下文字符串

    // 构建节点图
    this.nodes = new Map();
    for (const def of subtaskDefs) {
      this.nodes.set(def.id, {
        def,
        status: "pending",     // pending | running | completed | failed | paused
        taskId: null,           // 实际创建的任务 ID
        result: null,           // 执行结果
        dependsOn: def.dependsOn || [],
        failureReason: null,    // 失败原因（暂停/重试时显示）
      });
    }
  }

  /**
   * 执行 DAG，返回所有子任务的结果
   * @returns {Promise<Array<{ id, title, status, output }>>}
   */
  execute() {
    return new Promise((resolve, reject) => {
      // 环检测
      const hasCycle = this.detectCycle();
      if (hasCycle) {
        reject(new Error("子任务依赖存在环，无法执行"));
        return;
      }

      this.resolveCallback = resolve;
      this.startReady();
    });
  }

  /**
   * Kahn 算法检测环
   */
  detectCycle() {
    const inDegree = new Map();
    const adjacency = new Map();

    for (const [id, node] of this.nodes) {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    }

    for (const [id, node] of this.nodes) {
      for (const dep of node.dependsOn) {
        if (this.nodes.has(dep)) {
          const list = adjacency.get(dep);
          list.push(id);
          inDegree.set(id, inDegree.get(id) + 1);
        }
      }
    }

    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift();
      visited++;
      for (const next of adjacency.get(id)) {
        const newDeg = inDegree.get(next) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    return visited !== this.nodes.size;
  }

  /**
   * 终止调度器，不再启动新的子任务
   */
  abort() {
    this.aborted = true;
  }

  /**
   * 启动所有依赖已满足的 pending 任务
   * paused 状态下不启动新任务（等待用户处理失败的子任务）
   */
  startReady() {
    if (this.aborted || this.paused) return;
    for (const [id, node] of this.nodes) {
      if (node.status !== "pending") continue;

      // 只有依赖全部 completed 才启动（不再容忍 failed 依赖）
      const allDepsResolved = node.dependsOn.every((depId) => {
        const dep = this.nodes.get(depId);
        return !dep || dep.status === "completed";
      });

      if (allDepsResolved) {
        this.runSubtask(id);
      }
    }
  }

  /**
   * 构建子任务的完整 description（注入依赖结果 + 用户补充）
   */
  buildSubtaskDescription(subtaskId) {
    const node = this.nodes.get(subtaskId);
    let description = node.def.description || "";

    // 1. 注入依赖结果
    if (node.dependsOn.length > 0) {
      let depContext = "\n\n## 前置任务结果\n";
      for (const depId of node.dependsOn) {
        const dep = this.nodes.get(depId);
        if (dep && dep.result) {
          const output = dep.result.output || "(无输出)";
          depContext += `### ${dep.def.title} (${dep.status})\n${output.slice(0, 1500)}\n\n`;
        }
      }
      description += depContext;
    }

    // 2. 注入用户补充上下文
    const supplement = this.supplements.get(subtaskId);
    if (supplement) {
      description += `\n\n## 用户补充信息\n${supplement}\n`;
    }

    return description;
  }

  /**
   * 执行单个子任务
   */
  async runSubtask(subtaskId) {
    if (this.aborted) return;
    const node = this.nodes.get(subtaskId);
    if (!node) return;

    node.status = "running";
    node.failureReason = null;
    const taskId = randomUUID();
    node.taskId = taskId;

    const description = this.buildSubtaskDescription(subtaskId);

    // 创建实际任务
    const task = {
      id: taskId,
      title: node.def.title,
      description,
      type: node.def.type || "general",
      status: "pending",
      priority: 3,
      source: "web",
      sourceId: this.sessionId,
      parentTaskId: this.parentTaskId,
      subtaskId: subtaskId,
      dependsOn: JSON.stringify(node.dependsOn),
      explicitSkill: node.def.skill || null,
      explicitEngine: node.def.engine || null,
    };

    try {
      createTask(task);
    } catch (err) {
      log(this.parentTaskId, "warn", "dag-scheduler", `创建子任务失败: ${err.message}`);
    }

    // 广播子任务状态
    broadcastSubtaskUpdate(this.parentTaskId, this.sessionId, subtaskId, "running", taskId);
    log(this.parentTaskId, "info", "dag-scheduler", `启动子任务 ${subtaskId}: ${node.def.title}`);

    try {
      const result = await runTask(task);
      node.status = "completed";
      node.result = result;
      broadcastSubtaskUpdate(this.parentTaskId, this.sessionId, subtaskId, "completed", taskId);
      log(this.parentTaskId, "info", "dag-scheduler", `子任务完成 ${subtaskId}: ${node.def.title}`);
    } catch (err) {
      // 失败 → 标记为 paused 等待用户介入
      node.status = "paused";
      node.failureReason = err.message;
      node.result = { output: `错误: ${err.message}`, error: err.message };
      this.paused = true; // 暂停整个 DAG
      broadcastSubtaskUpdate(this.parentTaskId, this.sessionId, subtaskId, "paused", taskId, {
        failureReason: err.message,
      });
      log(this.parentTaskId, "warn", "dag-scheduler", `子任务失败暂停 ${subtaskId}: ${err.message}（等待用户补充信息后重试）`);
    }

    this.onSubtaskComplete(subtaskId);
  }

  /**
   * 添加子任务补充上下文（不立即执行）
   * 已有补充内容时追加
   */
  addSupplement(subtaskId, supplement) {
    const node = this.nodes.get(subtaskId);
    if (!node) return false;
    const existing = this.supplements.get(subtaskId) || "";
    const merged = existing ? `${existing}\n${supplement}` : supplement;
    this.supplements.set(subtaskId, merged);
    log(this.parentTaskId, "info", "dag-scheduler", `子任务 ${subtaskId} 补充信息已记录 (${supplement.length} 字符)`);
    return true;
  }

  /**
   * 重试失败/暂停的子任务（可选携带新的补充信息）
   * 重试成功后自动恢复 DAG 调度
   */
  async retrySubtask(subtaskId, supplement) {
    const node = this.nodes.get(subtaskId);
    if (!node) return { success: false, error: "子任务不存在" };
    if (node.status !== "paused" && node.status !== "failed") {
      return { success: false, error: `当前状态 ${node.status}，无法重试` };
    }

    if (supplement) {
      this.addSupplement(subtaskId, supplement);
    }

    log(this.parentTaskId, "info", "dag-scheduler", `重试子任务 ${subtaskId}${supplement ? "（含补充信息）" : ""}`);

    // 重新执行（runSubtask 会重置状态、构建新 description）
    node.status = "pending";
    this.paused = false; // 解除 DAG 暂停
    await this.runSubtask(subtaskId);

    return { success: true, status: node.status };
  }

  /**
   * 子任务完成回调
   */
  onSubtaskComplete(subtaskId) {
    // 暂停状态：不结束 DAG，也不启动新任务，等待用户介入
    if (this.paused) {
      log(this.parentTaskId, "info", "dag-scheduler", "DAG 已暂停，等待用户处理失败的子任务");
      return;
    }

    // 检查是否所有子任务都完成（仅 completed 计入完成；paused 视为未完成）
    const allDone = Array.from(this.nodes.values()).every(
      (n) => n.status === "completed" || n.status === "failed"
    );

    if (allDone) {
      // 收集所有结果
      const results = Array.from(this.nodes.entries()).map(([id, node]) => ({
        id,
        title: node.def.title,
        status: node.status,
        output: node.result?.output || node.result?.report || "",
        taskId: node.taskId,
      }));
      this.resolveCallback(results);
    } else {
      // 启动后续就绪的任务
      this.startReady();
    }
  }
}
