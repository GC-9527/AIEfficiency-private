import React, { useEffect, useRef, useState } from "react";

export default function UserMessageEditor({ initialValue, disabled = false, onCancel, onSubmit }) {
  const [value, setValue] = useState(String(initialValue || ""));
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    setValue(String(initialValue || ""));
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [initialValue]);

  async function submit() {
    const content = value.trim();
    if (!content || busy || disabled) return;
    setBusy(true);
    try { await onSubmit?.(content); } finally { setBusy(false); }
  }

  return (
    <div className="min-w-[min(32rem,72vw)] max-w-full" onClick={(event) => event.stopPropagation()}>
      <label className="sr-only" htmlFor="devbench-user-message-editor">编辑用户消息</label>
      <textarea
        ref={inputRef}
        id="devbench-user-message-editor"
        value={value}
        rows={Math.min(10, Math.max(3, String(value).split("\n").length + 1))}
        disabled={disabled || busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onCancel?.(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); }
        }}
        className="w-full resize-y rounded-xl border border-blue-400/35 bg-zinc-950/80 px-3 py-2.5 text-sm leading-relaxed text-zinc-100 outline-none transition focus:border-blue-400/70 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60 motion-reduce:transition-none"
      />
      <div role="note" className="mt-2 rounded-lg border border-amber-500/25 bg-amber-950/25 px-2.5 py-2 text-[11px] leading-relaxed text-amber-100/85">
        重新发送会从这里创建新的对话分支并保留旧回答，但不会回滚此前已经发生的代码、Git 或其它外部状态变更。
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto hidden text-[10px] text-zinc-500 sm:inline">Ctrl+Enter 重新发送 · Esc 取消</span>
        <button type="button" disabled={busy} onClick={onCancel} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[11px] text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50 motion-reduce:transition-none">取消</button>
        <button type="button" disabled={!value.trim() || busy || disabled} onClick={() => void submit()} className="rounded-lg border border-blue-400/30 bg-blue-600 px-3.5 py-1.5 text-[11px] font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-600 motion-reduce:transition-none">
          {busy ? "正在创建新分支…" : "重新发送"}
        </button>
      </div>
    </div>
  );
}

