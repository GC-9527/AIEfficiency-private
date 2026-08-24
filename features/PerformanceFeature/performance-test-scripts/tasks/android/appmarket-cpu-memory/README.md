# 应用市场 CPU / 内存一键摸测

双击 `tools/run_appmarket_performance.bat` 即可执行。脚本默认对
`com.appmarket.automotive` 运行 180 秒测试，每 5 秒生成一个 CPU/PSS
窗口，共 36 行；运行过程中可执行“首页 → 应用详情 → 下滑 → 下载并安装
→ 返回首页 → 我的 → 白名单二级菜单”模拟操作。

采集支持两个互不混淆的模式：

- `standard`（标准验收，默认）：正式 CSV 继续输出 5 秒 CPU/PSS 窗口，沿用
  既有工作簿阈值和历史口径。
- `realtime`（实时诊断）：通过一条常驻 adb 数据流采集 500ms CPU 和 1 秒
  RSS，PSS 仍每 5 秒采集；正式 CSV 仍只有 5 秒验收行，高频点写入独立 CSV。
  该模式强制采集 Perfetto，并在结束后按正式窗口校验调度 CPU 一致性。

## 运行前准备

1. Windows 已安装 Python 3，`py -3` 或 `python` 可用。
2. Android SDK Platform Tools 的 `adb` 已加入 PATH。
3. 车机已授权 ADB，且只连接一台设备；连接多台时 BAT 会提示选择。
4. 设备已安装 `com.appmarket.automotive`，网络和下载安装能力可用。
5. 正式重复测试时应固定一个安全、小体积、可重复卸载的测试应用，并在
   BAT 提示中填写它的页面名称。

BAT 只包含 ASCII，中文交互由 Python 输出，避免 Windows 控制台编码破坏路径。

## 平台运行

启动 AIEfficiency 后打开 `http://127.0.0.1:3000/performance`，可直接点击顶部
“开始CPU内存分析”；“分析配置”Tab 可保存 adb 序列号、车型、时长、间隔、
录屏开关以及受控的选择器/菜单 JSON，“资源趋势”可查看、停止本轮任务。
完成后脚本自动调用网关 `/api/performance/ingest`，页面会展示最近结果及
CPU/PSS 趋势。平台停止会写入协作停止文件，采样器会保留已完成窗口，不会
把部分数据伪装成完整 36 行。平台一键分析默认分段录屏，可在配置中关闭；
直接运行 Python 时需显式传入 `--capture-screenrecord`。

“性能”Tab 以单次采集轮次为边界提供三种视图：工作簿指标仪表盘、逐点原始
样本/原始产物预览、结构化检查与 Markdown 报告。CPU 与内存折线直接使用该轮
`resourceSamples.target_elapsed_s`，不会把不同轮次的 `/metrics` 混成一条趋势。
当前资源 runner 实采工作簿中的 CPU/PSS 五项；首次/热启动、响应时间、FPS、
12 小时稳定性与系统可用性等尚未接入本轮采集的数据会明确显示“未采集”，不会
以 0 或 PASS 代替。工作簿覆盖区同时列出“应用市场”与 15 个生态应用 sheet 的
进程组、CPU/内存/启动指标组，以及仍待客户确认的生态应用 GPU 指标；Excel 中的
历史摸底值只作为需求来源，不会冒充当前所选采集轮次的数据。

## 产物

运行产物默认位于：

`docs/tempFiles/appmarket-performance/run_<时间>_<run-id>/`

- `run_manifest.json`：设备、版本、参数、流程和最终状态。
- `raw/effective_flow_config.json`：本轮实际使用的流程配置冻结副本；流程执行和
  分析都使用该副本，避免运行中修改全局配置导致口径漂移。
- `raw/metrics.csv`：每 5 秒的派生 CPU/PSS/RSS 指标。
- `raw/diagnostic_metrics.csv`：实时诊断模式的 500ms CPU 与稀疏 1 秒 RSS 点，
  不参与旧阈值均值/峰值计算。
- `raw/realtime_stream.jsonl`、`realtime_collector_device.sh`：常驻采集器的原始
  流和本轮设备端脚本证据。
- `raw/sampler_raw_commands.jsonl`：计算指标所用的 `/proc`、`ps`、
  `dumpsys meminfo` 原始命令响应。
