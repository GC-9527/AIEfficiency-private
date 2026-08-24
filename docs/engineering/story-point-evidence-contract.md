# 运行态故事点证据契约与防幻觉规则

## 1. 来源事实与技术事实分离

来源事实来自不可变快照：标题、描述、评论、附件、版本、环境、期望行为和来源状态。技术事实来自候选代码、构建、测试、运行观测、协议响应、数据库或设备结果。

AI 的自然语言分析只能作为 `INFERENCE`。没有证据 ID 的关键结论不能参与 `VERIFIED` 判定。

## 2. Claim Ledger

```yaml
claims:
  - id: C-001
    type: FACT | INFERENCE | UNKNOWN
    statement: "..."
    evidence_ids: [E-001]
    invalidated_by: [candidate_change, source_snapshot_change]
```

- `FACT` 必须有原始证据；
- `INFERENCE` 要给出依据和可验证方法；
- `UNKNOWN` 不得在报告后文悄悄变成已完成；
- 来源冲突必须显式记录。

## 3. 防止 AI 自己写测试再证明自己正确

至少满足一种：

1. 同一回归测试在基线失败、候选通过；
2. 在候选上临时反向应用最小修复后失败，恢复后通过；
3. 使用既有独立测试、真实设备、外部协议、数据库查询或 golden output 作为 Oracle；
4. 独立 reviewer 检查测试断言没有复制实现算法、常量或同一错误假设。

不能单独作为通过证据：

- 编译成功；
- 没有抛异常；
- mock 返回了 AI 自己配置的值；
- 页面截图看起来正确；
- AI 声称“已测试”但没有命令、退出码和原始输出。

## 4. change_type 与证据模型

- DEFECT_FIX：差分复现、根因链、竞争假设、回归保护；
- FEATURE：验收标准追踪、正反向与兼容；
- REFACTOR：外部行为等价和资源无明显退化；
- CONFIG_OR_DATA：schema、预检、幂等、恢复与回滚；
- PACKAGE_OR_RELEASE：最终制品身份、安装、启动、升级和运行；
- TEST_OR_HARNESS：敏感度、假阳性/假阴性和外部 Oracle；
- REVIEW_OR_ANALYSIS：只读 Finding，不虚构运行结果；
- DOCUMENTATION：内容与真实实现一致。

## 5. 全面性必须结构化

“全面考虑”必须被替换为 12 维影响矩阵。每一维只能是 `PASS`、`NOT_APPLICABLE` 或 `UNKNOWN`，并包含依据。关键维度存在 `UNKNOWN` 时，结果最多 `PARTIAL`。

## 6. 候选一致性

每条证据绑定：

- source snapshot hash；
- base/head/diff hash；
- dependency/config hash；
- Flavor/variant；
- environment/device/AppMock；
- artifact hash；
- command、exit code、timestamp 和原始输出。

修复后引用旧制品、用 dev 证据宣称 production、用 AppMock 宣称真实设备、用其他 Flavor 代替目标 Flavor或混用多个 worktree 证据，都会使结论降为 PARTIAL/BLOCKED。

## 7. 独立 reviewer 的边界

Reviewer 是证据挑战者，不是第二个开发 Agent。STORY-STANDARD 默认只读复核；STORY-CRITICAL 才在隔离环境重跑最关键 1–3 个门禁。

## 8. VERIFIED 的准确含义

`VERIFIED` 表示：在声明的候选、来源快照、环境、验收标准和风险覆盖范围内，非 LLM 证据支持故事点交付正确，且没有发现阻断回归。

它不表示整个软件绝对无缺陷。高风险交付仍需灰度、监控、告警和回滚。
