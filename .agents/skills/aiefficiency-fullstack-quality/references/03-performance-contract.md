# 加载与性能契约

## 1. 性能验收必须回答

- 变更前后初始 JS、CSS、最大 chunk、gzip/brotli 体积变化多少？
- 直接路由是否仍为懒加载？重库是否只在功能触发时加载？
- 冷加载与同会话暖加载分别如何？
- 是否新增重复请求、串行瀑布、过度轮询、长任务或布局位移？
- 慢接口、失败接口、隐藏标签页、路由切换时是否正确取消或降级？

## 2. 默认工程预算

本包配置中的数值是项目初始门禁，可按真实基线收紧，不代表所有产品的统一标准：

- 单次变更新增总 JS gzip：不超过基线 10% 或 100 KiB，取更严格者。
- 单个 chunk gzip：默认不超过 750 KiB；重型编辑器/图形页应单独懒加载。
- 总 CSS gzip 增长：不超过 10%。
- 关键路由 LCP：目标不高于 2500 ms。
- CLS：目标不高于 0.10。
- 单个长任务：关注大于 50 ms；新增多个长任务为警告或阻断。
- 页面资源请求数、传输字节和脚本执行时间不得无解释显著增加。

CI 机器和本地机器绝对时间不同，因此更重视同环境差异。没有稳定环境时，包体差异仍是最低证据。

## 3. React/Vite 常见问题

- `lazy()` 只在入口声明不等于真正分包；检查构建 manifest 和共享 chunk。
- 在 App shell 顶层导入 `html2canvas`、`jszip`、流程图、编辑器等大库会污染所有路由。
- barrel export 可能把大模块意外带入初始包。
- 大型 JSX 文件每次状态变化重渲染整个页面；优先隔离状态和稳定 props，而非盲目 `memo`。
- `useEffect` 内重复注册定时器、WS 或事件监听会造成越来越慢。
- 轮询页面隐藏后仍运行会消耗 CPU/网络；使用 Page Visibility 或统一调度。
- Suspense fallback 高度与真实内容差异过大可制造 CLS。
- 图片、图表和 Markdown 渲染应避免无界尺寸与同步主线程重计算。

## 4. 请求性能与正确性一起验

优化不能破坏正确性：

- 合并请求前确认权限、缓存 key 和失效条件。
- 乐观更新需有冲突与回滚。
- 取消请求后不能把 abort 显示为业务错误。
- 去抖/节流不能吞掉最终输入。
- 并行请求需处理部分失败，不把失败字段伪装为空。
- 预取必须可控，避免每个侧栏项都加载大 chunk。

## 5. 包体基线

```bash
node scripts/bundle-audit.mjs --repo . --dist web-dashboard/dist
```

人工确认当前构建可作为基线后：

```bash
node scripts/bundle-audit.mjs --repo . --dist web-dashboard/dist --update-baseline
```

报告包含原始、gzip、brotli 大小和最大文件。缺基线时记录为 `NO_BASELINE`，但单 chunk 绝对预算仍然生效。若当前结果已经超出预算，普通 `--update-baseline` 会被拒绝，避免把失败结果“洗成通过”。

只有经批准的预期包体变化，才能显式接受，并把原因写入审计结果：

```bash
node scripts/bundle-audit.mjs --repo . --dist web-dashboard/dist \
  --update-baseline \
  --accept-budget-change "TB-1234 approved editor chunk increase"
```

原因至少 8 个字符。生产流程建议包含工单号、批准内容和到期治理计划。使用总门禁时同样可以把该参数传给 `quality-gate.mjs`。该例外只适用于包体预算，不适用于浏览器遮挡、越界、视觉差异、页面错误、安全或测试失败。

## 6. 浏览器性能

浏览器检查在导航前注入 PerformanceObserver，尽可能采集：

- navigation timing：TTFB、DOMContentLoaded、load。
- LCP、CLS、long task。
- resource count、transferSize、decodedBodySize。
- 页面异常、失败请求和仍未消失的 loading 标记。

真实 INP 需要足够用户交互样本；单次自动化不能可靠宣称生产 INP。自动化可记录事件耗时或交互延迟代理指标，但报告必须写清范围。

## 7. 性能回退处理

1. 先确认同环境重复测量，不用一次抖动下结论。
2. 查看新增 chunk、依赖和请求瀑布。
3. 优先修根因：懒加载、拆分状态、取消重复工作、减少不必要渲染。
4. 只有产品明确批准后才调整预算；报告记录原因、批准人/工单和后续期限。
5. 禁止删除测试、关闭采集或更新坏基线来“修复”性能失败。
