# Bug 分析 Agent 总体设计方案 v2

**编制日期**：2026-04-24
**阶段**：设计定稿（待 Codex 交叉审查 + 用户确认后进入实施）
**版本说明**：v2 相比 v1 的主要变化
- 补齐三层存储架构（L1 会话记忆 / L2 证据库 / L3 记忆树）
- 明确 LLM 聚类方式、树深度、TTL 策略
- 纳入 5 条反方自审修正（冷启动、跨库一致性、评分公式、画像隐私、聚类可复现性）

---

## 0. 核心约束（不可妥协）

| 约束 | 说明 |
|---|---|
| **面向非开发人员** | 测试、产品、项目经理可直接使用，输入 TB 单即可获得分类与报告 |
| **证据链可回溯** | 每一条结论必须能下钻到原始 TB 单/日志片段，禁止 LLM 凭空编造 |
| **分类必须明确** | 非问题（环境/硬件）/ UI 问题 / 代码问题 / 其他，并给出置信度 |
| **Windows 本地单机** | 部署在 AIEfficiency 网关（Node.js），不引入独立数据库服务 |
| **自我进化** | 评分反哺规则权重，记忆树随时间生长，支持规则自动提炼（人工审核） |

---

## 1. 整体架构

```
                         ┌──────────────────┐
  TB 单 / 日志输入  ───▶│   Bug 分析 Agent   │───▶  分类 + 证据链 + 报告
                         │  (Skill 层)        │
                         └────────┬─────────┘
                                  │
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ L1 会话记忆      │  │ L2 证据库        │  │ L3 记忆树        │
  │ (短期工作记忆)   │  │ (结构化事实)     │  │ (语义索引)       │
  │                 │  │                  │  │                  │
  │ session_memory  │  │ cases + FTS5     │  │ memory_tree      │
  │ engineer_profile│  │ rules / reports  │  │ 3-4 层结构       │
  │ TTL: 7天/永久   │  │ 按 pkgName 分库  │  │ LLM 聚类(每日)   │
  └─────────────────┘  └──────────────────┘  └──────────────────┘
             │                    │                    │
             └────────────────────┴────────────────────┘
                         （统一存储：SQLite .db 文件）
```

---

## 2. 数据模型

### 2.1 分库策略

```
C:\ai\AIEfficiency\knowledge\
├── common.db                    # 公共库（Android/AAOS 通用规则）
├── apps\
│   ├── com.xxx.music.db         # 每应用一库，以 packageName 命名
│   ├── com.xxx.map.db
│   └── ...
└── backup\
    └── YYYY-MM-DD\              # 每日 cron 快照
```

**查询跨库**：不使用物理镜像，改用 SQLite 原生 `ATTACH DATABASE` 联合查询（消除同步延迟）。

### 2.2 表结构（每个 app.db 内）

