# 《AppMarket 应用 Bug 分析辅助手册 v1.0》

> 📖 **使用说明**：本手册为 AAOS AppMarket 类应用 Bug 分析的**通用辅助文档**。配合「一份日志 + 一段复现视频」即可完成从**现象 → 分类 → 定性 → 定位 → 方案**的全流程分析。
>
> **适用对象**：人类工程师 / AI 分析助手 / 测试人员
> **输入要求**：logcat 日志（必需）+ 复现视频/截图（必需）+ 环境信息（可选）
> **输出能力**：问题类型 / 错误性质 / 根因假设 / 修复方案（代码错误时）

---

## 📑 目录

1. [使用流程（四步法）](#1-使用流程四步法)
2. [Bug 分类体系](#2-bug-分类体系)
3. [诊断决策树](#3-诊断决策树)
4. [错误性质判定矩阵](#4-错误性质判定矩阵)
5. [分类诊断 Playbook](#5-分类诊断-playbook)
6. [日志关键词速查表](#6-日志关键词速查表)
7. [视频分析 Checklist](#7-视频分析-checklist)
8. [修复方案模板库](#8-修复方案模板库)
9. [AAOS 特有陷阱库](#9-aaos-特有陷阱库)
10. [输出报告模板](#10-输出报告模板)

---

## 1. 使用流程（四步法）

```
┌─────────────────────────────────────────────────────┐
│ Step 1  视频观察  →  定位【现象类型】               │
│         用第 7 节 Checklist，判断 UI/功能/崩溃/卡顿  │
├─────────────────────────────────────────────────────┤
│ Step 2  日志扫描  →  提取【关键错误】               │
│         用第 6 节关键词表，grep 出异常行             │
├─────────────────────────────────────────────────────┤
│ Step 3  决策树走查 →  定性【分类+性质】             │
│         用第 3 节决策树 + 第 4 节矩阵                │
├─────────────────────────────────────────────────────┤
│ Step 4  Playbook →  给出【根因+方案】               │
│         用第 5 节 Playbook + 第 8 节方案模板         │
└─────────────────────────────────────────────────────┘
```

---

## 2. Bug 分类体系

### 2.1 一级分类（按现象）

| 代号 | 类型 | 典型表现 |
|------|------|---------|
| **UI-01** | 布局错乱 | 控件重叠/超出屏幕/黑边 |
| **UI-02** | 适配问题 | 不同分辨率/DPI 显示异常 |
| **UI-03** | 渲染异常 | 白屏/黑屏/闪烁/图片不显示 |
| **UI-04** | 交互失效 | 点击无响应/滑动卡顿 |
| **FUNC-01** | 功能异常 | 按钮逻辑错误/流程走不通 |
| **FUNC-02** | 数据错误 | 显示内容错/数据丢失 |
| **FUNC-03** | 状态错误 | 登录态丢失/状态不同步 |
| **DRIVE-01** | 走行限制 | 行车中功能未屏蔽/误屏蔽 |
| **DRIVE-02** | 驾驶分心 | 动画/弹窗违反 CDD |
| **PERF-01** | 卡顿 | UI 掉帧/操作延迟 |
| **PERF-02** | ANR | 主线程阻塞 ≥5s |
| **PERF-03** | OOM | 内存溢出 |
| **PERF-04** | 耗电/发热 | CPU 100%/温度异常 |
| **CRASH-01** | 应用闪退 | FATAL EXCEPTION |
| **CRASH-02** | Native Crash | SIGSEGV/SIGABRT |
| **INT-01** | MediaSession | 媒体控制失效 |
| **INT-02** | IPC/Binder | 跨进程调用失败 |
| **INT-03** | 权限拒绝 | SecurityException |
| **INT-04** | 账号/支付 | 三方 SDK 异常 |
| **NET-01** | 网络异常 | 请求超时/401/5xx |
| **NET-02** | 证书错误 | SSL/TLS 问题 |
| **SYS-01** | Framework | AMS/WMS 异常 |
| **SYS-02** | 虚拟化 | 虚机通信/性能 |

---

## 3. 诊断决策树

```
拿到 [日志 + 视频]
        │
        ▼
┌─────────────────────┐
│ 日志里有 FATAL？     │──YES──▶ CRASH 类（跳 Playbook §5.5）
└─────────┬───────────┘
         NO
          ▼
┌─────────────────────┐
│ 日志里有 ANR？       │──YES──▶ PERF-02（跳 §5.4）
└─────────┬───────────┘
         NO
          ▼
┌─────────────────────┐
│ 视频里是否闪退？     │──YES──▶ 无日志 FATAL = SIGNAL/被系统杀
└─────────┬───────────┘          （查 lowmemorykiller / dumpsys）
         NO
          ▼
┌─────────────────────┐
│ 视频里是否显示异常？ │──YES──▶ UI 类（跳 §5.1）
│（布局/渲染/黑白屏）  │
└─────────┬───────────┘
         NO
          ▼
┌─────────────────────┐
│ 视频里功能不对？     │──YES──▶ FUNC 类（跳 §5.2）
└─────────┬───────────┘
         NO
          ▼
┌─────────────────────┐
│ 车在行驶中才复现？   │──YES──▶ DRIVE 类（跳 §5.3）
└─────────┬───────────┘
         NO
          ▼
┌─────────────────────┐
│ 卡顿/慢？            │──YES──▶ PERF-01（跳 §5.4）
└─────────┬───────────┘
         NO
          ▼
┌─────────────────────┐
│ 网络相关？           │──YES──▶ NET 类（跳 §5.7）
└─────────┬───────────┘
         NO
          ▼
┌─────────────────────┐
│ 媒体/账号/支付？     │──YES──▶ INT 类（跳 §5.6）
└─────────┬───────────┘
         NO
          ▼
     兜底：查 SYS 类 + 多设备对比
```

---

## 4. 错误性质判定矩阵

### 四象限定性

```
              必现
                │
   ┌────────────┼────────────┐
   │            │            │
   │ 【A】      │ 【B】       │
   │ 代码错误    │ 代码错误    │
   │ （逻辑）    │ （资源/适配）│
   │            │            │
单─┼────────────┼────────────┼─多
设  │            │            │ 设
备  │ 【C】      │ 【D】      │ 备
   │ 偶现Bug    │ 环境错误   │
   │（时序/竞态）│（系统/网络）│
   │            │            │
   └────────────┼────────────┘
                │
              偶现
```

### 判定规则

| 判定维度 | 代码错误 | 环境错误 | 其他 |
|---------|---------|---------|------|
| **多设备可复现** | ✅ 是 | ❌ 仅某设备 | — |
| **日志含 App 包名异常** | ✅ 是 | ❌ Framework/system_server | — |
| **断网/换网影响** | ❌ 无关 | ✅ 强相关 | — |
| **清数据后消失** | ⚠️ 可能 | ❌ | ✅ 用户数据类 |
| **重启后消失** | ❌ 必复现 | ⚠️ 可能 | ⚠️ |
| **换账号消失** | ❌ | ❌ | ✅ 账号数据类 |
| **行车/静止差异** | — | — | ✅ 走行策略 |

### 关键判定句

- **「同一 APK 在 A 设备 OK，B 设备 NOK」**→ 80% 概率是**适配层代码错误**
- **「仅夜间/特定时段出现」**→ 高概率是**环境错误**（网络/服务端）
- **「100% 必现 + 堆栈指向 App 代码」**→ **代码错误**，必须修
- **「日志无异常但视频有现象」**→ 检查 **UI 线程/渲染链路** 或 **系统级拦截**

---

## 5. 分类诊断 Playbook

### 5.1 UI 类 Playbook

**观察点（视频）**：
- [ ] 是否有黑白屏？持续时间？
- [ ] 控件位置是否偏移？对比不同屏幕
- [ ] 是否有闪烁？频率？
- [ ] 点击后是否有水波/焦点反馈？

**日志关键词**：
```
Choreographer: Skipped \d+ frames
OpenGLRenderer: Davey!
ViewRootImpl: measure/layout
Resources$NotFoundException
InflateException
Bitmap too large
```

**常见根因**：

| 现象 | 根因 | 代码/环境 | 方案 |
|------|------|----------|------|
| 横竖屏切换崩 | onConfigurationChanged 未处理 | 代码 | 加 configChanges 或状态保存 |
| HDPI 图片糊 | 缺 xxhdpi 资源 | 代码 | 补齐资源目录 |
| 控件超出屏幕 | 硬编码 dp 未用 ConstraintLayout | 代码 | 改响应式布局 |
| 黑屏 2s+ | 主线程 IO 阻塞首帧 | 代码 | 迁异步 |
| 随机闪烁 | 双 Activity 叠加/主题冲突 | 代码 | 检查 launchMode |

### 5.2 FUNC 类 Playbook

**观察点（视频）**：
- [ ] 操作路径和预期是否一致？
- [ ] 在哪一步出错？
- [ ] 是否有提示 Toast？

**日志关键词**：
```
NullPointerException
IllegalStateException
IndexOutOfBoundsException
onError/onFailure
retrofit|okhttp|response
```

**常见根因**：

| 现象 | 根因 | 代码/环境 | 方案 |
|------|------|----------|------|
| 按钮无反应 | Listener 未注册/被覆盖 | 代码 | 检查 setOnClickListener 链 |
| 数据显示错 | 缓存脏/数据映射错 | 代码 | 清缓存 + 加 version 字段 |
| 状态不同步 | LiveData/Flow 未 observe | 代码 | 检查生命周期 |
| 登录态丢失 | Token 刷新逻辑错 | 代码+环境 | 检查 401 重试 |

### 5.3 DRIVE（走行）类 Playbook

**观察点（视频）**：
- [ ] 车速信息（车机仪表）
- [ ] 是否在驾驶模式？
- [ ] 屏蔽蒙层是否出现/消失？

**日志关键词**：
```
CarPropertyManager|CarUxRestrictions
DrivingState|UX_RESTRICTIONS
getCurrentCarUxRestrictions
DRIVING_MODE|PARK|MOVING
```

**常见根因**：

| 现象 | 根因 | 代码/环境 | 方案 |
|------|------|----------|------|
| 行车未屏蔽 | 未注册 CarUxRestrictionsManager | 代码 | 注册监听 + 拦截 Activity |
| 静止也被屏蔽 | getCurrentCarUxRestrictions 误判 | 环境/代码 | 查 CarService 状态 |
| 视频超长 | 未遵循 NO_VIDEO 限制 | 代码 | 动态降级为静态海报 |
| 弹窗违规 | Distraction-Optimized 未标记 | 代码 | 加 `distractionOptimized="true"` |

### 5.4 PERF 类 Playbook

**观察点（视频）**：
- [ ] 卡顿是否与动画/滚动相关？
- [ ] CPU/内存曲线（如有录）

**ANR 日志关键词**：
```
ANR in com.xxx
Input dispatching timed out
Broadcast of Intent timeout
CPU usage from
"main" prio=5 tid=1
```

**定位步骤**：
1. 找 `ANR in` 所在进程
2. 读 `/data/anr/traces.txt` 主线程堆栈
3. 看 `tid=1` 栈顶在哪
4. 判断是 IO/Lock/Native/Binder

**常见根因**：

| 栈顶特征 | 根因 | 方案 |
|---------|------|------|
| `BinderProxy.transact` | 远端服务卡 | 异步调用/加超时 |
| `SQLiteDatabase.*` | 主线程查 DB | Room + coroutine |
| `Object.wait` | 锁竞争 | 重构锁/用 CAS |
| `Socket.connect` | 主线程网络 | 搬子线程 |

### 5.5 CRASH 类 Playbook

**标准堆栈模板**：
```
FATAL EXCEPTION: main
Process: com.xxx.appmarket, PID: 12345
java.lang.NullPointerException:
    Attempt to invoke virtual method '...' on a null object reference
    at com.xxx.AppDetailActivity.onCreate(AppDetailActivity.java:87)
    at android.app.Activity.performCreate(Activity.java:xxxx)
    ...
```

**定位口诀**：
1. 看 **Exception 类型**（决定类别）
2. 看 **第一个「你的包名」的栈帧**（定位行）
3. 看 **Caused by**（真正根因）

**Exception 类型速查**：

| Exception | 典型原因 | 代码/环境 |
|-----------|---------|----------|
| NullPointerException | 对象未初始化/异步返回 null | 代码 |
| ClassCastException | 泛型擦除/类型误用 | 代码 |
| IllegalStateException | 生命周期错/Fragment 已 detach | 代码 |
| SecurityException | 权限缺失 | 代码+环境 |
| OutOfMemoryError | 大图/内存泄漏 | 代码 |
| RuntimeException (DeadObjectException) | Binder 对端死 | 环境 |
| ForegroundServiceStartNotAllowedException | A12+ 后台启 FGS | 代码 |

### 5.6 INT（集成）类 Playbook

**MediaSession 日志关键词**：
```
MediaBrowserCompat|MediaBrowserService
onConnected|onConnectionFailed
MediaSession|setPlaybackState
MediaControllerCompat
```

**MediaSession 常见坑**：

| 现象 | 根因 | 方案 |
|------|------|------|
| onConnectionFailed | Service 未注册到 manifest | 加 intent-filter `android.media.browse.MediaBrowserService` |
| 控件不显示 | PlaybackState 未调 setActive | `session.setActive(true)` |
| 播放/暂停无效 | Callback 未实现 | 补 onPlay/onPause |

### 5.7 NET 类 Playbook

**日志关键词**：
```
UnknownHostException
SocketTimeoutException
SSLHandshakeException
HTTP/\d\.\d\s(4\d{2}|5\d{2})
CertificateException
```

**速查**：

| 现象 | 代码/环境 |
|------|----------|
| 4xx | 代码（请求参数） |
| 5xx | 环境（服务端） |
| DNS fail | 环境（网络/DNS） |
| SSL fail | 环境（证书）或代码（未信任） |

---

## 6. 日志关键词速查表

### 按严重度排序（grep 顺序）

```bash
# P0 必查（一旦出现必定是问题）
FATAL EXCEPTION
ANR in
signal \d+ \(SIG(SEGV|ABRT|BUS)
low memory killer
tombstone

# P1 强信号
NullPointerException
SecurityException
DeadObjectException
ForegroundServiceStart.*NotAllowed
Resources\$NotFoundException
OutOfMemoryError
NetworkOnMainThreadException

# P2 上下文信号
Exception|Error
WARN|WTF
Skipped \d+ frames
GC.*\d+ms
Binder.*blocked
wm_on_(create|resume|pause)_called

# P3 领域专用
CarUxRestrictions
MediaBrowser|MediaSession
PackageManager.*died
```

### 按模块分类

| 模块 | 关键 TAG |
|------|---------|
| ActivityManager | `ActivityManager`, `ActivityTaskManager`, `ActivityThread` |
| 窗口 | `WindowManager`, `ViewRootImpl`, `InputDispatcher` |
| 包管理 | `PackageManager`, `PackageInstaller` |
| 媒体 | `MediaSession`, `MediaBrowser`, `AudioFocus` |
| 车机 | `CarService`, `CarPropertyManager`, `CarUxRestrictions` |
| 网络 | `ConnectivityManager`, `NetworkStack` |

---

## 7. 视频分析 Checklist

### 通用清单

- [ ] **起始状态**：App 冷启/热启/从哪个页面进来？
- [ ] **关键操作**：具体点了哪个控件？几次？
- [ ] **异常出现时刻**：操作后多久出现异常？
- [ ] **异常表现**：闪退/白屏/卡住/数据错？
- [ ] **恢复方式**：自动恢复/需手动退出/需重启？
- [ ] **环境线索**：网络图标/信号/电量/车速/时间

### AppMarket 专用清单

- [ ] **下载/安装阶段**：下载进度条是否卡？
- [ ] **列表滚动**：是否掉帧？
- [ ] **详情页跳转**：是否黑屏过渡？
- [ ] **图标加载**：占位图/真图切换是否异常？
- [ ] **搜索框**：输入是否跟手？候选词是否正常？

---

## 8. 修复方案模板库

### 模板 8.1 空指针防御

```java
// Before
obj.method();

// After
if (obj != null) {
    obj.method();
}
// 或 Kotlin
obj?.method()
```

### 模板 8.2 生命周期安全

```java
@Override
public void onDestroy() {
    super.onDestroy();
    if (mCallback != null) {
        mManager.unregisterCallback(mCallback);
        mCallback = null;
    }
    if (mDisposable != null) {
        mDisposable.dispose();
    }
}
```

### 模板 8.3 MediaSession 标准集成

```java
// 1. AndroidManifest.xml
<service android:name=".MusicService" android:exported="true">
    <intent-filter>
        <action android:name="android.media.browse.MediaBrowserService" />
    </intent-filter>
</service>

// 2. Service
public class MusicService extends MediaBrowserServiceCompat {
    @Override
    public void onCreate() {
        super.onCreate();
        mSession = new MediaSessionCompat(this, TAG);
        mSession.setCallback(new SessionCallback());
        mSession.setActive(true);
        setSessionToken(mSession.getSessionToken());
    }
}
```

### 模板 8.4 CarUxRestrictions 标准监听

```java
CarUxRestrictionsManager mgr =
    (CarUxRestrictionsManager) car.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE);
mgr.registerListener(r -> {
    if (r.isRequiresDistractionOptimization()) {
        // 屏蔽非 DO 功能
        hideNonDrivingUI();
    } else {
        showAllUI();
    }
});
```

### 模板 8.5 SMALI 层空指针修复

```smali
# Before
invoke-virtual {v0}, Lcom/xxx/Foo;->bar()V

# After（插入 null check）
if-eqz v0, :cond_skip
invoke-virtual {v0}, Lcom/xxx/Foo;->bar()V
:cond_skip
```

### 模板 8.6 主线程阻塞迁移

```kotlin
// Before (ANR 高危)
val data = db.query(...)
updateUI(data)

// After
lifecycleScope.launch {
    val data = withContext(Dispatchers.IO) { db.query(...) }
    updateUI(data)
}
```

---

## 9. AAOS 特有陷阱库

### 9.1 走行策略陷阱

- **陷阱**：`getCurrentCarUxRestrictions()` 首次返回可能为 null（Service 未 ready）
- **陷阱**：`NO_VIDEO` 限制下播放器必须降级而不是黑屏
- **陷阱**：多显示屏下 Restrictions 可能按显示屏独立，需 `CarUxRestrictionsManager#registerListener(..., displayId)`

### 9.2 多用户 / 多屏陷阱

- 副驾屏 `displayId != 0`，资源要按 display 区分
- User 0 (system) 和 User 10 (driver) 的数据隔离

### 9.3 虚拟化陷阱

- VM ↔ Host 通信延迟可导致 Binder timeout（误报为 ANR）
- GPU 虚拟化下 OpenGL 版本可能低于宿主

### 9.4 包管理陷阱

- AppMarket 下载后调 `PackageInstaller`，A12+ 需 `REQUEST_INSTALL_PACKAGES` 权限
- 静默安装需系统签名 + `INSTALL_PACKAGES`

### 9.5 媒体陷阱

- `AudioFocus` 在车机中多个音源争抢（导航/电话/媒体），需正确响应 `AUDIOFOCUS_LOSS_TRANSIENT`

---

## 10. 输出报告模板

拿到 [日志 + 视频 + 本手册] 后，按此模板输出：

```markdown
# Bug 分析报告

## 基本信息
- 问题标题:
- 严重程度: P0/P1/P2/P3
- 影响范围:
- 分析日期:

## 问题分类
- 一级分类: [UI-01 / FUNC-02 / DRIVE-01 / ...]
- 错误性质: ☐ 代码错误  ☐ 环境错误  ☐ 其他
- 判定依据: [多设备复现？日志指向？...]

## 现象描述（来自视频）
- 起始状态:
- 触发操作:
- 异常表现:
- 恢复方式:

## 关键日志
\`\`\`
[摘录 5-10 行最关键的 logcat]
\`\`\`

## 根因分析
- 直接原因:
- 根本原因:
- 归类层级: 应用层/集成层/适配层/系统层/虚拟化层

## 修复方案（若为代码错误）
- 修改文件:
- 修改内容: [引用第 8 节对应模板]
- 风险评估: 低/中/高
- 回归范围:

## 若为环境错误
- 环境缺陷:
- 规避方案:
- 上报对象: [运营商/OEM/服务端团队]

## 验证方案
1.
2.

## 预防建议
-
```

---

## 📌 附录：一页速查卡（打印版）

```
┌─────────────────────────────────────────────┐
│  Bug 分析五步走                              │
├─────────────────────────────────────────────┤
│  1. 看视频 → 现象分类（UI/FUNC/DRIVE/...）   │
│  2. 搜日志 → FATAL → ANR → Exception        │
│  3. 判性质 → 多设备复现？→ 代码/环境         │
│  4. 查 Playbook → 根因 + 方案模板           │
│  5. 填报告 → 按 §10 模板输出                │
├─────────────────────────────────────────────┤
│  关键词优先级：                              │
│  FATAL > ANR > NullPointer > Security >     │
│  Skipped frames > WARN                      │
├─────────────────────────────────────────────┤
│  AAOS 必查三件套：                           │
│  • CarUxRestrictions（走行）                │
│  • MediaSession（媒体）                     │
│  • PackageInstaller（安装）                 │
└─────────────────────────────────────────────┘
```

---

> 📍 **本手册使用方式（给 AI）**：
> 当收到用户提交的「日志 + 视频 + 问题描述」时：
> 1. 先按 §1 流程走
> 2. 按 §3 决策树定分类
> 3. 按 §4 矩阵定性质
> 4. 按 §5 Playbook 给根因
> 5. 按 §8 模板给方案
> 6. 按 §10 模板输出最终报告

> 📍 **本手册使用方式（给人）**：
> 打印第 10 节速查卡贴在工位旁，拿到 Bug 时照着走。

**版本**：v1.0 | **日期**：2026-04-21 | **适用**：AAOS AppMarket 类应用
