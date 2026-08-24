---
name: analyze-voice-see-logs
description: 分析可见可说(VoiceSee)功能的日志，诊断初始化、热词上报、指令执行等问题
triggers: VoiceSee, 可见可说, 语音, 热词, 指令
modification: false
engine: claude
---

# 可见可说(VoiceSee)日志分析 Skill

当用户提供日志内容时，按照以下知识体系进行分析诊断。

## 架构概览

可见可说功能涉及三层：
1. **AppMarket 层**（应用市场 APK）：`SeresInitializer` → `VoiceSeeFeatureSdkHelper` → `HwVoiceInteractHelper`
2. **WebApp SDK 层**：`WebAppVoiceControlSeeFeature` → `VoiceSeeInteract`
3. **JS 层**：H5 页面实现 `scanBuildAccessibilityTree()`、`callJsFun()`、`executeVoiceSeeCommand()` 等全局函数

## 关键日志 TAG

- `XS_VoiceSee` — 可见可说核心模块（WebAppVoiceControlSeeFeature、VoiceSeeInteract、HwVoiceInteractHelper 共用）
- `WebAppVoiceControlAccTreeDebugHelper` — Debug 模式下的调试命令日志

## 完整生命周期 & 对应日志关键字

### 阶段1：初始化

初始化链路：`SeresInitializer.init()` → `WebAppVoiceControlSeeFeature.initWebAppVoiceSeeFeature()` → `HwVoiceInteractHelper.init()` → `VisibleManager.getInstance().init()`

**预期日志（按顺序）：**
```
XS_VoiceSee: HwVoiceInteractHelper init          ← SDK 初始化
XS_VoiceSee: HwVoiceInteractHelper onConnected    ← 与语音助手建立连接成功
```

**异常诊断：**
- 没有 `init` 日志 → 检查是否在主进程（`isInMainProcess`），非主进程不初始化语音模块
- 有 `init` 无 `onConnected` → 语音助手服务未启动或未绑定前台应用
- 出现 `onDisConnected` → 语音助手解除绑定或崩溃

### 阶段2：WebView 绑定

当 WebAppActivity 打开 WebApp 后，`ifNeedWebAppWebView()` 被调用。

**预期日志：**
```
XS_VoiceSee: onWebAppAfterView registerListener==>   ← 注册事件监听
XS_VoiceSee: bindWebView ==>                          ← WebView 绑定成功
```

**异常诊断：**
- 没有 `bindWebView` → WebView 未正确传递给可见可说模块
- 没有 `registerListener` → Feature 模块未正确加载（检查 ServiceLoader 配置）

### 阶段3：JS 回调热词数据

JS 通过 `window.remote.notifyCallbackEvent()` 上报热词。事件名过滤在 `WebAppVoiceControlSeeFeature.listener` 中。

**预期日志：**
```
XS_VoiceSee: WebAppVoiceControlSeeFeature listener eventName--------reportAccessibilityTree   ← 收到无障碍树数据
XS_VoiceSee: handleJsCall eventName==>reportAccessibilityTree callbackString==>...             ← 解析热词
XS_VoiceSee: handleJsCall hotWords==>...                                                       ← 热词列表解析结果

XS_VoiceSee: WebAppVoiceControlSeeFeature listener eventName--------reportHotWordScenes        ← 收到热词场景
XS_VoiceSee: handleJsCall reportHotWordScenes==>...                                            ← 场景列表
```

**异常诊断：**
- 没有 `listener eventName` 日志 → JS 未调用 `notifyCallbackEvent`，或 eventName 不是 `reportAccessibilityTree`/`reportHotWordScenes`
- `hotWords==>[]` 或 `hotWords==>null` → JS 上报的数据为空或格式错误
- `callbackString` 有值但 `hotWords` 为 null → JSON 反序列化失败，检查 HotWordPage 的 JSON 格式：
  ```json
  [{"name":"热词名","role":"button","synonyms":["同义词1"],"scenes":["场景1"]}]
  ```

### 阶段4：语音助手拉取热词（上报）

语音助手唤醒后调用 `onGetVisibleInfo()`，要求 **100ms 内返回**。

**预期日志：**
```
XS_VoiceSee: HwVoiceInteractHelper onGetVisibleInfo                                    ← 语音助手开始拉取
XS_VoiceSee: onGetVisibleInfo ---> visibleContext==>... appVisible==>... Process.myPid  ← 拉取上下文
XS_VoiceSee: scanBuildAccessibilityTree                                                 ← 触发JS扫描
XS_VoiceSee: callJsScanBuildAccessibilityTree 222 callback cost XXms                    ← JS扫描回调（注意耗时）
XS_VoiceSee: defaultHotWordScenes ==>...                                                ← 默认场景
XS_VoiceSee: appVisible?.hotwords ==>...                                                ← 最终上报的热词数据
XS_VoiceSee: onGetVisibleInfo 112233 cost XXms                                          ← 总耗时（必须<100ms）
```