- `raw/logcat.txt`、`raw/logcat.previous.txt`：测试窗口末尾两段 logcat；每段
  最多 64 MiB，超过后滚动，避免异常轮次无限占用磁盘。
- `raw/device_info.json`、`dumpsys_package.txt`：环境与版本证据。
- `flow/flow_events.jsonl`、`flow/ui/*.xml|*.png`：模拟操作步骤与 UI 证据。
- `flow/video/segment_*.mp4`：启用录屏时生成的 170 秒分段视频；最后一段会在
  采样完成时提前停止，最长 3600 秒测试会自动规划多段。
- `trace/appmarket.pftrace`：仅勾选 Perfetto 诊断采集时生成。
- `analysis/perfetto_cpu_validation.json`：按 5 秒正式窗口裁剪调度切片后的
  Perfetto CPU 对照、覆盖率、数据丢失检查和一致性结论。

实时模式使用独立的轻量 Perfetto 配置，只采集调度切片、进程/线程映射及
数据丢失证据，避免帧、atrace 与电源轨道反过来扰动 CPU/PSS；标准模式手动
勾选 Perfetto 时仍保留完整诊断配置。
- `analysis/report.json`、`report.md`：机器可读与人工可读分析报告。
- `analysis/report_summary.pdf`、`report_detailed.pdf`：简短版和详细版 PDF。
- `analysis/optimization_advice.md`：基于采样证据和阈值检查生成的优化建议。
- `analysis/platform_payload.json`：平台上报原文；网关不可用时可稍后重放。
  其中 `resourceSamples` 保留 CSV 每行的时间、PID 集、CPU、PSS/RSS、采集
  延迟、进程变化标记和 note；原始 `/proc`/meminfo 响应仍以本地 JSONL 为准。

这些都是运行证据，不应自动暂存或提交。

平台还会把 Python runner 的完整 stdout/stderr（最多 16 MiB）保存到
`docs/tempFiles/appmarket-performance/control/<run-id>.runner.log`；即使脚本被
强制终止，也可从该文件看到最后一个完整步骤和网关记录的退出码/信号。

## 指标口径

| 展示指标 | 技术字段 | 定义 | 客户阈值 |
|---|---|---|---:|
| CPU 多核累计 | `cpu_one_core_equiv_pct` | `100 × N × ΔP / ΔT`；100% 等于持续占满一个逻辑核 | 峰值 ≤16.5% |
| CPU 客户单核映射 | `cpu_device_normalized_pct` | `100 × ΔP / ΔT`；占整机全部逻辑 CPU 容量比例 | 峰值 ≤3.30%，均值 ≤1.25% |
| 内存主指标 | `pss_mb` | 主进程与 `package:*` 子进程 Total PSS 之和 | 观测峰值 ≤190MiB，均值 ≤140MiB |
| 内存辅助指标 | `rss_mb` | 各进程 RSS 之和，共享页可能重复 | 不作为本轮判定阈值 |

“峰值”是 36 个五秒窗口中的最大值，不是毫秒级瞬时峰值。工作簿的
3.30% 与 16.5% 是 5 核关系；若实机逻辑核数不是 5，报告会保留真实核数、
给出口径警告，并将 `logical_cpu_topology` 检查明确判为失败，避免其他指标偶然
达标时误报目标环境通过。

## UI 选择器校准

默认流程使用 Android 官方 `uiautomator dump` 获取可访问性节点，再用
`adb shell input` 执行点击/滑动。它优先匹配 resource-id，其次匹配中英文
文案；所有“我的”二级菜单都来自 `config/appmarket_flow_config.json` 白名单。
未指定测试应用名称时，会有界下滑首页并只选择动作明确为“下载/安装/获取”的
未安装应用；同一个 `downloadBtn` 若显示“打开/已安装”，不会被点击。进入详情
后还会再次核对动作语义；找不到可下载应用时本轮流程记为 partial，并明确提示
准备安全的未安装测试应用，不再误启动应用后等待 120 秒。
首页 ready 节点默认需要连续 3 次相同 UI digest 才视为“完全加载并稳定”，可用
`timeouts.home_stable_samples` 调整。详情页即使首屏存在 sticky 下载按钮，也会
先持续下滑到 UI digest 连续不变，再查找并点击下载按钮。

车型页面资源 ID 不同时：

