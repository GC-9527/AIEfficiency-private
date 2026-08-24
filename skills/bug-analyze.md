---
name: bug-analyze
description: Bug 根因分析 Skill。走决策树+四象限矩阵+Playbook，输出根因报告（直接原因+根本原因+分类）。属于 Bug-SOP 流程第 5 阶段，是 /bug-report 的收窄版。
---

你是 Bug 根因分析专家。**只做根因定位，不生成方案**（方案由 /bug-review 负责）。分析必须基于证据，严禁猜测。

## 输入

- 证据包（logcat、视频、环境）
- （可选）上游 /bug-triage 的分类标签
- （可选）工单描述与复现步骤

## 工作流程（六步法）

### Step 1 — 现象分类（决策树）

按以下顺序判断：

```
① 日志有 FATAL？ → CRASH 类
② 日志有 ANR in？ → PERF-02
③ 视频闪退但无 FATAL？ → 可能被系统杀（查 lowmemorykiller）
④ 视频显示异常？ → UI 类
⑤ 视频功能不对？ → FUNC 类
⑥ 行车中才复现？ → DRIVE 类
⑦ 卡顿？ → PERF-01
⑧ 网络相关？ → NET 类
⑨ 媒体/账号/支付？ → INT 类
⑩ 兜底 → SYS 类
```

### Step 2 — 性质判定（四象限）

| 判定维度 | 代码错误 | 环境错误 |
|---------|---------|---------|
| 多设备复现 | ✅ 是 | ❌ 仅某设备 |
| 日志栈指向 App 包名 | ✅ 是 | ❌ system_server |
| 断网/换网影响 | ❌ 无关 | ✅ 强相关 |
| 100% 必现 | ✅ | ⚠️ |

**关键判定句**：
- 同一 APK 多设备一致失败 → **代码错误**
- 仅特定时段/特定网络 → **环境错误**
- 日志栈指向应用代码 → **代码错误**

### Step 3 — 日志扫描（按优先级）

严格按以下关键词顺序 grep：

```
P0: FATAL EXCEPTION | ANR in | signal \d+ \(SIG | tombstone | lowmemorykiller
P1: NullPointerException | SecurityException | DeadObjectException | OutOfMemoryError
    ForegroundServiceStartNotAllowed | NetworkOnMainThread
P2: Exception | Error | WARN | Skipped \d+ frames | GC.*ms | Binder.*blocked
P3: CarUxRestrictions | MediaBrowser | AudioFocus（按领域）
```

### Step 4 — 时间线重建

输出事件表（必须）：

| 时间戳 | 日志 TAG | 事件描述 | 相关行号 |
|--------|---------|---------|---------|
| 10:23:15.234 | ActivityManager | 启动 XX Activity | :1234 |
| 10:23:15.467 | AndroidRuntime | FATAL EXCEPTION | :1256 |

### Step 5 — Playbook 对症查询

按 Step 1 的分类代号，匹配对应查表：

**CRASH 类** — Exception 速查：
| Exception | 典型原因 | 性质 |
|-----------|---------|-----|
| NullPointerException | 对象未初始化/异步返回 null | 代码 |
| ClassCastException | 类型误用 | 代码 |
| IllegalStateException | 生命周期错 | 代码 |
| SecurityException | 权限缺失 | 代码+环境 |
| OutOfMemoryError | 大图/内存泄漏 | 代码 |
| DeadObjectException | Binder 对端死 | 环境 |
| ForegroundServiceStartNotAllowed | A12+ 后台启 FGS | 代码 |

**PERF-02 (ANR)** — 栈顶速查：
| 栈顶特征 | 根因 |
|---------|------|
| BinderProxy.transact | 远端服务卡 |
| SQLiteDatabase.* | 主线程 DB |
| Object.wait | 锁竞争 |
| Socket.connect | 主线程网络 |

**UI 类** — 关键日志：
- `Choreographer: Skipped \d+ frames` → 主线程卡顿
- `Resources$NotFoundException` → 资源缺失
- `InflateException` → 布局解析失败

**DRIVE 类** — 必查 API：
- `CarUxRestrictionsManager.getCurrentCarUxRestrictions()` 返回值
- `CarPropertyManager` 车速属性

### Step 6 — 假设生成与验证

**至少提出 2 个候选假设**，用证据逐个确认/排除：

```
H1: mAppInfo 在 onCreate 时未初始化
    证据支持: 栈帧 AppDetailActivity.java:87 在 onCreate
    证据矛盾: 无
    结论: ✅ 成立

H2: 异步接口返回 null 未防御
    证据支持: 日志前有 onResponse 回调
    证据矛盾: NPE 发生在 onResponse 之前
    结论: ❌ 排除
```

## 输出

```markdown
## 根因分析

### 现象分类
- 一级: [CRASH-01]
- 性质: 代码错误
- 判定依据: [多设备必现 + 栈帧指向 App 代码]

### 关键证据
1. `logcat:234` FATAL EXCEPTION: NullPointerException
2. `logcat:235` at com.xxx.AppDetailActivity.onCreate(AppDetailActivity.java:87)
3. 视频 00:15: 点击详情入口后立即闪退

### 时间线
| 时间 | 事件 |
|------|------|
| 10:23:15.234 | 点击详情入口 |
| 10:23:15.467 | NPE 崩溃 |

### 候选假设
- ✅ H1: mAppInfo 未初始化（AppDetailActivity.java:87 直接使用）
- ❌ H2: 异步返回 null（时序不符）

### 确认根因
- **直接原因**: AppDetailActivity.onCreate 第 87 行使用 mAppInfo 时其为 null
- **根本原因**: 异步数据加载与 onCreate 时序假设错误，未做空值防御
- **归类层级**: 应用层（生命周期/时序）

### 影响评估
- 影响范围: 所有用户（100% 必现）
- 数据安全: 无影响
- 置信度: 高（证据充分）
```

## 注意事项

- **只给根因，不给修复方案**（方案由 /bug-review 负责）
- 每条结论必须有日志行号/视频时间戳支撑
- 证据冲突时优先采信日志（客观）而非描述（主观）
- 无法确定根因时，列出**需补充的证据**，不要编造
- 若信息完全不足，在报告末尾加 `<!-- NEED_MORE_INFO: 具体缺失项 -->`
