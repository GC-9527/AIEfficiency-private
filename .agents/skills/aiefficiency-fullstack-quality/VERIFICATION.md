# AIEfficiency Full-stack Quality Skill — 验证报告

- 版本：1.0.0
- 验证日期：2026-08-19
- 运行环境：Linux x86_64，Node.js v22.16.0，Git 2.47.3
- 最低声明环境：Node.js 20+

## 结论

**PASS（包自身验证通过）**

本结论只覆盖 SKILL 包结构、Node.js 脚本语法和隔离微型仓库的确定性自测。用户提供的是 AIEfficiency 的部分集成审计包，而不是可运行的完整仓库，因此本次没有宣称真实 AIEfficiency 的构建、接口、鉴权数据或浏览器端到端场景已经通过。

## 已执行验证

| 验证项 | 结果 | 证据摘要 |
|---|---|---|
| SKILL 结构与 frontmatter | PASS | 名称、描述、版本、许可证、必需文件与引用目标均有效 |
| JSON 配置解析 | PASS | 配置、Schema、评测用例和 package.json 均可解析 |
| 全部 Node.js 脚本语法 | PASS | 12 个脚本通过 `node --check` |
| 隔离自测 | PASS | 54 项检查，0 失败 |
| 安装/升级/备份 | PASS | canonical 安装、链接适配、AGENTS 标记、完整文件树升级和备份通过 |
| 影响图 | PASS | 导入别名反向依赖、关联路由和无效 Git 基线阻断通过 |
| 静态 UI 门禁 | PASS | 能识别本次新增的任意 z-index、错误吞空等 P0/P1；不把无效基线当成零改动 |
| 包体门禁 | PASS | gzip/brotli 统计、绝对 chunk 预算、回退检测、防基线漂白通过 |
| 经批准的预算例外 | PASS | `--accept-budget-change` 原因由总门禁转发并写入审计证据 |
| 浏览器几何与视觉基线 | PASS | 模拟 Puppeteer 检出横向溢出；失败时拒绝写基线；通过后建立并比较 PNG 基线 |
| 总门禁状态传播 | PASS | 子脚本 FAIL 能使总门禁输出 `BLOCK` 和非零退出码 |
| 卸载保护 | PASS | 只移除确认过的适配链接和标记块，保留 canonical/证据的选项生效 |

## 实际命令

```bash
node scripts/validate-skill.mjs
node scripts/selftest.mjs
```

验证结果摘要：

```text
validate-skill: PASS
scriptCount: 12
selftest: PASS
checkCount: 54
failed: 0
```

## 自测没有伪造真实浏览器验收

自测使用隔离的本地 HTTP 服务与最小 Puppeteer 兼容运行时，目的是验证门禁算法、基线事务和状态传播；它不是 AIEfficiency 真实页面的截图验收。真实接入后仍需在可访问的 AIEfficiency 测试环境中执行：

```bash
node .agents/skills/aiefficiency-fullstack-quality/scripts/doctor.mjs --repo .
node .agents/skills/aiefficiency-fullstack-quality/scripts/quality-gate.mjs \
  --repo . --base origin/main --mode deep
```

## 真实仓库接入前需要核对

1. `.aiefficiency/quality/quality-gate.config.json` 中的前后端目录、构建/测试命令、导入别名和路由是否与当前分支一致。
2. 浏览器测试地址、登录态、测试账号和稳定测试数据是否可用；缺失时结果必须保持 `SKIPPED/INCOMPLETE`，不能写 PASS。
3. 首次视觉与包体基线必须由人工确认页面正确后建立，并将已审核基线提交到 Git。
4. AIEfficiency 的共享壳、侧栏、FloatingDock、Dialog/Portal、请求/鉴权公共层变更应使用 `deep`，不得降级为局部 quick 检查。
5. 审计包标注为 PARTIAL；完整源码接入后应重新生成路由/依赖画像并收紧配置预算。
