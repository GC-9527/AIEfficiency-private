# 全栈契约与状态门禁

## 1. 垂直链路

每个用户故事都要追踪：

```text
用户动作
  → 路由/组件
  → 前端状态模型
  → 请求/WS 客户端
  → API 路由与认证
  → 服务/队列/执行器
  → 数据库/文件/外部系统
  → 返回状态与 UI 呈现
```

只改链路一段时，明确其余段为什么无需改动。

## 2. API 契约检查表

- 方法、路径、query/body/header、content-type。
- 必填/可选字段、默认值、枚举、null 与缺省区别。
- 分页游标、排序稳定性、重复项、总数语义。
- 时间格式、时区、精度和本地化。
- HTTP 状态码与领域错误码；用户可行动消息与内部诊断分离。
- 认证 principal、角色、capability、资源归属与工作区边界。
- 幂等、重复提交、并发更新、409/412、重试策略。
- 向后兼容、版本、灰度与旧客户端行为。

## 3. 前端错误映射

禁止以下模式：

```js
try {
  return await request();
} catch {
  return []; // 把认证、网络或服务错误伪装成空数据
}
```

建议返回可判别结果或抛出结构化错误：

```js
{
  status: "success" | "empty" | "unauthorized" | "forbidden" | "error",
  data,
  error,
  retryable
}
```

UI 必须根据状态渲染不同文案和操作。日志可记录诊断细节，但不得泄露 token、Cookie、路径秘密或敏感响应。

## 4. 异步与竞态

- 对搜索/切换/刷新使用 AbortController 或请求序号。
- 路由卸载后不更新旧组件状态。
- 多请求组合要定义 all-or-nothing、部分成功或独立状态。
- 快速双击写操作必须防重复或后端幂等。
- WS 重连需去重、处理 last sequence、乱序和补偿拉取。
- 轮询与 WS 共存时确定谁是 source of truth，避免双重更新。

## 5. 数据库与配置

- DDL 变更可重复执行或有明确 migration version。
- 写入新字段前，旧版本读取不会崩溃；读取旧行时有默认策略。
- 大表变更考虑锁、备份、恢复和滚动升级。
- 配置新增字段有 schema、默认值、校验、秘密处理和环境差异。
- 本地路径、shell 命令和工作区必须受 allowlist/boundary 约束。

## 6. 权限场景

至少验证：匿名、普通用户、管理员/具备 capability、资源非所有者、token 过期、节点角色差异。前端禁用按钮不是安全控制；后端必须独立拒绝。

## 7. 测试组合

- 纯函数/状态模型单测：边界、错误、竞态。
- API 集成：真实 status/body/permission，避免只 mock UI。
- 数据迁移：空库、旧 schema、有数据、重复执行。
- UI：401/403/5xx 显示与重试。
- 端到端：至少一条成功路径和一条关键失败路径。

## 8. AIEfficiency 安全红线

- 不得放宽 executor token、管理员、loopback 或 workspace boundary。
- 不得允许任意 principal 浏览整机目录或对未知 Git 路径执行命令。
- 不得把任意 `projectDir`、shell acceptance 或危险权限直接传入执行器。
- 任何为测试而加入的 bypass 必须只存在于隔离测试配置，默认关闭且不可进入生产构建。
