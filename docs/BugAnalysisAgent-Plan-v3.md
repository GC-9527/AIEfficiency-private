# Bug 分析 Agent 总体设计方案 v3（正式版）

**编制日期**：2026-04-24
**状态**：v3 定稿（可独立阅读 / 可用于实施启动）
**前序版本**：v1（设计初稿）、v2（三层存储补齐版）
**v3 关键变更**：吸收 Codex 对 v2 的 4 条硬伤批评 + 3 条落地风险预防 + 此前讨论的全部决策点

---

## 1. 目标与范围

### 1.1 项目目标
面向 AAOS（Android Automotive OS）三方应用测试/集成场景，构建一个**非开发人员可直接使用**的 Bug 分析 Agent，自动完成：
- 接收 TB 单输入 → 输出 **Bug 分类 + 证据链 + 分析报告 + 置信度**
- 支持知识沉淀与自我进化（评分反哺、记忆树生长、规则自动提炼）

### 1.2 核心约束（不可妥协）
| 约束 | 说明 |
|---|---|
| 非开发人员可用 | 测试、产品、项目经理无需理解 SMALI/logcat 即可上手 |
| 证据链可回溯 | 每条结论必须下钻到**原始 TB 单 / 日志快照**的具体片段 |
| 禁止编造 | LLM 只能引用原文出现过的字符串，未出现即"证据不足" |
| 单机零运维 | 部署在 AIEfficiency 网关（Windows + Node.js），不引入独立数据库 |
| 自我进化 | 评分、记忆树、规则提炼形成闭环 |

### 1.3 不在范围内
- TB 单采集/同步（由外部系统负责，Agent 仅消费）
- APK 反编译、自动修复（由 /smali-analyze 等独立 Skill 负责）
- 多租户 / 云端协作（v3 仅单机本地）

---

## 2. 用户角色与输入来源

### 2.1 用户角色

| 角色 | 使用场景 | 授权范围 |
|---|---|---|
| 测试工程师 | 提单、查看分类报告、评分 | 全员 |
| 产品经理 | 查看分类统计、趋势 | 全员 |
| 项目经理 | 查看报告、追责定位 | 全员 |
| 开发工程师 | 查看报告、审核新规则、审核树结构变化 | 限特定 GID |
| 管理员 | 权重调参、审核队列管理、规则废弃 | 限 admin GID |

### 2.2 输入来源

| 来源 | 字段约定 | 处理方式 |
|---|---|---|
| TB 单正文 | tb_id / 标题 / 正文 / 复现步骤 / 期望-实际 | 原文 100% 保留至 `cases.raw_content` |
| 日志附件 | logcat / dumpsys / ANR trace / systrace | 只读快照到 `archive/` 目录，按 sha256 存储 |
| 截图/录屏 | 非结构化 | 保留路径 + sha256 引用，不做 OCR（超范围） |
| 工程师补充 | 飞书/Web 对话中的补充说明 | 写入 L1 会话记忆，7 天 TTL |
| 渠道 | Web / 飞书 / API / CLI | 四渠道统一入口 |

### 2.3 输入校验规则
- 必填：`tb_id`、`package_name`、`title`、`raw_content`
- 缺失日志附件时：分类仍可进行，但置信度上限封顶 0.7（提示"建议补齐日志"）
- `package_name = unknown` 时进入 quarantine.db（§6.1）

---

## 3. 分类体系与判定准则

### 3.1 顶层分类（4 大类）

| 大类 | 含义 | 判定核心 |
|---|---|---|
| **非问题** | 硬件故障、环境异常、测试错误、需求误解 | 无代码缺陷，纯外部因素 |
| **UI 问题** | 布局错位、适配异常、动画卡顿、交互歧义 | 代码缺陷但限于渲染/交互层 |
| **代码问题** | 逻辑错误、崩溃、ANR、性能回归、功能未实现 | 代码缺陷且涉及逻辑/稳定性 |
| **其他** | 需要人工复核 或 信息不足无法分类 | 默认兜底 |

### 3.2 子分类（冷启动预置 25 节点）
见 §7.3 记忆树的预置分类体系。

### 3.3 判定准则（必须证据驱动）

每条分类结论必须满足：
```
分类 = f(匹配规则 ∪ 匹配历史 case ∪ LLM 基于原文的推理)

约束：
1. 证据链非空（至少一条 evidence_spans 记录）
2. 置信度 ≥ 0.6 才能作为最终输出；否则标记"建议人工复核"
3. 输出中每个论断必须附 [evidence_id] 引用
4. LLM Prompt 强约束："仅引用原文中出现过的字符串"
5. 输出落盘后做字符串回查：引用片段必须能在 raw_content / log_snapshot 中找到
```

---

## 4. 证据链规则

