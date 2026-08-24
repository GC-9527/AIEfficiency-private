# Bug-SOP 使用指南

> 🎯 **Bug 分析端到端流程**（Triage → Evidence → Analyze → Review → Verify）
> 配合《AppMarket-Bug-Analysis-SOP.md》和《AppMarket-Bug-Analysis-Manual.md》使用。

## 一、组件清单

### Skill 文件（位于 `C:\ai\AIEfficiency\skills\`）

| Skill | 作用 | 阶段 |
|-------|------|------|
| `bug-triage.md` | 严重度评定 + 分类打标 | Stage 2 |
| `bug-evidence.md` | 证据包完整性检查 + ADB 补齐命令 | Stage 3 |
| `bug-analyze.md` | 根因分析（决策树+矩阵+Playbook） | Stage 5 |
| `bug-review.md` | 修复方案对比（≥2 方案） | Stage 6 |
| `bug-verify.md` | 验证计划 + 回归测试清单 | Stage 7 |
| `bug-sop.md` | **编排入口**（串联上面 5 个） | 全流程 |
| `bug-report.md` | 原有单步分析（保留作为快速通道） | — |

### 网关改动

- `gateway/services/dispatcher.js` 增加关键词识别函数 `detectSkillFromKeywords(task)`
- **需重启网关生效**：`cd C:\ai\AIEfficiency && ./stop.bat && ./start.bat`

---

## 二、两种使用入口

### 入口 A：对话直接调用

```
# 完整流程（推荐）
/bug-sop [粘贴日志 / 描述 bug / 提供文件路径]

# 单阶段调用（也可独立使用）
/bug-triage ...        # 只做分诊打标
/bug-evidence ...      # 只做证据检查
/bug-analyze ...       # 只做根因分析
/bug-review ...        # 只生成修复方案
/bug-verify ...        # 只生成验证计划
```

**示例**：
```
/bug-sop
日志: C:\logs\crash.log
视频: 点击详情闪退 crash.mp4
环境: 某车机 A12 1920x720
```

### 入口 B：Teambition 任务单触发

**方式 1：标题带 `[SOP]` 前缀**
```
[SOP] CARB-12345 应用详情页闪退
```

**方式 2：任务描述含 `/bug-sop`**
```
标题: CARB-12345 应用详情页闪退
描述: /bug-sop
      点击应用详情入口后立即闪退，必现...
```

**方式 3：任意一种包含"完整流程"、"bug-sop"等关键词**

满足任一条件，TB watcher 拉到任务后自动走 `bug-sop` 流程；
不满足则走默认 `bug-report`（与现状一致）。

---

## 三、流程执行效果

无论从哪个入口进入，AI 都会按以下顺序输出：

```
# Bug 分析综合报告 (via /bug-sop)

## 【阶段 1】分诊结果
- 严重度 / 分类 / SLA

## 【阶段 2】证据检查
- Gate G3: PASS / PARTIAL / FAIL
- 缺失项 + ADB 补齐命令（若有）

## 【阶段 3】根因分析
- 现象分类 / 性质 / 关键证据 / 时间线
- 候选假设 → 确认根因

## 【阶段 4】修复方案
- 方案 A（快速）/ 方案 B（彻底）
- 对比评分 / 推荐决议

## 【阶段 5】验证计划
- 可执行 adb 脚本 / 回归清单 / 环境矩阵

## 流程元数据
- Gate 通过情况 / 需人工介入项
```

---

## 四、Gate 中断机制

| Gate | 触发条件 | 中断行为 |
|------|---------|---------|
| **G3** | 证据不足（日志/视频都缺） | 只输出阶段 1-2，要求补齐 |
| **阶段 3** | 无法定位根因 | 阶段 4-5 标注"需补充信息" |
| **性质=环境错误** | 非代码问题 | 阶段 4 改为规避方案 + 上报 |
| **信息完全不足** | 报告末尾添加 `<!-- NEED_MORE_INFO: ... -->` → TB watcher 自动挂起并@提单人补充 |

---

## 五、验证 & 回滚

### 快速验证对话入口

```
在 Claude Code 里输入：
/bug-sop 测试一下流程，模拟一个 NullPointerException 崩溃场景
```

AI 应当输出完整 5 阶段报告（或标注信息不足）。

### 快速验证 TB 入口

```
1. 在 Teambition 建个测试任务，标题: [SOP] 测试 bug-sop 流程
2. 附日志文件
3. 等待 TB watcher 拉取（默认 60s 轮询）
4. 观察网关日志: type=bug_analysis -> engine=claude, skill=/bug-sop (关键词)
```

### 回滚

如果发现 bug-sop 不好用，回退到 bug-report 只需：
- 对话用户用 `/bug-report` 代替 `/bug-sop`
- TB 任务标题去掉 `[SOP]` 前缀即可
- 永久回滚：删除 dispatcher.js 中 `detectSkillFromKeywords` 相关代码

---

## 六、与原有 Skill 关系

```
          (保留不变)          (新增组合)
 /bug-report  ←同级→  /bug-sop
      │                   │
      │                   ├─ /bug-triage
      │                   ├─ /bug-evidence
      │                   ├─ /bug-analyze   ← 类似 /bug-report 但更聚焦
      │                   ├─ /bug-review
      │                   └─ /bug-verify
      │
   "单步快速分析"       "五阶段完整流程"
```

- `/bug-report`：面对信息齐全的简单 bug，一步出报告
- `/bug-sop`：面对复杂/跨阶段 bug，走完整 SOP 有审计痕迹
- 子 skill：可独立组合使用（如只分诊不分析）

---

## 七、后续可演进

| 版本 | 规划 |
|------|------|
| v1.0（当前） | 5 个原子 skill + 1 个编排 skill + 关键词路由 |
| v1.1 | 为每个 skill 加本地示例（`docs/examples/bug-*-example.md`） |
| v1.2 | 子 skill 串接改走 workflow-executor 而非 Prompt 引导 |
| v2.0 | 网关加工单状态机，支持跨对话的 Gate 持久化 |

---

**版本**：v1.0 | **创建日期**：2026-04-21 | **作者**：AI 实施
