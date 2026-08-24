// 悬浮按钮采集的草稿（截图+当天日志诊断包）在 SPA 内跨路由传递给独立的新建页。
// 用模块级变量而非 sessionStorage：截图/zip 的 base64 可能很大，超 sessionStorage 配额。
let draft = null;
export function setFeedbackDraft(d) { draft = d; }
export function takeFeedbackDraft() { const d = draft; draft = null; return d; }
