# 跨 AI 接入策略

## Canonical source

正式源码只保留一份：

```text
.agents/skills/aiefficiency-fullstack-quality/
```

不要在每个 AI 目录复制完整内容。多份源码会导致规则、脚本和版本漂移。

## 原生发现

- Codex：`.agents/skills/<name>/SKILL.md`
- OpenCode：支持 `.agents/skills`，也支持 `.opencode/skills` 和 `.claude/skills`
- Gemini CLI：支持 workspace `.agents/skills` alias
- Claude Code：项目技能通常位于 `.claude/skills`，安装器建立指向 canonical 目录的链接
- 支持 Agent Skills 开放标准的其他工具：优先配置到 canonical 目录或建立链接

模型与宿主必须区分：DeepSeek、MiniMax、Qwen、GPT、Claude 等“模型”通常由 Reasonix、OpenCode、Codex、自研编排器等“宿主”加载仓库规则。只要宿主能读取 canonical SKILL、执行脚本或注入 `portable-prompt.md`，同一工作流即可复用；不能宣称模型本身会自动扫描文件。

## 可选旧目录适配

```bash
node scripts/install.mjs --repo /path/to/AIEfficiency --legacy-adapters
```

该选项为 `.gemini/skills`、`.opencode/skills` 创建链接/目录联接，适合只扫描旧目录的版本；canonical 仍只有一份。升级时安装器比较完整文件树并先备份旧版本，避免脚本更新被漏掉。

## 不支持 Agent Skills 的工具

使用根 `AGENTS.md` 的小型回退块：它只要求 AI 在全栈/UI 任务前读取 canonical `SKILL.md`，不复制规则正文。若宿主不读取 AGENTS.md，则把 `assets/portable-prompt.md` 作为 system/project rule。

## 为什么不用 MCP 替代

本 SKILL 主要是工作流、门禁、脚本和输出契约，适合版本化随仓库分发。MCP 更适合实时数据、认证和受控远程工具。后续可以让 SKILL 调用 AIEfficiency 的 MCP/网关，但不应把核心质量规则分散到多个模型私有 Prompt。

## 团队发布

1. 在独立分支升级 canonical skill。
2. 运行 `validate-skill.mjs` 与 `selftest.mjs`。
3. 在真实 AIEfficiency 仓库执行 quick/standard/deep 冒烟。
4. 评审 SKILL diff 和脚本权限。
5. 检查 `MANIFEST.sha256`，打 tag，并通过中心机或 Git 拉取更新。
6. 工作机只更新 canonical 目录；链接无需变化。
7. 安装器保留 `.aiefficiency/quality` 配置/已审核基线与 `.aiefficiency/skill-backups`；运行报告和临时截图由局部 `.gitignore` 排除。
