---
name: analyze-safe-drive-logs
description: 分析走行规制(SafeDrive/UxRestriction)功能的日志，诊断档位订阅、车速变化、走行弹窗、UX限制等问题
user_invocable: true
---

# 走行规制(SafeDrive)日志分析 Skill

当用户提供日志内容时，按照以下知识体系进行分析诊断。

## 架构概览

走行规制功能采用 **客户端-服务端** 双层架构，通过车辆信号（档位+车速）判断是否触发走行限制：

### 整体流程
```
车辆信号（档位/车速）
  ↓
品牌适配层（Geely/Seres/GWM）
  ↓
WebAppSafeDriveFeature（服务端-核心判断逻辑）
  ↓
ISafeDriveNoticeListener.onNeedSafeDriveChange()
  ↓
走行弹窗（UxPopupView / SafeDriveDialog）
  ↓
H5页面走行状态通知
```

### 品牌差异

| 品牌 | 走行实现类 | 信号源 | 弹窗组件 | 额外机制 |
|------|-----------|--------|---------|---------|
| **Geely(吉利)** | `GeelyUxRestriction` + `GeelyDrivingStateDispatcherImpl` | 华为HOS Auto SDK (TransmissionManager/SpeedManager) + HwCarService UxRestrictions | `UxPopupView` | UxRestrictions系统级限制 + 5秒超时自动退出 |
| **Seres(赛力斯)** | `SafeDriveFeatureHelper` + `SeresDrivingStateDispatcherImpl` | 华为HOS Auto SDK + SeresPlatformAdapter (CarConstants.ID_GEAR) | `SafeDriveDialog` | 硬按键走行检查 (SeresHardKeyDispatcherImpl) |
| **GWM(长城)** | 未启用 | - | - | 走行功能在GWMInitializer中被注释掉 |

## 核心源码文件索引

| 文件 | 路径 | 角色 |
|------|------|------|
| GeelyUxRestriction | `app/src/geely/java/com/appmarket/automotive/features/GeelyUxRestriction.kt` | Geely走行客户端 |
| SafeDriveFeatureHelper | `app/src/seres/java/com/appmarket/automotive/features/SafeDriveFeatureHelper.kt` | Seres走行客户端 |
| GeelyDrivingStateDispatcherImpl | `app/src/geely/java/com/webapp/sdk/car/impl/GeelyDrivingStateDispatcherImpl.kt` | Geely驾驶状态分发器(UxRestrictions) |
| SeresDrivingStateDispatcherImpl | `app/src/seres/java/com/webapp/sdk/car/impl/SeresDrivingStateDispatcherImpl.kt` | Seres驾驶状态分发器(Gear) |
| SeresHardKeyDispatcherImpl | `app/src/seres/java/com/webapp/sdk/car/impl/SeresHardKeyDispatcherImpl.kt` | Seres硬按键分发器(走行下按键拦截) |
| WebAppSafeDriveFeature | `oldCode/webapp-safe-drive/` (SDK层) | 走行规制服务端(核心判断引擎) |
| UxPopupView | `app/src/main/java/com/appmarket/automotive/dialog/UxPopupView.kt` | Geely走行弹窗UI |
| SafeDriveDialog | `app/src/main/java/com/appmarket/automotive/dialog/SafeDriveDialog.kt` | Seres走行弹窗UI |
| DownloadView (Geely) | `app/src/geely/java/com/appmarket/automotive/view/DownloadView.kt` | 应用市场下载按钮(走行下禁止打开应用) |

## 关键日志 TAG

### 主要TAG
- `GeelyUxRestriction` 类的 TAG = `com.appmarket.automotive.features.GeelyUxRestriction`（javaClass.name）
- `SafeDriveFeatureHelper` - Seres走行客户端
- `safe-drive` - WebAppSafeDriveFeature (SDK服务端)
- `WebAppSafeDriveFeature` - SDK服务端 logTag
- `GeelyDrivingStateDispatcherImpl` 继承的 `CarStateDispatcher` 的 TAG
- `DrivingStateDispatcherImpl` - Seres驱动状态分发器日志前缀