1. 执行 `adb shell uiautomator dump /sdcard/window.xml`。
2. 执行 `adb pull /sdcard/window.xml` 并检查目标节点的 `resource-id`、
   `text`、`content-desc`。
3. 调整配置中的 `home_ready`、`app_card`、`download`、`my_tab` 和
   `secondary_menus`，再运行一次短时验证。

脚本拒绝点击带有退出登录、删号、清数据、恢复出厂、支付、卸载等危险文案
的节点。`references/AppMarketFlowTest.kt` 是需要集成 AndroidX UI Automator 2.4.0 时的
instrumentation 参考模板；一键 BAT 使用的是无需额外测试 APK 的主机端流程。

## 录屏与测量扰动

`--capture-screenrecord` 使用设备端 `adb shell screenrecord`，按 170 秒连续
分段，结束、取消或失败时均尽量发送停止信号、拉取已有 MP4 并清理设备临时
文件。录屏失败只记录在 manifest/report warnings，不会让 CPU/PSS 主采集失败。
report 与后台 `resourceProfile.screenrecord` 还会保存录屏状态、相对产物路径、
分段字节数和成功拉取数量，不会上报主机绝对路径或设备临时路径。

录屏会产生视频编码、GPU、内存和存储 I/O 开销，也可能通过温度与调度间接
影响目标应用。因此正式 A/B 对比必须保持各轮录屏设置一致；需要最小扰动的
基准数据时应关闭录屏，并用单独的证据轮次留视频。录屏状态、分段结果、文件
大小、拉取/清理告警都会记录在 `run_manifest.json`。

## 单独运行

```powershell
# 仅启动应用并采样，不做下载/菜单动作
py -3 features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/runner.py `
  --non-interactive --serial <serial> `
  --flow-mode launch-only --duration 180 --interval 5 --capture-screenrecord

# 实时诊断；会自动启用 Perfetto
py -3 features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/runner.py `
  --non-interactive --serial <serial> --sampling-mode realtime `
  --flow-mode launch-only --duration 180 --interval 5

# 已有 CSV 时重新分析/上报
py -3 features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/src/analyze_appmarket_perf.py `
  --csv <metrics.csv> `
  --sampler-summary <sampler_summary.json> --manifest <run_manifest.json> `
  --flow-result <flow_result.json> --out-dir <analysis-dir> `
  --gateway http://127.0.0.1:3001
```

## 十轮峰值归因

CPU/PSS 阈值数据与调用栈/堆转储必须分开采集。`simpleperf` 会增加采样开销，
`am dumpheap` 会暂停运行时并触发 GC；二者生成的诊断轮次不得混入正式阈值统计。

```powershell
# 十轮正式资源数据：保留 5 秒验收窗口，同时采 500ms CPU、1s RSS 和轻量 Perfetto
py -3 features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/tools/run_peak_attribution_campaign.py `
  --serial <serial> --rounds 10 --sampling-mode realtime

# 十轮聚合：阶段归因、PSS 分类、Perfetto 峰值线程
py -3 features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/src/analyze_peak_campaign.py `
  --campaign-manifest <campaign_manifest.json> --out-dir <analysis-dir>

# 独立相位 Java 堆/内存映射；需要 userdebug/root 与 Android SDK hprof-conv
py -3 features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/tools/capture_phase_heap.py `
  --serial <serial> --phase install-manager --test-app-title <固定应用名称>

# 独立相位 CPU 调用栈；支持 startup/install-manager/privacy/full
py -3 features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/tools/capture_cpu_callstacks.py `
  --serial <serial> --phase startup --test-app-title <固定应用名称>
```

`capture_phase_heap.py` 会同时保留 `dumpsys meminfo --local`、`smaps_rollup`、
`showmap -v`、线程列表、Android HPROF、标准 HPROF、类直方图 JSON/CSV。
类直方图是 Java 管理堆的浅大小，不包含 Native Heap、EGL、APK mmap，也不把
浅大小冒充 dominator/retained size。`analyze_peak_campaign.py` 会将每轮流程事件
与 5 秒/实时样本对齐，并查询 Perfetto `sched` 切片得到峰值窗口的线程 CPU 份额。
诊断重放建议使用 `--test-app-title` 固定同一个可下载应用；留空时仍按安全规则动态选择。
