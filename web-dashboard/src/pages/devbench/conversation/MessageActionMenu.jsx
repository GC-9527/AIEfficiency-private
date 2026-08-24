import React, { forwardRef } from "react";

export const MESSAGE_ACTION_REGISTRY = Object.freeze([
  { id: "copy", roles: ["user", "assistant", "live"], label: ({ copied }) => copied ? "已复制" : "复制" },
  { id: "quote", roles: ["user", "assistant"], label: () => "引用" },
  { id: "collapse", roles: ["user", "assistant", "live"], label: ({ collapsed }) => collapsed ? "展开" : "收起" },
  { id: "edit", roles: ["user"], label: () => "编辑" },
]);

const MessageActionMenu = forwardRef(function MessageActionMenu({ id, role, actionIds, context, position, onAction, onPointerEnter, onPointerLeave }, ref) {
  const enabled = new Set(actionIds || []);
  const actions = MESSAGE_ACTION_REGISTRY.filter((action) => enabled.has(action.id) && action.roles.includes(role));
  const above = position?.placement !== "below";
  return (
    <div
      ref={ref}
      id={id}
      role="toolbar"
      aria-label="消息操作"
      aria-hidden={position?.ready ? undefined : "true"}
      data-message-action-menu="true"
      data-message-menu-placement={position?.placement || "pending"}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="fixed z-[120] flex max-w-[calc(100vw-16px)] items-center gap-0.5 rounded-xl border border-zinc-700/90 bg-zinc-950/95 p-1 shadow-[0_16px_45px_rgba(0,0,0,0.55)] backdrop-blur-xl transition-opacity duration-100 motion-reduce:transition-none"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position?.ready ? "visible" : "hidden",
        opacity: position?.ready ? 1 : 0,
        pointerEvents: position?.ready ? "auto" : "none",
      }}
    >
      {actions.map((action) => {
        const disabled = action.id === "edit" && context?.editDisabled;
        const title = disabled ? (context?.editDisabledReason || "AI 运行或消息排队时不能编辑") : action.label(context || {});
        return (
          <button
            key={action.id}
            type="button"
            disabled={disabled}
            aria-label={title}
            title={title}
            onClick={() => onAction?.(action.id)}
            className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 disabled:cursor-not-allowed disabled:text-zinc-600 motion-reduce:transition-none ${action.id === "edit" ? "text-blue-200 hover:bg-blue-500/15" : "text-zinc-300 hover:bg-zinc-800 hover:text-white"}`}
          >{action.label(context || {})}</button>
        );
      })}
    </div>
  );
});

export default MessageActionMenu;