### 建议 logcat 过滤命令
```bash
# 综合走行日志（推荐）
adb logcat | grep -iE "SafeDrive|UxRestriction|DrivingState|safe-drive|onIntegerChangeSignal|onFloatChangeSignal|onNeedSafeDriveChange|notifyDrivingSpeedStateChanged|MOCK_DRIVING_STATUS|GeelyUxRestriction|handleFloatChangeSignal|dismissSafeDriveDialog|showSafeDriveDialog|popupRestrictionDialog|sUxRestrictionsStatus|notifyCarGearChange|notifyCarSpeedChange|isNeedSafeDrive|isSafeDriveConditionMet|finishCurrentTask|moveCurrentTaskToBackstage|tip_ux_restriction"

# Geely专用
adb logcat | grep -iE "GeelyUxRestriction|UxRestriction|sUxRestrictionsStatus|HwCarService|onUxRestrictionsChanged|MOCK_DRIVING_STATUS"

# Seres专用
adb logcat | grep -iE "SafeDriveFeatureHelper|DrivingStateDispatcherImpl|Seres-onDataChange|ID_GEAR|isShowingSafeDriveDialog"

# 车辆信号
adb logcat | grep -iE "onIntegerChangeSignal|onFloatChangeSignal|onIntegerErrorSignal|onFloatErrorSignal|transmissionGear|bodySpeed|ID_GEAR"

# 走行弹窗
adb logcat | grep -iE "onNeedSafeDriveChange|showSafeDriveDialog|dismissSafeDriveDialog|popupRestrictionDialog|finishCurrentTask|moveCurrentTaskToBackstage"
```

## 完整生命周期 & 对应日志关键字

### 阶段1：初始化

初始化链路因品牌不同：
- **Geely**: `GeelyInitializer` -> `CarDispatcherConfig.getDrivingStateDispatcher()` -> `GeelyDrivingStateDispatcherImpl.init()` + `WebAppSafeDriveFeature.initWebAppSafeDriveFeature(context, appId, GeelyUxRestriction)`
- **Seres**: `SeresInitializer` -> `SeresDrivingStateDispatcherImpl.init()` + `WebAppSafeDriveFeature.initWebAppSafeDriveFeature(context, appId, SafeDriveFeatureHelper)`

**Geely初始化 预期日志：**
```
# DrivingStateDispatcher 绑定 HwCarService
Bind HwCarService...                                          <- bindService 成功
onServiceConnected                                             <- HwCarService 连接成功

# GeelyUxRestriction.onInitDone 订阅车辆信号
subscribeTransmissionGear                                      <- 订阅档位
subscribeBodySpeed                                             <- 订阅车速
# 如果订阅失败：
init ohos error                                                <- HOS Auto SDK 初始化异常
```

**Seres初始化 预期日志：**
```
DrivingStateDispatcherImpl                                     <- SeresPlatformAdapter 初始化日志
init ohos error                                                <- 异常时出现
```

**异常诊断：**
- 没有初始化日志 -> 检查对应 Initializer 是否执行（依赖 flavor 配置）
- `Bind HwCarService failed` -> HwCarService 未安装或无法绑定（Geely）
- `init ohos error` -> 华为HOS Auto SDK权限问题（需要 `ohos.permission.vehicle.CAR_MOVING_INFO` 和 `ohos.permission.vehicle.SPEED_INFO`）
- `Disconnected HwCarService` -> HwCarService 服务断连

### 阶段2：车辆信号接收

#### 档位变化
```
onIntegerChangeSignal: {gearValue}                             <- 收到档位变化信号
```

**档位值映射表（华为HOS Auto标准）：**
| 值 | 档位 | 走行影响 |
|----|------|---------|
| 1 | P档(驻车) | 不触发走行 |
| 2 | N档(空挡) | 不触发走行 |
| 3 | R档(倒车) | 触发走行 |
| 4 | D档(前进) | 触发走行 |
| 5 | 预留 | - |
| 6 | E档(经济) | 触发走行 |
| 7 | S档(运动) | 触发走行 |

#### 车速变化
```
onFloatChangeSignal: {speedValue}                              <- 收到车速变化信号(km/h)
handleFloatChangeSignal ---: {speedValue}                      <- 处理车速值
```

#### Seres 特有：Gear 通过 PlatformAdapter
```
Seres-onDataChange key:ID_GEAR value:{value}                   <- Seres平台档位变化
```

#### 信号错误
```
onIntegerErrorSignal: zoneId = {p0}, errorCode = {p1}          <- 档位订阅错误
onFloatErrorSignal: zoneId = {p0}, errorCode = {p1}            <- 车速订阅错误
```

**errorCode 含义：**
| errorCode | 含义 |
|-----------|------|
| 1 | 订阅参数错误 |
| 2 | 功能不可用 |
| 3 | 系统错误 |

