// AI Workbench 入口与初始化。
// 进程启动时调用 init() 注册路由；
// 暴露给 routes/aiautowork.js 的统一服务入口。

import { Router } from "express";

export function createAiautoworkRouter() {
  const router = Router();
  return router;
}

export const AI_AUTOWORK_MODULE_INFO = {
  name: "aiautowork",
  version: "0.1.0",
  description: "AI Workbench 统一任务入口：批量解析 → AI 配置推导 → 校验/复核/修复 → 故事点创建",
};