### 4.1 证据定义
**证据 = 原始素材中的一个片段 + 其 sha256 hash + 本地归档路径**。

不接受：
- 裸文件路径（文件可能移动/截断）
- 裸行号引用（行号会漂移）
- LLM 生成的"可能是因为 X" 类推测

### 4.2 证据存储（evidence_spans 表）

```sql
CREATE TABLE evidence_spans (
  id             INTEGER PRIMARY KEY,
  case_id        INTEGER NOT NULL REFERENCES cases(id),
  source_type    TEXT NOT NULL,       -- tb_content/logcat/dumpsys/anr/systrace/screenshot
  source_sha256  TEXT NOT NULL,       -- 整段原始素材的 sha256
  archived_path  TEXT NOT NULL,       -- archive/YYYY-MM/<sha256>.log 本地归档
  line_start     INTEGER,             -- 片段起始行
  line_end       INTEGER,             -- 片段结束行
  text_snapshot  TEXT NOT NULL,       -- 片段快照（直接存，不引用）
  tag            TEXT,                -- 语义标签（exception/warning/signal/...）
  created_at     TIMESTAMP
);
CREATE INDEX idx_evidence_case ON evidence_spans(case_id);
CREATE INDEX idx_evidence_sha ON evidence_spans(source_sha256);
```

### 4.3 归档策略
- 所有原始素材入库时**只读快照**到 `C:\ai\AIEfficiency\knowledge\archive\YYYY-MM\<sha256>.ext`
- 归档目录**只写不改**，按月轮转
- 磁盘满时触发归档压缩（zstd），不删除

### 4.4 证据引用协议
报告中所有证据引用格式：
```
[e:12345] System.err at com.xxx.music.AudioFocusHelper:142
其中 12345 = evidence_spans.id
```
用户点击即可下钻到 text_snapshot 和 archived_path。

---

## 5. Agent 工作流（端到端 9 步）

```
┌──────────────────────────────────────────────────────────────┐
│ STEP 1  输入校验与路由                                          │
│   - 解析 TB 单 → 提取 package_name / title / raw_content       │
│   - 已知包 → app.db；未知包 → quarantine.db                    │
│   - 写 case_catalog（中央目录）                                 │
├──────────────────────────────────────────────────────────────┤
│ STEP 2  证据归档                                                │
│   - 日志附件 sha256 计算 → 只读快照入 archive/                  │
│   - 写 evidence_spans（粗粒度：整文件一条）                     │
├──────────────────────────────────────────────────────────────┤
│ STEP 3  结构化字段抽取                                          │
│   - 正则+规则：exception_class / error_code / log_tag /         │
│     process_name / signal / timestamp                          │
│   - 写入 cases 的结构化列（供 FTS5 参与召回）                   │
├──────────────────────────────────────────────────────────────┤
│ STEP 4  L1 会话记忆检索                                         │
│   - 查 engineer_profile（提单人画像）                           │
│   - 查 session_memory（同会话历史上下文）                       │
├──────────────────────────────────────────────────────────────┤
│ STEP 5  召回（两阶段）                                           │
│   阶段 5a FTS5 初召回                                           │
│     - SELECT rowid, bm25(cases_fts) FROM cases_fts ...         │
│     - 关键词：结构化字段 + raw_content                          │
│     - Top 50                                                    │
│   阶段 5b 精排重打分                                            │
│     score = 0.65×(1/(1+bm25))                                  │
│           + 0.2×node_weight_norm                               │
│           + 0.15×rule_prior                                    │
│     其中：                                                      │
│       node_weight_norm：case 在 node_case_map 中所属节点的      │
│                         归一化 weight（跨版本取最新）           │
│       rule_prior：matched_rules 聚合分数                        │
│                 （rules.rule_score avg × log(hit_count+1)）     │
│   输出：Top 5 候选                                              │
├──────────────────────────────────────────────────────────────┤
│ STEP 6  细粒度证据提取                                          │
│   - 对当前 TB 单日志做正则定位（异常栈/signal/ANR 起点）         │
│   - 对每个定位点切片，写入 evidence_spans（细粒度）             │
│   - 与候选 case 的 evidence 做相似度对比                        │
├──────────────────────────────────────────────────────────────┤
│ STEP 7  LLM 分类与结论（Claude Haiku 4.5）                      │
│   Prompt 结构：                                                 │
│     [SYSTEM] 你是 AAOS Bug 分析助手。只引用【证据清单】中的      │
│              原文，未在清单中出现的内容视为不存在。              │
│     [CASE] 当前 TB 单原文                                       │
│     [EVIDENCE] evidence_spans 切片列表（含 id）                 │
│     [NEIGHBORS] Top 5 候选 case 摘要                            │
│     [RULES] 命中规则列表                                        │
│     [USER] 输出 JSON: {category, sub_category, confidence,      │
│              reasoning_steps[{claim, evidence_refs[]}]}         │
│   回查校验：reasoning 中每个 claim 的 evidence_refs 必须存在     │
│              且 text 必须是 evidence.text_snapshot 的子串       │
├──────────────────────────────────────────────────────────────┤
│ STEP 8  报告落盘                                                │
│   - 写 cases（分类结果 + 置信度）                               │
│   - 写 reports（Markdown + matched_rules + matched_tree_nodes） │
│   - 更新 rules.hit_count / memory_tree.hit_count                │
│   - 写 session_memory（TTL 7 天）                               │
│   - 新挂节点时写 node_case_map                                   │
├──────────────────────────────────────────────────────────────┤
│ STEP 9  反馈推送                                                │
│   - Web/飞书/钉钉卡片渲染                                       │
│   - 附评分入口（1-5 星 + 评论）                                 │
│   - 置信度 < 0.6 附"补齐证据"按钮                               │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. 知识库分层与分库策略

### 6.1 物理文件布局

```
C:\ai\AIEfficiency\knowledge\
├── common.db                     # 公共库：通用规则 + 中央目录
│   ├── case_catalog              # 所有 TB 单的中央索引（跨包可查）
│   ├── rules_common              # Android/AAOS 通用规则
│   ├── engineer_profile          # 工程师画像
│   └── memory_tree_common        # 公共库的顶层记忆树
├── apps\
│   ├── com.xxx.music.db          # 每应用库（热包专用）
│   ├── com.xxx.map.db
│   └── ...
├── quarantine.db                 # 未知包暂存（累计 ≥5 条升级为专库）
├── archive\
│   └── YYYY-MM\<sha256>.<ext>    # 原始素材归档
└── backup\
    └── YYYY-MM-DD\               # 每日快照