**异常诊断：**
- 无 `onIntegerChangeSignal` / `onFloatChangeSignal` -> 信号订阅失败，检查初始化
- `onIntegerErrorSignal` errorCode=2 -> 车辆不支持该功能
- `onFloatChangeSignal` 值始终为0 -> SpeedManager 异常或车辆未行驶
- 档位值为 null -> 信号源异常，`notifyCarGearChange` 不会被调用
- `getVehicleGear error` / `getVehicleSpeed` 异常 -> SDK获取实时值失败

### 阶段3：走行判断（WebAppSafeDriveFeature 服务端）

`WebAppSafeDriveFeature` 收到 `notifyCarGearChange()` 和 `notifyCarSpeedChange()` 后进行走行判断。

**走行触发条件（isNeedSafeDrive）：**
1. 档位 > 默认档位（默认档位通过 `SafeDriveInfo` 设置，初始化为 gear=1 即P档）
2. 速度 >= 默认速度（初始化为 0f）
3. 当前屏幕符合客户端设定（通过 `DisplayEnum` 配置）
4. 若在音视频界面，需要正在播放状态

**关键日志：**
```
# SDK 内部判断（TAG: safe-drive / WebAppSafeDriveFeature）
notifyCarGearChange gearValue=...                              <- 档位变化通知
notifyCarSpeedChange speedValue=...                            <- 车速变化通知
isNeedSafeDrive=...                                            <- 走行判断结果
isSafeDriveConditionMet=...                                    <- 走行条件是否满足
```

**异常诊断：**
- 档位已切D档但未触发走行 -> 检查 `SafeDriveInfo` 的默认档位设置是否正确
- 车速>0但未触发 -> 可能是 `DisplayEnum` 屏幕判断不通过
- 音视频类WebApp走行异常 -> 检查 `NOTIFY_PLAYBACK_STATE_CHANGED` 回调是否正确上报播放状态

### 阶段4：走行弹窗显示/隐藏

当走行条件满足/解除时，`onNeedSafeDriveChange` 被回调。

**预期日志：**
```
onNeedSafeDriveChange ---------  isNeedShowSafeDrive----------> true    <- 需要显示走行弹窗
onNeedSafeDriveChange isNeedShowSafeDrive:---true                       <- 确认状态

# Geely:
popupRestrictionDialog                                                   <- 显示UxPopupView
dismissSafeDriveDialog safeDriveDialogWeakRef?.get()：...                <- 关闭弹窗

# Seres:
showSafeDriveDialog                                                      <- 准备显示
showSafeDriveDialog existingDialog?.popupInfo：...                       <- 检查已有弹窗
showSafeDriveDialo safeDriveFeature：...                                 <- 用户点退出
dismissSafeDriveDialog safeDriveDialogWeakRef?.get()：...                <- 关闭弹窗
```

**异常诊断：**
- `onNeedSafeDriveChange` 为 true 但无弹窗 -> `getCurrentWebAppActivity()` 返回 null，当前无前台 WebApp Activity
- 弹窗显示后立即消失 -> 检查 Geely 的 5秒超时逻辑：`sUxRestrictionsStatus == 1` 且经过 4秒以上会自动关闭并 `finishCurrentTask`
- 弹窗无法关闭 -> `dismissOnBackPressed(false)` 和 `dismissOnTouchOutside(false)` 是设计行为，只能通过退出按钮关闭
- Seres弹窗重复弹出 -> 检查 `existingDialog.isShow` 逻辑和 `popupInfo` 是否为 null

### 阶段5：Geely特有 - UxRestrictions 系统级限制

Geely 有**双重走行机制**：
1. **WebAppSafeDriveFeature 基于档位+车速判断**（与Seres共用）
2. **HwCarService UxRestrictions 系统级限制**（Geely独有）

```
onUxRestrictionsChanged value={0或1}                           <- 系统UxRestrictions状态变化
notifyDrivingSpeedStateChanged lastSpeed={} freshSpeed={}      <- 通知速度状态变化
```

**sUxRestrictionsStatus 值：**
| 值 | 含义 | 影响 |
|----|------|------|
| 0 | 非走行状态（停车） | 正常使用 |
| 1 | 走行状态（行驶中） | 禁止打开应用 + 5秒超时自动退出WebApp |

**走行下的应用市场行为（DownloadView.kt:310）：**
```kotlin
if (GeelyDrivingStateDispatcherImpl.sUxRestrictionsStatus == 1 && buttonText == "打开") {
    Toast: "Application available only when parked"  // tip_ux_restriction
    return  // 阻止打开应用
}
```

