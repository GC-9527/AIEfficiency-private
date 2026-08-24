import { Router } from "express";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, existsSync, cpSync, rmSync } from "fs";
import { join, dirname, relative, sep, resolve, isAbsolute, basename } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { requireAdmin } from "../services/admin-auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = join(__dirname, "..", "..", "skills");

// 默认颜色池，根据 skill id 哈希分配
const COLOR_POOL = [
  { color: "text-red-400 bg-red-500/10" },
  { color: "text-green-400 bg-green-500/10" },
  { color: "text-purple-400 bg-purple-500/10" },
  { color: "text-cyan-400 bg-cyan-500/10" },
  { color: "text-amber-400 bg-amber-500/10" },
  { color: "text-blue-400 bg-blue-500/10" },
  { color: "text-orange-400 bg-orange-500/10" },
  { color: "text-pink-400 bg-pink-500/10" },
  { color: "text-teal-400 bg-teal-500/10" },
  { color: "text-indigo-400 bg-indigo-500/10" },
];

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// 颜色名 → Tailwind class 映射
const COLOR_NAME_MAP = {
  red: "text-red-400 bg-red-500/10",
  green: "text-green-400 bg-green-500/10",
  purple: "text-purple-400 bg-purple-500/10",
  cyan: "text-cyan-400 bg-cyan-500/10",
  amber: "text-amber-400 bg-amber-500/10",
  blue: "text-blue-400 bg-blue-500/10",
  orange: "text-orange-400 bg-orange-500/10",
  pink: "text-pink-400 bg-pink-500/10",
  teal: "text-teal-400 bg-teal-500/10",
  indigo: "text-indigo-400 bg-indigo-500/10",
  yellow: "text-yellow-400 bg-yellow-500/10",
};

import { getCapabilityDoc, getCapabilitySummary, invalidateCapabilityCache } from "../services/capability-doc.js";

const router = Router();

// Skill 列表/内容仍可供 Chat 与工作流只读使用；创建、导入、同步等会
// 写本机文件或执行 Docker 命令的请求统一要求管理员身份。
router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  return requireAdmin(req, res, next);
});

/**
 * 递归扫描目录下所有 .md 文件，返回相对于 baseDir 的路径
 */
function scanMarkdownFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...scanMarkdownFiles(fullPath, baseDir));
      } else if (entry.endsWith(".md")) {
        results.push(relative(baseDir, fullPath));
      }
    } catch {}
  }
  return results;
}

/**
 * 将 API 中的 Skill ID 解析为 skills/ 内的安全删除目标。
 * 标准文件夹型 Skill（.../<name>/SKILL.md）删除整个 <name>/ 包；
 * 其它 Skill 只删除对应的 Markdown 文件。
 */
