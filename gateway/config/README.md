# DevBench 独立 Worker 部署配置

本目录只提交模板。真实配置、私钥、公钥和 launcher 二进制均为部署工件，不进入 Git。

固定运行时路径：

- `gateway/config/worker-launcher.json`：Gateway 读取的 launcher 声明；
- `gateway/config/worker-launcher-private.pem`：Gateway 独占的 Ed25519 私钥；
- `gateway/config/worker-launcher-public.pem`：Worker broker 只读的 Ed25519 信任锚；
- `gateway/.secrets/worker-deployment-probe.json`：安装验收使用的固定故事点权限探测清单。
- `gateway/.secrets/worker-deployment-attestations.json`：真实 Windows probe 成功后生成的 Ed25519 签名状态门禁。
- `gateway/.secrets/worker-launch-nonces/`：Gateway/Controller 身份独占的一次性启动 ledger 与有界签名审计。

## 安全边界

仓库不提供、也不会伪装一个可以自行切换身份的 Node.js launcher。生产 launcher 必须由管理员预先部署为固定、受保护的原生服务客户端：

- Windows 服务端使用专用服务身份和受限命名管道；按固定故事点映射创建受限主令牌，并以该令牌启动固定 `isolated-worker-broker.mjs`。不得使用 `runas`、密码参数、命令字符串或 shell；
- Linux 服务端必须在切换到目标非 root uid 的同时建立 mount namespace/cgroup/no-new-privileges 等内核边界，只挂载当前故事仓；不得暴露宿主机 Docker socket；
- 客户端只能把固定参数和最后追加的 `--devbench-worker-spec <签名数据>` 交给服务端，不得接受用户提供的 command、args、env、账号或密码；
- Gateway 的生产 broker 路径直接启动这个固定 native launcher，不经过 `cli-supervisor.js`、PowerShell、PATH `taskkill` 或 JS watchdog。Windows launcher 必须以 `CREATE_SUSPENDED` 创建 broker、先绑定 `KILL_ON_JOB_CLOSE` Job 与故事点受限主令牌再 resume；launcher client 持续拥有本次进程树，client 句柄关闭、Gateway 父进程死亡或控制管道断开时关闭 Job 并等待清空。Linux 必须在 resume/exec 前建立对应 cgroup/namespace/no-new-privileges，断管后终止并等待整个 cgroup；
- 同一固定 binary 必须实现只读内部查询 `--devbench-query-process-identity-v2 <pid> <launcherSha256>`，仅返回一条 `DEVBENCH_LAUNCHER_PROCESS_IDENTITY_V2=<base64url-json>`。实现必须用平台进程句柄/API 返回绑定 PID、binary hash、creation/start identity 与本实例 32 字节 `launcherInstanceEvidence` 的 v2 文档，不得调用 PATH、shell、PowerShell 或读取用户配置；旧 v1 查询不能形成 runtime lease；
- 服务端在验签前若需要读取路由身份，只能用它选择固定 Worker 令牌；任何未验签数据都不得影响要启动的程序、参数、环境或文件路径；
- broker 入口保持单文件自包含；v3 配置同时固定 broker 与 `worker-launch-consume-helper.mjs` 的绝对路径和 SHA-256，避免身份切换前后加载未固定模块；
- launcher 必须为每次启动创建三条不可继承给 CLI 的匿名管道：Worker broker 从 fd 3 写入随机 challenge，Gateway 身份 helper 从其 fd 3 读取；helper 原子消费持久化 nonce 后从 fd 4 写回 Ed25519 receipt，broker 从其 fd 4 验证；launcher 还必须经 fd 5 传入本次实例独有的 32 字节 base64url `launcherInstanceEvidence`。release、receipt、challenge 与该实例证据必须共同绑定，launcher 不得缓存、重放或跨实例复用任一材料；
- receipt 同时绑定 envelope/payload SHA-256、storyId、taskId、Worker 身份、nonce、过期时间和本次随机 challenge。broker 未收到唯一有效 receipt 时不得输出 probe 成功，也不得启动 CLI；
- CLI launch envelope 只携带唯一 `releaseChallenge`。Gateway 在 native launcher PID 与不可变 start identity 成功写入 SQLite runtime lease 后，才签发最长 10 秒的 `devbench.worker-lease-release.v2`，绑定 envelope SHA-256/nonce、story/task/Worker、leaseId、launcher PID/start identity 与查询得到的 `launcherInstanceEvidence`，并经 launcher 独占 stdin 写端发送 `RELEASE:<base64url>`。broker 必须先把 release 中的证据与 fd 5 当前实例证据逐字节匹配，再允许 nonce 消费；launcher A 的 release 不能用于 broker B；
- 每个 `writeDeniedRoots` / `inaccessibleRoots` 根必须在其真实父链内有 Controller 预建的 `.devbench-worker-boundary-*.sentinel`。broker 会验证完整父链有效权限，并真实尝试 mkdir/create/symlink/rename-delete-child；基础仓业务树还会逐项证明不可写，`.git`、mirror、密钥根和其它故事仓则必须连根读取都失败；任一成功或结果不确定都失败关闭；
- Worker 账号不得属于管理员/root 组，也不得持有可绕过 ACL 的 Windows privilege 或 Linux capability；
- 每个故事点使用唯一 SID/uid。Controller 的 Worker 映射、`worker-launcher.json` 和故事仓 ACL 必须一致。

