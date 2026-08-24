/**
 * devbench 配置记忆与推理（启发式）。
 * - 记忆：每次成功解决问题（FIX_DONE）时，把〔TB信号(标题/项目/迭代/标签/识别车型应用)〕→〔工程配置
 *   (主工程/分支/flavor车型/关联工程)〕沉淀到记忆库（store，按 TB 项目隔离、团队共享、可移植字段）。
 * - 推理：新建故事点时按相似度对记忆库打分，给出最可能的工程配置建议（用户确认即应用）。
 */
import * as store from "./store.js";
import { log } from "../logger.js";

const norm = (p) => String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
const same = (a, b) => norm(a) === norm(b);

// 从标题抽取关键词：【北汽】这类括号词 + 英文/型号词（YouTube、N5、E22H 等）
export function tokenizeTitle(title) {
  const s = String(title || "");
  const out = new Set();
  for (const m of s.matchAll(/【([^】]+)】/g)) out.add(m[1].trim());
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9.\-]{1,}/g)) out.add(m[0]);
  return [...out].filter(Boolean).slice(0, 24);
}

// 成功收尾时沉淀配置记忆。tab 需含 tbContext.projectId + 工程配置。返回写入行或 null。
export function recordConfigMemory(tab) {
  try {
    const projectId = tab?.tbContext?.projectId || "";
    const primaryProjectId = tab?.primaryProjectId || "";
    if (!projectId || !primaryProjectId) return null;
    const project = store.getProject(primaryProjectId);
    const primaryBranch = project ? (store.gitBranch(project.path) || "") : "";
    let flavor = "";
    if (project && Array.isArray(tab.flavors)) {
      const f = tab.flavors.find((x) => same(x.path, project.path));
      flavor = f?.flavor || "";
    }
    const extraProjectIds = [];
    for (const ex of tab.extraProjects || []) {
      const p = store.listProjects().find((x) => same(x.path, ex.path));
      if (p && !extraProjectIds.includes(p.id)) extraProjectIds.push(p.id);
    }
    const title = tab.tbContext?.title || tab.title || "";
    const keywords = tokenizeTitle(title);
    const { app, vehicle } = store.recognizeFromTitleKeywords(projectId, keywords);
    // 记下主工程的 git 远程地址：将来在"同一工程的另一份备份/路径"上也能据此落到当前可用的那份
    const primaryRemote = project ? (store.gitRemoteUrl(project.path) || "") : "";
    const mem = {
      signals: { vehicle, app, titleKeywords: keywords, tags: tab.tbContext?.tags || [], sprintName: tab.tbContext?.sprintName || "" },
      config: { primaryProjectId, primaryRemote, primaryBranch, flavor, extraProjectIds },
      sampleTitle: title.slice(0, 80),
    };
    const row = store.addConfigMemory(projectId, mem);
    log("system", "info", "devbench", `配置记忆已沉淀：TB项目${projectId} 主工程${primaryProjectId} flavor=${flavor || "-"} 车型=${vehicle || "-"}`);
    return row;
  } catch (e) {
    log("system", "warn", "devbench", `配置记忆沉淀失败: ${e.message}`);
    return null;
  }
}

// 给新任务推荐配置：评分匹配记忆库 → 返回 { snapshot, summary, basedOn } 或 null。
// query: { title, titleKeywords, vehicle, app, sprintName, tags }
export function suggestConfigSnapshot(projectId, query = {}) {
  const mems = store.getConfigMemories(projectId);
  if (!mems.length) return null;
  const overlap = (a, b) => { const B = new Set(b || []); return (a || []).filter((x) => B.has(x)).length; };
  let best = null, bestScore = 0;
  for (const m of mems) {
    let s = 0;
    if (query.vehicle && m.signals?.vehicle && query.vehicle === m.signals.vehicle) s += 5;   // 同车型最强信号
    if (query.app && m.signals?.app && query.app === m.signals.app) s += 2;
    s += overlap(query.tags, m.signals?.tags) * 1.5;
    if (query.sprintName && m.signals?.sprintName && query.sprintName === m.signals.sprintName) s += 1;
    s += overlap(query.titleKeywords, m.signals?.titleKeywords) * 1;
    s += Math.min(m.count || 1, 5) * 0.2; // 高频配置略加权
    if (s > bestScore) { bestScore = s; best = m; }
  }
  if (!best || bestScore < 1.5) return null; // 把握不足不乱建议
  // 主工程：记忆里那份在本机存在就用之；否则按 git 远程找"同一工程的另一份当前可用备份"（路径/分支可不同）
  let project = store.getProject(best.config.primaryProjectId);
  let pickedBackup = false;
  if (!project || project.exists === false) {
    const alt = store.findAvailableSameProject(best.config.primaryProjectId, best.config.primaryRemote);
    if (alt) { project = alt; pickedBackup = true; }
  }
  if (!project || project.exists === false) return null; // 连同工程的可用备份都没有 → 不建议
  const branches = {};
  if (best.config.primaryBranch) branches[project.path] = best.config.primaryBranch;
  const flavors = best.config.flavor ? [{ path: project.path, flavor: best.config.flavor }] : [];
  const extraProjects = [];
  for (const id of best.config.extraProjectIds || []) {
    const p = store.getProject(id);
    if (p) extraProjects.push({ path: p.path, name: p.name });
  }
  const snapshot = {
    mode: "local",
    primaryProjectId: project.id, // 用解析后的工程（可能是同工程的另一份可用备份）
    branches, flavors, extraProjects,
    sourceTitle: `配置记忆·${best.sampleTitle || ""}`.slice(0, 60),
  };
  const summary = {
    projectName: project.name,
    projectExists: project.exists !== false,
    branch: best.config.primaryBranch || "",
    flavor: best.config.flavor || "",
    vehicle: best.signals?.vehicle || "",
    extras: extraProjects.map((e) => e.name),
    pickedBackup, // true=记忆里那份不在本机，已落到同一工程的另一份可用备份
  };
  return { snapshot, summary, basedOn: { count: best.count || 1, sampleTitle: best.sampleTitle || "", score: Math.round(bestScore * 10) / 10 } };
}
