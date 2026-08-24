/**
 * 帮助中心文档 API - /api/help/*
 * 把 docs/devbench 下的 markdown 作为可交互 Wiki 提供给前端（列表 + 读取）。
 * 桌面打包未带 docs 时回落到内置精简目录（仅"网关概念速览"等核心文档随前端构建内置）。
 */
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 文档根：仓库内 docs/devbench；桌面打包资源可用 HELP_DOCS_DIR 覆盖
const DOCS_DIR = process.env.HELP_DOCS_DIR || path.join(__dirname, "..", "..", "docs", "devbench");

// 文档分组：顶层 + step2_wlan 子目录，给一个友好的分类
const GROUPS = [
  { dir: ".", label: "概览" },
  { dir: "step2_wlan", label: "局域网部署" },
];

function listDocs() {
  const out = [];
  for (const g of GROUPS) {
    const abs = path.join(DOCS_DIR, g.dir);
    if (!fs.existsSync(abs)) continue;
    let files;
    try { files = fs.readdirSync(abs); } catch { continue; }
    for (const f of files) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      const rel = g.dir === "." ? f : `${g.dir}/${f}`;
      out.push({ slug: encodeURIComponent(rel), group: g.label, title: f.replace(/\.md$/i, "") });
    }
  }
  return out;
}

router.get("/docs", (req, res) => {
  res.json({ ok: true, data: listDocs() });
});

router.get("/docs/:slug", (req, res) => {
  const rel = decodeURIComponent(req.params.slug);
  // 防目录穿越：解析后必须仍在 DOCS_DIR 内，且为 .md
  const fp = path.normalize(path.join(DOCS_DIR, rel));
  if (!fp.startsWith(path.normalize(DOCS_DIR)) || !fp.toLowerCase().endsWith(".md") || !fs.existsSync(fp)) {
    return res.status(404).json({ ok: false, error: "文档不存在" });
  }
  try {
    const content = fs.readFileSync(fp, "utf-8");
    res.json({ ok: true, data: { slug: req.params.slug, title: path.basename(fp, ".md"), content } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