```sql
-- L2：原始证据
CREATE TABLE cases (
  id            INTEGER PRIMARY KEY,
  tb_id         TEXT UNIQUE,              -- TB 单号
  package_name  TEXT NOT NULL,
  title         TEXT,
  raw_content   TEXT NOT NULL,            -- TB 单原文（完整保留）
  raw_log       TEXT,                     -- 原始日志附件引用（文件路径）
  category      TEXT,                     -- 非问题/UI/代码/其他
  sub_category  TEXT,
  confidence    REAL,                     -- Agent 分类置信度 [0,1]
  created_at    TIMESTAMP,
  analyzed_at   TIMESTAMP
);

-- L2：分析报告
CREATE TABLE reports (
  id            INTEGER PRIMARY KEY,
  case_id       INTEGER REFERENCES cases(id),
  content       TEXT,                     -- Markdown 报告
  evidence_refs TEXT,                     -- JSON: 引用的日志行号、字段
  matched_rules TEXT,                     -- JSON: 匹配到的 rule_id 列表
  matched_tree_nodes TEXT,                -- JSON: 匹配到的 node_id@version 列表
  created_at    TIMESTAMP
);

-- L2：规则库
CREATE TABLE rules (
  id            INTEGER PRIMARY KEY,
  pattern       TEXT,                     -- 匹配模式（关键词/正则）
  category      TEXT,
  conclusion    TEXT,                     -- 匹配后的结论模板
  rule_score    REAL DEFAULT 1.0,         -- 评分反哺而来
  hit_count     INTEGER DEFAULT 0,
  created_at    TIMESTAMP,
  updated_at    TIMESTAMP,
  status        TEXT DEFAULT 'active'     -- active/deprecated/pending_review
);

-- L2：评分
CREATE TABLE ratings (
  id            INTEGER PRIMARY KEY,
  report_id     INTEGER REFERENCES reports(id),
  rater_id      TEXT,
  score         INTEGER,                  -- 1-5
  comment       TEXT,
  channel       TEXT,                     -- web/feishu/api/cli
  created_at    TIMESTAMP
);

-- L2：FTS5 全文索引
CREATE VIRTUAL TABLE cases_fts USING fts5(
  tb_id, title, raw_content, raw_log,
  content=cases, content_rowid=id,
  tokenize='unicode61'
);

-- L3：记忆树
CREATE TABLE memory_tree (
  id           INTEGER PRIMARY KEY,
  parent_id    INTEGER REFERENCES memory_tree(id),
  level        INTEGER NOT NULL,          -- 0=root, 1=大类, 2=模式, 3=叶(可选)
  title        TEXT NOT NULL,
  summary      TEXT,                      -- LLM 生成的节点摘要
  case_ids     TEXT,                      -- JSON 数组，指向 cases.id
  weight       REAL DEFAULT 1.0,
  hit_count    INTEGER DEFAULT 0,
  version      INTEGER DEFAULT 1,         -- 节点版本（聚类更新时 +1）
  last_hit_at  TIMESTAMP,
  updated_at   TIMESTAMP
);

-- L3：聚类决策审计日志
CREATE TABLE memory_tree_change_log (
  id           INTEGER PRIMARY KEY,
  node_id      INTEGER,
  action       TEXT,                      -- create/update/split/merge/deprecate
  prompt       TEXT,                      -- 给 LLM 的 prompt 快照
  llm_output   TEXT,                      -- LLM 原始输出
  operator     TEXT DEFAULT 'system',     -- system/human:{userId}
  created_at   TIMESTAMP
);

-- L1：会话记忆
CREATE TABLE session_memory (
  id            INTEGER PRIMARY KEY,
  session_id    TEXT,
  case_id       INTEGER,
  content       TEXT,                     -- 工程师补充信息、中间推理
  expires_at    TIMESTAMP                 -- case 级：7 天后清理
);

-- L1：工程师画像（永久 + 软删除）
CREATE TABLE engineer_profile (
  user_id       TEXT PRIMARY KEY,
  expertise     TEXT,                     -- JSON: 擅长领域标签
  preferred_tools TEXT,                   -- JSON: systrace/logcat/...
  contribution_score REAL DEFAULT 0,      -- 贡献值（规则提炼、评分）
  archived_at   TIMESTAMP,                -- 软删除时间戳（离职 90 天归档）
  updated_at    TIMESTAMP
);
```

---

## 3. Agent 工作流程（端到端 8 步）

```
[步骤] 输入校验 & 路由
  ├─ 解析 TB 单：提取 packageName、标题、正文、附件
  └─ 路由到对应 app.db；未知 packageName → 挂公共库 + 新建 app.db

[步骤] 会话记忆检索 (L1)
  ├─ 查 engineer_profile（谁在提交，偏好什么）
  └─ 查 session_memory（同 session 的上下文）

[步骤] 记忆树下钻 (L3)
  ├─ 从 root 开始按关键词/embedding 相似度选择子树
  ├─ 下钻 2-3 层，收集候选节点（Top 5）
  └─ 汇总节点下的 case_ids

[步骤] 证据库精排 (L2)
  ├─ 在候选 case_ids 范围内做 FTS5 精排
  ├─ 若候选为空，降级为全库 FTS5 召回
  └─ 排序：节点 weight × 0.6 + case.rule_score × 0.4 + FTS bm25 × 权重

[步骤] 证据提取
  ├─ 从当前 TB 单中提取关键日志行号、异常栈、时间戳
  ├─ 与候选 case 对比，标注相似片段
  └─ 严禁编造：仅引用原文中出现过的字符串

[步骤] LLM 分类 & 结论生成
  ├─ 模型：Claude Haiku 4.5（成本优先）
  ├─ Prompt 包含：TB 原文 + Top 5 候选 case 摘要 + 匹配规则
  ├─ 输出：分类（非问题/UI/代码/其他） + 置信度 + 结论 + 证据引用
  └─ 低置信度（<0.6）时提示"建议人工复核"

[步骤] 报告落盘
  ├─ 写入 cases、reports 表
  ├─ 更新 rules.hit_count
  ├─ 更新 memory_tree.hit_count / last_hit_at
  └─ 写 session_memory（7 天 TTL）

[步骤] 反馈推送
  ├─ 返回 Web/飞书卡片
  ├─ 附评分入口（1-5 星 + 评论）
  └─ 低置信度分类附"补齐证据"按钮
```

---

## 4. 记忆树构建机制

### 4.1 冷启动（前 30 天）