Windows 下，`worker-launcher.json`、私钥、nonce ledger、launcher、broker 和 helper 的 owner/DACL 只允许对应 Gateway/Controller 管理身份、`SYSTEM` 和本机 Administrators 修改；Worker 仅可读取公钥及 broker 代码。Unix 下，受管文件由管理 uid 持有，配置与 launcher 不允许 group/other 写，私钥与 nonce ledger 权限不宽于 `0600`/`0700`。

## 安装前置检查

1. 从对应模板生成真实固定配置，替换所有占位符。
2. 为 Gateway 生成 Ed25519 密钥对；私钥只授予 Gateway，公钥只读授予每个 Worker。
3. 由 Controller 创建独立故事仓并返回 `workerIdentity` 与 `aclFingerprint`；根据当前全部故事/项目拓扑生成 exact scope，为每个禁止根创建并保护边界哨兵，再原子发布 probe 配置。
4. 部署并固定 launcher 原生二进制；计算 launcher、固定 broker 和固定 nonce helper 的 SHA-256 写入 v3 配置。launcher 的两个固定参数必须依次是同一 broker 与 helper 的绝对路径。
5. 预建 nonce ledger 目录并设置管理身份独占 ACL。ledger 最多保留 8192 个 state；未过期 state 达上限时拒绝新启动。只有 envelope 过期再加 5 秒时钟偏差后才归档；签名审计按 32 个文件、每文件 256 条轮转。
6. 运行真实跨身份检查：

```text
node gateway/worker-isolation-preflight.mjs --story-id <STORY_ID>
```

## 受管 Worker CLI 安装

v3 `cliAllowlist` 只接受两种精确描述符：

- `native`：固定原生可执行文件的绝对路径与 SHA-256；
- `node-entry`：同时固定 `node`/`node.exe` 和单个 `.js`/`.cjs`/`.mjs` 入口的绝对路径与 SHA-256。

Node、JS 入口及其完整父链必须安装在 Worker 不可修改、由 Gateway/Controller
管理身份保护的位置。broker 直接执行固定 Node，并把固定 JS 入口作为第一个参数；
不会解析 `PATH`、cwd、`.cmd`/`.bat`、shebang 或 shell，也不接受配置提供的任意
prefix args。npm 全局目录若允许 Worker 自身更新，不可作为该受管安装位置。

只有输出同时满足 `status=READY`、`code=WORKER_DEPLOYMENT_READY`、`identityProbe=PASS` 和 `isolationLevel=STRONG`，Windows Worker 部署才可启用写任务。`--static` 永远返回 `BLOCKED`，因为路径、Hash、ACL 和账号存在并不能证明 launcher 真正切换了 SID。

成功 probe 会原子更新受保护 attestation。运行时只有在该文件的 Ed25519 签名可由固定公钥验证，且未超过 7 天，同时 probe v5 配置 Hash、launcher/broker/helper Hash、完整 Worker 身份策略摘要、故事仓 ACL 指纹、边界哨兵及 `allowedRoots` / `writeDeniedRoots` / `inaccessibleRoots` / `inaccessibleEntries` 范围摘要全部匹配时，才返回 `STRONG`。`inaccessibleEntries` 由 Controller 对每个不可访问根做稳定双枚举，固定根及全部后代的绝对路径和 `directory|file|missing` 类型；broker 必须逐项证明不可访问，并只返回同时包含 `inaccessibleEntriesInaccessible=true` 与 `launcherInstanceChannelBound=true` 的 probe result v3。旧 result v2 一律失败关闭。任一配置、权限范围、故事拓扑、实例通道绑定或二进制漂移都会立即降级并要求重新 probe；手工写 JSON 不能升级状态。

