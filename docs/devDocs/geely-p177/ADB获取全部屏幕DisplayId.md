# P177 使用 ADB 获取全部屏幕 Display ID

## 结论

在 `2026-08-12 19:38:35 CST` 对设备 `192.168.20.224:5566`（`P177-LE`、Android 12 / API 32）实机查询，Android WindowManager/DisplayManager 当前可见 4 个逻辑屏幕：

```text
0
1
2
3
```

当前实机明细：

| Android `displayId` | 分辨率 | DisplayManager `uniqueId` | 物理端口 / SurfaceFlinger ID | HWC display | 状态 | 可确认用途 |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | 5120x1600 | `local:129` | 129 | 0 | ON | 标准 ADB 信息不足，待 OEM 资料确认 |
| 1 | 800x480 | `local:130` | 130 | 1 | ON | 标准 ADB 信息不足，待 OEM 资料确认 |
| 2 | 2240x182 | `local:131` | 131 | 2 | ON | 标准 ADB 信息不足，待 OEM 资料确认 |
| 3 | 2560x1600 | `local:132` | 132 | 3 | ON | 后排屏；当前前台类为 `rsd.RsdLauncherActivity` |

> 注意：已有笔记中的 `1001`、`1002`、`1003` 没有出现在本次标准 Android DisplayManager、WindowManager 或 SurfaceFlinger 输出中。它们可能是业务层或 OEM 自定义屏幕编号，不能直接当作 Android `displayId` 使用；需要用对应 OEM 接口或应用日志另行确认。

## 最简命令：获取全部 Android 逻辑屏幕 ID

先确认设备：

```powershell
adb connect 192.168.20.224:5566
adb devices -l
```

设备不止一台时，始终通过 `-s` 指定序列号。P177 当前可直接执行：

```powershell
adb -s 192.168.20.224:5566 shell "dumpsys window displays | grep 'Display: mDisplayId='"
```

实机输出：

```text
Display: mDisplayId=3 rootTasks=1
Display: mDisplayId=1 rootTasks=0
Display: mDisplayId=2 rootTasks=0
Display: mDisplayId=0 rootTasks=4
```

输出顺序是 WindowManager 的内部遍历顺序，不代表主副屏顺序；去重后的 `displayId` 为 `0、1、2、3`。

如果设备端没有 `grep`，在 Windows 主机上使用：

```powershell
adb -s 192.168.20.224:5566 shell dumpsys window displays | findstr /C:"Display: mDisplayId="
```

## 获取分辨率、uniqueId 和物理端口

查看完整原始数据：

```powershell
adb -s 192.168.20.224:5566 shell dumpsys display
```

在 PowerShell 中整理成表格：

```powershell
$serial = '192.168.20.224:5566'
$raw = adb -s $serial shell dumpsys display
$rows = @()

foreach ($line in $raw) {
    if ($line -notmatch 'mBaseDisplayInfo=DisplayInfo') {
        continue
    }

    $id = [regex]::Match($line, 'displayId (\d+)"').Groups[1].Value
    $resolution = [regex]::Match($line, 'real (\d+) x (\d+)')
    $uniqueId = [regex]::Match($line, 'uniqueId "([^"]+)"').Groups[1].Value
    $state = [regex]::Match($line, 'state ([A-Z]+)').Groups[1].Value
    $port = [regex]::Match($line, 'address \{port=(\d+)\}').Groups[1].Value

    if ($id -ne '') {
        $rows += [pscustomobject]@{
            DisplayId = [int]$id
            Resolution = '{0}x{1}' -f $resolution.Groups[1].Value, $resolution.Groups[2].Value
            UniqueId = $uniqueId
            State = $state
            PhysicalPort = [int]$port
        }
    }
}

$rows | Sort-Object DisplayId | Format-Table -AutoSize
```

本次实机输出：

```text
DisplayId Resolution UniqueId  State PhysicalPort
--------- ---------- --------  ----- ------------
        0 5120x1600  local:129 ON             129
        1 800x480    local:130 ON             130
        2 2240x182   local:131 ON             131
        3 2560x1600  local:132 ON             132
```

## 获取 SurfaceFlinger 物理显示 ID

```powershell
adb -s 192.168.20.224:5566 shell dumpsys SurfaceFlinger --display-id
```

本次实机输出：

```text
Display 129 (HWC display 0): invalid EDID
Display 131 (HWC display 2): invalid EDID
Display 130 (HWC display 1): invalid EDID
Display 132 (HWC display 3): invalid EDID
```

这里的 `129～132` 是 SurfaceFlinger/物理显示侧编号，不是应用通过 `Display#getDisplayId()` 获得的 Android 逻辑 `displayId`。`invalid EDID` 只表示命令没有取得有效 EDID，不表示屏幕不存在；DisplayManager 显示 4 块屏均为 `ON`。

## 辅助判断每个屏幕当前窗口

```powershell
adb -s 192.168.20.224:5566 shell dumpsys window displays | findstr /C:"Display: mDisplayId=" /C:"mCurrentFocus="
```

本次查询中：

- `displayId=3` 的当前窗口是 `com.flyme.auto.launcher.rsd.RsdLauncherActivity`，因此可确认它是后排屏。
- `displayId=0` 当前显示 `com.flyme.auto.pandoraparking.union.UnionMainActivity`。
- `displayId=1`、`displayId=2` 当时没有焦点窗口，不能仅凭一次 ADB 输出可靠命名。

## 编号含义不要混用

| 编号类型 | 本次值 | 主要用途 |
| --- | --- | --- |
| Android 逻辑 `displayId` | `0、1、2、3` | 应用 `Display#getDisplayId()`、WindowManager、按屏启动或排查窗口 |
| DisplayManager `uniqueId` | `local:129～local:132` | DisplayManager 内标识显示设备 |
| SurfaceFlinger / 物理端口 ID | `129～132` | 图形栈、HWC 和物理显示排查 |
| 业务/OEM 屏幕编号 | 笔记中有 `1001～1003`，本次未验证 | 只能按 OEM 或业务接口契约使用 |

## 本文档的验证范围

```text
Acceptance Route
  task_origin: DIRECT_ENGINEERING
  scope_kind: PROJECT_ENGINEERING
  protocols: project-engineering-acceptance
  change_type: DOCUMENTATION
  risk_tier: LOW
  target_repositories: D:/workspace/xsProjects/202606/AIEfficiency202606
  project_task_id: DOC-GEELY-P177-SCREEN-ID-20260812
  story_point_id: N/A
  source_system/source_issue_id: N/A
```

- 已读：`ask_1.txt`、`note_国家码.txt`，以及 P177 的实时 `dumpsys display`、`dumpsys window displays`、`dumpsys SurfaceFlinger --display-id` 输出。
- 未读：`temp1.txt`（本任务只要求屏幕 ID 命令，且该文件与已有用户修改均不应被改写）。
- 未执行：按屏启动应用、点击、安装、卸载、重启或任何设备配置修改。
- 设备构建：`25.09.01.251230.263241.userdebug`。
- 结论只对上述设备与当前构建的实时状态负责；升级系统或改变显示拓扑后应重新执行命令。
