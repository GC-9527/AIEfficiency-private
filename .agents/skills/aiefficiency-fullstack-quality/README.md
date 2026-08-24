# AIEfficiency Full-stack Quality Skill

面向 AIEfficiency 和其他全栈 Web 工程的跨 AI 质量 SKILL。它不是单纯的“最佳实践提示词”，而是一套可执行的影响分析、UI 关联回归、浏览器几何检查、视觉基线、包体性能和全栈契约门禁。

## 它解决什么

- 改一个 UI 后，其他路由、共享侧栏、FloatingDock、弹窗、下拉、输入区发生变形或遮挡。
- 桌面分辨率正常，但小屏、折叠侧栏、长文本、滚动到底部后异常。
- 页面越来越慢、路由包变大、重库进入首屏、轮询重复、过期请求覆盖新状态。
- 401/403/网络错误被吞成空数组，用户看到“暂无数据”而不是错误。
- AI 只检查改动文件，没有追踪反向依赖和共享 UI 消费者。
- 不同 AI 工具各维护一份规则，版本逐渐漂移。

## 核心结构

- `SKILL.md`：跨平台 Agent Skills 标准入口。
- `references/`：按需加载的详细规则，降低日常 token 消耗。
- `scripts/`：只依赖 Node.js 内置模块的静态与构建门禁；浏览器检查会复用工程已有 Playwright、Puppeteer 或 Puppeteer Core。
- `config/`：AIEfficiency 默认路由、视口、预算和命令配置。
- `assets/`：未知 AI 的 AGENTS.md 回退片段、通用 Prompt、层级 token 示例、CI 示例。
- `evals/`：触发与行为评测样例。
- `VERIFICATION.md`：包自身验证范围、真实结果与接入限制。
- `LICENSE`：Apache-2.0 许可证；`MANIFEST.sha256` 在发布打包时生成。

## 一次安装，多 AI 共用一份源码

解压后，在 SKILL 目录执行：

```bash
node scripts/install.mjs --repo /path/to/AIEfficiency
```

Windows 示例：

```powershell
node .\scripts\install.mjs --repo "D:\workspace\AIEfficiency"
```

安装器会：

1. 将唯一正式源码安装到 `.agents/skills/aiefficiency-fullstack-quality/`。
2. 为 Claude Code 创建 `.claude/skills/...` 的符号链接或目录联接，而不是复制第二份源码。
3. 在项目 `.aiefficiency/quality/` 创建可修改的质量配置（已有文件不覆盖）。
4. 以带标记、可回滚的方式向 `AGENTS.md` 追加回退规则；安装前自动备份到 `.aiefficiency/skill-backups/`。
5. 创建局部 `.gitignore`：保留项目配置和已审核基线，忽略运行报告、临时截图和安装清单。
6. 升级时比较完整 SKILL 文件树，而不是只比较 `SKILL.md`；脚本、配置、引用或资产任一变化都会触发 canonical 备份与原子替换。

Codex、OpenCode、Gemini CLI 以及支持 `.agents/skills` 的工具可直接发现 canonical 目录；Claude Code 通过链接发现。需要兼容只扫描旧目录的宿主时可加 `--legacy-adapters`，安装器只创建 `.gemini`/`.opencode` 链接，不复制源码。其他只支持项目说明文件的 AI 通过 `AGENTS.md` 回退规则读取同一个 `SKILL.md`。真正不支持仓库文件或工具调用的聊天模型，可注入 `assets/portable-prompt.md`。

> “支持全部 AI”表示同一份标准工作流可被不同宿主接入；没有任何文件格式能强迫所有未知 AI 产品自动发现它。对不实现 Agent Skills 的宿主，本包使用 AGENTS.md/便携 Prompt 回退，但仍不复制 SKILL 正文。

## 验证安装

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/validate-skill.mjs
node .agents/skills/aiefficiency-fullstack-quality/scripts/doctor.mjs --repo .
```

## 日常使用

局部变更：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs \
  --repo . --base origin/main --mode quick
```

普通功能或 BUG：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs \
  --repo . --base origin/main --mode standard
```

共享布局、全局 CSS、弹窗/悬浮层、性能、鉴权、发布：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs \
  --repo . --base origin/main --mode deep
```

首次建立经人工确认的基线：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs \
  --repo . --mode deep --update-baseline
```

基线更新采用“先验证、后提交”策略：静态检查、配置命令、包体或浏览器几何存在阻断时，不会把失败结果写成新基线。只有已经获得产品/技术负责人批准的包体预算变化，才能显式记录原因后接受：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs \
  --repo . --mode deep --update-baseline \
  --accept-budget-change "TB-1234 approved editor chunk increase"
```

这只允许更新包体预算基线，不会绕过遮挡、越界、视觉差异、页面错误或安全门禁。

报告默认写入：

```text
.aiefficiency/quality/
├── artifacts/
├── baselines/
├── reports/
└── screenshots/
```

## 浏览器检查前提

浏览器门禁优先复用以下任一环境：

- 工程已安装的 `playwright` 或 `@playwright/test`；
- 工程已安装的 `puppeteer` 或 `puppeteer-core`；
- 本机 Chrome、Chromium 或 Edge；
- 配置或环境变量指定的浏览器可执行文件。

它不会自动联网安装依赖，也不会自动启动或重启生产服务。默认访问配置中的本地开发地址；缺少浏览器或服务时结果为 `SKIPPED`，而不是伪造 `PASS`。

## 只更新一份

后续升级只替换 `.agents/skills/aiefficiency-fullstack-quality`。安装器比较完整文件树，先将旧 canonical 与冲突适配器备份到 `.aiefficiency/skill-backups/`，再替换；Claude 及可选 legacy 链接会继续读取同一份源码。禁止在 `.claude`、`.gemini`、`.opencode` 再复制完整 SKILL。

## 自测

```bash
node scripts/selftest.mjs
```

自测会在临时目录创建一个故意包含 UI 风险的微型仓库，验证完整文件树升级、别名反向依赖、无效 Git 基线阻断、只拦截新增静态问题、包体预算与防基线漂白、总门禁状态传播、模拟浏览器的横向溢出/视觉基线、PNG 差异、安装与卸载。它不访问网络，也不修改真实工程。