`StoryRepositoryController` 已把 Controller registry CAS 与 `reconcileManagedWorkerDeploymentProbeConfig` 接成同一条受管事务链。probe v5 全量文档包含严格递增的 `generation`、Controller 策略中的 `workerIdentity`、本故事全部独立仓、只读的全部基础仓业务树，以及完全不可访问的基础仓 canonical Git common-dir、其它活动故事仓、受管 mirror 和 `workerSecretRoots`，并绑定 ACL 指纹、sentinel 和不可访问后代清单。Gateway 只能从该受保护文档导入 grant v2；实时 cwd/add-dir 只能缩小到 Controller 已允许的仓库子路径，不能自行增加路径、身份、ACL、sentinel 或不可访问条目。生产 runtime/broker 严格拒绝 probe v3/v4；只有 Controller recovery/reconcile 能在验证固定路径、普通单链接文件和完整父链 ACL 后读取旧 generation/sentinel 归属并迁移到 v5，旧文档绝不能形成 READY 或 runtime grant。

新文档发布后的 stale sentinel 清理使用当前 config 内容/generation 与 sentinel 内容/文件身份双重 CAS。若更新 generation 已发布，旧代清理必须恢复或保留被新拓扑复用的 sentinel，绝不按旧路径盲删新代数据。

每次 registry CAS 先持久化 recovery marker，再提交 registry 并原子重建完整 probe 文档；generation 进入 grant/attestation 指纹，所以 topology 或元数据推进后旧 attestation 立即失效。排队任务在每次续期/launch 前还会重读固定 probe 并比较 current generation 与完整 scope，旧 grant 不能靠刷新 TTL 自续命，必须重新发 grant 并完成 matching probe。provision 发布失败会用新的 CAS generation 恢复旧 registry topology，并回收刚创建的故事仓；retire/cleanup 等已发生破坏性文件变更的失败会阻塞后续 mutation，由 daemon 启动恢复重建后才解除。返回的 `storiesRequiringProbe` 只表示必须重新执行真实跨身份 probe，不会自行伪造 `READY`。

daemon 受保护配置必须提供非空绝对路径数组：

```json
{
  "workerSecretRoots": [
    "<CONTROLLER_PROTECTED_SECRET_ROOT>",
    "<GATEWAY_PROTECTED_SECRET_ROOT>"
  ]
}
```

这些路径必须在故事仓根之外，父链 ACL 必须拒绝 Gateway/Worker rename、delete-child 和写入。Controller 还会固定加入自身 `dataRoot` 与 Gateway `.secrets`。该列表只来自 daemon 配置，API、UI 和 provision 请求不能覆盖。

当前 Controller topology 不接受 Gateway 传入的 StoryDev `storyDirectory`，因此独立 Worker 的 CLI add-dir 会排除未登记的故事资料目录。若部署要求 Worker 直接读取附件或临时上下文，必须先增加由 Controller 受保护配置固定的 story-storage 根，并由 Controller 按 storyId 派生、持久化且验证唯一绑定；不得把 Gateway 提交的任意资料路径直接加入 allowedRoots。在该能力完成前，资料应由 Gateway 注入 prompt/经 artifact API 传递，直接文件访问按失败关闭处理。

仓库仍不包含管理员安装的原生 launcher/service/account。完成这些 OS 部署、fd 5 实例证据通道、目录父链 ACL 加固和逐故事真实 probe 前，生产状态必须保持 `BLOCKED`。

当前 Unix 运行时没有已验证的 namespace/cgroup containment。即使真实跨 uid、ACL 和 broker probe 全部通过，也会返回：

```text
code=WORKER_KERNEL_CONTAINMENT_UNAVAILABLE
status=BLOCKED
isolationLevel=DEGRADED
```

该结果是显式失败关闭，不代表 Unix 已达到强隔离。完成内核级 launcher 与真实攻击验收前，不得改写为 `STRONG`。

## Git Controller、mirror 与故事仓保留引用

