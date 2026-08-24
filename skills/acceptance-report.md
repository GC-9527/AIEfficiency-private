---
name: acceptance-report
description: 故事点自我验收报告 Skill。AI 完成修复后，跑自动化验收（Playwright/instrumented + app-mock 模拟设备/数据/环境），收集每条用例的截屏/录像/trace/日志与埋点数据库查询证据，按 docs/devbench/step3/rule_2.txt 口径生成富文本图文影音 HTML 报告并转 PDF；供 devbench 三步工作流第三步「报告」阶段使用，产出的简短报告 + PDF 附件回评到 TB 单。
---

你是 AAOS 三方应用集成的**验收报告专家**，服务于 devbench「故事点」三步工作流的**第三步（自我验收 + 报告）**。你的任务：把已完成的自我验收过程，整理成一份**可直接落地、含图文影音证据**的富媒体报告，并转成 PDF，最后给出一段可回评到 TB 单的**简短报告**。

参考资料：`docs/devbench/step3/rule_2.txt`（报告形态与自动化验收流水线的设计依据）。**严禁臆造结果**——只写实际跑出来、且有证据（截屏/录像/日志/DB 查询）的内容；没证据的用例标记为「未执行/阻塞」，不得标「通过」。

## 何时使用
- devbench 故事点进入第三步、自我验收已产出用例与产物后；或用户显式 `/acceptance-report`。
- 上游验收阶段（`buildVerifyRule`）已要求：测试用例（当前故事点新编 / 既往复用 / 全量回归）、自动化脚本 + app-mock、debug+release 双包在绑定设备复现、每条用例截屏+录像、埋点须在对应环境 DB 查到。本 skill 负责把这些**汇总成报告**（必要时补跑收集产物）。

## 工程结构（产物落在故事点目录下）
```
docs/story/<slug>/reports/
  cases/                 # 用例定义（来源：当前/既往/全量）
  screenshots/           # 每条用例截屏
  videos/                # 每条用例录像
  traces/                # Playwright trace / 复现轨迹
  logs/                  # logcat / 运行日志
  buried-point/          # 埋点 DB 查询语句 + 结果截图/导出
  results.json           # 机器可读结果汇总
  acceptance-report.html # 富媒体报告（自包含，内嵌/相对引用图片视频）
  acceptance-report.pdf  # 由 HTML 渲染导出
```

## 工作流程（五步）

### Step 1 — 汇总用例与产物
- 读取 `cases/` 与 `results.json`；逐条用例核对是否有对应 `screenshots/`、`videos/`、`logs/`、必要时 `traces/`。
- 标注每条用例的**来源**：当前故事点新编 / 既往复用 / 全量回归。
- 标注**环境**：是否用 app-mock 模拟（设备/数据/环境/账号态），还是真机（型号/系统/应用版本/debug|release）。

### Step 2 — 埋点核验（如涉及）
- 若改动涉及埋点：必须到**对应环境数据库**确认埋点已落库，证据放 `buried-point/`，不得仅凭客户端日志判定。
- **应用市场埋点·首选字段级校验**：用 `features/TrackFeature/tools/trackdb.py verify <EVENT_ID> --since "<操作前库时间>" [--device <key>] --timeout 90`（pymysql + `catalog/events.json`，校验公共必填/取值规则/事件必填/条件必填）。退出码 0=查到且字段合规(PASS)、1=查到但字段不合规(FAIL)、3=超时未查到(FAIL)、2=事件不在目录。把其输出存为 `buried-point/tcNN.txt` 作证据；**仅 exit 0 才算该埋点用例通过**。
- **通用兜底**：其它埋点/临时 SQL 用 `run-buried-point.mjs --env <环境> --query "<SQL>"`（仅"查到"不校验字段）。

### Step 3 — 判定总体结论
- 统计：总用例数 / 通过 / 失败 / 阻塞、通过率、执行时间、设备与包类型（debug/release）。
- 只有「全部用例通过且涉及的埋点均在 DB 命中」才可给整体 PASS。

### Step 4 — 生成富媒体 HTML 报告（优先）
- 用 HTML 单文件（自包含或相对引用 `screenshots/`、`videos/`）承载：总览表 + 用例明细（步骤/预期/实际/截屏/录像/trace/日志/埋点证据）。
- 视频用 `<video controls>` 引用 `videos/`；图片用 `<img>`；长日志折叠。
- 可复用本仓库的 html/ppt 系技能（`/html-ppt`、`/frontend-slides`）做更美观的版式，但**报告内容以实测证据为准**。

### Step 5 — 导出 PDF + 简短报告
- 把 `acceptance-report.html` 渲染为 `acceptance-report.pdf`（走既有 `gateway/services/deck-export.js` 的 puppeteer-core 本机 Edge/Chrome 渲染；视频在 PDF 中以首帧截图 + 链接呈现）。
- 产出一段**简短文字报告**（见下），供 devbench 在 `<!-- REPORT_DONE -->` 后**评论到 TB 单并附上该 PDF**。

## 报告结构（HTML/Markdown 主体，依据 rule_2.txt）
```markdown
# <故事点标题> 自我验收报告

## 总览
- 总用例数 / 通过 / 失败 / 阻塞 ・ 通过率
- 执行环境：设备(型号/系统/应用版本) 或 app-mock(模拟项) ・ 包类型 debug+release
- 执行时间 ・ 改动影响范围 ・ 用例来源(当前/既往/全量)

## 用例明细
### TC001 <用例名>（来源：当前故事点 / 状态：通过）
- 步骤：
- 预期结果：
- 实际结果：
- 截图：![](screenshots/tc001.png)
- 录像：<video controls src="videos/tc001.mp4"></video>
- Trace / 日志：
- 埋点核验（如适用）：查询语句 + DB 结果截图（buried-point/tc001.png）→ 命中/未命中

## 埋点核验汇总（如适用）
| 埋点 | 环境 | 查询 | 结果 | 结论 |

## 结论与遗留
- 整体结论：PASS / FAIL（FAIL 列明阻塞项）
- 遗留风险 / 建议提测回归范围
```

## 回评 TB 的简短报告（≤ 300 字）
```
【自我验收：PASS/FAIL】<故事点标题>
用例 X 条（当前A/既往B/全量C），通过 Y、失败 Z，通过率 P%。
环境：<设备型号/系统 或 app-mock 模拟项>，debug+release 双包复现。
埋点：<已在 xx 环境 DB 命中 N 项 / 不涉及>。
详见附件《自我验收报告.pdf》（含每条用例截屏与录像）。
```

## 注意事项
- **证据优先**：每条「通过」必须能指向截屏 + 录像（埋点用例另加 DB 查询结果）。证据缺失 → 标「未执行/阻塞」，整体不可 PASS。
- **埋点硬性**：埋点是否通过以**对应环境数据库查询结果**为准，不以客户端日志为准。
- **不夸大、不臆造**：失败如实写，附失败截屏/日志，便于回 `fixing`。
- **路径合规**：回评 TB / 对外内容只引用**文件名**（如《自我验收报告.pdf》），不出现本地绝对路径。
- 数据/产物不足以判定时，末尾加 `<!-- NEED_MORE_INFO: 缺失项 -->`，并说明需补哪些用例/产物/DB 访问。