**异常诊断：**
- 应用打不开且提示"停车后使用" -> `sUxRestrictionsStatus == 1`，检查UxRestrictions状态
- P档下仍显示走行限制 -> `onUxRestrictionsChanged` 回调延迟或未收到0值
- UxRestrictions和SafeDrive弹窗同时触发 -> 正常行为，两个机制独立运作

### 阶段6：Debug 模式 Mock 走行（仅 Geely DEBUG 包）

```bash
# 模拟走行状态变化
adb shell am broadcast -a com.huawei.hmsforcar.carappinit.MOCK_DRIVING_STATUS --es lastSpeed "0" --es freshSpeed "1"
# lastSpeed: 上一次速度状态  freshSpeed: 新速度状态
# "0" = 非走行  "1" = 走行
```

## 分析步骤

当用户提供日志时，按以下顺序检查：

1. **判断品牌**：根据日志中的 TAG 判断是哪个品牌
2. **检查初始化**：是否有成功的初始化日志，信号订阅是否成功
3. **检查信号接收**：`onIntegerChangeSignal` 和 `onFloatChangeSignal` 是否有数据，值是否合理
4. **检查走行判断**：`onNeedSafeDriveChange` 的 `isNeedShowSafeDrive` 值是否符合预期
5. **检查弹窗状态**：弹窗是否正确显示/隐藏
6. **检查UxRestrictions**（Geely）：`sUxRestrictionsStatus` 值是否与实际驾驶状态一致
7. **检查应用市场行为**：走行下是否正确禁止打开应用
8. **汇总问题**：给出具体的问题定位和修复建议

## 常见问题速查表

| 现象 | 可能原因 | 排查方法 |
|------|---------|---------|
| 走行功能完全不生效 | 初始化未完成/信号订阅失败 | 查 `init ohos error` 和初始化日志 |
| D档行驶无走行弹窗 | 档位信号未收到/SafeDriveInfo默认值配置错误 | 查 `onIntegerChangeSignal` 日志 |
| P档仍显示走行弹窗 | `onNeedSafeDriveChange` 未收到 false / UxRestrictions 未更新 | 查 `isNeedShowSafeDrive` 和 `sUxRestrictionsStatus` |
| 弹窗显示后5秒自动退出 | Geely UxRestrictions超时机制（正常行为） | 确认 `sUxRestrictionsStatus==1` 且超时>4秒 |
| 应用市场"打开"按钮无效 | `sUxRestrictionsStatus==1`（Geely走行限制） | 查 `tip_ux_restriction` Toast |
| 走行弹窗无法关闭 | 设计行为：`dismissOnBackPressed(false)` | 只能通过退出/返回按钮，或切P档解除 |
| 档位/车速信号错误 | errorCode=1/2/3 | 查 `onIntegerErrorSignal` / `onFloatErrorSignal` |
| HwCarService断连 | 系统服务异常 | 查 `Disconnected HwCarService` |
| Seres硬按键走行下不响应 | `isShowingSafeDriveDialog()` 检查 | 查 SeresHardKeyDispatcherImpl 中走行弹窗状态 |
| GWM无走行功能 | 未在GWMInitializer中启用 | GWM品牌不支持走行（代码已注释） |
| 走行下WebApp H5未收到通知 | `notifyH5SafeDriveStateChange` 未调用 | 查 SDK 层 safe-drive 日志 |
| 音视频WebApp走行异常 | 播放状态回调问题 | 查 `NOTIFY_PLAYBACK_STATE_CHANGED` |

## H5交互相关

| SDK常量 | H5事件 | 说明 |
|---------|--------|------|
| `NOTIFY_PLAYBACK_STATE_CHANGED` = `"notifyPlaybackStateChanged"` | H5->Native | H5上报音视频播放状态变化 |
| `REQUIRES_SAFE_DRIVE_CONDITION_STATE` = `"requiresSafeDriveConditionState"` | H5->Native | H5查询当前是否满足走行条件 |
| `notifyH5SafeDriveStateChange` | Native->H5 | 通知H5走行状态变化(true=触发/false=解除) |

## 关键字符串资源

| Key | 值 | 使用场景 |
|-----|-----|---------|
| `webapp_driving_restrictions_tips` | "Shift to Park to use this feature." | 走行弹窗提示文字 |
| `tip_ux_restriction` | "Application available only when parked" | 应用市场Toast提示 |
| `tip_ux_restriction_triggered` | "Shift to Park to use this feature." | 走行触发提示 |
| `tip_ux_restriction_triggering` | "Unable to use this app while driving." | 走行中提示 |