**预置分类体系**（硬编码 25 个节点）：
```
root
├── 音频类问题
│   ├── 焦点管理 (AudioFocus 相关)
│   ├── 播放中断
│   └── 路由异常 (A2DP/USB/本地)
├── 渲染/UI 类问题
│   ├── Surface/SurfaceView
│   ├── 适配/分辨率
│   └── 动画卡顿
├── 权限/安全类问题
│   ├── Runtime Permission
│   └── Permission Denied
├── 稳定性问题
│   ├── ANR
│   ├── Native Crash
│   ├── Java Crash
│   └── OOM
├── 兼容性问题
│   ├── Android 版本
│   ├── AAOS 特性
│   └── 厂商定制
├── 网络/通信问题
│   ├── 请求超时
│   └── DNS/代理
├── 环境/硬件（非问题）
│   ├── 设备硬件故障
│   ├── 网络环境
│   └── 测试环境配置
└── 其他
    └── 待归类
```

**预置节点随 app.db 初始化脚本一起写入**，冷启动期立即可用。

### 4.2 增量聚类（每日 cron）

```
Cron: 03:00 每日
Job: memory-tree-cluster.js

流程：
1. 扫描过去 24 小时新入库的 case（SELECT ... WHERE created_at > ...）
2. 每应用库独立处理
3. 每批最多 50 条 case；超过则分批
4. 对每条 case：
   a. 先尝试挂到现有叶子节点（关键词匹配 + embedding top3）
   b. 若现有节点命中度 < 阈值（0.65），暂存"待归类"
5. 每日"待归类"累积 ≥ 10 条时：
   a. 调 LLM (Claude Haiku 4.5, temperature=0)
   b. Prompt: 这批 case 的摘要 + 现有树结构
   c. 输出: 新建叶子节点 or 扩展现有模式节点的建议
6. 写入 memory_tree_change_log，待人工审核
7. 人工审核通过后才真正落地到 memory_tree
```

**为什么不实时聚类**：
- token 成本：实时每 case 调 LLM 成本不可控
- 批处理提供"全局视角"，聚类质量更好
- 单点故障容忍：LLM 宕机不阻塞主流程

### 4.3 聚类可复现性保障

- **LLM 参数**：`temperature=0`，固定 `seed`
- **完整审计**：prompt + 输出快照写 `memory_tree_change_log`
- **节点版本号**：每次更新 version +1
- **报告引用**：报告中记录 `node_id@version`，回查可定位历史结构
- **回滚**：支持"恢复到 YYYY-MM-DD 00:00 的树结构"

### 4.4 树深度约束

- **最大 4 层**（root=0, 大类=1, 模式=2, 细粒度=3）
- 超过 4 层时触发"合并审核"（LLM 建议父节点合并策略，人工裁决）
- 单层节点 > 20 时触发"分裂审核"

---

## 5. 评分机制

### 5.1 评分渠道

| 渠道 | 入口 | 写入字段 |
|---|---|---|
| Web | Chat.jsx 报告底部 1-5 星 | ratings(channel=web) |
| 飞书 | 卡片交互按钮 | ratings(channel=feishu) |
| API | POST /api/rate | ratings(channel=api) |
| CLI | `aie rate <report_id> <score>` | ratings(channel=cli) |

### 5.2 权重更新公式（定稿）

```
-- 规则权重
rule_score = (1 - α) × rule_score + α × normalize(avg_score × log(1 + hit_count))
其中 α = 0.2（平滑系数），normalize 到 [0.1, 5.0]

-- 叶节点 weight
leaf.weight = avg(attached_cases.rule_score) × log(1 + node.hit_count)

-- 中间节点 weight
internal.weight = avg(children.weight) × (n / (n + 3))  -- n 为子节点数，3 为偏置项防止新节点权重暴涨

-- 冷节点衰减
每周 cron：30 天未命中 → weight *= 0.9；180 天未命中 → 归档

-- 全局归一化
每周 cron：min-max 归一化到 [0.1, 5.0]，防止数值漂移
```

### 5.3 低评分处理

- 单报告评分 ≤ 2 → 标记 `pending_review`，进规则复核队列
- 某规则近 10 次评分 avg ≤ 2.5 → 自动 `status=deprecated`，人工审核恢复

---

## 6. 自我进化

### 6.1 规则提炼流水线

```
触发: 每周日 04:00 cron
条件: 某类 case（同 category+sub_category）积累 ≥ 20 条且无对应 rule

流程:
1. LLM 分析这批 case 的共性
2. 输出候选规则（pattern + conclusion）
3. 写入 rules 表，status='pending_review'
4. 推送给管理员审核（飞书卡片）
5. 审核通过 → status='active'；拒绝 → 永久废弃并记录拒绝原因
```

### 6.2 规则演化

- 规则 hit_count 达标（如 ≥ 100）且 avg_score ≥ 4.0 → 提升为"高置信规则"（权重 ×1.5）
- 规则被新规则覆盖 → 软废弃（保留审计）