生产环境的 Git 写操作只能经独立 Controller daemon 完成。Repository Registry 会固定基础仓真实路径、Git common-dir、远端指纹、受管 mirror 和绝对 Git 可执行文件；不同物理仓库显式配置同一个 `mirrorPath` 会以 `GIT_CONTROLLER_MIRROR_PATH_CONFLICT` 失败关闭。该唯一绑定同时检查当前定义和 Controller 持久 catalog，不能通过重启后移除旧定义来把同一 mirror 路径静默转交给另一个 repositoryId。daemon 还会在任何恢复或监听之前拒绝 registration warning/error，宽松诊断 runtime 不能被生产严格 runtime 的缓存复用。

远端回退或分叉强推永远不能通过持久配置自动放行。Controller 会先把候选抓取到隔离 ref，计算完整旧/新 SHA、丢失提交计数与有界完整列表、受影响活动故事、已发布提交权威状态及其 SHA 列表，并生成绑定这些字段的 impact digest。发布状态为 `UNKNOWN`、任一影响列表被截断、故事影响无法验证或 `approvalAllowed` 不为 true 时均失败关闭。管理员批准必须是一次性、短时并精确绑定 repository、branch、relationship、preview version、旧/新 SHA 和 impact digest；批准人与当前已认证管理员必须一致。批准内容、原 actor 和 impact digest 会在 accepted ref CAS 前写入 durable `MIRROR_PUBLISHING` checkpoint，崩溃恢复沿用原 relationship/actor/批准审计，而不是降级成无来源的 recovery 批准。

accepted 发布的写入顺序固定为：最终 remote tip 复核 → durable `MIRROR_PUBLISHING` → 创建不可变的 generation `N+1` accepted-history ref → `MIRROR_RETENTION_VERIFIED` → accepted ref CAS → mirror state CAS。若进程在 accepted ref 切换前中断，启动恢复只有在持有当前 repository lease、accepted ref 与持久状态仍精确等于旧 SHA/generation `N`、且 history `N+1` 精确等于本 operation candidate 时，才用 `update-ref -d <ref> <candidate>` compare-and-delete 并再次复核；任一条件漂移都失败关闭。清理会在最终持久基线复核后同步续租，随后不经过事件循环让出便立即启动 compare-and-delete；另一个 Controller 不能仅凭租约过期回收仍存活进程持有的受保护 OS lock，只有已死亡或已证明 PID 复用的同机 owner 才可被替换。accepted ref 已切到 candidate 时绝不删除 history，而是完成 state CAS 和 maintenance；即使 `UNCHANGED` 导致旧 SHA 与 candidate 相同，恢复仍先用 operationId、remote fingerprint 和 generation `N+1` 识别已经提交的 mirror state，不能误判成旧基线并删除本代 history。升级恢复也识别旧二进制可能留下的 `MIRROR_RETENTION_VERIFIED` 且无 publishing checkpoint 的 journal，并从已消费 preview 重新证明 repository、branch、旧/新 SHA 和 generation 后执行同样的精确清理。

repository OS lock 使用 v2 Git-child ledger。Controller 在每个会写 mirror、base 或故事点独立仓库的 Git 命令启动前先同步、fsync 地写入 `SPAWNING`，拿到子进程后登记 PID 与可信启动身份为 `RUNNING`，子进程关闭后先清账再完成命令 Promise；有未清记录时 lease release 不删除 lock。故事仓的 `init`、exact-SHA `fetch`、`update-ref`、`checkout` 和元数据写入与 mirror/base 使用同一 repository lease 和账本。普通过期锁回收与启动事务恢复都会在 rename lock 前复读精确 revision，并逐项证明旧 Git PID 已死亡或发生可信 PID 复用；`SPAWNING`、仍存活、身份查询失败、旧 v1 无 child ledger 或检查期间 lock 漂移都失败关闭。

直接 PID 账本只是附加诊断，不构成完整进程树证明。生产 `STRONG` 必须来自真正持有 Windows Job 或 Linux cgroup 生命周期权的管理员安装 native launcher/guardian：受保护 daemon 配置只固定 `containerPolicyId`、`policyDigest`、guardian 二进制 Hash/ACL 和独立 Ed25519 `guardianKeyId`，不能固定或自报每次启动的容器身份。guardian 为每次 daemon 生成不可复用 `containerEpoch`，短期 receipt 绑定随机 challenge、daemon instance、Controller PID/start identity/OS identity、guardian instance、Git/guardian Hash、策略摘要及 10 秒内有效期。`runtime.describe` 必须带 Gateway 随机 challenge；Gateway 使用自己受保护配置中的 guardian 公钥验签，Controller 自签的 `STRONG` 或五个布尔值不能放行。daemon 在启动恢复前、ready 前、每个请求及每个 Git spawn 前重新挑战 guardian；通道丢失立即失败关闭。

