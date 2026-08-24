# Acceptance v4.1 Golden Cases 与灰度对比

日期：2026-08-10  
运行模式：`REPORT_ONLY`  
可执行用例：`gateway/test/acceptance-v4-golden.test.mjs`

## 1. 十个固定 Golden Cases

| # | 场景 | v4.1 预期 | 旧单协议主要问题 | 自动化 |
|---:|---|---|---|---|
| 1 | 直接工程功能开发 | `DIRECT_ENGINEERING / PROJECT-STANDARD` | 容易被误送入故事点 release/设备流程 | PASS |
| 2 | 直接工程缺陷修复 | Project 协议内选择 baseline-red/candidate-green、根因和竞争假设证据 | 用“是否为 BUG”选择另一整套协议 | PASS |
| 3 | 平台正式发布 | 只有 `PROJECT-RELEASE` 可产生 `Production Readiness=READY` | 普通工程通过和生产 READY 混为一谈 | PASS |
| 4 | 飞书/JIRA/TB 普通故事点 | 三种来源均路由到同一 `runtime-story-point-assurance` | 来源系统名称可能影响技术门禁 | PASS |
| 5 | 多仓/公共 SDK/多 Flavor | `STORY-CRITICAL`，包含关键重跑与回滚门禁 | 风险与来源或固定设备清单绑定 | PASS |
| 6 | AppMock/验收器缺陷 | `HARNESS_DEFECT` 阻断故事，不修改目标业务代码 | 工具假阴性容易触发业务代码误修 | PASS |
| 7 | 来源回写失败 | 技术 `VERIFIED` 保持，`Source Sync=FAILED` 独立显示 | 同一 phase 把同步失败误当技术失败 | PASS |
| 8 | 同时修改平台与目标工程 | `DUAL_SCOPE`，两套候选、证据和结论 | 单协议无法表达两个对象 | PASS |
| 9 | 验收期间来源事实变化 | 生成新不可变快照哈希，旧证据不得静默复用 | 可变 `tbContext` 难以证明验收对象未漂移 | PASS |
| 10 | Gate/影响证据不足 | 必须 `PARTIAL`，PASS 无 evidence 自动降为 PENDING | 模型文字或任意 evidence id 可能自证 | PASS |

聚焦执行结果：10/10 通过。该结果证明路由、聚合和保守降级规则，不等价于真实 TB/飞书/设备/生产端到端成功。

## 2. 防止验收器自证

Golden evaluator 的纯函数测试之外，另由 service/API 集成测试覆盖权威边界：

- caller 在创建 run 时提交 PASS，不会直接得到 ACCEPTED/VERIFIED；
- caller 经管理员 API 上传并声明 `MECHANICAL` 的证据，落库仍为 `UNVERIFIED`；
- 内部机械 runner/独立 reviewer 的证据必须绑定同一 run、candidate hash、source snapshot hash 和 environment；
- change-type evidence requirements 必须被可信证据 metadata 覆盖；
- FACT、影响矩阵和非 `NOT_ATTEMPTED` Source Sync 均不能只靠请求体声明；
- Canonical source 不允许用当前时间补 `fetched_at`。

对应测试：

- `gateway/test/acceptance-v4-store.test.mjs`；
- `gateway/test/acceptance-v4-api.test.mjs`；
- `gateway/test/acceptance-v4.test.mjs`。

## 3. 旧/新结果对比边界

本次没有取得经过脱敏且可重复的历史生产故事数据集，因此没有伪造误报率、漏报率或耗时百分比。当前可确认的是静态规则和 deterministic golden replay：

| 指标 | 旧单协议 | v4.1 Phase 0 |
|---|---|---|
| 验收对象 | Project/Story/Release/Sync 混合 | Project 与 Story 分轨；Sync 正交 |
| 普通工程门禁 | 可能机械要求 release、设备、AppMock、fresh reviewer | PROJECT-STANDARD 到 build/E2E；不声明 READY |
| 来源影响 | 入口以 TB/story acceptance 为中心 | 来源只控制取数/映射/权限/回写 |
| 证据不足 | 可能依赖模型结论或双 PASS 文案 | PENDING/PARTIAL/UNKNOWN |
| 缓存 | 缺少统一 candidate/source/environment identity | 以 protocol/gate/input hash 精准复用和失效 |
| 回写失败 | 与 workflow phase 混合 | 技术结论与 Source Sync Status 分离 |
| 修复预算 | 失败后容易全量返工 | 每轨最多 2 轮，仅重跑失效门禁 |

待真实双写期采集的指标：

- 每个协议和风险等级的耗时；
- 重复门禁数量与缓存命中/错误命中；
- 旧/新结论差异及人工裁定；
- HARNESS/SOURCE_CONNECTOR/ENVIRONMENT 误归因；
- 错误自动推进和 source sync 重试；
- 每轨修复轮数。

## 4. 灰度顺序

1. `REPORT_ONLY`：旧 `workflow.phase` 保持主判定，新模型只读展示；
2. `DUAL_WRITE`：接入真实 DevBench Tab adapter 与 GateEngine 后双写，仍不自动推进来源；
3. 历史回放：用固定、脱敏、不可写的 golden stories 比较旧/新；
4. 有界自动修复：只允许低风险且最多两轮，HARNESS/SOURCE/ENVIRONMENT 不进入目标业务修复；
5. `PRIMARY`：仅在结论差异和错误升级清零、回滚演练完成后切换；
6. Source Sync 始终作为独立 saga，必须幂等、可重试、可审计。

## 5. 回滚

- 关闭 `acceptance.mode`/UI 入口并停止 v4.1 双写；
- 保留不可变来源快照、证据和 audit events，不做破坏性清表；
- 恢复旧主判定只影响决策读取，不覆盖 v4.1 历史；
- 如果候选或来源漂移，精确失效相关 Gate，不全量删除缓存。

当前不满足切换 PRIMARY 的条件：真实 DevBench Tab、既有 verify-runner、TB durable sync 与 v4.1 service 尚未形成权威桥接。