export function resolveSkillDeleteTarget(id, skillsDir = SKILLS_DIR) {
  const normalizedId = String(id || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const segments = normalizedId.split("/");
  if (!normalizedId || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  const root = resolve(skillsDir);
  const filePath = resolve(root, `${normalizedId}.md`);
  const relativeFile = relative(root, filePath);
  if (!relativeFile || relativeFile === ".." || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) {
    return null;
  }

  const isPackage = basename(filePath).toLowerCase() === "skill.md" && dirname(filePath) !== root;
  const deletePath = isPackage ? dirname(filePath) : filePath;
  const relativeDeletePath = relative(root, deletePath).replace(/\\/g, "/");
  return {
    id: normalizedId,
    filePath,
    deletePath,
    relativeDeletePath,
    scope: isPackage ? "package" : "file",
  };
}

export function deleteSkillEntry(id, { skillsDir = SKILLS_DIR } = {}) {
  const target = resolveSkillDeleteTarget(id, skillsDir);
  if (!target) return { ok: false, status: 400, error: "Skill ID 无效" };
  if (!existsSync(target.filePath)) return { ok: false, status: 404, error: "Skill 不存在" };

  if (target.scope === "package") {
    rmSync(target.deletePath, { recursive: true, force: false });
  } else {
    unlinkSync(target.filePath);
  }

  return {
    ok: true,
    data: {
      id: target.id,
      scope: target.scope,
      path: target.relativeDeletePath,
      message: target.scope === "package"
        ? `已删除本地 Skill 包 ${target.relativeDeletePath}`
        : `已删除本地 Skill ${target.relativeDeletePath}`,
    },
  };
}

// 平台能力文档
router.get("/capabilities", (req, res) => {
  try {
    const doc = getCapabilityDoc();
    res.json({ success: true, data: doc });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 平台能力纯文本摘要（供 prompt 注入）
router.get("/capabilities/summary", (req, res) => {
  try {
    res.type("text/plain").send(getCapabilitySummary());
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// 获取 skill 列表
router.get("/", (req, res) => {
  try {
    const files = scanMarkdownFiles(SKILLS_DIR);
    const skills = files.map((relPath) => {
      const content = readFileSync(join(SKILLS_DIR, relPath), "utf-8");
      const meta = parseFrontmatter(content);
      // id: 去掉 .md 后缀，子目录用 / 分隔（如 "decrypt-elog/decrypt-elog"）
      const id = relPath.replace(/\\/g, "/").replace(/\.md$/, "");
      // 显示名优先用 frontmatter name，否则取文件名部分
      const baseName = id.includes("/") ? id.split("/").pop() : id;

      // 子目录名作为分组标签
      const group = id.includes("/") ? id.split("/")[0] : null;

      const tag = meta.tag || group || null;
      const colorName = meta.color || null;
      const colorClass = colorName
        ? (COLOR_NAME_MAP[colorName] || COLOR_POOL[hashCode(id) % COLOR_POOL.length].color)
        : COLOR_POOL[hashCode(id) % COLOR_POOL.length].color;

      return {
        id,
        file: relPath.replace(/\\/g, "/"),
        name: meta.name || baseName,
        description: meta.description || "",
        tag,
        color: colorClass,
        content: content.slice(content.indexOf("---", 3) + 3).trim(),
        raw: content, // 完整原文（含 frontmatter），供同步/写回时保留 frontmatter，避免丢失
      };
    });
    res.json({ success: true, data: skills });
  } catch (err) {
    res.json({ success: true, data: [], error: err.message });
  }
});

// 获取单个 skill 详情（支持子目录，如 /api/skills/decrypt-elog/decrypt-elog）
router.get("/*", (req, res, next) => {
  // 排除 sync-cloud 路由
  if (req.params[0] === "sync-cloud" || req.params[0] === "pull-from-cloud") return next();

  try {
    const id = req.params[0];
    const file = join(SKILLS_DIR, `${id}.md`);
    const content = readFileSync(file, "utf-8");
    const meta = parseFrontmatter(content);
    const baseName = id.includes("/") ? id.split("/").pop() : id;
    const group = id.includes("/") ? id.split("/")[0] : null;
    const tag = meta.tag || group || null;
    const colorName = meta.color || null;
    const colorClass = colorName
      ? (COLOR_NAME_MAP[colorName] || COLOR_POOL[hashCode(id) % COLOR_POOL.length].color)
      : COLOR_POOL[hashCode(id) % COLOR_POOL.length].color;

    res.json({
      success: true,
      data: {
        id,
        name: meta.name || baseName,
        description: meta.description || "",
        tag,
        color: colorClass,
        content: content.slice(content.indexOf("---", 3) + 3).trim(),
        raw: content,
      },
    });
  } catch {
    res.status(404).json({ success: false, error: "Skill 不存在" });
  }
});

// 创建 Skill（OpenClaw 风格 SKILL.md）
router.post("/", (req, res) => {
  try {
    const { id, name, description, content, raw } = req.body;
    if (!id || !id.match(/^[a-z0-9-]+$/)) {
      return res.status(400).json({ success: false, error: "ID 只能包含小写字母、数字和连字符" });
    }
    const filePath = join(SKILLS_DIR, `${id}.md`);
    if (existsSync(filePath)) {
      return res.status(409).json({ success: false, error: "Skill 已存在" });
    }
    // 支持直接写入完整文件内容（含 frontmatter）
    const md = raw || `---\nname: ${name || id}\ndescription: ${description || ""}\n---\n\n${content || ""}`;
    writeFileSync(filePath, md, "utf-8");
    invalidateCapabilityCache();
    res.json({ success: true, data: { id, name: name || id } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 更新 Skill
router.put("/:id", (req, res) => {
  try {
    const id = req.params.id;
    const filePath = join(SKILLS_DIR, `${id}.md`);
    if (!existsSync(filePath)) {
      return res.status(404).json({ success: false, error: "Skill 不存在" });
    }
    const { name, description, content, raw } = req.body;
    if (raw) {
      // 直接写入完整内容（含 frontmatter）
      writeFileSync(filePath, raw, "utf-8");
    } else {
      const md = `---\nname: ${name || id}\ndescription: ${description || ""}\n---\n\n${content || ""}`;
      writeFileSync(filePath, md, "utf-8");
    }
    invalidateCapabilityCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除 Skill（支持子目录 ID，如 software-development/example/SKILL）
router.delete("/*", (req, res) => {
  try {
    const result = deleteSkillEntry(req.params[0]);
    if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
    invalidateCapabilityCache();
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 从本地路径导入 Skill（文件或文件夹）
router.post("/import", (req, res) => {
  try {
    const { path: srcPath } = req.body;
    if (!srcPath) return res.status(400).json({ success: false, error: "缺少 path" });
    if (!existsSync(srcPath)) return res.status(400).json({ success: false, error: `路径不存在: ${srcPath}` });

    const stat = statSync(srcPath);

    if (stat.isFile()) {
      // 单文件：复制到 skills/ 根目录
      const fileName = srcPath.replace(/\\/g, "/").split("/").pop();
      const destPath = join(SKILLS_DIR, fileName);
      cpSync(srcPath, destPath);
      invalidateCapabilityCache();
      const id = fileName.replace(/\.md$/, "");
      res.json({ success: true, data: { message: `已导入文件 ${fileName}`, ids: [id] } });

    } else if (stat.isDirectory()) {
      // 文件夹：整个复制为子目录
      const dirName = srcPath.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop();
      const destDir = join(SKILLS_DIR, dirName);
      mkdirSync(destDir, { recursive: true });

      // 递归复制整个目录
      cpSync(srcPath, destDir, { recursive: true });

      // 统计 .md 文件数
      const mdFiles = scanMarkdownFiles(destDir, SKILLS_DIR);
      invalidateCapabilityCache();
      res.json({
        success: true,
        data: {
          message: `已导入文件夹 ${dirName}/（${mdFiles.length} 个 Skill 文件 + 附属文件）`,
          ids: mdFiles.map(f => f.replace(/\\/g, "/").replace(/\.md$/, "")),
        },
      });
    } else {
      res.status(400).json({ success: false, error: "不支持的路径类型" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 推送单个 Skill 到云端
router.post("/:id/push", async (req, res) => {
  try {
    const id = req.params.id;
    const { cloudUrl } = req.body;
    if (!cloudUrl) return res.status(400).json({ success: false, error: "缺少 cloudUrl" });

    const filePath = join(SKILLS_DIR, `${id}.md`);
    if (!existsSync(filePath)) {
      return res.status(404).json({ success: false, error: "本地 Skill 不存在" });
    }

    const raw = readFileSync(filePath, "utf-8");
    const resp = await fetch(`${cloudUrl}/api/skills/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, raw }),
    });
    const result = await resp.json();

    if (result.success) {
      res.json({ success: true, data: { message: `Skill /${id} 已推送到云端` } });
    } else {
      res.json({ success: false, error: result.error || "推送失败" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 从云端拉取 skills 到本地
router.post("/pull-from-cloud", async (req, res) => {
  const { cloudUrl } = req.body;
  if (!cloudUrl) return res.json({ success: false, error: "缺少 cloudUrl" });
  try {
    const resp = await fetch(`${cloudUrl}/api/skills`);
    const { data } = await resp.json();
    let count = 0;
    for (const skill of data) {
      const filePath = join(SKILLS_DIR, `${skill.id}.md`);
      mkdirSync(join(filePath, ".."), { recursive: true });
      // 优先写完整原文（含 frontmatter）；若云端未返回 raw，则用元数据重建 frontmatter，
      // 严禁直接写 content（那是去掉 frontmatter 的正文，会抹掉 name/description/user_invocable）
      let md = skill.raw;
      if (!md) {
        const body = (skill.content || "").replace(/\s+$/, "");
        const fm = [`name: ${skill.name || skill.id}`, `description: ${skill.description || ""}`];
        if (skill.tag) fm.push(`tag: ${skill.tag}`);
        if (skill.user_invocable !== undefined) fm.push(`user_invocable: ${skill.user_invocable}`);
        md = `---\n${fm.join("\n")}\n---\n\n${body}\n`;
      }
      writeFileSync(filePath, md, "utf-8");
      count++;
    }
    res.json({ success: true, data: { message: `已从云端同步 ${count} 个 Skill`, count } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 同步 skills 到云端 Docker 容器
router.post("/sync-cloud", async (req, res) => {
  try {
    const execFileAsync = (cmd, args, opts) => new Promise((resolve, reject) => {
      execFile(cmd, args, { encoding: "utf-8", windowsHide: true, ...opts }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });

    const check = (await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", "ai-efficiency-cloud"], { timeout: 5000 })).trim();

    if (check !== "true") {
      return res.json({ success: false, error: "容器 ai-efficiency-cloud 未运行" });
    }

    const localFiles = scanMarkdownFiles(SKILLS_DIR);

    await execFileAsync("docker", ["exec", "ai-efficiency-cloud", "sh", "-c", "rm -rf /app/skills/*"], { timeout: 10000 });
    await execFileAsync("docker", ["cp", `${SKILLS_DIR}/.`, "ai-efficiency-cloud:/app/skills/"], { timeout: 10000 });

    res.json({
      success: true,
      data: {
        message: `已同步 ${localFiles.length} 个 Skill 到云端`,
        files: localFiles,
        count: localFiles.length,
      },
    });
  } catch (err) {
    res.json({ success: false, error: err.message || "同步失败" });
  }
});

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return meta;
}

export default router;