任何 prior epoch 的 stale lock 都必须无条件取得 guardian 签名 tombstone，即使直接 child ledger 已为空。guardian 必须先不可逆 seal 旧 epoch、杀死整树并确认 `activeProcessCount=0`，再签发绑定 current/prior epoch 的恢复回执；只有验签和精确 lock 复读都成功后才允许 rename/recovery。Windows 使用 `KILL_ON_JOB_CLOSE` 且禁止 breakaway，Linux 使用不可重新委派的 cgroup v2 与 `cgroup.kill`；macOS 在有不可逃逸的内核实现和真实攻击验收前不支持 `STRONG`。仓库实现了该失败关闭契约、签名验证和负向回归，但不包含管理员安装的 native guardian 二进制、Job/cgroup 服务和真实跨重启攻击证据，因此真实生产部署验收仍为 `BLOCKED`。

生产 registry 的每个物理仓库可配置 `publicationPolicy`，当前只接受 `schemaVersion=1`、`mode=PROTECTED_EXACT_SHA_POSITIVE_LEDGER`。`publishedCommitShas` 必须由受保护的发布流水线维护为精确且不删除历史记录的 40/64 位发布提交 SHA 正证据台账，`evidenceId` 标识其权威来源；Controller 会规范化台账并计算 `evidenceDigest`，把两者纳入 registry 配置摘要和每次 rewrite impact digest。匹配 dropped SHA 时可以权威返回 `PRESENT`；返回的 SHA 是该受保护配置快照中的精确正命中，不宣称是当前已发布提交全集。静态台账中没有匹配项绝不构成“未发布”证据，只返回 `UNKNOWN` 并拒绝批准；空台账同样始终失败关闭。要安全返回 `NONE` 或权威发布全集，后续证据后端必须与发布流水线和 Controller 仓库 lease 共享 fencing/事务，保证发布登记先于对外发布，并提供按 repository/branch 绑定的完整、单调、防回滚和有时效快照。没有该协调后端、dropped 列表被截断、证据 ID/digest 无效或策略在 preview/execute 间漂移时均不得批准。达到 4096 条上限时必须升级权威证据后端，不能删除旧 SHA 继续运行。

所有 Controller 内部 ref 都使用域隔离、固定长度的散列定位符，避免合法 64 字符 remoteId 与 240 字符 branch 在 Windows loose-ref 路径上触发 `Filename too long`。accepted、accepted-history、incoming 和 base destination 分别位于紧凑的 `refs/devbench/accepted/a-*`、`refs/devbench/accepted-history/h-*`、`refs/devbench/incoming/i-*` 与 `refs/remotes/devbench/b-*`；外部权威 `refs/heads/*` 保持原名，状态和审计仍保存原始 remoteId/branch。故事仓收到的 accepted descriptor 会重新计算并严格核对 ref 绑定。

每个活动故事的 exact base SHA 还会在 mirror 中写入 Controller 专属保留引用。为兼容 Windows 长路径，引用使用 `refs/devbench/story-base/b-<binding>/s-<sha-token>` 的紧凑定位符；`binding` 绑定 storyId 与 repositoryId，短 SHA token 只用于定位，所有创建和读取都必须把 ref 内容与完整 40/64 位 exact SHA 逐字节核对，碰撞只会失败关闭。故事首次创建或缺失重建前必须先建立保留引用；正常 retire/cleanup 只有在 registry 删除持久化之后，才能在同一 repository lease 内释放它。

Controller 启动顺序固定为：mirror/base 恢复（此时 GC 延迟）→ Worker topology 恢复 → provision 恢复 → baseline registry 恢复 → quarantine/tombstone 恢复 → 全仓 story retention 对账 → hooks 恢复 → 检查无未处理事务 → 开始监听。任何对账失败都会阻止 daemon 对外服务；后续 `git gc --auto` 也必须在同一 lease 内先完成 accepted-history 和 story retention 对账。