**异常诊断：**
- 没有 `onGetVisibleInfo` → 语音助手未连接或未识别当前应用为前台
- `cost` 超过 100ms → 超时，本次热词上报可能被语音助手丢弃
- `hotwords ==>[]` → 热词列表为空，检查：
  1. `hotWordsList` 是否为 null（JS 从未上报 reportAccessibilityTree）
  2. `hotWordPage.name` 是否全部为空（name 为空会被 filter 过滤）
  3. `scenes` 和 `defaultHotWordScenes` 是否都为 null
- `scanBuildAccessibilityTree` 无 callback → JS 侧函数未定义或 WebView 已销毁

### 阶段5：指令执行

用户说出热词后，语音助手回调执行。

**预期日志：**
```
# 按名称执行
XS_VoiceSee: onExecuteName ---> executeName==>{"name":"xxx",...}     ← 语音助手下发名称指令
XS_VoiceSee: executeVoiceCommand voiceCommand==>...                   ← 转发给 JS
XS_VoiceSee: callJsExecuteVoiceCommand                               ← 调用 JS executeVoiceSeeCommand()
XS_VoiceSee: callJsExecuteVoiceCommand 222 callback cost XXms        ← JS 执行完成

# 按索引执行
XS_VoiceSee: onExecuteIndex ---> executeIndex==>{"index":N,...}      ← 语音助手下发索引指令

# 全局操控
XS_VoiceSee: onExecuteControl ---> executeControl==>...              ← 操控指令
```

**异常诊断：**
- 有 `onExecuteName` 无 `executeVoiceCommand` → `WebAppVoiceControlSeeFeature` 实例为 null
- `callJsExecuteVoiceCommand` 无 callback → JS 侧 `executeVoiceSeeCommand()` 函数未定义
- 执行后页面无反应 → 检查 JS 侧是否正确处理了传入的 command JSON

### 阶段6：角标显示/隐藏

```
XS_VoiceSee: onShowCornerMark visibleContext==>... appCornerMark==>...   ← 显示角标
XS_VoiceSee: onHideCornerMark visibleContext==>...                       ← 隐藏角标
XS_VoiceSee: showCorner===>...                                           ← JS 侧角标渲染
```

## Debug 模式专用命令

Debug 包支持通过 `WebAppVoiceControlAccTreeDebugHelper`（WebSocket）发送模拟命令：

| 命令 JSON | 作用 |
|---|---|
| `{"command":"buildTree"}` | 触发扫描无障碍树 |
| `{"command":"voiceSeeCommand","paramData":{...}}` | 模拟语音指令执行 |
| `{"command":"mockSendHotWords"}` | 模拟一次完整热词上报流程 |

## 分析步骤

当用户提供日志时，按以下顺序检查：

1. **过滤关键 TAG**：`grep` 出 `XS_VoiceSee` 相关日志
2. **检查初始化**：是否有 `init` → `onConnected` 完整链路
3. **检查 WebView 绑定**：是否有 `bindWebView`
4. **检查热词数据源**：是否有 `reportAccessibilityTree` 回调且数据非空
5. **检查上报结果**：`onGetVisibleInfo` 中 `hotwords` 是否非空，耗时是否 < 100ms
6. **检查指令执行**：`onExecuteName`/`onExecuteIndex` 是否正常触发并传递到 JS
7. **汇总问题**：给出具体的问题定位和修复建议

## 常见问题速查表

| 现象 | 可能原因 | 排查方法 |
|---|---|---|
| 语音助手说"不支持可见可说" | 未初始化/未连接 | 查 `init` 和 `onConnected` 日志 |
| 唤醒后无热词提示 | hotwords 为空 | 查 `appVisible?.hotwords` 日志内容 |
| 热词能显示但点击无反应 | JS 执行失败 | 查 `callJsExecuteVoiceCommand callback` |
| 热词偶尔丢失 | 超时(>100ms) | 查 `onGetVisibleInfo cost` 耗时 |
| 其他 WebApp 打开后热词失效 | listener 被清空 | 查是否有 `registerListener` 重新注册 |
| 非主进程无法使用 | 初始化条件限制 | 确认 `isInMainProcess` 为 true |
