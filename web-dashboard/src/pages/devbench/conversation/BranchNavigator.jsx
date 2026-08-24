import React from "react";

export default function BranchNavigator({ navigation, busy = false, disabled = false, onSelect }) {
  if (!navigation || navigation.total <= 1) return null;
  return (
    <div role="navigation" aria-label="用户消息版本" className="mt-2 flex items-center justify-end gap-1 text-[10px] text-blue-100/70">
      <button type="button" aria-label="切换到上一个用户消息版本" title="上一个版本及其 AI 回答" disabled={disabled || busy || !navigation.previousId} onClick={() => navigation.previousId && onSelect?.(navigation.previousId)} className="flex h-6 w-6 items-center justify-center rounded-full border border-blue-400/20 bg-blue-950/30 text-sm transition hover:border-blue-300/50 hover:bg-blue-500/15 disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none">‹</button>
      <span aria-live="polite" className="min-w-10 text-center font-mono">{navigation.index}/{navigation.total}</span>
      <button type="button" aria-label="切换到下一个用户消息版本" title="下一个版本及其 AI 回答" disabled={disabled || busy || !navigation.nextId} onClick={() => navigation.nextId && onSelect?.(navigation.nextId)} className="flex h-6 w-6 items-center justify-center rounded-full border border-blue-400/20 bg-blue-950/30 text-sm transition hover:border-blue-300/50 hover:bg-blue-500/15 disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none">›</button>
    </div>
  );
}