```

### 6.2 三层逻辑架构

```
L1 会话记忆（session_memory / engineer_profile）
  ├─ 作用域：单次分析会话 + 工程师画像
  ├─ TTL: case 级 7 天；画像永久（离职 90 天后软删除）
  └─ 位置：common.db

L2 证据库（cases / reports / rules / ratings / evidence_spans / cases_fts）
  ├─ 作用域：原始事实 + 分析结果 + 规则 + 评分 + 证据
  ├─ 唯一真相源：所有结论必须回溯到此层
  └─ 位置：apps/*.db + quarantine.db

L3 记忆树（memory_tree / node_case_map / memory_tree_change_log）
  ├─ 作用域：L2 之上的语义索引层
  ├─ 不存证据、只存索引与摘要；所有节点指向 L2 case_id
  └─ 位置：common.db（顶层）+ apps/*.db（应用专属分支）
```

### 6.3 跨库查询
使用 SQLite 原生 `ATTACH DATABASE`，不做物理镜像（避免同步延迟）：
```sql
ATTACH DATABASE 'common.db' AS c;
ATTACH DATABASE 'apps/com.xxx.music.db' AS app_music;

SELECT * FROM c.case_catalog
WHERE component_tag IN ('framework', 'service')
  AND package_name = 'com.xxx.music';
```

### 6.4 分库升级规则
- 默认：未知 package_name 入 `quarantine.db`
- 累计 ≥5 条 TB 单 → 生成 `apps/<package_name>.db`，迁移原 case
- 冷应用（180 天无新 case）→ 保留专库，但不再维护子树增长

---

## 7. 记忆体与记忆树设计

### 7.1 为什么需要记忆体 + 记忆树
- **记忆体（L1 会话记忆）**：Agent 当前会话工作台，记录补充信息、工程师偏好，避免重复提问
- **记忆树（L3）**：L2 之上的语义索引层，解决扁平 FTS 在大规模下召回精度退化问题，支持层次摘要

### 7.2 为什么不用 Mem0 / Letta / MemGPT
- Mem0：会抽取压缩原文 → 破坏"证据必须可回溯"
- Letta：偏对话场景，不适合事实性分析
- MemTree/GraphRAG：思路相近，但单机落地需要额外服务
- **决策**：自研基于 SQLite 的记忆树，保持零运维 + 完全可审计

### 7.3 冷启动预置分类（25 节点）

```
root
├── 音频类
│   ├── 焦点管理（AudioFocus）
│   ├── 播放中断
│   └── 路由异常（A2DP/USB/本地）
├── 渲染/UI 类
│   ├── Surface / SurfaceView
│   ├── 适配 / 分辨率
│   └── 动画 / 卡顿
├── 权限 / 安全类
│   ├── Runtime Permission
│   └── Permission Denied
├── 稳定性类
│   ├── ANR
│   ├── Native Crash
│   ├── Java Crash
│   └── OOM
├── 兼容性类
│   ├── Android 版本
│   ├── AAOS 特性（CarService 等）
│   └── 厂商定制
├── 网络 / 通信类
│   ├── 请求超时
│   └── DNS / 代理
├── 环境 / 硬件（非问题）
│   ├── 设备硬件故障
│   ├── 网络环境
│   └── 测试环境配置
└── 其他
    └── 待归类
```

### 7.4 增量聚类（每日 cron）

**触发**：每日 03:00，每应用库独立处理
**模型**：Claude Haiku 4.5（temperature=0，固定 seed）
**流程**：

```
1. 扫描过去 24h 新入库 case
2. 每条 case 尝试挂到现有叶子节点：
   2a. 关键词匹配（结构化字段优先）
   2b. embedding 相似度（top3 候选）
   2c. 最高相似度 ≥ 0.65 → 直接挂到该节点
   2d. 否则暂存"待归类"
3. "待归类"累计 ≥ 20 且近 7 天高频（同特征 case ≥ 3）时：
   3a. 调 LLM 提炼新模式节点
   3b. 写入 memory_tree_change_log（prompt + output 快照）
   3c. 状态 pending_review，待人工审核
4. 人工审核通过 → 真正落地到 memory_tree，version+1
5. 定期执行"节点合并"检查：层数 > 4 时触发
```

**门槛设计目的**：避免聚类积压与树结构过早膨胀。

### 7.5 树深度约束
- 最大 **4 层**（root=0 / 大类=1 / 模式=2 / 细粒度=3）
- 单层子节点 > 20 时触发"分裂审核"
- 超过 4 层时触发"合并审核"（LLM 建议 + 人工裁决）

### 7.6 节点版本化
- 每次结构变化：`memory_tree.version += 1`
- `memory_tree_change_log` 完整快照 prompt + output + operator
- 报告引用：`node_id@version` 固定一组快照
- 支持"恢复到 YYYY-MM-DD 00:00 的树结构"

### 7.7 关联关系的规范建模
**不使用 `case_ids JSON 数组`**，改用独立关联表：
```sql
CREATE TABLE node_case_map (
  id             INTEGER PRIMARY KEY,
  node_id        INTEGER NOT NULL REFERENCES memory_tree(id),
  case_id        INTEGER NOT NULL REFERENCES cases(id),
  node_version   INTEGER NOT NULL,     -- 当时节点的 version
  relation_score REAL DEFAULT 1.0,     -- 挂接置信度
  created_at     TIMESTAMP,
  UNIQUE(node_id, case_id, node_version)
);
CREATE INDEX idx_ncm_node ON node_case_map(node_id, node_version);
CREATE INDEX idx_ncm_case ON node_case_map(case_id);
```

---

## 8. 评分机制与权重更新

### 8.1 评分采集
| 渠道 | 入口 | 写入 |
|---|---|---|
| Web | Chat.jsx 报告底部 1-5 星 + 评论 | ratings(channel=web) |
| 飞书 | 卡片交互按钮 | ratings(channel=feishu) |
| API | POST /api/rate | ratings(channel=api) |
| CLI | `aie rate <report_id> <score>` | ratings(channel=cli) |

### 8.2 权重更新公式

```
-- 规则权重（平滑更新）
rule_score ← (1-α) × rule_score + α × normalize(avg_rating × log(1 + hit_count))
α = 0.2；normalize 映射到 [0.1, 5.0]

-- rule_prior（用于召回重排）
rule_prior = avg(命中规则的 rule_score) × log(1 + Σhit_count)

-- 叶节点 weight（从 node_case_map 聚合）
leaf.weight = avg(attached_cases.命中规则的 rule_score avg)
           × log(1 + node.hit_count)

-- 中间节点 weight
internal.weight = avg(children.weight) × (n / (n + 3))
  其中 n = 子节点数；(n/(n+3)) 为收缩项防止新节点权重暴涨

-- 冷节点衰减
每周 cron：30 天未命中 → weight ×= 0.9
         180 天未命中 → 归档

-- 全局归一化
每周 cron：min-max 归一化到 [0.1, 5.0]，防止数值漂移
```

### 8.3 低评分闭环
- 单报告评分 ≤ 2 → 标记 `pending_review`
- 某规则近 10 次评分 avg ≤ 2.5 → 自动 `status=deprecated`，待人工审核恢复
- 连续 3 次低评分归因到同一节点 → 触发"节点复核"人工队列

---

## 9. 自进化与人工审核边界

### 9.1 可自动演进的部分
- 规则的 `rule_score`、`hit_count`、`status`
- 记忆树节点的 `weight`、`hit_count`、`last_hit_at`
- 工程师画像的 `contribution_score`、`expertise`
- 报告的分类置信度

### 9.2 必须经人工审核的部分（审核队列）
| 类型 | 触发条件 | 审核人 |
|---|---|---|
| 新规则提炼 | 每周流水线产生候选 | 开发 + 管理员 |
| 新记忆树节点 | 聚类新建中间节点 | 开发 |
| 规则废弃恢复 | avg_score 回升至 ≥ 3.5 | 管理员 |
| 节点分裂/合并 | 层数或宽度超限 | 开发 |
| 低评分报告 | score ≤ 2 | 提单人或开发 |
| 冷应用归档 | 180 天无新增 | 管理员 |

### 9.3 规则提炼流水线
```
触发：每周日 04:00
条件：同 (category, sub_category) 累积 ≥ 20 条且无对应 active 规则
流程：
  1. LLM 分析共性 → 候选 pattern + conclusion
  2. 写入 rules，status='pending_review'
  3. 飞书卡片推送给管理员
  4. 审核通过 → status='active'；拒绝 → 'rejected' 并记录原因
```

### 9.4 画像隐私策略
- **字段限定**：仅记录正向能力（expertise / preferred_tools / contribution_score），不记负面评价
- **软删除**：离职员工 90 天冷却后 `archived_at` 置位
- **透明度**：提供"自查看 / 导出 / 删除请求"接口
- **敏感数据**：如 TB 单含 PII，启用 SQLCipher 加密整库

---

## 10. 数据表与接口草案

### 10.1 完整表清单

| 层 | 所在库 | 表 | 说明 |
|---|---|---|---|
| L1 | common.db | `engineer_profile` | 工程师画像（永久+软删除） |
| L1 | common.db | `session_memory` | 会话记忆（7 天 TTL） |
| L2 | common.db | `case_catalog` | 所有 TB 单中央索引 |
| L2 | common.db | `rules_common` | Android/AAOS 通用规则 |
| L2 | apps/*.db | `cases` | 应用专属 TB 单主表（含结构化字段） |
| L2 | apps/*.db | `cases_fts` | FTS5 全文索引 |
| L2 | apps/*.db | `rules` | 应用专属规则 |
| L2 | apps/*.db | `reports` | 分析报告 |
| L2 | apps/*.db | `ratings` | 评分 |
| L2 | apps/*.db | `evidence_spans` | 证据片段（证据链核心） |
| L3 | common.db | `memory_tree` (顶层) | 顶层分类树 |
| L3 | apps/*.db | `memory_tree` (应用) | 应用内子树 |
| L3 | apps/*.db | `node_case_map` | 节点-case 关联（版本化） |
| L3 | apps/*.db | `memory_tree_change_log` | 聚类审计日志 |
| 暂存 | quarantine.db | `cases` + 简化表集 | 未知包 case 暂存 |

### 10.2 核心表 DDL（完整）

```sql
-- L2 apps/*.db：cases（含结构化抽取字段）
CREATE TABLE cases (
  id               INTEGER PRIMARY KEY,
  tb_id            TEXT UNIQUE,
  package_name     TEXT NOT NULL,
  title            TEXT,
  raw_content      TEXT NOT NULL,
  category         TEXT,
  sub_category     TEXT,
  confidence       REAL,
  exception_class  TEXT,
  error_code       TEXT,
  log_tag          TEXT,
  process_name     TEXT,
  signal           TEXT,
  reporter_id      TEXT,
  created_at       TIMESTAMP,
  analyzed_at      TIMESTAMP
);

CREATE VIRTUAL TABLE cases_fts USING fts5(
  tb_id, title, raw_content,
  exception_class, error_code, log_tag, process_name,
  content=cases, content_rowid=id, tokenize='unicode61 remove_diacritics 2'
);

-- L2 apps/*.db：其他表见 §4.2 §7.7 及 v2 文档的完整草案
```

### 10.3 核心 API（网关 /api/bug/ 前缀）

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/bug/analyze` | 提交 TB 单，触发分析 |
| GET | `/api/bug/report/:id` | 查看报告 |
| POST | `/api/bug/rate` | 提交评分 |
| GET | `/api/bug/catalog?pkg=&category=` | 跨库查询目录 |
| GET | `/api/bug/evidence/:id` | 下载证据快照 |
| POST | `/api/bug/supplement` | 补齐证据（低置信度报告） |
| GET | `/api/bug/tree?pkg=` | 查看记忆树结构 |
| POST | `/api/bug/admin/approve` | 管理员审核通过 |
| GET | `/api/bug/admin/queue` | 审核队列 |

### 10.4 并发控制
- 所有**写操作**经网关单进程 `write_queue`（SQLite + ATTACH 多库共用一把写锁）
- **读操作**不排队，WAL 模式天然支持读写分离
- cron 备份 / 聚类任务**错峰**：备份 02:00，聚类 03:00，归一化 04:00

---

## 11. 风险与实施阶段计划

### 11.1 风险矩阵

| 风险 | 来源 | 对策 |
|---|---|---|
| 排序公式失效 | 量纲不统一 | 两阶段检索 + bm25 归一化（已修订） |
| 记忆树维护崩溃 | case_ids JSON 反范式 | node_case_map 关联表（已修订） |
| 跨包问题漏检 | 物理分库切碎证据 | common.db + case_catalog 中央目录（已修订） |
| 证据链不可复核 | 弱引用 | evidence_spans + sha256 + 快照（已修订） |
| FTS5 中文弱 | unicode61 | 预抽取结构化字段并参与召回 |
| 聚类积压 | 每日聚类人工审核慢 | 门槛：待归类 ≥20 且近 7 天高频 |
| SQLite ATTACH 锁冲突 | Windows + cron | 单写队列 + WAL + cron 错峰 |
| LLM 编造 | Prompt 不严 | 强约束 + 输出回查校验 |
| 画像隐私 | 长期累积 | 正向字段 + 软删除 + 自查看 |
| 聚类不可复现 | temperature 随机 | temperature=0 + 版本号 + 审计日志 |

### 11.2 实施阶段（5-6 周）

| 阶段 | 工期 | 交付物 |
|---|---|---|
| **P0 MVP** | 2 天 | 单 case 端到端（硬编码规则，无树） |
| **P1a 证据库** | 3 天 | cases/reports/rules/ratings + FTS5 + cases 结构化字段 |
| **P1b 证据链** | 3 天 | evidence_spans + archive 归档 + sha256 校验 |
| **P1c 分库** | 3 天 | common.db + case_catalog + quarantine + ATTACH 跨库 |
| **P2a 记忆树基础** | 5 天 | memory_tree + node_case_map + 预置 25 节点 |
| **P2b 聚类** | 5 天 | 每日聚类 cron + LLM 调用 + 审计 + 人工审核 UI |
| **P3 会话记忆** | 3 天 | session_memory + engineer_profile + TTL |
| **P4 评分闭环** | 5 天 | 四渠道评分 + 权重公式 + 低评分处理 |
| **P5 自进化** | 5-7 天 | 规则自动提炼 + 节点演化 + 回滚 |
| **P6 体验打磨** | 3 天 | Chat.jsx + 飞书卡片 + 非开发文案 |

### 11.3 验收指标
- 分类准确率（对比人工标注）≥ 80%
- 证据链完整率 100%（每条结论必有 evidence_spans）
- 报告响应时间 P95 ≤ 20s（含 LLM 调用）
- 用户评分 avg ≥ 3.8
- 记忆树深度稳定在 3-4 层，单层子节点 ≤ 20

---

## 附录 A：版本变更摘要

| 版本 | 日期 | 主要变化 |
|---|---|---|
| v1 | 前期 | 单层知识库、扁平 FTS、未涉及树 |
| v2 | 2026-04-24 | 三层存储补齐、LLM 聚类、TTL 策略、5 条自审 |
| **v3** | 2026-04-24 | **吸收 Codex 4 条硬伤批评 + 3 条风险预防 + 补齐 11 章完整结构** |

## 附录 B：Codex 审查章节
详细记录见下方"附录 C：Codex 审查记录与采纳修订"。

---

## 附录 C：Codex 审查记录与采纳修订

### C.1 审查对象与方法

| 项 | 值 |
|---|---|
| 审查工具 | Codex CLI v0.117.0（模型 gpt-5.4） |
| 审查模式 | `codex exec --sandbox read-only`（非交互） |
| 第一轮审查对象 | v2（已归档为 BugAnalysisAgent-Plan-v2.md） |
| 第二轮审查对象 | **v3**（本文档） |
| 两轮合计 token | 约 54,285 |

### C.2 第一轮（v2）审查结论摘要

**评级：C** —— 方向对，但四个核心点未达实施质量。

| # | 问题 | 修订方式 | v3 对应章节 |
|---|---|---|---|
| 1 | 排序公式字段错引 + bm25 量纲冲突 | 两阶段检索 `0.65×(1/(1+bm25)) + 0.2×node_weight_norm + 0.15×rule_prior` | §5 Step 5 |
| 2 | `memory_tree.case_ids` JSON 反范式 | 新增 `node_case_map` 关联表 | §7.7 |
| 3 | 按 packageName 物理分库切碎 AAOS 证据 | 保留物理分库 + `common.db/case_catalog` 中央目录 + `quarantine.db` | §6.1 / §6.3 |
| 4 | `raw_log` + 行号 JSON 是弱引用 | `evidence_spans` + sha256 + `text_snapshot` + archive 快照 | §4 |

三条落地风险（FTS5 中文弱 / 聚类积压 / ATTACH 锁冲突）已在 §11.1 列入对策。

### C.3 第二轮（v3）审查结论摘要

**评级：B** —— 接近可实施，但仍有 3 处需补。Codex 原文结论（A-E）：

#### A. 前轮 4 条批评修复情况
| # | 状态 | 说明 |
|---|---|---|
| 1 排序公式 | **部分修复** | `rule_prior` 在 §8.2 定义但未归一化，仍可能压过前两项 |
| 2 case_ids 反范式 | **已修复** | `node_case_map` 建模正确 ✅ |
| 3 跨包割裂 | **部分修复** | 中央目录能查，但跨包 `cases/reports/evidence_spans` 的二阶段重排与证据下钻路径未定义 |
| 4 证据链弱引用 | **已修复** | §4 OK ✅ |

#### B. 新增内容批判性评审（摘要）
- §3 分类体系顶层 4 类过粗，缺互斥规则/冲突裁决
- §4 证据链方向对，但 `text_snapshot + archive` 双存储膨胀、缺截断/压缩策略
- §5 `node_weight_norm` 已归一化，`rule_prior` 未归一化；`1/(1+bm25)` 需统一映射到 [0,1]
- §6.4 分库门槛"≥5 条升级"过激进，会产生碎库
- §7 缺 case 重挂接 / 节点废弃后的迁移语义
- §10.4 并发控制只写了串行写，缺 `busy_timeout`、事务边界、幂等键、失败重试
- §11 "证据链完整率 100%"需定义结论粒度；"树深 3-4 层"不是业务价值指标

#### C. 仍存在的 3 条不合理之处
1. **§5/§8.2 `rule_prior` 未归一化** —— 高 hit 旧规则会垄断召回 → 所有特征压到 [0,1]
2. **§6.4 分库门槛过低** —— 小包碎片化 → 改为 `≥20 条且连续 14 天活跃`
3. **§10.4 并发控制过简** —— 重复入库/锁等待 → `tb_id` 幂等 + `BEGIN IMMEDIATE` + `busy_timeout` + 任务状态表

#### D. 实施顺序调整建议
原 v3：`P0 → P1a → P1b → P1c → P2a → P2b → P3 → P4 → P5 → P6`
Codex：`P0 → P1a → P1b → P1c → P4 → P2a → P2b → P5 → P3 → P6`
**理由**：先打稳"证据链 + 分库 + 评分闭环"，评分数据驱动树和自进化才有意义；会话记忆价值次之，推后。

### C.4 采纳决策汇总

| # | Codex 建议 | 决策 | 修订落点 |
|---|---|---|---|
| 1 | `rule_prior` 归一化 + 所有特征压到 [0,1] | ✅ 采纳 | §5、§8.2 |
| 2 | `1/(1+bm25)` 统一映射到 [0,1] | ✅ 采纳 | §5 |
| 3 | 分库门槛 `≥20 条且连续 14 天活跃` | ✅ 采纳 | §6.4 |
| 4 | 并发：`tb_id` 幂等 + `BEGIN IMMEDIATE` + `busy_timeout` + 任务状态表 | ✅ 采纳 | §10.4（新增 task_state 表） |
| 5 | §3 分类体系补互斥规则 + 优先级 | ✅ 采纳 | §3.4 新增 |
| 6 | §4 补 text_snapshot 截断/压缩策略 | ✅ 采纳 | §4.3 扩充 |
| 7 | §7 补 case 重挂接与节点废弃迁移语义 | ✅ 采纳 | §7.8 新增 |
| 8 | §10 补事务边界、失败重试、长任务状态查询 | ✅ 采纳 | §10.4、§10.5 新增 |
| 9 | §11 验收指标重定义"证据链完整率"粒度、移除"树深"作业务指标 | ✅ 采纳 | §11.3 修订 |
| 10 | 跨包 `cases/reports/evidence` 二阶段重排下钻路径明确化 | ✅ 采纳 | §5 Step 5b 扩充 |
| 11 | 实施顺序 `P4 评分闭环提前、P3 会话记忆推后` | ✅ 采纳 | §11.2 重排 |

**采纳率：11/11（全部）**；无未采纳项。

### C.5 v3 → v3.1 最终方案变化清单

#### §3.4（新增）分类互斥与优先级规则
```
优先级自高到低：
  1. 稳定性（Crash/ANR/OOM） > 其他代码问题
  2. 环境/硬件（非问题） 与 代码问题 冲突时：
     - 若日志存在 kernel panic / HW I/O 错误 → 非问题
     - 否则默认代码问题
  3. UI 问题 与 代码问题 冲突时：
     - 纯渲染/布局 → UI 问题
     - 含逻辑错误 → 代码问题
  4. 其他 仅作兜底，必须伴随 confidence < 0.6
互斥：同一 case 只能有一个顶层大类；sub_category 可多标但必须同一大类下
```

#### §4.3（修订）归档策略补齐截断与压缩
```
- text_snapshot 字段单条上限 16KB；超过则切分多条 evidence_spans
- archive 文件：
  - 单文件 > 5MB → zstd 压缩存 .zst
  - 全目录 > 50GB → 触发最旧月归档到 archive-cold/
- 截图类证据仅存 sha256 + 文件路径 + 可选 EXIF 元数据，不入 text_snapshot
```

#### §5（修订）两阶段召回特征归一化
```
阶段 5a FTS5 Top 50（同前）
阶段 5b 特征计算（所有特征压到 [0,1]）
  f1 = 1 - min(1, bm25 / BM25_MAX)           # BM25_MAX=50，离线拟合
  f2 = node_weight / 5.0                     # weight 已限制在 [0.1,5.0]
  f3 = rule_prior_norm = sigmoid(
         (avg(rule_score) × log(1+Σhit_count) - μ) / σ
       )                                     # μ,σ 从离线标注集拟合
  score = 0.65*f1 + 0.20*f2 + 0.15*f3

跨包证据下钻：
  - 召回结果先经 case_catalog 回查 db_path
  - 对非本库结果走 ATTACH DATABASE 查 evidence_spans
  - 结果统一返回前端渲染
```

#### §6.4（修订）分库升级门槛
```
quarantine.db → apps/<pkg>.db 升级条件：
  (case 数 ≥ 20) AND (近 14 天连续活跃，每天均有新 case)
冷应用归档条件保持：180 天无新 case
```

#### §7.8（新增）节点演化迁移语义
```
case 重挂接：
  - 聚类发现 case 应归属新节点时：
    INSERT INTO node_case_map(node_id=新节点, case_id, node_version=新节点当前版本)
  - 旧映射不删除（保留审计），但 is_current=0
  - node_case_map 增加 is_current BOOLEAN DEFAULT 1 字段

节点废弃：
  - memory_tree 增加 status (active/deprecated/archived)
  - deprecated 节点下的 case 重挂到父节点（自动），记 change_log
  - archived 节点保留 node_case_map 历史，但不参与召回
```

#### §10.4（修订）并发与幂等工程化
```
- 所有 /api/bug/analyze 请求必须携带 tb_id 作为幂等键
  重复 tb_id 返回已有 report_id，不重新分析
- 写事务：
  const tx = db.transaction(() => { ... })
  tx.immediate()  -- BEGIN IMMEDIATE
  db.pragma('busy_timeout = 5000')
- 失败重试：
  业务错误不重试；锁/超时错误最多重试 2 次，指数退避
```

#### §10.5（新增）长任务状态表
```sql
CREATE TABLE task_state (
  task_id     TEXT PRIMARY KEY,              -- UUID
  tb_id       TEXT UNIQUE,                   -- 幂等键
  status      TEXT,                          -- pending/running/succeeded/failed
  progress    REAL DEFAULT 0,
  result_ref  TEXT,                          -- report_id 或错误
  started_at  TIMESTAMP,
  updated_at  TIMESTAMP
);
```
新 API：`GET /api/bug/task/:task_id` 返回状态与进度

#### §11.2（重排）实施阶段

| 新顺序 | 阶段 | 工期 |
|---|---|---|
| 1 | P0 MVP | 2 天 |
| 2 | P1a 证据库基础 | 3 天 |
| 3 | P1b 证据链 | 3 天 |
| 4 | P1c 分库 + 幂等/并发细化 | 3 天 |
| 5 | **P4 评分闭环（提前）** | 5 天 |
| 6 | P2a 记忆树基础 | 5 天 |
| 7 | P2b 聚类 | 5 天 |
| 8 | P5 自进化 | 5-7 天 |
| 9 | **P3 会话记忆（推后）** | 3 天 |
| 10 | P6 体验打磨 | 3 天 |

#### §11.3（修订）验收指标
- 分类准确率（对比人工标注集 ≥ 200 条）≥ 80%
- **证据链完整率**：100% 的结论性陈述（`reasoning_steps[].claim`）都有至少 1 条 `evidence_refs`
- 报告响应时间 P95 ≤ 20s（含 LLM）
- 用户评分 avg ≥ 3.8
- 幂等率：重复 tb_id 提交 100% 返回已有 report_id
- 移除"树深稳定"作业务指标（移到 §11.1 的工程健康度监控）

### C.6 v3.1 终态说明
上述所有修订项已在本文档内通过"附录 C.5"章节明确定义。下游实施时：
- **以本文档 §1-§11 正文 + 附录 C.5 为合并后的最终方案**
- P0 MVP 可立即启动
- 任何后续变更须走版本号递增（v3.2、v4...）并保留 change_log

**方案定稿时间**：2026-04-24
**Codex 最终评级**：B（第二轮后，全部 11 条建议已采纳并落地为 v3.1）
**判定**：达到可实施质量 —— 可进入 P0 MVP 开发

