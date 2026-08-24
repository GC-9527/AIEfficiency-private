# AIEfficiency 缺陷与防回归台账

本台账记录已经发生、且必须通过自动化机制防止再次出现的缺陷类型。聊天记录、`docs/tempFiles/` 验收材料和本机日志只作为临时证据；只有版本化规则、测试和构建门禁属于长期工程记忆。

## 使用规则

每次修复缺陷时必须补充或更新一条记录，至少包含：

- 用户可见现象与受影响版本；
- 根因和容易产生误判的检查方式；
- 必须长期保持的行为合同；
- 自动化回归测试和构建/运行时门禁；
- 修复版本、验收范围及仍未覆盖的风险。

代码回退前必须先确认引入提交和保留合同，优先使用最小文件或 hunk 变更。缺陷只有同时具备“复现、测试、门禁、台账、验收”才算关闭。

---

## REG-20260822-DEVBENCH-001：故事点 worktree 动态目录名破坏跨仓固定兄弟源码依赖

- 复现：应用市场工程通过 `../AppMarketWeb` 引用 WebApp 源码时，DevBench 分别创建 `v202605_ui_CARB_13998`、`v202605_ui_CARB_13998_webapp` 等动态目录；两个 checkout 虽来自同一逻辑分支，但目录名不满足固定兄弟关系，Gradle 配置阶段无法解析依赖工程。
- 根因：原 worktree 管理器把 Flavor、分支和工单标识放在每个仓库目录层，没有“一个故事点、多个固定目录成员”的原子工作区模型；仓库共享定义也没有保存构建入口、固定目录名、成员模式和严格分支策略。
- 行为合同：
  - 未配置 Bundle 的工程继续使用原单仓布局；启用 Bundle 的故事点必须落在 `WorktreeSpace/<工单短标识-故事点哈希>/`，成员使用配置中的区分大小写固定目录名，且都是该父目录的直接子级；
  - Bundle 必须声明唯一可修改的必需构建入口，所有实际创建成员使用同一逻辑分支；只读成员使用 detached checkout，高层 Git 写接口和 Provider Prompt 都必须阻止其被修改、提交或推送；
  - 多仓创建、固定目录迁移、文件元数据和 SQLite 恢复镜像作为一个事务处理；任一成员分支、路径、持久化或布局校验失败时回滚本轮新建和移动，保留 `FAILED` 状态与本地诊断日志，并禁止进入 AI；
  - AI 派发前重新检查共同父目录、固定大小写目录名、成员存在性、逻辑分支、构建入口和只读 detached 状态；工作区进入 `READY` 前必须从构建入口目录自身的 Gradle wrapper 执行 `projects`，缺 wrapper 或配置失败时整单回滚；Worker 重启只在 tab、SQLite 与 `.aiefficiency/workspace.json` 证据一致时恢复；
  - 清理只处理当前 Bundle 的登记 worktree、预留文件、元数据和恢复记录，不递归删除共享根或基础仓库。
- 自动化守卫：
  - `gateway/test/workspace-bundle.test.mjs`
  - `gateway/test/worktree-manager.test.mjs` 中的固定兄弟目录、失败回滚、双可修改仓、脏工作区迁移和幂等恢复用例
  - `gateway/test/worktree-routes.integration.test.mjs` 中的 Bundle HTTP、Gradle 构建入口门禁、双故事点并发、只读写门禁、SQLite/文件恢复和安全清理用例
  - `gateway/test/story-repository-path-resolver.test.mjs` 中的 AI 派发前 Bundle 完整性门禁
  - `gateway/test/store.test.mjs`
  - `web-dashboard/src/pages/devbench/workspaceBundleModel.test.mjs`
  - `web-dashboard/src/pages/devbench/workspaceBundleSummaryModel.test.mjs`
  - Gateway 定向测试、Web 生产构建及全栈质量门禁。
- 修复版本：2026-08-22 工作区重构，尚未提交版本号。
- 验收范围：隔离 Git 仓库和隔离 Gateway 覆盖本地源码、两个并发故事点、只读 WebApp、两个可修改仓库、缺分支回滚、含未提交改动迁移、重启恢复与清理；真实业务 AppMarket/WebApp 仓库和目标车型 Gradle 构建未在本轮隔离自动化中执行。
- 残余风险：不同 Git 版本、Linux 大小写文件系统和真实 Android/Gradle 复合工程仍需在部署前各做一次目标分支 smoke；detached 与平台 Git 写门禁阻止正常误操作，但底层 Agent 沙箱暂不支持单个附加根的 OS 级只读权限，因此仍保留每轮 Prompt 只读规则和清理前 dirty 检查作为纵深保护。

## REG-20260804-STORYDEV-001：Windows 换行转换导致 MiniMax 执行包误报 task graph 漂移

- 复现：在 `core.autocrlf=true` 的 Windows checkout 中，从仓库根执行 `task-orchestrator.mjs --check`；即使工作区干净，也报“task-graph.yaml 内容摘要与 runtime index 不一致，必须重新编译 runtime”。把根 `README.md` 直接交给 MiniMax 时，文档又首先引导到明确被 B-08 阻断的 `--run` 入口，Agent 只能笼统返回“无法执行”。
- 根因：`task-runtime/index.json` 保存的是 Git blob 的 LF 文本摘要，运行器和 `acceptance-probes` 却对工作区 CRLF 原始字节计算 SHA-256；同一文本因此在 Windows 上产生不同摘要。测试还把历史生成仓库名 `AIEfficiency202606` 写死，与当前 `AIEfficiency` checkout 不符。根 README 同时缺少可直接派发的首个原子任务、预期输出和阻断分类。
- 行为合同：
  - `task-graph.yaml` 的来源摘要按 UTF-8 文本计算，并仅把 CRLF/CR 规范化为 LF；换行风格变化必须等价，任何其他内容变化仍必须触发漂移失败。
  - `runtime-graph` 和 `--check` 在 Windows `core.autocrlf=true` checkout 中必须通过，并保留 `productionRun=BLOCKED`；仓库根验证必须对照 `git rev-parse --show-toplevel`，不得依赖副本目录名。该结果是 B-08 安全状态，不是包损坏。
  - 根 README 单独发送给 MiniMax 时必须明确首轮只执行 `EC-M0-T01`、列出必读材料和预检命令，并区分无工作区、Node 版本、脏文件重叠、包损坏和生产门禁；不得引导 Agent 绕过 B-08 或伪造 `READY`。
- 独立验收追加根因：初版修复后，README 允许 resultPlan-only 提交继续，但预生成 `EC-M0-T01` 仍要求 HEAD 精确等于不可解析的历史 SHA `5733060...`，导致 MiniMax 必然返回 `STALE`。执行包基线现统一为当前仓库可解析的 `d55fc504adb06369273e1f86dce9d1f14552b1f6`，并以“commit 存在 + 为 HEAD 祖先 + 基线后无产品路径提交”判定；执行包与本条台账属于非产品支持路径。
- 自动化守卫：`task-orchestrator.test.mjs` 覆盖 LF/CRLF 等价、内容漂移不等价、当前 task graph 与 runtime 摘要一致、Git 根目录动态解析、baseline commit 可解析/祖先/路径分类，以及 README 与首个 MiniMax Prompt 的一致性和 B-08 禁止合同；`acceptance-probes.mjs runtime-graph` 与 `task-orchestrator.mjs --check` 是交付前预检。
- 修复版本：2026-08-04 工作区修复，尚未提交版本号。
- 残余风险：当前机器只有 Node 22.11.0，包结构预检可执行，但 `EC-M0-T01` 要求的 Node 24.14.1 产品测试仍需在匹配运行时复跑；B-08 外部 sandbox runner、签名信任根和 admission-ledger receipt 仍未交付，正式生产编排继续保持 `BLOCKED`。

## REG-20260731-DEV-001：故事点任务面板回退范围过大

- 现象：为了移除 aiautowork 影响而回退了过多代码，破坏了任务面板已有的双 Tab 行为。
- 根因：以整文件状态作为回退目标，没有先列出必须保留的 UI/数据行为。
- 行为合同：
  - 面板始终包含“待办列表”和“TB单列表”两个 Tab；
  - 当前 Tab 使用 `devbench_task_panel_active_tab_v1` 持久化；
  - 非法或已删除的缓存值回退到“待办列表”；
  - TB 候选列表仍支持搜索、分组和加入待办。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/taskPanelTabsModel.mjs`
  - `web-dashboard/src/pages/devbench/taskPanelTabsModel.test.mjs`
  - `web-dashboard` 的 `npm test`
  - Desktop 发布 `npm run preflight`
- 修复版本：Desktop 1.6.11 的发布门禁开始强制执行。
- 残余风险：模型/源码合同测试不替代真实浏览器点击验收；涉及交互布局时仍需运行 Web 构建并人工抽查。

## REG-20260731-DESKTOP-001：Desktop 本地模块漏入 app.asar

- 现象：安装后 Electron 主进程报 `Cannot find module './external-url.js'`，源码存在但安装包缺失。
- 根因：`desktop/package.json` 使用显式 `build.files`，新增的传递依赖没有同步加入；构建只验证成功打包，没有验证运行时依赖闭包。
- 行为合同：Desktop 入口及其所有静态本地依赖必须同时被 `build.files` 覆盖，并存在于最终 `app.asar`。
- 自动化守卫：
  - `desktop/scripts/verify-package.cjs`
  - `desktop/scripts/verify-package.test.cjs`
  - `desktop/scripts/before-pack.cjs`
  - `desktop/scripts/after-pack.cjs`
  - `scripts/build.ps1` 的 Desktop release preflight
- 修复版本：1.6.9；1.6.11 将检查纳入统一 preflight。
- 残余风险：静态依赖图不解析计算生成的模块路径；此类路径必须改为显式清单或增加专门测试。

## REG-20260731-DESKTOP-002：Gateway 原生模块 ABI 与内置 Node 不兼容

- 现象：Desktop 可以安装，但 Gateway 启动时 `better_sqlite3.node` 报 NODE_MODULE_VERSION 127→137 不兼容。
- 根因：
  - 仅执行 `require('better-sqlite3')`，没有打开数据库，因此原生 binding 未被加载；
  - 打包 Node 取自构建机器，版本未固定；
  - Gateway bundle 直接复制开发目录中的历史 `node_modules`；
  - 覆盖升级继续保留 AppData 中的旧原生模块。
- 行为合同：
  - 构建 Node 必须与 `.node-version`、Desktop/Gateway package 和 lock metadata 完全一致；
  - Gateway 生产依赖必须在隔离 staging 中通过 `npm ci --omit=dev` 生成；
  - 所有原生检查必须实际打开 `:memory:` 数据库并执行 `SELECT 1 AS ok`；
  - 覆盖升级发现不兼容时必须替换 AppData `node_modules`，然后再次验证；二次失败必须停止启动。
- 自动化守卫：
  - `.node-version`
  - `desktop/scripts/runtime-policy.cjs`
  - `desktop/scripts/preflight.cjs`
  - `desktop/scripts/gateway-bundle.cjs`
  - `desktop/gateway-runtime.cjs`
  - `desktop/gateway-dependency-manager.cjs`
  - 对应 `*.test.cjs`
  - `beforePack`、`afterPack` 与运行时三层检查
- 修复版本：1.6.10；1.6.11 增加固定 Node、干净 staging 和可执行修复合同。
- 残余风险：不同操作系统和 CPU 架构仍需各自产物构建与原生 smoke；Windows 验收不能代表 macOS。

## REG-20260801-DEVBENCH-001：故事点运行中消息无法实时追加且 AI 身份误标

- 现象：`cfd7485` 将新故事点默认引擎改为 Codex 后，网页仍只有 Claude `stream-json` 注入实现；Codex 工作中发送的消息只能排队。队列状态刷新后不可见，Gateway 重启后也可能不再出队。部分回答只显示引擎名/模型，改写 API 地址的 Claude/Codex 可能被误认为官方产品。
- 根因：
  - 将“CLI 名称/模型名称”当成接入能力，没有按 Claude stream-json、Codex app-server、OpenAI 兼容直连 API 等真实协议建模；
  - Codex `exec` 是单次 stdin，未接入 app-server 的 `thread/start`、`turn/start`、`turn/steer` 事件流；
  - 把 `stream.write()` 返回 `false`（背压）误判成写入失败，可能把已接收消息再次入队；
  - 持久队列的调度依赖当前进程内的完成回调，启动恢复没有重新扫描；
  - AI 快照没有固化产品、服务商、接入方式、脱敏端点和官方/兼容标识；中心机也没有回传其实际代理后端。
- 行为合同：
  - Claude Code 外壳通过 stream-json、Codex CLI 外壳通过 app-server `turn/steer` 实时追加；网关直连/未知接入只使用持久 FIFO 队列；协议失败必须安全回退队列且不得重复执行首条 prompt；
  - `turn/start` 响应不代表 turn 已可追加，必须等到 `turn/started`；Node 写流只有回调失败才算失败，背压不是拒绝；
  - Gateway 恢复会重新调度所有持久队列，网页通过 WebSocket/重载展示待发送条目；
  - 每条回答固化实际产品、provider、接入协议、脱敏 endpoint、model、档位及 official 标志；Claude/Codex 外壳映射到火山方舟、MiniMax 等兼容端点时不得标成 Anthropic/OpenAI 官方；中心机必须回传实际生效的代理后端，旧中心机未回传时明确显示未知；
  - Windows Codex app-server 使用固定 `cmd.exe` 启动参数和非 detached 双向管道；Linux/macOS 使用独立进程组。每个 app-server 使用独立临时运行目录并在退出后清理，避免跨任务状态库锁与 provider 串线。
- 自动化守卫：
  - `gateway/test/codex-app-server.test.mjs`
  - `gateway/test/devbench-message-delivery.test.mjs`
  - `gateway/test/ai-model-metadata.test.mjs`
  - `gateway/test/store.test.mjs`
  - `web-dashboard/src/pages/devbench/engineStatusCache.test.mjs`
  - `web-dashboard` 的 `npm test` 与 `npm run build`
  - Gateway 启动运行态恢复中的 `schedulePersistedTabQueueDrains()`；Codex 启动前的 app-server CLI 能力预检。
- 修复版本：2026-08-01 工作区修复，尚未提交版本号。
- 验收范围：Windows 本机真实验证官方 Codex/OpenAI 与 Codex/MiniMax 的同一活动 turn 实时追加；自动化覆盖 Claude/Codex/API 能力矩阵、背压、竞态、队列恢复、中心机身份回传、存档往返和网页实时显示数据模型。
- 残余风险：尚未在 macOS/Linux 和旧版 Codex CLI 上做真实进程探测；这些环境由跨平台单测和运行时预检覆盖，预检失败会降级为持久队列。未执行真实浏览器人工点击/截图验收，网页部分以生产构建、前端测试及后端真实协议探测为证据。

## REG-20260801-DEVBENCH-002：故事点聊天附件生命周期和交付 UI 语义混乱

- 现象：拖拽文件会自动成为每轮持续注入的故事点材料，发送后仍显示在输入框上方；粘贴图片会被强制改成 `paste_*`，且发送后不在用户消息气泡中显示。输入附件没有完整预览/定位入口，AI 回复中的图片和文件也缺少一致的展开、下载交付体验。用户点击移除时容易误以为文件已删除或 AI 已忘记。
- 根因：拖拽材料与粘贴附件使用两套状态和生命周期；消息虽保存了部分 `input.attachments` 元数据，但消息气泡没有消费。剪贴板只处理图片并覆盖文件名；普通附件定位端点只覆盖安装包。图片附件仅以路径文字进入 Prompt，没有接到执行器已有的 `imagePaths`。
- 行为合同：
  - 普通拖拽、粘贴附件默认只属于当前消息；发送后从输入区移入对应用户消息气泡，已发送消息的附件元数据可持久化并兼容旧记录；
  - 优先保留浏览器或系统剪贴板提供的真实文件名，仅在来源没有名称时生成 `paste_*`；Windows 系统剪贴板回退必须由 Gateway 自行读取 FileDropList，不接受客户端任意绝对源路径；
  - Gateway 主机剪贴板路径和所有调用系统资源管理器的入口仅允许本机页面访问；局域网来源必须返回 `403`，且不得先读取剪贴板或启动 Explorer；
  - 输入区和历史用户消息中的附件支持合适尺寸的图片缩略图、展开/收起预览、下载和当前故事点边界内的资源管理器定位；
  - AI 回复中的 Markdown `storydev:/` 产物链接以及裸引用均提供预览/下载入口；AI 生成产物时应使用 `[文件名](storydev:/相对路径)` 交付；
  - 当前消息中通过故事点路径校验的普通图片文件进入执行器 `imagePaths`，文档和历史附件仍按受控引用真实读取；
  - 已发送附件随活动对话分支保留轻量历史索引，后续轮次可按需真实读取；索引出现不等于 AI 已读取，当前消息附件不重复进入历史索引；
  - “清除草稿”与“移出持续上下文”都不删除磁盘副本，也不抹除已发送历史或 Provider 会话，UI 必须明确该边界。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/storyAttachmentModel.test.mjs`
  - `web-dashboard/src/pages/devbench/storyMessageModel.test.mjs`
  - `gateway/test/clipboard-files.test.mjs`
  - `gateway/test/devbench-artifact-path.test.mjs`
  - `gateway/test/devbench-conversation-model.test.mjs`
  - `gateway/test/devbench-prompt-mode.test.mjs`
  - `web-dashboard` 的 `npm test` 与 `npm run build`
- 修复版本：2026-08-01 工作区修复，尚未提交版本号。
- 验收范围：Windows 文件剪贴板回退、故事点隔离复制和定位、结构化消息元数据、当前轮图片多模态输入、媒体分类/裸引用提取、生产构建以及浏览器附件交互。
- 残余风险：远程浏览器明确禁用 Gateway 主机的系统 FileDropList 和资源管理器定位，只能使用浏览器实际提供的文件对象上传；系统剪贴板文件夹仍要求用户拖拽上传。Office 文档是否能内联预览取决于浏览器，始终保留打开/下载入口。物理删除附件和强制 Provider 遗忘属于独立的数据治理能力，本修复未实现。

## REG-20260801-DEVBENCH-003：故事点在配置确认前被创建且推理来源被错误硬门禁

- 现象：不同新建入口直接创建 Tab/worktree 后才补工程配置；悬浮面板把空白故事点与“选择工程新建”混在一起。AI 推理默认开启，并把 TB 附件、评论等来源全部完整读取当成正向结论前提；单一来源足够时仍提示“门禁阻塞”。跨来源结论矛盾没有稳定落到最终配置。Git 批量在 AI 关闭或首项已存在时还会反复处理首项。
- 根因：创建 API 没有服务端确认意图，UI 弹窗只是创建后的配置工具；来源采集质量与“当前证据能否形成候选”共用了同一个硬门禁；冲突选择只保存标记而没有同步/校验最终草稿；批量队列没有消费当前项；创建与重新打开入口各自维护流程，缺少统一入口合同。
- 行为合同：
  - 所有真正新建入口必须先完成可选 AI 推理和统一初始化配置；用户确认前不得创建 Tab、故事目录、worktree 或设备绑定；
  - 初始化面板持有从入口、设置读取、AI 推理、人工复核到真实创建的同一事务；AI 弹窗交接和可恢复创建失败都不得提前 settle Promise 或释放入口互斥锁，失败后必须保留最新草稿供修改重试；
  - AI 推理默认关闭，只能在设置页显式开启；开启后创建和重新打开都先复核，关闭时新建仍必须经过初始化面板；
  - 空白故事点在独立 Tab 直接输入标题；不再提供“选择工程新建故事点”；初始化/既有故事配置统一覆盖 TB、主工程、关联工程、Flavor、设备和最终确认；
  - 任一可用来源都可独立形成候选，缺失/部分来源只降低置信度并显示告警；不同来源矛盾必须逐项人工裁决，候选裁决必须同步到最终草稿，草稿再变更会使旧裁决失效；
  - 生产 Gateway 只接受短期、owner 绑定的初始化确认意图；意图重放必须幂等，失败不得破坏其它故事点设备或留下被误报为“未创建”的残留；Git commit 意图还必须绑定仓库、revision、推理 run 和目标指纹；
  - 创建证明只认本次入口显式保存的 review session；被复制故事点或组锚快照中的历史 run 不得充当新建授权，空白/复制还必须冻结标题、复制来源和 TB 身份，Git 重推理必须保持 Git consumer；
  - TB 身份只认面板显式绑定并由服务端解析出的任务，不从标题中的 CARB 单号推导绑定；显式普通任务 URL 使用规范化后的哈希身份参与查重且不在指纹中泄露原文；推理实际读取的 TB 必须与任务、组首项或初始化入口一致，进行中和已关闭故事点都会参与重复绑定校验；
  - 标题、TB task、CARB 与显式 URL 身份必须在最终插入 Tab 的同一次 SQLite 事务中查重；普通入口与 Git 入口并发消费同一身份时只能有一个成功，预检查只用于提前反馈，不能充当最终唯一性保证；
  - 初始化面板选中的设备必须在意图签发和最终消费时都由服务端确认 ADB 在线；目标绑定可被多个故事点共享，创建流程不得解除其它故事点绑定，真实脚本、安装和验收必须通过设备运行时 FIFO 租约独占执行；
  - 修改既有故事点配置时不得解除其它故事点的设备绑定；设备变更必须在 worktree 副作用前校验，且当前故事点持有运行时租约时禁止切换/解绑；worktree 或最终保存失败且已有副作用时必须返回可定位、可重试的 partial；
  - 任务组成员锁定并继承首项故事点的实际工程、构建、Flavor 和设备配置，逐项创建后立即入组；迁组必须修复旧组 active 指针，工作区或入组异常必须停止后续项并以 partial 暴露真实残留，不得用旧快照隐藏磁盘状态；
  - 网络未知结果必须复用同一初始化意图；服务端明确判定意图失效后才重新签发。部分创建和部分重开必须冻结普通确认、刷新列表对账并引导人工核对，不得关闭面板、激活工作流或改写为成功；
  - 初始化面板停留期间 AI review proof 过期或规则变旧时，必须清除旧意图、保留当前草稿并回到可重新推理状态；网络、超时和 partial 结果不得误清意图；
  - 已复核 run 必须冻结复核完成后的 rules/registry/keyword/value/serving-sample revision；旧 reviewed run 缺少完整快照时失败关闭，外部配置变化后旧 proof 必须 stale，而 reviewed stale 不计入待复核指标；
  - 组队、迁组和切换活动成员必须先取得共享配置来源计划，并在同一次持久化事务中用来源指纹做 CAS；重复激活当前成员必须在创建 worktree 前幂等返回；
  - AI 推理开启时，重新打开接口只接受同一 owner 已人工复核的推理 run；服务端按 closedAt、配置指纹和关闭组成员冻结重开范围，跨故事/跨用户/过期/配置变化均拒绝，负向人工结论也可在保存后继续；
  - Git 批量队列每轮必须移除当前项；没有 TB 项目时允许用 Git 仓库或故事入口隔离域基于当前来源推理。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs`
  - `web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`
  - `web-dashboard/src/pages/devbench/gitCommitStoryModel.test.mjs`
  - `web-dashboard/src/pages/devbench/aiTrainingGovernanceModel.test.mjs`
  - `gateway/test/story-initialization.test.mjs`
  - `gateway/test/story-initialization-git-race.integration.test.mjs`
  - `gateway/test/story-ticket-identity.test.mjs`
  - `gateway/test/story-create-guard.integration.test.mjs`
  - `gateway/test/story-create-review.test.mjs`
  - `gateway/test/story-create-ai-review.integration.test.mjs`
  - `gateway/test/story-create-device.test.mjs`
  - `gateway/test/story-group-route-contract.test.mjs`
  - `gateway/test/store.test.mjs` 中的故事点组队、迁组与来源 CAS 用例
  - `gateway/test/story-reopen-review.test.mjs`
  - `gateway/test/story-reopen-review.integration.test.mjs`
  - `gateway/test/config-inference-group-source-gate.test.mjs`
  - `gateway/test/config-inference-quality.test.mjs`
  - `gateway/test/config-inference-governance-store.test.mjs`
  - `gateway/test/config-inference.test.mjs` 中的隔离同步域、重开门禁和并发复核后重新确认用例
  - `web-dashboard` 的 `npm test` 与 `npm run build`
- 修复版本：2026-08-01 首轮实现；2026-08-02 重做初始化事务、创建 review proof、原子身份占用、组来源 CAS、既有配置设备边界和失败重试，尚未提交版本号。
- 验收范围：前端 279 项完整测试与 672 模块生产构建；Gateway 故事点定向 73 项、Store 83 项及配置推理 74 项测试；隔离浏览器 5 个场景覆盖 AI 开关、人工确认/暂不采用、确认前不创建、失败保留草稿重试和配置读取失败关闭。隔离验收不对真实故事点数据、真实 TB 状态或生产工作区执行写入。
- 残余风险：真实浏览器下复杂组队/批量弹窗的连续人工操作仍需在目标部署环境复核；远程拉取和本地 worktree 的全部异常组合由回滚守卫覆盖，但不同 Git/文件系统实现仍应在发布前做一次真实仓库 smoke；既有故事点的前端配置应用仍是分步骤调用，后端会暴露 partial，但不是一个覆盖全部字段的单事务更新。

## REG-20260802-DEVBENCH-004：暂不采用 AI 推理后初始化面板长时间不消失

- 复现：新建空白故事点，进入初始化配置并触发 AI 推理，在复核页点击“暂不采用”；当复核保存接口缓慢或失败时，页面继续停留在 AI 推理浮层，用户无法判断点击是否生效。
- 根因：浮层展示状态与服务端复核持久化使用同一个等待事务；只有网络请求完成后才退出推理页，且请求没有有限超时。
- 行为合同：
  - 点击“暂不采用”必须先同步退出 AI 推理展示，再异步保存人工决定；初始化面板在保存期间显示明确状态并继续锁定最终创建；
  - 保存失败必须保留原 run、原 payload 和入口互斥锁，允许幂等重试；标题或 TB 身份变化必须废弃旧重试并要求重新推理；
  - 复核请求必须有有限超时，不得无限停留；`group_auto` 和服务端创建证明门禁保持不变。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`
  - `gateway/test/story-create-review.test.mjs`
  - `web-dashboard` 生产构建。
- 修复版本：2026-08-02 工作区修复，尚未提交版本号。
- 验收范围：前端状态模型覆盖立即退出、保存失败、同请求重试和身份失效；Gateway 创建证明回归与生产构建通过。
- 残余风险：尚未在真实高延迟网络中做人工计时和截图；30 秒超时只限制单次 HTTP 等待，服务端最终结果仍依赖幂等重放核对。

## REG-20260802-DEVBENCH-005：设备绑定被误当成物理占用且车型源码重复克隆

- 复现：故事点 A 绑定设备后，故事点 B 无法选择同一设备；反之若简单放开绑定，两个故事点的脚本/安装可能同时操作同一 serial。多车型初始化还会按车型、月份和 TB 单号重复 clone 同仓库，配置工程入口以内联展开方式挤压聊天页面。
- 根因：设备目标偏好与运行时独占混在 Tab 字段中，没有跨 Gateway 的租约、心跳、fencing、TTL 和队列模型；源码目录按故事实例命名，没有稳定的仓库/分支身份和故事点 worktree 边界；创建面板未消费服务端车型应用映射。
- 行为合同：
  - 多个故事点可共享绑定同一在线 serial；实际 AI 轮次、脚本、安装、验收和已接入的手动设备操作必须通过 SQLite 本机状态中的每设备 FIFO 租约串行化；
  - 租约必须支持 requestId 幂等、单调 fencing、心跳、精确释放/取消、TTL 恢复和重启恢复；切换绑定会取消该故事点旧设备上的排队请求，但不会影响其它故事点绑定；
  - 设备租约 TTL 上限为 5 分钟；故事点持久队列必须用 CAS 固化并复用 runtime requestId，关闭故事点要取消其等待请求，外部活跃租约存在时禁止关闭；设备运行态只允许保存在本机，不得进入跨节点同步导出或全量替换；
  - Gateway 内所有已知的显式 serial 写操作入口（shell、APK/XAPK 安装、push、原始 ADB、硬件语音和 scrcpy 启动）必须经过同一临时租约守卫；设备忙碌时应返回带当前 owner/queue/runtime 的 409，且不得启动底层命令；
  - 设备接口必须同时返回连接状态、绑定故事点、当前租约和后续队列；旧绑定 API 保持可调用但语义迁移为共享绑定；
  - 中央配置面板和兼容故事点配置区必须以同一状态组件展示设备在线状态、完整绑定故事点名称、当前使用任务及带顺序的后续 FIFO 队列；只在下拉框显示数量不算完成；
  - 初始化面板按 TB 项目读取车型源码配置，车型和应用均可多选；服务端重新展开可信仓库/分支，同仓同分支只准备一份稳定 `SourceCache`，同仓不同分支必须分目录；每个故事点使用独立 worktree；
  - `SourceCache` 准备必须使用跨 Gateway 文件系统锁和同目录私有临时目录；Git 不得直接写最终缓存路径，临时克隆验证通过后才原子发布，失败或崩溃残留只清理明确命名且已过期的临时目录，不覆盖已验证缓存；
  - Gateway 重启后必须接管没有活动共享租约的 `queued/cloning` 故事点；旧版已把共享缓存提前发布为 `local/done` 且没有 managed worktree 的记录，须先撤回可对话状态再恢复。缓存准备期间只能保持 queued/cloning，只有独立 managed worktree 原子写回成功后才能广播全局 done；
  - 默认克隆父路径为 `D:\workspace\AIProjects`；无 D 盘时选择可用空间最大盘符下的 `workspace\AIProjects`；已有显式配置不得被默认值覆盖；
  - “配置工程”及缺工程入口统一打开网页中央多 Tab 面板，不再展开故事点内联区域。
- 自动化守卫：
  - `gateway/test/device-runtime.test.mjs`
  - `gateway/test/device-operation-guard.test.mjs`
  - `gateway/test/device-operation-route-guard.integration.test.mjs`
  - `gateway/test/story-device-claim-race.integration.test.mjs`
  - `gateway/test/story-device-close.integration.test.mjs`
  - `gateway/test/story-create-device.test.mjs`
  - `gateway/test/source-preparation.test.mjs`
  - `gateway/test/source-initialization-recovery.integration.test.mjs`
  - `gateway/test/remote-clone-story-storage.test.mjs`
  - `gateway/test/story-initialization.test.mjs`
  - `gateway/test/store.test.mjs`
  - `gateway/test/devbench-queued-message.test.mjs`
  - `gateway/test/devbench-userdata.test.mjs`
  - `web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs`
  - `web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`
  - `web-dashboard/src/pages/devbench/deviceRuntimeStatusModel.mjs`
  - `web-dashboard` 生产构建。
- 修复版本：2026-08-02 工作区修复，尚未提交版本号。
- 验收范围：两个 Gateway 进程并发共享绑定、单租约 FIFO 交接和 fencing 递增；两个独立 Node 进程竞争同一真实 Git 缓存时只发生一次发布，另一个验证后复用；真实 Git 覆盖失败临时目录清理、陈旧锁接管、Gateway 重启后恢复 managed worktree、旧版提前发布状态隔离、分支隔离和消费者/Flavor 保留；ADB 只读探测确认本机两台设备在线。
- 残余风险：未在本轮对真实 Android 工程执行安装、脚本或设备重启；未接入运行时 API 的外部进程仍可能绕过协调器，插件必须使用 `/device-use` 契约。scrcpy 当前只保护启动动作，detached 投屏会话未持有覆盖窗口生命周期的租约。进程在 worktree 创建系统调用中被强制终止时，Git 可能保留未登记的 worktree 管理残留，恢复会创建新的安全工作区但仍需后续清理巡检收敛孤儿目录。

## REG-20260802-DEVBENCH-006：故事点初始化被 AI 与工作区串行阻塞且聊天命令无法单独收起

- 复现：开启故事点 AI 推理后从空白、TB、任务或 Git commit 入口新建，页面先被推理复核浮层占用，初始化配置不能并行填写；本地工程确认创建会一直等待 worktree，用户不能先进入故事点页面。初始化 Flavor 只能手输，已选工程散落在列表中；中央编辑面板缺少报告模式、存档目录和关联工程 Android Studio 入口。AI 回答中的多条工具命令以及“实时命令输出”只能整体展示，不能在回答内分别展开收起。
- 根因：入口把 AI 复核当作初始化面板之前的串行阶段，推理浮层与面板互斥；本地 worktree、设备绑定和 HTTP 创建响应处于同一同步事务；工程与 Flavor 使用普通列表/输入框；旧工作流设置仍只存在于故事点兼容区；工具命令使用截断标签，实时输出使用常开容器。
- 行为合同：
  - 所有真正新建入口先进入统一初始化配置面板；AI 设置检查与推理在面板后台并发执行，不得锁住标题、工程、Flavor、构建或设备编辑；最终创建仍必须等待人工复核证明；
  - 推理期间醒目显示“AI正在推理”；完成后同一位置变为可点击的“AI 推理已完成 / 查看AI推理”，打开独立复核层；“确认应用到初始化配置”只回填当前面板，不得提前创建故事点；标题或 TB 身份变化会使迟到结果失效；
  - 本机与远程 Flavor 使用可搜索、可自由输入的下拉框；主工程和已选关联工程按选择顺序置顶，未选工程保持服务端原顺序；
  - Flavor 只属于构建配置，不再参与 worktree 目录或 `story/` 分支命名；切换 Flavor 必须原位保留 worktree 和未提交文件，只有主工程或 TB 单号改变才进入破坏性重建确认；
  - 本地工程确认后只原子创建故事点记录并持久化初始化计划，返回 `202` 让 UI 立即进入故事点页面；worktree 与设备绑定在后台顺序执行，进度通过 WebSocket 和 `/tabs` 状态展示；重启恢复、进程内去重、失败持久化和显式重试必须可用；
  - 远程源码初始化同样立即进入故事点并显示克隆/工作区阶段、进度、失败原因和重试；A→B 配置切换必须使用新的持久化 operation/generation，旧 A 的进度、错误、结果和 worktree 都不得覆盖 B；
  - 后台初始化处于 `queued/preparing/error` 时，对话、构建和开发工作流必须在副作用前关闭；只有 worktree 成功且设备绑定完成后才能发布 `ready`；
  - 编辑态中央面板提供独立“工作流与归档”步骤，支持简短/专家报告模式以及默认/自定义存档目录、目录选择、复制和打开；这些字段只属于当前故事点，不得进入工程配置快照、复制配置或故事点组共享；
  - 编辑态关联工程行复用 Android Studio 多版本打开能力，版本菜单必须浮在中央面板之上且不被滚动容器裁剪；
  - 编辑态主工程也必须提供 Android Studio 打开入口；切换 TB 项目时必须废弃旧项目的车型源码配置和迟到推理结果，禁止把 A 项目的目标图带到 B；
  - AI 回答中的历史/实时工具命令统一聚合为卡片内一个默认收起的“命令 + 数量”短标签区域；摘要不得显示命令正文，展开后按执行顺序展示全部完整命令，单条命令不得再各自创建 `details`；“实时命令输出 显示最近输出，完整内容以脚本日志为准”继续使用另一独立、默认收起的 `details`，互不联动且长内容不撑宽聊天框。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs`
  - `web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`
  - `gateway/test/story-initialization.test.mjs`
  - `gateway/test/android-studio.test.mjs`
  - `gateway/test/story-storage-routes.test.mjs`
  - `gateway/test/devbench-config-apply.integration.test.mjs`
  - `gateway/test/source-initialization-recovery.integration.test.mjs`
  - `gateway/test/remote-source-initialization-generation.test.mjs`
  - `gateway/test/agent-tool-command-display.test.mjs`
  - `gateway/test/worktree-routes.integration.test.mjs`
  - `gateway/test/worktree-rebuild.test.mjs`
  - `web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs`
  - `web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`
  - `web-dashboard` 完整测试与生产构建。
- 修复版本：2026-08-02 工作区修复，尚未提交版本号。
- 验收范围：前端全量测试与 674 模块生产构建；相关 Gateway 150 项、真实 HTTP worktree 3 项、worktree 管理 43 项和 Store 87 项回归；隔离 Gateway `/api/health` 与 Vite 页面均返回 HTTP 200。覆盖初始化状态/入口/工程排序/旧设置投影、聊天命令折叠、后台计划/设备时序/重试/副作用门禁、远程代次隔离和 Flavor 非破坏性更新；未向真实 TB 或真实远程仓库写入。
- 残余风险：后台初始化真实耗时仍取决于目标 Git 仓库、磁盘和杀毒软件；进程内 Promise 去重不跨 Gateway，共享 operation/generation CAS、worktree `wx` 租约和侧车预留负责阻止旧结果写回与目录/分支碰撞。浏览器原生 `details` 的展开状态不跨刷新持久化；实时输出仍是当前回合聚合尾部，尚未按命令 ID 拆分为一条命令对应一段输出。真实高延迟远程 Git/TB 与浏览器人工点击尚需目标部署环境复核。

## REG-20260802-DEVBENCH-007：聊天中的基础仓库路径绕过故事点 worktree 隔离

- 复现：在故事点聊天中粘贴已登记基础仓库的绝对路径或仓内文件路径。旧实现虽然把 AI 的 `cwd/addDirs` 指向故事点 worktree，也在提示词中声明基仓禁写，但用户正文、运行中实时注入、持久队列和编辑重发仍把该绝对路径原样交给本机 AI；没有关联 worktree 时页面只会在底层工具失败后间接报错。初版门禁还遗漏自然语言分隔符后的单级相对遍历，例如从 `WorktreeSpace/story-a` 发送“请读取 `..\story-b\secret.txt`”，空格、换行、引号或中文括号后的 `..` 均可能直接进入兄弟故事点 checkout。
- 根因：工作目录投影与用户正文是两条独立链路；发送边界没有基于 `worktree.entries` 的确定性仓库身份解析，也没有对缺失、歧义、失效和其它故事点 worktree 做统一 fail-closed。无 CLI resume 的历史重放还会再次注入原始基仓路径。相对遍历匹配器只接受消息开头或斜杠作为 `..` 左边界；设备协调等待和实时注入失败后的持久排队也可能复用 await 之前的旧映射判断。
- 行为合同：
  - 服务端以当前故事点 active `worktree.entries` 为权威映射；`basePath → path`、`baseRepositoryPath → worktreePath`，按最长源根匹配并保留仓内相对路径；Windows 路径大小写不敏感，兼容正反斜杠、空格、引号和 UNC；分支只用于校验和提示，禁止仅凭 `main/master/release` 或模糊工程名猜测仓库；
  - Windows 扩展命名空间、尾随点/空格、盘符根相对路径、UNC 同共享根、点段、未加引号的空格路径和已存在 junction 必须按规范化及物理路径复核；未知 UNC 或未登记盘符必须不访问该卷即关闭，驱动器相对路径、动态环境变量遍历和越出 worktree 的 `..` 必须关闭；
  - 用户可见 `displayContent/messageInput.text` 和存档保持原文；只在 provider 当前任务、实时注入和无续接历史重放中使用映射后的 worktree 路径，并记录结构化映射审计；基仓绝不能进入 `cwd/addDirs`；
  - 普通发送、首轮甄别、验收/报告触发、运行中注入、持久排队、设备排队、编辑重发和失效 CLI 自动重试必须共用同一解析器；队列真正出队时按最新 Tab 再解析，禁止保留旧绝对 worktree；单级 `..` 在空格、换行、引号、反引号和中英文成对标点后也必须按完整相对 token 复核；
  - 已登记基仓没有当前 active worktree、同一源根对应多个 worktree、登记路径丢失/越界、引用当前故事点 inactive worktree或其它进行中/已关闭故事点 worktree时，必须在任何 AI/注入/排队前返回 409；页面在聊天输入区上方持久显示 `role=alert` 醒目卡片，明确“AI 未执行”，列出路径、原因、候选项并提供“配置对应工程”入口；
  - 受管故事点必须恰好有一个 active 主 worktree；0 个或多个主 worktree、`queued/preparing/error/cleaned/cleanup_partial` 生命周期、共享/嵌套 checkout 即使消息只写“继续”也必须全局关闭。Store、agent `cwd` 和 `addDirs` 只能消费 active 条目，禁止回退到失效主工程或 Gateway cwd；
  - 历史消息在重放给无 CLI 续接的引擎前也必须重新映射；若当前已无法安全映射，则隐藏该条原始路径并注入隔离说明，不得把旧基仓路径重新交给 AI；
  - TB 描述/评论/备注、附件索引、材料、Git 评审上下文、RAG 和经验等 provider-only 外部材料也必须走同一解析器；无法安全映射时整段脱敏而不是原样注入。网络/磁盘等待后、实时注入前、设备 acquire 返回后以及注入失败转持久队列前必须重新读取 Tab 并再次解析；失效的设备请求必须取消，已存在的失效持久队首必须用 CAS 原子移除；worktree 清理、重建或远程配置换代后必须清空 CLI/远程 Agent 会话身份；
  - 两个 Gateway 并发初始化同一基仓时，目录和 `story/` 分支必须通过 `wx` 侧车原子预留，认领同时校验 tab、目标路径和 Git common-dir；同 tab 重启可复用，不同 tab 的配置复制不得认领或移动来源故事点 worktree，失败时不得删除无法证明归属的目录。
- 自动化守卫：
  - `gateway/test/story-repository-path-resolver.test.mjs`
  - `gateway/test/devbench-prompt-mode.test.mjs`
  - `gateway/test/devbench-conversation-routes.test.mjs`
  - `gateway/test/worktree-resource-isolation.integration.test.mjs`
  - `gateway/test/worktree-manager.test.mjs`
  - `gateway/test/worktree-routes.integration.test.mjs`
  - `gateway/test/agent-tool-command-display.test.mjs`
  - `gateway/test/store.test.mjs`
  - `gateway/test/devbench-config-apply.integration.test.mjs`
  - `web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`
  - `web-dashboard` 完整测试与生产构建。
- 修复版本：2026-08-02 工作区修复，尚未提交版本号。
- 验收范围：纯函数覆盖精确根、仓内文件、monorepo 最长根、Windows 大小写/斜杠/空格/引号、UNC/扩展路径/根相对路径/跨卷、前缀碰撞、单级与多级遍历、自然语言/成对标点边界、物理 junction、缺失、歧义、失效、多主和其它故事点；定向 resolver/prompt/conversation/store 合计 204 项通过，并覆盖 await 后复检、设备请求取消与失效队首 CAS 移除；相关 Gateway 150 项与真实 HTTP/Git worktree 集成证明缺失映射返回 409、任务未启动、队列为空、告警持久化且基础仓库哨兵内容/mtime 不变；双 Gateway 资源隔离和目录/分支原子预留回归通过。
- 残余风险：当前门禁确定性处理系统已登记基仓、故事点 worktree 及直接可解析的路径引用；同一已登记卷上的未知外部绝对路径和不含路径的自然语言操作仍不会被臆测为仓库。路径映射是发送边界和误操作保护，不等同于操作系统沙箱：本机 Claude/Gemini/Codex 执行器仍以高权限模式运行，启动后可以通过未出现在消息中的命令导航；后续仍需 Controller grant、ACL 或真正进程沙箱把所有基础仓库设为不可访问/只读根，才能形成完整进程级隔离。崩溃后从未重试、也未走清理的初始化可能留下安全但占名的侧车，后续会分配新秒级名称而不会覆盖其它 worktree。

## REG-20260802-DEVBENCH-008：AI 回答的实时命令输出出现中文乱码

- 复现：让 Codex app-server 或 CLI 输出包含中文的命令结果，并在一个中文字符的 UTF-8 多字节序列中间拆分 stdout `data` chunk；旧实现会在 Gateway 进入 JSONL 解析和 WebSocket 广播前产生 `�`，页面“实时命令输出”只能显示已经损坏的文本。
- 根因：两个进程输出入口都对每个 `Buffer` 独立执行 `String()`/`toString()`；Node 的 `data` chunk 不保证落在 UTF-8 字符边界，跨 chunk 的多字节字符会被不可逆地替换。
- 行为合同：
  - app-server 与 CLI fallback 的 stdout/stderr 必须在字节入口使用有状态 UTF-8 流式解码，并在进程关闭时刷新尾部；
  - JSONL 解析、WebSocket `tool_output` 和前端聊天框必须接收到原始完整中文，不得在 UI 使用猜测性乱码替换；
  - 任意合法 UTF-8 字节边界拆包都必须保持文本逐字一致且不产生 U+FFFD。
- 自动化守卫：
  - `gateway/test/utf8-stream-decoder.test.mjs`
  - `gateway/test/codex-app-server.test.mjs`
  - `gateway/test/codex-json-stream.test.mjs`
  - `gateway/test/agent-tool-command-display.test.mjs`
  - `web-dashboard` 完整测试与生产构建。
- 修复版本：2026-08-02 工作区修复，尚未提交版本号。
- 验收范围：UTF-8 解码器覆盖“实时命令输出：中文检查通过 ✅”全部可能字节拆分位置；app-server 集成用例在“中”字内部拆包并验证通知逐字一致；相关 Gateway 18 项、前端完整 295 项测试通过，生产构建完成 674 个模块；隔离 Gateway 托管生产构建的 Chrome 验收确认实时命令输出默认收起，展开后完整显示“中文命令输出：检查通过，路径 D:\workspace\示例工程”且不含 U+FFFD；全新独立代理复跑相同自动化并补做单字节拆包验证后给出 PASS。CLI 旧集成测试在进入编码断言前受现有 `TASK_RUNTIME_LEASE_UNAVAILABLE` 阻塞，未计为通过。
- 残余风险：本修复处理 UTF-8 数据被任意 chunk 拆分的确定性乱码；若外部命令本身按 GBK、OEM code page 或其它非 UTF-8 编码写出字节，仍需该命令显式声明编码或在其适配层转码，不能由聊天 UI 安全猜测。

## REG-20260802-DEVBENCH-009：聊天卡片逐条展示完整工具命令导致重复长条

- 复现：同一 AI 回答连续执行多条 PowerShell 或其它工具命令；旧页面会为每条命令生成一个独立的默认收起卡片，摘要直接显示完整命令并重复出现“展开”，三条相同长命令会占据三行甚至更多空间。
- 根因：历史回答与实时回答都逐项调用 `ToolCommandChip`，组件把单条命令正文直接放入各自的 `<summary>`，没有回答级的命令区域。
- 行为合同：
  - 同一历史或实时回答的全部工具命令必须聚合为卡片内一个命令区域；收起态只显示“命令”和数量，不显示命令正文；
  - 整个命令区域共用一个默认收起的原生 `details`；一次展开后按原执行顺序显示全部完整命令，单条命令不再拥有独立展开状态；
  - 历史与实时回答复用同一组件；实时命令输出继续作为另一块独立区域，不与命令清单联动。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`
  - `web-dashboard` 完整测试与生产构建。
- 修复版本：2026-08-02 工作区修复，尚未提交版本号。
- 验收范围：目标模型测试 41 项及前端完整 295 项通过，生产构建完成 674 个模块；隔离 Gateway 托管生产构建的 Chrome 验收向同一实时回答注入三条相同长 PowerShell 命令，确认页面只有一个命令区域，收起摘要为“命令 3 展开”且完整命令不可见，一次展开后按顺序显示三条逐字一致的完整命令；收起与展开截图均已人工检查；全新独立代理复核原始材料并复跑相同测试、构建及差异检查后给出 PASS。
- 残余风险：命令数量反映实际收到的工具事件，不会自动合并内容相同但确实重复执行的命令；展开状态不跨页面刷新持久化。

## REG-20260802-DEVBENCH-010：车型源码配置面板重复鉴权把已登录管理员误判为只读

- 复现：管理员已经在 DevBench 完成登录，父页面管理员专属配置入口可见；打开“车型源码配置”后，弹窗仍可能显示“仅管理员可编辑”，并隐藏导入、添加车型及映射编辑操作。
- 根因：DevBench 父页面已经通过 `useIsAdmin` 得到稳定管理员状态，但 `VehicleSourceModal` 没有接收该状态，弹窗每次挂载又独立发起一次异步鉴权；子请求暂时失败或尚未完成时会与父页面产生权限状态分叉，并按非管理员渲染。
- 行为合同：
  - 从 DevBench 打开车型源码配置面板时，必须把父页面已经确认的 `isAdmin` 显式传给弹窗；
  - 弹窗收到父页面状态时必须优先使用该状态，不能被自身重挂载时的异步校验降级；只有独立调用且父页面未传值时才回退到组件自己的 `useIsAdmin`；
  - 管理员不显示“仅管理员可编辑”，并显示导入配置及添加/编辑车型操作；未登录用户继续显示只读提示且不能看到管理员写操作。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/vehicleSourceAdminState.test.mjs`
  - `web-dashboard` 完整测试与生产构建。
- 修复版本：2026-08-02 工作区修复，尚未提交版本号。
- 验收范围：回归测试在修复前按预期失败、修复后通过；前端完整 296 项测试通过，生产构建完成 674 个模块；Gateway `/api/health` 返回 200，并用 Gateway 托管的生产构建 `http://127.0.0.1:3001/devbench` 通过真实 TB 管理员会话打开车型源码配置面板，确认父页面管理员菜单可见、弹窗无只读提示且存在“导入配置”和“添加车型”；注销后重开同一生产页面，确认显示“仅管理员可编辑”且管理员按钮隐藏。管理员及未登录截图均已人工检查。
- 残余风险：本轮覆盖本机 Gateway 与真实管理员登录态，但未覆盖局域网其它节点、管理员令牌恰在弹窗打开期间过期的瞬时交互；后端写接口仍会独立校验 Bearer token 并在过期时返回 403，不会因前端沿用父状态而放宽服务端权限。

## REG-20260802-DEVBENCH-010：工程配置缺少应用分组、多路径和独立 WebApp 绑定

- 复现：故事点初始化选择“本机主工程”时原生下拉无法显示工程当前 Git 分支，部分弹层场景表现为候选不可辨识；本机工程配置是扁平路径列表，无法从应用角度组织多个关联仓库，也无法为同一仓库登记多份 checkout；旧实现还把 `WebApp 路径` 挂在应用市场行上，AI 复核显示“随主工程”；车型源码配置只能手工恢复克隆父路径，无法一键取回本机默认值。
- 根因：初始化面板使用不支持富文本标签的原生 `select`；本机配置缺少“应用 → 仓库定义 → 本机工程 ID”关系层，schema v2、推理本机解析和复核 UI 又共同保留了 `webAppPath` 的一对一继承模型；远程配置 API 只返回当前克隆父路径，没有把统一默认路径暴露给弹窗。
- 行为合同：
  - 初始化主工程使用不被滚动容器裁剪的自定义下拉，每个候选同时显示工程名、路径和服务端实时返回的当前 Git 分支；路径失效的候选保持可见但不可选；
  - 工程配置以应用为第一层；应用名既可自由输入，也可搜索选择 TB 应用分类与仓库定义名称，精确命中仓库定义名称时自动建立关联；用户可添加多个应用，每个应用可关联多个 Git 仓库；
  - 每个关联仓库可登记多份本机路径；路径输入或选择后按该路径实时读取并展示当前 Git 分支，分支不得只挂在仓库或应用级；仓库与路径支持搜索、编辑、增删，未选择仓库或未保存路径不能落盘；
  - 本机工程 schema v4 在扁平 `projects` 之外保存 `applications`，关系层只保存应用名、仓库定义 ID 和本机工程 ID；绝对路径继续只保存在本机忽略配置中，不得进入团队共享包；v3 扁平配置按 Git 远程仓库身份迁移，同一远程的多份路径归入同一仓库；
  - 历史 `webAppPath` 读取时无损拆成确定 ID 的 WebApp 工程，下一次保存、备份和还原不再写回附属字段；重复 ID 必须确定性去重；
  - WebApp 与应用市场、SDK 等工程使用相同的本机选择和绑定流程，不得继承主工程路径或从本地快照中隐藏；已有“仓库+目标分支”人工绑定允许复用，多份同仓候选仍必须人工选择；
  - WebApp 仓库画像只在当前工单命中 WebApp、Web、H5、网页应用或前端证据时作为应用市场依赖追加；无相关证据不得仅凭历史样本带出 WebApp；
  - 车型源码配置 API 同时返回当前值与本机默认克隆父路径；“默认”按钮只回填统一计算结果，用户点击“保存”后才持久化，中心代理场景也必须使用浏览器所在 Gateway 的本机默认值。
- 自动化守卫：
  - `gateway/test/store.test.mjs`
  - `gateway/test/config-inference.test.mjs`
  - `web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs`
  - `web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`
  - `web-dashboard` 生产构建。
- 修复版本：2026-08-02 工作区修复，尚未提交版本号。
- 验收范围：Gateway Store 88/88、AI 推理 75/75、前端 296/296 全部通过，前端生产构建通过；隔离 Gateway 与真实浏览器验证了 2 个应用、3 个仓库、6 个本机工程路径及各自分支，WebApp 独立关联、初始化下拉分支标签、默认克隆父路径回填均符合合同；fresh 独立验收复跑 Gateway 163/163、前端 296/296，并核对 API 关系无重复路径、重复引用或悬空引用，结论 PASS。
- 残余风险：历史故事点已经持久化的 `worktree.entries` 仍保留 `webapp` 角色用于兼容既有工作区；本次迁移只改变后续本机工程配置和 AI 复核绑定，不主动重写或删除既有故事点目录。隔离环境未登录 Teambition，因此应用名候选中的 TB 应用分类未做在线数据验收，仓库定义名称联动已完成浏览器验证；修改文件存在 Git 的 LF→CRLF 提示，但 `git diff --check` 无错误。

## REG-20260802-DEVBENCH-011：管理员身份存在多份真相且跨页进入管理后台触发整页重载

- 复现：
  - 从设置或飞书同步页点击“管理后台”，浏览器发生一次新的文档导航，应用壳、路由模块和管理员身份请求全部重新初始化，进入 `/admin` 的体感明显慢于侧栏内的 SPA 跳转；
  - 同一管理员令牌在 App、管理后台、DevMode、车型源码配置及其它业务页分别请求 `/api/admin/auth/me`，网络超时、旧请求迟到、同窗口登录/退出或管理员名单变化时，各页面可能同时显示“管理员”“只读”和“校验中”等互相矛盾的状态；
  - Gateway 旧 `/api/admin/auth/tb-login` 使用机器共享的 Teambition Cookie 识别操作者，无法证明当前浏览器访问者就是该账号；管理员从名单移除后，旧令牌仍可沿用名单角色快照；复制数据中的非法 `super` 角色还可能提升为超级管理员。
- 根因：身份认证没有稳定 Principal、认证方式、令牌受众和授权版本合同；前端以局部 hook、时间戳角色缓存和父组件布尔属性拼接身份；后端把管理员成员表、机器服务账号与本机 break-glass 超管混为同一种角色来源；管理员变更也没有统一的实时失效事件。REG-010 用父属性压过子请求只能隐藏一次竞态，仍保留两份身份真相，因此由本条替代。
- 行为合同：
  - 前端只能由进程级管理员会话 store 请求 `/api/admin/auth/me`；同一 token/audience 并发校验必须 single-flight，迟到请求不得覆盖新 token，401 只能以 compare-and-clear 清理发起请求时的 token；网络或超时降级时可保留上次 Principal 用于说明，但所有写 capability 必须立即失败关闭；
  - 登录令牌必须绑定 Gateway origin；登录、退出、跨标签 storage、窗口恢复及服务端 `admin_authz_invalidated` 事件必须汇入同一状态机，车型源码配置只消费明确的 `vehicle-config:*` capability，不得再接收父组件 `isAdmin` 覆盖；
  - `admin_users` 只表达 `admin` 成员关系，数据库与节点复制均不得产生 `super`；`super` 只能由本机 TOTP 产生且不得跨 M2M 转发；管理员令牌必须绑定稳定 subject、已验证 authMethod 和当前成员 revision，移除、重加或有效复制变更后旧令牌立即失效；
  - TOTP setup 只在未绑定且原始访问者为 loopback 时返回密钥；本机反向代理只能在直连 peer 为 loopback 时采用 `X-Forwarded-For` 的最后一跳，禁止由客户端前置伪造 loopback；已绑定密钥不得经 HTTP 重现，reset 必须同时满足本机访问和当前 `super` 会话，错误登录按原始访问者限流；
  - 机器共享 TB Cookie 不得签发浏览器管理员身份；在浏览器绑定的一次性 TB challenge 完成前，生产 `/auth/tb-login` 与可伪造 body 身份的 `/auth/ding-login` 必须返回 410，钉钉只接受服务端 OAuth 换取的身份；
  - 站内 `/admin` 入口必须使用 React Router 导航；应用壳不能被懒加载管理模块的全局 Suspense 替换，管理模块应在空闲、悬停或聚焦时预加载；管理页首屏用 `/api/admin/overview` 聚合固定上限的管理员、引导态与审计数据，不得固定轮询；
  - 所有会改变主机、设备、任务、Skill、备份或 TB 服务状态的页面请求必须由后端统一 `requireAdmin`，前端统一使用 audience-bound `authenticatedFetch`；GET/HEAD 只读语义不得被身份收敛意外改变；
  - 跨节点业务转发只能携带独立 M2M 凭据和经验证的委托 Principal，不得透传浏览器 Bearer；本机 `super` 不得委托。普通管理员委托必须绑定钉钉 subject、中心当前成员 revision、请求方法/路径/body 摘要、30 秒有效期和一次性 nonce，任一不匹配、重放或成员移除都必须失败关闭。
- 自动化守卫：
  - `gateway/test/admin-auth.test.mjs`
  - `gateway/test/admin-auth-routes.integration.test.mjs`
  - `gateway/test/admin-principal-delegation.test.mjs`
  - `gateway/test/admin-write-route-guards.test.mjs`
  - `gateway/test/security-boundaries.integration.test.mjs`
  - `gateway/test/center-forward-pollution.integration.test.mjs`
  - `web-dashboard/src/services/adminAuth.test.mjs`
  - `web-dashboard/src/services/adminAuthArchitecture.test.mjs`
  - `web-dashboard/src/pages/writeAuthTransport.test.mjs`
  - `web-dashboard/src/pages/devbench/vehicleSourceAdminState.test.mjs`
  - `web-dashboard` 完整测试、生产构建与隔离 Gateway 托管构建的 Chrome 导航/身份验收。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 验收范围：Gateway 管理认证、路由、委托、写保护、安全边界、中心转发、配置、复制与审计定向矩阵 58/58 通过；Web 管理架构/传输 pretest 14/14 与默认主测试 299/299 通过，生产构建完成 675 个模块。隔离 `NODE_ENV=production` standalone Gateway 托管生产构建的 Chrome 验收从 `/help` 点击 `/admin`，在 `/auth/me` 人为延迟 2200ms 时管理壳 211ms 可见，navigation entry 保持 1 且页面标记不丢失；TOTP reset 后无刷新清除 token、显示登录门，旧 token 返回 401。全新独立代理从原始交接包重新运行同一矩阵、构建与浏览器脚本，得到 Gateway 58/58、Web 14/14 + 299/299、675 模块构建和管理壳 181ms，并独立判定 PASS；登录态与撤权态截图均已人工检查。
- 残余风险：Gateway 全量 `npm test` 曾运行 904 秒后仍在性能资源集成用例，未取得完整全量汇总，不能表述为全量 PASS；浏览器性能数字来自 Windows headless Chrome 单轮隔离运行，尚无多轮 P50/P95。浏览器绑定的一次性 Teambition 登录 challenge 尚未实现；当前安全行为是停用会把机器共享身份误当成人员身份的旧入口，管理员可使用本机 TOTP 或服务端验证的钉钉 OAuth。真实钉钉扫码、局域网多节点撤权传播、逐页面写按钮人工端到端和目标部署网络延迟仍需在对应环境复核。

## REG-20260803-SETTINGS-012：Teambition 一键登录提取卡死且过期 Cookie 状态不明确

- 复现：设置页保存过期 Cookie 后点击“验证 Cookie”，旧实现只显示上游原始错误；点击“一键登录提取”时，本机浏览器一旦读到部分或过期 Cookie 就提前结束轮询，账号验证失败后又不广播失败状态。前端只监听可能丢失的 WebSocket，且本地模式启动成功后没有进入等待态，页面会长期停在“等待登录中”。取消/替换远程登录后立即重试时，旧异步任务还会把新会话改为失败并关闭新浏览器。未登录管理员直接点击时也只得到接口失败，没有先引导管理员登录。
- 根因：本地与远程浏览器分别维护不完整的登录状态机，Cookie 存在被误当成 Cookie 有效；异步轮询、状态更新和浏览器清理都引用可被替换的全局会话，没有绑定启动时的会话代际。`/login/status` 只返回远程会话，前端 WebSocket effect 又受父组件内联回调影响反复重连。Cookie 检查没有区分缺失、过期、无效和服务不可用；配置读取还会把 `teambition.userCookie` 与 `appSecret` 明文返回浏览器。
- 行为合同：
  - 本地与远程登录必须共用“工作台跳转 → 提取候选 Cookie → `/api/users/me` 验证 → 成功后落库”的流程；部分、旧或未生效 Cookie 继续等待并自动重试，不得提前保存；关闭、取消、超时和启动失败都必须进入可查询且可广播的终态；快速重试时旧会话不得更新或关闭新会话。
  - 设置页以 WebSocket 提供即时反馈，并在启动、等待、验证阶段轮询 `/api/tb-tasks/login/status` 兜底；本地和远程启动都立即显示等待态，成功后自动复查 Cookie、刷新用户和项目配置；未登录管理员先打开统一管理员登录入口。
  - Cookie 健康状态必须稳定区分 `valid`、`missing`、`expired`、`invalid`、`unavailable`；登录与非登录重定向、登录/维护/普通 HTML 必须分别归类，网络或上游故障不得清空本地 Cookie、回传候选 Cookie 或误报为账号过期。
  - 配置接口不得向浏览器返回 Teambition Cookie/App Secret 明文；掩码回传不得覆盖真实凭据，Teambition 凭据写入必须要求管理员。手工录入收进高级区，已保存值不回显；候选值必须验证成功后再原子替换，验证失败保留旧值。
- 自动化守卫：
  - `gateway/test/tb-cookie-login.test.mjs`
  - `gateway/test/tb-remote-browser.test.mjs`
  - `gateway/test/config-admin.integration.test.mjs`
  - `gateway/test/teambition.test.mjs`
  - `web-dashboard/src/pages/settings/tbCookieLoginModel.test.mjs`
  - `web-dashboard/src/pages/writeAuthTransport.test.mjs`
- 修复版本：2026-08-03，本条所在提交。
- 自验收范围：Gateway Cookie/远程浏览器/配置鉴权/写保护/Teambition 关联矩阵 82/82 通过，其中包含 Cookie 响应边界、手工候选原子保存、本机/远程取消后立即重启的会话代际隔离；Web 管理认证 pretest 14/14、默认主测试 303/303 通过，生产构建完成 676 个模块。隔离 production Gateway 使用伪造过期 Cookie 验证配置脱敏、匿名写拒绝，并由 Chrome 完成“管理员门禁 → 已过期 → 手工录入不回显 → 一键登录提取 → 等待/轮询 → 取消”流程；`00-admin-required.png`、`01-cookie-health.png`、`01b-manual-cookie.png`、`02-login-waiting.png`、`03-login-cancelled.png` 已人工检查，取消后状态接口返回 `cancelled/CANCELLED/busy=false`。
- 独立验收：全新代理复跑相同自动化与构建，另完成 Cookie 探测 27 个边界场景和手工保存 3 个场景的隔离复现；代码/自动化与隔离浏览器均为 PASS，未发现确定性缺陷。
- 残余风险：验收机原 3100/3101 服务未启动，未读取或改写真实用户配置；没有可供扫码的真实 Teambition 账号，因此未完成“真实账号扫码/密码登录 → 新 Cookie 落库 → 附件下载”的线上成功链，当前总体验收为 PARTIAL。隔离浏览器已实际打开 Teambition 登录页并验证启动/取消状态，成功落库链由可执行的账号验证、原子保存和 Cookie 响应边界回归测试覆盖。

## REG-20260803-DEVBENCH-013：输入区运行状态泄漏完整工具命令并挤压核心元数据

- 复现：故事点 AI 执行长 PowerShell 命令时，输入框上方状态条在“运行中”后直接显示 `live.tools` 的最后一条完整命令；命令会占据多行，并同时进入悬浮标题，把 AI、模型、档位、开始时间、已运行时长、Token 用量和停止按钮挤散。
- 根因：输入区状态条把“当前工具命令”误当成任务状态的一部分，直接读取 `live.tools[live.tools.length - 1]`；状态展示又只有“运行中/空闲”两个分支，没有区分请求尚未出流、流已结束但回答仍在保存、用户停止等过渡状态。
- 行为合同：
  - 输入区状态条不得读取或展示工具名、命令参数、命令输出，也不得把这些内容放进 `title`；完整命令继续只存在于回答卡片可展开的统一命令区域和实时命令输出区域；
  - 运行态按“运行中 AI 名称 · 模型 · 档位 · 开始/已运行 · 输入/输出/缓存/总消耗”的稳定顺序显示，Token 与时间沿用统一格式化逻辑，停止按钮保持独立可操作；
  - 乐观发送尚未收到流时显示“启动中/正在等待 AI 响应”，流结束等待最终消息时显示“收尾中/正在保存回答”，用户停止时显示“已停止/停止前回答已保留”，无任务时显示“空闲/等待输入”；
  - 状态颜色和脉冲只表达活动程度，状态条允许自然换行，长元数据不得重新引入命令截断或命令悬浮提示。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/storyRunStatusModel.test.mjs`
  - `web-dashboard` 完整测试与生产构建。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 验收范围：目标状态模型与源码边界测试 3/3 通过；前端管理认证 pretest 14/14、默认主测试 306/306 通过，生产构建完成 677 个模块，`git diff --check` 通过。隔离 production Gateway 托管当前生产构建，Chrome 通过 Mock WebSocket 和 Mock send/stop 依次验证空闲、启动、运行、收尾、停止及最终恢复空闲；运行态逐项命中 `gpt-5.6-sol/xhigh`、开始/已运行和五项 Token 数据，状态正文与 `title` 均不含注入的长 PowerShell 命令。1360px 与 760px 两种视口均无水平溢出，停止按钮可见、无遮挡且确认后进入停止态；六张截图已人工检查。
- 独立验收：全新上下文代理 `/root/run_status_acceptance` 未读取开发 Agent 的自验结论，独立复跑聚焦测试 3/3、pretest 14/14、主测试 306/306、677 模块生产构建及 `git diff --check`，并重新执行 3304 浏览器 DOM 流程、逐张检查六张截图；确认输入区正文/title 不含长命令、宽窄屏无溢出、停止按钮无遮挡、回答卡片命令折叠区仍保留，结论 `PASS`。
- 残余风险：浏览器验收为隔离 UI app-mock，没有发起真实 AI 任务或验证真实供应商用量上报；运行数据通过页面实际 WebSocket reducer 注入，适合验证本次展示合同，但生产环境仍需在下一次真实长任务中观察一次。浏览器覆盖 Chrome 的 1360px 和 760px 视口，未单独覆盖 Firefox/Safari。

## REG-20260803-ADMIN-013：管理员修复误删验证器重绑定入口并把普通 TB 登录误作管理员能力

- 复现：网关本机在验证器已绑定后打开 `/admin`，“首次使用 / 重新绑定验证器”不再返回已有密钥与二维码；`/settings` 的 Teambition 用户登录显示“管理员登录后提取”，普通 TB 用户未经管理员登录无法发起扫码。历史 TB 管理员 ID 还被统一标为钉钉 subject，与真实身份来源不符。
- 根因：身份收敛修复把“普通 TB 用户扫码获取本人登录态”和“已授权 TB 管理员登录管理后台”合并成同一个管理员写权限；为防止机器共享 Cookie 冒充当前浏览器操作者，又整体停用了 TB 管理员入口。TOTP 密钥响应条件从“本机可查看”改成“仅本机且未绑定可查看”，密钥文件未删除，但重绑定 UI 无法再取得 key。
- 三种身份合同：
  - **超级管理员**：只能由网关本机 TOTP 签发，拥有管理员名单管理和验证器 reset 能力，不得复制或跨节点委托；已绑定密钥可在网关 loopback 重新显示以绑定新验证器，远程访问始终不返回 secret/otpauth。
  - **管理员**：是超级管理员从 TB 组织成员中显式加入的普通管理员；用一次性、浏览器持有、扫码成功后才完成的 TB challenge 签发 `admin` Principal，永远不能因 TB 登录提升为 `super`。
  - **普通 TB 用户**：无需任何管理员会话即可在设置页发起“一键登录”并扫码，只建立 TB 用户登录态，不获得管理能力；手工 Cookie 覆盖和业务写操作仍需要管理员。
- 稳定主体合同：`admin_users` 持久化 `subject_issuer` 并区分 `teambition`/`dingtalk`；历史 24 位小写十六进制 TB ObjectId 迁移为 `teambition`。管理员令牌校验和 M2M 委托同时绑定 issuer、成员 revision 和请求摘要，撤权后旧令牌立即失效。
- 自动化守卫：
  - `gateway/test/admin-auth.test.mjs`
  - `gateway/test/admin-subject-migration.test.mjs`
  - `gateway/test/admin-auth-routes.integration.test.mjs`
  - `gateway/test/admin-principal-delegation.test.mjs`
  - `gateway/test/admin-write-route-guards.test.mjs`
  - `gateway/test/tb-login-challenge.test.mjs`
  - `gateway/test/tb-remote-browser.test.mjs`
  - `web-dashboard/src/services/gateway.test.mjs`
  - `web-dashboard/src/services/adminAuthArchitecture.test.mjs`
  - `web-dashboard/src/pages/writeAuthTransport.test.mjs`
  - `web-dashboard` 完整测试、生产构建与隔离 production Gateway 浏览器验收。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 自验收范围：Gateway 三身份/历史 subject 迁移/路由/委托/远程登录定向矩阵 47/47 通过，扩展 Cookie/配置/安全边界矩阵 84/84 通过；Web 管理身份 pretest 14/14、完整测试 305/305 通过，生产构建完成 676 个模块。隔离 `NODE_ENV=production` Gateway 与 Chrome 确认已 enrolled 的 TOTP 密钥/二维码在 loopback 恢复、远端隐藏，未持有管理员 token 的设置页可直接进入普通 TB 用户扫码等待态，管理后台 TB 入口明确提示需超管授权；三张截图已人工检查。用户指定的实时 `127.0.0.1:3000/admin` 与 `/settings` 还完成了不读密钥、不发起真实 TB 登录的只读 DOM 冒烟。
- 独立验收：全新代理重新检查差异、三张截图和原始 JSON/日志，复跑 Gateway 47/47、Web pretest 14/14、主测试 305/305、676 模块构建、隔离 production 浏览器与 live UI 只读冒烟，未发现确定性 P0/P1/P2 权限缺陷；因 live 3001 仍是未重启的旧进程且真实 TB 扫码未执行，最终 verdict 为 `PARTIAL`。
- 残余风险：隔离验收未使用真实 Teambition 账号完成扫码成功链，浏览器的等待态用拦截响应验证；真实 TB 身份落库、普通用户不获管理权、名单成员只获 `admin` 由服务层与路由集成测试覆盖，部署后仍建议用一个名单内和一个名单外 TB 账号各走一次真实扫码。表结构仍使用历史 `ding_userid` 作单列主键，如果两个 provider 出现完全相同的原始 ID 会冲突，当前用 issuer 防止身份误判但未做复合主键迁移。

## REG-20260803-SETTINGS-014：普通 TB 用户拉取可选项目引用越界且验证器入口误报重绑定

- 复现：普通 TB 用户已在设置页登录，点击“当前账号操作的 TB 项目”中的“拉取可选项目”立即显示 `authHeaders is not defined（需 TB 登录）`；同时 `/admin` 在真实 key 文件仍存在且接口返回 `enrolled=true` 时，折叠入口仍固定显示“首次使用 / 重新绑定验证器”，让用户误以为 key 已丢失或查看动作会重置 key。
- 根因：`authHeaders` 定义在 `Settings` 组件函数作用域内，模块级 `TbProjectList` 却直接引用它，浏览器在发起请求前就抛出 `ReferenceError`；即使去掉该引用，DevBench 生产总门禁仍要求管理员 Principal，错误地阻止普通 TB 用户访问本人项目接口。验证器入口没有消费 enrolled 状态，只使用固定的历史操作文案，展示层与真实 key 状态不一致。
- 行为合同：
  - 普通 TB 用户必须同时具备已验证的 `userCookie` 和 `operatorId`，只允许访问 `GET /tb-projects`、`GET/PUT /tb-projects/selection`、`GET /tb-projects/available`；其它 DevBench 接口继续要求管理员或 M2M Principal。
  - “当前账号”始终指当前 TB operatorId；即使浏览器同时存在 `super` 或 `admin` 会话，项目偏好也必须使用 `tb:<operatorId>` 隔离键，不能改用管理员 subject。项目接口始终在持有当前 TB Cookie 的本机 Gateway 执行，不转发到中心节点。
  - 非空项目选择必须重新对照当前 TB Cookie 可见项目并采用上游规范名称；不可见项目返回 `TB_PROJECT_NOT_VISIBLE`。空选择可直接清空本人偏好，不调用上游。
  - `TbProjectList` 不得依赖 Settings 组件内部管理员头函数；拉取可选项目只使用普通同源 GET。
  - 已 enrolled 的验证器必须显示为“查看验证器绑定信息”和“继续绑定使用现有密钥”；查看不会写 key。只有超级管理员明确点击“重新生成密钥”并二次确认时才调用 reset，使旧验证码失效。
- 自动化守卫：
  - `gateway/test/devbench-tb-user-access-policy.test.mjs`
  - `gateway/test/devbench-tb-project-access.integration.test.mjs`
  - `web-dashboard/src/pages/writeAuthTransport.test.mjs`
  - `web-dashboard/src/services/adminAuthArchitecture.test.mjs`
  - 管理认证/三身份关联矩阵、Web 完整测试、生产构建与隔离 production Gateway 浏览器验收。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 自验收范围：新建 Gateway 回归 5/5、Web 目标回归 9/9 通过；管理认证、管理员路由、委托、写保护、TB challenge、远程浏览器与配置关联矩阵 63/63 通过；Web pretest 15/15、完整测试 305/305 通过，生产构建完成 676 个模块。隔离 `NODE_ENV=production` Gateway + Chrome 实际点击后，已 enrolled 页面显示现有 key 说明与二维码，普通 TB 设置页点击“拉取可选项目”显示两个模拟可见项目且无 `authHeaders` 页面异常；两张截图已人工检查。真实 `gateway/.secrets/admin-totp.json` 仅做元数据/哈希只读核验，文件存在且全部测试前后哈希一致，最后修改时间仍为 2026-06-17；真实本机 setup 接口返回 `enrolled=true`。
- 独立验收：全新代理只依据交接包与原始材料，复跑 Gateway 64/64、Web pretest 15/15、主套件 305/305、676 模块生产构建和随机端口隔离浏览器 3/3，另用隔离 TOTP 文件确认查看绑定信息前后 size/SHA-256 不变；源码与隔离 production 范围 verdict 为 `PASS`。代理未修改产品源码、未操作索引、未重启真实 3001。
- 残余风险：隔离浏览器为避免使用真实账号而拦截了“可选项目”上游响应，未完成真实 TB Cookie 到 Teambition 项目列表的线上成功链。当前 3001 Gateway 是 Service Control 托管的旧非 watch 进程，实时匿名项目选择仍返回 HTTP 401；源码与隔离 production 验收已修复，但必须在确认不会打断任务后由 Service Control 重启 Gateway 才会在 3000/3001 生效。本轮检查时活动任务和运行租约均为空，但未擅自执行重启。

## REG-20260803-DEVBENCH-014：应用工程配置重开闪加载且车型源码配置入口割裂

- 复现：在“工程开发”打开“工程配置 → 应用工程配置”，等待本机应用、仓库、路径和分支显示后关闭，再次打开时仍回到“正在读取应用工程配置…”；车型源码配置又从顶部“配置”菜单打开第二个独立弹窗，无法在应用工程与仓库定义的同一上下文中切换。车型存在未发布编辑时，合并弹窗的统一关闭入口还必须保留原有防丢确认。
- 根因：`ProjectConfigModal` 只缓存了单条 Git 信息和仓库定义，应用布局 `rows/applications/applicationOptions` 每次挂载都从空状态开始并强制显示加载态；`index.jsx` 同时维护 `showConfig`、`showVehicle` 两套可见状态，`VehicleSourceModal` 自带完整遮罩、标题和页脚，不能作为工程配置内容区复用。
- 行为合同：
  - 应用工程配置按 TB 项目保存最后一次已确认或服务端返回的有效快照；重开时先从模块内存/localStorage 同步恢复，包括合法的空布局，不得再次闪全量加载态；随后后台请求服务端真值并原位校准，损坏或不可用缓存必须安全回退到接口加载。首次加载时，单独先返回的应用候选不得把未知布局伪造成有效空快照；必须等 `rows/applications` 都就绪后才创建首份快照。
  - 保存应用分组或本机路径后只缓存服务端规范化结果；项目路径/分支刷新、导入、清空与删除后的服务端重载必须同步更新缓存，不能把未落库的临时路径伪装成已保存配置。
  - “工程配置”固定包含“应用工程配置 / 仓库定义 / 车型源码配置”三个 Tab；工程开发页不再维护第二个车型源码弹窗。原“车型源码配置”快捷入口保留，但必须直达同一个工程配置弹窗的第三个 Tab。
  - 车型 Tab 切换后保持挂载，避免 Tab 往返丢失本地编辑；仓库定义和应用候选从父面板实时传入。关闭统一弹窗时，如车型存在未发布改动，必须确认后才能退出。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/projectConfigCache.test.mjs`
  - `web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`
  - `web-dashboard/src/pages/devbench/vehicleSourceAdminState.test.mjs`
  - `web-dashboard` 完整测试、生产构建与隔离 production build 浏览器验收。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 自验收范围：缓存/入口/车型权限定向矩阵 51/51 通过，含“应用候选先返回不创建假空快照”竞态回归；Web 管理认证 pretest 15/15、默认主测试 313/313 通过，Vite 生产构建完成 678 个模块。隔离 Vite production preview + Headless Edge 在 1440×1000 下确认工程配置三 Tab 居中展示；应用配置首次加载后关闭，在第二轮接口人为延迟 1500ms 时重开 97ms 已显示缓存内容、没有“正在读取”状态，后台响应后内容保持；车型快捷入口直达合并后的第三个 Tab。未发布车型草稿首次关闭弹出确认且取消后弹窗保留；浏览器 `pageErrors=[]`、`consoleErrors=[]`，四张截图已人工检查。
- 独立验收：全新 Agent `/root/project_config_tabs_acceptance_race_final` 只依据交接包、原始证据和当前代码，未读开发 Agent 自验结论；独立复跑聚焦 51/51、Web pretest 15/15、主测试 313/313、678 模块生产构建与随机端口 Headless Edge 均通过。独立浏览器重开 107ms 内显示缓存、无加载态，后台刷新后内容仍在，三 Tab、车型快捷入口和未发布保护通过，页面/控制台无错误；自启的 preview 已停止。隔离 production Web/app-mock 范围总体结论为 `PASS`。
- 残余风险：浏览器验收通过请求拦截使用隔离应用/车型数据，没有读写真实 Gateway 配置、真实 TB 应用分类或局域网共享发布；生产环境部署后仍建议用一个真实 TB 项目执行“首次打开 → 关闭 → 断网/高延迟重开 → 服务端更新后后台校准”，并在另一节点修改车型映射后检查 WebSocket 刷新与本地未发布草稿保护。当前命令环境为 Node 22.11.0，未在仓库声明的 Node 24.14.1 Gateway 目标环境复跑；本次改动仅涉及 Web 前端，但完整发布流水线仍应在目标 Node 版本复验。

## REG-20260803-DEVBENCH-015：普通 TB 用户已登录仍被故事点工作台总守卫误判为未认证

- 复现：普通用户通过 Teambition 一键登录取得有效 `userCookie` 与 `operatorId` 后打开故事点工作台，页面首个 `GET /api/devbench/tabs` 请求仍返回 `DEVBENCH_AUTH_REQUIRED`；即使直接提交 `POST /api/devbench/tb-task/resolve`，也会在读取目标 TB 单前被相同总守卫拒绝。新建故事点面板默认停在空白故事点，TB 入口位于第四个 Tab。
- 根因：身份收敛时只给普通 TB 主体放行了四个项目选择接口，没有把它作为 DevBench 的“已认证、非管理员”主体；同时 TB 单解析会在 Cookie 查询失败后继续使用开放平台应用身份，无法证明普通用户本人有权读取目标工单。面板的 Tab 顺序和默认值仍采用历史空白故事点优先约定。
- 行为合同（本条取代 `REG-20260803-SETTINGS-014` 中“其它 DevBench 接口继续要求管理员或 M2M Principal”的旧限制）：
  - 同时具有非空 `teambition.operatorId` 与已验证 `teambition.userCookie` 的普通 TB 登录态，是 DevBench 可接受的低权限已认证身份；管理员/M2M 主体优先且普通身份不获得任何管理员 capability。
  - 普通 TB 用户按 CARB 单号或任务链接解析、导入、绑定、创建故事点，或切换远程拉取模式自动关联工单时，必须先仅使用当前用户 Cookie 精确读取目标工单；不得使用本地任务缓存绕过校验，也不得回退开放平台应用令牌。Cookie 401 引导重新登录，403/404 或搜索结果不精确命中时失败关闭，校验失败不得先写入故事点模式或远程拉取配置。
  - 故事点初始化必须在服务端再次执行相同的目标工单可见性校验，不能只信任前端此前的解析结果；创建 intent 继续绑定当前稳定主体。
  - 新建故事点面板的首个及默认 Tab 均为“从 TB 单新建”，空白、git commit、批量 commit 与历史入口继续保留。
- 自动化守卫：
  - `gateway/test/devbench-tb-user-access-policy.test.mjs`
  - `gateway/test/devbench-tb-project-access.integration.test.mjs`
  - `gateway/test/devbench-tb-ticket-access.integration.test.mjs`
  - `gateway/test/teambition-user-ticket-access.test.mjs`
  - `web-dashboard/src/pages/devbench/newStoryPanelModel.test.mjs`
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 自验收范围：Gateway 新增/相关 5 个测试文件 19/19 通过，其中覆盖远程拉取模式下“缓存已有但本人不可见”失败关闭且不落盘，以及本人可见时正常自动绑定；故事点 AI 复核与初始化集成 14/14 通过；Web 管理认证 pretest 15/15、完整测试 310/310 通过，生产构建完成 678 个模块，`git diff --check` 通过。隔离 `vite preview` 托管该生产构建并用 app-mock 提供空 DevBench 数据，Chrome 1360×900 实际点击“＋ 新故事点”后确认首个 Tab 为“从 TB 单新建”、默认选中且 TB 输入面板可见；截图和机器结果保存在临时验收目录，未暂存/提交。
- 独立验收：全新上下文 Agent 只依据原始差异、测试和临时证据复核，先发现并推动修复“远程拉取自动绑定使用本地任务缓存绕过 Cookie 校验”的旁路；最新工作区复跑 Gateway 相关与故事点初始化矩阵 33/33、Web pretest 15/15、完整测试 310/310、678 模块生产构建、路由语法和差异检查均通过，并人工核对 TB 首个/默认 Tab 截图。源码、隔离测试与 app-mock 浏览器范围为 `PASS`；因无真实普通 TB 账号及线上可见/不可见工单，整体 verdict 为 `PARTIAL`。独立 Agent 未修改产品文件、未暂存/提交、未重启真实服务。
- 残余风险：自动化测试使用隔离配置和模拟 Teambition 响应，未验证真实 TB 搜索响应、Cookie 域策略以及线上 401/403/404；当前 TB 登录凭据仍是 Gateway 配置范围而非浏览器会话范围，在共享 Gateway 场景中需要额外评估操作者与机器当前 TB 身份的一致性。部署中的旧 Gateway 进程需要安全重启后才会加载修复；生产构建仍有既有的大 chunk 警告。

## REG-20260803-DEVBENCH-016：大附件拖入聊天输入框后永久停在上传态

- 复现：管理员已登录故事点工作台后，从文件夹拖入约 34MiB 文件到聊天输入框；附件二进制请求没有沿用 DevBench JSON 写请求的登录传输契约。若请求被鉴权拒绝、代理连接半开或网络请求始终不返回，`StoryTab` 会一直等待 `uploadFile()`，输入框持续显示“正在上传附件…”。隔离复现确认旧实现不会携带 `Authorization`，且模拟永不结算的 `fetch` 时调用没有任何终态。
- 根因：`REG-20260803-DEVBENCH-011` 收敛 DevBench 总鉴权后，`api.js` 中 JSON 写请求会附带 audience-bound 登录凭证，但附件、二签 APK 和汇总模板三个二进制 POST 仍直接调用裸 `fetch`；附件请求也没有超时/中止边界。Gateway 隔离实测可在约 0.3 秒内完整接收并落盘 34MiB，请求体上限不是本次卡死根因。
- 行为合同：
  - 所有 DevBench 二进制写请求必须复用 `authenticatedFetch`，只向当前可信 Gateway audience 附带登录凭证；不得为附件接口另造不受 audience 约束的 token 头。
  - 故事点附件上传最长等待 120 秒；超时必须中止底层请求并返回 `ATTACHMENT_UPLOAD_TIMEOUT` 可重试终态，让 `StoryTab` 的既有 `finally` 收起“正在上传附件…”；网络错误和非 2xx HTTP 响应不得包装成成功。
  - Gateway 必须完整接收并落盘 30MiB 以上附件，响应 `size` 与磁盘大小一致；回归用例使用隔离故事点与系统临时目录，不得写入真实故事点或源码工程。
  - 同类二进制入口统一走共享写请求封装；后续鉴权或超时策略变更必须在该边界统一修改，不能继续新增裸二进制 `fetch`。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/storyAttachmentUpload.test.mjs`
  - `gateway/test/story-storage-routes.test.mjs`
  - `web-dashboard/src/pages/writeAuthTransport.test.mjs`
  - `web-dashboard` 完整测试与生产构建。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 自验收范围：Gateway 存储/鉴权相关矩阵 38/38 通过（其中存储路由 12/12，真实 34MiB 请求与落盘均为 35,651,584 字节）；Web 管理认证 pretest 15/15、完整测试 318/318 通过，生产构建完成 679 个模块，`git diff --check` 通过。隔离浏览器通过随机端口加载当前生产构建，实际拖入 34MiB 文件后捕获到带鉴权的二进制请求，上传中提示出现、完成后提示消失并展示 34 MB 附件卡片；页面、控制台和 HTTP 失败均为 0。
- 独立验收：全新上下文 Agent `/root/attachment_upload_independent_acceptance` 只依据交接包与原始证据，独立复跑 Web 定向测试 13/13、Gateway 存储/隔离测试 12/12、679 模块生产构建和隔离浏览器 34MiB 拖拽场景，并逐张目视核对上传前、上传中、上传后三张截图；限定在“隔离 Gateway/store + 当前 Web 生产构建 + 本机无头浏览器”范围内结论为 `PASS`。独立 Agent 未修改产品文件、未暂存/提交、未使用或重启真实 3000/3001 服务。
- 残余风险：本地验收使用 Node 22.11.0，而 Gateway 声明 Node 24.14.1；隔离 loopback 验收未覆盖部署反向代理、跨地域或真实弱网，120 秒超时由注入即时 timer 的单元测试验证而未等待真实时钟；生产构建仍有既有的大 chunk 告警。真实部署进程未重启，发布后仍需在声明的 Node/CI 环境及等价预发代理补跑 30–50MiB 受控 smoke。

## REG-20260803-DEVBENCH-016：故事点投屏被设备独占租约误拦截

- 复现：任一故事点持有某个 serial 的脚本、安装或验收运行时租约后，任何已绑定该 serial 的故事点点击“投屏”都会返回 `DEVICE_RUNTIME_BUSY` 409；只有任务释放设备后才能启动 scrcpy。
- 根因：`POST /tabs/:id/scrcpy` 把只读观察用途的投屏启动包装成瞬时设备独占请求，因此错误参与了面向脚本、安装和 ADB 写操作的故事点租约竞争。
- 行为合同：
  - 故事点投屏只读取当前 Tab 已绑定的设备 serial 并启动 scrcpy，不申请、排队、续期或释放设备运行时租约；投屏按钮不受当前或其他故事点占用设备影响；
  - shell、APK/XAPK 安装、push、原始 ADB、验收脚本以及 CarDev 设备入口仍必须经过全局设备运行时守卫，不能借投屏豁免获得并发写能力；
  - scrcpy detached 窗口生命周期不持有设备 lease；多个故事点可同时发起同一设备的投屏，窗口数量由操作者自行管理。
- 自动化守卫：`gateway/test/device-operation-route-guard.integration.test.mjs`。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 当前验证：修复前路由用例稳定复现设备被任一故事点占用时投屏返回 409；修复后路由定向用例确认占用方与其他故事点均可启动投屏、原 lease 身份及队列保持不变，同时 CarDev 与其他设备操作继续返回 409。完整构建、运行时投屏和独立验收结论见本次故事点验收记录。
- 残余风险：真实设备上的 scrcpy 可执行文件、窗口创建和长时间投屏仍需在目标 Gateway/设备上验证；投屏与设备写任务允许并行是本需求明确的行为边界。

## REG-20260803-DEVBENCH-017：故事点聊天“查看预览”打开认证错误 JSON

- 复现：管理员已登录故事点工作台，聊天消息或附件列表包含 `storydev:/...` 产物时点击“查看预览”，新窗口、图片、视频或 iframe 直接请求 `GET /api/devbench/tabs/:id/artifact`，生产认证中间件返回 `DEVBENCH_AUTH_REQUIRED` JSON。
- 根因：普通 API 通过 JavaScript `fetch` 附加 Bearer token，但浏览器原生导航和富媒体子资源请求不能附加该请求头；已有的产物票据服务未接入 Gateway 路由和前端预览链接，导致认证状态无法安全传递。
- 行为合同：
  - 已认证页面先调用 `POST /tabs/:id/artifact-tickets`，为预览与下载分别签发短时票据；浏览器只能使用包含票据的产物 URL，不把管理员 Bearer 写入 URL、DOM 或持久化存储；
  - 票据精确绑定 tab、`storydev:/` 引用、预览/下载模式、允许的 GET/HEAD 方法、源文件身份和不可变快照；过期、篡改、跨 Tab、源文件替换/删除、快照篡改以及故事点删除均失败关闭；
  - 生产环境的产物读取即使携带 Bearer 也必须提供有效票据；支持媒体 Range、HEAD、安全下载和原有 MIME/`nosniff` 行为；
  - 聊天 Markdown 富媒体、裸产物引用、显式产物卡片和材料列表统一使用票据 URL，并在到期前自动刷新；票据未就绪时不生成可点击的未认证原始链接。
- 自动化守卫：`gateway/test/artifact-ticket.test.mjs`、`gateway/test/story-artifact-ticket.integration.test.mjs`、`gateway/test/story-storage-routes.test.mjs`、`web-dashboard/src/pages/devbench/storyMessageModel.test.mjs`。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 当前验证：修复前票据路由集成用例 5/5 因 404 失败，且原页面链接可直接复现认证 JSON；接入后票据单元与集成矩阵 9/9、生产故事存储路由 11/11 通过。完整 Web 构建、实际浏览器预览和独立验收结论见本次故事点验收记录。
- 残余风险：票据默认有效期 10 分钟并依赖前端提前刷新；大量并发预览受快照容量策略约束。部署中的旧 Gateway/Web 进程必须更新或重启后才会加载本修复。

## REG-20260803-DEVBENCH-016：故事点初始化核对超过十分钟后“确认创建”被锁死

- 复现：开启故事点 AI 推理，从 TB 单进入初始化面板并完成人工复核后，核对工程、关联工程、Flavor 和设备超过 10 分钟，再点击“确认创建”；服务端返回 `STORY_CREATE_AI_REVIEW_EXPIRED`，前端显示“人工复核证明已过期，请重新推理并复核”，随后把“确认创建”置为不可用。
- 根因：创建与重开共用的人工复核凭证在未配置时默认仅有效 10 分钟；初始化面板本身是允许长时间人工核对的四步流程，默认有效期短于正常操作时间，导致合法的最终确认被误判为过期。
- 行为合同：
  - 未显式配置时，故事点 AI 人工复核凭证默认有效 1 小时，覆盖正常的多步骤人工核对；显式配置的更短窗口继续生效，最大值仍限制为 1 小时。
  - 延长默认窗口不得放宽现有 owner、project、consumer、入口、标题、TB 工单身份、规则新鲜度和人工决定校验；过期后仍必须重新推理并复核。
  - 初始化 intent 仍只在最终确认时签发并保持短时、单次消费；确认前不得创建 Tab、worktree 或设备绑定。
- 自动化守卫：
  - `gateway/test/story-create-review.test.mjs` 覆盖默认 1 小时内的 11 分钟人工核对可通过、显式 10 分钟策略仍过期，以及 1 小时上限。
  - `gateway/test/story-create-ai-review.integration.test.mjs` 覆盖完整创建复核与初始化门禁。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 验收范围：Gateway 单元回归 13/13、创建复核/TB 访问/Git 并发相关集成回归 21/21 通过，其中真实路由覆盖默认配置下人工复核后等待 11 分钟仍可签发初始化 intent；Web 生产构建完成 679 个模块。隔离 Gateway、数据库、DevBench store、TOTP、Git fixture 和外部请求后，Chrome 实际操作 AI 关闭、AI 正向复核、AI 暂不采用、首次创建失败后重试、配置读取 500 失败关闭共 5/5 场景通过；确认前 Tab 数不变，最终确认后只创建一个 Tab，机器结果、13 张截图和日志保存在临时验收目录，未暂存/提交。源码与隔离自验收为 `PASS`；运行中的 3001 Gateway 未重启，线上加载与当前已过期面板恢复为 `PARTIAL`，待安全重启后验证。
- 独立验收：全新上下文 Agent 仅依据交接包、当前差异和原始证据，复跑单元 13/13、集成 21/21、Web 679 模块生产构建与差异检查，并人工核对全部 13 张截图；确认 TTL 边界与既有 owner/project/consumer/入口/标题/TB/规则新鲜度门禁未被放宽，源码与隔离范围为 `PASS`。3001 Gateway 进程启动时间早于源码修改且未重启，当前运行环境为 `BLOCKED（尚未加载修复）`，综合 verdict 为 `PARTIAL`。独立 Agent 未修改文件、暂存区或运行服务。
- 残余风险：运行中的 Gateway 需要在不会打断活动故事点任务时重启才会加载新默认值；超过 1 小时的初始化核对仍会按安全策略要求重新推理复核。

## REG-20260803-DEVBENCH-018：Git Update 冲突失败弹窗在小屏幕上无法关闭

- 复现：故事点执行 Git Update 后出现多个工程冲突或后端错误，结果小窗在输入区上方向上展开；小分辨率或移动视口下，固定 330px 详情再叠加标题、AI 提示和底部栏会超过可视高度，顶部唯一的关闭图标被顶出屏幕，用户无法点击关闭。
- 根因：结果小窗只限制了详情列表高度，没有以动态视口高度约束整个弹窗；外层始终绝对定位在输入框上方，操作栏也没有独立于长错误内容固定，失败态底部只提供“重新更新”而没有关闭入口。宽屏断点还把弹窗层级从 `z-[85]` 降为 `z-30`，短屏时会被 `z-40` 的全局开发工具浮层覆盖，即使按钮可见也无法命中。
- 行为合同：
  - 窄屏使用相对动态视口固定的底部浮层，宽屏继续保持输入框上方的紧凑弹窗；整体最大高度必须随 `dvh` 收缩，不能越过屏幕边界。
  - 标题栏和失败态操作栏保持在滚动区之外；AI 错误、多工程结果和冲突文件只在中间区域滚动，长内容不得把操作按钮推出视口。
  - Git Update 非运行态同时保留顶部关闭图标和底部带文字“关闭”按钮；底部关闭与“重新更新”并列，在窄屏换行后仍可点击。
  - 所有响应式断点下 Git Update 弹窗层级都必须高于全局开发工具浮层，关闭按钮中心命中目标必须仍是按钮本身。
- 自动化守卫：`web-dashboard/src/pages/devbench/storyEntryInferenceModel.test.mjs`。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 验收范围：Web 定向回归 44/44、完整 pretest 15/15 与主测试 320/320 通过，Vite 生产构建完成 680 个模块；Chrome 使用 app-mock API/WebSocket 注入 9 个工程的冲突/失败结果，390×360 与 800×320 两种视口均确认面板不越界、中间详情独立滚动、关闭按钮中心命中自身且点击后弹窗消失。机器结果、验收脚本和两张截图保存在 `docs/tempFiles/story-acceptance/20260803-git-update-small-screen/`，受忽略规则保护，未暂存或提交。
- 独立验收：全新上下文 Agent 只读检查四个目标文件、验收脚本、机器结果及两张截图，复跑定向 44/44、完整 Web 15/15 + 320/320、680 模块生产构建及 `git diff --check`，确认移动视口使用固定底部浮层、短桌面仍在输入区上方、滚动与操作区分离、`z-[85]` 未被响应式断点降级，结论为 `PASS`；未修改、暂存、提交或操作用户服务。
- 残余风险：浏览器虚拟键盘、超小横屏和嵌入式 WebView 对动态视口单位的实现存在差异，需用目标客户端尺寸覆盖至少一轮真实交互。

## REG-20260803-DEVBENCH-018：故事点初始化本机工程候选无法按分支或完整路径搜索

- 复现：打开“故事点初始化配置 → 工程范围 → 本机工程”，主工程下拉只能滚动浏览全部候选，关联工程列表也没有搜索入口；当同名工程较多或只知道当前 Git 分支/本机完整路径时，无法快速定位目标工程。
- 根因：`/api/devbench/projects` 已返回工程名称、完整路径和各本机路径的实时 `branch`，但初始化面板只负责展示这些字段，没有统一的查询归一化与候选过滤合同；主工程直接遍历全部 `projects`，关联工程仅排除当前主工程后直接遍历。
- 行为合同：
  - 主工程下拉和关联工程列表必须复用同一个过滤函数，并匹配工程名/稳定 ID、实时 Git 分支和工程完整路径。
  - 匹配忽略大小写，Windows 反斜杠与正斜杠路径等价；空格分隔的多个关键词必须全部命中，空查询保持服务端原顺序。
  - 搜索状态与 `primaryProjectId`/`extraProjectIds` 草稿选择分离；过滤、清空或无结果不得改变已选工程，也不得在最终确认前创建 Tab、worktree 或设备绑定。
  - 主工程候选继续展示名称、完整路径和实时分支；关联工程继续展示运行信息和 Android Studio 入口；无匹配时显示明确空状态。
- 自动化守卫：`web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs` 覆盖名称、分支、大小写、路径分隔符、多关键词、空查询和不修改输入数组，并以源码合同约束主工程/关联工程都消费过滤结果；`storyEntryInferenceModel.test.mjs` 保持初始化入口与工程打开链路回归。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 自验收：定向测试 72/72、管理认证预检 15/15、完整 Web 测试 320/320 通过；Vite 生产构建完成 680 个模块。隔离 Gateway 返回 3 个带实时分支的临时工程，无头 Edge/Chrome 实际验证主工程名称/分支/完整路径过滤、关联工程分支/完整路径过滤和无结果状态；页面错误、控制台错误与 HTTP 失败均为 0，`git diff --check` 通过。
- 独立验收：fresh Agent `/root/local_project_search_acceptance` 未读取开发 Agent 自验结论，独立复跑定向 72/72、pretest 15/15、完整测试 320/320、680 模块生产构建、隔离浏览器脚本与差异检查，并逐张目视 4 张截图，结论 `PASS`；未修改产品文件、未暂存或提交。
- 残余风险：隔离夹具只有 3 个工程，未覆盖数百/数千候选的输入性能；未替换或重启用户当前运行服务；已勾选关联工程经过“过滤隐藏 → 清空搜索”后的保留由查询 state 与草稿 state 分离及单元测试审查覆盖，尚无专门浏览器断言。

## REG-20260803-DEVBENCH-018：AI 推理待人工复核时“确认创建”不可点击

> 已被 `REG-20260803-DEVBENCH-019` 取代：AI 推理与人工复核不再是故事点初始化的创建门禁，本条仅保留为缺陷演进记录。

- 复现：开启故事点 AI 推理，推理完成后直接进入初始化面板第 4 步；页面显示“AI 推理已完成”和“未发现来源矛盾”，但“查看AI推理”在无障碍树中表现为普通提示文本，“确认创建”按钮被禁用，用户无法从预期的最终操作继续。
- 根因：前端只有 `disabled`、`reviewed`、`skipped` 三种阶段允许最终确认；`review_ready` 虽然有独立复核入口，却直接把底部主按钮禁用，没有把主操作转接到必需的人工复核流程。
- 行为合同：
  - `review_ready` 时“确认创建”保持可点击；点击只打开 AI 推理人工复核，不签发初始化 intent，不创建 Tab、worktree 或设备绑定。
  - 人工确认应用或“暂不采用”成功保存后，第二次点击才执行真实创建；不得自动接受 AI 结果或绕过 owner、范围、来源冲突与服务端 proof 门禁。
  - 推理运行中、复核保存中、错误、stale、partial recovery、缺少复核入口或存在未裁决来源冲突时仍失败关闭。
- 自动化守卫：`web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs` 覆盖 `confirm`、`review_inference`、`blocked` 三态及面板主按钮接线；隔离浏览器验收必须从最终确认按钮进入复核，并确认复核前 Tab 数不变。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 验收范围：Web 定向回归 72/72、pretest 15/15、完整测试 320/320 通过，生产构建完成 680 个模块。隔离 Gateway/store/config/TOTP/Git 与外部请求后，Chrome 实际从可点击的“确认创建”进入 AI 复核，复核前 Tab 数保持 1，保存人工结论后才从 1 增至 2；连同 AI 关闭、暂不采用、首次失败重试和配置 500 失败关闭共 5/5 场景通过，机器结果与 14 张截图保存在临时验收目录。当前 `127.0.0.1:3000/devbench` 经 Vite 热更新后，UI Automation 确认主按钮由 disabled 变为 enabled，实际点击后出现“返回故事点初始化配置”，可见故事点 Tab 仍为 5，Gateway 没有新增 `devbench-create` 日志；未替用户提交人工结论或创建故事点。源码、隔离浏览器和当前运行环境自验收为 `PASS`。
- 独立验收：全新上下文 Agent 仅依据交接包、当前差异和原始证据，复跑 Web 定向回归 72/72、pretest 15/15、完整测试 320/320，并核对浏览器机器结果、网络时序、关键截图、当前 UI 状态和 production 日志。独立结果确认首次点击只打开人工复核，复核前没有创建请求、Tab 数不变；当前页面已显示人工复核，最新 `devbench-create` 仍早于本次热更新。源码、隔离浏览器完整流程及当前 production 页面的只读首段行为均为 `PASS`。独立 Agent 未执行构建、未点击页面、未修改文件、暂存区或服务。
- 残余风险：AI 复核仍要求用户完成一次明确的人工作用；该安全步骤不会被合并为自动创建。

## REG-20260803-DEVBENCH-019：AI 推理与复核页面阻塞故事点初始化主流程

- 复现：开启故事点 AI 推理后，从新建入口进入初始化配置；当推理处于运行、待复核、复核页已打开、反馈保存中、失败或 stale 状态时，“确认创建”会被禁用或被强制改道到复核流程。即使用户已经完成全部人工配置，也必须等待 AI 或先保存一次复核结论；服务端在 AI 开关开启时还会对未携带 AI proof 的初始化请求直接失败关闭。
- 根因：前端把 `inferencePhase` 同时接入初始化面板 `canConfirm`、主按钮动作和全屏复核遮罩；服务端又把全局 AI 开关等同于“每次创建都必须带 proof”。可选建议、反馈持久化和最终人工配置确认因此错误地共享了同一同步门禁。
- 行为合同：
  - 故事点初始化中的 AI 推理、人工复核和反馈保存全部是可选异步辅助，不得参与“确认创建”的可用性判断；`checking`、`running`、`review_ready`、`reviewing`、`saving_skip`、`reviewed`、`skipped`、`error`、`stale` 均按当前人工可见配置继续主流程。
  - 打开 AI 复核页不得形成全屏交互屏障；页面必须保留“返回初始化配置”和“使用当前配置继续创建”入口。用户从复核页直接继续，或点击仍可操作的主面板确认时，立即关闭该复核展示并按当前草稿推进，不等待 review API。
  - “确认应用”和“暂不采用”先同步关闭复核页并更新当前草稿/状态，review 反馈随后在后台 best-effort 保存；保存失败只做非模态提示，不回滚已确认草稿，不阻塞创建。
  - 初始化 intent 只冻结用户最终确认的当前配置，不携带或依赖 AI run/proof。服务端 AI 开关开启但客户端没有显式提交 runId 时允许纯人工初始化；如果调用方显式提交 runId，仍必须严格校验 owner、project、consumer、入口和复核结论，伪造或越权 proof 继续失败关闭。
  - 最终确认之前仍不得创建 Tab、worktree 或设备绑定；表单合法性、来源配置未就绪、部分创建恢复、初始化 intent 单次消费，以及既有 owner、TB、标题、工程、设备和工作区门禁不放宽。
- 自动化守卫：
  - `web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs` 覆盖全部 AI 阶段不参与创建动作；`storyEntryInferenceModel.test.mjs` 覆盖复核页非阻塞展示、直接继续、主面板确认关闭孤立复核页，以及 review 后台保存顺序。
  - `gateway/test/story-create-ai-async.integration.test.mjs` 覆盖 AI 开关开启且没有 run 时纯人工创建成功、跳过初始化 intent 仍失败、显式伪造 run 仍失败；`story-create-ai-review.integration.test.mjs` 继续覆盖显式 proof 的 owner/project/consumer/入口和复核约束。
  - 隔离浏览器验收必须实际打开 AI 复核页，在不提交 review 的情况下从“使用当前配置继续创建”完成创建，并证明打开复核页前后 Tab 数不变、最终只创建一个 Tab、初始化请求不含 `configInference`。
- 修复版本：2026-08-03 工作区修复，尚未提交版本号。
- 当前验收：Web 定向回归 72/72、pretest 15/15、完整测试 320/320、Gateway 异步与显式 proof 集成回归 18/18 通过，生产构建完成 680 个模块。隔离 Gateway/store/config/TOTP/Git 与外部请求后，Chrome 5/5 场景通过：AI 复核页打开前后 Tab 均保持 1，不提交 review 即可按当前配置创建到 2，初始化请求不含 `configInference`；“暂不采用”场景对 review 注入 500 后立即回到初始化面板并显示非阻塞失败说明，随后仍从 2 唯一创建到 3；AI 配置读取 500 时确认按钮保持可用并从 4 唯一创建到 5；AI 关闭及首次初始化 409 重试也均通过。机器结果、网络事件、日志和 13 张截图保存在临时验收目录，未暂存/提交。
- Production 加载：重启前只读确认 5 个故事点、0 个运行任务；通过 Service Control 重启后，Gateway PID 59024、Web PID 58128，健康检查 `status=ok`，最终启动日志为 `control_20260803_220643.log`、`gateway_20260803_220643.out.log`、`web_20260803_220643.out.log`，两端 stderr 为空；重启后仍为 5 个故事点、0 个运行任务。为避免改写用户草稿，未在真实 Production 页面执行最终创建。
- 独立验收：第一轮全新上下文 Agent 将源码判为 `PARTIAL`，准确发现“AI 开关关闭时显式 runId 跳过严格校验”和“缺少 review 500 动态证据”两个缺口；补强后第二轮全新 Agent 复跑 Gateway 18/18、Web 72/72、差异检查，并核对 5/5 浏览器机器结果、review-500 后续 201/200 网络时序、6 张关键截图和最新 Production 启动/监听状态，源码合同、自动化、隔离浏览器与 Production 加载四项均为 `PASS`，总体结论升级为 `PASS`。两个 Agent 均未修改文件、配置、服务、暂存区或真实数据。
- 残余风险：测试运行于 Node 22.11.0，尚未在 Node 24 环境复跑；未在真实 Production/TB/worktree/device 创建链执行 canary。非故事点初始化入口若拥有独立的业务授权合同，仍按各自合同处理；本条保证的是“新建故事点的初始化与最终确认”不受 AI 推理生命周期阻塞。

## REG-20260804-DEVBENCH-020：编辑故事点配置仍被新建向导强制逐步确认

- 复现：从现有故事点打开配置面板，只修改“构建与设备”中的目标设备后，底部仍显示“下一步”，必须继续经过后续 Tab 到最后一页才能更新；设备候选也只能使用面板打开前的列表。顶部“配置”下拉与旁边“配置工程”按钮还同时提供编辑入口，职责重复。
- 根因：新建和编辑虽然共用中央面板并拥有不同 Tab 集合，但底部主操作仍只按 `activeTab === "review"` 判断，导致编辑态继续继承新建向导的线性步骤；目标设备选择没有把现有 `refreshDevices()` 回调接入面板；配置下拉遗留了迁移前的编辑入口。
- 行为合同：
  - 新建模式继续按“故事点信息 → 工程范围 → 构建与设备 → 确认”逐步推进，最终确认前不得创建 Tab、worktree 或设备绑定。
  - 编辑模式在任意 Tab 都显示“确认更新”，不显示“上一步/下一步”；提交时仍执行完整表单、来源冲突和归档目录校验，非法配置必须跳转到对应字段而不是部分写回。
  - “构建与设备”中的目标设备提供显式刷新按钮和刷新中状态，刷新只更新候选/运行时状态，不改变当前草稿选择。
  - 顶部“配置”下拉只负责复制/应用工程配置；打开中央编辑面板统一由独立“配置工程”按钮及必要的错误引导入口负责。
- 自动化守卫：`web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs`，并由 `web-dashboard` 的 `npm test` 与 `npm run build` 覆盖接线和编译。
- 修复版本：2026-08-04 工作区修复，尚未提交版本号。
- 当前验证：配置/消息/入口定向回归 79/79、管理认证 pretest 15/15、完整 Web 测试 327/327 通过，Vite 生产构建完成 681 个模块。隔离启动当前仓库页面并连接现有 Gateway 的只读数据，Edge 实测编辑态构建 Tab 直接显示“确认更新”且无上下步、设备刷新显示“刷新中…”，配置下拉只保留“复制配置”；机器结果、脚本和截图保存在 `docs/tempFiles/story-acceptance/20260804-story-config-chat-ux/`。
- 独立验收：全新上下文 Agent 仅依据交接包、白名单差异与原始证据，复跑 79/79 定向、15/15 pretest、327/327 完整测试、681 模块构建及差异检查，并逐张目视 7 张截图，确认本条配置交互合同，结论 `PASS`；未修改文件、暂存、提交或操作服务。
- 残余风险：真实 ADB 设备上下线与设备 FIFO 状态变化仍需在连接目标设备的 Gateway 上验证；刷新动作不自动轮询，也不会替用户改变已选设备。

## REG-20260804-DEVBENCH-021：消息发送期间草稿重复显示且失败消息无法编辑重发

- 复现：点击发送后，用户消息已经乐观显示在对话区，但输入框正文、引用和附件仍保留到 `/send` 成功返回；若请求在服务端落库前失败，前端继续显示仅本地存在的用户消息，随后“编辑并重新发送”把该本地 ID 传给历史分支接口，返回“要编辑的消息不存在或不属于当前故事点”。
- 根因：输入状态清理被放在网络成功分支，视觉反馈取决于慢请求；乐观消息没有 `pending/failed/localOnly` 生命周期，失败也被追加成伪 assistant 错误气泡，编辑路径无法区分服务端历史节点与未落库的本地发送尝试。
- 行为合同：
  - 点击发送并冻结本次正文、引用和附件快照后，输入框必须在发出网络请求前立即清空；用户在请求期间输入的新草稿不得被成功或失败回调覆盖。
  - 乐观用户消息明确标记 `pending`；失败后原气泡转为 `failed/localOnly` 并展示失败原因，不伪装成 AI 回答，也不把同一正文恢复到输入框造成重复。
  - 编辑服务端已存在的用户消息继续创建不可变对话分支；编辑本地失败消息必须复用普通发送路径，并保留本轮附件元数据，禁止调用需要服务端历史 ID 的 `conversation/edit-and-resend`。
  - 普通发送成功返回 `userMessageId` 时，用服务端 ID 替换乐观 ID；排队/实时注入仍由后续权威对话刷新收敛，不放宽既有 FIFO 和运行中编辑门禁。
- 自动化守卫：`web-dashboard/src/pages/devbench/storyMessageSendModel.mjs`、`storyMessageSendModel.test.mjs`、`storyEntryInferenceModel.test.mjs`；新模型测试已纳入 `web-dashboard/package.json` 的 `npm test`。
- 修复版本：2026-08-04 工作区修复，尚未提交版本号。
- 当前验证：修复前定向测试因缺少发送状态模型和编辑主操作模型失败；修复后配置/消息/入口定向回归 79/79、管理认证 pretest 15/15、完整 Web 测试 327/327 通过，Vite 生产构建完成 681 个模块。Edge 请求拦截实测发送后 150ms 输入框为空且乐观气泡处于 pending，模拟 503 后原用户气泡显示失败且编辑可用；重新发送仍命中普通 `/send` 两次且没有调用 `/conversation/edit-and-resend`，成功后失败/pending 状态收敛。
- 独立验收：全新上下文 Agent 独立复跑全部测试与构建并核对 DOM 断言、请求记录和 7 张截图，确认输入即时清空、失败消息可编辑、相同 `clientMessageId` 的失败/重试均走 `/send` 且无历史编辑请求，结论 `PASS`；未修改文件、暂存、提交或操作服务。
- 残余风险：未实际调用付费 AI Provider；真实长连接断开、跨 Gateway 排队完成和旧页面热更新前遗留的无状态乐观消息仍需运行环境验证。

## REG-20260804-DEVBENCH-022：故事点配置面板从本机工程 AS 入口误开 worktree

- 复现：编辑已有故事点，进入“故事点配置 → 工程范围 → 本机工程”，点击主工程或关联工程旁的 AS 按钮；Android Studio 打开的是当前故事点 Git worktree，而不是本机工程列表登记的基础工程目录。
- 根因：配置面板从 `storyTab.worktree.entries` 建立 `baseProjectId/basePath → worktreePath` 映射，`studioPathForProject()` 又优先取该映射，导致“本机工程”入口被故事点运行时工作区语义覆盖。
- 行为合同：
  - “工程范围 → 本机工程”的主工程与关联工程 AS 按钮只能使用项目定义返回的 `project.path`，新建和编辑模式保持一致。
  - 故事点 worktree 仍由故事点页面已有的工作区/Android Studio 入口负责；不能通过配置面板本机工程入口隐式替换基础工程路径。
  - 工程路径为空或不可用时不展示 AS 按钮；本次修复不改变工程选择、分支、Flavor、worktree 创建或保存逻辑。
- 自动化守卫：`web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs` 直接验证基础路径解析，并以源码合同禁止配置面板重新引入 `managedStudioPaths` 或向面板传递 `storyTab` 作为打开路径来源。
- 修复版本：2026-08-04 工作区修复，尚未提交版本号。
- 当前验证：修复前测试因缺少基础路径合同失败；修复后初始化模型 32/32、配置/消息/入口定向回归 79/79、管理认证 pretest 15/15、完整 Web 测试 327/327 通过，Vite 生产构建完成 681 个模块。Edge 拦截 AS 打开请求，确认主工程基础路径为 `D:\workspace\xsProjects\202605\AISdkV4\202605AppMarketSeres\AppMarketProjects`，故事点 worktree 为 `D:\workspace\xsProjects\WorktreeSpace\seres_CARB_13465`，实际 `/open-in-studio` 参数严格等于前者且不等于后者；未真实启动 IDE。
- 独立验收：全新上下文 Agent 独立核对前后端调用链、浏览器原始请求和路径对照，确认 `POST /api/devbench/open-in-studio` 只携带 `project.path` 且不等于 worktree；复跑全部测试、构建和差异检查后结论 `PASS`，未真实启动 IDE 或修改文件。
- 残余风险：自动化浏览器验收会拦截 `/open-in-studio` 避免真实启动 IDE；需在用户可接受打开 Android Studio 时再做一次真实基础目录启动确认。

## REG-20260804-DEVBENCH-023：故事点 AI 会话未注册应用市场开发环境后台 MCP

- 复现：在 AIEfficiencyTrack 仓库目录执行 `codex mcp list` 可看到 `appmarket_admin_backend`，切换到故事点目标工程或其 worktree 后执行同一命令只剩全局 MCP；故事点中新建的 Codex 会话返回 `No MCP server named ... found`，Claude、Gemini、API 模型和分布式 Agent V2 也没有一致的 20 个应用市场只读工具。
- 根因：原实现只依赖仓库级 `.codex/config.toml` 的相对 `cwd` 注册；DevBench 启动 Codex 时又使用隔离 `CODEX_HOME`，故事点工作目录通常属于另一工程，因此项目配置既不会被发现，相对服务路径也无法解析。Claude/Gemini 没有接线，API 模型与 Agent V2 的工具注册表也没有 MCP 桥接；启动和发布流程还没有安装/携带 `mcp-servers/devServer` 依赖。
- 行为合同：
  - 稳定注册 ID 为 `appmarket_admin_backend`，npm 包名为 `appmarket-admin-readonly-mcp-server`；所有故事点可选的原生 CLI 模型、OpenAI 兼容 API 模型和分布式 Agent V2 都能发现同一组 20 个只读工具。
  - 注册必须在 AI 进程或会话创建前完成，并使用由 DevBench 可信安装目录解析出的绝对 Node/入口路径；不得依赖故事点 worktree 中存在 AIEfficiencyTrack 的项目配置，不要求用户手工启动 MCP 进程。
  - Claude 官方/方舟/MiniMax 使用进程级 MCP 配置；Codex 官方/MiniMax 的 exec 与 app-server 都注入会话配置；Gemini 合并保留既有用户设置并显式允许该服务；API/Agent V2 通过 MCP 客户端桥接真实工具 schema 与调用结果。
  - 认证信息只允许从 `APPMARKET_ADMIN_*` 环境变量继承；生成的 TOML/JSON、日志、工具 schema、能力声明和发布包不得写入账号、密码、Cookie 或 Token 值。服务保持精确 origin、只读 endpoint 和工具名白名单。
  - `start.ps1`/`start.sh` 自动安装 MCP 依赖；Gateway 源码包和自包含发布包必须携带服务源码与运行依赖。升级后需重启 Gateway 并创建新的故事点 AI 会话，已运行会话不宣称热更新。
- 自动化守卫：`gateway/test/appmarket-admin-mcp.test.mjs` 覆盖可信绝对路径、Codex 幂等合并、六类原生 CLI 接线、Gemini 设置保留、20 工具 MCP bridge、启动/发布链与无明文凭证；`gateway/test/api-engine.test.mjs` 覆盖故事点 API 模型工具表；`gateway/test/agent-v2.test.mjs` 覆盖分布式声明与工具 manifest；`gateway/test/codex-app-server.test.mjs` 覆盖私有运行配置注入。`desktop/scripts/gateway-bundle.test.cjs` 和 `service-control-electron/scripts/prepare-gateway.test.js` 要求 Electron Gateway 资源实际复制脱敏后的 MCP 源码并在缺包/缺 SDK 时失败关闭。`mcp-servers/devServer/test/*.test.mjs` 与 `npm run smoke` 继续守住 stdio、20 工具、只读注解、鉴权脱敏和后台访问边界。
- 修复版本：2026-08-04 工作区修复，尚未提交版本号。
- 当前验证：修复前从 AIEfficiencyTrack 之外目录执行 `codex mcp list` 只返回 OpenAI 文档服务；修复后使用与故事点相同的会话覆盖参数从外部目录执行，`appmarket_admin_backend` 状态为 `enabled`。MCP 服务静态检查、49 项测试和 stdio smoke 通过；Gateway 的原生 CLI、Codex app-server、API 模型、远端故事点本地桥接和 Agent V2 定向回归 93/93 通过。后端、Desktop Windows 和 Service Control Windows 发布构建均成功；Desktop preflight 25/25、Service Control 打包守卫 2/2 通过。分别从 `dist/backend`、Desktop 最终 `win-unpacked/resources/gateway` 和 Service Control 最终同名资源目录，使用各自随包 Node 实际启动 stdio 服务、列出 20 个工具并调用能力接口成功。当前进程没有 `APPMARKET_ADMIN_*` 凭证，因此真实开发后台鉴权/数据准确性验收保持阻塞，不把本地 stdio 结果宣称为真实后台通过。
- 独立验收：首轮全新 Agent 在后端路径通过后发现 Desktop/Service Control 未携带仓库根 MCP，结论 `FAIL`，据此补齐两条 Electron 打包链和失败关闭守卫。修复后的另一名全新 Agent 禁止读取旧报告，独立复跑 MCP 49/49、Gateway 84/84、Desktop 3/3、Service Control 2/2，并从仓库外 cwd 使用三种最终包各自随包 Node 启动同一 20 工具服务；本地/发布范围 `PASS`，因凭证为 0 将真实后台单列 `BLOCKED`，总结果 `PARTIAL`。
- 残余风险：开发后台默认地址仍是明文 HTTP，网络链路可能被同网段观察或篡改；真实后台准确性依赖本机只读账号权限与环境变量配置，未配置凭证时只能列出能力，鉴权查询会明确失败；已运行的 Gateway/AI 会话不会自动加载本次源码变更。

## REG-20260804-SERVICE-CONTROL-024：产物预览负载导致 Gateway 健康检查反复异常

- 复现：通过 Service Control 启动 Production Gateway 后，在故事点聊天中批量加载带 `storydev:/...` 引用的产物；控制日志短时间内反复出现 `HTTP health check is temporarily unavailable for gateway`，同期 Web 代理访问 `127.0.0.1:3001` 出现 `ECONNREFUSED`，但 Gateway/Web 的受管 PID 仍存活。无产物负载时连续 120 秒探测 121/121 成功，最大响应 9ms。
- 根因：不可变产物快照在 Windows 上通过同步 `PowerShell`/`icacls` 子进程验证目录 SID、owner 和 DACL。快照创建与回收会改变目录指纹，批量签发/预览因而在 Gateway 主进程内重复执行同步安全探测，冻结 Node 事件循环；Service Control 又在第一次 2.5 秒 HTTP 探测失败后立即把 profile 写成 `degraded` 并展示异常。
- 行为合同：
  - Windows SID、ACL 收紧和 owner/DACL allowlist 校验必须保持失败关闭，但只能通过异步子进程执行；任何产物快照安全探测都不得使用 `execFileSync`、`execSync` 或 `spawnSync` 阻塞 Gateway 事件循环。
  - 同一进程内并发的根目录安全校验必须串行去重，Windows SID 可按进程缓存；快照创建、打开、校验、Range/HEAD、容量限制、过期回收和删除仍保持原安全合同。
  - Service Control 对仍有 owned 进程/监听证据的首次 HTTP 失败只记录内存观察并在 5 秒后快速复查，不写入用户可见降级状态；只有连续第二次失败才展示降级。明确缺失/外来进程证据仍按原连续三次确认后判停，健康恢复会清零所有计数。
- 自动化守卫：`gateway/test/artifact-ticket.test.mjs` 检查产物安全实现不含同步子进程，并在 Windows 真实 ACL 探测期间验证事件循环定时器可响应；`gateway/test/service-control-runtime-health.test.mjs` 覆盖首次 owned HTTP miss 静默复查、连续 miss 才降级、恢复清零，以及 5 秒 pending 调度接线。
- 修复版本：2026-08-04 工作区修复，尚未提交版本号。
- 当前验证：修复前现场控制日志在约 8 分钟内出现 5 次降级，最长一次约 124 秒，Vite 同期记录多次 Gateway `ECONNREFUSED`；微小快照单测单例用例耗时约 0.6–1.5 秒。修复后产物票据单元回归 5/5、票据路由集成回归 5/5、故事存储/34MiB 上传/Range 下载回归 12/12、Service Control 运行健康回归 13/13、Service Control 相关矩阵 40/40、Electron 测试 2/2 及相关语法/差异检查通过。新代码进程已由 Service Control 接管为 `running/ready`；按控制面板真实 2.5 秒超时阈值安静探测 180 秒，Gateway 158/158、Web 158/158 成功，Gateway 最大 1071ms。Windows NSIS 安装包构建成功，包内源码合同核对通过；独立验收结论见本次验收记录。
- 残余风险：异步 ACL 探测仍受 Windows PowerShell/磁盘性能影响，但不会冻结 HTTP 事件循环；大量 100MB–1GB 产物的复制与哈希仍会占用磁盘带宽和 CPU，需要通过容量/并发策略继续观察。并发执行构建/测试时的首轮 120 秒探测曾出现 1 次 Web 代理 4.5 秒超时，新的首次失败静默复查合同可避免立即误报，但资源极端争用下若连续两次失败仍会如实展示降级。当前验收 Node 为 22.11.0，而 Gateway 包声明 24.14.1；安装包未签名，需在正式签名链和目标 Node 运行时再做发布验收。

## REG-20260804-DEVBENCH-024：故事点输入框输入/删除卡顿且 Gateway 500 后发送正文无法从输入框找回

- 复现：在已有较长会话的故事点聊天框连续使用输入法输入或退格删除，受控 `input` 每次变化都会重跑整个大型 `StoryTab`，并同步触发草稿 `localStorage` 写入；点击发送后虽然输入框立即清空，但 `/send` 返回 Gateway 500 时只留下失败气泡，原正文、引用和附件不会回到编辑区。
- 根因：草稿正文、光标、历史联想和输入法组合态全部属于 `StoryTab` 父组件状态，单个字符会连带消息 Markdown、工作流、工程/设备和浮层重新求值；发送流程只有“发前清空”和失败消息状态，没有独立的提交快照/清空版本/失败恢复契约。REG-021 的“失败正文只留在气泡、不恢复输入框”无法满足用户从编辑区立即找回原文的新要求，本条明确取代该项约束。
- 行为合同：
  - 正文、光标、联想、历史导航和输入法组合态由独立轻量输入组件持有；输入/删除不得把逐字符状态同步给整个 `StoryTab`。草稿持久化采用短延迟合并写入，组件卸载时仍刷新最后值。
  - `compositionstart/update/end` 期间保持受控输入实时更新，组合态按键不得误触 Ctrl/Cmd+Enter 发送；历史检索只扫描最近的有界用户消息集合。
  - 发送前冻结正文版本、引用和附件快照并立即清空视觉输入；成功只消费对应快照。Gateway 非 2xx、网络失败或发送回调异常时，若用户尚未开始下一条草稿，则原正文、引用和附件自动恢复且正文重新聚焦。
  - 发送等待期间形成的新草稿优先，成功或失败回调都不得覆盖；此时原发送尝试仍以 `failed/localOnly` 气泡保留，可继续使用 REG-021 的编辑重发路径。请求等待期间保留已提交正文的本地持久化副本，切 Tab/卸载时失败正文仍可恢复。
- 自动化守卫：`StoryChatInput.jsx`、`storyInputDraftModel.mjs`、`storyInputDraftModel.test.mjs` 和 `storyMessageSendModel.test.mjs`；新模型测试纳入 `web-dashboard/package.json` 的完整测试命令，并由源码合同禁止把逐字符 `input/setInput` 状态重新放回 `StoryTab`。
- 修复版本：2026-08-04 工作区修复，尚未提交版本号。
- 当前验证：定向输入/发送回归 7/7、管理认证 pretest 15/15、完整 Web 测试 331/331 通过，Vite 生产构建完成 683 个模块。Edge 隔离浏览器在当前 Vite 页面和当前 Gateway 只读故事点数据上精确拦截两次 `/send` 并返回模拟 500，同时把 4 次非目标 `artifact-tickets` POST 以模拟 503 失败关闭，`backendMutation=false`；232 次从首字符开始的中文组合输入/删除同步事件耗时 p50 0.5ms、p95 0.9ms、p99 1.3ms、最大 2.5ms、超过 16ms 为 0。第一次发送等待态输入框立即为空而持久草稿仍在，500 后正文与持久草稿精确恢复并重新聚焦；第二次等待期间输入的新草稿在 500 后未被旧回调覆盖，两个旧提交均保留失败气泡。白名单 `git diff --check` 通过。
- 独立验收：第一名全新上下文 Agent 判定 `FAIL`，发现正文有新编辑时旧附件/引用仍会被无条件恢复，且初版浏览器脚本未对全部非目标写请求失败关闭；据此增加独立上下文修订、附件/引用防覆盖回归并收紧浏览器拦截。修复后第二名全新上下文 Agent 独立复跑定向 7/7、pretest 15/15、完整 Web 331/331、683 模块构建、白名单差异检查和 SHA-256 一致的 Edge 脚本副本；其浏览器结果为 232 个样本 p50 0.4ms、p95 0.9ms、p99/最大 1.4ms、超过 16ms 为 0，两次 `/send` 模拟 500、4 次非目标写请求被阻断、`backendMutation=false`，结论 `PASS`。两名 Agent 均未修改、暂存或提交工作区文件，也未重启服务。
- 残余风险：浏览器用标准组合事件模拟中文输入法，并未覆盖每个 Windows 第三方 IME；请求失败为页面拦截模拟 500，未让真实 Gateway/Provider 故障，也未验证进程崩溃恰好发生在服务端已落库但响应丢失的 publication-unknown 场景。

## REG-20260804-DEVBENCH-025：本地工程故事点 worktree 已完成但页面永久停留在后台初始化

- 复现：从 TB 入口选择本地工程创建 CARB-13955，创建响应携带 `workspaceInitialization.status=queued/preparing` 后立即进入故事点页面；如果该页面没有收到或处理 `devbench_story_initialization_progress` 完成事件，顶部持续显示“正在后台初始化故事点工作区 / 正在创建独立 worktree”，输入与开发操作一直锁定。刷新页面后从 `/api/devbench/tabs` 读到持久化 `ready`，横幅才消失。
- 根因：TB/空白故事点创建入口只在创建响应后刷新一次 Tab，后续状态收敛完全依赖 WebSocket；现有轮询只服务于自动启动开发或组队流程，普通创建页面没有漏事件补偿。同时多个 `reloadTabs()` 并发时按响应到达顺序无条件覆盖，较早请求可能晚到并把较新的 `ready` 快照覆盖回 `preparing`。
- 行为合同：
  - WebSocket 继续作为低延迟通知，但只要任一 Tab 的本地 worktree 或远程源码仍处于 `queued/preparing/cloning`，页面必须按持久化 `/tabs` 状态每秒校准，直到进入 `ready` 或 `error` 终态。
  - Tab 刷新响应按请求代次单调应用；较早请求晚到时不得覆盖已经应用的较新响应，较新请求失败时也不能阻止仍有效的较早成功响应落地。
  - 本地工程仍作为基仓创建故事点独立 worktree；本修复只保证真实完成态及时解锁，不绕过 worktree 隔离，也不把 `preparing` 伪装成 `ready`。
- 自动化守卫：`web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs` 覆盖本地、远程、ready 和 error 状态分类，并检查漏 WebSocket 事件时的定时校准及并发刷新代次门禁接线。
- 修复版本：2026-08-04 工作区修复，尚未提交版本号。
- 当前验证：现场系统日志确认 CARB-13955 以 `kind=confirmed_local` 创建；持久化 Tab 显示 operation `d9c9eaef-2558-4cf4-9e1e-e8627544ea89` 在约 8.5 秒内完成，两个 worktree 均实际登记到对应 Git 仓库，`workspaceInitialization/worktreeStatus=ready`、`progress=100`，排除 Git 初始化卡死。修复前新增回归因缺少状态校准导出而失败；修复后初始化模型 33/33、配置/消息/入口定向矩阵 79/79、管理认证 pretest 15/15、完整 Web 332/332 通过，Vite 生产构建完成 683 个模块。Edge 屏蔽全部 WebSocket 事件并拦截 `/tabs` 先返回 `preparing`、后返回现场 `ready`：页面先展示横幅且锁定输入，第 3 次读取在约 1.08 秒后移除横幅并解锁，`backendMutation=false`；两张前后截图已目视核对。
- 独立验收：全新上下文 Agent 仅依据交接包和原始证据，独立检查四个变更文件与全部七类原始产物，复跑初始化 33/33、pretest 15/15、完整 Web 332/332、683 模块生产构建，并完成不落文件的 Edge 复验；WebSocket 事件为 0，三次 `/tabs` 读取后从锁定态进入无横幅/可输入态，结论 `PASS`。该 Agent 未修改、暂存、提交或重启仓库与服务。
- 残余风险：轮询会在 WebSocket 异常期间增加每秒一次 `/tabs` 只读请求；当前 `/tabs` 返回全量故事点，后续故事点数量显著增长时可演进为按 Tab 查询或服务端状态版本长轮询。本次没有创建第二个真实 worktree，远程 clone 收敛与刻意乱序 HTTP 仅由模型/源码合同覆盖；浏览器控制台有一个未识别的只读 404，构建保留既有大 chunk 警告。当前 Node 为 22.11.0，而部分打包链声明 Node 24；本次不重启用户当前 Gateway，运行中页面需加载新前端代码后才生效。

## REG-20260804-DEVBENCH-026：远程源码长路径检出失败且进度/错误证据被丢弃

- 复现：以远程源码模式创建 CARB-13955，目标为 `appMarket / v202605-ui`。初始化横幅长期保持固定进度，约一分钟后只显示“远程源码后台初始化失败 / 部分仓库克隆失败”；自动与手动重试表现一致。使用同一源码准备链路隔离复现时，Git 下载及 Updating files 到 100% 后因 `WebAppVoiceControlAccTreeDebugOrRelease.kt` 等深层文件触发 `Filename too long`，随后报 `fatal: unable to checkout working tree`。
- 根因：SourceCache 的 Git for Windows clone 没有像故事 worktree/Controller runner 一样命令级启用 `core.longpaths=true`，依赖机器全局设置；路由为防止旧 generation 污染新配置而使用空 `tabId` 影子任务，底层逐仓库 WebSocket 进度因此被前端全部忽略；聚合层又只写“部分仓库克隆失败”且失败时不保存 `remoteRepos`，真实 Git 错误和错误码同时丢失。
- 行为合同：
  - Windows SourceCache 与 legacy clone 都必须在 Git 命令上显式注入 `-c core.longpaths=true`，不得依赖用户 global/system 配置；其它平台保持原参数。
  - 空 `tabId` 影子任务继续隔离底层写回，但逐仓库进度必须经当前 `operationId + generation + mutation lease` 守卫转发到真实故事点；总进度按克隆阶段映射到 5–65%，源码完成进入 worktree 阶段后继续到 70–100%。
  - 总进度同时写入 `remoteSourceInitialization.progress/repositories`，WebSocket 丢失时页面按每秒 Tab 校准继续变化；前端使用总进度，不再把多阶段 Git 原始百分比简单平均或固定为 20%。
  - 失败时必须持久化各仓库 `error/errorCode/branch/path`，横幅优先展示具体仓库和脱敏后的 Git 错误；新 generation 仍不得接收旧任务的进度、结果或错误。
- 自动化守卫：`gateway/test/source-preparation.test.mjs` 覆盖 Windows 命令级 longpaths 参数及真实超过 260 字符 tracked path 的 clone/checkout；`gateway/test/remote-source-initialization-generation.test.mjs` 覆盖真实 operation 的进度持久化和 `Filename too long` 失败证据；`web-dashboard/src/pages/devbench/storyInitializationModel.test.mjs` 覆盖 WebSocket 总进度合并与持久化进度兜底。
- 修复版本：2026-08-04 工作区修复，尚未提交版本号。
- 当前验证：现场日志与数据库确认 CARB-13955 连续两次在约 62–77 秒后只持久化 `progress=5`、`remoteRepos=null` 和“部分仓库克隆失败”；修复前使用完全相同的 `appMarket / v202605-ui` 链路复现 Git 下载 100% 后 `Filename too long / unable to checkout working tree`。修复后同仓同分支真实 SourceCache 在 49 秒内 `cloned`；隔离复制真实数据库并把 cloneParent 指向仓库外临时目录，通过真实 `/remote/init` 完成远程 clone、本地化和 managed worktree，持久化进度依次覆盖 5–64%、70%、100%，最终 `remoteSourceInitialization=ready`、`cloneStatus=done`，故事分支 `story/v202605_ui_CARB_13955` 中确认原失败深层 Kotlin 文件存在。后端源码准备/远程代次/恢复/故事初始化/worktree 相关矩阵 75/75、Web pretest 15/15、完整 Web 333/333 通过；Vite release 构建完成 683 个模块。验收数据库副本和临时 clone/worktree 已移入回收站，真实故事点状态未修改。
- 独立验收：全新上下文 Agent 仅依据交接包、完整白名单差异与原始现场证据，独立复跑 Gateway 必跑矩阵 75/75、Web 完整测试 333/333、683 模块生产构建、Gateway 语法与 `git diff --check`，并核对稳定 SourceCache 分支/HEAD/工作区及深层 Kotlin 文件，结论 `PASS`。该 Agent 未修改源码、索引或服务；另独立复现未改动的 Controller 套件 28/36、8 个失败，确认其失败范围不引用本次 SourceCache/进度改动，继续作为独立基线缺陷记录。
- 残余风险：真实 CARB-13955 仍保持原失败状态，需要部署/重启包含本修复的 Gateway 与 Web 后由用户点击“重试初始化”；本次未改写真实用户数据。额外运行未改动的 Controller exact-SHA `story-repository.test.mjs` 时 28/36 通过，剩余 8 个为 accepted-SHA/独立仓清理既有断言及一个 delta-pack base object 读取失败，不属于 SourceCache 路径，但在其基线修复前不能据此宣称完整 Controller 套件通过。Vite 仍有既有大 chunk 警告；本次 app-mock 验收没有浏览器截图。

## REG-20260805-SERVICE-CONTROL-027：Node 升级后 Service Control 启动 Gateway 因 SQLite 原生 ABI 不匹配退出

- 复现：Gateway 已声明并由系统 Node `24.14.1` 启动，但现有 `gateway/node_modules/better-sqlite3/build/Release/better_sqlite3.node` 仍由 Node 22 构建。Service Control 点击 Start 后，Gateway 在 `gateway/db/sqlite.js` 创建数据库时以 code 1 退出；完整 stderr 明确记录模块 ABI 为 `127`、当前 Node 要求 ABI `137` 和 `ERR_DLOPEN_FAILED`。
- 根因：Service Control 的依赖完整性检查只判断 `node_modules` 和包目录是否存在，Node 切换后不会验证原生二进制是否能由本次选中的 Node 加载；发布准备又直接复制源码 Gateway 的 `node_modules`，缺少复制前后原生绑定门禁。因此同一份已存在但 ABI 过期的依赖会同时绕过源码启动和打包检查。
- 行为合同：
  - 每次真正拉起 Gateway 前，必须使用本次即将启动 Gateway 的同一个 Node 执行内存 SQLite 探针，实际构造数据库、执行查询并关闭，不能以目录存在或只 `require` JavaScript 包装层代替原生加载。
  - 源码模式若命中 `NODE_MODULE_VERSION`、`ERR_DLOPEN_FAILED` 等可修复的绑定错误，Service Control 自动使用选定 Node 对应的 npm 执行一次 `npm rebuild better-sqlite3`，然后重新探测；二次仍失败则停止启动并保留明确诊断。安装包模式不得现场改写随包资源，探测失败时直接失败关闭。
  - Service Control 打包必须在删除上一份可用 `gateway-bundled` 前验证源码 Gateway 绑定，并在复制完成后再次验证目标绑定；任一探针失败都不得继续生成看似成功但无法启动的安装包。
- 自动化守卫：`service-control-electron/gateway-native-runtime.cjs`、`service-control-electron/scripts/gateway-native-runtime.test.js` 和 `service-control-electron/scripts/prepare-gateway.test.js`，覆盖 ABI 127/137 首次失败后自愈、重建后仍失败关闭、打包拒绝错误 ABI，以及拒绝时保留上一份 bundle。
- 修复版本：2026-08-05 工作区修复，尚未提交版本号。
- 当前验证：修复前使用 Node `24.14.1 / ABI 137` 真实导入当前 Gateway 稳定复现 ABI 127 加载失败；重建后同一 Node 成功创建内存库并查询 SQLite `3.51.3`，`gateway/db/sqlite.js` 完整导入成功。重新加载 Service Control 后由面板真实点击 Start，Production 显示 `Running in background`，Gateway PID 1692 监听 3001、Web PID 7292 监听 3000，Gateway `/api/health` 返回 `status=ok / version=2.5.7`、Web 返回 HTTP 200，最新 Gateway/Web stderr 均为 0 字节。Service Control 测试 6/6 和相关语法检查通过；`npm run dist:win` 完成 683 模块 Web 构建、Gateway/Node/资源准备、Electron 打包和 NSIS 安装包生成。最终 `win-unpacked` 内 Node 为 `24.14.1 / ABI 137`，其对最终资源目录内 `better-sqlite3` 的真实内存库查询成功，`app.asar` 也包含启动守卫模块。
- 独立验收：全新上下文 Agent `/root/service_control_sqlite_acceptance` 仅依据交接包、变更白名单与原始证据，独立复跑 Service Control 6/6、相关语法和差异检查，复查修复前后日志、当前 3000/3001 HTTP/PID/命令，并使用最终随包 Node 对最终 Gateway 创建、查询、关闭内存 SQLite；同时核对 `runtime.json`、`app.asar` 和 NSIS 产物。SQLite 故事范围结论为 `PASS`；完整 Windows 打包启动因后续缺失 PerformanceFeature 配置资源保持 `PARTIAL`。该 Agent 未修改源码、配置、索引或服务，也未生成持久验收文件。
- 残余风险：Electron 调试协议下截图操作两次超时，故本条不把截图列为证据；状态证据来自 DOM、进程、端口、HTTP 和原始日志。最终安装包的额外整包启动已越过 SQLite 初始化，但随后因发布资源缺少 `features/PerformanceFeature/performance-test-scripts/tasks/android/appmarket-cpu-memory/config/appmarket_flow_config.json` 退出；这是另一项既有打包完整性缺口，不能将本次 SQLite 原生绑定通过扩写为完整安装包端到端 PASS。安装包未签名，Vite 仍有既有大 chunk 警告。

## REG-20260805-DEVBENCH-027：故事点实时信息不显示——HTTP 免认证但 WS 强制鉴权导致本机浏览器收不到 chat_stream

- 现象：故事点网页聊天窗口不显示任何模型的实时信息（发送后直到最终回答出现，对话区一直空白），最终回答可见（HTTP 轮询/刷新拉到落库消息）。用户环境 deepseek 任务实际执行成功（网关日志 `DeepSeek 以纯文本结束 (30 次工具调用)`），后端 WS 广播链路经真实 deepseek API 验证正常（`status/thinking/tool_use/text` 全部广播、sessionId 正确）。
- 根因：网关 HTTP 业务路由（`/api/devbench` 等）对本机/受信来源请求免认证（requireDevbenchAuth 的 NODE_ENV=test/development 豁免或 M2M 信任），而 WS 通道（`/ws`，承载 `chat_stream`/`chat_stream_end` 等实时事件）在生产模式（NODE_ENV 非 test/development）强制要求有效 `aiefficiency.auth.<token>`。本机浏览器通过 vite dev server（localhost:3000 → proxy → 3001）访问时若 localStorage 无有效 admin token，握手后即被 `close(1008, "websocket authentication required")` 拒绝 → `chat_stream` 无法到达前端。前端 `onclose → connect` 持续重连但每次都被拒。该问题影响所有模型（与引擎无关），deepseek 只是用户当前使用的引擎。
- 行为合同：
  - WS 本机信任边界与 HTTP 一致：回环来源（127.0.0.1/::1）+ 本机 Origin（localhost/127.0.0.1/::1）或无 Origin（桌面版 file://、本机工具）→ 允许免认证建立实时通道；
  - 回环来源 + 非本机 Origin（恶意网页）→ 拒绝；非回环来源（LAN/远程）→ 一律要求认证（既有安全边界不变）；
  - 前端订阅不再依赖 WS 就绪与 tabs 刷新时序：activeId 切换时强制补订阅当前故事点 session，避免漏订阅被服务端会话过滤。
- 自动化守卫：
  - `gateway/test/ws-local-trust.test.mjs`（本机信任判定正反 6 例）
  - `gateway/test/devbench-deepseek-live.integration.test.mjs`（devbench sendTurn → agent-runner → executeApiEngine(deepseek) 完整链路：WS `chat_stream` 广播 + liveDraft 持久化 + 最终消息落库）
  - 既有 `gateway/test/api-engine.test.mjs`（API 引擎流式/onStream/chat_stream_end）
- 修复版本：2026-08-05 工作区修复，尚未提交版本号。
- 验收范围：修复后需在 NODE_ENV 非 test/development 的网关（如 Electron Service Control 启动）上，用本机浏览器打开 devbench 页面，确认发送消息后 `chat_stream` 实时到达（LiveBubble 出现、思考/工具/正文实时滚动），LAN 访问仍要求 token。本机验证通过：真实 deepseek API 跑通 executeApiEngine 后 WS 事件完整（thinking×41/text×35/status×3/tool_use×1 + chat_stream_end）；CDP 复现了无 token 浏览器 WS 被 1008 拒绝、修复逻辑判定本机回环+localhost Origin 放行。
- 残余风险：vite dev server（host: true）下 LAN 用户经本机 proxy 访问时网关看到的是 127.0.0.1 来源会被放行（与 HTTP 本机免认证口径一致，开发场景可接受）；生产云端部署仍要求 token，未变。本机信任判定基于 `req.socket.remoteAddress` 与 `Origin`，若未来网关前面再加反向代理转发需复核来源判定。

## REG-20260806-DEVBENCH-028：新建空白故事点「临时分析」无信号可输入，且不支持拖入附件

- 现象：新建空白故事点（或没有任何 TB 信号/配置）时，「临时分析」（AI 配置推理）在没有任何输入的情况下运行，推理结果 targets 为空，复核窗口显示"什么都没配置"；初始化面板/推理窗口没有任何入口可以拖入日志、截图或文档作为分析输入。
- 根因：`runStoryPanelInference` 对空白/manual 入口只构造 `{ title, ticketInput }`，无附件、无备注等任何信号；`config-inference` 启发式推理完全依赖 title/project/iteration/tag/attachment/comment/note 信号，输入为空则推理不出任何配置。初始化面板没有附件输入 UI。
- 行为合同：
  - 新建故事点初始化面板的 AI 推理区域必须支持拖入/选择/粘贴附件（文件与文件夹），文本类（≤256KB）读取前 64KB 预览随推理信号发送（附件名命中关键词映射、文本内容进入 attachment/note 信号），二进制（图片等）只保留文件名；
  - 推理信号不得包含二进制乱码：非文本文件禁止 `file.text()` 读取；
  - 用户确认创建故事点后，拖入的附件必须原样转入新故事点资料目录（archives），失败仅 toast 提示不阻断创建。
- 自动化守卫：`storyInitializationModel.test.mjs`（flavor/快照路径）+ 生产构建通过；前端附件文本判定/预览逻辑在 `StoryInitializationPanel.jsx`，由构建与人工验收覆盖。
- 修复版本：2026-08-06 工作区修复，尚未提交版本号。
- 验收范围：新建空白故事点 → 拖入日志/截图 → 运行 AI 推理 → 复核窗口信号区显示附件名与文本预览 → 确认创建 → 附件出现在故事点资料目录。残余风险：推理仍是启发式（非 LLM），附件内容对关键词未命中的配置维度贡献有限；大文件（>256KB）只取文件名。

## REG-20260806-DEVBENCH-029：故事点从备份还原丢失 Flavor 与聊天记录，且旧分支名/worktree 目录未更新

- 现象：从 `.devbench-story.zip` 还原新建故事点后：①Flavor 没有还原；②聊天记录全部丢失或部分缺失；③聊天记录/备份数据中仍引用备份机的旧分支名、旧 worktree 绝对目录，AI 后续轮次会引用失效路径。
- 根因：①前端 `flavorMapFromSnapshot` 只按 `row.path` 匹配本机工程，而后端备份快照的 `flavors` 只有可移植的 `{projectId, flavor}`（path 已在 `stripPortableTab` 剥离），projectId 解析不到 → flavorByProjectId 全空 → 创建请求不带 flavors；②`applyStoryBackupToTab` 只要存在 conversation 对象就按对话图还原，若对话图是空图（`nodes: []`）会用空图覆盖消息列表且不回退 messages，聊天记录整体丢失；③`stripPortableTab` 剥离 worktree 绝对路径后备份不再保留旧分支名/旧目录，还原后无法把消息中的旧引用更新为新值。
- 行为合同：
  - 备份快照 flavors 必须可移植（projectId 优先）还原 Flavor，主工程与关联工程 flavor 都不能丢；
  - 还原聊天记录时，对话图为空/异常必须回退到备份消息列表兜底，任何情况下不得用空对话图覆盖有内容的消息；
  - 备份必须保留旧分支名与旧 worktree 目录（`tab._legacyRefs` + `manifest.legacyRefs`）；还原后目标 worktree 就绪时把聊天记录中的旧分支名/旧目录替换为目标故事点当前值（新增 `POST /tabs/:id/apply-backup-ref-remap`），未就绪时暂存 `tab.backupLegacyRefs`，前端在 worktree 就绪后自动补齐；
  - 引用替换必须带字符边界：旧分支 `story/release_CARB_123` 不得误伤 `story/release_CARB_1234`，旧目录 `D:/worktrees/AAA` 不得误伤 `D:/worktrees/AAA2`；允许路径分隔符延续以更新旧目录下子路径前缀；长/具体条目（路径）优先于短条目（分支名）执行。
- 自动化守卫：`gateway/test/story-backup.test.mjs`（备份保留引用/快照 projectId/消息完整还原/空对话图兜底/remap 替换+边界+清除暂存，6 例）；`storyInitializationModel.test.mjs`（projectId 形式 flavors 还原 Flavor，35 例全过）；前端生产构建通过。
- 修复版本：2026-08-06 工作区修复，尚未提交版本号。
- 验收范围：跨机（或换目录）备份 → 还原 → 确认 Flavor 正确、聊天记录完整、消息中旧分支名/旧 worktree 目录已被替换为新值；worktree 尚未就绪时打开故事点后消息引用自动更新。残余风险：消息中的旧引用替换仅覆盖消息节点 content 与 aiSnapshot/actualAi 的部分路径字段，资料文件（ask/archives 文本）内的旧路径引用未做批量替换；worktree 未 provision 成功的故事点无法完成路径替换（需先修复工作区）。

## REG-20260806-DEVBENCH-030：Amend 本地改动 / Git 提交整理把业务单号分支名递增拆号

- 现象：故事点「Amend 本地改动」与「Git 提交整理」推导新分支名时，对 `XXX/xxx_CARB_14189` 这类业务单号分支：Amend 生成 `XXX/xxx_CARB_14190`（单号数字被递增）、提交整理首次生成 `XXX/xxx_CARB_141891`（数字被吞并），破坏了 `CARB_14189` 整体单号语义，导致 MR/评审记录对不上原单号。
- 根因：分支名「末尾 +1」逻辑（后端 `nextBranchSuffix` 与前端 `GitAmendPanel.branchPreview` 副本）对末尾任意连续数字做 +1，未识别 `_CARB_<数字>` 是整体单号；Git 提交整理首次命名（`deriveReworkBranchName`）直接 `curBranch + "1"` 追加，同样破坏单号。
- 行为合同：
  - `…_CARB_14189` → 新分支 `…_CARB_14189_1`（首次追加修正序号，单号整体保持）；`…_CARB_14189_1` → `…_CARB_14189_2`（再次时只递增修正序号）；
  - 普通分支保持原语义：末尾数字 +1（保留前导零，时间戳类 `_08051624471 → _08051624472`）、无数字尾号追加 `1`；
  - 前端预览（`GitAmendPanel`）与后端 `nextBranchSuffix` 必须一致。
- 自动化守卫：`gateway/test/amend-branch-naming.test.mjs`（5 例：CARB 首次追加 `_1`、序号递增、大小写不敏感、普通分支原行为、普通数字尾号 +1）；`nextBranchSuffix`/`isBusinessTicketBranch` 收敛到 `gateway/services/devbench/branch-naming.js` 单一来源。
- 修复版本：2026-08-06 工作区修复，尚未提交版本号。
- 验收范围：对 `story/*_CARB_<单号>` 分支依次执行 Amend 与 Git 提交整理，确认新分支为 `…_CARB_<单号>_1`、再次为 `…_CARB_<单号>_2`；对无单号分支确认原行为不变。残余风险：仅识别 `_CARB_<数字>` 单号模式（devbench 实际分支约定），其它业务单号前缀（如 `_JIRA-`、`_BUG-`）仍按普通数字尾号递增，如需支持可按同样模式扩展 `isBusinessTicketBranch`。

## REG-20260806-DEVBENCH-031：重新打开已关闭故事点强制弹 AI 推理复核窗口

- 现象：AI 推理开关开启时，从历史列表/任务/TB 重新打开已关闭的故事点，会先弹「AI 推理」复核窗口、要求人工确认工程配置后才恢复；重开只是恢复历史现场，重复推理毫无收益且打断流程。
- 根因：`reopenClosed`（前端）在 AI 推理开启时先 `requestConfigInference` 弹复核窗，确认后才调用 reopen API；后端 `/tabs/reopen-closed` 对 AI 开启且未提交 `projectId`+`configInferenceRunId` 的请求一律 409 `STORY_REOPEN_AI_REVIEW_REQUIRED`，把推理复核变成重开强制门禁。
- 行为合同：
  - 重新打开已关闭故事点直接用已存配置恢复，不再触发/弹 AI 推理复核窗口（前端 `reopenClosed` 直接 `reopenClosedNow`）；
  - 后端 reopen 不强制要求推理复核：未携带 runId 直接正常恢复；仍携带已复核 runId 的调用（兼容旧流程/防御旧 in-flight 请求）保留同故事、同 owner、未过期校验并应用；
  - 新建/复制故事点的 AI 推理流程不变（仅重开跳过）。
- 自动化守卫：`gateway/test/story-reopen-review.integration.test.mjs`（更新：AI 开启直开 200 且不带 configInferenceRunId；携带 runId 时跨故事/跨 owner/过期/未复核仍拒绝；幂等重放、AI 关闭直开均通过）；`story-reopen-review.test.mjs` 服务单元测试 3 例保留。
- 修复版本：2026-08-06 工作区修复，尚未提交版本号。
- 验收范围：开启 AI 推理 → 关闭一个故事点 → 从历史列表重新打开 → 确认直接恢复、无推理弹窗、聊天记录/配置正常；任务「再次开发」与 TB 已关联切换场景同样不弹窗。残余风险：`storyEntryInferenceModel` 中 reopen 相关 defer/证明路径成为防御性死代码（不触发但保留）；后端集成测试顺带修复了存量 401（production 下无 token 被 auth 拒绝，测试改为携带 owner token）。

## REG-20260807-SERVICE-CONTROL-032：产物快照 fsync/目录扫描仍同步阻塞事件循环致健康检查降级与 HTTP 500

- 复现：REG-20260804-SERVICE-CONTROL-024 已把 ACL 探测改为异步并抑制首次 HTTP miss 误降级，但在故事点聊天中批量加载带 `storydev:/...` 引用的大体积产物（视频/截图/日志，100MB–1GB）时，控制面板仍频繁报 `HTTP health check is temporarily unavailable for gateway; owned processes are still running.`（phase=degraded），前端同时出现 HTTP 500。无产物负载时健康探测 121/121 成功。
- 根因：产物快照创建链路仍残留两类同步阻塞：① `createSnapshot` 在 `pipeline` 异步复制完成后调用 `fs.fsyncSync(destinationFd)` 同步刷盘，大文件在 Windows 上可阻塞事件循环数秒；② `scanAndCollect` 用 `fs.opendirSync` + `directory.readSync()` + `fs.lstatSync` 逐条同步遍历整个快照目录（每次 createSnapshot 都会调用，O(n) 同步 I/O）。两者叠加使 Gateway 事件循环在批量签发票据期间被冻结，`/api/health` 连续两次 2.5s 超时 -> degraded；在途业务请求也因事件循环冻结超时 -> 前端 HTTP 500。此外 `verifyOpenedSnapshot` 在每个 GET/Range 请求上重新哈希整个不可变快照文件，视频流式播放的几十次 Range 请求重复全量哈希，加剧磁盘争用。
- 行为合同：
  - 产物快照创建/扫描/删除路径不得使用 `fs.fsyncSync`、`opendirSync`+`readSync` 或任何同步子进程；`fsyncDirectory` 改为 `fs.promises.open` + `handle.sync()`，`createSnapshot` 改为 `await fsyncAsync(destinationFd)`（`promisify(fs.fsync)`），`scanAndCollect` 改为 `fs.promises.opendir` + `for await` + `fs.promises.lstat`。
  - 快照创建、打开、Range/HEAD、容量限制、过期回收和删除仍保持原安全合同（不可变、单链接、O_NOFOLLOW、ACL allowlist 失败关闭）；扫描期间条目被并发删除返回 ENOENT 时跳过而非抛错。
  - `verifyOpenedSnapshot` 对同一不可变快照（按文件身份 size/mtimeNanos/ctimeNanos/dev/ino + 期望 sha256 组合键）只做一次全量哈希，后续 GET/Range 命中进程内缓存时仅做 fstat 前后一致性校验；缓存上限 1024 条 FIFO 淘汰。
- 自动化守卫：`gateway/test/artifact-ticket.test.mjs` 在原有"无同步子进程"断言基础上增加 `fs.fsyncSync`/`readSync()`/`opendirSync` 源码合同禁止，并新增"重复验证命中缓存不重新全量哈希"用例；`story-artifact-ticket.integration.test.mjs` 的 Range 重复请求用例继续覆盖端到端正确性。
- 修复版本：2026-08-07 工作区修复，尚未提交版本号。
- 当前验证：修复前源码含 `fs.fsyncSync`、`opendirSync`+`readSync()` 同步调用；修复后源码合同断言全部通过，产物票据 6/6、票据路由集成 5/5、故事存储/上传/Range 12/12、Service Control 运行健康 13/13、devbench 产物路径 42/42 通过。缓存命中测试验证同一 4MiB 快照第二次 verify 不再触发全量哈希（缓存大小不变）。
- 残余风险：`fs.fstatSync`/`fs.openSync`/`fs.linkSync` 等单次元数据同步调用仍保留（每次 <1ms，非批量瓶颈）；异步 fsync 仍受磁盘性能影响但不冻结事件循环。验证缓存基于不可变快照身份，inode 复用不会误命中（缓存键含 size/mtime/ctime/sha256）。工作区另有 `devbench.js`/`worktree-manager.js` 的 AI lease 残留清理改动与本条无关，未纳入本次修复。

## REG-20260807-SERVICE-CONTROL-033：devbench 对话/草稿大文件同步读写冻结事件循环致健康检查降级与 HTTP 500（MiniMax-M3 长对话）

- 复现：故事点「埋点推广到所有车型」使用 MiniMax-M3（claude-minimax / codex-minimax，思考流超长）运行时，Service Control 频繁报「运行健康检查异常：HTTP health check is temporarily unavailable for gateway; owned processes are still running.」，前端同时出现 HTTP 500。真实对话文件实测 msg-<tab>.json 达 25.9MB、conversation-v2.json 达 27.1MB（MiniMax 单轮 transcript 16341 条/7.5MB）。
- 根因：devbench 对话持久化存在两类同步阻塞，随 MiniMax 长思考流放大后冻结 gateway 事件循环：
  1) `writeConversationFilesAtomic` 每次消息变更都 `writeFileSync` 全量写两个大文件（还带 tmp/backup/rename/rm 多副本），单次 27MB+27MB 同步 I/O 约 1.5–2.5s；`readConversationState` 每次 `readFileSync` + `JSON.parse` 两个大文件（约 200ms+）再加 `normalizeConversation` 深拷贝；
  2) live draft（`saveLiveDraft`）每 120ms 节流 `writeFileSync` 全量写，而 `liveDraft.thinking += value` 无上限，MiniMax 思考流一轮可达数 MB，持续拖拽事件循环。
  二者叠加使 Service Control `/api/health` 2.5s 探针连续 miss → phase=degraded → 前端业务请求超时 → HTTP 500。
- 行为共识：
  - 任何持久化路径不得因大对象/大文件产生秒级同步 I/O；运行轨迹（transcript）是过程性数据，必须限制单节点体积，不能随对话无限膨胀（实测 27.3MB 压缩到约 0.89MB，压缩率 96.7%）；
  - 同一 tab 的对话读取应优先内存缓存（statKey = mtimeMs:size 校验，跨进程共享时自动失效重读）；
  - 流式草稿（live draft）的 thinking/text/tools 必须封顶，保留尾部最新内容（刷新恢复展示最新即可）。
- 自动测试：`gateway/test/devbench-store-async-write.test.mjs`（5 项：超长 transcript 保头保尾截断+标记、小 transcript 单条裁剪、模拟 MiniMax 长对话大文件 append 后体积<4MB 且压缩率>50%、读写一致性、live draft 落盘与清理）。相关既有测试 212/212 通过（store/conversation-backup/conversation-model/prompt-mode/archive-live/closed-story-purge/story-backup）。
- 修复版本：2026-08-07 本地修改，未提交版本号。
- 当前验证：真实 27.14MB conversation + 25.92MB msg 文件：首次 getMessages（读+normalize）约 1.2s（一次性，旧文件首次读取），appendMessage（读缓存+compact+写盘）351ms，append 后文件 0.89MB（96.7% 压缩），8/21 节点标记 transcriptTruncated；新消息正确落盘。网关相关回归 212/212 通过。
- 残余风险：升级部署后旧大文件首次读取/响应仍有一次性 1s 级成本（本次读后即被 compact 缩小）；transcript 仅保留首尾（中间轨迹丢弃，`transcriptTruncated/transcriptTotal` 标记），如需完整轨迹可后续做 transcript 独立文件 + 按需加载。

## REG-20260807-DEVBENCH-034：Git 提交整理 squash 冲突时临时 worktree 与上下文落 C 盘，且冲突卡片无 IDE 打开入口

- 复现：在 Windows 用户上触发「Git 提交整理 → 冲突」分支（开发分支含 squash merge 冲突），保留的临时 worktree 写到 `os.tmpdir()`，即 `C:\Users\<user>\AppData\Local\Temp\aieff-rework-<id>-<ts>-<rand>\`；冲突解决上下文也写在同目录的 `aieff-rework-ctx-...json`。用户必须手抄路径到 IDE，冲突卡片只显示纯文本路径，缺少一键打开入口；同时 `req.body.tmpDir` 在 `/resume` 与 `/abort` 里被原样回传给 `git worktree remove --force` + `rmSync({recursive:true,force:true})`，任何客户端可借此写任意路径。
- 根因：临时 worktree 与上下文文件早期实现选择 `os.tmpdir()` 是出于"独立于工程目录"的小代价，但 `os.tmpdir()` 在 Windows 默认落 C 盘，整份 Android 源码在工作流期间要进系统盘 + 跨盘读 IDE；冲突卡片也未挂 AS 控件。前端 `tmpDir` 入参缺校验，链路任一节点被劫持即可 `git worktree remove` 任意目录。
- 行为合同：
  - 临时 worktree 必须落在"已配置的 worktree 父目录"下：`<store.ensureCloneParentReady()>/<WORKTREE_SPACE_DIRNAME>/_rework-<tab8>-<时间戳>-<随机>`，与故事点 worktree 同级、共用同一根的清理/迁移策略；
  - 上下文文件 `<dirname(tmpDir)>/<basename(tmpDir)>.ctx.json` 与临时 worktree 同级（不放 worktree 内，避免污染 `git status` 校验；不放 `os.tmpdir()`，跨盘问题回归）；
  - `tmpDir` 的派生必须放在 `git stash push` 之前执行，避免 base 解析失败把专用 stash 留在仓库里；
  - 升级前遗留在 `os.tmpdir()/aieff-rework-*` 的会话仍必须可读/可清理（向后兼容），通过 `LEGACY_REWORK_WORKTREE_PREFIX` + `legacyReworkContextFile` 实现；
  - `/tabs/:id/git/commit-reorganize/{resume,abort}` 必须用 `resolveReworkWorktreePath` 校验 tmpDir，仅允许在受控 worktree 父目录内，或旧版 `os.tmpdir()/aieff-rework-*`；其他任意路径一律拒绝（避免 `git worktree remove --force` / `rmSync(recursive)` 被恶意指向工程目录或系统目录）；
  - 冲突卡片必须提供「Android Studio 打开」入口（复用 `StudioBtn` compact），`failDetail.tmpDir` 失败保留场景也需 AS 入口方便排查。
- 自动化守卫：
  - `gateway/test/devbench-rework-conflict.test.mjs` 新增 3 项：① `reworkWorktreeBase` 用 `ensureCloneParentReady() + WORKTREE_SPACE_DIRNAME` 拼目录；② `resumeReworkWorkflow`/`abortReworkWorktree` 必须先 `resolveReworkWorktreePath` 校验并支持 `LEGACY_REWORK_WORKTREE_PREFIX`；③ `reworkContextFile` 用 `path.dirname/basename` 拼 `.ctx.json`，`readReworkContext`/`deleteReworkContext` 同时兼顾 legacy 路径；并反向断言 `reworkBranchWorkflow` 主流程不再 `path.join(os.tmpdir(), \`aieff-rework-...\`)`；
  - `gateway/test/devbench-rework-conflict-frontend.test.mjs` 新增 3 项：`import StudioBtn` 存在、冲突 needDecision 卡片渲染 `<StudioBtn path={decision.tmpDir} onToast={onToast} compact />`、`failDetail.tmpDir` 渲染 `<StudioBtn path={failDetail.tmpDir} onToast={onToast} compact />`；
  - `gateway/scripts/run-tests.mjs rework` 全绿（3 个文件：`devbench-rework-conflict.test.mjs` 11/11、`devbench-rework-conflict-frontend.test.mjs` 3/3、`devbench-rework-merge-check.test.mjs` 既有）。
- 修复版本：2026-08-07 本地修改，提交版本号随 feat commit（待提交）。
- 当前验证：源码契约测试 14/14 通过；冲突卡片在保留 worktree 场景直接渲染 AS 按钮，复用 `StudioBtn`（多版本下拉 + 记忆选择），与 `GitUpdateBar` 的 git-update 冲突处置 UX 一致。
- 残余风险：`store.ensureCloneParentReady()` 失败时（克隆父路径未配置）会直接 4xx 返回——这是预期的「未配置就拒收」，但若用户从未走过「新建故事点 → 工程就绪」流程而直接触发整理，需提示先去「故事点配置」设置克隆父路径；当前没有专门的引导文案（建议下一步在 Web 端空仓库提示里追加一行）。旧版 `os.tmpdir()/aieff-rework-*` 兼容读取仅兜底既有会话，不会主动清理；如要清盘需用户手工 `rm` 或等待下一次 git 更新流程触发删除。

## REG-20260807-GITDEV-002：Git 提交整理/Amend 升级为不可变快照 + Detached Worktree + ls-remote 校验

- 复现（升级前缺陷）：旧实现存在 6 个结构性风险：① squash 使用分支名 `cur` 而非固定 SHA（分支在操作期间可移动）；② `worktree add -b` 在 Worktree 创建时就建立正式分支（后续校验失败时遗留）；③ Push 后用 `fetch + rev-parse origin/<branch>` 校验（走本地 remote-tracking 引用，可能过时）；④ `delete-remote-branch` 不校验 expectedOldRemoteSha（可删到别人的提交）；⑤ `amendNewBranchWorkflow` 无 commit count 校验 + 无提示 `git add -A` + 直接 `switch -c` 切用户工作区；⑥ include 模式用 stash（修改真实 Worktree）。
- 根因：原始实现是增量演进，各安全检查逐步添加但未统一到不可变快照模型，分支名/Index/Worktree 在操作期间仍可被外部或用户修改。
- 行为合同：
  - 操作开始后固定 SOURCE_HEAD_SHA / TARGET_SHA / OLD_REMOTE_SHA / SOURCE_SNAPSHOT_SHA / RESULT_SHA，创建内部引用 `refs/ai-restructure/<operationId>/source|target|result`；后续 Squash / Diff / Commit 禁止使用可能移动的分支名。
  - Worktree 用 `--detach` 创建（不建正式分支），全部校验通过后才用 `update-ref` + zero SHA 原子创建 `refs/heads/<NEW_BRANCH>`（已存在且 SHA 不同则拒绝覆盖）。
  - Squash 使用 `sourceSnapshotRef`（固定 SHA），禁止用分支名。
  - include 模式用临时 Index（`GIT_INDEX_FILE` + `read-tree` + `git add` + `write-tree` + `commit-tree`）生成虚拟 Source Snapshot Commit，不修改真实 Index/Worktree；快照前后验证 `git status` 不变。
  - Push 前重新 `fetch --prune origin` + `ls-remote --heads origin refs/heads/<target>` 校验 Target SHA（不走本地 remote-tracking 引用）；Target 变化时返回 `TARGET_CHANGED` 并提供重新生成。
  - Push 只允许普通 Push（禁 `--force` / `--force-with-lease` / `--no-verify`）；Push 后用 `ls-remote` 直接校验远程 SHA = RESULT_SHA。
  - `delete-remote-branch` 携带并校验 expectedOldRemoteSha / expectedNewRemoteSha；旧远程 SHA 变化时拒绝删除；旧远程不存在时返回「不适用」。
  - `amendNewBranchWorkflow` 验证 SOURCE 相对 TARGET 只有一个 Commit（不满足引导使用完整重整）；使用隔离 Worktree（不切用户工作区）；创建 backup ref；禁止无提示 `git add -A`（通过临时 Index 快照纳入 dirty 改动）。
  - Commit 前记录 `VALIDATED_TREE_SHA`（`write-tree`），Commit 后验证 `HEAD^{tree}` = VALIDATED_TREE_SHA。
- 自动化守卫：
  - `gateway/test/devbench-rework-snapshot.test.mjs` 新增 26 项测试：源码契约 9 项（不可变快照模型、--detach、squash 用 ref、Tree 验证、ls-remote、原子建分支、delete SHA 校验、Amend commit count、include 不 stash）+ Git 行为集成 17 项（多 Commit 重整、Merge Commit 消除、临时 Index 不改 Worktree、原子建分支拒绝/成功、ls-remote 查询、Push 后 SHA 校验、敏感文件阻断、Tree 不一致检出、Detached Worktree 无正式分支、旧远程被更新拒绝删除、原远程不存在、Amend 多/单 Commit、内部引用创建清理、Source 新增 Commit 快照不变、Stash 恢复失败保留 OID）。
  - 既有 `devbench-rework-conflict.test.mjs` 11/11、`devbench-rework-merge-check.test.mjs` 3/3、`devbench-rework-conflict-frontend.test.mjs` 3/3 全部仍通过。
- 修复版本：2026-08-07 本地修改，提交版本号随 feat commit（待提交）。
- 当前验证：全部 40 项测试通过（14 既有 + 26 新增）；`node -c routes/devbench.js` 语法检查通过。
- 残余风险：① Gateway 重启后恢复（测试 16）目前仅通过快照 ref 持久化间接覆盖（refs 在 .git 目录中持久存在），但未实现专门的恢复端点；② Android 构建后 Tree 被修改的场景（测试 18）已覆盖 Tree SHA 不一致检出，但实际构建命令需用户配置 `validationCommand`；③ `amendNewBranchWorkflow` 在多 Commit 场景返回错误引导用户使用完整重整，但未自动切换；④ 前端 `GitAmendPanel` 和 `GitCommitReworkPanel` 已更新传递 expected SHA，但旧版本前端缓存可能不传（后端兼容：不传 expected SHA 时不做 SHA 校验，仅做存在性检查）。

## REG-20260807-DEVBENCH-034：AI 回合真实 usage 在多请求工具轮中丢失并被描述文本估算冒充

- 现象：OpenAI-compatible API 每个流式响应虽收到 Provider `usage`，但只实时广播后即丢弃；`agent-runner` 最终固定按任务描述和输出长度估算 Token。多轮工具调用、`stream_options` 兼容重试、失败请求、实际 Prompt 长度和工具 Schema/结果字符均无法审计，`token_usage` 中也无法区分真实值与估算值。
- 根因：`api-engine.successResult` 未返回逐请求 usage 聚合；`agent-runner` 使用 `task.description` 而不是实际 `promptOverride` 估算输入；数据库仅有 input/output 两列；异常路径没有持久 telemetry，且 `chat_stream_end` 抛错时仍标记 success。
- 行为合同：实际发送的 application Prompt 必须按 Unicode code point 记录字符数与 SHA-256；API 每个 HTTP attempt、兼容重试和含 `tool_calls` 的 Provider 响应都必须记录，所有 Provider 实报 usage 跨请求累加；仅 `finish_task` 的响应也计一个 tool round，同时单独保留 tool call 数；真实值、兼容估算和不可观测失败必须分别标记为 `provider`、`estimated`、`unavailable`。`execution_succeeded` 只表示 Provider/CLI 执行是否正常收口，不表示 marker、租约、阶段门禁或 TB 同步成功；成功与异常 telemetry 均进入任务记录，异常 `chat_stream_end.success=false`。阶段推进、报告校验需重试和 TB 写回必须使用独立观测表；相同 TB 任务、写入类型和 payload hash 的既往成功写入只能标记为“重复候选”，不得冒充远端幂等确认。多 Gateway 同时打开旧库时，`journal_mode=WAL` 必须仅对 `SQLITE_BUSY/SQLITE_LOCKED` 做有界重试，不得因启动竞态随机失败，其它 WAL 错误仍立即失败关闭。
- 自动化守卫：`gateway/test/fixtures/devbench-phase2/turn-observability.fixture.json` 固化一次无副作用兼容重试 + 三个带 usage 的工具响应；`gateway/test/api-engine.test.mjs` 验证 4 attempts/3 responses/1 retry/3 tool rounds/3 tool calls 以及真实 usage 总和；`gateway/test/agent-telemetry.test.mjs` 验证 Unicode Prompt、v1/v2 字段兼容与 SQLite 聚合来源；`gateway/test/agent-telemetry.integration.test.mjs` 验证旧表数据回填、双 Gateway 并发迁移、跨 Gateway TB 重复候选、API→agent-runner→SQLite 成功/失败单写以及工作总结兼容重试/失败落库；`gateway/test/workflow-observability.test.mjs` 验证报告缺标记/阻断的需重试率、同阶段不推进、实际 TB 指纹/story 归属和重复写候选聚合；`gateway/test/devbench-prompt-mode.test.mjs` 验证 stale retry 使用独立 attempt 并保留 Prompt hash。
- 修复版本：2026-08-07 M0 实现。
- 当前验证：M0 遥测/API/报告/工作流定向测试 55/55 通过；并发迁移用例在暴露 WAL PRAGMA 偶发 `SQLITE_BUSY` 后加入启动边界有界重试，整个 integration 文件 5/5 以及该跨进程用例连续 20/20 次通过。完整 Prompt 模式回归 71/72，唯一失败是本修复前已存在的基础仓路径映射用例。fixture 实报汇总为 input 606、output 66、cache read 12、cache creation 3；该数值只证明累计口径，不代表生产 Token 节省。
- 残余风险：尚未调用真实 Provider 对照；CLI 内建 system Prompt 和 tool schema 不可见时保持 `null`，CLI 无实报 usage 时仍以 `estimated` 明示；阶段指标是本地工作流回合推进率，不等同于 TB 远端最终成功率；报告指标是“本次结果需要重试”的比例，尚未关联后续是否真的发生重试；TB 指标是本地 payload 指纹的重复候选率，附件指纹只包含文件名、大小和评论，不是内容哈希，也不构成远端幂等；数据库尚无 attempt 唯一索引和观测表清理策略，异常重复调度仍需查询侧去重且表会持续增长；完整 `devbench-prompt-mode` 基线另有一个与本修复无关的既有路径映射失败。

## REG-20260807-DEVBENCH-035：v2 工作流记录缺少可校验、可回放的外置持久化合同

- 现象：Phase2 设计包已定义 `stage-context-v2`、checkpoint、evidence manifest 和 receipt Schema，但 Gateway 运行时没有 Schema registry、独立 revision、幂等索引或故事点外置记录库；现有配置也没有默认关闭的 v2 灰度开关。若直接接入后续 Prompt/状态机，无法可靠区分重放、revision 冲突、路径越界和磁盘篡改。
- 根因：v2 Schema 只存在设计文档目录，生产包无本地 Draft 2020-12 编译入口；故事点持久化仅有会话/草稿等可覆盖 JSON，没有 canonical hash、no-overwrite publish、跨进程 story lock 和 payload/envelope 身份绑定；配置服务的嵌套对象返回为浅副本，调用方可绕过更新入口原地打开 flag。
- 行为合同：`workflowV2.featureFlags` 只允许六个白名单布尔值，仅 `=== true` 启用且全部默认关闭；M1 不得被旧 Prompt、Provider、marker、报告或状态机静态引用。四份业务 Schema 必须作为 Gateway 本地运行资源按 Draft 2020-12 与 format 校验；记录只能落在受信 tab 解析的 `storyDirectory/workflow-v2` 内。stage context 按 `(storyId, contextId, revision)` 的 contextId SHA-256 子流连续追加，checkpoint、manifest 和 receipt 使用各自独立的连续 revision；所有 envelope 先做 Schema 及跨字段 identity 校验，再按 RFC 8785/JCS UTF-16 键序生成 canonical JSON 与 SHA-256，通过同目录临时文件、fsync 和 hard-link no-replace 发布。Receipt 必须绑定 `receiptId`、`operationId`、非空 envelope 幂等键与 `action/toolName/rootId/selector/operationArgs` 复合哈希；同 key 只有身份、revision、payload 和 args 全同才回放，异参数必须冲突且永不覆盖旧记录。
- 自动化守卫：`gateway/test/workflow-v2-config.test.mjs` 覆盖默认关闭、白名单、部分嵌套更新和返回值隔离；`gateway/test/workflow-v2-schema-registry.test.mjs` 覆盖四份 Schema 与设计源字节级一致、任意 cwd 本地加载、conditional/format 与输入不变性；`gateway/test/workflow-v2-envelope-store.test.mjs` 覆盖 JCS golden、四类独立流、contextId 哈希子流、identity、gap/stale、精确幂等/冲突、两 Gateway 冷启动同写、receipt operation/args、非法 UTF-8/BOM、Schema/哈希/链篡改和旧链零引用。
- 修复版本：2026-08-07 M1 实现。
- 当前验证：M1 定向测试 19/19 通过；六份新旧配置 runner 均以 0 退出，既有 store 回归 88/88、workflow phase 7/7 通过；`ajv@8.20.0` 与 `ajv-formats@3.0.1` 为直接依赖。完整 Prompt 模式 71/72，唯一失败为 M0/M1 前已存在的基础仓路径映射用例；未宣称全量 `npm test` 通过。
- 残余风险：进程强杀可能遗留 lock/临时文件，尚无安全 stale-lock 恢复；未 fsync 目录，hard-link 在某些 SMB/网络文件系统上可能不可用；普通 SHA-256 可检测未重算的漂移，不是带密钥的真实性保护，末尾记录删除也缺少外部 head 锚点；`receiptId` 当前只保证单 story 唯一，不同 key 的 operation replay 不持久化新 alias；trusted tab 由内部调用方保证，store 未回查 tab registry。M1 只实现记录幂等，不解决“外部副作用成功、receipt 落盘前崩溃”，也未执行真实 Provider/TB/设备和目标部署文件系统验收。

## REG-20260807-DEVBENCH-036：API 预检失败被遥测误记为一次 Provider 请求

- 复现：API 引擎已启用且有 key、但在请求前因缺少 Base URL/模型、故事产物范围或工具初始化失败时，实际 `fetch` 调用为 0，`token_usage.request_attempts/request_count` 却落为 1/1。
- 根因：API 预检异常发生在请求级 telemetry 创建前；`agent-runner` 用空 telemetry 收口时，`completeAgentTurnTelemetry` 为兼容不透明 CLI 执行而无条件把新对象补成一次请求，错误套用到了 API 路径。
- 行为合同：没有请求级证据时不得虚构 Provider 请求。API 路径无 telemetry 必须保持 0 attempts/0 responses；CLI 仍可通过显式兼容选项记录一次不透明执行。无 usage 的 API 预检失败继续标记 `unavailable`、0 input/output、`execution_succeeded=false`。
- 自动化守卫：`gateway/test/agent-telemetry.test.mjs` 固化零请求与 CLI 兼容分支；`gateway/test/agent-telemetry.integration.test.mjs` 用缺 Base URL 的有效 API 配置和 fetch sentinel 验证请求前失败只落一条 0/0 失败记录，并校验任务结果 telemetry。
- 修复版本：2026-08-07 M0 验收补丁。
- 当前验证：遥测单元与集成测试 10/10，通过完整 M0 遥测/API/报告/工作流定向组 42/42；M1 隔离回归 19/19。
- 残余风险：API telemetry 仍在部分故事目录/MCP/工具预检之后创建，这些失败虽不再虚增请求，但只能由 runner 补齐通用失败 telemetry；后续若需要逐预检步骤诊断，应把 telemetry 创建提前到 `executeApiEngine` 的配置读取之后并记录结构化 preflight outcome。

## REG-20260807-DEVBENCH-037：阶段上下文重复注入历史、材料和路径且无统一字符预算

- 复现：旧 `buildTurnPrompt` 在同一轮同时拼接原始 assistant 对话、最新评论与完整 TB 评论、会话附件/material/TB 附件、工程路径和 RAG 文本；同一评论、证据或路径可重复出现，且没有跨字段总预算。低上下文模型可能把已被用户否决的历史结论重新当作事实，短报告轮也会获得与报告无关的 Git、设备和工程元数据。
- 根因：现有链路按展示文本逐段拼接，没有可信控制面与不可信证据面的结构边界；评论、附件、root/path 各用不同去重口径；上下文没有 stable ID、checkpoint/manifest 快照、Unicode 字符计数、确定性排序或 hard-limit 失败协议。
- 行为合同：M2 选择器只接受程序提供的 `story/stage/task/scope/capabilities/output` 作为可信控制面，外部内容只能按阶段白名单进入 `data`；禁止原始 assistant/history/messages/transcript 字段和带 assistant/system/tool role 的历史节点，事实记忆只来自通过 Schema 的 checkpoint。评论、证据、root 和路径分别按 `commentId`、`evidenceId`、`rootId`、`rootId + normalized relative path` 去重并稳定排序；`VERIFIED` claim 引用的 evidence 自动提升为 required，冲突 stable ID 失败关闭。预算按 canonical JSON 的 Unicode code point 计数，所有允许的 stage data 必须归入 plan/evidence/misc 之一，优先删除低相关 memory，再删除 optional evidence 元数据/条目和旧评论；required evidence 及其元数据、最新纠偏、blocker、带回执/PASS 的结构化事实和当前任务不得裁剪，保护项超过字段或 hard total 时返回 typed failure。任何因预算省略的 evidence 都必须把 coverage 降为 `PARTIAL`。REPORT_SHORT 只投影精简 reportFacts 与可信 maxChars，路径、Git、设备、附件、历史和工具均不进入上下文；REPORT_EXPERT 的 outputPath 与 verified evidence IDs 只能来自可信 output/checkpoint。按 revision 从 store 读取时必须重新绑定 story/schema/revision，且禁止 sources 叠加 manifest；相同逻辑 fixture 必须得到相同 canonical JSON 与 SHA-256。
- 自动化守卫：`gateway/test/workflow-v2-context-selector.test.mjs` 覆盖运行预算资产与设计源字节一致、任意 cwd、输入重排 hash 稳定与入参不可变、四类 stable ID 去重、required OR/VERIFIED evidence 提升、原始历史与控制面注入隔离、Unicode 计数、字段/总量超限、裁剪顺序与 coverage 降级、REPORT_SHORT 最小上下文、报告输出控制可信来源、阶段白名单、checkpoint 复合 change key 和精确 checkpoint/manifest revision 读取。
- 修复版本：2026-08-07 M2 实现。
- 当前验证：M2 选择器定向测试 16/16、M1+M2 联合测试 35/35 通过；完整旧 Prompt 模式回归 71/72，唯一失败仍是 M0/M1/M2 前已存在的基础仓路径映射用例。M2 模块保持未接入旧 Prompt/Provider/marker/状态机，`promptV2` 等六个开关仍全部默认关闭。
- 残余风险：M2 只提供 dormant selector 与精确 revision 读取，不会自行生成 checkpoint/manifest，也尚未替换旧 Prompt；实际请求接入、CLI stale-session 冻结上下文和 compatibility Prompt 属于 M3。普通 SHA-256 只提供确定性/漂移检测，不提供带密钥的真实性；reportFacts/assetManifest 的专用 Schema 与渲染门禁属于 M7；真实 Provider、TB、设备和目标部署文件系统尚未验收。

## REG-20260807-DEVBENCH-038：v2 灰度已选中但实际派发仍可回退大 Prompt、历史会话或可变附件

- 复现：打开 `workflowV2.featureFlags.promptV2` 后，异步 StageContext 可以成功生成并落盘，但同步 `sendTurn` 仍可能重新调用旧 `buildTurnPrompt`；CLI stale-session 重试会强制追加原始历史，纯客户端 legacy distributed 协议还会在冻结 Prompt 之外拼入绝对路径、远端 root 和轮间摘要。当前轮附件可通过 `imagePaths` 或可变 `storydev:/archives/**` 直接进入 Provider；设备排队、报告模式切换和结果落库竞态又可能把已准备的 context 绑定到另一轮身份或在 phase/checkpoint 结算前发送下一条队首。
- 根因：旧链把“写用户消息、构造 Prompt、创建任务、Provider session、marker 推断、phase/TB 结算、释放租约和排队出队”分散在同一个同步入口及多个异步回调中，没有一个可校验的 frozen dispatch manifest；StageContext、Prompt hash、source cursor、conversation identity、设备租约、报告模式和 Provider transport 没有在真正派发边界统一绑定。旧队列只持久化 device task/request，pre-start 释放后的 terminal requestId 也无法再次申请设备。
- 行为合同：
  - `promptV2` 默认关闭；只有稳定 story/provider 灰度命中且 stage 为 TRIAGE、REPAIR、VERIFY_EXECUTE、REPORT_SHORT 或 REPORT_EXPERT 时才走 compatibility。非法灰度配置、缺身份、已失败结算和 selected 准备/校验错误必须在 Provider 前失败关闭；未命中、group workflow 和非目标 stage 保持旧链。
  - selected 派发只使用本地运行时五份 compatibility 模板与一个通过 Schema/预算选择器的 StageContext；Prompt、context、checkpoint/manifest exact cursor、task/attempt/user、映射后输入、工程 root 摘要、live report mode、设备 assessment/lease 和 rollout 形成 deep-frozen dispatch hash。conversation 首次 append 必须原子保存相同 Prompt/遥测；stale retry 复用完全相同的 Prompt/context，不续接 CLI/remote session、不接受 realtime steer、不走 `imagePaths`。
  - 本轮普通文件附件只从活动 conversation path 和当前 message input 读取，先在 StoryDev 下发布不超过 25 MiB 的 content-addressed hard-link no-replace blob，再把 blob ref/size/SHA 绑定 dispatch 并在同步派发前复核；stable external ID 绑定不同内容、当前 folder、篡改 blob、无效 report/device/source identity 均 typed fail-closed。废弃对话分支附件不得进入 manifest；编辑重发在新节点落盘前按目标父节点的祖先链投影，旧 target/descendant 附件不得泄漏到新分支。本轮 required evidence 成为活动历史后仍保持 required，结算不得静默降为 optional。
  - compatibility 结果只接受恰好一个与冻结 stage 匹配的显式 marker；禁止自然语言补标。TRIAGE/REPAIR/VERIFY 的控制字段必须唯一且使用受控结论，VERIFY PASS 还必须提供构建、测试、设备三条分类独立、引用互异且明确成功的 Markdown evidence 行。系统先执行结构门禁，再追加 UNVERIFIED checkpoint/刷新 manifest cursor，并等待旧 `applyWorkflow` 完成，最后才清 running 状态、释放租约和出队；结算失败写持久 blocker、触发一次队首收敛且不得被 Provider failure 回调重复写 assistant。
  - persistent queue 固化 task/attempt/user 三元身份及 effective report mode；设备真正 acquired 后 VERIFY 必须重新读取设备状态。pre-start release 只轮换 terminal device requestId，同设备/同语义重试可复用 StageContext，同时 sealed dispatch 仍精确绑定本次 lease fencing 与 assessment checkedAt。确定性 pre-start/settlement 失败把精确队首持久化为 blocked，前端只允许匹配 requestId 的人工 retry/cancel；不得后台自旋或保留成无状态 pending。
  - 纯客户端 selected v2 只允许 Agent V2 协议；客户端向中心发送 frozen Prompt SHA/context，中心在调用模型前二次校验。distributed legacy 会重写 Prompt，必须返回 `WORKFLOW_V2_COMPATIBILITY_DISTRIBUTED_PROTOCOL_UNSAFE`，不得静默降级。
- 自动化守卫：`gateway/test/workflow-v2-compatibility-prompt.test.mjs`、`workflow-v2-compatibility-result-gate.test.mjs`、`workflow-v2-prompt-rollout.test.mjs`、`workflow-v2-compatibility-dispatch.test.mjs`、`workflow-v2-index-integration-gate.test.mjs`、`workflow-v2-m3-edge-regression.test.mjs` 和 `workflow-v2-send-turn.integration.test.mjs` 覆盖五阶段模板/预算、灰度、冻结派发、结果门禁、history/session/steer/image 隔离、附件快照/分支/identity、报告与设备竞态、回调/队列结算及真实 mock Provider triage→fixing；`devbench-queued-message.test.mjs` 与 `device-runtime.test.mjs` 覆盖三元身份和 terminal requestId 轮换；`agent-v2.test.mjs` 覆盖中心 Agent V2 transport。
- 修复版本：2026-08-07 M3 实现。
- 当前验证：全部 workflow-v2、持久队列与设备协调联合回归 97/97，Agent V2、M0 遥测/API/工作流观测联合回归 54/54 通过；旧 phase/观测/Prompt 回归 79/80，唯一失败仍为 M0–M3 前已存在的 provider-only 基础仓路径映射断言。真实 mock OpenAI-compatible Provider 已验证 compatibility Prompt 不含 raw assistant history、conversation metadata 与 source cursor 落盘，并在 result recorder 后由 triaging 推进 fixing；web-dashboard production build 通过，`git diff --check` 通过。
- 残余风险：六个 v2 flag 仍默认关闭，M3 只替换 compatibility Prompt 并保留旧 marker/phase/TB 行为；group workflow 暂留 legacy。阶段工具硬白名单、evidence receipt、系统 VERIFY 判定、程序化短报告、Git/ADB/Flavor 权限门禁、TB Saga 与最终删除自然语言兼容属于 M5–M10，不能由 M3 的 Prompt 声明替代。content-addressed blob 位于普通用户可写 StoryDev 目录，SHA 可检测派发前漂移但不是带密钥的真实性保护；M1 source cursor 仍没有跨 Gateway CAS。尚未完成 Claude/Codex/真实中心、真实 TB 写回和真机对照，也未执行 20 个历史 fixture 的 Provider A/B 扩灰；因此保持 flag 默认关闭，不宣称可以扩大生产灰度。旧 Prompt 基线另有一个既有路径映射失败。

## REG-20260807-DEVBENCH-039：structured result 可由畸形输出、错绑回执或原始 JSON 旁路推进与泄漏

- 复现：M3 compatibility Prompt 仍依赖 Markdown marker，API/CLI 没有冻结的结果 Schema/终止协议。M4 初版接线中，空 manifest、空 evidence/claims 的 `CLIENT_ISSUE` 仍可返回 `triage_is_bug`；旧 context 的 PASS EDIT/TEST receipt 只要 action 相同即可错绑到新路径和检查；完整 `structuredResult` 还会写入通用 `tasks.result` 并由任务 list/detail API 返回。高风险 TRIAGE/REPAIR 即使声明 `DIAGNOSE_PLAN/LOCAL_GATE`，复用旧事件也会跳过诊断计划或独立评审。
- 根因：Provider 只有宽松文本收口；五份 result Schema 缺统一幂等身份，receipt selector 未与冻结 context/path/check/case 对账；结果 gate 只验枚举和少量字段，忽略分类、风险与 `nextStage` 的语义矩阵；`agent-runner` 把内存执行结果原样序列化到任务表；VERIFY/renderer/PDF gate 接口只读 status，未绑定 story/context/result hash。
- 行为合同：API structured 回合只暴露业务工具和唯一动态 `finish_stage`，参数必须是 exact stage Schema；普通文本、fence、非 object、多终态、缺终态和终态混合工具全部 typed fail-closed。CLI 只接受单一 JSON object，禁止前后缀/fence/数组/文本兜底；两种 transport 均冻结 schema/context/revision/idempotencyKey、禁止 session/history/image/streaming 旁路。结果先按本地 registry 与冻结 dispatch 校验，再验证语义与 receipt，追加 story-wide immutable stage-result，最后才适配安全旧事件、推进旧状态机并展示；raw JSON 不得进入 liveDraft、conversation、archive、WS 或通用 task API。
- 证据与状态门禁：TRIAGE 结论必须有至少两种 manifest evidence type 的当前 context PASS read receipt、完整 rootCause 和由至少两项已读证据支撑的 SUPPORTED claim；分类、冻结风险和 nextStage 必须一致。REPAIR 的 EDIT receipt 精确绑定 context/rootId/path，BUILD/TEST receipt 精确绑定 context/check name；VERIFY receipt 绑定 context/caseId，并完整覆盖 evidenceRefs。所有 receipt 全局唯一且 status/action/evidence/hash 必须匹配。系统 VERIFY、renderer、PDF gate 必须递归冻结，并绑定 storyId/contextId/revision/resultSha256，以及 planId/htmlRef。旧状态机不能表达的 HIGH/CRITICAL 诊断/独立评审路由必须阻断，不得降级到 fixing/verifying。
- 自动化守卫：`workflow-v2-structured-prompt.test.mjs`、`workflow-v2-structured-runner.test.mjs`、`api-engine.test.mjs` 覆盖模板/Schema/finish_stage/CLI JSON 与 transport 漂移；`workflow-v2-structured-result-gate.test.mjs` 覆盖空证据、两类证据 quorum、transition/risk、跨 context receipt、root/path/check/case/hash、完整 evidence coverage 和系统 gate identity；`workflow-v2-structured-result-store.test.mjs` 与 envelope tests 覆盖 immutable replay/conflict/tamper；`workflow-v2-index-integration-gate.test.mjs` 与 `workflow-v2-structured-send-turn.integration.test.mjs` 覆盖三轨开关、结算先于展示、task API 脱敏，以及真实 mock API 的正向、malformed 和 missing-receipt 三场景。
- 修复版本：2026-08-07 M4 实现。
- 当前验证：全部 workflow-v2、API engine 与 telemetry 联合回归 145/145 通过；真实 structured sendTurn mock 的成功、畸形 finish_stage、缺 receipt 三场景通过，正向结果进入 immutable record 并安全推进，畸形/缺证据不推进且 raw sentinel 不出聊天/任务 API。Phase2 包在隔离副本中通过 29 个 JSON/36 个 acceptance case 校验。旧 phase/Prompt/观测回归 79/80，唯一失败仍是 M0–M4 前已存在的 provider-only 基础仓路径映射断言。
- 残余风险：`structuredResultsV2` 仍必须默认关闭；M5 尚未把 StageContext capabilities 变成 API/CLI 执行层工具白名单，M6 尚未接生产 receipt 生成与可信 VERIFY 系统 gate，M7 尚未接 renderer/PDF gate，M9 尚未替换旧 TB 写入为 Saga。当前启用 structured 全流程会在无生产 receipt 的 TRIAGE、VERIFY 或 EXPERT 报告处安全阻断；group 与 HIGH/CRITICAL 路由继续等待目标状态机，不会用旧事件绕过。未完成真实外部 Provider、TB、设备与专家 PDF 端到端验收。

## REG-20260807-DEVBENCH-040：provider-only 路径映射测试的存在性与物理路径桩不一致

- 复现：运行 `gateway/test/devbench-prompt-mode.test.mjs` 时，`provider-only TB and RAG context maps known base paths and redacts missing mappings` 使用不存在的 `D:\\workspace\\...` 夹具路径并把 `pathExists` 固定为 `true`，但仍让 `sanitizeStoryProviderContext` 使用真实文件系统 `realPath`；已登记 base 的正向分支因此返回路径隔离提示，而不是映射后的 worktree 路径。
- 根因：测试只替换了存在性探针，没有同步替换物理路径探针，构造出“路径存在但无法取得真实位置”的不可能状态。生产代码把该状态视为 worktree 完整性失败并关闭，这是 REG-20260802-DEVBENCH-007 要求保留的安全行为，不是生产映射回归。
- 行为合同：路径解析测试若使用虚拟绝对路径，`pathExists` 与 `realPath` 必须描述同一虚拟文件系统；正向映射夹具可使用 identity `realPath` 表示无 junction，无法解析或越界的真实路径仍必须 fail-closed，且 provider 上下文不得泄漏原始绝对路径。
- 自动化守卫：`gateway/test/devbench-prompt-mode.test.mjs` 的 provider-only TB/RAG 用例同时注入 identity `realPath`，继续覆盖“已登记 base 映射到当前 worktree”和“缺失映射整段隔离且不泄漏原路径”。物理 junction、共享 checkout、真实路径回指基仓和解析失败由 `gateway/test/story-repository-path-resolver.test.mjs` 的专门用例继续覆盖。
- 修复版本：2026-08-07 旧链基线修复。
- 当前验证：`gateway/test/devbench-prompt-mode.test.mjs` 72/72、`gateway/test/story-repository-path-resolver.test.mjs` 49/49 通过，`git diff --check` 通过。
- 残余风险：identity `realPath` 仅适用于无 junction 的纯映射夹具，不能替代真实文件系统或重解析点测试；新增虚拟路径测试若再次只替换部分探针，仍可能产生误报。

## REG-20260808-DEVBENCH-041：Workflow V2 CLI、中心 Agent 与阶段工具权限可绕过受控执行边界

- 复现：启用 V2 灰度后，将 REPAIR 或 VERIFY_EXECUTE 分派到 CLI、中心 Agent 或 legacy distributed transport；旧链路可把模型文本、远端任务或自由命令当作阶段执行结果，再尝试推进工作流。
- 根因：阶段能力、transport 限制、Worker 隔离和真实受控执行器之间原先没有统一的派发前 fail-closed 门禁；CLI/中心路径可与本机 API receipt 路径混淆。
- 行为合同：receipt-required 阶段只允许本机 API transport；CLI、center、远端和 distributed legacy 不得产生或升级 receipt。没有已冻结、已证明 execution profile 与受限 executor 时，必须在 Provider、子进程和仓库副作用之前以 typed error 终止；模型只能选择该阶段白名单内工具/检查项。
- 自动化守卫：`gateway/test/agent-v2.test.mjs`、`gateway/test/workflow-v2-stage-tool-policy.test.mjs`、`gateway/test/workflow-v2-stage-execution-policy.integration.test.mjs`、`gateway/test/workflow-v2-receipt-transport-policy.test.mjs`、`gateway/test/workflow-v2-index-integration-gate.test.mjs`。
- 修复版本：2026-08-08 Phase2 工作区实现，尚未提交。
- 当前验证：V2 CLI/阶段策略定向回归 15/15 通过；结构化 dispatch 的 API-only 与派发前阻断路径已做自动化校验。未调用真实 Provider、中心 Agent 或 Worker。
- 独立验收：全新上下文 Agent 复跑 CLI/center/remote 边界 8/8，并在最终 Workflow V2 38 文件/336 用例中复核；本地离线范围 `PASS`。未调用真实 Provider、中心 Agent 或 Worker，生产仍为 `BLOCKED`。
- 残余风险：现有 native Worker launcher 只证明受管 Provider CLI，不是 BUILD/TEST/VERIFY 的生产受限 executor；生产正链仍保持 `WORKFLOW_V2_RECEIPT_CONFINED_EXECUTOR_UNAVAILABLE` 阻断。

## REG-20260808-DEVBENCH-042：结构化 receipt、VERIFY 证据与受控副作用可被旧结果、错 root 或未证明适配器污染

- 复现：复用旧 context 的 EDIT/BUILD/TEST/DEVICE receipt，伪造兼容文本结果，或让 BUILD/DEVICE 返回缺少绑定信息的对象；旧门禁可能仅按 action/status 接受，VERIFY 无法证明计划、root、检查项和结果属于同一冻结上下文。
- 根因：receipt 曾缺少统一的 story/context/revision/root/check/case/result-hash 绑定，Controller 返回值与最终 receipt 的绑定不足；默认进程执行和设备业务动作也不能证明实际受控副作用。
- 行为合同：structured REPAIR/VERIFY 只能使用不可变 execution profile、受控 receipt 存储和精确 selector；兼容字符串、原始 JSON 旁路、缺项或跨 context/root/check/case 的 receipt 必须阻断。BUILD 只能经 Build Controller，DEVICE_ACTION 只能经同故事点冻结 lease 的 Device Proxy；默认 runner、Build broker 或 Device adapter 缺失时返回 BLOCKED，绝不执行自由进程或设备命令；同一受控 operation 重试必须幂等、冲突 fail-closed。
- 自动化守卫：`gateway/test/workflow-v2-controlled-operation-journal.test.mjs`、`gateway/test/workflow-v2-controlled-receipt-executor.test.mjs`、`gateway/test/workflow-v2-media-receipts.test.mjs`、`gateway/test/workflow-v2-api-receipt-transport.integration.test.mjs`、`gateway/test/workflow-v2-system-verification-gate.test.mjs`、`gateway/test/workflow-v2-build-device-controller.test.mjs`、`gateway/test/workflow-v2-controller-receipt-bridge.test.mjs`、`gateway/test/workflow-v2-structured-result-gate.test.mjs`。
- 修复版本：2026-08-08 Phase2 工作区实现，尚未提交。
- 当前验证：最终 EDIT state 与 BUILD/TEST receipt 已绑定同一不可变摘要；受控 operation 使用 durable reserve/settle journal，跨 recorder/进程重试和 append fault 不重复执行，无法证明的中间态 fail-closed；六类材料 READ、PDF 页和视频关键帧 CAPTURE、产物 SHA-256 回读及 symlink/junction 零外部写回归均通过。mandatory capability 与 case action 精确对账，video/screenshot/logcat 分别要求独立内容寻址 CAPTURE 回执。`workflow-v2` 聚合回归 38/38 文件、336/336 用例通过；受控 journal 的“动作后、settlement 前崩溃”仓库根与 `gateway` cwd 回归 2/2 通过。
- 独立验收：媒体/受控 receipt 子范围先复跑 51/51 和 21/21；最终全新上下文 Agent 重放 mandatory evidence P0 后确认 gate `BLOCKED`、structured result `ok=false`、无 `verify_pass`，聚焦 42/42、完整 Workflow V2 336/336。本地离线范围 `PASS`；真实设备和生产受限 executor 未准备，生产端到端仍为 `BLOCKED`。
- 残余风险：生产默认 Build broker 和 Device business-action adapter 为空；真实 BUILD/TEST/DEVICE/CAPTURE 端到端、真实媒体文件读取和生产部署证明尚未执行。动作成功但 settlement 未落盘的进程强杀会永久停在 ambiguous，必须人工核对，绝不盲目重放。

## REG-20260808-DEVBENCH-043：/send 与 TB Saga 在多 Gateway、崩溃恢复和远端不确定写入下重复注入或错误结算

- 复现：两个 Gateway 用同一幂等键并发 `/send`，或在消息注入、队列追加、TB 评论/附件/状态写入后立即崩溃；旧实现可能重复调用 Provider/队列/TB，或把未确认远端写入错误标为完成。
- 根因：请求幂等、TB pending payload、single-owner/fencing、outbox acknowledgement 和 terminal ledger 以前不在同一持久事务内；TB 本身没有可验证的原生幂等语义。
- 行为合同：`/send` 必须先在 SQLite 事务中 reserve/commit/release 幂等记录；同 key 异 payload 原子冲突，未知 pending 不接管，不重复注入。TB Saga 必须冻结 payload/hash/revision，写前持久化 owner/fencing/outbox，写后只在回读确认后推进；新 Gateway 仅可对不确定写作冻结内容的只读 reconciliation，未命中保持 `sync_pending/reconciling`。所有 outbox 已确认后的本地结算恢复不得再调用 Provider 或 TB。
- 自动化守卫：`gateway/test/devbench-send-idempotency.integration.test.mjs`、`gateway/test/workflow-v2-tb-sync-saga.test.mjs`、`gateway/test/workflow-v2-tb-durable-operation.integration.test.mjs`、`gateway/test/store.test.mjs`、`gateway/test/teambition.test.mjs`。
- 修复版本：2026-08-08 Phase2 工作区实现，尚未提交。
- 当前验证：/send 幂等定向回归 3/3 通过；TB workflow/Saga/durable-operation 定向回归 36/36 通过；Store、异步写、Teambition 与 `/send` 扩大回归 139/139 通过。新增 planned-only owner 崩溃接管、旧 fencing 写入拒绝、写后只读 reconciliation 与 terminal-only 结算恢复覆盖；语法检查和 `git diff --check` 通过。
- 独立验收：全新上下文 Agent 复跑 `/send`、TB durable owner/outbox/Saga 39/39，并在最终工作树确认 index/隐藏标志均为空；本地离线范围 `PASS`。真实 TB 写回未执行，生产外部范围 `BLOCKED`。
- 残余风险：TB API 无原生幂等键；远端最终一致性导致回读暂未命中时会安全停留 `reconciling`，需后续只读重试。附件上传与挂载尚非两个独立持久 checkpoint，上传成功但挂载失败可能留下孤儿 blob；同一 story 的 durable owner 合同限定为同机多 Gateway 共享 SQLite，跨机器重复 ownership 不在当前支持范围。未调用真实 TB。

## REG-20260808-DEVBENCH-044：短报告可绕过 VERIFY，或在 Git commit 后本地结算失败时重复 Provider/丢失可信修复事实

- 复现：在非 reporting 阶段或缺少本轮 VERIFY PASS 时直接触发 short/expert report；或在 REPAIR 已由 Git Controller 提交后让本地 settlement 失败并重试。旧链路可能调用 Provider、回写报告，或再次提交/无法从持久记录恢复。
- 根因：报告入口、派发边界和 `report_done` 没有共享 VERIFY readiness 合同；可信短报事实没有强制绑定已结算的 REPAIR commit；commit 成功与本地 workflow 结算之间缺少可恢复边界。
- 行为合同：short 与 expert 报告都必须处于 reporting 且持有本轮 VERIFY PASS；任一入口、确定性 renderer、Provider 派发或 `report_done` 写回都不得绕过。确定性短报仅从已接受 structured REPAIR 和匹配 story/context/revision/result hash/worktree 的 Git settlement 读取事实；REPAIR commit 后本地结算失败必须只重放本地 immutable 结算，不得再次调用 Provider 或重复提交。
- 自动化守卫：`gateway/test/workflow-v2-deterministic-report-production.test.mjs`、`gateway/test/workflow-v2-report-renderer.test.mjs`、`gateway/test/workflow-v2-repair-commit-settlement.test.mjs`、`gateway/test/workflow-v2-tb-workflow-sync.test.mjs`、`gateway/test/devbench-prompt-mode.test.mjs`、`gateway/test/workflow-v2-index-integration-gate.test.mjs`。
- 修复版本：2026-08-08 Phase2 工作区实现，尚未提交。
- 当前验证：报告 readiness/确定性短报/settlement/index 定向回归已通过；`gateway/test/devbench-prompt-mode.test.mjs` 完整回归 73/73 通过；M8/最终 EDIT/REPAIR recovery/报告补充集 67/67 通过。真实 Provider、真实 TB 未运行。
- 独立验收：全新上下文 Agent 复跑报告与结算补充集并确认本地离线范围 `PASS`；因生产 VERIFY executor、Provider 和 TB 未接入，生产端到端仍为 `BLOCKED`。
- 残余风险：可信事实依赖本地 immutable receipt/settlement 完整性；生产受限 VERIFY executor 未部署时，报告会被安全阻断而非自动降级。

## REG-20260808-DEVBENCH-045：M8 Git、Flavor、Build 与设备动作缺少 Controller 正链或跨 Flavor/lease 提交

- 复现：让模型指定自由 Git 命令、任意 Flavor、公共 `src/main` 改动、其它 Flavor sourceSet，或在设备 lease 过期/换绑后继续 BUILD/DEVICE；旧实现可从 Gateway 直接执行、接受未授权 Flavor，或以陈旧 binding 生成成功结果。
- 根因：Git 提交、Flavor diff、构建产物 provenance 与设备业务动作曾分散在 Gateway/模型侧，未由 Controller 对 request、HEAD、检查 receipt、artifact、lease 和 fencing 做统一回读；非 Android/Web 工程没有受信 Flavor policy。
- 行为合同：Git commit 只能走独立 Git Controller，精确暂存受控路径、使用 Controller 生成提交信息、关闭 hooks、读回 branch/HEAD/diff 并写 durable journal/idempotency；必须验证最新 EDIT state 和 required receipt。Android 必须由 Controller 在 expected HEAD 解析非空 Flavor catalog；其它 Flavor 改动阻断，公共 main 改动需要显式可信影响审批；非 Android/Web 未配置单独 Controller-owned repository policy 即阻断。BUILD 必须绑定 story/repository/root/HEAD/Flavor/task/version/artifact provenance；DEVICE 仅允许同故事、同 serial、同 leaseId/fencingToken 的已证明动作并执行后回读。
- 自动化守卫：`gateway/test/story-repository-authoritative-commit.test.mjs`、`gateway/test/workflow-v2-repair-commit-settlement.test.mjs`、`gateway/test/workflow-v2-build-diff-gate.test.mjs`、`gateway/test/workflow-v2-build-device-controller.test.mjs`、`gateway/test/workflow-v2-controller-receipt-bridge.test.mjs`、`gateway/test/git-controller-process-boundary.test.mjs`、`gateway/test/git-controller-capability.test.mjs`。
- 修复版本：2026-08-08 Phase2 工作区实现，尚未提交。
- 当前验证：M8 Git Controller、最终 EDIT/mandatory receipt、Build/Device bridge 与 REPAIR 崩溃恢复稳定快照 65/65 通过；Device Proxy 真值、lease/binding 漂移定向回归 19/19 通过。当前未运行真实 Git Controller daemon、受证明 Build broker 或真实设备。
- 独立验收：全新上下文 Agent 的 M8/最终 EDIT/REPAIR recovery/报告补充集 67/67 通过，本地离线范围 `PASS`；真实 Controller daemon、Build broker 和设备未运行，生产端到端 `BLOCKED`。
- 残余风险：默认 production bridge 没有 Build broker/Device adapter；`src/main` 的可信人工审批和非 Android/Web 的 Controller policy 未部署。真实 Android release 包、设备、媒体和生产环境验收均未执行。

## REG-20260808-DEVBENCH-046：Base Protection Hook 的加固实现被后续变更整体回滚

- 复现：导入 Git Controller runtime 或执行 managed hook 诊断；`base-protection-hooks.js` 缺少 `diagnoseBaseProtectionHooks` 导出，导致 runtime import 失败，受管 hook 的安装、审计和恢复保护退化。
- 根因：后续变更 `44b0733` 意外整体回滚已验证 hardened hook 实现，而不是按文件/hunk 保留需要的行为；测试夹具又把本机 Node 可执行文件 ACL 当成固定前提。
- 行为合同：Base Protection Hook 必须保留受管安装、完整诊断、审计、幂等恢复和缺失激活记录修复；Git Controller runtime 不得因缺少诊断导出而失效。回滚只能针对已定位 hunk，必须比较引入提交与应保留行为；运行环境 ACL 检查必须使用受控夹具，不得依赖开发机 Node 安装目录权限。
- 自动化守卫：`gateway/test/base-protection-hooks.test.mjs`、`gateway/test/git-controller-base-sync.test.mjs`、`gateway/test/git-controller-process-boundary.test.mjs`。
- 修复版本：2026-08-08 工作区按已验证 hardened 版本恢复，尚未提交。
- 当前验证：恢复后的源文件与已验证版本字节一致；runtime import 成功；替换环境相关 Node ACL 夹具后，`gateway/test/base-protection-hooks.test.mjs` 完整复跑 32/32 通过。
- 独立验收：最终全新上下文 Agent 对稳定工作树给出本地离线总验收 `PASS`，未发现剩余 P0/P1；真实 Controller hook 安装未执行，生产环境范围仍为 `BLOCKED`。
- 残余风险：本机 Node 安装目录 ACL 可被环境策略改变；生产 Controller hook 安装仍需在目标服务身份和文件系统 ACL 下验证。

## REG-20260808-DEVBENCH-047：VERIFY 忽略 mandatory capability 与材料要求后错误生成 verify_pass

- 复现：冻结计划声明 `mandatoryCapabilities=[BUILD,DEVICE_ACTION,CAPTURE]`，唯一 mandatory case 是 DEVICE_ACTION 且要求 video/screenshot/logcat；结果只提供一张 DEVICE_ACTION PASS receipt。旧 `buildTrustedSystemGate` 返回 PASS，随后 structured gate 生成 `verify_pass`，可进入报告与 TB 结算。
- 根因：JSON Schema 只约束字段形状；system gate 的 case 归一化丢弃 `mandatoryCapabilities/evidenceRequirements`，只检查每个 case 的单一 action receipt，没有交叉验证能力集合或材料种类。
- 行为合同：mandatoryCapabilities 必须与 mandatory cases 的 action 集合精确一致；`receipt/<ACTION> receipt` 只由 case 主回执满足；video、screenshot、logcat 各需独立 CAPTURE 回执，绑定相同 context revision、root、case、可信 executor、material kind、evidenceId、`capture-output/<sha>.bin` 并回读哈希。主回执不可重复消费为材料，未知自由文本 BLOCKED；合法 VERIFY FAIL 不依赖正向材料读取。
- 自动化守卫：`gateway/services/devbench/workflow-v2/verification-evidence-contract.js`、`gateway/test/workflow-v2-system-verification-gate.test.mjs`、`gateway/test/workflow-v2-compatibility-evidence-gate.test.mjs`、`gateway/test/workflow-v2-trusted-execution-plan.test.mjs`、`gateway/test/workflow-v2-structured-result-gate.test.mjs`。
- 修复版本：2026-08-08 Phase2 工作区实现，尚未提交。
- 当前验证：语义/系统/兼容/structured gate 聚焦 42/42；完整 Workflow V2 38/38 文件、336/336 用例通过；交付 example 同时通过 Schema 与 semantic contract。
- 独立验收：全新上下文 Agent 重放原 P0，得到 `WORKFLOW_V2_VERIFY_MANDATORY_CAPABILITY_MISMATCH / BLOCKED`，structured result `ok=false`、`legacyEvent=null`、证据读取 0；本地离线 `PASS`。
- 残余风险：生产 CAPTURE adapter 尚未部署到能签发上述独立材料回执；部署前 VERIFY 会安全阻断，不能以本地 fixture 代替真机证据。

## REG-20260808-DEVBENCH-048：Workflow 测试聚合器显示 0/0 并丢失首次失败诊断

- 复现：Node 当前 reporter 明确输出多个 PASS/FAIL，用旧 `node scripts/run-tests.mjs workflow-v2` 聚合时每文件仍显示 `pass=0 fail=0`；某文件首次非零退出时摘要缺少有效 `not ok`/stderr，重跑成功容易掩盖首次失败证据。
- 根因：聚合器按已过时的 spec reporter 文本解析计数，未要求完整终态汇总，也没有把子进程协议错误、stdout/stderr 和首次退出码作为交付门禁。
- 行为合同：每个文件只执行一次并强制 TAP；必须解析完整且自洽的 tests/pass/fail/skipped/cancelled/todo，缺失或矛盾汇总 fail-closed；任一子文件非零使总命令非零，并保留首次 `not ok`、stdout/stderr、退出码和协议错误。
- 自动化守卫：`gateway/test/run-tests-runner.test.mjs`；所有 Workflow V2 聚合运行使用 `gateway/scripts/run-tests.mjs`。
- 修复版本：2026-08-08 测试基础设施工作区实现，尚未提交。
- 当前验证：聚合器专测 5/5；最终 Workflow V2 审计为 38/38 文件、336/336 用例，未知汇总文件 0。
- 独立验收：全新上下文 Agent 复跑 5/5，并确认完整聚合真实计数与退出语义；本地离线 `PASS`。
- 残余风险：未来 Node TAP 协议若变化会被当作未知/不完整汇总而阻断，需要显式升级 parser，不能静默计为 0。

## REG-20260808-DEVBENCH-049：Phase2 MANIFEST 字节口径漂移且 validator 未校验完整性

- 复现：旧 MANIFEST 声明 65 个条目；当前 Windows 工作树逐字节核对时 65/65 size、64/65 SHA 不符，CRLF→LF 后仍有 8 项失配。`verification-plan.example.json` 旧 size=1935，而 canonical 实际为 4762；旧 validator 仍返回绿色且会写 generated metrics。
- 根因：清单混用了工作树 CRLF、历史 LF 和陈旧内容的 size/hash；validator 只解析 JSON/Schema/Prompt，不对 MANIFEST 的 schema、路径集合、size/SHA 做校验，并在检查过程中修改包文件。
- 行为合同：MANIFEST v3 以 UTF-8、CRLF→LF canonical bytes 为唯一跨平台口径；完整覆盖排序后的受管普通文件并校验 path/sizeBytes/SHA，拒绝 NUL、孤立 CR、绝对/逃逸/反斜杠、大小写碰撞、漏项/多项/重复、symlink/junction/reparse。MANIFEST 自排除，标准 `**/__pycache__/*.pyc` 明确排除但异常 cache 内容仍阻断。`--check`/`--check-manifest` 全只读，`--print-manifest` 只输出候选。
- 自动化守卫：`schemas/package-manifest.schema.json`、`tests/test_manifest_integrity.py`、`tests/validate_package.py`。
- 修复版本：2026-08-08 Phase2 package manifest v3 工作区实现，尚未提交。
- 当前验证：常规无 `-B` unittest 14/14；其后 package check 与 manifest-only check 通过，67 个受管文件、30 JSON、10 prompts、36 acceptance cases；LF/CRLF 隔离副本、tamper/size/path/missing/extra/duplicate/schema/cache/reparse 负测通过，metrics 哈希不变。
- 独立验收：全新上下文 Agent 独立重算 67/67 path/size/SHA 全一致，example canonical 4762 字节及 SHA 与清单一致，validator 前后 68 个非 pyc 包文件零变化；本地离线 `PASS`。
- 残余风险：当前 Python 环境缺少可选 `jsonschema` 时通用 Schema/example 元校验会跳过；本轮由 Gateway Ajv 2020 和 JS schema tests 补验。后续应让 validator 输出明确标注该可选检查状态，避免把 skipped 表述成已执行。

## REG-20260809-FEISHU-050：D8CDC 双8目标路由和飞书优先级映射错误

- 复现：分别用 `D8CDC-` 标题的 Spotify、非 Spotify 工单和普通 Spotify 工单执行策略预览。旧逻辑仅按功能模块匹配 Spotify 并写入 8678 S应用，无法同时判断标题前缀，也没有双8应用市场的兜底分支。历史配置还把 P0/P1/P2/P3 写成 `0/1/2/2`，可读映射把 `0/1/2` 显示为“紧急/普通/较低”，不符合目标合同。
- 根因：原关键词特例只有单一字段包含条件，标题模板、Tasklist、Sprint 和应用分类混在全局配置里，无法表达“标题前缀 + 功能模块”的有序双条件路由；优先级写入值与页面文案各自维护，历史持久值会覆盖新默认值。
- 行为合同：P0/P1/P2/P3 固定归一为 `2/1/0/-10`，页面分别显示“非常紧急/紧急/普通/较低”。标题以大写 `D8CDC-` 开头且功能模块不区分大小写精确等于 Spotify 时，写入双8 S应用和 `Ava_S_双8_待规划`；同前缀但不等于 Spotify 时写入双8应用市场和 `Ava_应用市场_8155_待规划`；两者标题均为 `【缺陷转载8155】【阿维塔】{sourceWorkItemNo}{problemSummary}`。非 D8CDC Spotify 继续使用原 8678 S应用，其他工单继续使用 legacy 默认目标。预览、真实写入和写后回读必须共享同一策略决策。
- 自动化守卫：`gateway/test/feishu-sync-policy-engine.test.mjs` 断言两条 D8CDC 路由的规则、标题、真实 Tasklist/Sprint ID、Spotify 大小写及精确相等边界、P0/P3 值，以及原 Spotify/默认回退不受影响；`gateway/test/feishu-project-sync.test.mjs` 覆盖完整创建、更新、回读差异和可读优先级；`gateway/test/feishu-project-sync-source-views.test.mjs` 覆盖纯 `/policy-preview` 不写 TB；`web-dashboard/src/pages/feishuProjectSyncPolicyModel.test.mjs` 覆盖优先级文案、正则规则样例和否定条件样例。
- 修复版本：2026-08-09 工作区实现，尚未提交。
- 当前验证：后端策略、HTTP、主同步与路由回归 150/150，Web 飞书/策略模型 28/28，生产构建与隔离浏览器场景通过；全新上下文独立验收 PASS。全量 Web 为 344/346，两个失败位于本任务未修改的 DevBench 基线。生产真实写入/回读未执行，证据边界详见 `docs/tempFiles/story-acceptance/FEISHU-20260809/`（临时证据，不提交）。
- 残余风险：当前仅做 TB 目标元数据只读核验和本地策略/同步适配器验证；在未取得安全的测试工单范围前，不执行生产 TB 创建或更新，因此生产写入与回读仍需受控验收。

## REG-20260809-FEISHU-051：当前生效规则遗漏策略路由且配置页以裸 ID 作为主信息

- 复现：打开 `/feishu-project-sync` 的“配置与规则”。顶部“当前生效规则”只列出旧 `mappings.keywordRules`，看不到 `D8CDC-` 标题前缀与功能模块为/不为 Spotify 的两条 `routing.rules`；Project、Tasklist、Sprint、成员、规则档案和映射摘要又在主文本中直接显示 `69ddf5744b9a04cb08c4c2fa` 等技术 ID，用户无法判断实际业务目标。
- 根因：策略引擎与旧关键词编辑器已并存，但总览仍只读取旧数组；选择器和摘要各自使用 `name || id`、`name · id` 或直接 ID 的局部回退，没有统一的“名称优先、ID 按需展开”显示合同，也没有把规则条件转换成业务语句。
- 行为合同：“当前生效规则”按优先级展示所有启用的规范化路由规则，并将两条 D8CDC 分支表述为“标题以 D8CDC- 开头”且“功能模块等于/不等于 spotify（不区分大小写）”，同时显示目标档案、任务列表、迭代和同步策略名称。飞书同步页面的项目、任务列表、迭代、成员、阶段、状态、自定义字段、规则/档案/策略和映射摘要以显示名称为主；运行所需 ID 仅在技术标识详情中出现。名称无法解析时显示明确的刷新/补充提示，不得把裸 ID 当作名称。
- 自动化守卫：`web-dashboard/src/pages/feishuProjectSyncPolicyModel.test.mjs` 覆盖条件业务语句、名称优先和目标摘要；`feishuProjectSyncReadableUi.test.mjs` 固化总览路由接线、选择器名称主显示和技术标识折叠；`gateway/test/feishu-sync-policy-engine.test.mjs` 固化预览 trace 的字段名称与大小写元数据；Web production build 验证 JSX 集成。
- 修复版本：2026-08-09 工作区实现，尚未提交。
- 当前验证：策略引擎与 Web 可读模型/接线聚焦回归 24/24、完整飞书同步后端回归 150/150、Web production build 通过。3200 实页自验 15 项断言通过，常态视图未显示策略中的 7 个 24 位技术 ID，写请求 0；全新上下文 Agent 独立复跑 24/24、150/150、production build，并完成 18 项浏览器断言，常态 DOM 对配置中的 11 个 24 位技术 ID 暴露数为 0、写请求与外部请求均为 0，独立结论 PASS，总体双门禁 PASS。完整 Web 为 357/359，两个失败位于本任务未修改的 DevBench 基线。证据位于 `docs/tempFiles/story-acceptance/FEISHU-20260809-READABLE-UI/`（临时证据，不提交）。
- 残余风险：历史自定义配置若只保存技术 ID、且对应下拉或元数据接口当前不可用，页面只能提示“名称未解析”，无法凭空恢复业务名称；需在可连接 TB 的环境刷新选项或人工补充显示名称。生产飞书/TB 写入不属于本次可读性修复的必要动作，仍需受控工单范围另行验收。

## REG-20260809-DEVBENCH-052：Windows Codex MCP 配置参数被 shell 拆分

- 复现：故事点 CARB-13546 选择“Codex CLI（OpenAI 官方）· gpt-5.6-sol·xhigh”发送消息。CLI supervisor 传入完整 AppMarket MCP `-c` 覆盖参数后，Node 24 输出 `DEP0190`，Codex 随即以退出码 2 报 `unexpected argument 'APPMARKET_ADMIN_PASSWORD,' found`；用 `codex exec --help` 和同一组覆盖参数可在不调用模型的情况下稳定复现。
- 根因：Windows Job launcher 对 `codex`、`claude`、`gemini` 等无 `.exe/.com` 后缀的命令统一使用 `spawn(command, args, { shell: true })`。Node 将参数数组未转义地拼成 shell 命令串，MCP `env_vars`、`enabled_tools` 等包含空格、逗号和引号的单一 TOML 参数因此丢失 argv 边界。
- 行为合同：Windows CLI launcher 必须始终以 `shell:false` 启动子进程；对标准 npm `.cmd` shim 解析并直启其 JS/EXE 入口，使每个原始参数逐项、逐字节传递。非标准批处理仅允许通过显式 `cmd.exe` 兼容分支启动，不得恢复 Node `shell:true`。Codex 的完整 MCP 覆盖参数、stdin prompt 和退出码必须保持不变，stderr 不得再出现 `DEP0190`。
- 自动化守卫：`gateway/test/windows-cli-spawn.test.mjs` 通过真实 Windows supervisor → Job controller → launcher → npm shim 链路，断言含 `APPMARKET_ADMIN_PASSWORD`、空格、引号、`&`、`|` 的 Codex 参数数组完全相等，stdin 完整到达且无 `DEP0190`。
- 修复版本：2026-08-09 工作区实现，尚未提交。
- 当前验证：Windows supervisor 参数保真回归 1/1、Agent timeout 18/18、Codex app-server 7/7、AppMarket MCP Gateway 7/7 与 MCP 服务包 49/49 通过；四个相关 watchdog 聚焦场景 4/4 通过。Desktop preflight 25/25、Web production build、Windows installer 打包通过；包内 Node + Gateway 对真实 `codex exec --help` 重放完整 MCP 覆盖参数，退出码 0，未出现 `DEP0190` 或 password unexpected argument。
- 独立验收：全新上下文 Agent `/root/carb_13546_acceptance` 独立复跑源码与最终桌面包，真实 `codex exec --help` 接受完整 MCP 参数、退出码 0、CLI stderr 为空；本地 Windows 桌面产物范围 `PASS`，P0/P1 均为 0。未安装 NSIS、未调用付费模型，生产 UI 端到端仍未执行。
- 残余风险：非标准自定义 `.cmd/.bat` 不具备可解析 npm 入口时仍依赖显式 `cmd.exe` 兼容；官方 Codex、Claude 和 Gemini 的标准 npm shim 均走无 shell 的直接 JS/EXE 入口。

## REG-20260809-DEVBENCH-053：已退役 Full V2 仍可由历史配置重新接入故事发送链

- 复现：在 `workflowV2.featureFlags` 中重新设置 `promptV2`、`structuredResultsV2`、`evidenceReceiptsRequired` 或 `tbSyncSaga`，并恢复 `promptV2Rollout`、`activeExecutionProfileId`、`executionProfiles`。旧配置服务会接受并持久化这些字段，使已计划退役的 Controller/receipt/settlement 路径仍可被重新启用。
- 根因：工作流执行计划已决定回到 Prompt-only，但公开配置合同仍保留 Full V2 的八个开关、rollout 和 execution profile，没有在生产配置加载与更新边界执行退役收敛。
- 行为合同：生产 `workflowV2.mode` 固定为 `prompt-only`；公开特色开关只保留默认关闭的 `promptCompatibilityOverlay`，并继续要求 story/provider/stage 显式白名单。启动时必须原子写回清除历史 Full V2 字段，API 更新中的 Full V2 flags、rollout、execution profile 也必须被丢弃，普通 Flavor 选择不得调用 Full V2 Build catalog gate。普通 Git worktree、现有 Provider、legacy Marker、`applyWorkflow`、当前 TB Saga、通用 executor 与普通设备 FIFO/lease 继续保留，不因退役 Full V2 而删除。
- 自动化守卫：`gateway/test/workflow-v2-config.test.mjs` 覆盖历史配置的启动迁移与磁盘清理、API 尝试重启 Full V2、持久化结果、返回值引用隔离、example 公共合同和普通 Flavor 路由去除 V2 Build gate；`gateway/test/workflow-v2-prompt-overlay-send-turn.integration.test.mjs` 覆盖生产 Prompt-only 下的唯一可选增强链，且不创建 Full V2 envelope/settlement。旧 Full V2 协议测试仅允许在 `NODE_ENV=test` 且显式设置 `AIEFF_TEST_FULL_WORKFLOW_V2=1` 的隔离进程运行。
- 修复版本：2026-08-09 工作区实现，尚未提交。
- 当前验证：生产配置合同 7/7、真实 legacy sendTurn Prompt Overlay 1/1、普通 worktree manager 43/43、故事仓路径隔离 49/49 通过；旧 compatibility/structured sendTurn 仅测试态各 1/1 通过。Desktop preflight 25/25、Web production build、Windows installer 打包通过；包内配置以历史 Full V2 输入重放后只返回 `prompt-only` 和 Overlay 开关，不含 promptV2 rollout 或 execution profile，且迁移后的磁盘配置与运行时值一致。
- 独立验收：全新上下文 Agent `/root/carb_13546_acceptance` 独立确认历史 Full V2 配置在最终包中原子迁移，运行时与磁盘均只保留 Prompt-only；Overlay、普通 worktree、路径隔离与测试态旧协议回归通过，本地 Windows 桌面产物范围 `PASS`，P0/P1 均为 0。
- 残余风险：本次先完成运行时退役与公开配置瘦身，未物理删除休眠的 Full V2 源文件；后续只有在确认无 daemon、hook、待 settlement 和共享模块依赖后，才可按模块继续删除，不能整目录移除 `workflow-v2`。完整 `worktree-routes.integration.test.mjs` 在本机仍有一个既有测试数据 `path.resolve(undefined)` 失败；去除 Flavor gate 后目标大场景越过原 409 点，但在继续执行其余步骤时触及用例自身 120 秒上限，因此该文件不能计为全绿，当前由窄路由合同、worktree manager 与真实 Prompt-only sendTurn 补充门禁。

## REG-20260810-SERVICE-CONTROL-055：停止态或失败态无法强制释放端口并恢复服务

- 复现：Service Control 的关注区仍显示“强制结束 PID 并恢复端口”按钮时点击；若对应 profile 已被运行健康检查标记为 `stopped`，或先前启动已进入 `failed`，主进程在重新核验端口占用者之前直接报“仅运行中的环境可以释放占用端口并自动重启”。
- 根因：界面按 `portFallbacks` 中仍可安全识别的占用者决定是否提供恢复操作，主进程却额外要求 `status === "running"`。健康检查和启动失败可以改变表面状态而保留端口回退诊断，造成同一快照在前后端的资格判断不一致。
- 行为合同：仓库已配置、profile 不在启动/停止中、且回退快照仍存在时，`running`、`stopped`、`failed` 均可进入强制释放流程；`running` 在释放后执行 Stop + Start，`stopped/failed` 直接 Start。停止态健康刷新必须以 profile 配置为首选端口的权威来源并重新探测：端口恢复可监听时撤销过期回退、清空旧 PID，并把被旧状态污染的当前/首选端口恢复为配置值；即使旧回退数组已被中间版本清空，只要状态端口仍漂移也必须收敛。端口仍被占用时更新占用者快照。未配置、忙碌态、回退快照消失，以及 PID、进程名、命令行、受管归属或 Gateway discovery 指纹任一复核不一致时，必须在终止进程前失败关闭。
- 自动化守卫：`gateway/test/service-control-runtime-health.test.mjs` 覆盖三种可恢复状态、未配置/忙碌/快照消失负例、停止态过期回退刷新接线，以及原有的受保护 PID、受管进程、非 Node/Vite、非 Gateway 和指纹不完整拒绝矩阵。
- 修复版本：2026-08-10 工作区修复，尚未提交版本号。
- 剩余风险：自动化不会触发真实 UAC 或结束用户已有进程；最终安装包中的人工点击、管理员提权取消和真实端口抢占恢复仍需在受控进程上验证。

## REG-20260810-DEVBENCH-054：Codex app-server 丢弃 OAuth 轮换凭据导致 refresh_token_reused

- 复现：故事点 CARB-13546 选择“Codex CLI（OpenAI 官方）· gpt-5.6-sol·xhigh”发送消息。Codex app-server 从用户配置复制 `auth.json` 到每任务临时 `CODEX_HOME`；自动刷新令牌后，新凭据只写入临时目录，任务结束随目录一起删除。下一轮或并发任务仍持有旧 refresh token，再刷新时稳定收到 401 `refresh_token_reused` 并以退出码 1 结束。
- 根因：提交 `5ee6aca` 为规避 app-server SQLite/runtime 资源竞争而引入独立临时 `CODEX_HOME`，却把需要跨进程持久化的 OAuth `auth.json` 也当成一次性运行数据；官方 exec 还可能读取 `.codex-official` 备份，而 app-server 从当前 `.codex` 复制，放大了凭据源漂移。必须保留独立运行目录、`turn/steer` 实时追问、MCP 注入和任务结束清理，不能回退整项隔离能力。
- 行为合同：默认配置为官方 Codex 时，exec 与 app-server 必须以当前 `.codex/auth.json` 为唯一权威凭据源；app-server 仍使用独立临时运行目录，但完整且有效的轮换后 JSON 必须原子回写。并发旧副本不得覆盖已更新凭据。仅当 `refresh_token_reused` 发生在首条 prompt 尚未启动且没有正文/工具输出时，允许等待凭据传播后自动重试一次；已开始执行的 turn 不得重放。一次重试仍失败时，停止重试并明确提示执行 `codex logout`、`codex login`。
- 自动化守卫：`gateway/test/codex-app-server.test.mjs` 覆盖轮换凭据自动回写、并发旧副本的 compare-and-swap 防覆盖、后续运行读取新凭据和临时目录清理；`gateway/test/agent-timeout.test.mjs` 覆盖原消息无输出恢复、最多一次重试、持续失效的重新登录提示，以及已有正文/已启动 prompt 禁止重放。
- 修复版本：2026-08-10 CARB-13546 工作区实现，尚未提交。
- 当前验证：Node 语法检查通过；Codex app-server 7/7、Agent timeout 21/21 定向回归通过。更广回归、最终桌面产物和独立验收待本轮验收完成后更新。
- 残余风险：自动恢复依赖另一 Codex 进程已把后继凭据写回权威配置；若账号会话本身已撤销或没有任何进程持有有效后继令牌，则必须人工重新登录。真实 OpenAI 账号调用将在不暴露凭据且用户允许消耗额度的受控环境另行确认，本轮自动化不得读取或记录 token 内容。

## REG-20260810-SERVICE-CONTROL-056：Gateway 恢复成功后 Web 首选端口仍被外部 Vite 占用

- 复现：Production 同时因外部 Gateway 占用 3001、外部 AIEfficiency Vite 占用 3000 而回退到 3002/3010；点击“强制结束 PID 并恢复端口 3001”后，Gateway 已恢复 3001，但界面继续报告 Web 3000 被占用且没有可操作的恢复按钮，用户感知为端口再次被占用。
- 根因：强制释放策略只接受带完整 discovery 指纹的 Gateway `server.js`，所有 Web 占用者一律返回 `unsupported_service`；此外结束进程后仅做一次瞬时端口快照，父进程或看门狗快速拉起时可能在当前服务重启前重新占用。运行态 `preferredWebPort` 还会被实际回退端口 3010 污染，名称与配置权威口径不一致。
- 行为合同：Gateway 与 Web 必须分别显示真实首选端口和实际端口；未受管 Web 仅在唯一监听 PID、Node/Vite 命令精确落入一个已配置且有效的 AIEfficiency 仓库、PID 未受本面板跟踪且确认前后身份不变时才允许强制释放。释放后必须等待端口连续稳定空闲再重启；若父进程/看门狗重新占用则失败关闭并报告新 PID，不得静默再次回退后声称恢复。普通 Vite、未知/相对命令、受管 PID、多监听者和路径不匹配继续拒绝结束。
- 自动化守卫：`gateway/test/service-control-runtime-health.test.mjs` 覆盖 Web/Vite 已配置仓库路径正例、无指纹/非 Vite/仓库路径不匹配负例、稳定释放接线，以及配置首选端口不被实际回退端口覆盖。
- 修复版本：2026-08-10 工作区修复，尚未提交版本号。
- 当前验证：新增合同在基线实现上 12/15（3 项失败），候选为 15/15；Service Control 聚合 7 文件、42/42 与 Electron 包测试 7/7 通过。真实源码控制器已加载候选并把 3000 的外部 Vite PID 8240 标记为 `forceReleaseEligible=true`，配置首选端口保持 3000，Production Gateway 3001 与回退 Web 3010 均 HTTP 200。Windows NSIS 构建成功，包内主进程、策略和渲染器与源码逐字节一致。
- 剩余风险：自动化不会直接结束用户当前 PID 8240，也不会绕过真实确认框/UAC；真实进程释放需由用户在更新后的控制面板中明确确认。

## REG-20260810-DEVBENCH-057：故事点停止误判为其它 Gateway 且页面残留“实时追加”

- 复现：故事点 Agent 和 live draft 仍属于当前任务，但 `runningTaskId` 因异步收尾或多窗口同步提前变为 `null`；点击停止会返回 409“该 AI 任务正在另一个 Gateway 执行”。最终回答已经落盘时，若 `chat_message` WebSocket 终态事件丢失，浏览器的乐观 `runningTabs` 仍不会被对话恢复接口清除，发送按钮持续显示“实时追加”。CARB-14113 的冻结快照命中后半段状态：`runningTaskId=null`、`live=null`、最终回答已存在。
- 根因：停止路由只认 tab 的 `runningTaskId`，没有把 live draft 的 `taskId` 作为同一轮的可验证归属；前端只在 WS 最终消息到达时清除本地运行集合，`GET /conversation` 没有返回权威运行态，恢复逻辑也只会增加而不会删除运行标记。
- 行为合同：停止路由必须同时读取持久 `runningTaskId` 与 live draft `taskId`，优先中止本 Gateway 实际持有的 Agent，并保留停止前已显示回答；清理持久任务字段必须使用 compare-and-clear，不能覆盖并发登记的新任务。对话恢复接口必须返回经租约/进程协调后的 `runtime.active/taskId`；前端在流结束后主动核对，并按服务端布尔结论增删本地运行集合、清除已不存在的 live 缓冲。服务端未给结论时保持现状，不得猜测为空闲。
- 自动化守卫：`gateway/test/devbench-stop-answer.integration.test.mjs` 覆盖 `runningTaskId` 提前丢失、live draft taskId 回退、HTTP 停止、回答保留、`runtime.active true→false`，并构造 persisted/live 两个不同 taskId 均为本机活跃的冲突，证明只停止可见草稿任务且保留另一任务及其持久状态；`web-dashboard/src/pages/devbench/chatStopModel.test.mjs` 覆盖“历史回答已落盘 + 服务端 live 为空/运行态为 false + 浏览器残留 running/live”后退出“实时追加”，并保护旧 Gateway、缺少 sessionId、较新 WS 状态及实际组件接线；`storyRunStatusModel.test.mjs` 继续保护停止/收尾/停滞显示合同。
- 修复版本：2026-08-10 CARB-14113 平台工作区实现，尚未提交。
- 当前验证：停止集成回归在旧实现上稳定得到 409，候选 3/3 通过；前端停止与状态聚焦 12/12 通过；Web production build 通过，`git diff --check` 通过。全量 Web 为 359/361，两个失败位于未改的新建入口/重开锁测试；关联 Gateway 集为 87/88，唯一失败位于未改的对话备份认证夹具 401，均未通过修改范围外断言规避；由于本轮未保存这些聚合失败的原始输出，只把它们作为非阻断观察，不将“既有失败”当成独立验收 FACT。
- 残余风险：本轮证明同一 Gateway 内任务归属字段脱节可恢复；双 taskId 时优先命中本机真实 Agent，真正由另一机器或另一 Gateway 进程持有且仍活跃的任务仍保持 409 fail-closed，尚未提供跨节点取消协议。两个 WS 终态都丢失时由对话恢复/既有停滞自愈收敛；旧 Gateway 不返回权威 `runtime`、缺少 sessionId、较新 WS 数据、切换 tab/多窗口和进程重启路径均采用不武断删除状态的兼容策略。当前受管 Gateway 需要由 Service Control 正常重启后才会加载新的后端路由；未将平台修复冒充为 CARB-14113 业务代码或真机验收结论。

## REG-20260811-DEVBENCH-058：精简故事点 Prompt 已实现但生产默认仍发送 legacy 大 Prompt

- 复现：从真实故事点消息节点导出“AI 接收到的 Prompt”。`features/StoryDev/工作流/AI修复工作流/note_1.txt` 为 460 行、27963 字节，仍包含近期原始对话、完整共享 RAG、重复 TB/附件内容、长 Git/设备/材料问责规则和 NEXT；不存在 `Prompt-only 生产执行边界` 或 `STAGE_CONTEXT_JSON`。当本地配置没有 `workflowV2` 时，旧代码默认 `promptCompatibilityOverlay=false`、rollout=0%，五个精简模板不会进入真实派发。
- 根因：Prompt-only 实现被保留成默认关闭且要求 story/provider/stage 三重显式白名单的灰度增强；Full V2 退役后没有把它升级为生产默认，也没有迁移此前持久化的“关闭 + 空 scope”旧默认。组队故事点还被阶段解析器直接排除，始终回退 legacy 大 Prompt。
- 行为合同：生产 `prompt-only` 运行时默认启用精简 Prompt，默认 100% 且空 story/provider/stage 列表表示不限制；非空列表仍用于定向灰度，显式关闭仍可应急回退。启动读取旧磁盘配置时以 `productionPromptVersion` 一次性迁移旧默认，测试态 Full V2 不参与该迁移。TRIAGE、REPAIR、VERIFY_EXECUTE、REPORT_SHORT、REPORT_EXPERT 均使用“短核心 + 当前阶段模板 + 最小 StageContext”；组队甄别/修复只处理当前成员，统一验收/报告冻结全部成员范围。代码评审保持独立只读协议，不混入修复五阶段。
- 自动化守卫：`workflow-v2-prompt-overlay.test.mjs` 固化生产默认、显式关闭与可选白名单；`workflow-v2-config.test.mjs` 固化旧配置迁移、生产版本和示例配置；`devbench-prompt-mode.test.mjs` 对五阶段执行 legacy/候选差分、字符预算、禁止原始历史字段和组队范围断言；`workflow-v2-prompt-overlay-send-turn.integration.test.mjs` 通过真实 sendTurn/API mock 证明最终实发为精简 Prompt、遥测为 `phase2_overlay`、legacy marker/TB 状态机保持不变且不创建 Full V2 envelope/settlement；队列、幂等和阶段回归保护冻结身份与模式漂移阻断。
- 修复版本：2026-08-11 平台工作区实现，尚未提交。
- 当前验证：核心 9 文件隔离回归 123/123；组队 M3 边界 16/16、测试态 Full V2 compatibility sendTurn 1/1；Node 语法与 `git diff --check` 通过。当前有效配置对 `tab_1786371428333_1j5oup + codex + REPAIR` 返回 `selected=true/reason=enabled`。全 `workflow-v2` 聚合首次为 343/347，其中组队旧断言和 Full V2 互斥夹具已增量修正；未改的 `strictMarkersV2` 退役字段旧断言仍失败，测试态 structured Full V2 复验受临时目录 `.envelope-store.lock` EPERM 阻断。`agent-v2` 的 `poll_process cursor metadata` 仍命中既有 `(no new output)` 时序失败；配置聚合 36/37 的唯一失败为未改的 Feishu 管理权限夹具 403。
- 残余风险：本轮没有调用真实付费 Provider 或生产 TB，也没有用同一业务故事点重新实发；部署并重启 Gateway 后，应在隔离故事点依次触发五阶段并从消息节点核对 `aiPromptTelemetry.promptVariant=phase2_overlay`、模板哈希和实际 Prompt。普通阶段内仍沿用现有 Provider 会话续接语义；本轮优化的是每次实发 Prompt 与选择路径，不把 Full V2 的 receipt/Controller/结构化结算重新带回生产。

## REG-20260811-DEVBENCH-059：Windows 本机身份瞬时漂移导致历史与打开故事点消失

- 复现：Service Control 启动 Gateway 后，`GET /api/devbench/tabs` 只返回 1 条打开记录，`GET /api/devbench/tabs/copy-sources` 返回 `open=1/closed=0`；同一 `devbench_userdata` 中原 MachineGuid 设备桶仍完整保存 `tabs=5/closed=86`。现场哈希证明旧数据没有删除，而当前进程新建并读取了 MAC 设备桶。
- 根因：`machineStorageId()` 只给 `reg query ... MachineGuid` 1.2 秒；Gateway 启动时一次瞬时超时就永久回退并缓存 MAC 哈希。`tabs/closed/deviceRuntime` 以该哈希作为本机桶键，因此同一台 Windows 机器的一次启动会被误识别为另一台设备。
- 行为合同：Windows 优先通过固定 `System32/reg.exe` 有界重试 MachineGuid；成功解析的设备 ID 持久化到本机 DevBench 临时目录。后续启动若 MachineGuid 瞬时不可用，必须沿用持久 ID，不得切换到 MAC 桶；MachineGuid 恢复且与旧缓存不同时，以当前 MachineGuid 为准，避免复制旧缓存把另一台机器绑定进来。缓存不可写不能阻断 Gateway，但不得改写任何故事点正文或关闭状态。
- 自动化守卫：`gateway/test/devbench-userdata.test.mjs` 覆盖设备身份落盘、MachineGuid 失败时复用持久 ID、MachineGuid 恢复后覆盖过期缓存，并继续保护 tabs/closed 本机隔离与禁止 gossip。
- 修复版本：2026-08-11 平台工作区实现，尚未提交。
- 当前验证：旧进程现场基线为 `open=1/closed=0`，SQLite 权威桶为 `tabs=5（3 条 hidden）/closed=86`；身份专项回归 13/13、四组相关回归 119/119、语法与 `git diff --check` 通过，其中独立子进程会在启动后让注册表命令不可用并证明仍沿用持久身份。因 Service Control 提权父进程拒绝当前会话直接重启，使用严格前置条件和单事务把权威快照复制到误选别名桶，源桶保持不变；随后 3000 实际 API 返回 `open=5/closed=86`，隔离 Chromium 在真实 `/devbench` 页面看到 5 个故事点 Tab、历史面板 86 个“打开”和 86 个“复制”入口，相关 API 均为 200、无失败请求。
- 残余风险：当前受管 Gateway 尚未由 Service Control 正常重启，因此“真实受管进程在 MachineGuid 超时后命中持久缓存”的生产重启路径由单元合同覆盖，未在该提权进程内注入故障复跑。首次升级且缓存尚不存在、MachineGuid 三次连续失败时仍会兼容回退 MAC；下一次 MachineGuid 成功会纠正并写入稳定缓存。误选别名桶保留一份可回退镜像，原 MachineGuid 桶没有删除或覆盖。

## REG-20260811-DEVBENCH-060：安全的直接 worktree 引用无法清除同路径历史告警

- 复现：CARB-14180 已登记唯一主 worktree 与关联 SDK worktree，生命周期均为 `ready`。用持久告警中的主 worktree 路径重新执行仓库解析，结果为 `ok=true`、`worktreeOwnershipVerified=true`，但直接 worktree 引用不产生基础仓映射，返回 `mappings=[]`；旧 `__testShouldClearRepositoryPathAlert` 因只读取 `mappings` 返回 false，页面持续显示“基础仓库尚未映射/路径越出 worktree”，即使后续 AI 已在该 worktree 成功执行。
- 根因：解析器区分 `mapped` 基础仓引用与 `allowed` 直接 worktree 引用，持久告警清理却只消费前者的 `basePath/worktreePath`，丢失了后者已完成词法、真实路径、归属和隔离验证的根路径证据。
- 行为合同：成功解析必须返回本轮实际命中的、已验证安全的仓库根路径；告警清理可使用这些路径与基础仓映射，但只能在告警的每个受保护路径都被同轮精确验证时清除。其它仓库的成功映射不得清除当前告警；目录逃逸、未知卷、共享 checkout、失效映射和物理重解析越界继续 fail-closed。
- 自动化守卫：`gateway/test/story-repository-path-resolver.test.mjs` 覆盖直接 worktree 引用返回 `resolvedRepositoryPaths` 且不伪造 `mappings`；`gateway/test/devbench-prompt-mode.test.mjs` 覆盖同路径 `unsafe-path` 告警可清除、不同 SDK 告警不可清除；`gateway/test/worktree-resource-isolation.integration.test.mjs` 继续保护真实隔离 Gateway 的缺失仓库阻断、零排队和基础仓不变。
- 修复版本：2026-08-11 `PE-CARB-14180-REPOSITORY-PATH-ALERT` 工作区实现，尚未提交。
- 当前验证：真实 CARB-14180 快照在旧判定上稳定得到 `shouldClear=false`；候选定向路径/Prompt/隔离 Gateway 聚合 128/128 通过。候选对同一路径返回 `resolvedRepositoryPaths` 后，实时告警已从 `STORY_BASE_WORKTREE_MISSING` 精准清为 `null`；API 回读确认 worktree 仍为 `ready`、operationId 未变、AI 未运行且队列为空。最终证据记录在 `docs/tempFiles/project-acceptance/PE-CARB-14180-REPOSITORY-PATH-ALERT/508d3453/`。
- 残余风险：当前修复只清理后续成功解析已精确覆盖的持久告警，不追溯猜测原始失败输入；正式发布前仍需通过 Service Control 正常重启受管 Gateway 并验证新进程加载候选。

## REG-20260812-CARDEV-061：P177 重连后 HUD 抢占无障碍根节点导致 Geely 工程模式未输入

- 复现：`192.168.20.76:5566 / P177-LE` 重连后，从 `/cardev` 点击工程模式入口。系统拨号盘已显示在 2560×1600 主驾屏，但 `uiautomator dump` 返回 800×480 的 `com.geely.hud` 层级，原实现因此报 `CARDEV_DIALPAD_KEYS_NOT_FOUND`，没有向拨号盘输入密码。
- 根因：P177 多显示屏在重连后可能把无障碍根节点留在 HUD，普通 `uiautomator` 结果不一定属于当前可见拨号器；同时原通用文件名、函数名和路由没有表达该密码与拨号行为只属于 Geely，容易被后续车厂误复用。
- 行为合同：工程模式采用“通用注册中心 + 厂商插件”结构；Geely 独立拥有密码、拨号、P177 兼容与成功判据，HTTP 路由显式为 `/devices/engineering-mode/geely`，前端从注册表动态生成“进入Geely车机工程模式”按钮并复用通用多设备选择。P177 几何兜底仅在型号匹配、可见窗口确为 Geely 拨号器、物理主屏为 display 0、窗口为 2560×1600 时启用，并向 display 0 逐键点击；最终必须检测到 `com.geely.engineermode/.MainActivity` 才返回成功。未知厂商、窗口或分辨率不匹配继续失败关闭；免管理员调用仍只允许 Gateway 本机可信页面。
- 自动化守卫：`gateway/test/cardev-geely-engineering-mode.test.mjs` 覆盖 Geely 密码、动态 UI、P177 四重约束兜底、未知插件和最终 Activity 反证；`gateway/test/device-operation-route-guard.integration.test.mjs` 覆盖厂商路由与设备 lease；`gateway/test/admin-write-route-guards.test.mjs` 保护本机可信免登录边界；`web-dashboard/src/pages/cardev/engineeringModeDeviceSelection.test.mjs` 保护插件按钮文案和通用多设备弹窗。
- 修复版本：2026-08-12 工作区实现，尚未提交。
- 当前验证：Gateway 插件、权限、ADB 与设备锁定向矩阵 21/21；Web 插件按钮与设备选择 6/6；Vite production build 通过。Service Control 已加载插件化候选，Gateway PID `43564 -> 23976`、Web PID `28948`，健康检查 HTTP 200。插件清单只返回 `geely / Geely车机工程模式`；本机可信网页不带管理员身份调用 `/devices/engineering-mode/geely`，对 `192.168.20.76:5566` 返回 `ok=true`、动态密码 `#*131211`、`inputMethod=p177_dialpad_geometry_tap`，ActivityManager 确认目标进入 `com.geely.engineermode/.MainActivity`，同时 Pixel 4 XL 仍停留在 Launcher。隔离浏览器打开真实 `/cardev`，确认“进入Geely车机工程模式”按钮唯一存在；两台设备在线时弹窗列出 P177 与 Pixel，默认不预选任何设备且确认按钮禁用，必须主动选择后才能执行。旧通用 `/devices/engineering-mode` 不再享有本机免管理员权限，返回 HTTP 401。
- 残余风险：P177 几何兜底只覆盖已验证的 2560×1600 Geely 拨号盘；其他 Geely 布局仍优先依赖动态 UI 节点，其他车厂必须新增独立插件，不得复用 Geely 密码或坐标。正式发布 READY 未评估。

## REG-20260814-DEVBENCH-062：Codex 已完成 turn 但故事点仍保持运行中

- 复现：CARB-14481 的 Codex CLI 已输出完整验收报告并发出协议事件 `turn.completed`，最后活动停在该事件；此后近 30 分钟没有新的 CLI 输出，但数据库任务、运行租约、Agent 进程树和页面状态仍为运行中，只能等待 1 小时 idle 上限或人工停止。
- 根因：Codex JSON 流解析器只从 `turn.completed` 提取用量和会话信息，没有把它暴露为终止信号；Agent Runner 又只在最终正文包含旧中文“任务状态”或 `<!-- NEXT:` 标记时启动 30 秒收尾。CARB-14481 的有效最终正文以 `<!-- VERIFY: FAIL -->` 结束，不命中旧正文标记，子进程即使已经完成 turn 仍因辅助进程保持标准输出而无法自然退出。
- 行为合同：`turn.completed` 是 Codex JSON 流的一轮权威终止事件。Runner 必须先消费同一事件中的最终正文、usage 和 session id，再在微任务阶段收敛执行、终止残留进程树、释放运行槽位与租约并持久化最终回答；最终正文是 PASS、FAIL 或不含任何自然语言结束标记都不得影响收敛。旧正文标记只保留为兼容回退，不作为主要终止协议。
- 自动化守卫：`gateway/test/codex-json-stream.test.mjs` 固化 `turn.completed -> turnCompleted=true`；`gateway/test/agent-timeout.test.mjs` 的 `turn-completed-hang` 假 CLI 输出 `VERIFY: FAIL` 最终报告和 usage 后持续挂起，验证 Runner 能主动收敛、完整保留报告与 usage、把任务标为 completed 且清空运行 Agent。
- 修复版本：2026-08-14 `CARB-14481-CODEX-STUCK` 平台工作区实现，尚未提交。
- 当前验证：基线在新回归上稳定等待到 4 秒总超时并失败；候选的 Codex Agent 相关用例 9/9、Codex JSON 流 7/7、两份源码语法检查和 `git diff --check` 均通过。真实 CARB-14481 已通过既有停止接口安全收敛，完整失败报告保留，runtime 变为 inactive，原 Agent 进程树消失且 Gateway 保持在线。Service Control 已正常重启并加载候选：Gateway PID `12592 -> 41172`、Web PID `26708 -> 41204`，3001/3000 均为 HTTP 200 且无端口回退；重启后 CARB-14481 仍为 `runtime.active=false`，最后一条 transcript 保留 `<!-- VERIFY: FAIL -->`，数据库无 active task、运行租约或持有任务的 Agent。
- 残余风险：本轮不重新调用真实付费 Codex，也不在 CARB-14481 上重放业务 turn，以免重复修改目标工作树或触发来源副作用；真实协议证据来自事故现场的 `turn.completed`，候选终止行为由 Windows 进程级集成假 CLI 复现。CARB-14481 自身的业务验收仍因 P166 未绑定、来源附件未逐个读取且最终报告为 FAIL 而不能标记 VERIFIED；该业务结论与本平台生命周期修复分开。

## REG-20260820-DEVBENCH-063：Atlas 故事点模型目录被旧配置截断且客户端入口未区分

- 复现：故事点聊天页打开 AI 模型弹窗，`Atlas Coding Plan` 只显示旧配置中的 `zai-org/glm-5.1`；引擎列表也只有网关 API 直连入口，无法区分 Claude Code、Codex CLI 与 Hermes 三种客户端协议。
- 根因：内置 Atlas `availableModels` 只有单项，持久化旧数组又覆盖默认值；API 引擎元数据没有向弹窗传递 `availableModels`。客户端一键配置只改全局工具配置，没有注册故事点级的独立引擎 ID、隔离 profile 和运行适配。
- 行为合同：启动加载时把官方 Atlas 模型目录与历史自定义模型去重合并；`atlas` API 直连保持兼容。故事点新增 `claude-atlas`、`codex-atlas`、`hermes-atlas`，分别使用隔离的 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`HERMES_HOME`，共享 Atlas 模型目录但保留各自流式/队列、MCP、状态检测与显示名称。只有 Atlas 配置就绪且对应 CLI 已安装时入口才可用。
- 自动化守卫：`gateway/test/api-engines-config.test.mjs` 固化旧单模型配置迁移为完整目录；`ai-model-metadata.test.mjs` 固化三个入口的模型元数据；`atlas-client-config.test.mjs` 与 `codex-minimax.test.mjs` 固化三套隔离 profile 和 Codex app-server；`atlas-engine-status.integration.test.mjs` 固化 Hermes 未安装时失败关闭；`devbench-message-delivery.test.mjs`、`appmarket-admin-mcp.test.mjs` 和 `web-dashboard/src/pages/settings/atlasSetupModel.test.mjs` 固化协议能力与 UI 命名。
- 修复版本：2026-08-20 工作区实现，尚未提交。
- 当前验证：基线同一判据为 `configured=1 / metadata=0 / popup=1` 且只有 `atlas`；候选本地真实配置与隔离 Gateway 均得到 17 个唯一模型，真实浏览器 DOM 点击弹窗看到三条 Atlas 客户端入口和 17 个模型，并从 Claude Atlas 切换、持久化为 Codex Atlas。专项回归 53/53、Web 411/411、production build、语法和 `git diff --check` 通过；静态质量门禁无新增阻断项。
- 残余风险：本机未安装 Hermes，未执行真实 Hermes + Atlas 付费请求；当前受管 Gateway 仍是修复前进程，需由用户正常重启后加载候选。390px 视口下既有固定宽度弹窗横向裁切，本轮未扩大为布局修复；完整 Gateway 套件还存在与本改动无关的 Windows 长进程/游标用例失败并在既有保护钩子处停滞。

## REG-20260820-DEVBENCH-064：故事点 AI 选择器按“CLI × AI 产品”分组

- 复现：故事点聊天页把 `claude-minimax`、`claude-atlas`、`codex-minimax` 等真实运行引擎平铺成同级选项；用户无法先按 Claude Code、Codex CLI、Gemini CLI、Hermes 理解执行外壳，再选择该 CLI 下的 MiniMax、Atlas Coding Plan 等 AI 产品。
- 行为合同：弹窗第一层按 CLI 分组且一次展开一个分组，当前 CLI 默认展开；第二层只展示该 CLI 支持的 AI 产品，产品按钮继续提交原有 engine ID。模型、档位、可用性、运行中禁用、动态 API 引擎和故事点级保存契约不变。底部输入区与右侧悬浮入口共用同一 Portal 弹窗，在窄屏保留 8px 安全边距；Escape 关闭后焦点返回原触发按钮。
- 自动化守卫：`web-dashboard/src/pages/devbench/enginePickerModel.test.mjs` 固化 CLI/产品映射、动态 API 直连降级与 accordion 接入；`atlasSetupModel.test.mjs` 从 canonical 分组目录继续保护三条 Atlas 客户端入口。
- 修复版本：2026-08-20 工作区实现，尚未提交。
- 当前验证：新增契约基线因缺少分组模型失败；候选定向 8/8、Web pretest 22/22、Web 主测试 414/414、Vite production build 均通过。隔离 Gateway 与真实 Chrome DOM 验证 Claude Code 组含 Anthropic 官方/火山方舟/MiniMax/Atlas Coding Plan，Codex CLI 组含 OpenAI 官方/MiniMax/Atlas Coding Plan；点击 Codex Atlas 后故事点持久化为 `codex-atlas`。底部与悬浮两个入口在 390×844、768×1024、1024×768、1440×900、1920×1080 均无横向溢出或弹窗越界，Escape 焦点恢复通过。
- 残余风险：本轮不改变全局“在此开发”悬浮工具的独立模型选择器，也不执行真实付费 AI 请求；正式发布 READY 未评估。构建仍报告既有 `GitCommitReworkPanel.jsx` JSX 字符警告和大 chunk 警告。

## REG-20260820-DEVBENCH-065：底部 AI 切换按钮挤压故事点输入框

- 复现：故事点输入区把 AI 切换、清空、发送和输入框放在同一不可换行的 flex 行；AI 按钮又同时展示 CLI、产品、模型和档位，并保持 `shrink-0`。390×844 隔离浏览器基线中，即使先把按钮压到 87px，输入区仍只剩 26px。
- 根因：底部触发器重复展示了只应存在于 tooltip/选择弹窗的完整技术信息，操作行又没有窄屏换行和输入区最小宽度合同。
- 行为合同：底部按钮仅显示稳定的主要产品短名，例如 `Atlas Coding Plan` 显示为 `Atlas`；完整 CLI、产品、模型和档位继续保留在 `title` 与选择弹窗。按钮宽度不超过 112px；操作行空间不足时换行，输入区优先保留 `min(12rem, 100%)`；悬浮入口、引擎 ID、模型/档位和保存接口不变。
- 自动化守卫：`enginePickerModel.test.mjs` 固化产品短名和紧凑 DOM；隔离 Gateway + Chrome DOM 同时校验按钮宽度、输入区宽度、API 直连 Atlas 切换持久化、弹窗几何与关联路由。
- 修复版本：2026-08-20 工作区实现，尚未提交。
- 当前验证：紧凑 DOM 基线 3/4 通过、目标用例失败；候选专项 10/10、Web pretest 22/22、Web 主测试 416/416、Vite production build 通过。390×844 下 Claude 按钮 69px、输入区由 26px 恢复为可用主行的 178px；API 直连 Atlas 按钮为 59px 且文本仅为 `Atlas`。768×1024、1024×768、1440×900、1920×1080 同样通过，无页面横向溢出、弹窗越界或页面异常。
- 残余风险：窄屏空间不足时清空、发送和 AI 按钮会换到输入框下方，这是为保证输入区可用的预期降级；未执行真实付费 AI 请求，正式发布 READY 未评估。

## REG-20260821-DEVBENCH-066：自由纠偏消息被验收/报告阶段覆盖为只读任务

- 复现：CARB-15144 首轮需求已经同时包含 avatr8678 与 avatr8155；故事点处于 `VERIFY_EXECUTE` 时，用户再次发送“avatr8155也需要同样处理，不只是 avatr8678 我之前不是发过吗？”。冻结会话证明该消息正文和当前任务完整到达 AI，AI 也识别出 avatr8155 被排除，但最终只输出验收失败的“简短报告”，没有继续修改。随后工作流因验收失败回到修复阶段。
- 根因：普通输入框消息没有冻结用户回合类型；`inferWorkflowKindFromMessage` 对非流程话术返回空值，`resolveCompatibilityStage` 又无条件按持久 `workflow.phase` 回退，因此自由纠偏在 `verifying/verify_blocked/reporting` 被重写为只读 VERIFY/REPORT Prompt。正在运行的验收/报告 Agent 还允许实时注入普通聊天，即使模型理解了新要求也受当前阶段权限约束而不能执行。报告识别器同时会把“不要提交报告”中的否定话术误判为显式报告动作。
- 行为合同：输入框发送和编辑重发必须在服务端把明确验收/报告话术冻结为 `verify/report`，其余用户消息冻结为 `chat`；`chat` 继续通过同一 `sendTurnWithDeviceRuntime` 链路逐轮携带主工程/worktree、绑定设备、目标 Flavor、TB 材料、历史和安全约束。修复阶段的 chat 保留可写 `REPAIR` Prompt；甄别、验收、报告阶段不得仅凭旧 phase 覆盖用户本轮意图。验收/报告运行中收到 chat 必须进入持久 FIFO 队列，待当前只读回合结束后独立派发；流程按钮继续显式触发 `repair/verify/report`。否定报告话术不得启动报告流程。
- 自动化守卫：`gateway/test/devbench-prompt-mode.test.mjs` 固化 CARB-15144 原话、否定报告和主工程/设备/Flavor/任务 Prompt 上下文；`gateway/test/workflow-v2-prompt-rollout.test.mjs` 固化 chat 与 REPAIR/VERIFY/REPORT 的阶段边界；`gateway/test/devbench-conversation-routes.test.mjs` 固化输入框、编辑重发、运行中排队和“标记修复完成”按钮接线；`gateway/test/workflow-v2-prompt-overlay-send-turn.integration.test.mjs` 通过隔离 Provider 的真实 `sendTurn` 链证明纠偏轮使用完整故事点 Prompt 且不含 VERIFY/REPORT overlay；既有队列和发送幂等集成继续保护冻结身份与 FIFO。
- 修复版本：2026-08-21 `CARB-15144-chat-intent-routing-fix` 平台工作区实现，尚未提交。
- 当前验证：事故冻结会话是独立基线 Oracle：同一用户消息的 `aiPrompt` 明确为 `stageId=VERIFY_EXECUTE`，回答只产生验收失败报告；候选定向回归 89/89、扩展队列/幂等/Prompt 链 93/93，隔离 Provider 真实派发 2 轮通过，第二轮 Prompt 同时包含主工程、`avatr8155ProdRelease`、当前设备绑定状态和原始纠偏任务，且不含 VERIFY/REPORT 阶段模板；390×844 隔离网页在 `verifying` 阶段真实输入 CARB-15144 原话并用 Ctrl+Enter 发送，`/send` 收到逐字一致正文；源码语法检查通过。
- 残余风险：本轮不得在真实 CARB-15144 或生产 TB 上重放消息、修改其目标业务 worktree 或推进来源状态；受管 Gateway 仍需正常重启后才会加载候选。自然语言分类保持保守规则，未明确表达的复杂双重否定仍可能落为 chat，但不会因此自动触发报告副作用。

## REG-20260821-DEVBENCH-067：甄别完成后顶部直接显示“标记修复完成”

- 复现：CARB-15059 冻结会话仅有 TRIAGE 用户请求、甄别回答和“甄别完成，请继续发消息开始修复”系统提示，持久阶段为 `fixing`，没有任何 REPAIR 用户回合；顶部状态条却直接显示“标记修复完成”，使尚未开始修复的用户看到收尾动作。
- 根因：`WorkflowStatusBar` 只按 `phase === fixing` 决定按钮，没有区分“甄别后待开始修复”和“已经执行过修复但尚未产出 FIX_DONE”。页面虽然另有悬浮“AI 修复”入口，顶部下一步按钮没有接入既有 `startFix -> onSend -> /send` 链路；“标记修复完成”文案还容易让人误以为点击后直接改状态，实际只是再启动一轮 AI 核对。
- 行为合同：`fixing` 且甄别后没有真实 REPAIR 用户回合时，顶部只显示“开始修复”，点击后通过既有发送链携带故事点、主工程/worktree、设备、Flavor、材料和历史进入可写 REPAIR 回合。已有 REPAIR 回合仍停在 `fixing` 时，显示“继续修复”和次级“核对修复完成”；后者只让 AI 核对代码与自测，只有 AI 输出 `FIX_DONE` 才进入验收，不得直接写阶段。AI 运行时只显示对应运行态；其余阶段按钮语义和 API 保持不变。
- 自动化守卫：`workflowMapModel.test.mjs` 以 CARB-15059 冻结时间线保护“TRIAGE-only -> start_fix”和“REPAIR 已开始 -> continue_fix + mark_fixed”，并覆盖 claimed/triaging/group_fixed/verifying/verify_blocked/reporting/sync_pending/testable/reject_pending/rejected 的空闲按钮矩阵及 StoryTab 接线；隔离 Chromium 真实点击“开始修复”，检查窄屏几何、实际 `/send` 请求、完整配置上下文和运行态切换。
- 修复版本：2026-08-21 `CARB-15059-workflow-action-button-fix` 平台工作区实现，尚未提交。
- 当前验证：真实 CARB-15059 只读 API 与冻结消息证明 `phase=fixing`、REPAIR 回合数为 0、旧 UI 显示“标记修复完成”；新增合同基线因缺少动作模型失败，候选专项 10/10、Web pretest 22/22、Web 主测试 420/420、Vite production build 通过，静态 UI 审计 0 个阻断项。390×844 隔离页面只显示“开始修复”、按钮完整可见且页面无横向溢出；真实点击后 POST `/api/devbench/tabs/tab_isolated_carb_15059/send`，正文包含故事点、主工程、`zeekrCx`、绑定设备并切换为“AI 正在按该 TB 单修复”。
- 残余风险：未点击或推进真实 CARB-15059，TB 的“复现概率”必填阻断保持原样；隔离 UI 证明浏览器和 API 接线，不代表真实付费 Provider 已执行修复。受管 Web/Gateway 需正常重启或重新部署后才会稳定加载候选；复杂的旧消息缺少时间戳和 Prompt 遥测时，动作模型保守视为尚未开始修复，用户可再次点击“开始修复”而不会误触发完成流程。

## REG-20260821-SETTINGS-067：Atlas 一键设置后 Claude Code 同时加载两种认证变量

- 复现：在设置页对 Atlas Coding Plan 点击“一键设置到 Claude Code”后，Claude Code v2.1.220 启动提示 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY` 同时存在。现场 Process/User/Machine 环境均未设置这两个变量；写入前备份的 `settings.json.env` 只有 API Key，一键设置后的默认 Claude 配置同时出现 API Key 与 Atlas AUTH_TOKEN。
- 根因：`mergeAtlasIntoClaudeSettings` 先完整保留旧 `env`，再加入 Atlas 所需的 `ANTHROPIC_AUTH_TOKEN`，但未删除上一 provider 留下且与其互斥的 `ANTHROPIC_API_KEY`。故事点隔离 Atlas 启动路径和既有 Claude×火山方舟全局配置路径已经执行该删除，只有 Atlas 全局一键设置漏掉。
- 行为合同：Atlas 写入 `%USERPROFILE%\.claude\settings.json` 时必须保留顶层设置、权限、主题与无关 env，写入 Atlas 官方端点、模型和 AUTH_TOKEN，并删除 `ANTHROPIC_API_KEY`；Codex、OpenCode、Hermes、备份、原子写入、失败恢复及响应脱敏行为不变。程序不擅自修改操作系统 Process/User/Machine 环境变量。
- 自动化守卫：`gateway/test/atlas-client-config.test.mjs` 同时从纯合并函数和临时 home 的真实事务写入固化“保留无关字段、AUTH_TOKEN 存在、API_KEY 缺失、备份存在且响应不泄密”。
- 修复版本：2026-08-21 `atlas-claude-auth-conflict-20260821` 平台工作区实现，尚未提交。
- 当前验证：用户提供会话记录 72 行已完整读取，SHA-256 为 `A97355EAB445C41A5B73A00688AD8524D4DE837BF3945D2683D0C6D4B1E65533`；同一基线判据退出 1 且 `conflict=true`，候选退出 0 且 `conflict=false`。Atlas 配置专项 8/8、管理员 Atlas 路由 1/1、Web pretest 22/22、Web 全套 416/416、Vite production build、语法和目标 diff 检查通过。修复后的正式服务函数已对当前用户配置重新执行，创建 `settings.json.aiefficiency-atlas-20260821T025308Z.bak`，只读核对为 AUTH_TOKEN 存在、API_KEY 缺失；真实启动 Claude Code v2.1.220 正常进入提示符且未再出现双认证警告，全程未发送 Prompt。静态审计无阻断项；深度质量门禁在 Gateway 全套长时间无输出后终止，未伪报通过。
- 残余风险：当前受管 Gateway 未重启，因此设置页进程要在下次正常重启后才加载代码补丁；本机当前配置已修复。完整 `config-admin.integration` 为 13/14，失败的是与本修复无调用关系的存量“普通字段无 token 可改”断言（实际 403）；Gateway 全量门禁仍为未完成。构建继续报告既有 `GitCommitReworkPanel.jsx` JSX 字符和大 chunk 警告。若 shell profile 或外部启动器以后注入 `ANTHROPIC_API_KEY`，文件级修复无法删除进程外来源，应按 Claude 官方指引单独清理该来源。

## REG-20260821-DEVBENCH-068：TB 工作流缺少可持久化的“跳过测试验收”选择

- 复现：DevBench 的“TB 工作流”状态栏在报告模式后没有“跳过测试验收”选项；即使用户不需要测试与验收，`FIX_DONE` 仍会进入 `verifying/verify_blocked`，完整工作流图也始终展示“等待验收”和“自我验收”。
- 根因：报告模式和自动化档位都有持久配置，但测试验收是状态机中的无条件阶段；前端工作流图使用固定 phase 清单，显式验收入口、自动推进、报告就绪门禁和 Prompt 又分别假定每轮必有 `VERIFY PASS`，只改 UI 无法真正跳过。
- 行为合同：状态栏在“简短报告/专家报告”标识后提供可访问的“跳过测试验收”按钮，默认关闭并按故事点持久化；故事点组只有一轮统一验收，因此组内同步选择。开启后 `FIX_DONE` 直接进入 `reporting`，显式/自动验收入口和人工切换到验收阶段均由后端拒绝，完整工作流图不渲染 `verify_blocked/verifying`；关闭后没有真实 `verifyPassedAt` 的报告阶段恢复到真实验收门禁。跳过只表示未执行，必须保留 `fixedAt`，不得写入 `verifyPassedAt`、宣称验收通过或伪造验收资产；简短和专家报告都要明确披露跳过边界。
- 自动化守卫：`gateway/test/devbench-workflow-phase.test.mjs` 固化单故事点和故事点组选择、`FIX_DONE -> reporting`、关闭恢复、人工阶段与 HTTP API 门禁；`devbench-prompt-mode.test.mjs` 固化显式验收阻断、报告措辞、专家 HTML 和简短 TB 评论的未执行边界；`store.test.mjs` 固化默认关闭；Workflow V2 compatibility/structured/overlay 模板及 context selector 固化 `SKIPPED_BY_USER`；`workflowMapModel.test.mjs` 固化按钮/API/工作流图接线。隔离 Chromium 真实点击按钮，并在 390×844 与 1440×900 检查选择状态、按钮位置、无横向溢出及两个验收节点的隐藏/恢复。
- 修复版本：2026-08-21 `devbench-skip-test-verification-toggle-20260821` 平台工作区实现，尚未提交。
- 当前验证：新增状态机与工作流图合同在旧实现上稳定 3 项失败；候选专项 22/22、报告与 Store 聚合 170/170、Workflow V2 相关聚合初次 58/60（两项为设计源尚未同步），同步设计源后增量 9/9；Web pretest 22/22、Web 主测试 422/422、Vite production build、三份 Node 语法和 `git diff --check` 通过。隔离页面两次真实 DOM 点击分别发送 `{ skipped: true }` 和 `{ skipped: false }`，窄屏/桌面按钮完整可见且页面无横向溢出，选择时工作流图不含两个验收节点，恢复后重新显示；所有 `/api` 均被隔离拦截，未操作真实 TB。
- 残余风险：本轮没有推进真实故事点、执行付费 Provider、写回 TB 或验证部署后的受管 Gateway；报告提交后仍按既有业务规则流转“可提测”，但评论会明确测试验收未执行。正式发布 READY 未评估。构建继续报告未改的 `GitCommitReworkPanel.jsx` JSX 字符警告和既有大 chunk 警告。

## REG-20260821-DEVBENCH-069：甄别回答缺少同回合生成的初步分析报告入口

- 复现：点击“开始 AI 甄别”后，聊天区只保存普通助手回答和流程阶段卡片，没有独立的“查看分析报告”入口；既有兼容 Prompt 虽包含简短/详细分析文字，但没有把初步问题分析冻结为可单独查看的消息字段。若点击入口再发起一个分析回合，会改变用户要求的“甄别时同时生成”，也会增加 Provider 调用并可能推进或污染流程。
- 根因：甄别结果适配层只把展示正文写入助手消息，没有在同一次 TRIAGE 结果结算时生成并持久化独立的初步分析摘要；`MessageBubble` 也没有识别该类型的本地展开控件。初步分析报告与后续验收后的流程报告因此没有稳定的数据边界和交互边界。
- 行为合同：同一个 TRIAGE AI 回合成功返回时，服务端必须从本轮甄别结果同步生成简短的“初步问题分析”并与该助手消息原子持久化，标记为 `triage_initial`；助手气泡只在存在该字段时显示“查看分析报告”。点击仅在当前气泡内展开/收起已保存内容，不调用 API、不新增用户/助手回合、不执行 AI、不改变工作流阶段、不写 TB。普通聊天、修复、验收和报告消息不显示该入口；内容必须明确尚未执行修复、测试与验收，且不能冒充后续流程报告。
- 自动化守卫：`gateway/test/devbench-prompt-mode.test.mjs` 固化兼容文本和结构化甄别结果到初步分析报告的确定性转换；compatibility overlay 与 structured `sendTurn` 集成测试分别固化同一助手消息的持久字段和原始结构化哨兵不泄露；`storyMessageModel.test.mjs` 固化按钮由持久字段驱动、仅本地展开且带遮挡保护。隔离 Chromium 通过稳定 test id 真实点击展开/收起，在 390×844 和 1440×900 检查按钮、报告边界、横向溢出及零 API 写入；全部点击遵守 Visual Operation Guard 的 `authorize -> begin -> real tool -> result`。
- 修复版本：2026-08-21 `devbench-triage-analysis-report-button-20260821` 平台工作区实现，尚未提交。
- 当前验证：新增核心合同在旧实现上稳定 2 项失败（报告生成函数缺失、消息气泡入口缺失）；候选 Prompt/UI 纯测试 90/90，compatibility/structured 同回合持久化集成 2/2，Gateway 相关聚合 183/183；Web pretest 22/22、Web 主测试 423/423、Vite production build、Node 语法、`git diff --check` 和 operation-map 校验通过。隔离页面初始仅甄别回答显示一个“查看分析报告”，真实点击后展开本轮已保存的初步分析且 API 写请求为 0，桌面仍完整可见，再次点击收起；隔离脚本拦截全部 `/api`，没有操作真实 TB。全栈静态质量门禁为 `PASS_WITH_WARNINGS / ALLOW_WITH_REVIEW`，当前工作区 0 个新增阻断项。
- 残余风险：历史甄别消息不会被追溯补写该字段；本轮没有执行真实付费 Provider、推进真实故事点、写回 TB 或验证部署后的受管 Gateway。深度质量门禁中的 Gateway 全量测试在 600 秒上限超时，因此不能声称全量 Gateway 已通过；定向聚合 183/183 只覆盖本次关联链路。正式发布 READY 未评估。构建继续报告未改的 `GitCommitReworkPanel.jsx` JSX 字符警告和既有大 chunk 警告。

## REG-20260821-DEVBENCH-070：Git Update 冲突修复把完整安全 Prompt 展示到聊天气泡

- 复现：CARB-13998 的 Git Update 产生 worktree 合并冲突后，点击 AI 修复，用户消息气泡完整展示仓库绝对路径、冲突文件白名单和六条 Git 操作限制；用户提供的 `features/StoryDev/工作流/AI修复工作流/发送消息问题/note_1.txt` 与 `launchGitConflictResolution` 构造的 `task` 逐段一致。
- 根因：冲突修复路由直接调用 `sendTurnWithDeviceRuntime(tab, task)`，没有使用对话协议已经支持的 `content / displayContent / messageInput` 分离，因此发送层把完整执行 Prompt 同时作为持久内容和用户可见正文。`StoryTab` 正确优先渲染 `displayContent`，前端不是根因。
- 行为合同：点击 Git 冲突 AI 修复后，聊天正文只显示 `修复Git合并冲突`；持久 `content` 和真正发给 AI 的 Prompt 必须继续包含目标 worktree、冲突文件白名单、逐文件 `git add -- <file>` 以及禁止 commit/push/stash/reset/clean/切分支/merge-abort 的完整约束。消息输入元数据标记 `actionKind=git_conflict_resolution`。不得缩短 AI 实际 Prompt、扩大仓库或文件范围、允许基础仓库写入，或改变现有 Git Update 和人工审核流程。
- 自动化守卫：`devbench-conversation-routes.test.mjs` 固化冲突派发的短展示、长 Prompt 和危险操作禁令；`workflow-v2-prompt-overlay-send-turn.integration.test.mjs` 通过隔离 Provider 的真实 `sendTurn` 链证明 Provider 收到完整约束，同时持久用户节点的 `displayContent/input.text` 只有短文案。隔离 Chromium 在 390×844 与 1440×900 读取真实消息 DOM，确认短文案可见、长 Prompt 不在页面、无横向溢出且 API 写请求为 0；真实 Git 和 TB 均未触碰。
- 修复版本：2026-08-21 `devbench-git-conflict-message-display-20260821` 平台工作区实现，尚未提交。
- 当前验证：新增合同在旧实现上稳定 1 项失败，候选定向与真实派发聚合 8/8；worktree 安全集成 10/11，其中基础仓库保护和本次冲突入口门禁通过，唯一失败是范围外“批量查询 WebApp 子仓”用例在测试代码 `path.resolve(candidate.resolvedPath)` 收到 `undefined`，单独重跑仍失败且本次 diff 未触及该查询链。Web pretest 22/22、Web 主测试 424/424、Vite production build、Gateway 语法、`git diff --check` 和 Visual Operation Guard operation-map 校验通过；deep 静态质量门禁为 `PASS_WITH_WARNINGS / ALLOW_WITH_REVIEW`，0 个阻断项。
- 残余风险：未在真实 CARB-13998 上再次点击 AI 修复、未调用付费 Provider、未修改其 worktree 或写回 TB；现有受管 Gateway 需正常重启或重新部署后才会加载候选。完整安全 Prompt 仍作为审计/Provider 内容持久化，只是不再展示在聊天正文；历史消息不会追溯改写。范围外批量查询集成失败仍需独立处理，不能把当前聚合声称为全通过。构建继续报告未改的 `GitCommitReworkPanel.jsx` JSX 字符和既有大 chunk 警告；正式发布 READY 未评估。

## REG-20260822-DEVBENCH-071：Codex Atlas 使用已移除的 Chat wire API 导致故事点执行前失败

- 复现：CARB-15059 点击“开始修复”后，聊天框显示 `codex-atlas` 退出码 1，错误指出 `model_providers.atlas_coding_plan.wire_api = "chat"` 已不再支持。候选前直接调用 `mergeAtlasIntoCodexToml` 可见固定生成该旧值；将同一生成器创建的隔离 `CODEX_HOME` 交给本机 `codex-cli 0.149.0` 执行只读 `features list`，稳定以相同配置加载错误退出 1。
- 根因：Atlas 的 Codex provider 生成器仍沿用旧 Chat 传输值，而当前 Codex 配置协议只支持 Responses；故事点 CLI 路径和 app-server 路径都从该 canonical 生成器复制配置，所以尚未发起模型请求就会失败。
- 行为合同：Atlas Codex provider 必须显式生成 `wire_api = "responses"`，且不得再生成 `chat`；故事点独立 `.codex-atlas`、app-server 进程级临时 `CODEX_HOME` 和设置页全局 Codex 合并继续共用同一生成器。Atlas provider id、Base URL、模型、认证、其它 TOML/provider、MCP 注入、备份和隔离目录契约保持不变。
- 自动化守卫：`gateway/test/atlas-client-config.test.mjs` 固化故事点隔离配置、重复合并和旧值排除；`gateway/test/codex-minimax.test.mjs` 固化 app-server 临时配置同样使用 Responses。真实 Codex CLI 的只读配置加载作为测试实现之外的独立 Oracle，不发送 Prompt 或付费请求。
- 修复版本：2026-08-22 `CARB-15059-codex-atlas-wire-api-fix` 平台工作区实现，尚未提交。
- 当前验证：同一合同基线退出 1、候选退出 0；故事点隔离配置与 app-server 临时配置分别经真实 `codex-cli 0.149.0 features list` 加载成功。Atlas/Codex 定向先为 18/18，扩展到配置、app-server、MCP、元数据与消息协议聚合为 50/50；三份 Node 语法检查通过。deep 质量门禁中静态审计 0 阻断、Web 全套测试与 Vite production build 退出 0；浏览器因无 UI/DOM/布局改动且存在更高优先级结构化 Oracle 标记 `SKIPPED`，包体因无评审基线标记 `NO_BASELINE`。Gateway 277 文件全量在 600 秒上限退出 2，已完成部分出现未修改链路的 Hermes 临时 Prompt、remote-agent cursor、故事点 tempFiles 和进程 supervisor 失败，最终为 `ETIMEDOUT`，不得声称 Gateway 全量通过。
- 残余风险：本轮没有调用 Atlas 付费 Responses 端点、没有在真实 CARB-15059 再次发送消息或推进 TB；当前受管 Gateway 需正常重启或重新部署后才会加载候选。Atlas 服务端对 Responses API 的真实兼容性仍需首次隔离请求确认；范围外 Gateway 全量失败与超时未在本任务内修复，正式发布 READY 未评估。

## REG-20260822-DEVBENCH-072：持久消息投影缺少 ID 导致编辑重新发送查不到节点

- 复现：CARB-15059 的用户消息已经持久化到 conversation graph，用户在聊天框打开该消息的“编辑”，修改正文并点击“重新发送”，页面提示“要编辑的消息不存在或不属于当前故事点”。只读 `/conversation` 快照显示活动路径 8 条 `messages` 全部没有 `id`，同响应 `conversation.nodes/activePathIds` 则都有真实 UUID；第 7 条用户消息在旧页面被合成为 `legacy:user:3:1787366737268:6`，而 graph 节点 ID 为 `573d268b-1357-4bbe-8d40-64047de874d8`。
- 根因：为了保持旧线性消息和备份的原始字段，legacy projection 会删除 normalize 阶段生成的 `id`；`StoryTab` 渲染和编辑动作只调用 `messageStableId(message, index)`，没有把同响应中权威的活动路径身份接回展示消息。后端编辑接口按 `conversation.nodes[].id` 精确查找，因此 UI 合成 ID 必然返回 `CONVERSATION_MESSAGE_NOT_FOUND`。这与未落盘发送失败消息走普通 `/send` 的既有重试分支不同。
- 行为合同：有显式消息 ID 时必须始终优先使用显式值；显式 ID 缺失时，只允许在同一 conversation 的 `activePathIds[index]` 存在对应节点且角色、正文与展示消息一致时恢复 graph UUID，否则保守保留 legacy fallback。持久用户消息的编辑、引用、跳转和版本导航统一使用恢复后的身份；编辑重新发送继续创建不可变分支并携带 revision CAS，不得改成普通发送。未落盘的本地失败消息仍按既有合同复用普通 `/send`，legacy 落盘和备份格式不变。
- 自动化守卫：`conversationGraphModel.test.mjs` 固化 graph UUID 恢复、显式 ID 优先和不匹配时失败关闭；`storyMessageSendModel.test.mjs` 继续保护本地失败消息的普通发送路径。Visual Operation Guard operation-map 新增 `verify_devbench_persisted_message_edit_resend`，隔离 Chromium 使用“messages 无 ID + graph 有 UUID”的 CARB-15059 同形响应，真实点击消息、编辑、输入和重新发送，并拦截全部 API。
- 修复版本：2026-08-22 `CARB-15059-chat-edit-resend-id` 平台工作区实现，尚未提交。
- 当前验证：同一只读 CARB-15059 快照的身份断言在基线退出 1（`legacy:user:3:1787366737268:6 != 573d268b-...`），候选退出 0，8 条活动路径消息全部恢复为对应 graph ID；消息图与本地失败重试定向测试 7/7、conversation 后端模型/路由兼容 11/11、Web pretest 22/22、Web 主测试 425/425、Vite production build、Node 语法、Visual Operation Guard operation-map 校验和全工作区 `git diff --check` 通过。隔离 Chromium 中持久用户消息 DOM ID 为真实 UUID，四个 DOM 动作均完成 Guard `authorize -> begin -> result`，最终只产生一条被拦截的 `POST .../conversation/edit-and-resend`，载荷使用真实 UUID、revision 11 和外部状态确认，没有调用 `/send`，真实故事点和 Provider 均未触碰。deep 质量门禁静态审计 0 阻断，包体与浏览器审计均为 `NO_BASELINE` 且 0 阻断；浏览器仅记录一个 390px `/devbench` 资源 404 控制台 P2 Finding。Gateway 277 文件全量在 600 秒退出 2 并 `ETIMEDOUT`，已完成部分复现未修改链路的 Hermes 临时 Prompt、remote-agent cursor、故事点 tempFiles 和进程 supervisor 失败。
- 残余风险：本轮没有在真实 CARB-15059 上点击重新发送，以免重放业务 Prompt、修改其目标 worktree 或触发来源副作用；真实页面需在 Web 候选重新部署/刷新后验证。身份恢复依赖服务端 `messages` 与 `activePathIds` 保持同一活动路径顺序；角色或正文不一致时会失败关闭为 legacy ID，不会猜测关联。deep 总报告因范围外 Gateway 全量失败/超时为 `BLOCK`，不能声称整个工作区全套通过；构建仍报告未改 `GitCommitReworkPanel.jsx` JSX 字符与既有大 chunk 警告，浏览器审计无评审基线。正式发布 READY 未评估。

## REG-20260822-DEVBENCH-073：历史超大回答阻塞故事点页面交互

- 复现：打开 CARB-15059 后输入框约 2.2 秒出现，但首次聚焦被主线程阻塞约 38.2 秒；PerformanceObserver 记录 8 个超长任务，单次最长约 9.7 秒。页面把一条 1,090,427 字符的 Codex JSONL 过程流当作普通 Markdown 正文，并同步执行 Markdown、产物引用和附件路径扫描。另一个历史故事点的会话响应达到 43,288,911 字节，说明旧数据会持续扩大读取和序列化成本。
- 根因：`agent-runner` 只对精确的 `codex` 引擎解析 JSONL，`codex-atlas` 落入通用 stdout 累积路径，把 `thread.started/item.completed/turn.completed` 原始事件整体保存为最终回答；Store 只在新写入时压缩 transcript，读取旧会话不压缩投影；前端对任意长度正文都立即运行 Markdown 和产物扫描，三层缺少共同的体积边界。
- 行为合同：所有 Codex CLI 变体必须复用 Codex JSONL 解析并只持久化最后一条 `agent_message`；读取旧会话时仅压缩内存/响应投影，不改写原始历史文件；超过 64 KiB 的聊天正文首屏只展示 4,000 字符纯文本预览，跳过 Markdown、裸产物引用和附件路径扫描，用户显式展开时在固定高度只读纯文本区查看完整内容。正常消息、显式附件、消息编辑/引用和既有 Codex 官方认证恢复语义保持不变。
- 自动化守卫：`storyMessageModel.test.mjs` 固化大正文有界预览与显式纯文本展开；`devbench-store-async-write.test.mjs` 固化旧 transcript 读取投影压缩且源文件字节不变；`agent-timeout.test.mjs` 固化 `codex-atlas` 只保存最后一条 agent 消息；`operation-map.json` 的 `verify_devbench_oversized_message_responsiveness` 记录真实只读页面的聚焦、输入和展开检查，并拦截所有写方法。
- 修复版本：2026-08-22 `devbench-web-startup-freeze-20260822` 平台工作区实现，尚未提交。
- 当前验证：专项 Web 13/13、Gateway Store/Codex JSONL 14/14、Atlas Runner 1/1、Web pretest 22/22、Web 主测试 426/426、Vite production build、两份 Gateway 语法和 `git diff --check` 通过。真实 CARB-15059 只读页面的输入框出现约 2.35 秒、首次聚焦约 5 毫秒、39 字符输入约 160 毫秒；首屏超大消息 DOM 约 4,065 字符，完整 1,090,427 字符展开约 482 毫秒、收起约 23 毫秒。隔离脚本拦截了 2 个既有附件票据 POST，没有写入真实故事点。真实 28,485,010 字节旧会话复制到隔离 Store 后，候选响应投影为 1,559,264 字节，缩小约 94.5%，源文件保持不变。deep 全栈门禁的静态审计为 `PASS_WITH_WARNINGS` 且 0 阻断，包体为 `NO_BASELINE` 且 0 阻断，浏览器覆盖 66 个路由/视口场景并为 `NO_BASELINE`、0 阻断；总门禁仅因 Gateway 全仓测试在 600,014 毫秒上限退出 2 而为 `BLOCK`。
- 残余风险：当前运行中的 Gateway 尚未重启，所以前端 HMR 已加载候选，但受管 Gateway 仍需正常重启或重新部署才会加载读取投影和 Runner 修复；没有再次调用付费 Atlas Provider。`agent-timeout.test.mjs` 全文件 24/25，唯一失败为本次未修改的 Hermes 临时 Prompt 引用用例，Atlas/Codex 关联用例均通过；构建继续报告未改 `GitCommitReworkPanel.jsx` JSX 字符警告和既有大 chunk 警告。正式发布 READY 未评估。

## REG-20260822-DEVBENCH-074：TB 状态流转遇到必填弹窗后只提示人工处理

- 复现：DevBench 工作流调用 TB 状态流转时，`PUT /api/tasks/{taskId}/taskflowstatus` 返回 `MissingRequiredField`，旧实现立即提示用户去 TB 手工填写，无法继续到工作流已选择的目标状态。用户提供的 TB 网页抓包证明成功顺序是先写任务标签、应用分类、缺陷分类和复现概率，再携带任务类型配置重试状态流转。
- 根因：`gateway/services/teambition.js::updateTaskStatus` 没有必填字段恢复分支；状态请求缺少 `_scenariofieldconfigId`，并使用了与网页成功请求不同的 `persistentValidatorEnable`。项目标签读取还没有优先使用抓包中的 `/api/tags?tagType=project&_projectId=...` 端点。
- 行为合同：目标状态继续只在任务所属 taskflow 内解析。仅当 TB 明确返回 `MissingRequiredField` 时，读取当前任务、项目标签、任务类型字段和选项 ID；保留已有标签及人工字段值，空值按已确认规则填写（`P162-G -> Geely`、应用分类 `App Market`、缺陷分类 `功能使用BUG`、复现概率 `一般`），通过 `/api/v2/tasks/{taskId}` 写入后只重试一次原目标状态。任务类型、标签或选项无法唯一解析时失败关闭，不猜测、不绕过 TB 校验。
- 自动化守卫：`gateway/test/teambition.test.mjs` 固化抓包请求体、`P162-G` 标签映射、场景配置状态载荷、写后回读、已有人工值保护和无法解析时零任务字段写入；既有 TB 工作流 Saga 与 durable operation 测试继续保护状态回写的幂等、回读和失败隔离。
- 修复版本：2026-08-22 `DEV-BENCH-TB-REQUIRED-TRANSITION-20260822` 工作区实现，尚未提交。
- 当前验证：新增抓包合同在基线稳定失败；候选定向 3/3、Teambition 全文件 44/44、TB 工作流与 durable 聚合 46/46、共享 `listProjectTags` 的飞书同步回归 111/111、Web 426/426 和 Node 语法通过。经用户明确授权，真实 `CARB-15125` 从“待处理”流转到“可提测”；独立 Cookie 详情回读确认状态 ID 为 `65a5f2745a1f7b88c7a289f2`、标签为 `Geely`，三个字段分别为 `App Market / 功能使用BUG / 一般`。
- 残余风险：真实写入只覆盖平台组件项目与 `P162-G` 语义；其它无法唯一命中的车型标签会保持失败关闭，需要基于新的原始证据扩展别名。当前受管 Gateway 需正常重启或重新部署后才会加载候选。用户提供的抓包文件含现存 TB 会话凭据，本轮没有复制或提交凭据，相关凭据仍应轮换；正式发布 READY 未评估。

## REG-20260822-DEVBENCH-074：API Provider 响应静默导致故事点 AI 假活

- 复现：CARB-15124 的 API Agent 在 `run_command` 返回后不再产生聊天流、工具调用或错误消息；目标 Gradle 命令已经失败退出，但数据库任务、Agent 状态和 Gateway 运行租约仍持续显示运行中。用同一命令和工具执行边界复测可正常返回，排除 `run_command` 自身等待子进程关闭的假设；旧 `executeApiEngine` 对下一轮 Provider 请求只绑定用户停止信号，Provider 不发首包或流中途静默时会无限等待。
- 根因：API Agent 的主循环没有首包超时和响应流空闲超时；`fetch` 与 `reader.read()` 只响应人工停止，网络连接仍打开但没有新字节时 Promise 不会结算，Agent Runner 因此无法进入失败收尾、清除运行 Agent 和释放租约。
- 行为合同：每次 Provider 传输尝试必须有独立首包看门狗；收到任意原始流数据后切换为空闲看门狗并在每个后续数据块上续期。首包或空闲超时必须中止 fetch/reader、抛出可识别的终态错误、保留 transcript/telemetry，并沿既有异常路径广播 `chat_stream_end(success=false)`、把 Agent 标为 error 和释放本轮运行槽位。用户手动停止仍保持 `userStopped` 语义；工具执行时长不纳入 Provider 流空闲计时。
- 自动化守卫：`gateway/test/api-engine.test.mjs` 使用永不闭合的真实 `ReadableStream` 分别固化“首包静默”和“收到首段后静默”，证明在测试安全中止之前抛出 `API_PROVIDER_FIRST_CHUNK_TIMEOUT` 或 `API_PROVIDER_STREAM_IDLE_TIMEOUT`，且请求信号已中止；`gateway/test/agent-timeout.test.mjs` 再通过真实 `runTask` 的 Atlas 路由证明终态错误、失败遥测和运行 Agent 均已收敛，同时继续保护人工停止语义。
- 修复版本：2026-08-22 `CARB-15124-HARNESS-RUNSHELL` 平台工作区实现，尚未提交。
- 当前验证：两条新增合同在旧实现上均只能等到测试安全中止并失败；候选 Provider/流式收尾/人工停止/Atlas `runTask` 聚合 11/11 通过。deep 质量门禁中 Web pretest 22/22、Web 主测试 426/426、production build 和静态 0 阻断均通过；Gateway 全仓在 600 秒退出 2，已执行部分除本次相关用例通过外，复现了既有 Hermes Prompt、remote-agent cursor、进程 supervisor 与故事点进程快照失败。快照原始证据显示 Node.js 24.14.1/Windows 下 `node -e` 引号被既有 `start_process` 路径破坏并以 `Unterminated string constant` 退出 1，与 Provider 看门狗路径无直接关系。
- 残余风险：当前受管 Gateway 尚未重启或部署，运行中 CARB-15124 不会热加载服务端候选；本轮没有重新发送真实故事点消息、调用付费 Provider、停止现有任务或修改目标 Android worktree。默认首包 90 秒、流空闲 120 秒是故障收敛上限，仍需在真实 Provider 负载中观察是否需要配置化调优；正式发布 READY 未评估。

## REG-20260822-DEVBENCH-075：MiniMax 响应前瞬时传输失败直接终止故事点执行

- 复现：CARB-15125 使用“MiniMax·MiniMax-M3·默认档位”执行时，Provider 已多轮返回思考、文本和工具调用，但后续一轮在等待响应约 5 分钟后以原始 `fetch failed` 终止；同一配置人工重试随后能够完整执行成功，另一次长执行又在相同阶段失败。候选前的隔离回归用 `TypeError(fetch failed) -> cause.code=ECONNRESET` 复现为首次请求立即失败、无第二次请求，退出码为 1。
- 根因：API Agent 只对 HTTP `stream_options` 不兼容做一次重试；`fetch` 在返回响应前遇到连接重置、DNS 暂态错误或 Undici 连接/响应头超时会直接穿透到 Runner。异常路径还只保留顶层 `fetch failed`，丢失 `error.cause.code`，无法区分可恢复网络抖动与证书、URL 等不可重试配置错误。事故日志没有保存底层 cause，因此历史两次失败的精确传输码仍为 `UNKNOWN`；“瞬时响应前传输失败”是由成功重试、时序和当前代码共同支持的最强解释，不冒充已证明的唯一原因。
- 行为合同：同一 Provider 请求只有在尚未返回任何响应时，才允许对明确列入白名单的瞬时传输码或首包等待超时做至多一次短延迟重试；收到响应并进入流读取后不得自动重放，避免重复工具副作用。用户停止、证书错误、非法 URL、HTTP 业务错误和未知非传输异常不得重试。失败消息只暴露安全的传输码，不记录 API Key、Authorization、Prompt 或请求体；重试原因和每次请求 outcome 必须写入既有 telemetry，并向聊天流发送一次简短重试状态。
- 自动化守卫：`gateway/test/api-engine.test.mjs` 固化 MiniMax 连接重置后成功、首包超时后成功、证书错误不重试、流阶段静默不重放及 transport telemetry；`gateway/test/agent-timeout.test.mjs` 通过真实 `runTask`/MiniMax 路由证明一次连接重置可自动恢复、任务持久化为 completed 且运行 Agent 被释放。既有 `stream_options` 兼容、人工停止、流式收尾和 MiniMax `<think>` 解析回归继续保护关联半径。
- 修复版本：2026-08-22 `CARB-15125-MINIMAX-FETCH` 平台工作区实现，尚未提交。
- 当前验证：基线新增 MiniMax Runner 回归 0/1、API Engine 三条传输合同 0/3；候选 API Engine 定向 11/11、Runner 定向 4/4、MiniMax think-tag 3/3、telemetry/dispatcher 聚合 2/2、Web pretest 22/22、Web 主测试 426/426、Vite production build、Node 语法和 `git diff --check` 通过。deep 影响图 PASS；静态审计为 `PASS_WITH_WARNINGS` 且 0 blocker，只报告本次修改的大文件维护性提示和一条既有静默空值提示。Gateway 两个全文件套件分别为 34/35 与 26/27，失败均为任务前已知且未改动的 Windows `start_process` 外置产物用例和 Hermes 临时 Prompt 引用用例，MiniMax 专项均通过。当前主机对 `api.minimaxi.com:443` 的 TCP 检查成功，Node 24 未携带凭据访问 `/v1/models` 得到预期 HTTP 401，证明验证时刻本机 DNS/TCP/TLS/Node fetch 路径可达；未发送真实 API Key 或付费 Prompt。
- 残余风险：历史生产日志只保存顶层错误，无法追溯两次故障究竟是连接重置、DNS 还是响应头超时；一次有界重试只能吸收单次瞬时故障，连续故障仍会安全失败并显示传输码。当前 Gateway/Web 未运行，本轮没有启动或重启 Service Control、没有在真实 CARB-15125 上重新发送消息、没有调用付费 MiniMax，也没有修改其脏 Android worktree；部署加载与真实 Provider 复验仍未执行，正式发布 READY 未评估。

## REG-20260822-DEVBENCH-076：独立 Gateway 无法发布车型配置到当前服务

- 复现：本机 `127.0.0.1:3001` 的 `team/production/vehicle-source` 有 12 个车型且包含已发布的 `geelyp162`；局域网地址 `172.16.129.94:3301` 对应另一个 `team/profile:development-3/vehicle-source`，只有 8 个车型且不含 `geelyp162`。两端均为 `syncMode=disabled`、成员数 0。旧实现即使管理员已经完成车型变更预览与确认，仍以 `LAN_SYNC_PUBLISH_DISABLED` 拒绝提交，因此目标独立服务既不能接收 JSON 导入，也不能维护单项车型配置。
- 根因：发布策略把“不参与 Gateway 节点间投递”错误等同于“禁止当前 Gateway 修改自己的共享快照”。前端仍展示草稿、预览和发布入口，导入也已经改走受治理的变更集，却没有独立服务提交语义；同时把零成员提交统一称为“发布到团队”，掩盖了不同运行 profile、配置空间和服务地址之间不会自动同步的边界。
- 行为合同：`disabled` 独立服务允许有发布权限的管理员在显式预览和确认后原子提交到当前 Gateway，继续执行配置空间校验、实体基线、冲突检测、幂等键、事务、审计和 WebSocket 刷新，但不创建或伪造成员投递；所有访问同一 Gateway 的浏览器读取一致结果。`peer` 继续执行团队投递与 mTLS 门禁，`receive-only` 继续拒绝发布。不同 profile/配置空间不得自动互相覆盖，跨 Gateway 迁移仍通过导出、目标服务导入 dry-run 和确认发布完成。
- 自动化守卫：`gateway/test/lan-sync.test.mjs` 固化 disabled 本地提交、零投递、独立审计和 `receive-only` 拒绝；`gateway/test/lan-sync.integration.test.mjs` 通过真实受保护 HTTP 发布接口写入 `geelyp162` 并由同一服务的读取接口回读；`vehicleSourceAdminState.test.mjs` 固化独立服务、peer 与只接收节点的用户可见语义。
- 修复版本：2026-08-22 `DEVBENCH-VEHICLE-SOURCE-LAN-SYNC-20260822` 平台工作区实现，尚未提交。
- 当前验证：只读基线证据确认两端项目 ID 相同但配置空间、版本和车型集合不同；旧实现隔离脚本退出 1 并返回 `LAN_SYNC_PUBLISH_DISABLED`。候选 LAN 同步单测 19/19、独立 Gateway HTTP 集成 1/1、车型前端模型 6/6、Web pretest 22/22、Web 主测试 428/428、Node 语法和 `git diff --check` 通过。
- 残余风险：`172.16.129.94:3301` 仍运行旧候选且真实共享库尚未写入 `geelyp162`；本轮没有重启、部署或直接修改远端数据库，也没有绕过目标服务管理员确认。部署后仍需管理员在目标 3301 页面导入本机导出的车型 JSON、确认 dry-run 只新增/修改预期条目并发布，再由另一台浏览器回读；正式发布 READY 未评估。

## REG-20260822-DEVBENCH-077：跨机器 Gateway 更新代码后仍读取各自的旧车型配置

- 复现：`172.16.129.94:3101` 已加载与当前候选一致的 Web 产物，但 `profile:development` 仍只有 8 个车型、不含 `geelyp162`；本机 Gateway 的另一个运行数据库有 12 个车型并包含该配置。3101 的持久配置请求 `lanSync.syncMode=peer`，运行态却显示 `disabled · Server1`，成员数和连接数均为 0。
- 根因：车型映射是 Gateway 运行数据库，不属于 Git/前端构建产物，拉代码和重新编译不会迁移数据。3101 的 peer 请求又因未配置双向 mTLS 被安全策略降级为 disabled；旧中心转发只能复用 `claudeProxyClient.enabled/host/token`，没有独立的车型配置来源入口，因此不使用远端 AI 的 standalone 节点只能继续读取本地旧快照。
- 行为合同：管理员可为车型源码配置单独设置中心 Gateway origin 和用途独立的 M2M 口令，不要求启用或切换 AI 代理；启用时 origin 同步加入显式 trusted peers。安全 peer 模式继续优先且必须使用 mTLS。显式中心缺地址、缺口令、指向自身、不可信或不可达时必须失败关闭，前端隐藏浏览器旧缓存并显示真实错误，不得静默回退本地旧数据。车型页同时展示本机 profile、实际配置来源和本机同步角色；本机 cloneParent 继续保留，不从中心传播。
- 自动化守卫：`gateway/test/vehicle-config-center.test.mjs` 固化路由优先级、自引用和缺配置失败关闭；`vehicle-center-forward-auth.test.mjs` 固化车型专用口令不会落到 AI 口令；`forward.integration.test.mjs` 以多个真实 Gateway 进程证明 standalone 在关闭 AI 代理时仍能读取中心车型映射、中心不可达时失败关闭且 cloneParent 留在本机；`config-admin.integration.test.mjs` 保护中心口令脱敏、掩码回传与 `lanSync` 管理员边界；`vehicleSourceAdminState.test.mjs` 保护中心来源和 mTLS 降级诊断文案。
- 修复版本：2026-08-22 `DEVBENCH-VEHICLE-SOURCE-CENTER-20260822` 平台候选。
- 当前验证：3101 与当前部署 chunk 名称、字节数和 SHA-256 一致，排除旧前端；只读 API 同时证明 3101 请求 peer 但因 mTLS 未配置降级为 disabled，且没有中心 host、成员或连接。候选 Gateway 相关测试按文件隔离 7/7、用例 40/40，配置管理员边界定向 2/2，Web pretest 22/22、主测试 430/430，Vite production build 通过；deep 静态质量审计为 `PASS_WITH_WARNINGS` 且 0 个新增阻断项。
- 残余风险：中心 Gateway 地址和跨机口令属于部署凭据，不能写死进 Git；`172.16.129.94:3101` 在管理员通过新设置入口连接到实际含 `geelyp162` 的来源 Gateway 前，运行数据不会自行改变。当前机器无法证明 3101 到来源地址的反向网络可达性，也未持有远端管理员会话，因此没有直接写远端配置或数据库。正式发布 READY 未评估。

## REG-20260822-DEVBENCH-078：车型配置同步依赖 profile、固定中心与 mTLS，陈旧节点打开时存在反向覆盖风险

- 复现：本机 production Gateway 有 12 个车型且包含 `geelyp162`，局域网 development Gateway 只有 8 个车型；两端代码与 Web 制品一致，配置仍因 `team/production/vehicle-source`、`team/profile:development/vehicle-source` 分隔。远端请求 peer 同步时又因未配置双向 mTLS 降级为 disabled。旧实现还会在同步初始化和 `/remote-config/initialize` 只读入口自动创建基线操作，导致一台配置更少的陈旧节点仅启动、加入或打开页面时可能把本机快照当成新写入传播。
- 根因：运行 profile 被错误纳入车型团队空间身份；节点 ID 来自可随配置复制的 `servers.nodeId`；peer 传输把整套 Gateway HTTPS/mTLS 证书当成前置条件；同步初始化把”读取本机现有配置”和”管理员明确发布”混为同一个写操作。旧中心模式还要求人工填写 host、token、CA、cert、key 和多个开关，不能满足轻量局域网运维。
- 行为合同：车型配置固定使用共同空间 `team/vehicle-source`，不区分 production/development，也不指定唯一中心。每个 Gateway 使用本机 Ed25519 身份派生唯一节点 ID；管理员在任一成员上明确发布的车型变更按签名操作、版本向量、ACK/outbox 和冲突规则传播。首次管理员点击”建立同步组”是唯一允许把已有配置显式播种的动作；加入码只接收组内版本，启动、刷新、打开配置页、初始化工程或加入同步组均不得外发本机旧快照。管理员明确加入新组时，节点先停止旧组会话并原子清除旧操作、成员、投递、冲突和游标，仅保留本机车型/仓库物化快照与不可复用的签名序号；旧组的同名已签名操作也不得进入新组。加入后会话使用临时 X25519 密钥协商和 AES-256-GCM 加密，加入码为十分钟有效、一次使用且与加入节点公钥绑定的 256 位 HMAC 证明；mTLS 仅保留为可选纵深加固，不再是同步前置条件。
- 自动化守卫：`gateway/test/lan-sync-channel-crypto.test.mjs` 固化密钥方向、篡改和重放拒绝；`gateway/test/lan-sync.test.mjs` 固化统一团队空间、身份派生和显式发布边界；`gateway/test/lan-sync.integration.test.mjs` 用三个真实隔离 Gateway 固化”一次性加入、带同名旧组签名操作的节点不反向传播、只读打开不外发、管理员发布、预认证失败重连、成员转发、断线续传”；`gateway/test/lan-sync-mtls.test.mjs` 与 `discovery-policy.test.mjs` 固化应用层加密默认启用且可选 mTLS 仍可强制；`ui-smoke.mjs` 经 Visual Operation Guard 使用真实 DOM 点击，固化打开页零发布、点击一次只创建一次邀请以及 390px 控件不裁切。
- 修复版本：2026-08-22 `DEVBENCH-VEHICLE-SOURCE-LAN-SYNC-20260822-R5` 工作区实现，尚未提交。
- 当前验证：加密、LAN 策略、车型中心兼容和前端状态定向回归 46/46 通过；三节点/双节点/独立服务集成 3/3 通过，20 次同步延迟样本 P95 约 75ms；隔离 Chrome 真实 UI 点击通过，打开页面没有发布请求，管理员点击后恰好产生一次邀请请求，390px 输入与按钮均为 94px 且无重叠、越界或脚本错误。深度全栈门禁中影响图、Web 测试、Vite production build 和静态审计均通过，静态为 0 blocker；Gateway 全仓在 600 秒上限退出 2，已完成部分复现 5 个未修改链路的既有失败，单独重跑为 83/89、5 失败、1 跳过，涉及 Hermes 临时 Prompt、remote-agent cursor、故事点临时进程快照和 Windows 进程 supervisor。因此本次专项候选证据通过，但全仓总门禁不能声明通过。
- 残余风险：本轮没有重启、部署或写入 `172.16.129.94:3101` 的真实服务，也没有在未受控生产数据上创建同步组；远端只有部署新候选并由管理员执行一次配对后才会加入共同团队。设备私钥和加入码无需购买证书，但设备身份文件仍需随 Gateway 数据目录安全保存；若组织要求额外的网络层双向认证，可继续使用自签或内部 CA 的免费 mTLS 证书并自行承担签发、分发与轮换运维。正式发布 READY 未评估。

## REG-20260822-DEVBENCH-078-B：故事点初始化缺少通用工程并把 WebApp Flavor 和工作区布局等同于主工程

- 复现：故事点初始化选择”本机工程 → 按车型/Flavor”时，只能看到车型映射中的主工程和 WebApp，SDK 与 AIEfficiency 不可选择；WebApp 直接沿用主工程的 `geelyp162`，但其实际 Flavor 是独立的 `spotify/youtube`。`CARB-15190` 的两个仓库分别位于 `geely_e22_CARB_15190` 与带时间戳的平铺目录，`workspaceBundle` 为空，没有 `.aiefficiency/workspace.json`。
- 根因：初始化选项只从车型映射生成，把关联仓库类别与 Flavor 继承混为同一规则；同远端仓库的旧推断按首个项目定义命中，使 SDK 逻辑身份被 AppMarket 遮蔽；AppMarket 默认工程配置没有声明 Bundle。旧工作区切换到固定兄弟目录时，重建预览又没有把 Bundle 拓扑和成员模式变化纳入安全重建，导致旧 EDITABLE WebApp 直接迁移为 READ_ONLY 时状态不一致。
- 行为合同：车型映射中的目标工程保持必选，repository、SDK、tooling、service 类工程作为可选通用工程追加；WebApp 只与主工程建立车型关联，不继承主工程 Flavor，所有通用工程各自按本机项目定义选择 Flavor。相同远端仓库必须以 `defaultBranch` 等稳定身份区分逻辑工程。AppMarket 默认创建 Bundle V2，成员固定为同一父目录下的 `AppMarket`（EDITABLE）与 `AppMarketWeb`（READ_ONLY），严格使用同一逻辑分支，并生成 `.aiefficiency/workspace.json`。旧布局或成员模式变化必须先生成安全检查与确认令牌；存在脏改动、未推送提交、stash 或保护冲突时失败关闭，不得强制迁移。
- 自动化守卫：`storyInitializationModel.test.mjs` 固化 SDK/AIEfficiency 可选通用工程、WebApp 独立 Flavor 与无效车型 Flavor 丢弃；`store.test.mjs` 固化同远端分支身份、旧绑定兼容别名、默认 Bundle 与显式禁用；`worktree-rebuild.test.mjs` 固化 Bundle 拓扑签名和拓扑变化安全重建；`worktree-routes.integration.test.mjs` 固化独立 WebApp 的 HTTP 重建路径；既有 workspace-bundle 与 worktree-manager 套件继续保护固定目录、严格分支、回滚、并发预约、junction 防护、清理令牌和锁。
- 修复版本：2026-08-22 `story-init-local-flavor-bundle-carb-15190` 平台工作区候选，尚未提交。
- 当前验证：模型测试 38/38、Store 93/93、重建单测 6/6、Bundle/worktree-manager 核心聚合 53/53、独立 WebApp HTTP 路由 1/1、Web production build 和 Node 语法通过。受控 Chromium 真实点击验证 SDK、AIEfficiency 与独立 WebApp Flavor 均可选择，390×844 无横向溢出且无页面错误。真实 `CARB-15190` 已迁移到 `WorktreeSpace/CARB-15190-2d267be5/{AppMarket,AppMarketWeb}`，元数据 SHA-256 为 `5F6BE3D297538DD5BA0978063140203792AD4E7E3A7EE85B86B4A56220F2D598`，Gradle Bundle 预检 `BUILD SUCCESSFUL`，新旧 worktree 清洁状态和旧目录清理均已回读。
- 残余风险：完整 Gateway 质量命令在 600 秒上限超时，未获得全仓 Gateway 通过证据；一个范围外 Windows worktree-lock 慢用例单独运行仍超时。Web 构建继续报告既有 `GitCommitReworkPanel.jsx` JSX 字符和大 chunk 警告。UI 打开初始化面板会执行既有的本地配置推断记录 POST，但未创建临时故事点、未调用付费 Provider，也未写回 TB 状态；正式发布 READY 未评估。

## REG-20260822-DEVBENCH-079：本机 Flavor 映射选择完成后”下一步”仍校验旧草稿

- 复现：在故事点初始化的”本机工程 → 按车型/Flavor”中选择 `geelyp162`，明确选择 AppMarket、WebApp、WebApp 独立 Flavor 以及可选 SDK/AIEfficiency 后，不点击右上角”应用此 Flavor 映射”而直接点击页脚”下一步”，页面仍停在工程范围。受控 Chromium 基线退出 1，证据为 `DIRECT_NEXT_BLOCKED {“buildVisible”:false,”alerts”:[]}`；Gateway 同期没有收到下一步或工程映射请求。
- 根因：工程下拉只更新 `localFlavorProjectSelections/localFlavorSelections`；只有独立”应用”按钮才把解析结果写入 `draft.primaryProjectId/extraProjectIds/flavorByProjectId`。页脚 `goNext()` 直接校验闭包中的旧 `draft`，因此把界面上已经完整且有效的映射误判为没有主工程。这是浏览器本地状态衔接缺陷，不是 Gateway、项目路径或车型配置异常。
- 行为合同：在本机 Flavor 子页点击”下一步”时，必须复用 `applyStoryLocalFlavorMapping` 对当前可见选择做一次原子解析；解析成功后校验并保存同一个新草稿，再进入构建设置。独立”应用此 Flavor 映射”入口继续保留；按当前分支、远程工程、编辑故事点和所有分支/路径/必需项校验不变。映射无效时仍停留当前页并显示 canonical 错误，不得靠放宽校验继续。
- 自动化守卫：`storyInitializationModel.test.mjs` 固化 `goNext()` 必须识别 Flavor 模式、复用 canonical 映射函数并校验新草稿；`.ai/operation-map.json` 的 `verify_story_initialization_local_flavor_common_projects` 固化”不点击单独应用按钮，直接下一步进入构建设置”，同时保护 WebApp 独立 Flavor、SDK/AIEfficiency、零故事点创建和 390px 无横向溢出。
- 修复版本：2026-08-22 `devbench-geelyp162-local-mapping-next-step` 平台工作区候选，尚未提交。
- 当前验证：新增定向用例在旧实现 0/1、候选 1/1；同一 3100/3101 服务的受控 Chromium 在旧实现退出 1，候选退出 0 并真实进入构建设置。全程 15 次 DOM 动作遵循 `authorize -> begin -> result`，页面错误 0，非预期写请求 0，`/api/devbench/tabs` 写入 0，390×844 的 body/root scrollWidth 均为 390；唯一写请求是打开面板时既有的本地配置推断 run POST。
- 残余风险：本轮只修复工程范围页的本地状态衔接，不改变推断 run 的既有触发语义；尚未执行确认创建，因此没有重复创建真实故事点或 worktree。正式发布 READY 未评估。

## REG-20260823-DEVBENCH-079：局域网车型同步仍要求人工建组且 5 秒发现写库

- 复现：上一候选虽然统一了 `team/vehicle-source` 并提供加密 WebSocket 增量同步，但设置页仍要求管理员建立同步组、复制加入码并在其它设备逐台加入；发现服务每 5 秒广播，未知节点会直接 `pairMember` 并绕过管理员校验播种本机现有配置，已配对成员也随发现包反复更新 `last_seen_at/updated_at`。这既不符合“管理员正常编辑后其它局域网设备自动同步”的零配置目标，也会让启动或陈旧节点发现成为旧快照传播入口。
- 根因：发现、授权、在线状态和配置播种没有分层：UDP 广播同时承担心跳、自动信任、成员持久化和首次基线发布；同步启用又被放在独立设置流程，而不是绑定已有的管理员车型发布治理入口。单个 UDP 包没有丢包补偿，若 HTTP 已健康但 socket 尚未 bind，首次发布通知会丢失并退化到周期等待。
- 行为合同：不提供同步开关、建组、加入码或逐台确认 UI。新安装默认 `disabled`，只有管理员在“车型源码配置”完成一次真实、非 no-op 的受保护发布时，系统才按共同 `teamConfigSpace` 自动生成确定性组 ID、把该管理员已经维护的现有车型/仓库配置建立为基线并启动同步；预览、打开、刷新、启动和 UDP 发现均不得播种。其它同广播域 Gateway 验证设备签名、节点 ID、公钥指纹、私有 origin、协议、配置空间和确定性组 ID 后自动加入，只接收组内操作，不上传其本机无操作日志的陈旧快照。UDP socket 持续异步监听，启动、首次发布、IP 或拓扑变化使用四次有界事件 burst，周期兜底为 90 秒；在线状态完全来自 WebSocket ping/pong，成员库只在真实认证或 IP 变化时更新。手动 peer 在 LAN WebSocket 在线时跳过 HTTP `/api/discovery/info` 探活，断线后沿既有 500ms～30s 指数退避重连。显式 `receive-only` 继续失败关闭，不被自动发现改写。
- 自动化守卫：`lan-sync.test.mjs` 固化默认独立、首次管理员发布自动建组与现有配置播种、幂等恢复、自动加入零反向播种、签名/组/私有地址篡改拒绝及 `receive-only` 保留；`discovery-policy.test.mjs` 固化 60～120 秒区间内的 90 秒兜底、异步 UDP、WebSocket 在线跳过 HTTP 探活以及仅 IP 变化写成员库；`lan-sync.integration.test.mjs` 用两个真实 Gateway 证明 A 正常发布后 B 无任何设置即可自动加入，同时收到 A 的本次变更和既有 `geelyp162`，而 B 的 `must-not-upload` 旧配置没有反向传播。设置页源合同和车型发布目标模型保护零操作文案与控件删除。
- 修复版本：2026-08-23 `DEVBENCH-VEHICLE-SOURCE-AUTO-LAN-SYNC-20260823` 平台工作区实现，尚未提交。
- 当前验证：保护性基线 30/35、最终 LAN/发现/发布状态定向 52/52；零设置真实双 Gateway 集成 1/1 通过，邀请码兼容与完整 ACK/离线续传/冲突套件此前同候选为 4/4，20 次持久 WebSocket 可见延迟 P95 约 47ms。Web pretest 23/23、主测试 436/436、Vite production build、影响图和 `git diff --check` 通过；静态全栈审计由 1 个新增阻断修正为 `PASS_WITH_WARNINGS`、0 blocker。deep 总门禁的 Gateway 全仓运行卡在本次未修改的 `base-protection-hooks` 临时目录 Git 探针并被终止，不能声称 Gateway 全仓通过。
- 残余风险：零确认自动加入以公司局域网 UDP 广播域作为授权边界；Ed25519 与 X25519/AES-GCM 证明设备身份并保护传输，但不能阻止已进入同一广播域的恶意主机仿照自动加入协议。需要更强组织身份时仍必须预置团队密钥或组织 PKI。公司交换机若屏蔽广播，需要保留手动 peer/邀请码兼容入口或配置网络；本轮未在真实 `172.16.129.94:3101` 部署和写入，正式发布 READY 未评估。
## REG-20260823-SETTINGS-080：设置页挂载即启动昂贵诊断并在开发态重复执行

- 复现：在当前 3000/3001 服务直接打开 `/settings`，静态 HTML 仅约 15ms，但页面挂载会立即执行全量 CLI 引擎状态、备份环境、仓库、TB Cookie、局域网和执行器探测；React StrictMode 又把多组 mount effect 重复启动。只读基线中 `/api/config/engine-status` 单独约 8.3s，`/api/backup/env-check` 单独约 2.2s；浏览器首轮有 924 个 DOM 节点、128 个控件、10 秒内 11 个长任务和约 1.72s 主线程任务时间，Gateway 请求最长约 8.6s。
- 根因：`Settings.jsx` 把首屏配置与页面中下部诊断放进同一挂载周期；全量引擎检测会并发启动 Claude/Gemini/Codex/Hermes，其中 Claude 还会真实执行一次最小模型调用；备份环境检测使用同步子进程。`main.jsx` 又在任意路由 idle 时预载管理后台模块。首个网关地址输入状态位于 3400 行级父组件中，逐键输入会重算整页。
- 行为合同：打开设置页只读取首屏必要配置，不自动启动任何 CLI/模型检测、备份环境进程或页面中下部数据源；React StrictMode 下同一挂载只启动一次 Settings 首次只读加载。AI 模式、API 模型、工作报告、Codeup 与备份面板在接近可视区时挂载；单个引擎只在用户点击”检测”后检查，备份面板滚动可见后仍完整加载 manifest/env-check。管理后台仅在侧栏 hover/focus 表达访问意图后预取。网关地址输入状态隔离到小组件，保存、连接测试、权限和错误语义不变。
- 自动化守卫：`settingsPerformanceUi.test.mjs` 固化禁止自动 `/api/config/engine-status`、备份面板延迟挂载、StrictMode 首次加载占位、网关输入状态隔离及管理后台意图预取；浏览器 DOM/CDP 验证打开页昂贵请求为 0，手工 Gemini 检测只发 1 次单引擎请求，滚动到备份区后 manifest/env-check 各发 1 次。
- 修复版本：2026-08-23 `SETTINGS-PERFORMANCE-20260823` 平台工作区候选，尚未提交。
- 当前验证：性能合同基线 0/4、候选扩展后 5/5；Web pretest 28/28、主测试 437/437、Vite production build、影响图、静态审计和 `git diff --check` 通过。候选首屏 DOM 374（较基线约 -60%）、控件 44（约 -66%），网关输入交互样本 7～28ms（基线约 72～147ms），冷启动长任务 3 个、暖启动 1 个，主线程任务时间约 0.78s/0.54s；打开页不再请求 engine-status、backup、TB Cookie、仓库或执行器端点。Settings gzip chunk 约 37.72KiB，较此前审计产物约 37.0KiB 增长不足 1KiB。
- 残余风险：本轮浏览器指标来自本机 Vite 开发服务，不代表所有机器的生产绝对时间；bundle-audit 当前没有已审核基线，结果为 `NO_BASELINE`。构建仍有范围外 `GitCommitReworkPanel.jsx` JSX 字符和 1.2MB 主 chunk 警告；未运行会卡在既有 Gateway Git 探针的 deep 全仓门禁，正式发布 READY 未评估。

## REG-20260823-DEVBENCH-080：Bundle 目录身份覆盖旧 Git 故事分支规则且关联工程无法增量加入

- 复现：Bundle 故事点虽然正确创建 `CARB-<编号>-<短哈希>/{AppMarket,AppMarketWeb}`，但可编辑仓库的 Git 分支被改成由工作区目录名派生的 `story/CARB_<编号>_<短哈希>`，不再遵循既有 `story/<源分支>_CARB_<编号>`；向该故事点增加未预声明的关联工程会返回 `WORKSPACE_BUNDLE_MEMBER_UNCONFIGURED`。Flavor 配置变更虽可原位保留目录，但缺少覆盖 Bundle 路径与实际 Git 分支的组合回归。
- 根因：实现把”故事点工作区目录身份”和”Git 分支身份”合并为同一个命名输入；Bundle 测试又把错误的新分支写成期望值，只验证工作区目录和元数据，没有把 Bundle 实际 checkout 分支与迁移前的分支合同比较。Bundle 拓扑签名同时把运行时关联工程视为固定核心成员，导致增量扩展被错误归类为整组重建。
- 行为合同：Bundle 根目录继续由故事点号和稳定短哈希命名，仓库目录使用固定或显式稳定兄弟目录名；可编辑仓库 Git 分支统一复用既有 `buildWorktreeBranchName`，与 Bundle 目录名无关。Flavor、构建、设备等非 Git 身份配置变化不改变目录或分支；同一 Git common-dir 内的分支切换原位完成。新增关联工程只在现有 Bundle 根下创建一个新兄弟 worktree，保留所有既有成员路径和分支；运行时关联工程可使用自己的源分支，不参与 AppMarket/AppMarketWeb 核心同逻辑分支约束，也不触发固定拓扑重建。
- 自动化守卫：`gateway/test/worktree-manager.test.mjs` 固化旧分支规则、两个可编辑核心仓库同名分支以及关联工程增量加入时核心目录复用；`gateway/test/worktree-routes.integration.test.mjs` 通过隔离 Gateway 和真实 Git worktree 固化 Flavor 变更不重建、分支原位切换及持久记录同步、关联工程同根新增与重启恢复；`gateway/test/worktree-rebuild.test.mjs` 固化运行时关联成员不改变固定 Bundle 拓扑签名。
- 修复版本：2026-08-23 `restore-legacy-worktree-branch-naming` 平台候选，随本条自动化守卫一并提交。
- 当前验证：旧候选的旧规则断言为 47/48，实际分支是 `story/CARB_13998_<短哈希>`；候选 `worktree-manager` 完整套件 48/48，初始化/Bundle/重建聚合 26/26，Bundle HTTP 集成 1/1。HTTP 集成确认 Flavor 变更前后根目录、主工程目录和 Git 分支完全相同；显式分支切换后目录不变、实际分支与持久记录同步；新增关联工程后只新增一个兄弟目录并在重启后恢复 3 个成员。Web production build 与静态审计通过，静态新增阻断项为 0。
- 残余风险：本轮没有自动重命名已经创建的 `CARB-15190` Git 分支，避免在未确认上游、脏状态和其它 worktree 占用前修改现有分支身份；当前 3101 Gateway 已确认是不会热加载的旧进程，自动重启命令在执行前被工具策略拒绝，需通过受管入口正常重启后加载候选，正式发布 READY 未评估。完整 Gateway 全仓门禁未获得通过结论；测试聚合器在未显式设置 `NODE_ENV=test` 时会使一个旧集成夹具触发认证失败，正确隔离环境下该用例已通过。

## REG-20260823-DEVBENCH-081：只读关联工程获得 AI 写权限时没有故事分支和一致持久状态

- 复现：Bundle 默认把 AppMarketWeb 作为 `READ_ONLY + detached HEAD` 创建，但 AI 工作区仍把该目录加入 `addDirs/allowedRoots`；旧实现只在页面 Git/构建接口拒绝 READ_ONLY，API 工具、CLI/远端 Agent 的实际写权限边界没有在首次写入前创建故事分支。若 AI 判断需要修改 WebApp，系统只能继续禁止，或依赖 Prompt 自律而在 detached checkout 上承担误写风险；其他只读关联工程同样如此。
- 根因：READ_ONLY 同时承担”初始 checkout 模式”和”永久成员模式”，没有”AI 获得源码写权限”这一受控状态转换；Git checkout、tab、SQLite `story_workspace/story_workspace_member` 与 `.aiefficiency/workspace.json` 也没有共同的事务/CAS 边界。旧只读 Prompt 和真实 `commandPolicy` 还来自不同判定，TRIAGE/VERIFY/REPORT 的文字约束不能证明工具层真正只读。
- 行为合同：只读分析、代码评审、验收和报告回合保持 READ_ONLY/detached；REPAIR 或普通可写回合在 AI 启动前锁定整个故事点 Bundle，核对 Git 归属、冻结 HEAD 和清洁状态，然后在原目录创建故事分支。AppMarketWeb 等固定核心成员使用主工程实际故事分支名；来源分支不同的运行时关联工程按自身来源分支复用既有 `story/<来源分支>_CARB_<编号>` 规则。目录不移动、不删除、不重建；tab、SQLite 和 workspace.json 全部一致后才开放写权限，任何失败都回滚 detached 与本次新分支并保持 AI 未启动。已晋升成员继续复用现有目录和分支，后续 Flavor 等非 Git 身份配置不触发重建。
- 自动化守卫：`gateway/test/worktree-manager.test.mjs` 用三个独立真实 Git 仓库固化固定 WebApp 同名分支、不同来源关联仓分支、全成员原位晋升、三方持久化、幂等和 CAS 失败回滚；`gateway/test/store.test.mjs` 固化工作区单次 CAS 与禁止目录拓扑替换；`gateway/test/devbench-prompt-mode.test.mjs` 固化只有实际源码可写回合触发晋升，阶段策略与 `commandPolicy` 使用同一判定。
- 修复版本：2026-08-23 `devbench-associated-repository-lazy-promotion` 平台工作区候选，尚未提交。
- 当前验证：新增定向合同 4/4 通过；worktree-manager 全套 50/50、Store 94/94、Prompt/权限模式 84/84、Workflow V2 派发边界 25/25、Bundle/Flavor 不重建 11/11、真实 Git HTTP 路由 4/4、Node 语法与 `git diff --check` 通过。隔离测试证明 AppMarketWeb 从 detached 原位切到主仓同名 `story/v202605_ui_CARB_15190`，另一只读关联仓从 `tools-main` 原位切到 `story/tools_main_CARB_15190`；模拟 tab CAS 冲突后两个持久镜像恢复 READ_ONLY、目标 checkout 恢复 detached 且临时分支不存在。深度全栈门禁中 Web 全量测试、production build、影响图和静态审计通过；Gateway 全仓命令在 600 秒上限退出 2，单独复跑稳定复现 4 个未修改模块的范围外失败：Hermes 临时 Prompt 引用 1 项、remote-agent cursor 1 项、API 外置 tempFiles 快照 1 项、Windows process supervisor 2 项。
- 残余风险：本轮没有在运行中的 CARB-15190 上启动真实付费 AI 或主动把其 WebApp 晋升为可写，避免在业务范围尚未确认时产生真实故事分支；当前候选仍需 Gateway 正常重启后才会加载。自动晋升要求只读 checkout 清洁、HEAD 与登记提交一致且目标分支未冲突，任一不满足会按合同阻断并要求人工处理。深度全栈门禁的 Gateway 全仓结论仍为 BLOCK，且未执行浏览器核心交互和正式发布门禁；上述范围外失败未在本候选中修复，正式发布 READY 未评估。

## REG-20260823-DEVBENCH-082：车型源码配置缺少主动同步入口且多管理员并发裁决不能跨节点闭环

- 复现：局域网自动同步主要依赖启动、发布、IP/拓扑变化的事件广播和 90 秒兜底；接收 Gateway 若错过这些广播，管理员在车型源码配置页没有立即补齐的入口。两个管理员在离线期间修改同一车型后，双方虽然会形成冲突，但旧裁决只在执行裁决的节点关闭；选择”保留本机值”又可能被物化层当作 no-op，导致裁决操作没有传播，另一节点仍保留冲突和不同值。
- 根因：前端和路由没有把”管理员现在请求对齐”建模为独立命令；UDP 只有普通公告，没有经过签名的即时发现 solicitation；WebSocket 协议只有连接时的版本向量交换，没有显式 `SYNC_REQUEST/SYNC_STATUS`。冲突解决操作没有携带它所裁决的本地、远端两个 revision，且变更预览仅比较最终物化值，无法表达”值不变但因果关系已改变”的解决操作。
- 行为合同：车型源码配置提供无需二次确认的”立即同步”按钮，复用 `vehicle-config:read` 权限。点击只发送当前 `projectId`，先用带随机 requestId、节点签名和空间绑定的 UDP solicitation 主动唤醒已发布节点，再通过现有加密 WebSocket 和版本向量双向补齐操作；没有节点时只等待发现，绝不把本机快照当作发布。未发布的页面编辑必须保留，远端变化只提示刷新；冲突列表可由 WebSocket 事件刷新。多个管理员修改不同实体时按操作日志合并；并发修改同一实体且值不同必须在双方创建显式冲突，禁止静默 last-write-wins。任一管理员裁决时，解决操作必须携带被裁决的两个 revision，即使选择值等于本机当前值也必须发布；其它节点应用后只关闭精确匹配这两个 revision 的冲突。并发做出互相矛盾的裁决仍按新并发变更生成新冲突，不假装达成共识。
- 自动化守卫：`vehicleSourceManualSyncUi.test.mjs` 固化按钮、忙碌态、未发布编辑保留、冲突刷新、读取权限及不存在整包覆盖 API；`lan-sync.test.mjs` 固化无成员时零操作、签名 solicitation 防篡改、保留本机值仍产生解决操作以及按双 revision 关闭冲突；`lan-sync.integration.test.mjs` 使用真实隔离 Gateway 证明接收节点错过发布 burst 后可由主动同步立即发现并拉取、未授权请求返回 401、陈旧本机配置不反向上传，以及两个管理员离线并发修改后双方出现冲突、单方裁决后双方配置收敛且冲突清零。`.ai/operation-map.json` 记录隔离 CDP 的真实按钮点击与多视口检查。
- 修复版本：2026-08-23 `DEV-BENCH-VEHICLE-SOURCE-MANUAL-SYNC-20260823` 平台工作区候选，尚未提交。
- 当前验证：新增 UI 合同基线 0/3、候选 3/3；LAN/发现/加密/日志/mTLS 聚合 48/48（包含普通发布不能伪造解决因果关系的权限守卫）；真实 LAN 集成 4/4，20 次在线增量可见延迟 P95/P99 约 44.06/44.24ms，安全收口后复跑关键双 Gateway 场景 P95/P99 约 81.17/85.93ms；Web pretest 31/31、主测试 437/437、Vite production build和四份 Gateway 语法检查退出 0。隔离 Chrome 中按钮实际经历“立即同步 → 同步中… → 立即同步”，只产生一次带认证和当前 projectId 的同步 POST，390×844、1440×900 均完整可见且无横向溢出。静态全栈审计修正对失败关闭校验的误报后为 `PASS_WITH_WARNINGS`、0 blocker。
- 残余风险：本轮没有在真实 `172.16.129.94:3101` 部署或触发生产配置同步；受管 Gateway 需正常重启或重新部署后才会加载新协议。UDP 广播仍受公司网络广播策略影响，跨 VLAN 或屏蔽广播时需已有 peer 地址才能重连。多管理员同实体并发通过显式人工裁决收敛，不提供分布式事务或自动选择“赢家”；互相矛盾的并发裁决会继续形成新冲突，这是防止数据静默丢失的有意行为。构建继续报告未修改的 `GitCommitReworkPanel.jsx` JSX 字符和既有大 chunk 警告；正式发布 READY 未评估。隔离 Chrome 临时 profile 的安全清理被执行策略拒绝，目录保留在忽略的工程验收临时区且不提交。

## REG-20260823-DEVBENCH-083：跨广播域 Gateway 已有车型配置但车型源码页仍显示“局域网自动同步”

- 复现：`127.0.0.1:3100` 对应的 development Gateway 只有 8 个车型、0 个成员，`192.168.10.110:3001` 的 production Gateway 有 11 个车型并包含 `geelyp162/geelyp166/baicn5`；两端均使用 `team/vehicle-source`，但处于不同 UDP 广播域，无法互相发现。旧车型源码页只要 `syncMode=peer` 就显示“局域网自动同步”，没有成员数、离线状态或手动 LAN 地址入口。远端浏览器已登录管理员也不能授权本机 Gateway 修改可信 peer。
- 根因：自动发现只覆盖同一 UDP 广播域；已有 `servers.peers` 轮询依赖尚未建立的 M2M 共享口令，并且保存 peer 后要等待周期探活。手动地址覆盖签名公告中的 `host` 又会使 Ed25519 公告验证失败；只让新节点单向读取远端公告时，旧远端也不知道新节点身份，无法完成双向成员登记和 WebSocket 连接。
- 行为合同：车型源码页必须按 `connectedPeers + members` 展示真实在线、离线或 0 成员状态。当前页面管理员可登记一个无凭据、无路径的私有 `http(s)` Gateway origin；浏览器只向当前同源 `/api/discovery/peers` 发送管理员请求，不把 Token/Cookie 发往远端。Gateway 保存后立即从固定公开 `/api/discovery/info` 读取并验证原始签名、协议、确定性组、配置空间、公钥指纹和私有地址，再以手动 origin 作为连接路由；敏感共享接口继续要求独立 M2M 口令。新节点用标准签名 UDP 公告单播通知旧远端，保持旧版本兼容，随后通过既有加密 WebSocket 增量同步；无效签名、不同组、自引用、非私有或不可达目标失败关闭。
- 自动化守卫：`gateway/test/lan-sync.integration.test.mjs` 使用两个隔离 Gateway 固化“保存 peer 后立即探测、双向登记、在线连接和远端车型到达”，且所有 UDP 发现端口动态分配，禁止测试复用真实 48900；`gateway/test/discovery-policy.test.mjs` 与 `discovery.integration.test.mjs` 保护信任边界、退避和跨子网手动 peer；`vehicleSourceAdminState.test.mjs` 保护真实连接状态与 origin 校验；`vehicle-source-lan-peer-ui.integration.test.mjs` 经 Visual Operation Guard 真实输入和点击，断言同源管理员 POST、零远端浏览器请求、连接刷新及远端车型出现。
- 修复版本：2026-08-23 `devbench-lan-vehicle-source-sync` 平台工作区候选，尚未提交。
- 当前验证：本机和远端只读 API 证明 8/11 个车型差异及 0 成员状态；前端状态 14/14、Web pretest 28/28、Web 主测试 440/440、发现策略 11/11、发现集成 6/6、跨子网同步 1/1、隔离 UI 1/1 和 Vite production build 通过。UI 验收执行 4 次受 Guard 授权的 DOM 动作，截图 0、坐标动作 0、视觉成本 0。全栈门禁自动升级为 deep，静态审计 0 blocker、Web 测试/构建通过；Gateway 全仓在 600 秒以 `cmd.exe ETIMEDOUT` 退出 2，浏览器总审计按 DAG 跳过，不能声明全仓通过。初版集成测试误用 48900，向真实开发网关写入两个离线测试成员；已在线备份 SQLite/本地配置，使用仓库现有事务清除 2 个成员、10 条测试操作和关联传输状态，复核真实库为 0 成员/0 操作且物化车型仍为 8 个，并将测试改为动态 UDP 端口。
- 残余风险：本轮没有把候选部署到运行中的 3101；精确受管重启命令在执行前被进程控制安全策略拒绝，PID 15256 未停止。也没有用真实页面把 `192.168.10.110:3001` 写入本机可信 peers，因此真实 8→11 同步仍需在 Service Control 重启开发环境后，由本机管理员点击一次确认。旧远端必须监听双方约定的发现 UDP 端口（默认 48900）并允许来自本机的单播；跨 VLAN 防火墙若阻断 UDP 或 WebSocket，连接会保持可诊断的离线状态。完整 LAN 同步文件中的既有“持久 WebSocket 增量同步”用例在当前 HEAD 和候选均于同一断言失败，归类为 `PRE_EXISTING`，本次未扩大范围修复。正式发布 READY 未评估。

## REG-20260823-DEVBENCH-084：跨子网车型同步要求普通用户理解并手填 Gateway 地址

- 复现：同一广播域的 Gateway 能通过 UDP 自动发现，但 `172.16.128.0/22` 与 `192.168.10.0/24` 之间没有广播转发；两端即使分别已有管理员登录，也不会共享浏览器会话或自动获得对方 origin。旧车型源码页把跨子网首次引导暴露为默认输入框，当前节点必须由管理员手填 `http://192.168.10.110:3001` 才能入组。
- 根因：发现服务把所有跨子网地址都建模为 `servers.peers`；该集合同时承担敏感 M2M 信任，既不适合由部署无感下发，也无法表达“只允许读取公开签名公告”的最小权限引导节点。现有安装脚本虽已知道中心 origin，却没有独立持久化为车型同步引导信息。
- 行为合同：部署或环境可预置私网 `servers.discoverySeeds`；Gateway 启动和低频重试只从这些 origin 的精确 `/api/discovery/info` 读取公开公告。引导 origin 不进入 `trustedPeerOrigins`，不得获得审计、管理员、用户数据或 shared-bundle M2M 权限。只有协议、schema、配置空间、确定性组、公钥指纹、Ed25519 签名和私网 origin 全部有效时才自动入组，再通过签名 UDP 单播和 X25519/AES-GCM WebSocket 完成双向登记、成员传播与增量同步。车型源码页默认只展示后台自动组网状态；手工地址保留在管理员高级恢复中。
- 自动化守卫：`gateway/test/discovery-policy.test.mjs` 固化私网 seed 归一化及与 M2M trusted peer 分离；`gateway/test/lan-sync.integration.test.mjs` 使用两个隔离 Gateway 固化不同广播入口、零 `/api/discovery/peers` 写请求的自动入组与车型到达；`vehicleSourceAdminState.test.mjs` 固化自动发现状态文案；`vehicle-source-lan-peer-ui.integration.test.mjs` 经 Visual Operation Guard 断言默认输入折叠，并保留管理员高级恢复的同源写入边界。
- 修复版本：2026-08-23 `devbench-rendezvous-zero-touch` 当前平台工作区候选，尚未提交。
- 当前验证：发现策略 12/12、发现/LAN 策略聚合 48/48、完整 LAN 集成 6/6 通过；其中新增零输入跨子网场景没有调用 `/api/discovery/peers` 写接口，自动入组、建立加密 WebSocket 并收到远端车型配置，20 次在线增量样本 P95/P99 为 66.83/70.87ms。前端状态 15/15、隔离 UI 1/1、配置权限定向 2/2、安装脚本 seed 合同、Web pretest 31/31、主测试 441/441、Vite production build、Node 语法与 `git diff --check` 通过；UI 验收执行 5 次 Guard 授权 DOM 动作，截图 0、坐标动作 0、视觉成本 0。deep 全栈门禁中 Web 测试/构建、影响图和静态审计通过，静态新增 blocker 为 0；Gateway 全仓命令在 600 秒上限退出 2，并复现未修改模块的 Hermes 临时 Prompt、remote-agent cursor、外置 tempFiles 快照和 Windows process supervisor 失败，浏览器总审计按 DAG 跳过，因此不能声明全仓通过。配置权限全文件为 16/17，失败项是基线用例把已列入管理员边界的 `feishuProjectSync` 随完整 GET 结果无 token 回写，与本次 `discoverySeeds` 定向权限用例无关。
- 残余风险：引导节点仍是部署配置而非凭空网络发现；若 IP 变化、路由、UDP 单播或 WebSocket 被防火墙阻断，系统会后台退避并显示重试状态。当前私网 origin 校验有意拒绝公共地址和普通 DNS 名称，避免 SSRF/DNS rebinding 扩大信任边界；需要稳定域名时应另行引入组织 PKI 与受控解析策略。本机忽略配置已预置 `http://192.168.10.110:3001`，但受 Service Control 托管的 3101 进程仍是修改前 PID；精确进程重启被执行策略拒绝，最小化控制窗口也无法由 Accessibility 安全操作，故未强制终止服务，真实本机自动入组要到下一次正常 Service Control 重启后才会加载。正式发布 READY 未评估。

## REG-20260823-DEVBENCH-085：局域网车型已同步但默认空 TB 项目让页面误显示“没有配置”

- 复现：运行中的本机 Gateway 已与 `192.168.10.110:3001` 完成签名入组和加密 WebSocket 认证，`65a5f274950780b816cf905e` 下已物化 11 个车型；但 `/tb-projects` 第一项 `66d5d0ec1f1e659482e41e6c` 没有车型配置。浏览器没有明确人工选择时固定取第一项，并把该自动默认值写入 localStorage，工程配置的车型源码页因此持续显示空列表。
- 根因：同步协议按 TB 项目正确隔离数据，页面初始化却不知道哪个可见项目已有车型配置；旧版自动默认与用户明确选择共用同一个 localStorage 键，也无法在升级后安全区分。
- 行为合同：`/tb-projects` 只读响应为当前用户可见项目附加已有车型配置的项目 ID；仅当恰好一个可见项目有车型配置时给出推荐。前端必须保留明确人工选择；对没有明确人工选择的首次访问或旧版自动默认，无感选中唯一推荐项目。滚动升级期间旧 Gateway 缺少元数据时，前端可并行读取可见项目的只读车型配置；任一读取失败或存在多个有配置项目时不得猜测。不得跨项目复制、合并或改写车型数据。
- 自动化守卫：`gateway/test/vehicle-source-project-selection.test.mjs` 固化可见范围、唯一推荐和多候选不猜测；`gateway/test/devbench-tb-project-access.integration.test.mjs` 固化 `/tb-projects` 新元数据及普通 TB 登录读取边界；`web-dashboard/src/pages/devbench/tbProjectSelectionModel.test.mjs` 固化旧自动默认迁移、人工选择优先、首项兼容和旧 Gateway 失败关闭。
- 当前验证：运行 API 证明 `65a5f274950780b816cf905e` 下 11 个车型、2 个在线 LAN 成员且自动引导状态为 connected；后端定向与路由集成 5/5、前端新模型 4/4、Web pretest 31/31、主测试 445/445、Vite production build 通过。隔离无头浏览器在全新 localStorage 下自动选中“平台组件”，经 2 次 DOM 点击进入车型源码配置后确认 `geelyp162`、`avatr8678` 可见；页面产生的 8 次后台 POST 均由只读夹具拦截。实际 `3100` 上的 `/devbench`、`/aiautowork`、`/aiautowork/settings`、`/settings`、`/devices`、`/admin` DOM smoke 6/6 通过，均无页面异常或 800px 视口横向溢出；两轮 UI 验证合计 0 次截图、0 次坐标操作。构建继续报告既有 `GitCommitReworkPanel.jsx` JSX 字符和大 chunk 警告，但退出码为 0。
- 残余风险：自动推荐只解决唯一候选；多个 TB 项目都已有车型配置时必须保留现有/首项选择，避免破坏跨项目隔离。旧 Gateway 兼容探测会在首次加载产生每个可见项目一次只读请求，新 Gateway 返回轻量元数据后不会执行该回退。正式发布 READY 未评估。

## REG-20260823-DEVBENCH-085：TB 工具包抽取前旧入口缺少完整上下文与 prepare-before-write 合同

- 复现：脱敏 rich fixture 已包含状态、优先级、自定义字段、参与人、创建/更新时间、评论和附件；当前 `buildTbContextSection` 只输出标题、描述、评论和附件，`fetchAndSaveTbContext` 又固定只保留最后 30 条评论。4 个待下载附件不会进入确认门禁，只有第 11 个才触发数量确认。`canonicalStatus("AI甄别")` 返回 null，`处理中/已解决` 被折叠为旧 `修复中/可提测`。`kickTriage` 的源码顺序是先 `onStartDev`，再检查工程、刷新上下文和准备附件；拒绝评论仍带 `🤖 AI 自动工作流` 前缀。
- 根因：旧 DevBench 将 UI 工作流、上下文裁剪、附件体验和 TB 副作用逐步叠加在同一入口，完整性标签与真实 payload 漂移；附件“非阻塞”策略覆盖了甄别前材料就绪要求；状态与评论模板属于旧业务合同，尚未通过 canonical toolkit 的 plan/apply 和归一化 schema 统一。
- 行为合同：抽取后必须先以当前 principal 获取完整、带 provenance/unavailable reason 的上下文，0/1/3 个附件可自动准备，4 个及以上未选择时零下载、零代码修改、零 TB 写入；精确 `AI甄别/处理中/已解决` 只能从当前 taskflow 动态解析，缺失或歧义时失败关闭。TRIAGE/RESOLUTION 使用不同 evidence fingerprint 与幂等范围，评论为简短具体原因/措施且不含 AI 身份模板。动态字段/状态 ID、既有 readback、durable owner、fencing、CAS 和歧义后零重写必须保留。
- 自动化守卫：`gateway/test/tb-toolkit-m1-characterization.test.mjs` 与 `gateway/test/fixtures/tb-toolkit-m1-context.json` 固化 TaskRef、上下文字段丢失、评论截断、附件聚合、0/1/3/4/11 当前阈值、状态折叠、评论模板、甄别调用顺序、低权限 actor 和部分成功；既有 `teambition*`、`devbench-tb*`、`workflow-v2-tb*` 套件继续保护分页/partial、下载安全、401/403、动态必填字段、幂等和崩溃恢复。
- 修复版本：2026-08-23 `AIEfficiency_TB_Skill_MCP_Generator_v2.0.0` M1 仅建立 characterization/BUG 基线，产品修复尚未开始；M2/M3 必须以目标合同测试替换相应 BUG baseline 后才能修改实现。
- 当前验证：新 M1 文件首轮 10/11，唯一失败是测试错误假设评论写异常后当前调用会立即二次回读；按真实实现修正该断言后 11/11 通过，Saga 的 `pending_ambiguous`、状态 blocked 和零状态写断言未降低。TB/DevBench 关联套件 14 文件、131/131 通过。deep 全栈门禁中 Web 测试、production build 和静态审计通过；Bundle/browser 因没有评审基线为 `NO_BASELINE`；Gateway 全仓在 600022ms 超时并以退出码 2 结束，超时前记录未修改的 `agent-timeout`、`agent-v2`、`api-engine`、`api-process-supervisor` 四个范围外文件共 5 个失败，且尚未执行到新增 M1 文件，因此工程变更结论保留 `PARTIAL`。
- 残余风险：本阶段没有修复任何旧入口行为，没有运行真实 TB 或验证真实 taskflow 中三个固定状态；`kickTriage` 缺显式 ticket-access helper 只能证明函数级门禁缺口，status 的当前 Cookie 读取与后续 OpenAPI/comment 组合是否形成运行态越权仍为 UNKNOWN。评论写异常的同调用立即回读与后续 durable 恢复 SLA 尚未统一。正式发布 READY 未评估。

## REG-20260823-SKILLDEV-086：官方 Teambition MCP 缺少完整评论与任务附件读取能力

- 复现：`@tng/teambition-openapi-mcp@0.2.2` 发布工具包含 `queryTaskV3`、工作流/状态查询、`updateTaskStatusV3` 和 `createTaskCommentV3`，但没有完整任务评论列表读取，也没有覆盖任务、评论、备注全部附件的枚举与字节下载工具。只调用 `queryTaskV3` 时无法证明评论和附件为空。
- 根因：官方 MCP 按当前 OpenAPI 工具集封装任务和项目管理；项目文件库 `file` 工具不等价于任务上下文附件完整性 Oracle。若把未提供的数据默认成空数组，4 附件选择门禁和 prepare-before-write 会被静默绕过。
- 行为合同：AIEfficiency 直接接入固定版本官方 MCP，不再实现第二套 Teambition MCP 或直连 HTTP provider。官方未覆盖的评论/附件来源必须标为 `UNAVAILABLE`，`prepareTicket` 返回 `CONTEXT_INCOMPLETE`，下载数为 0，且 M3 状态/评论写入不得启用；只有官方补齐能力或用户明确批准新的集成边界后才能解除。
- 自动化守卫：`official-mcp.test.mjs` 以真实官方子进程验证固定版本、只读工具白名单、stdio 工具调用和错误脱敏；`prepare-ticket.test.mjs` 证明能力缺口不会被解释为 0 个附件；其余测试保护 0/1/3/4、worktree exclude、原子下载、大小/摘要、冲突和路径逃逸。
- 修复版本：2026-08-23 `AIEfficiency_TB_Skill_MCP_Generator_v2.0.0` M2 候选；官方 MCP 薄接入与本地核心已完成，远端完整 prepare 仍为 `PARTIAL`。
- 当前验证：M2 21/21、TB/DevBench 关联 131/131、Web pretest 31/31、Web 主测试 441/441、Vite build、生成包校验和依赖审计通过。标准质量门禁进入 Gateway 全量后超过 180 秒无新输出而停止，沿用 M1 已知仓库级 harness 风险，工程结论保持 `PARTIAL`。
- 残余风险：未以真实租户验证 `queryTaskV3` 返回形状、权限、分页、限流或状态一致性；官方 Beta 工具可能漂移，固定版本升级必须重跑能力矩阵和 stdio 契约。未解决 SOURCE_CONNECTOR 缺口前不得进入真实 M3 写入或声称 M2 生产可用。

## REG-20260823-SKILLDEV-087：官方能力审计白名单不完整导致重复实现边界判断错误

- 复现：M2 初次只把 `queryTaskV3/searchTaskflowsV3/searchTaskflowStatusesV3` 加入官方工具白名单，并据此声称官方 0.2.2 没有评论与附件元数据读取。复核已安装发布包源码后确认还存在 `listTaskActivitiesV3/listFilesV3/getFileDetailV3`，写入还有 `createTaskCommentV3/updateTaskStatusV3`。若继续沿用旧判断，会把官方已覆盖能力错误复制到第二套 Provider。
- 根因：能力审计基于预选工具列表而不是官方发布包的完整注册与 schema；“未启用”被误当成“官方不存在”。组合 Provider 的写回读最初也直接调用 official `listComments`，没有复用已经完成 Cookie 读兜底的组合快照。
- 行为合同：对外只有 `tb-ticket-mcp`。内部官方子进程固定 6 个读工具，write profile 增加 2 个官方写工具；内部 supplement 只补 OpenAPI 权限读兜底、富文本备注/备注图片和安全字节下载。评论与状态写入始终走官方 MCP；写前/写后评论回读复用组合读取，不能因 official 读权限缺口破坏幂等。
- 自动化守卫：`official-mcp.test.mjs` 锁定完整官方读白名单和真实 stdio OpenAPI 请求；`supplement-provider.test.mjs` 锁定缺口边界、SSRF、签名刷新和组合评论回读；`mcp.test.mjs/mcp-stdio.test.mjs` 证明外部只有 4/5 个统一业务工具；`offline-canary.test.mjs` 通过同一 MCP 完成 TRIAGE/RESOLUTION 且写序为两次不同评论与一次状态；Gateway 关联 209/209 保护旧必填字段和 durable 行为。
- 修复版本：2026-08-23 `tb-ticket-toolkit@0.6.0` 工作区候选，未提交。canonical Skill 位于项目事实源 `.agents/skills/tb-ticket-fix`；Gateway 仅增加默认关闭的 shadow-read，真实 canary 前不允许 canonical 切换，不删除旧逻辑。
- 当前验证：toolkit 48/48、Gateway 关联 209/209、4 份 Schema strict compile、Skill 校验、生产依赖审计和生成包校验通过；真实 Teambition 读写未执行。
- 残余风险：目标租户的官方权限、响应、分页/限流、taskflow/必填字段和实际网络仍为 UNKNOWN。M6 真实测试任务 canary、生产切换与旧实现删除因缺少隔离工单、白名单和显式 `apply=true` 授权保持 `SKIPPED/DEFERRED`；离线 canary 不能替代生产证据。

## REG-20260823-DEVBENCH-086：心跳与业务推进混用导致 AI 任务永久运行

- 复现：运行态 `CARB-14427` 的 AI 任务最后一次真实事件为 `run_command`，随后任务记录和对话继续显示 `running/active`，runtime lease 持续心跳，但业务结果不再推进。保护性单测还用终止后永不发出 `close` 的伪子进程复现本地工具 Promise 无法收尾；API Agent 历史配置 `0` 允许工具循环无限迭代，也没有单次回合总时限。
- 根因：旧草稿只有 `updatedAt`，状态、思考、usage 和租约心跳都会刷新它，无法表达“进程活着但业务没有推进”；`api-tools.runShell()` 在 Windows 进程树未回报 `close/error` 时无限等待；Agent 取消后没有独立 PID/租约身份复核；API 工具循环允许无限迭代且只覆盖 Provider 首包/流空闲，没有覆盖完整 active turn。
- 行为合同：每个 active execution slice 独立记录 `heartbeatAt` 与 `lastMeaningfulProgressAt`。状态、usage、思考和工具请求只刷新心跳；新正文、完成的工具结果和显式终态/检查点才刷新业务推进。无业务推进先进入 `warning`，继续停滞后进入 `cancelling`，取消后按运行进程、PID identity 和 runtime lease 验证为 `terminated` 或 `termination_unconfirmed`。API 单片段有有限总时限和有限迭代上限，到达迭代上限生成可恢复 partial。故事点创建时间不参与任何超时；跨月、跨年的任务通过已保存结果/检查点开启新片段继续。
- Shell 合同：`run_command` 与 `run_tests` 保留声明的执行超时；请求终止后最多再等待 5 秒确认 `close/error`。未确认时以 `API_TOOL_TERMINATION_UNCONFIRMED` 终止当前回合，不得降级成普通工具文本。自动收敛、手工停止和片段续跑均不得清理或回滚业务工作树。
- 自动化守卫：`gateway/test/agent-progress.test.mjs` 固化 meaningful 分类、去重、警告/取消顺序、API hard cap 不被进展延长、历史无限配置迁移及多年故事点不按年龄过期；`gateway/test/agent-timeout.test.mjs` 用真实受控 CLI/API 挂起验证 typed cancel 与进程树退出确认；`gateway/test/api-tools.test.mjs` 固化三类 shell 终止路径；`gateway/test/devbench-prompt-mode.test.mjs` 固化 partial 回答与长期续跑提示；前端状态模型固化 warning/cancelling/termination_unconfirmed，禁止旧 2 分钟草稿计时抢先误杀新监督任务。
- 修复版本：2026-08-23 `AI-PROGRESS-SUPERVISOR-20260823` 当前平台工作区候选，尚未提交。
- 当前验证：新增监督纯单测 5/5、CLI/API 三级收敛集成 2/2、DevBench Prompt/partial 85/85、停止回答与租约 3/3、前端全测 446/446、production build、六个 Node 文件语法、`git diff --check` 和变更后影响图通过；静态 UI 审计 `PASS_WITH_WARNINGS` 且 0 blocker。API engine 36/37、API tools 23/26、agent-timeout 27/29；失败项为既有 Windows 后台进程/Hermes 测试夹具。deep 门禁完成 doctor、影响图、静态审计、Web 全测和构建后，Gateway 聚合停在既有 `base-protection-hooks.test.mjs` 且超过其 60 秒上限未退出，本次门禁会话被受控中止，因此不声明 deep PASS。
- 残余风险：meaningful progress 是可观察事件启发式，仍可能把“唯一但无价值的正文/工具输出”当推进，或遗漏未接入分类的新型业务事件；分布式节点断网时进程身份可能只能落为 `termination_unconfirmed`。默认阈值可配置以降低特定长构建误杀，但在取得真实运行分布前不能声称零误杀或零遗漏。`CARB-14427` 目标工作树的业务交付正确性不属于本平台工程修复结论；Gateway 聚合未通过，正式发布 READY 未评估。

## REG-20260823-DEVBENCH-088：长 AI 流向慢 WebSocket 客户端无限排队导致 Gateway 堆耗尽

- 复现：Service Control 在 2026-08-23 20:40:58 记录 production Gateway 以退出码 134 停止；stderr 在约 4.09 GiB 堆附近连续 GC 后报告 `Ineffective mark-compacts near heap limit` 与 `JavaScript heap out of memory`。事故窗口内 DevBench MiniMax 任务产生 110 次工具调用，但持久化会话、live draft 和进程输出快照均远小于堆规模。修复前回归向一个 `bufferedAmount=4 MiB` 的伪客户端广播时，该客户端仍收到新消息且不会断开。
- 根因：统一 WebSocket 发送出口仅检查 `readyState` 后直接调用 `client.send()`，没有检查 `ws.bufferedAmount`、没有单连接积压上限，也没有慢消费者断开策略。长时间思考、正文和工具流遇到打开但冻结或消费缓慢的浏览器时，`ws` 发送队列可无界保留消息。OOM 是已证实的直接退出原因；因事故进程未留下 heap snapshot，慢客户端队列占比与精确对象分解仍为 `UNKNOWN`。
- 行为合同：单连接“已积压字节 + 下一条消息字节”超过 4 MiB 时，从广播集合移除并主动终止该连接；其他健康连接继续收到同一消息。正常连接的事件信封、会话过滤和实时顺序不变；前端按既有重连机制恢复，并从持久化 live draft 获取最近状态。不得以提高 V8 堆上限替代有界队列，也不得因一个慢连接中断整个广播。
- 自动化守卫：`gateway/test/ws-emit.integration.test.mjs` 固化积压客户端终止、零追加及健康客户端继续发送，并继续保护 `{type,data}` 信封、坏连接隔离、序列化失败和 session 过滤。
- 修复版本：2026-08-23 `devbench-gateway-sudden-stop-20260823` 当前平台工作区候选，尚未提交。
- 当前验证：新增背压回归在基线为 6/7、唯一失败正是积压客户端未断开；候选同一文件 7/7。WebSocket 关联定向 27/27，通过 API Engine、实时故事点、structured sendTurn 与 WS 的聚合为 45/46，唯一失败是台账已记录且与本差异无交集的 Windows `start_process` 外置产物夹具（`PRE_EXISTING`）。Web pretest 31/31、主测试 446/446、Vite production build、Node 语法、`git diff --check`、变更后 deep 影响图和静态审计通过；build 只保留既有 JSX 字符与大 chunk 警告。deep 全栈门禁进入 Gateway 聚合后再次停在既有 `base-protection-hooks.test.mjs`，超过其 60 秒单文件上限仍不退出，受控终止并归为 `HARNESS_DEFECT`，不声明 deep PASS。Service Control 通过匿名 CDP pipe 的真实 DOM Start 恢复原先运行的 production 3000/3001 和 development 3100/3101，关闭管道后无 remote-debugging TCP 监听；直连/代理健康与 `/devbench` 均为 HTTP 200。隔离无头 Chrome 加载真实 `/devbench`，13 个 API 响应无失败、WebSocket 建连、无断连横幅/横向溢出/写请求；Gateway 连续 60 秒四次健康检查均为 200，Working Set 从 371.6 MiB 回落至 166.5 MiB，新 stderr 无 OOM。
- 残余风险：缺少事故时 heap snapshot，无法把 4.09 GiB 堆逐对象归因；4 MiB 是保护上限而非网络吞吐 SLA，极慢客户端会重连并可能丢失仅存在于瞬时流、尚未落入 live draft 的末尾片段。本轮没有恢复或重放 CARB-14427 的 110 工具长任务，因此运行证据是回归、真实浏览器建连与短时健康观察，不是同负载耐久证明；Gateway 全仓聚合仍受既有 harness 挂起阻断，正式发布 READY 未评估。

## REG-20260823-DEVBENCH-089：自我验收把源码晋升权限误当成命令执行权限

- 复现：`CARB-14427` 进入 prompt-only `VERIFY` 后，界面和 Prompt 要求新开验收 Agent 生成单测/用例/App-mock/脚本并执行 debug/release 构建、安装和设备场景，但实际 Provider 工具列表没有 `run_command`、`run_tests` 及测试资产写入工具；验收只能反复搜索、分析和输出计划，看起来像进入循环。基线探针同时命中“`verify` 属于 `READ_ONLY_WORKFLOW_KINDS`”和“`commandPolicy` 由 `sourceWriteEnabled` 推导为 `read_only`”，退出 1；相同只读策略下真实工具定义只有 12 项且没有两个执行工具。
- 根因：关联 `READ_ONLY` 仓库是否应晋升为故事分支，与当前 AI 回合是否可以执行测试命令，本是两个权限维度；`fb6e8e05` 的延迟晋升改动把两者合并为同一个 `sourceWriteEnabled`，导致不应晋升关联仓的 `VERIFY` 同时失去所有执行能力。prompt-only 验收又没有 Full V2 天然的 fresh-session 边界，旧实现只在提示词里声称“独立验收”，仍可能续接开发 Provider 会话。
- 行为合同：`SOURCE_READ_ONLY_WORKFLOW_KINDS` 继续包含 `verify`，所以验收不得把关联只读仓晋升为源码可写；独立的 `EXECUTION_READ_ONLY_WORKFLOW_KINDS` 只包含 `code_review/triage/report`，prompt-only `verify` 必须获得真实命令、测试和验收资产生成能力。显式 Full V2 `stageToolPolicy.readOnly=true` 始终优先并继续失败关闭。`VERIFY` 和既有 `code_review` 都强制清空 CLI/remote Provider 续接身份且不带开发会话历史；验收 Prompt 禁止修改产品实现，只允许生成故事点测试资产和外置证据并实际执行构建、测试、安装及设备场景。
- 自动化守卫：`gateway/test/devbench-prompt-mode.test.mjs` 固化源码晋升与命令权限正交、`verify` 工具表含 `run_command/run_tests`、`triage/report/code_review` 仍不含执行工具、Full V2 只读覆盖不变，并通过生产 `executeTool` 真正执行 `node` 命令取得 `CARB-14427-VERIFY-EXECUTED` 标记；同文件固化 `VERIFY` fresh-session。`gateway/test/workflow-v2-index-integration-gate.test.mjs` 固化本地历史和 remote session/cursor 均使用统一 fresh-session 判据。
- 修复版本：2026-08-23 `feat/admin-rbac` 的 `CARB-14427-verify-execution-policy` 当前平台工作区候选，尚未提交。
- 当前验证：基线合同探针退出 1并确认两项错误耦合；候选 Prompt/权限/真实命令回归 87/87、工作流索引/队列/会话边界 34/34、防循环进度监督 5/5、Prompt overlay 与 Full V2 stage policy 39/39、Node 语法和 `git diff --check` 通过。最终影响图 PASS、5 个文件（4 个实现/测试文件加本条 ledger）且建议 deep；在 ledger 写入前针对 4 个实现/测试文件执行的 deep 质量门禁中，doctor、影响图、静态审计、Web 测试和 production build 通过，静态审计 0 blocker，包体与浏览器审计为 `NO_BASELINE`；Gateway 288 文件聚合在 600025ms 超时并退出 2，超时前仍报告台账已记录且与本差异无交集的 Hermes 临时 Prompt、remote cursor、外置进程/快照等 Windows harness 失败，因此总门禁 `BLOCK`，工程结论保留 `PARTIAL`。
- 残余风险：本轮未重启或部署运行中的 Gateway，未向真实 `CARB-14427` 重新发送消息，未调用付费 Provider，也未在绑定设备实际完成 debug/release 构建、安装和 TB 场景回放；这些属于部署后运行态证据，不能由隔离回归替代。prompt-only 路径对“不得修改产品实现”的约束仍由 Prompt 和工作区保护共同执行，尚不是 Full V2 的逐工具细粒度写路径策略。正式发布 READY 未评估。
