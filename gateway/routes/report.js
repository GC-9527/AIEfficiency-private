import { Router } from "express";
import { generateReport, calcDateRange } from "../services/report-generator.js";
import { checkTeambitionStatus } from "../services/teambition.js";
import { log } from "../services/logger.js";
import { getConfig } from "../services/config.js";
import * as devbenchStore from "../services/devbench/store.js";
import { getAuthoritativeWorkReportRepositories } from "../services/work-report-repositories.js";

const router = Router();

/**
 * POST /api/report/generate
 * 生成工作报告
 * Body: { period: "week"|"month"|"quarter"|"year", refDate?: "2026-03-28", sessionId?: "xxx" }
 */
router.post("/generate", async (req, res) => {
  const { period = "week", refDate, sessionId } = req.body;

  try {
    const range = calcDateRange(period, refDate);
    res.json({ success: true, data: { message: `正在生成 ${range.label}...`, range } });

    // 异步生成（不阻塞响应）
    generateReport(period, { refDate, sessionId }).catch(err => {
      log("system", "error", "report", `报告生成失败: ${err.message}`);
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

async function repositoryPreview() {
  const repositories = await getAuthoritativeWorkReportRepositories(devbenchStore, getConfig());
  return repositories.map((repo) => ({
    id: repo.id,
    name: repo.name,
    definitionIds: repo.definitionIds,
    definitionNames: repo.definitionNames,
    remote: repo.remote,
    hasLocal: repo.hasLocal,
    paths: repo.paths,
  }));
}

router.get("/repositories", async (req, res) => {
  try {
    res.json({ success: true, data: { repositories: await repositoryPreview() } });
  } catch (error) {
    res.status(503).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/report/preview
 * 预览数据源状态（不生成报告）
 */
router.get("/preview", async (req, res) => {
  try {
    const [tbStatus, gitRepos] = await Promise.all([checkTeambitionStatus(), repositoryPreview()]);
    res.json({
      success: true,
      data: {
        gitRepos,
        teambition: tbStatus,
        hasChat: true,
      },
    });
  } catch (error) {
    res.status(503).json({ success: false, error: error.message });
  }
});

export default router;
