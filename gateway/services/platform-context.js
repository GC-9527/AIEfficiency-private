/**
 * 平台上下文生成器
 * 自动生成 PLATFORM.md 内容，供 AI 规划器使用
 * 内容缓存，Skill 变化时自动刷新
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getCapabilitySummary } from "./capability-doc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");
const GATEWAY_PORT = process.env.PORT || 3001;

let cachedDoc = null;

/**
 * 生成平台上下文文档（约 400-600 字符）
 * 规划器使用，帮助 AI 理解平台能力并生成准确的子任务描述
 */
export function getPlatformContext() {
  if (cachedDoc) return cachedDoc;
  cachedDoc = buildPlatformDoc();
  return cachedDoc;
}

/**
 * 缓存失效（Skill 变化时由 agent-runner 调用）
 */
export function invalidatePlatformContext() {
  cachedDoc = null;
}

function buildPlatformDoc() {
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";

  // 动态获取 Skill 列表
  let skillList = "";
  try {
    const summary = getCapabilitySummary();
    if (summary) {
      // 从摘要中提取 skill 名称行
      const lines = summary.split("\n").filter(l => l.startsWith("- /") || l.startsWith("- "));
      skillList = lines.slice(0, 25).join("\n");
    }
  } catch {}

  return `## 平台环境 (AIEfficiency)

系统: ${platform} | 项目根目录: ${PROJECT_ROOT} | 网关: http://localhost:${GATEWAY_PORT}

### 目录结构
- skills/ — Skill 文件(.md)，创建/编辑 Skill 必须放在此目录
- configs/ — 设备配置(device-profiles.json)
- gateway/ — 网关后端代码（不要修改）
- web-dashboard/ — 前端代码（不要修改）

### 可用 API (localhost:${GATEWAY_PORT})
- Skill: POST /api/skills {id,name,description,content} | PUT /api/skills/:id | DELETE /api/skills/:id
- 设备: GET /api/devices/discover | POST /api/devices/connect {ip,port}
- 配置: GET /api/config | PUT /api/config
- 报告: POST /api/report/generate {period:"week|month|quarter|year"}

### 已安装 Skills
${skillList || "(动态加载)"}

### 规范
- 创建 Skill 文件放 skills/ 目录，格式: frontmatter(name,description) + Markdown 正文
- 文件操作使用绝对路径，项目根: ${PROJECT_ROOT}
- 涉及代码/文件修改的子任务标记 inspect: true
- 不要在 .claude/ 或其他非项目目录下创建文件`;
}