Windows 下共享 Controller Git runner 与独立故事仓 runner 都会在隔离 global/system Git 配置的同时，命令级强制 `-c core.longpaths=true`，不依赖机器配置。daemon ready/runtime 描述会暴露 storyRoot、`.creating-<uuid>`、最大受管路径段、深 tracked path 和 Git metadata 的路径预算；超过 Windows extended-path 上限时拒绝启动。legacy 260 字符预算作为显式诊断，不替代真实 Git for Windows 的部署验证。

当前生产故事 baseline refresh 会以 `STORY_BASELINE_RESTRICTED_EXECUTOR_REQUIRED` 失败关闭，因为 Controller 不能在 Worker 可写故事路径上直接执行按路径寻址的 Git。只有部署按故事 Worker 身份运行、且具备等价 OS 约束和句柄绑定的受限执行器后，才能开启该写路径；测试环境中的 in-process adapter 不构成生产放行证据。

## Git Controller 的受保护 SSH descriptor

`git-controller-daemon.schema.example.json` 与 `git-controller-client.schema.example.json` 只描述两侧受保护字段契约，`git-controller-registry.example.json` 只展示仓库与 `credentialRef` 的绑定。这些模板都不是可运行配置，不含真实私钥、密钥内容、机器路径、账号 SID/uid 或可复用 ACL 指纹。daemon 与 Gateway client 必须分别 pin 同一 `mode`、`containerPolicyId`、`policyDigest`、guardian key id、guardian binary Hash 和 Git binary Hash；每次启动的 `containerEpoch` 只能来自 guardian 签名 receipt，禁止写入固定配置。

生产部署必须由管理员在仓库外生成 daemon 配置，并为每个只读 SSH 身份配置独立 `credentialDescriptors.<credentialRef>`：

- 固定绝对 `sshBinaryPath`、`privateKeyPath`、`knownHostsPath`，以及每个文件的内容 SHA-256 和 owner/ACL/完整父链 descriptor SHA-256；
- 私钥只授予 Controller 服务身份读取，Worker、Gateway、普通用户与故事仓均不可读取或修改；Unix 私钥不得宽于 `0600`；
- 路径不得包含空白或 shell 元字符。Controller 只会内部生成固定 `GIT_SSH_COMMAND`，强制 `BatchMode`、严格 host key、单一 identity，并关闭密码、键盘交互、agent、forward、proxy 和 local command；
- 固定 registry 中的每个 SSH 定义必须显式绑定存在的 `credentialRef`。远端指纹包含规范化 username、host、port 和 repository path；任一项漂移都会失败关闭；
- daemon 启动时以及每次 SSH 远端读取前都会重新证明 descriptor。文件缺失、内容变化、ACL/owner/父链变化或 known_hosts 缺失时，不会执行网络 Git；
- descriptor 路径和私钥内容不进入 API、UI、审计或错误详情。受管 mirror 只执行 `ls-remote`/`fetch` 等读取命令，不提供 push 路径。

部署后应以仓库外的只读 key 对目标远端做真实验收，并确认 key 在服务端没有写权限。不要把生成后的 daemon JSON、registry JSON、私钥、known_hosts、哈希采集输出或 ACL/SDDL 清单提交到 Git。

## 受管 mirror maintenance

Controller 对 mirror、基础仓和故事仓的普通 Git 写命令都以命令级配置关闭 `gc.auto`、`gc.autoDetach`、`maintenance.auto` 和 `maintenance.autoDetach`；所有 `fetch` 还显式传入 `--no-auto-maintenance`，避免直接 Git 进程完成后仍有脱离 lease 的后台写者。每次 accepted ref 通过 CAS 发布后，Controller 会改用专门的前台维护参数：恢复正常 `gc --auto` 阈值判断，但继续固定 `gc.autoDetach=false` 与 `maintenance.autoDetach=false`，并在同一个仓库 lease、Git-child ledger 和 fencing token 内等待命令完整结束；随后重新验证 accepted SHA 与对象连通性，才完成事务。

故事仓 provision、基础仓同步、mirror fetch/恢复与 maintenance 共用同一 repository lease，因此 maintenance 不会与 exact-SHA clone/fetch 并发。维护中崩溃会停留在可恢复 journal 阶段；Controller 重启后只有在证明原 owner 已失效、accepted ref 与持久化 generation 一致时才接管并重跑维护。每个故事仓拥有独立对象库、没有 alternates 或指向 mirror 的 remote，所以后续 mirror GC 不会破坏已创建故事仓。
