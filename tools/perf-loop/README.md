# perf-loop —— 应用市场性能压测闭环（工程 C，Step 5）

Monkey 压测 + 数据采集 + 自动上报 AIEfficiency 的一键脚本，配合车机端 `PerfTracker`（TAG=`APP_MKT_PERF`）使用。

## 闭环流程

```
① gradlew :app-market:assemble<Variant>  → adb install -r
② 冷启动：force-stop → logcat -c → LAUNCHER 启动 → 等首帧
③ Monkey 压测：monkey（参数对齐手动命令：全 ignore + monitor-native + pct-touch75/appswitch15 + -v -v）<N>
④ 抓 logcat（APP_MKT_PERF + AndroidRuntime:E + ActivityManager:E）
⑤ 解析 ①②③/内存/Crash/ANR → 带 round_NNN POST /api/performance/ingest
⑥ 存 reports/round_NNN/（monkey.log / logcat.txt / round.json / summary.md）
```

> 设计：脚本**直接 scrape logcat**（PerfTracker 已把 `cold_start done: …`、`metric[…]`、`event[crash|anr]` 打到 logcat），自己解析并上报，**不依赖** mock app 的 HTTP 上报开关——只要车机端运行时开关打开让 PerfTracker 采集打 log 即可。

## 前置条件

- **运行方式**：Windows 自带的是 PowerShell 5.1，**没有 `pwsh`**（那是 PowerShell 7）。本脚本兼容 5.1——用 `powershell -ExecutionPolicy Bypass -File <脚本> <参数>` 运行（下面示例均已用此形式；装了 PowerShell 7 也可直接 `pwsh <脚本>`）。
- `adb` 在 PATH，已连接车机（多设备用 `-Serial`）。
- 车机端装的是带 perf-tracker 的应用市场包，且已通过 mock app 打开「性能分析」开关（让 PerfTracker 真正采集、打 logcat）。
- AIEfficiency 网关在跑（默认 `http://localhost:3001`）。
- 工程 A 仓库路径：默认 `D:\workspace\xsProjects\202605\AISdkV4\2026AppMarketAIV5`，可用环境变量 `APPMARKET_DIR` 覆盖。

## 用法

```powershell
# 跑一轮（demoDev debug，10000 事件）
powershell -ExecutionPolicy Bypass -File ./run-perf-loop.ps1 -Channel demo -Env Dev -Events 10000

# 用已安装的包，跳过构建
powershell -ExecutionPolicy Bypass -File ./run-perf-loop.ps1 -NoBuild -Channel seres

# 多设备指定序列号
powershell -ExecutionPolicy Bypass -File ./run-perf-loop.ps1 -Serial 192.168.1.20:5555

# 不连设备：打印将执行的命令
powershell -ExecutionPolicy Bypass -File ./run-perf-loop.ps1 -DryRun

# 不连设备/网络：仅验证 logcat 解析逻辑
powershell -ExecutionPolicy Bypass -File ./run-perf-loop.ps1 -SelfTest
```

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `-Channel` | demo | 渠道 flavor（demo/seres/avatr8678/...）|
| `-Env` | Dev | 环境维度（Dev/Prod/Stage）|
| `-BuildType` | debug | debug/release |
| `-Events` | 5000 | **每轮** Monkey 事件数（×约 0.3s = 每轮压测时长）|
| `-Rounds` | 1 | 跑几轮（每轮=冷启动测①②③ + 压测 + 抓数 + round 上报）|
| `-DurationHours` | 0 | >0 时忽略 `-Rounds`，循环跑到该时长自动停（如 48=两天）|
| `-Gateway` | http://localhost:3001 | AIEfficiency 网关 |
| `-Serial` | （空）| adb 设备序列号（网络车机如 `192.168.20.116:5566`）|
| `-NoBuild` | — | 跳过 assemble/install（用已装好的包）|
| `-DryRun` | — | 只打印命令不执行 |
| `-SelfTest` | — | 验证解析逻辑后退出 |

> Monkey 参数已对齐手动命令：`--ignore-crashes/timeouts/security/native-crashes --monitor-native-crashes --pct-touch 75 --pct-trackball 5 --pct-appswitch 15 --pct-pinchzoom 5 ... -v -v`。

## 多轮对比

每轮自增 `round_NNN`，上报后落 `perf_session.round`。面板「轮次对比」可读 `GET /api/performance/rounds` 查看各轮平均启动时长趋势。

## 连续 2 天性能/稳定性测试（两终端）

长跑请在**自己的终端**执行（不要挂在 IDE 会话/CI 里，撑不过 2 天）。开两个终端并行：

**终端 1 —— 性能压测闭环（跑满 48h 自动停）**
```powershell
powershell -ExecutionPolicy Bypass -File ./run-perf-loop.ps1 -Channel avatr8678 -Env Dev -NoBuild `
     -Serial 192.168.20.116:5566 -Events 5000 -DurationHours 48
