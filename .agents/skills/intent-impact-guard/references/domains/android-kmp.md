# Android 原生与 Kotlin Multiplatform 检查表

## 变体与车型

- 确认 buildType、productFlavor、Variant、车型、Display 和分支；
- 同一分支多 Flavor 时，检查 sourceSets、Manifest overlays、资源覆盖和依赖；
- 通用能力优先进入共享模块；车型差异通过接口、配置或厂商 impl 处理；
- 不因一个 Flavor 的问题复制通用源码到该 Flavor；
- 构建和测试至少覆盖目标 Variant，并评估共用实现的代表性 Variant。

## 生命周期与内存

新增或修改以下内容必须检查成对释放：

- listener/receiver/callback；
- Handler/Runnable/定时器；
- coroutine/Flow/Job；
- WebView、Binder、ServiceConnection；
- Context、View、Activity/Fragment 引用；
- SDK 注册和厂商回调。

验证创建、前后台、配置变化、进程重建、页面销毁和异常路径。禁止用全局静态引用修复生命周期问题。

## 线程与性能

- 主线程不得增加磁盘、网络、Binder 长调用或大对象解析；
- Flow/LiveData/Compose state 避免重复订阅和无限重组；
- 列表、图片、WebView 和多 Display 检查内存峰值；
- 启动路径避免同步初始化非关键 SDK；
- 日志不得泄露密钥、账号、车辆或用户隐私。

## KMP 边界

- 业务规则优先 `commonMain`，平台 API 放 expect/actual 或平台 source set；
- Android 特有生命周期、Context、Binder 不进入 common；
- 并发、时间、文件、网络的跨平台语义要明确；
- 修改公共接口时编译所有相关 targets；
- 不在多个平台 source set 复制相同业务实现。

## AppMock 与自动化

- 生产数据源迁移时保留 AppMock 注入点；
- Mock 与真实实现共享 API/数据模型；
- debug/test 能力受构建类型和身份认证保护；
- ADB/forward/REST 自动化接口不得无鉴权暴露；
- 修复后验证真实实现与 Mock 至少各一条关键路径。
