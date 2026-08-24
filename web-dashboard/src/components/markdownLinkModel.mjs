// Markdown 链接安全模型：mailto 链接降级判定。
// 内部工具不唤起系统邮箱客户端：remark-gfm 会自动把文本中的邮箱 autolink 成
// mailto 链接（git 作者邮箱、AI 回复里的 xxx@yyy 等），点击会打开本机邮件应用——
// 即用户反馈的“一直打开邮箱”。渲染层对 mailto 一律降级为纯文本，不再可点击。

export function isMailtoHref(value) {
  return /^mailto:/i.test(String(value || "").trim());
}
