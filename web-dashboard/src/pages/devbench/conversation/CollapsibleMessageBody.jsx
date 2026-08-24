import React from "react";

function summaryText(content) {
  const text = String(content || "")
    .replace(/```[\s\S]*?```/g, " [代码段] ")
    .replace(/[`*_>#\[\]()~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "暂无可预览正文";
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

export default function CollapsibleMessageBody({ collapsed, content, role, children }) {
  if (!collapsed) return <div data-message-body="expanded" data-message-content-region="true">{children}</div>;
  return (
    <div data-message-body="collapsed" data-message-content-region="true" aria-label="消息正文已收起" className="min-w-0 py-0.5">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
        {role === "user" ? "你的消息已收起" : "AI 回答已收起"}
      </div>
      <div className="overflow-hidden text-[12px] leading-5 text-zinc-400" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
        {summaryText(content)}
      </div>
    </div>
  );
}
