# 可点击原型使用指南

## 地址与边界

- 原型入口：`docs/tempFiles/aiautowork-uiux-demo/index.html`
- 评审截图：`docs/tempFiles/aiautowork-uiux-demo/screenshots/`
- 原型仅使用静态 HTML、CSS、JavaScript 和本地 Mock 数据。
- 不连接 TB、Git、AI、数据库、设备、队列、通知或故事点创建接口。
- “打开旧开发工作台”始终新开 `http://127.0.0.1:3000/devbench`，不修改旧页面。

可直接双击 `index.html`。若浏览器限制本地文件，也可以在仓库根目录运行任意只读静态服务器，并访问对应目录。

## 推荐评审路径

1. 从“工作概览”识别并发、排队、待确认与 Critical。
2. 打开“故事空间”，检查旧 `/devbench` 左侧故事 Tab 的新承接方式。
3. 点击“新建故事点”，依次体验智能输入、解析、推导、审核、预检、确认和 Mock 创建。
4. 进入“批量处理”，默认只看异常；切换自动通过、组确认和人工介入。
5. 体验“配置分组确认”“批量补全”和“创建所有已就绪”。
6. 在“配置待确认”打开人工介入 Drawer，只处理异常字段。
7. 在“工作台设置”修改并发或阈值，保存并观察反馈。
8. 使用顶栏“Demo 场景”快速切换异常、空状态和并发场景。

## 深链接截图场景

原型支持 `?screen=<name>`，用于稳定复现评审状态：

| screen | 状态 |
|---|---|
| `overview` | 工作概览 |
| `running` / `todo` / `reviews` / `tb` | 四个主要列表 |
| `batch-exceptions` / `batch-auto` | 批量异常与自动通过 |
| `batch-parse` | 100 条解析预览 |
| `group-confirm` / `batch-fill` | 分组确认与批量补全 |
| `config-compare` | AI 推荐和最终配置对比 |
| `project-picker` / `dependencies` / `branches` / `flavor` | 配置子界面 |
| `preflight` | 配置预检 |
| `repair-success` / `repair-failed` | 自动修复结果 |
| `candidate-history` / `rollback` | 候选版本和恢复最佳候选 |
| `human` | 人工介入 |
| `create-ready` / `create-partial` / `queue` | 创建、部分成功和执行队列 |
| `settings-concurrency` / `settings-inference` | 设置 |
| `scenarios` | Demo 场景切换器 |

## Mock 数据

- 15 条 TB 单，其中 8 条已有故事点。
- 5 条手工任务。
- 8 条 Git Review 和 2 个 Review Batch。
- 4 个 TB Mock 数据来源，并模拟跨来源去重和部分失败。
- 3 个 Git 仓库、6 个工程、多分支、多依赖与多 Flavor。
- V1、V2、V3 三个候选配置版本及评分下降、恢复最佳候选场景。
- 100 条完整批次：3 重复、2 无效、95 有效、68 自动通过、17 建议组确认、8 人工介入、2 达到最大修复次数。

## 可点击范围

导航、二级 Tab、搜索、批量筛选、主要 Drawer/Dialog、创建向导、候选版本、配置子界面、批量补全、组确认、创建结果、设置修改、保存、恢复默认、重置和场景切换均有本地反馈。

表格中的低频“更多”操作只模拟 Toast；这是原型边界，不代表已接入真实服务。