```
每轮 ≈ 冷启动测 ①②③ + 5000 事件压测(~25min) + 抓数上报；48h ≈ **115 轮 → 115 个冷启动样本 + 持续压测**，全部带 `round_NNN` 进面板「轮次对比」。

**终端 2 —— 原始日志归档（同样 48h）**
```powershell
powershell -ExecutionPolicy Bypass -File ./backup-device-logs.ps1 -Serial 192.168.20.116:5566 -DurationHours 48
```
持续抓 logcat、每 30min gzip 归档到 `perf-logs/<设备>/`，并扫入每轮 Monkey 报告（详见下节）。

**跑 2 天的注意事项：**
1. **网关别关** —— 装 AIEfficiency 网关的终端(`localhost:3001`)要一直开着，否则上报落空（数据存本地 `round.json` 但面板看不到）。
2. **开发机别休眠** —— 电源设置里关掉睡眠/休眠，否则脚本会停。
3. **设备别掉线** —— 网络 adb(`<ip>:5566`)2 天里可能抖动断开；掉了 `adb connect <ip:port>` 重连，USB 连接更稳。
4. **样本粒度** —— 小 `-Events`(如 2000) 每轮快、冷启动样本多；大 `-Events`(如 20000) 压测更久、样本少。`5000` 折中。
5. **monkey 互斥** —— 别再另外手动跑 monkey；本脚本每轮自己起/停 monkey，多个 monkey 会互相反复拉起 App 搅乱观测。
6. 跑完用面板「轮次对比 / 资源趋势 / 性能日志」+「AI 分析」分析；原始日志在 `perf-logs/`。

## 范围说明（Step 5）

- ✅ build→install→monkey→采集→解析→**round 标记上报**。
- ⛳ AI 分析建议（`/api/performance/analyze`）与「Monkey 报告 / 轮次对比 / AI 分析」面板 Tab 属 **Step 6**。
- ⛳ CPU(/proc)、FPS(Choreographer)、perfetto trace 采集为后续增强。

---

## 长时日志归档 backup-device-logs.ps1（连续 2 天 Monkey 用）

`run-perf-loop.ps1` 是"每轮抓一次"；连续长跑要用 `backup-device-logs.ps1` **持续无损归档** logcat + Monkey 报告。

```powershell
# 连跑两天，每 30 分钟轮转压缩归档（结束 Ctrl-C 或到 -DurationHours 自动停）
powershell -ExecutionPolicy Bypass -File ./backup-device-logs.ps1 -Serial <serial>
# 快速验证一次（dump 当前缓冲→压缩→退出）
powershell -ExecutionPolicy Bypass -File ./backup-device-logs.ps1 -Serial <serial> -Once
```

- **持续流式**抓 `adb logcat -b all`（非定时 dump，避免 Monkey 高频事件下环形缓冲滚动丢日志）；启动时把设备缓冲调到 `-BufferMB`(默认16M)。
- 每 `-RotateMin`(默认30) 分钟轮转：停流→压成 zip→重开（间隙 <1s）。
- 顺带把 `reports/` 下新增 Monkey 轮次复制进设备归档目录。
- 归档到 `AIEfficiency/perf-logs/<model>_<serial>_<ip>/`（**已 gitignore**）：`archive/*.zip` + `monkey/round_*` + `device.json`。
- 参数：`-Serial -OutRoot -RotateMin -DurationHours(0=手动停) -BufferMB -Once`。

> 结构化性能数据（①②③/metrics/crash/anr）由 PerfTracker **实时 HTTP 上报入库**，不在本脚本范围；本脚本只归档"原始 logcat + Monkey 报告"，供深度溯源。

---

## 设置车机国家码 set-car-region.ps1（avatr8678，不走 mock）

台架/无整车环境下，国家码源属性 `ro.avatr.car.locale.string` 为空 → 应用市场 `region()` 取不到。本脚本写运行时覆盖属性，让其读到指定国家码（**真机 setprop，不经 mock app**）。

```powershell
# 设为 SA（沙特），并重启应用市场重读
powershell -ExecutionPolicy Bypass -File ./set-car-region.ps1 -Serial 192.168.20.116:5566 -CountryCode SA -RestartApp
powershell -ExecutionPolicy Bypass -File ./set-car-region.ps1 -CountryCode AE -RestartApp
# 改成其它（如 US）—— 即时生效、免重启/免重打包
powershell -ExecutionPolicy Bypass -File ./set-car-region.ps1 -Serial 192.168.20.116:5566 -CountryCode US -RestartApp
# 清除覆盖，回落到 App 内置默认 / 真机 sysprop
powershell -ExecutionPolicy Bypass -File ./set-car-region.ps1 -Serial 192.168.20.116:5566 -Clear -RestartApp
```

- 写 `debug.appmarket.region`（root），`Avatr8678PlatformBridge.region()` **最高优先**读它；`debug.*` 可反复 setprop、即时生效（不像 `ro.*` 一个 boot 只能设一次）。
- `region()` 取值优先级：`debug.appmarket.region`（运行时覆盖）→ SDK deviceIdentity → `ro.avatr.car.locale.string` → 代码级 `MODEL_REGION_DEFAULT`(车型码`E15-EU-Left`→`SA`) → 系统 Locale。
- `debug.*` 重启会丢 → 回落到 App 内置 `MODEL_REGION_DEFAULT`。**改 baked 默认国家码**：编辑 `app-market` avatr8678 变体的 `Avatr8678PlatformBridge.MODEL_REGION_DEFAULT` 后重打 release。
- 参数：`-Serial -CountryCode(默认SA) -Clear -RestartApp -Prop(默认 debug.appmarket.region)`。

> 车型/carMachine（`E15-EU-Left → avatr-8678`）由车机 jar + bridge 自动解析，无需本脚本设置。
