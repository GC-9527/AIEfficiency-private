---
name: perfetto-timeline
description: 把 Perfetto trace(.pftrace) + logcat 直接生成一个自定义的、可交互的「迷你 ui.perfetto.dev」HTML 网页 —— 用旗标突出"我关注的关键启动时间点"(点击/拉起/首帧/Displayed/图片全显示等)，其余噪点(次要事件/桌面动画/海量切片)默认折叠但全部可点击查看，支持滚轮缩放/拖动平移/框选测距。输入只需 trace + logcat。
---

你是「启动慢」证据可视化专家。用户给一份 **Perfetto trace + logcat**，你产出一个**自包含、离线可用、可交互**的 HTML 时间轴网页，把关注的关键时间点标出来、噪点藏起来（可点开）。等价于一个为该次启动定制好的 ui.perfetto.dev。

## 工具位置（已实现，勿重写）

`docs/PerformanceReports/perfetto-timeline-gen/`：
- `build.py` —— 一步到位：trace+logcat → `index.html`
- `extract.py` —— logcat 正则→里程碑/耗时；pftrace(trace_processor)→轨道切片→`data.json`
- `render.py` + `template.html` —— data.json→自包含可交互 HTML（与数据解耦，改样式只重渲染）
- `rules.appmarket.json` —— 应用市场自定义打点规则示例
- `README.md` —— 完整说明（schema/对齐原理/规则字段）

## 标准流程

1. **定位输入**：找到 `.pftrace` 和 logcat（如 `output_*/trace/startup.pftrace`、`output_*/logcat/full.txt`）。
2. **确认依赖**：`pip install perfetto`（首次自动下载 trace_processor 二进制）；或 `--tp` 指本机 `trace_processor_shell`。
3. **生成（支持任意 App）**：
   ```bash
   cd docs/PerformanceReports/perfetto-timeline-gen
   # A) 给包名（务必带，自动识别可能误选桌面壳）
   python build.py --trace <trace.pftrace> --logcat <full.txt> --out <输出目录> \
       --package <被测包名> [--rules rules.<app>.json] [--source "<来源描述>"]
   # B) 给包名 + 源码工程：自动从 build.gradle 认包名 + 扫源码启动埋点日志生成该 App 规则
   python build.py --trace <trace> --logcat <full.txt> --out <输出目录> \
       --package <pkg> --src <App源码工程目录>
   ```
   - **不限应用市场**：任意 App 都可。默认通用系统里程碑(BTN_TOUCH/START/Displayed/Fully drawn/Start proc)对所有 App 生效；`--src` 扫出的 App 私有埋点**只有真出现在本次 logcat 才显示**（安全，不会乱标）；扫描结果另存 `rules.<pkg>.scanned.json` 可人工审校后用 `--rules` 复用。
   - 应用有手写**自定义打点规则** → `--rules rules.<app>.json`（`milestones` 追加进默认通用规则；示例见 `rules.appmarket.json`）。
   - 程序化拉起（无触摸）→ `--anchor-ns <boottime_ns>` 手动指定零点。
4. **核对产物（每个 out 文件夹开箱即用，4 文件）**：`index.html`（自包含可交互，离线即看）+ `data.json` + `engine.json`（本地引擎参数）+ `start_engine.bat`（双击起引擎，ASCII，含中文路径也不乱码）。`--no-engine-bat` 可只出前两个。改样式后 `python render.py --data <out>/data.json --out <out>/index.html` 秒级重渲染。
   用本机 Edge/Chrome headless 截图自检渲染正常：
   `msedge.exe --headless --disable-gpu --window-size=1600,900 --screenshot=<png> --virtual-time-budget=3000 file:///<index.html>`
5. **（可选）转 PDF**：`msedge.exe --headless --print-to-pdf=<pdf> --virtual-time-budget=4000 file:///<index.html>`。

## 零点对齐原理（必须理解，否则时间全错）

logcat=墙钟、trace=boottime(ns)，两套时钟。唯一可靠跨时钟锚点 = `InputReader: ... BTN_TOUCH value=UP when=<boottime_ns>`：该行既给 logcat 算相对 ms，又给 trace 算相对 ms。全部对齐到「**点击抬起 UP = 0**」。锚点取「拉起目标包的那次点击」——所以 **`--package` 要准**。

## 网页交互（交付时向用户说明）

- **WASD 导航（同 ui.perfetto.dev）**：W/S 以鼠标为中心放大/缩小、A/D 平移，按住连续；主轴/堆栈火焰图/总线三视图通用。另：滚轮缩放、拖动平移；预设：全程 / 启动段 0→1s / 首帧 0→400ms / 复位。
- **★ 只看关键点**（默认开）只突出关注点；次要点变小三角，仍可点；可勾"显示全部次要标记"。
- 轨道开关：主线程 doFrame、帧时间线卡顿（默认开）、桌面入场动画（默认关，噪点）。
- 顶部标尺区按住拖动 = 测距 Δms（等价 perfetto 框选量时长）；Shift+拖动同效。
- 点旗标/切片 → 右栏详情（相对时间、耗时、卡顿类型、原始 logcat 行号），可 **📌Pin** / **🔥看该段堆栈**。
- **🔥 查看堆栈**：主线程/RenderThread 调用栈火焰图，缩放下钻（点帧切片自动弹出该帧堆栈）。
- **▤ 串/并行总线**：弹面板，一张表看系统侧 vs 应用侧并行/串行各段耗时（含桌面启动动画时长）。
- **⇄ 加载对比(B)**：载入第二份 data.json → 幽灵线 + A/B/Δ 对比表。
- **📂 打开 trace/数据**：拖入 .json 秒开；拖入 .pftrace → 经本地引擎 `serve_trace.py` 解析（见下）。

## 真的打开原始 .pftrace（本地引擎）

大 trace 不塞浏览器（会崩）。在 trace 目录起本地引擎，网页拖入 .pftrace 即 fetch 其结果：
```bash
python serve_trace.py <startup.pftrace> --logcat <full.txt> --package <pkg> [--rules rules.appmarket.json]
# 网页打开后把该 .pftrace 拖进去 → 自动 fetch http://127.0.0.1:9009/data.json（还提供 /query?sql= 实时查询）
```
理由（如用户问）：662MB 进浏览器 WASM 加载慢/吃内存/易崩；本地引擎让原始 trace 常驻本机 trace_processor（同 ui.perfetto.dev `--httpd` 思路），稳。

## 纪律

- **诚实标注**（遵最高优先级回答标准）：温启动时无"新建进程③/onCreate⑤"切片就不显示；虚拟 GPU 栈的 GPU 绝对耗时仅参考；应用自打点的"用户口径终点"晚于最后可见帧时，两者都标、不混淆。
- 报告/对外只引用**文件名**，不出现本地绝对路径；告知用户产物落点那一句可给本地路径。
- 网页**自包含可迁移**：data 内联在 HTML、无外链；整目录复制到任意电脑可离线打开（遵 report-deliverable 规范）。原始 trace 太大不内嵌，HTML 里以相对路径给"可拖入 ui.perfetto.dev 复核"的链接即可。
- AI 临时中间文件放 `docs/tempFiles/`，不入 git。