### 6.3 工程师画像自演化

- 画像由以下维度自动累积：
  - 贡献规则数、贡献规则平均评分
  - 评分参与度（被视为"活跃评审员"）
  - 补齐证据次数（低置信分类被他补齐的次数）

### 6.4 画像隐私策略

- 画像字段**仅记录正向能力**（擅长领域、偏好工具），不记录负面评价
- 离职员工：90 天冷却期后 `archived_at` 置位（软删除），查询时过滤
- 支持员工自查看/导出（透明度原则）
- 敏感日志加密：如 TB 单含 PII，启用 SQLCipher

---

## 7. 实施路线

| 阶段 | 工期 | 交付物 |
|---|---|---|
| **P0 MVP** | 2 天 | 单 case 端到端跑通（硬编码规则，无记忆树），验证证据链逻辑 |
| **P1a 证据库** | 3 天 | L2 完整表结构 + FTS5 + 分库脚本 + ATTACH 跨库查询 |
| **P1b 记忆树** | 1 周 | L3 预置 25 节点 + 每日聚类 cron + 审计日志 + 节点版本 |
| **P1c 会话记忆** | 3 天 | L1 session_memory + engineer_profile + 清理 cron |
| **P2 评分接入** | 1 周 | 四渠道评分入口 + 权重更新 + 召回排序优化 |
| **P3 自进化** | 1–2 周 | 规则自动提炼（人工审核）+ change_log + 回滚 |
| **P4 体验优化** | 1 周 | Chat.jsx 渲染 + 飞书/钉钉卡片 + 非开发文案打磨 |

**总计**：约 **5–6 周**

---

## 8. 技术栈 & 依赖

| 组件 | 选型 | 理由 |
|---|---|---|
| 存储 | SQLite (better-sqlite3) | 零运维、单文件分库、FTS5 原生支持 |
| 全文检索 | FTS5 + unicode61 tokenizer | 对中文 TB 单足够 |
| 向量检索（未来） | sqlite-vec 扩展（P2 后） | 仅在 FTS 召回精度不够时启用 |
| LLM（聚类/分类） | Claude Haiku 4.5 | 成本低，聚类摘要任务够用 |
| LLM（复杂推理） | Claude Sonnet 4.6 | 低置信案件、新规则提炼 |
| Cron | node-cron + 网关 /api/schedule | 持久化任务走网关 |
| Web 渲染 | Chat.jsx（AIEfficiency 现有） | 不新增前端技术栈 |
| 备份 | 每日 rsync + Litestream（可选） | SQLite 云备份方案 |

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| LLM 聚类随机性 | 树结构漂移 | temperature=0 + 节点版本号 + 审计日志 |
| SQLite 分库写锁 | 并发写冲突 | 网关单进程串行化；WAL 模式 |
| 证据被 LLM 编造 | 破坏可信度 | Prompt 强约束"仅引用原文"；输出后字符串回查校验 |
| 冷启动体验差 | 前 30 天无记忆树价值 | 预置 25 节点分类体系 |
| 画像数据滥用 | 隐私/合规风险 | 仅正向字段 + 软删除 + 自查看 |
| 评分通胀 | 权重失真 | 每周全局归一化 + 冷节点衰减 |

---

## 10. 待确认的决策点（最后一轮）

1. **预置 25 节点分类** —— 是否需要我与你对齐到具体包名（如音乐类应用的常见子分类）？
2. **LLM 聚类频率** —— 每日 03:00 是否冲突其他 cron？如需调整请指定
3. **画像字段范围** —— 是否严格限定为"正向能力"？是否允许记录"负责维护的模块"等中性字段？
4. **备份策略** —— 每日本地快照 + 云备份（S3/OSS）是否需要？还是仅本地？
5. **飞书卡片评分** —— 是否要对所有报告推送到飞书？还是仅工程师订阅的应用？

---

## 附录 A：与 v1 的 Diff

| 维度 | v1 | v2 |
|---|---|---|
| 存储层次 | 单层（知识库） | 三层（L1/L2/L3） |
| 分库策略 | 未明确 | 按 packageName 分库 + common.db + ATTACH 联合查询 |
| 召回策略 | FTS5 直查 | 会话记忆 → 树下钻 → FTS 精排 |
| 聚类机制 | 未涉及 | LLM 每日聚类 + 审计 + 版本 |
| 评分公式 | 大致描述 | 公式定稿 + 冷热衰减 + 全局归一化 |
| 画像隐私 | 未涉及 | 正向字段 + 软删除 + 员工透明度 |
| 冷启动 | 未涉及 | 预置 25 节点分类 |

---

**文档版本**：v2.0
**下一步**：Codex 交叉审查 → 用户裁决决策点 → P0 MVP 开工
